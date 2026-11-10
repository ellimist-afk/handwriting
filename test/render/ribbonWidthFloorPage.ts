import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { inlineInk, inkOverlayExtension, overlayForPath } from "../../src/inline/InkOverlay";
import { surfaceExtents } from "../../src/inline/SurfaceExtent";
import { setPenInk } from "../../src/inline/PenInk";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField } from "./iphoneObsidianStub";

// Regression instrument for the ribbon width floor (WidthFloor.ts /
// RibbonRenderer.fillRibbon). Measures the committed canvas directly - peak
// alpha and the count of pixels with alpha>=128 - not a blanket alpha>0
// count, which reads a hairline as "painted".
installObsidianDom();
const ids = new Map<string, string>();
inlineInk.attachHost({
	readPageId: path => ids.get(path) ?? null,
	claimId: async (path, id) => { ids.set(path, id); return { pageId: id }; },
	loadSidecar: async () => null,
	scheduleSidecar: () => {}, scheduleSidecarNow: async () => {}, notify: () => {},
});
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise<void>(r => requestAnimationFrame(() => r())); };

/**
 * The committed canvas, for PIXEL sampling.
 *
 * What this page reads is alpha out of the bitmap, which is independent of
 * where the canvas sits on screen - so it stays valid whatever transform the
 * ink layer carries. A sampler that reads POSITION does not inherit that: the
 * pinch-preview offset is written on `.handwriting-ink-layer`
 * (InkOverlay.applyPreviewInkOffset), so anything measuring where ink IS
 * during a preview must read the layer's rect, not the band's and not the
 * canvas's own CSS box. Sampling after settle sidesteps it entirely, because
 * the offset is cleared before the commit re-rasters.
 */
/** The overlay's own committed canvas, by identity: the ink layer's DOM order changes as layers are added. */
function committedCanvas(overlay: { committedCanvas?: HTMLCanvasElement }): HTMLCanvasElement {
	const c = overlay.committedCanvas;
	if (!c) throw new Error("committed canvas missing");
	return c;
}
function alphaStats(c: HTMLCanvasElement): { peakAlpha: number; countAtLeast128: number; countAboveZero: number } {
	const ctx = c.getContext("2d");
	if (!ctx || c.width === 0 || c.height === 0) return { peakAlpha: 0, countAtLeast128: 0, countAboveZero: 0 };
	const d = ctx.getImageData(0, 0, c.width, c.height).data;
	let peakAlpha = 0, countAtLeast128 = 0, countAboveZero = 0;
	for (let i = 3; i < d.length; i += 4) {
		const a = d[i]!;
		if (a > peakAlpha) peakAlpha = a;
		if (a >= 128) countAtLeast128++;
		if (a > 0) countAboveZero++;
	}
	return { peakAlpha, countAtLeast128, countAboveZero };
}

/** One fresh mount, zoomed to `targetZoom` via the real button path, then one pen stroke, then alpha stats. */
async function oneStrokeAt(targetZoom: number, label: string, pressure: number) {
	const path = `ribbon-floor-${label}.md`, pageId = `ribbon-floor-${label}`;
	ids.set(path, pageId);
	surfaceExtents.grow(path, { x: 2000, y: 2000 });
	const pane = document.body.appendChild(document.createElement("div"));
	pane.className = "workspace-leaf-content camera-proof-pane";
	pane.style.cssText = "width:640px;height:480px;display:flex;flex:0 0 640px;overflow:hidden;";
	const host = pane.appendChild(document.createElement("div"));
	host.className = "markdown-source-view camera-proof";
	host.style.cssText = "width:100%;height:100%;min-width:0;min-height:0;display:flex;flex:1 1 auto;overflow:hidden;";
	const view = new EditorView({
		parent: host,
		state: EditorState.create({
			doc: "untitled repro", extensions: [
				EditorView.lineWrapping,
				editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} })),
				inkOverlayExtension(),
				EditorView.theme({ "&": { width: "640px", height: "480px" }, ".cm-content": { fontFamily: "monospace", fontSize: "16px", lineHeight: "24px" } }),
			],
		}),
	});
	await settle();
	const overlay = overlayForPath(path)! as any;
	if (!overlay) throw new Error(`overlay missing: ${label}`);
	let steps = 0;
	while (overlay.pinchScaleNow > targetZoom * 1.0001 && steps < 20) { overlay.zoomNoteBy(.5); await settle(); steps++; }
	const zoomBefore = overlay.pinchScaleNow;
	const rect = pane.getBoundingClientRect();
	const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
	setPenInk(true);
	const t = document.elementFromPoint(cx, cy);
	if (!t) return { label, zoomBefore, targetZoom, steps, error: "no element at point", stats: null as any };
	for (const [type, x, y, buttons, p] of [["pointerdown", cx, cy, 1, pressure], ["pointermove", cx + 20, cy + 20, 1, pressure], ["pointerup", cx + 20, cy + 20, 0, 0]] as const)
		t.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "pen", pointerId: 700 + steps, clientX: x, clientY: y, buttons, pressure: p }));
	await settle();
	const strokeCount = inlineInk.strokes(path).length;
	const stats = alphaStats(committedCanvas(overlay));
	const backing = overlay.committedBacking;
	const dpr = overlay.dpr;
	view.destroy(); pane.remove();
	return { label, zoomBefore, targetZoom, steps, strokeCount, pressure, backing, dpr, stats };
}

/**
 * Proves the paint sites read the STORED committedBacking, not a fresh
 * backingNow()/cssScale recomputation: mutate `overlay.cssScale` to a wildly
 * different value WITHOUT letting a reallocation run (no handleResize call),
 * then draw the same stroke as the "control" mount (which never touches
 * cssScale). If the paint used cssScale afresh, the mutated run's alpha
 * stats would look like an unfloored render at cssScale=8 (effectively no
 * floor needed, since backing would be huge); if it used the stored field,
 * the mutated run matches the control exactly, because the actual canvas
 * resolution - and the floor's own reference quantity - never changed.
 */
async function lockedStaleBackingCheck(pressure: number) {
	const control = await oneStrokeAt(0.125, `locked-control-${pressure}`, pressure);
	const path = `ribbon-floor-locked-${pressure}.md`, pageId = `ribbon-floor-locked-${pressure}`;
	ids.set(path, pageId);
	surfaceExtents.grow(path, { x: 2000, y: 2000 });
	const pane = document.body.appendChild(document.createElement("div"));
	pane.className = "workspace-leaf-content camera-proof-pane";
	pane.style.cssText = "width:640px;height:480px;display:flex;flex:0 0 640px;overflow:hidden;";
	const host = pane.appendChild(document.createElement("div"));
	host.className = "markdown-source-view camera-proof";
	host.style.cssText = "width:100%;height:100%;min-width:0;min-height:0;display:flex;flex:1 1 auto;overflow:hidden;";
	const view = new EditorView({
		parent: host,
		state: EditorState.create({
			doc: "untitled repro", extensions: [
				EditorView.lineWrapping,
				editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} })),
				inkOverlayExtension(),
				EditorView.theme({ "&": { width: "640px", height: "480px" }, ".cm-content": { fontFamily: "monospace", fontSize: "16px", lineHeight: "24px" } }),
			],
		}),
	});
	await settle();
	const overlay = overlayForPath(path)! as any;
	let steps = 0;
	while (overlay.pinchScaleNow > 0.125 * 1.0001 && steps < 20) { overlay.zoomNoteBy(.5); await settle(); steps++; }
	const backingBeforeMutation = overlay.committedBacking;
	// Simulate the race: cssScale has moved but nothing reallocated (no
	// handleResize call happens between this mutation and the paint below),
	// so committedBacking must hold regardless. `frame.locked` is a getter
	// (StrokeFrame manages it itself around the real pointerdown/up it
	// wraps) - not settable here, and not needed: the contract this proves
	// is that nothing but a reallocation writes committedBacking, which this
	// mutation-without-reallocation already exercises directly.
	overlay.cssScale = 8;
	const rect = pane.getBoundingClientRect();
	const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
	setPenInk(true);
	const t = document.elementFromPoint(cx, cy);
	if (!t) return { error: "no element at point" };
	for (const [type, x, y, buttons, p] of [["pointerdown", cx, cy, 1, pressure], ["pointermove", cx + 20, cy + 20, 1, pressure], ["pointerup", cx + 20, cy + 20, 0, 0]] as const)
		t.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "pen", pointerId: 900, clientX: x, clientY: y, buttons, pressure: p }));
	await settle();
	const backingAfterMutation = overlay.committedBacking;
	const stats = alphaStats(committedCanvas(overlay));
	view.destroy(); pane.remove();
	return { control: control.stats, mutated: stats, backingBeforeMutation, backingAfterMutation, mutatedCssScale: 8 };
}
(window as any).ribbonWidthFloorLockedCheck = lockedStaleBackingCheck;

async function run() {
	// Both arms, at 100% and at 12.5% (matches the calibration probe's own
	// tempos): default half-pressure, and the low-pressure ("hairline")
	// pen the ruling asks be used as the RED/GREEN arm.
	const at100Default = await oneStrokeAt(1, "100-default", 0.5);
	const at12_5Default = await oneStrokeAt(0.125, "12.5-default", 0.5);
	const at100Thin = await oneStrokeAt(1, "100-thin", 0.05);
	const at12_5Thin = await oneStrokeAt(0.125, "12.5-thin", 0.05);
	return { at100Default, at12_5Default, at100Thin, at12_5Thin };
}
(window as any).ribbonWidthFloorRun = run;

// 100%-identity check: fillRibbon with floor=undefined vs floor={backing:1,dpr:1}
// must paint byte-identical pixels, on the SAME points, off the DOM (no
// overlay needed) - this is what "the floor is the identity at backing===dpr"
// means as a pixel fact, not just an algebraic one.
import { fillRibbon } from "../../src/ink/RibbonRenderer";
import type { RibbonPt } from "../../src/ink/Ribbon";
async function identityAt100() {
	const pts: RibbonPt[] = [
		{ x: 10, y: 10, hw: 1.1 }, { x: 40, y: 15, hw: 1.32 }, { x: 70, y: 40, hw: 0.33 }, { x: 90, y: 60, hw: 1.32 },
	];
	const cam = { x: 0, y: 0, zoom: 1 };
	const make = () => { const c = document.createElement("canvas"); c.width = 200; c.height = 200; return c; };
	const a = make(), b = make();
	fillRibbon(a.getContext("2d")!, cam, pts, "#000000", false, undefined);
	fillRibbon(b.getContext("2d")!, cam, pts, "#000000", false, { backing: 1, dpr: 1 });
	const da = a.getContext("2d")!.getImageData(0, 0, 200, 200).data;
	const db = b.getContext("2d")!.getImageData(0, 0, 200, 200).data;
	let identical = da.length === db.length;
	let firstDiffAt = -1;
	if (identical) {
		for (let i = 0; i < da.length; i++) {
			if (da[i] !== db[i]) { identical = false; firstDiffAt = i; break; }
		}
	}
	return { identical, firstDiffAt, length: da.length };
}
(window as any).ribbonWidthFloorIdentity = identityAt100;
