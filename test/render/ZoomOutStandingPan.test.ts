/**
 * ZOOM OUT AND THE PAGE STAYS PUSHED LEFT.
 *
 * What it looks like: you pinch in on a note, then pinch back out somewhere
 * else on the screen, and when the zoom settles at 100% the note is not back
 * under your finger - it sits off to the left, its first characters past the
 * pane's edge, and it stays there until a Fit, a zoom button or a file switch.
 * Scrolling does not bring it back, because at 100% the note fits the pane and
 * there is nothing to scroll.
 *
 * WHY IT HAPPENS (read on 043612dc):
 * a pinch holds the note with a pan translate, and the settle spends that pan
 * into native scroll - `Math.max(0, anchor.scrollLeft - pan.x / effScale)`.
 * Whatever the scroll clamp refuses comes back as pan by design, so the settled
 * frame stands exactly where the last preview frame stood. At a scale where the
 * content fits the pane the scroller has no range at all, so a leftward
 * remainder cannot be spent and the whole of it stays as pan.
 *
 * THE RULE: the pan exists to
 * reach what the scroll cannot above the fitting scale, and the bound on it is
 * the note's visible overlap - 24 px. Where the page FITS its viewport that
 * bound is wrong, because it lets a gesture leave the whole page hanging off a
 * pane it fits inside, with no scroll range left to undo it. So THE SETTLE's
 * pan target is clamped there to the tighter of what the old bound allows and
 * the page's own box inside the pane.
 *
 * ONLY THE SETTLE OF A ZOOM. While the fingers are down the note stays under
 * the focal point - that is the gesture's contract, pinned by "a pinch holds the
 * note under the focal point" in ScrollColumnAnchorPinch, and an earlier shape
 * that bounded every preview frame broke it by up to 295 px (measured). So a
 * preview frame may hang outside the viewport, and this file does not assert
 * otherwise. And only a settle that CHANGED THE SCALE: a two-finger pan at a
 * constant spread keeps its landing where the fingers left it, pinned by "right/
 * down expansion without toggle", which a clamp on every settle broke by 800 px
 * (measured). The edge that follows - an in-then-out pinch ending at its start
 * scale is a pan here and is not clamped - has its own arm at the end.
 *
 * THE GESTURE, both cells: pinch in to 300% centred on the ink, then pinch out
 * centred 340 client px to the LEFT of it. The two centres differ on purpose -
 * that is what a hand does, and with both centres on the same point the pan
 * comes back to zero on its own and there is nothing to read.
 *
 * WHAT IS MEASURED after the zoom-out settles: the pan the overlay holds, the
 * scroller's remaining range on each axis (the regime this claim is about, read
 * rather than assumed), where the text line's own box sits against the pane,
 * and whether the ink is on the pane - from the committed canvas's pixels and
 * from a real screenshot. A positive control moves the canvas by a known 10 px
 * so a zero is a measurement rather than a silence.
 *
 * WHAT THE CLAMP MOVES, measured on this fixture and pinned per cell below: 0
 * px with readable line length on at 100% (the settle already lands inside),
 * 1.45 px with it on at 150%, and 226.67 px with it off at 100% - the case
 * Alan would see, where the page hung a fifth of the pane outside it.
 *
 * ON A CLIPPED AXIS THE SETTLED FRAME DIFFERS FROM THE LAST PREVIEW FRAME, by
 * exactly that correction, and that difference IS the fix - not the "frame
 * stands" invariant failing. Where the settle has nothing to correct, the frame
 * still stands, and the cells below assert whichever of the two applies.
 *
 * THE LAST CELLS settle where the content does NOT fit (250% with readable line
 * length on, 150% with it off). There the pan is doing its job, and the
 * invariant is the design's own: the settled frame stands where the last
 * preview frame stood. They are the guard that the fix touches only the fitting
 * axis. Measured first (the R1 read): where
 * the content does not fit the settle may spend the whole remainder into
 * scroll and leave no pan at all, so "a pan survives" is NOT the guard.
 *
 * Numbers go to HW_STANDING_PAN_OUT when set.
 *
 * Plant: HW_R1_PLANT_NO_FIT_BOUND=1 builds the overlay with the settle never
 * asking for the fitting bound - the fit test and its readout still tell the
 * truth, only the clamp is gone. Expected red under it: the clipped 100% cell
 * (its page stays 227 px outside) and the 0.75 zoom arm. Everything else green.
 * (The 150% cell with readable line length on was red here through the clamp's
 * counter until that cell gained a rest, which does not go through it.)
 *
 * The other direction: HW_R1_PLANT_CLAMP_EVERY_SETTLE=1 builds it with every
 * settle treated as a zoom - the shape that sprang a two-finger drag back by
 * 800 px. Expected red under it: both drag arms and the in-then-out edge.
 *
 * READABLE LINE LENGTH ON, WHERE THE COLUMN FITS: every settle
 * returns the centred column to its rest, so the two fitting cells with the
 * setting on no longer stand where the last preview frame stood; they assert the
 * rest once the bounce has carried the page there, and the clamp's counter stays
 * at 0 because the rest, not the window, placed it; and the two in-band drags gain
 * arms with the setting on that expect the same rest. HW_RLL_PLANT_WINDOW_SETTLE=1
 * settles those on the window again: expected red, exactly those four arms.
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

declare const process: { env: Record<string, string | undefined> };

/** The page: the same mount as scrollColumnAnchorPage (pane offset 300 px, monospace 16/24, Obsidian's sizer), plus the stroke and the readers. */
const PAGE = `
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { inlineInk, inkOverlayExtension, overlayForPath, setScrollExpansionEnabled, setInlineTool, setInkSizeMult } from "../../src/inline/InkOverlay";
import { surfaceExtents } from "../../src/inline/SurfaceExtent";
import { setInkColorHex } from "../../src/ink/InkColor";
import { setPenInk } from "../../src/inline/PenInk";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField } from "./iphoneObsidianStub";
import { parsePage, serializePage } from "../../src/model/PageData";

installObsidianDom();
const ids = new Map(), sidecars = new Map();
const save = (id, page) => { sidecars.set(id, serializePage(page)); };
inlineInk.attachHost({ readPageId: p => ids.get(p) ?? null, claimId: async (p, id) => { ids.set(p, id); return { pageId: id }; },
	loadSidecar: async id => (sidecars.has(id) ? parsePage(sidecars.get(id), id) : null), scheduleSidecar: save, scheduleSidecarNow: async (id, p) => save(id, p), notify: () => {} });

const frame = () => new Promise(r => requestAnimationFrame(() => r()));
/** After the frame has rendered: its layout, its observer deliveries and its paint have run. */
const rendered = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await frame(); };
const PANE_W = 1397.5, PANE_H = 800, HOST_LEFT = 300, TEXT_LINE = 6;
let rig = null;

function installSizer(view) {
	const sizer = document.createElement("div"); sizer.className = "cm-sizer";
	const container = document.createElement("div"); container.className = "cm-contentContainer";
	view.contentDOM.parentElement.insertBefore(sizer, view.contentDOM); sizer.appendChild(container); container.appendChild(view.contentDOM);
	void view.scrollDOM.clientWidth; return sizer;
}
const lineEl = view => view.contentDOM.querySelectorAll(".cm-line")[TEXT_LINE];
const textBox = view => { const range = document.createRange(); range.selectNodeContents(lineEl(view)); const r = range.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, cy: (r.top + r.bottom) / 2 }; };
const MAGENTA = p => p[3] > 200 && p[0] > 200 && p[1] < 60 && p[2] > 200;

/** The committed canvas's magenta pixels, mapped through the canvas's client rect. */
function backingInk() {
	const cc = rig.overlay.committedCanvas, w = cc.width, h = cc.height;
	if (!(w > 0 && h > 0)) return null;
	const d = cc.getContext("2d").getImageData(0, 0, w, h).data;
	let minY = Infinity, maxY = -1, minX = Infinity, maxX = -1, n = 0;
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; if (MAGENTA([d[i], d[i + 1], d[i + 2], d[i + 3]])) { n++; if (y < minY) minY = y; if (y > maxY) maxY = y; if (x < minX) minX = x; if (x > maxX) maxX = x; } }
	if (!n) return { n };
	const r = cc.getBoundingClientRect();
	return { n, cy: r.top + ((minY + maxY + 1) / 2) * r.height / h,
		left: r.left + minX * r.width / w, right: r.left + (maxX + 1) * r.width / w };
}

const r2 = v => Math.round(v * 100) / 100;

function sample(phase) {
	const { view, overlay, pane } = rig, t = textBox(view), ink = backingInk(), k = overlay.pinchScaleNow;
	const s = view.scrollDOM, pr = pane.getBoundingClientRect(), sr = s.getBoundingClientRect(), cr = view.contentDOM.getBoundingClientRect();
	const pan = overlay.viewportPan || { x: 0, y: 0 };
	const layout = overlay.viewportLayout;
	// The zoom bar, its buttons, Fit and the zoom commands all stand down together with the
	// canvas off, and they read that from this one term. The refusal pin below asserts it.
	const viewportState = typeof overlay.getNoteViewportState === "function" ? overlay.getNoteViewportState() : null;
	return { phase, k, preview: !!overlay.pinchPreview, busy: viewportState ? viewportState.busy : null,
		panX: r2(pan.x), panY: r2(pan.y), rasterPanX: r2(overlay.rasterPan ? overlay.rasterPan.x : 0), rasterPanY: r2(overlay.rasterPan ? overlay.rasterPan.y : 0),
		// The scroller's remaining range on each axis: the regime this claim is about.
		rangeX: r2(s.scrollWidth - s.clientWidth), rangeY: r2(s.scrollHeight - s.clientHeight), scrollLeft: r2(s.scrollLeft), scrollTop: r2(s.scrollTop),
		paneLeft: r2(pr.left), paneRight: r2(pr.right), textLeft: r2(t.left), textRight: r2(t.right), textCy: r2(t.cy),
		// The rule bounds the CONTENT's box against the viewport: the scroller is the viewport, .cm-content is the page.
		viewLeft: r2(sr.left), viewRight: r2(sr.right), contentLeft: r2(cr.left), contentRight: r2(cr.right),
		// The overlay's own fit quantity when the build exposes it (the fix's helper), so the cell can cross-check the regime it asserts.
		fitReadout: typeof overlay.panFitReadout === "function" ? overlay.panFitReadout() : null,
		sizerTransform: rig.sizer.style.transform || "",
		// The scrollbar gutter in screen px on this frame: Readable line length centres the column beside it.
		gutter: r2(sr.width - s.clientWidth * sr.width / s.offsetWidth),
		inkN: ink ? ink.n : 0, inkLeft: ink && ink.n ? r2(ink.left) : null, inkRight: ink && ink.n ? r2(ink.right) : null,
		dyNote: ink && ink.n ? (ink.cy - t.cy) / k : null,
		bounce: typeof overlay.overscrollBounceReadout === "function" ? overlay.overscrollBounceReadout() : null,
		// room and extent, the two terms of the settle's floor (min(0, room - extent)),
		// read the same way the settle reads them (InkOverlay.ts :6603-6613), so a cell can derive its
		// own expected rest instead of pinning one.
		paneWidthPx: layout ? r2(layout.paneWidth) : null, externalScale: layout ? layout.externalScale : null,
		columnBoxPx: layout && layout.columnBox !== undefined ? r2(layout.columnBox) : null,
		extentX: rig.path ? r2(surfaceExtents.get(rig.path).x) : null, fontZoom: overlay.fontZoom };
}

window.standingPan = {
	async mount(readable, tag, infiniteCanvas) {
		// Alan, 2026-09-20: the pinch zoom exists only under the Infinite Canvas now, so a
		// rig that pinches mounts with the canvas ON. The canvas-on settle laws apply here: the
		// page stays where the fingers left it, no centring and no fit window.
		setPenInk(true); setScrollExpansionEnabled(infiniteCanvas !== false);
		setInlineTool("pen"); setInkColorHex("pen", "#ff00ff"); setInkSizeMult("pen", 4);
		const path = "standing-pan-" + readable + "-" + (tag || "gesture") + ".md";
		const pane = document.body.appendChild(document.createElement("div"));
		pane.className = "markdown-source-view mod-cm6" + (readable ? " is-readable-line-width" : "");
		pane.style.cssText = "position:relative;margin-left:" + HOST_LEFT + "px;width:" + PANE_W + "px;height:" + PANE_H + "px;overflow:hidden";
		const doc = Array.from({ length: 400 }, (_, i) => "line " + i + " alpha beta gamma delta epsilon zeta").join("\\n");
		const view = new EditorView({ parent: pane, state: EditorState.create({ doc, extensions: [history(), EditorView.lineWrapping,
			editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} })), inkOverlayExtension(),
			EditorView.theme({ "&": { width: PANE_W + "px", height: PANE_H + "px" }, ".cm-scroller": { overflowY: "auto", overflowX: "hidden" }, ".cm-content": { fontFamily: "monospace", fontSize: "16px", lineHeight: "24px" } })] }) });
		const sizer = installSizer(view);
		await settle(12);
		const overlay = overlayForPath(path);
		if (!overlay) throw new Error("no overlay for " + path);
		rig = { pane, view, overlay, sizer, path };
		const t = textBox(view), x = t.left + 80, y = t.cy;
		const pen = (type, px, py, buttons) => document.elementFromPoint(px, py)?.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "pen", pointerId: 901, isPrimary: true, clientX: px, clientY: py, buttons, pressure: buttons ? 0.5 : 0 }));
		pen("pointerdown", x, y, 1); for (let i = 1; i <= 6; i++) pen("pointermove", x + 30 * i, y, 1); pen("pointerup", x + 180, y, 0);
		await settle(12);
		return { strokes: inlineInk.strokes(path).length, natural: sample("natural"), inkMiddleX: textBox(view).left + 170, pane: pane.getBoundingClientRect().toJSON() };
	},
	/** Known 10 px down on the committed canvas; both readers must read it back. Removed before returning. */
	async plant(on) { rig.overlay.committedCanvas.style.translate = on ? "0 10px" : ""; await settle(2); return sample(on ? "plant-on" : "plant-off"); },
	/** The router's two-finger pinch about an EXPLICIT client point, spread 300 -> 300 x to over steps frames, then settle. */
	async pinch(to, steps, cx, cy, tag) {
		const { overlay } = rig, router = overlay.router, from = overlay.pinchScaleNow;
		const spread0 = 300, spread1 = 300 * to / from;
		const touch = s => { router.touchPos.set(911, { x: cx - s / 2, y: cy }); router.touchPos.set(912, { x: cx + s / 2, y: cy }); };
		const ev = type => new PointerEvent(type, { pointerId: 912, pointerType: "touch" });
		const rows = [sample(tag + "-before")];
		touch(spread0); router.beginPinch(ev("pointerdown"));
		for (let i = 1; i <= steps; i++) { touch(spread0 + (spread1 - spread0) * i / steps); router.updatePinch(ev("pointermove")); await rendered(); rows.push(sample(tag + "-move-" + i)); }
		router.endPinch(ev("pointerup"), { x: cx, y: cy }); router.touchPos.clear();
		for (let j = 1; j <= 16; j++) { await rendered(); rows.push(sample(tag + "-settle-" + j)); }
		// The settle's correction glides for half a second, longer than those frames: read on to the rest, one row a frame,
		// so the last row is the settled page and the rows in between still carry the glide.
		for (let j = 1; j <= 90 && rig.overlay.overscrollBounceReadout && rig.overlay.overscrollBounceReadout().active; j++) { await rendered(); rows.push(sample(tag + "-glide-" + j)); }
		return rows;
	},
	/**
	 * ONE gesture from the current scale to "to", its centre travelling from cxStart to cxEnd the whole way: a drag whose
	 * spread drifted, or a zoom that also pans. slopKick (px) opens the spread by that much on the first frame, so a drift
	 * smaller than the router's 12 px pinch slop still belongs to an ACTIVE gesture, as it does on a real screen once the
	 * fingers have moved: measured, a 9 px spread change with no kick never activated and moved nothing.
	 */
	async pinchPath(to, steps, cxStart, cxEnd, cy, tag, slopKick) {
		const { overlay } = rig, router = overlay.router, from = overlay.pinchScaleNow;
		const spread0 = 300, spread1 = 300 * to / from, kick = slopKick || 0;
		const touch = (s, cx) => { router.touchPos.set(911, { x: cx - s / 2, y: cy }); router.touchPos.set(912, { x: cx + s / 2, y: cy }); };
		const ev = type => new PointerEvent(type, { pointerId: 912, pointerType: "touch" });
		const rows = [sample(tag + "-before")];
		touch(spread0, cxStart); router.beginPinch(ev("pointerdown"));
		for (let i = 1; i <= steps; i++) {
			const t = i / steps;
			const spread = kick && i === 1 ? spread0 + kick : kick ? spread0 + kick + (spread1 - spread0 - kick) * (i - 1) / (steps - 1) : spread0 + (spread1 - spread0) * t;
			touch(spread, cxStart + (cxEnd - cxStart) * t);
			router.updatePinch(ev("pointermove")); await rendered(); rows.push(sample(tag + "-move-" + i));
		}
		router.endPinch(ev("pointerup"), { x: cxEnd, y: cy }); router.touchPos.clear();
		for (let j = 1; j <= 16; j++) { await rendered(); rows.push(sample(tag + "-settle-" + j)); }
		// The settle's correction glides for half a second, longer than those frames: read on to the rest, one row a frame,
		// so the last row is the settled page and the rows in between still carry the glide.
		for (let j = 1; j <= 90 && rig.overlay.overscrollBounceReadout && rig.overlay.overscrollBounceReadout().active; j++) { await rendered(); rows.push(sample(tag + "-glide-" + j)); }
		return rows;
	},
	/**
	 * A TWO-FINGER DRAG, the scale held, the centre travelling by (dx, dy) over steps frames.
	 * pinchPath only moves the centre horizontally and only while the spread changes; the allowance
	 * is a per-axis claim, so the vertical needs its own driver.
	 */
	async dragPath(steps, dx, dy, cx, cy, tag) {
		const { overlay } = rig, router = overlay.router;
		// The router engages a preview on a real spread change, so a drag carries the same 1.03 the
		// existing drag arms use: constant spread reads as no gesture at all and previews zero frames.
		const spread0 = 300;
		const touch = (px, py, sp) => { router.touchPos.set(911, { x: px - sp / 2, y: py }); router.touchPos.set(912, { x: px + sp / 2, y: py }); };
		const ev = type => new PointerEvent(type, { pointerId: 912, pointerType: "touch" });
		const rows = [sample(tag + "-before")];
		touch(cx, cy, spread0); router.beginPinch(ev("pointerdown"));
		for (let i = 1; i <= steps; i++) {
			const t = i / steps;
			// The ruling: THE SPREAD IS HELD. A real two-finger drag does not change the spread at all;
			// the 3% ramp this used to carry was there only to keep the router previewing, and it moved the
			// settle's floor 50 px across the gesture, so every frame was measured against a bound it never
			// ran under. Held, the floor stands still: measured spread 0.0000 px across all 30 frames.
			//
			// THE KICK IS SQUEEZED BETWEEN TWO CONSTANTS, and 20 px does not fit between them. It must EXCEED
			// the router's 12 px pinch slop or the gesture never goes live and nothing previews
			// (InkOverlay.ts :139), and it must stay under PAN_DRAG_SCALE_EPS of the 300 px spread - 15 px -
			// or every frame reads as a zoom and the give band is gated off. Measured at a held 20 px kick:
			// scale ratio 1.067 on all 30 frames, gate shut on all 30, band never fired. 14 px clears the
			// slop and lands at 1.047, gate open on all 30.
			const sp = spread0 + 14;
			touch(cx + dx * t, cy + dy * t, sp);
			router.updatePinch(ev("pointermove")); await rendered(); rows.push(sample(tag + "-move-" + i));
		}
		router.endPinch(ev("pointerup"), { x: cx + dx, y: cy + dy }); router.touchPos.clear();
		for (let j = 1; j <= 40; j++) { await rendered(); rows.push(sample(tag + "-settle-" + j)); }
		for (let j = 1; j <= 90 && rig.overlay.overscrollBounceReadout && rig.overlay.overscrollBounceReadout().active; j++) { await rendered(); rows.push(sample(tag + "-glide-" + j)); }
		return rows;
	},
	/** ONE gesture in to peak and back out to the scale it began at, the centre drifting from cxStart to cxEnd over the whole of it. */
	async pinchRound(peak, steps, cxStart, cxEnd, cy, tag) {
		const { overlay } = rig, router = overlay.router, from = overlay.pinchScaleNow;
		const spread0 = 300, spreadPeak = 300 * peak / from, total = steps * 2;
		const touch = (s, cx) => { router.touchPos.set(911, { x: cx - s / 2, y: cy }); router.touchPos.set(912, { x: cx + s / 2, y: cy }); };
		const ev = type => new PointerEvent(type, { pointerId: 912, pointerType: "touch" });
		const rows = [sample(tag + "-before")];
		touch(spread0, cxStart); router.beginPinch(ev("pointerdown"));
		for (let i = 1; i <= total; i++) {
			const up = i <= steps ? i / steps : (total - i) / steps;
			touch(spread0 + (spreadPeak - spread0) * up, cxStart + (cxEnd - cxStart) * i / total);
			router.updatePinch(ev("pointermove")); await rendered(); rows.push(sample(tag + "-move-" + i));
		}
		router.endPinch(ev("pointerup"), { x: cxEnd, y: cy }); router.touchPos.clear();
		for (let j = 1; j <= 16; j++) { await rendered(); rows.push(sample(tag + "-settle-" + j)); }
		// The settle's correction glides for half a second, longer than those frames: read on to the rest, one row a frame,
		// so the last row is the settled page and the rows in between still carry the glide.
		for (let j = 1; j <= 90 && rig.overlay.overscrollBounceReadout && rig.overlay.overscrollBounceReadout().active; j++) { await rendered(); rows.push(sample(tag + "-glide-" + j)); }
		return rows;
	},
	sample,
	/** After a wait in real time, not frames: a deferred repaint runs on a timer. The overscroll glide is half a second, so
	 * a settle's own frames are not enough: wait it out rather than read a page still on its way to rest. */
	async later(ms, phase) { await new Promise(r => setTimeout(r, ms));
		for (let i = 0; i < 90 && rig.overlay.overscrollBounceReadout && rig.overlay.overscrollBounceReadout().active; i++) await frame();
		await settle(4); return sample(phase); },
	/**
	 * Screenshot pixels (PNG as base64 from the test): magenta inside the pane and within 120 px of the text line the stroke
	 * was drawn on, in client px. THE BAND IS NOT DECORATION: the toolbar's colour swatch is magenta too (192 device px of
	 * it), and counting it dragged the bbox centre halfway - the 10 px plant read back as 5 and the cells' own liveness
	 * control caught it. The pane-wide count is kept as 'whole' for diagnosis.
	 */
	async screenInk(b64) {
		const img = await createImageBitmap(await (await fetch("data:image/png;base64," + b64)).blob());
		const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const g = c.getContext("2d"); g.drawImage(img, 0, 0);
		const d = g.getImageData(0, 0, c.width, c.height).data;
		const dpr = c.width / window.innerWidth, pr = rig.pane.getBoundingClientRect();
		const t = textBox(rig.view);
		const x0 = Math.max(0, Math.floor(pr.left * dpr)), x1 = Math.min(c.width, Math.ceil(pr.right * dpr));
		const py0 = Math.max(0, Math.floor(pr.top * dpr)), py1 = Math.min(c.height, Math.ceil(pr.bottom * dpr));
		const y0 = Math.max(py0, Math.floor((t.cy - 120) * dpr)), y1 = Math.min(py1, Math.ceil((t.cy + 120) * dpr));
		let n = 0, minX = Infinity, maxX = -1, minY = Infinity, maxY = -1, whole = 0;
		for (let y = py0; y < py1; y++) for (let x = x0; x < x1; x++) { const i = (y * c.width + x) * 4; if (MAGENTA([d[i], d[i + 1], d[i + 2], d[i + 3]])) {
			whole++;
			if (y >= y0 && y < y1) { n++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; } } }
		if (!n) return { n, dpr, whole };
		return { n, dpr, whole, left: r2(minX / dpr), right: r2((maxX + 1) / dpr), cy: r2((minY + maxY + 1) / 2 / dpr) };
	},
};
`;

let browser: Browser, script: string;
const DPR = 2;
const record: unknown[] = [];

beforeAll(async () => {
	let planted = 0;
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "standingPanPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
		plugins: process.env.HW_R1_PLANT_CLAMP_EVERY_SETTLE ? [{ name: "r1-clamp-every-settle", setup(builder) {
			builder.onLoad({ filter: /src[\\/]inline[\\/]InkOverlay\.ts$/ }, args => {
				const from = "const zoomed = Number.isFinite(ratio) && (ratio < PAN_SETTLE_ZOOM_BAND.below || ratio > PAN_SETTLE_ZOOM_BAND.above);";
				const text = readFileSync(args.path, "utf8");
				if (text.split(from).length !== 2) throw new Error("r1 plant: band anchor not found once");
				planted++;
				return { loader: "ts", contents: text.replace(from, "const zoomed = Number.isFinite(ratio) || true;") };
			});
		} }] : process.env.HW_R1_PLANT_NO_FIT_BOUND ? [{ name: "r1-no-fit-bound", setup(builder) {
			builder.onLoad({ filter: /src[\\/]inline[\\/]InkOverlay\.ts$/ }, args => {
				const from = "this.anchorPanTo(hold.toScale, hold, local, top, zoomed);";
				const text = readFileSync(args.path, "utf8");
				if (text.split(from).length !== 2) throw new Error("r1 plant: anchor not found once");
				planted++;
				return { loader: "ts", contents: text.replace(from, "void zoomed; this.anchorPanTo(hold.toScale, hold, local, top, false);") };
			});
		} }] : [] });
	if ((process.env.HW_R1_PLANT_NO_FIT_BOUND || process.env.HW_R1_PLANT_CLAMP_EVERY_SETTLE) && !planted) throw new Error("r1 plant requested but never applied");
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);
afterAll(async () => {
	await browser?.close();
	if (process.env.HW_STANDING_PAN_OUT) writeFileSync(process.env.HW_STANDING_PAN_OUT, JSON.stringify(record, null, 1));
});

const call = (p: Page, method: string, ...args: unknown[]) => p.evaluate(([m, a]) => (window as any).standingPan[m](...a), [method, args] as const);
async function screen(p: Page) {
	const b64 = (await p.screenshot({ type: "png" })).toString("base64");
	return call(p, "screenInk", b64) as any;
}
const r3 = (v: number) => Math.round(v * 1000) / 1000;
/** How far the zoom-out's centre sits from the zoom-in's, in client px: a hand does not pinch twice about one point. */
const CENTRE_OFFSET_PX = 340;
const PAN_MIN_VISIBLE_PX = 24;
/** The ruling's floor, `min(0, room - extent)`, from the raw fields `sample()` reads off the settle's own layout. */
function floorXOf(row: any): number {
	const effective = row.k * row.externalScale;
	const room = Math.max(0, row.paneWidthPx * row.externalScale - PAN_MIN_VISIBLE_PX);
	const extent = Math.max(row.columnBoxPx ?? 0, row.extentX * row.fontZoom) * effective;
	return Math.min(0, room - extent);
}



/**
 * THE EDGE, PINNED AS THE CONTRACT: a single gesture that pinches in to 300% and back out to the
 * 100% it began at, its centre drifting 340 px left the whole way, is a PAN to the settle's clamp - its committed scale
 * is its starting scale - so the settle lands exactly where the last preview frame stood even though the page ends up
 * hanging off the pane, and the clamp's counter does not move. If this arm goes red, the clamp has started acting on
 * gestures that did not zoom, which is the spring-back the two-finger pan cells in ScrollColumnAnchorPinch forbid.
 */
it("an in-then-out pinch that ends at its starting scale is a pan to the settle: not clamped, RLL=false", async () => {
	const page = await browser.newPage({ viewport: { width: 1800, height: 900 }, deviceScaleFactor: DPR, hasTouch: true });
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	try {
		await page.setContent('<!doctype html><body style="margin:0"></body>');
		await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
		await page.addScriptTag({ content: script });
		const mounted = await call(page, "mount", false, "round") as any;
		expect(mounted.strokes, "the stroke committed").toBe(1);
		const natural = mounted.natural, centre = mounted.inkMiddleX as number, cy = natural.textCy as number;
		const round = await call(page, "pinchRound", 3, 30, centre, centre - CENTRE_OFFSET_PX, cy, "round") as any[];
		const peak = round[30], lastPreview = round[60], settled = round.at(-1);
		const later = await call(page, "later", 400, "later") as any;
		record.push({ edge: "in-then-out", natural, round, later, errors });
		// eslint-disable-next-line no-console
		console.log("STANDINGPAN-EDGE " + JSON.stringify({ peakK: peak.k, k: settled.k, naturalContentLeft: natural.contentLeft, lastPreviewContentLeft: lastPreview.contentLeft,
			contentLeft: settled.contentLeft, viewLeft: settled.viewLeft, rangeX: settled.rangeX, panX: settled.panX, laterContentLeft: later.contentLeft,
			boundHits: settled.fitReadout ? settled.fitReadout.boundHits : null }));
		expect(errors).toEqual([]);
		expect(peak.k, "the gesture really zoomed in").toBeGreaterThan(2.5);
		expect(settled.k, "and came back to the scale it began at").toBeCloseTo(1, 6);
		// The arm runs under the Infinite Canvas now, and the canvas grants sideways room, so the
		// old premise - a page that fits its pane with no scroll range at all - cannot hold. Measured at
		// aa437ff1 on this fixture: rangeX 1690 before the gesture and 2202 at rest. The regime this arm
		// asserts is the canvas one: room exists, and the settle still does not spring the page back.
		expect(settled.rangeX, "premise: the canvas granted this note sideways room").toBeGreaterThan(1);
		// ZERO SNAP at the commit frame (the first settle sample, a real measured DOM
		// rect so any bounce overlay is already reflected in it): it paints where the last preview
		// frame painted, whatever the glide eases afterward.
		const commitRow = round.find((r: any) => r.phase === "round-settle-1");
		expect(commitRow, "premise: the commit frame was sampled").toBeTruthy();
		// Second attempt, test-only. THE ROW STAYS ON THE SCREEN. The first attempt compared
		// `panX + bounce.fromX` against the preview's `panX`, which is the app's own arithmetic checked
		// against itself - `fromX` IS `painted - landed`, so the sum returns `painted` by construction and
		// a page painting somewhere else entirely would still pass. Withdrawn; that is the ruling
		// mistake and the ruling already ruled the shape out.
		// What is actually wrong is the SAMPLE TIME: `round-settle-1` is read after the glide has begun,
		// and the only thing between the commit and that read is the glide's own progress, which the
		// readout reports exactly - `fromX` where it started, `x` where it is now. Measured over four
		// runs of this arm on one tree the progress at that sample was 0.39, 1.36, 2.72 and 3.30 px,
		// which is precisely the miss the row reported. So the read stays `contentLeft`, a measured DOM
		// rect, and only the glide's own travel since it started is added back. A page painted anywhere
		// but the last preview's position still reddens this row, by the whole of that displacement.
		const glideSoFar = commitRow.bounce ? commitRow.bounce.fromX - commitRow.bounce.x : 0;
		expect(Math.abs((commitRow.contentLeft + glideSoFar) - lastPreview.contentLeft),
			`zero snap: the commit frame paints the last preview's position, px (painted ${commitRow.contentLeft} + glide so far ${r3(glideSoFar)} against ${lastPreview.contentLeft})`).toBeLessThanOrEqual(0.5);
		// AT REST (after the glide), the page has eased to the floor, min(0, room -
		// extent), derived from this fixture's own geometry - not left hanging indefinitely.
		// under the canvas the rest is not a floor to ease onto - the page stays where the
		// fingers left it and the pan it held is spent into the room the canvas granted. Measured at
		// aa437ff1: the last preview frame paints the page at contentLeft -205.00 at 300%, and at rest
		// the returned-to-100% page sits at -34.33 with panX -0.33 and 2202 px of range beside it. The
		// claim is the same one in a canvas regime: nothing springs back at the lift.
		expect(Math.abs(settled.panX), `at rest the pan is spent, px (read ${r3(settled.panX)})`).toBeLessThanOrEqual(1);
		expect(Math.abs(later.contentLeft - settled.contentLeft), "and stays there a moment later, px").toBeLessThanOrEqual(0.5);
	} finally { await page.close(); }
}, 180_000);

/**
 * THE BAND. A two-finger drag on a real screen drifts the scale 1-12% through the router's 12 px
 * slop, so "the settle changed the scale" is a band of the gesture's starting scale, [0.8, 1.25], not equality. Each arm is
 * one gesture on a fresh 100% note whose spread drifts to its ratio while the centre travels far enough left to hang the
 * page off the pane. Inside the band it is a drag and lands where the fingers left it; outside it is a zoom and the settle
 * brings a page that fits back inside the pane.
 */
const BAND_CASES = [
	// Drags, from a settled 60% with readable line length off: the full-width column (1383 px at 100%) is 855 px at 61.8% and
	// 929 px at 67.2%, well inside the 1397.5 px pane by the overlay's own fit, which is the quantity the clamp decides on.
	{ readable: false, start: 0.6, ratio: 1.03, travel: 360 },
	{ readable: false, start: 0.6, ratio: 1.12, travel: 360 },
	// The two Readable-line-length-on arms are DELETED with the rest they asserted. With the
	// setting on the column is inset, so a drag cannot carry it past the pane's edge at all and this
	// fixture has no overshoot to stand on; the bound's own behaviour there is OverscrollEdgeBound's.
] as const;

for (const b of BAND_CASES) {
	it(`a two-finger gesture ending at ${b.ratio} of its starting scale (${b.start * 100}%) on a page that fits: a drag, it stays where the fingers left it, RLL=${b.readable}`, async () => {
		const page = await browser.newPage({ viewport: { width: 1800, height: 900 }, deviceScaleFactor: DPR, hasTouch: true });
		const errors: string[] = [];
		page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
		try {
			await page.setContent('<!doctype html><body style="margin:0"></body>');
			await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
			await page.addScriptTag({ content: script });
			const mounted = await call(page, "mount", b.readable, "band") as any;
			expect(mounted.strokes, "the stroke committed").toBe(1);
			const natural = mounted.natural, centre = mounted.inkMiddleX as number, cy = natural.textCy as number;
			// The start scale, reached by a plain zoom about the ink with no drift, so the arm's own gesture begins from rest.
			const toStart = await call(page, "pinchPath", b.start, 30, centre, centre, cy, "to-start") as any[];
			const begin = toStart.at(-1);
			const rows = await call(page, "pinchPath", b.start * b.ratio, 30, centre, centre - b.travel, cy, "band", 20) as any[];
			const lastPreview = rows[30], settled = rows.at(-1);
			const hitsBefore = rows[0].fitReadout ? rows[0].fitReadout.boundHits : 0;
			const later = await call(page, "later", 400, "later") as any;
			record.push({ band: b, natural, rows, later, errors });
			// eslint-disable-next-line no-console
			console.log("STANDINGPAN-BAND " + JSON.stringify({ ...b, beginK: begin.k, k: settled.k, rangeX: settled.rangeX, hitsBefore, lastPreviewContentLeft: lastPreview.contentLeft, contentLeft: settled.contentLeft,
				contentRight: settled.contentRight, viewLeft: settled.viewLeft, viewRight: settled.viewRight, laterContentLeft: later.contentLeft,
				boundHits: settled.fitReadout ? settled.fitReadout.boundHits : null, boundMaxPx: settled.fitReadout ? r3(settled.fitReadout.boundMaxPx) : null }));
			expect(errors).toEqual([]);
			expect(begin.k, "the arm began at its start scale").toBeCloseTo(b.start, 3);
			expect(settled.k / begin.k, "the gesture ended at its ratio of the starting scale").toBeCloseTo(b.ratio, 2);
			// THE REGIME IS THE OVERLAY'S OWN FIT, not the scroller's range. The two part company on any gesture
			// whose scale RISES: measured, the scroller grows horizontal range as soon as the preview scale passes the committed one
			// and keeps it through the settle (67 px at 60% -> 61.8%, 247 px at 60% -> 67.2%, 149 px at 100% -> 112% with readable
			// line length on) while the page is plainly narrower than the pane (855 / 929 / 784 px against 1398). A scale that falls
			// leaves none (0 px at 100% -> 75%). So the scroller's range is reported, and the fit the clamp uses is asserted.
			if (settled.fitReadout) expect(settled.fitReadout.fitsX, "the overlay's own fit says the page fits at the end scale").toBe(true);
			// with the canvas off there is no give, so a drag whose ask would carry the page past the
			// pane's left edge stops AT the edge on every preview frame (the plain bound), never past it. The old
			// row asserted the give here; the ask itself (travel 360 against a fitting page) is unchanged, so the
			// bound is exercised, not vacuous.
			// A DRAG (ratio within PAN_DRAG_SCALE_EPS of 1) takes the plain bound; a ZOOM keeps the note under the
			// focal point with no bound and the settle lands it, so its last preview frame still hangs past the edge.
			if (Math.abs(b.ratio - 1) < 0.05) {
				// NOT VACUOUS, the guard the zero-snap row below depends on: the fingers asked for more travel than
				// the page had room for, so a page standing exactly at the edge is the bound engaged, not a drag
				// that never reached it. Room is read off the drag's own first sample.
				const room = rows[0].contentLeft - rows[0].viewLeft;
				expect(b.travel, `premise: the ask exceeded the room (travel ${b.travel}, room ${r3(room)})`).toBeGreaterThan(room + 1);
				// with the canvas ON the drag is not stopped at the pane's edge. The canvas grants
				// the travel, the page follows the fingers past the edge, and the lift leaves it there.
				// Measured at aa437ff1 on this fixture: the last preview frame paints contentLeft -52.92
				// (1.03 arm) and -67.68 (1.12 arm) against a viewLeft of 300.
				expect(lastPreview.contentLeft, "a drag under the canvas: the page followed the fingers past the pane's left edge").toBeLessThan(lastPreview.viewLeft - 50);
			} else expect(lastPreview.contentLeft, "a zoom: the gesture carried the page past the pane's left edge").toBeLessThan(lastPreview.viewLeft - 0.5);
			// ZERO SNAP at the commit frame (the first settle sample): it paints where
			// the last preview frame painted, whatever the glide eases afterward.
			const commitRow = rows.find((r: any) => r.phase === "band-settle-1");
			expect(commitRow, "premise: the commit frame was sampled").toBeTruthy();
			// Second attempt, test-only. THE ROW STAYS ON THE SCREEN. The first attempt compared
		// `panX + bounce.fromX` against the preview's `panX`, which is the app's own arithmetic checked
		// against itself - `fromX` IS `painted - landed`, so the sum returns `painted` by construction and
		// a page painting somewhere else entirely would still pass. Withdrawn; that is the ruling
		// mistake and the ruling already ruled the shape out.
		// What is actually wrong is the SAMPLE TIME: `round-settle-1` is read after the glide has begun,
		// and the only thing between the commit and that read is the glide's own progress, which the
		// readout reports exactly - `fromX` where it started, `x` where it is now. Measured over four
		// runs of this arm on one tree the progress at that sample was 0.39, 1.36, 2.72 and 3.30 px,
		// which is precisely the miss the row reported. So the read stays `contentLeft`, a measured DOM
		// rect, and only the glide's own travel since it started is added back. A page painted anywhere
		// but the last preview's position still reddens this row, by the whole of that displacement.
		const glideSoFar = commitRow.bounce ? commitRow.bounce.fromX - commitRow.bounce.x : 0;
		expect(Math.abs((commitRow.contentLeft + glideSoFar) - lastPreview.contentLeft),
			`zero snap: the commit frame paints the last preview's position, px (painted ${commitRow.contentLeft} + glide so far ${r3(glideSoFar)} against ${lastPreview.contentLeft})`).toBeLessThanOrEqual(0.5);
			// AT REST (after the glide), the page has eased to the floor - not an
			// unbounded hang.
			// at rest under the canvas the page is WHERE THE FINGERS LEFT IT - there is no floor
			// to ease onto, because the room the canvas granted absorbs the pan. Measured at aa437ff1:
			// last preview -52.92 and rest -53.00 on the 1.03 arm, -67.68 and -68.00 on the 1.12 arm.
			expect(Math.abs(settled.contentLeft - lastPreview.contentLeft),
				`at rest the page is where the fingers left it, px (rest ${r3(settled.contentLeft)}, last preview ${r3(lastPreview.contentLeft)})`).toBeLessThanOrEqual(1);
			// NOT the bound counter: `notePanBound` counts BOTH axes now, and this gesture's y arm legitimately
			// fires it (measured 3 hits) while x is left alone. The x claim above is the whole claim here.
			expect(Math.abs(later.contentLeft - settled.contentLeft), "and nothing moves a moment later, px").toBeLessThanOrEqual(0.5);
		} finally { await page.close(); }
	}, 180_000);
}

/**
 * THE ALLOWANCE, RED-FIRST at 956ef2c9 where the preview is unbounded.
 *
 * Alan's contract, from his video of the native scroller: while the fingers are down the page may
 * pass its own room by a small give and then STOPS under them - it does not follow the fingers for
 * ever - and the lift eases that give back to the bound. His reference numbers: about 90 px of
 * give dragging down, about 220 px dragging right at 72% on a 2210 px page. The first guess for
 * the constant is 96 px at the effective scale, to be tuned on his device.
 *
 * These cells pin the two halves per axis: the preview STOPS at the bound plus the allowance, and
 * the lift arrives at the bound itself. They are expected RED on the preview row today, because
 * `bounded` is settle-only and nothing clamps a preview frame.
 */
const ALLOWANCE_PX = 96;
const allowanceOf = (row: any): number => ALLOWANCE_PX * (row.externalScale ?? 1);

// RETIRED BY the ruling (Alan, 2026-09-20). The two bound cells here drove a two-finger drag with the
// Infinite Canvas OFF and asserted the plain bound of the ruling: no give, the preview stops at the
// floor or the ceiling, and the lift lands on it. With the canvas off the product now ignores
// every phase of a two-finger gesture, so there is no preview to bound and no landing to read -
// the premise "the drag really previewed" cannot hold. Under the canvas the same drag has the
// give and the bounce, whose rows live with the overscroll work. The canvas-off refusal is
// pinned once for this rig at the foot of this file.


/**
 * THE REFUSAL PIN for this rig. Alan's decision of 2026-09-20 takes the note zoom out of the
 * canvas-off mode: with the Infinite Canvas off a two-finger pinch is ignored in every phase, no
 * preview starts, the page does not move, the scale stays at 100%, and the zoom bar, its buttons,
 * Fit and the zoom commands all read busy together.
 *
 * NON-VACUITY: the identical gesture, same fixture and same driver, runs first with the canvas ON
 * and has to move the scale and enter a preview. Without that control a rig whose router had
 * stopped delivering touches would pass this cell while the product was broken.
 */
it("canvas off: a pinch is ignored - no preview, the page does not move, the scale stays at 100%, the zoom bar reads busy", async () => {
	const page = await browser.newPage({ viewport: { width: 1800, height: 900 }, deviceScaleFactor: DPR, hasTouch: true });
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	try {
		await page.setContent('<!doctype html><body style="margin:0"></body>');
		await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
		await page.addScriptTag({ content: script });

		// CONTROL: the canvas ON. The same pinch has to reach the zoom.
		const onMount = await call(page, "mount", true, "refusal-control", true) as any;
		const onRows = await call(page, "pinch", 0.4, 20, onMount.inkMiddleX, onMount.natural.textCy, "control") as any[];
		const onEnd = onRows.at(-1);
		expect(errors).toEqual([]);
		expect(onRows.some((r: any) => r.preview), "control: the canvas-on gesture entered a preview").toBe(true);
		expect(Math.abs(onEnd.k - 1), `control: the canvas-on pinch moved the scale (k ${onEnd.k})`).toBeGreaterThan(0.05);
		expect(onRows[0].busy, "control: the zoom bar is live with the canvas on").toBe(false);

		// THE PIN: the canvas OFF, a fresh mount, the same gesture.
		const offMount = await call(page, "mount", true, "refusal-pin", false) as any;
		const offRows = await call(page, "pinch", 0.4, 20, offMount.inkMiddleX, offMount.natural.textCy, "refused") as any[];
		const before = offRows[0], after = offRows.at(-1);
		record.push({ cell: "refusal pin", control: { k: onEnd.k, previews: onRows.filter((r: any) => r.preview).length }, before, after });
		expect(errors).toEqual([]);

		expect(before.k, "premise: the canvas-off note starts at 100%").toBe(1);
		expect(after.k, "canvas off: the scale after the pinch").toBe(1);
		expect(offRows.some((r: any) => r.preview), "canvas off: no preview frame was entered").toBe(false);
		expect(after.busy, "canvas off: the zoom bar, its buttons, Fit and the zoom commands read busy").toBe(true);
		expect(Math.abs(after.panX - before.panX), "canvas off: the pan moved sideways").toBeLessThanOrEqual(0.5);
		expect(Math.abs(after.panY - before.panY), "canvas off: the pan moved vertically").toBeLessThanOrEqual(0.5);
		expect(Math.abs(after.textLeft - before.textLeft), "canvas off: the text's screen left moved").toBeLessThanOrEqual(0.5);
		expect(Math.abs(after.textCy - before.textCy), "canvas off: the text's screen centre moved").toBeLessThanOrEqual(0.5);
	} finally { await page.close(); }
}, 240_000);
