/**
 * AUDIT JUDGE PROBE L-diff20-3 (1.4.21, tag 1a05f62c). Read-only audit; not part of the product suite.
 *
 * Question: the stated trigger (link A -> B in the same tab) is refuted by the host rebuild (setState destroys the
 * ViewPlugin; L-diff20-3.test.ts cells 1-2 green). Does the SAME defect - restingColumnMargin (:7644) and
 * columnMarginDebt (:7651) not reset by the in-place path-change branch (:3182-3248) or restoreViewportLayout
 * (:8347-8375) - reach the user through the one route that keeps the instance: a rename/move of the open note?
 *
 * Host facts (Obsidian 1.13.7 app.js, read by this judge): FileView.onRename (@1497897) only re-renders breadcrumbs,
 * title and header; MarkdownView.onRename (@3037657) only sets the inline title, then calls it. Neither reaches
 * setViewData/setState, so the overlay instance survives a rename and `filePath()` (:2141, editorInfoField.file.path,
 * the same TFile mutated in place) reports the new path on the next update. main.ts:3532-3535 only re-keys stores.
 *
 * ORACLE (J1-J5): a freshly opened note and an editor just switched away from a zoomed note, in the IDENTICAL visual
 * state (100%, scroll 0, natural layout), must land identically on the same first commit. Cells assert that (red =
 * the switched editor moves differently).
 *  J0 host route, REAL constructor via the REAL ViewPlugin spec: rename in place -> same instance, branch ran,
 *     camera reset, both fields untouched (characterisation; green expected).
 *  J1-J5 run the note-switch branch: their rig changes the path with no file object and no rename record.
 *  J1 '-' after switching the editor away from a note left at 200% vs fresh twin (correct behaviour asserted)
 *  J2 same as J1 with ONLY the two fields cleared after the switch (discriminating plant; green expected)
 *  J3 '+' (x1.25) after a switch from a note left at 200% vs fresh twin (correct behaviour asserted)
 *  J4 Fit on an ink-less note (commitCameraScale(1,{0,0}), :9016) after the switch vs fresh twin (correct asserted)
 *  J5 negative control: switch from a note left at 50% (it rests at the natural inset) then '-' vs twin (green expected)
 * The zoom commit path is REAL (zoomNoteBy, zoomAroundCenter, commitCameraScale, applyViewportBox,
 * restColumnAgainstCurrentGrant, appliedColumnMargin, columnMarginDebtScrollLeft, columnFitsPane,
 * setViewportScroll) as is the path-change branch (update/updateInner) and restoreViewportLayout; the layout and the
 * canvas scroll grant are modelled (rig copied from L-diff20-3.test.ts / InkOverlay-4-3).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

(globalThis as { window?: unknown }).window = globalThis;
{
	const g = globalThis as Record<string, unknown>;
	if (typeof g.addEventListener !== "function") g.addEventListener = () => undefined;
	if (typeof g.removeEventListener !== "function") g.removeEventListener = () => undefined;
	if (typeof g.ResizeObserver !== "function") {
		g.ResizeObserver = class { observe(): void {} unobserve(): void {} disconnect(): void {} };
	}
}

import { ViewPlugin } from "@codemirror/view";
import { type App, type CachedMetadata, type Plugin, TFile } from "obsidian";
import { InkOverlayPlugin, inkOverlayExtension, inlineInk } from "../inline/InkOverlay";
import { CanvasNoteOverride, NOTE_CANVAS_KEY, setCanvasNoteOverrideForTest } from "../inline/CanvasNoteOverride";
import type { InlineInkHost } from "../inline/InlineInkStore";
import { MIN_PINCH_SCALE } from "../inline/PinchScale";
import { emptyPage } from "../model/PageData";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fields = Record<string, any>;
const f = (o: unknown): Fields => o as Fields;

const A = "ld203j-a.md";
const RENAMED = "ld203j-renamed.md";
const SWITCHED = "ld203j-switched.md";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const overlaySpec = (inkOverlayExtension() as any)[2];

// ---- permissive DOM stand-in (InkOverlay-5-1) ---------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const U: any = new Proxy(function inert() { /* inert */ }, {
	get(_t, k) {
		if (k === "then") return undefined;
		if (k === Symbol.toPrimitive) return () => 0;
		if (k === Symbol.iterator) return function* () { /* empty */ };
		if (typeof k === "symbol") return undefined;
		return U;
	},
	apply: () => U,
	construct: () => U,
	set: () => true,
});
function permissive<T extends object>(own: T): T {
	return new Proxy(own, {
		get(t, k) {
			if (k in t) return (t as Record<PropertyKey, unknown>)[k];
			if (k === "then") return undefined;
			if (typeof k === "symbol") return undefined;
			return U;
		},
	});
}

function installOverride(): void {
	const a = Object.assign(new TFile(), { path: A, extension: "md" });
	const files = new Map<string, TFile>([[a.path, a]]);
	const metadata = new Map<TFile, CachedMetadata>([[a, { frontmatter: { [NOTE_CANVAS_KEY]: true } }]]);
	const app = {
		metadataCache: { getFileCache: (file: TFile) => metadata.get(file), on: () => ({}) },
		fileManager: { processFrontMatter: vi.fn() },
		vault: { read: vi.fn(async () => ""), getAbstractFileByPath: (path: string) => files.get(path) ?? null },
	} as unknown as App;
	const override = new CanvasNoteOverride(app);
	override.start({ registerEvent: () => {}, register: () => {} } as unknown as Plugin);
	setCanvasNoteOverrideForTest(override);
}

async function loadNote(): Promise<void> {
	const host: InlineInkHost = {
		readPageId: (p) => "ld203j-page-" + p,
		claimId: async (_p, pageId) => ({ pageId }),
		loadSidecar: vi.fn(async (pageId: string) => {
			const data = emptyPage(pageId);
			data.surface = "inline";
			return { data, recovered: false };
		}),
		scheduleSidecar: vi.fn(),
		notify: vi.fn(),
	};
	inlineInk.attachHost(host);
	await inlineInk.ensureLoaded(A);
}

function makeEditor(startPath: string) {
	const owner = { file: { path: startPath } as { path: string } };
	const win = permissive({
		devicePixelRatio: 1,
		setTimeout: () => 1,
		clearTimeout: () => undefined,
		requestAnimationFrame: () => 1,
		cancelAnimationFrame: () => undefined,
		getComputedStyle: () => permissive({ position: "relative", fontSize: "16px", overflowX: "auto", overflowY: "auto" }),
	});
	const doc = permissive({ defaultView: win });
	const dom: Fields = permissive({
		ownerDocument: doc,
		parentElement: null,
		closest: (sel: string) => (sel === ".markdown-source-view" ? dom : null),
	});
	const scrollDOM = permissive({ ownerDocument: doc, scrollLeft: 0, scrollTop: 0, clientWidth: 800, clientHeight: 600 });
	const info = { get file() { return owner.file; } };
	const state = permissive({ field: () => info });
	const view = permissive({ dom, scrollDOM, contentDOM: permissive({ ownerDocument: doc }), get state() { return state; } });
	return { owner, create(): InkOverlayPlugin { return overlaySpec.create(view, undefined) as InkOverlayPlugin; } };
}

// ---- rig (copied from L-diff20-3.test.ts, itself the InkOverlay-4-3 prototype rig) -----------------------------
const PANE = 1400;
const HEIGHT = 900;
const SCROLLBAR = 17;
const LINE = 700;
const COLUMN_LOCAL = (PANE - SCROLLBAR - LINE) / 2; // 341.5
const GRANT = PANE - SCROLLBAR;

type Seed = { restingColumnMargin: number | null; columnMarginDebt: number; columnRestMargin: number | null };

function makeRig(seed: Seed) {
	const styles: Record<string, string> = {};
	const win: Fields = {
		requestAnimationFrame: vi.fn(() => 1),
		cancelAnimationFrame: vi.fn(),
		setTimeout: vi.fn(() => 0),
		clearTimeout: vi.fn(),
		CSS: { supports: () => true },
		getComputedStyle: (el: unknown) => (el === host
			? { zoom: styles.zoom ?? "1", transform: "none", width: `${PANE}px`, height: `${HEIGHT}px`, borderLeftWidth: "0", borderRightWidth: "0" }
			: { borderLeftWidth: "0", borderRightWidth: "0" }),
	};
	const classes = new Set<string>();
	const classList = (set: Set<string>) => ({
		contains: (c: string) => set.has(c),
		add: (c: string) => { set.add(c); },
		remove: (...cs: string[]) => { for (const c of cs) set.delete(c); },
		toggle: (c: string, on?: boolean) => { if (on ?? !set.has(c)) set.add(c); else set.delete(c); },
	});
	const parent: Fields = { clientWidth: PANE, clientHeight: HEIGHT, scrollLeft: 0, scrollTop: 0, classList: classList(new Set()) };
	const host: Fields = {
		clientWidth: PANE, clientHeight: HEIGHT, isConnected: true, parentElement: parent,
		ownerDocument: { defaultView: win },
		classList: classList(classes),
		getBoundingClientRect: () => ({ left: 0, top: 0, width: PANE, height: HEIGHT }),
		style: {
			getPropertyValue: (n: string) => styles[n] ?? "",
			getPropertyPriority: () => "",
			setProperty: (n: string, v: string) => { styles[n] = v; },
			removeProperty: (n: string) => { delete styles[n]; },
		},
		setCssStyles: (s: Record<string, string>) => { Object.assign(styles, s); },
	};

	const overlay = Object.create(InkOverlayPlugin.prototype) as Fields;
	const k = (): number => overlay.pinchScaleNow as number;
	let scrollLeft = 0, scrollTop = 0;
	const clientWidth = (): number => (PANE - SCROLLBAR) / k();
	const scroller: Fields = {
		get scrollLeft() { return scrollLeft; },
		set scrollLeft(v: number) { scrollLeft = Math.max(0, Math.min(v, this.scrollWidth - this.clientWidth)); },
		get scrollTop() { return scrollTop; },
		set scrollTop(v: number) { scrollTop = Math.max(0, v); },
		get clientWidth() { return clientWidth(); },
		get offsetWidth() { return PANE / k(); },
		get scrollWidth() { return Math.max(clientWidth(), PANE - SCROLLBAR) + GRANT; },
		scrollHeight: 48000, clientHeight: HEIGHT,
		getBoundingClientRect: () => ({ left: 0, top: 0, width: PANE, height: HEIGHT }),
	};

	const measures: Array<{ read: () => unknown; write: (v: unknown) => void }> = [];
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	overlay.view = { dom: host, scrollDOM: scroller, contentDOM: { getBoundingClientRect: () => ({ left: 0, top: 0 }), children: [] }, requestMeasure: (m: any) => { measures.push(m); }, measure: vi.fn(), viewport: { from: 0, to: 0 } };
	overlay.container = { setCssStyles: vi.fn() };
	overlay.frame = { locked: false };
	overlay.canvasMode = true;
	overlay.cssScale = 1; overlay.fontZoom = 1; overlay.scale = 1;
	overlay.pinchScaleNow = 1;
	overlay.zoomFloor = MIN_PINCH_SCALE;
	overlay.pinchRefScale = null;
	overlay.pinchPreview = false;
	overlay.viewportGeneration = 0;
	overlay.retiring = false;
	overlay.panAnchorHold = null;
	overlay.scrollExpansion = null;
	overlay.hostZoomSupport = null;
	overlay.previewInkOffset = 0; overlay.previewInkOffsetY = 0;
	overlay.columnRestMargin = seed.columnRestMargin;
	overlay.restingColumnMargin = seed.restingColumnMargin;
	overlay.columnMarginDebt = seed.columnMarginDebt;
	overlay.viewportLayout = null;
	overlay.getNoteViewportState = () => ({ zoom: overlay.pinchScaleNow, busy: false, fitAvailable: true });
	overlay.prepareViewportLayout = () => {
		if (!overlay.viewportLayout) overlay.viewportLayout = {
			parent, paneWidth: PANE, paneHeight: HEIGHT, externalScale: 1, baseTransform: "none", baseZoom: 1,
			width: PANE, height: HEIGHT, column: LINE, columnBox: LINE, gutterX: SCROLLBAR, gutterScreen: SCROLLBAR,
			sizerColumn: true, columnInset: true, ownLines: false, left: "0px", right: "0px",
			columnLocal: COLUMN_LOCAL, columnAuto: { lineWidth: LINE, fixed: 0, scrollbar: SCROLLBAR },
			styles: new Map([["zoom", { value: "", priority: "" }]]),
		};
		return true;
	};
	let path = "note.md";
	overlay.filePath = () => path;
	overlay.lastPath = path;
	overlay.panX = () => 0;
	overlay.panY = () => 0;
	for (const name of ["restorePinchLayers", "retirePanSettle", "releaseMeasures", "clearViewportPan", "updatePaperSpacing", "refreshPenCursor", "updateExtent", "scheduleRepaint", "handleResize", "endPreviewPaper", "placeCanvasLayers"]) overlay[name] = vi.fn();
	overlay.syncBand = () => "none";
	overlay.firstSettleConsumer = () => false;
	overlay.ownsMarkdownEditorRoot = () => true;
	for (const name of ["updateHandwritingPageClass", "resetGestureState", "loadInk", "writeInkLayerTransform"]) overlay[name] = vi.fn();
	overlay.emptyNoticeGate = { forgetAll: vi.fn() };
	overlay.wet = { clear: vi.fn() };
	overlay.highlightWet = { clear: vi.fn() };
	overlay.highlightWetCanvas = { setCssStyles: vi.fn() };
	overlay.tail = {
		clearAll: vi.fn(),
		configureInlineBacking: () => undefined,
		placeInline: () => undefined,
		restoreFullSurface: () => undefined,
		prepareLive: () => undefined,
	};
	overlay.mobileTools = null;
	overlay.router = null;
	overlay.undoIdentity = null;

	const margin = (): number => {
		if (!classes.has("handwriting-note-viewport")) return COLUMN_LOCAL;
		const auto = Number.parseFloat(styles["--handwriting-column-auto-left"] ?? "NaN");
		const frozen = Number.parseFloat(styles["--handwriting-column-margin-left"] ?? "NaN");
		return Math.max(0, Math.min(auto, frozen));
	};
	const columnScreenX = (): number => (margin() - scrollLeft) * k();
	const flush = async (): Promise<void> => {
		while (measures.length) { const m = measures.shift()!; m.write(m.read()); }
		await Promise.resolve(); await Promise.resolve();
	};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const P = InkOverlayPlugin.prototype as any;
	const zoomBy = async (factor: number): Promise<boolean> => { const r = P.zoomNoteBy.call(overlay, factor); await flush(); return r; };
	/** Fit on a note with no ink: InkOverlay.ts:9016 `commitCameraScale(1,{left:0,top:0})`. */
	const fitEmpty = async (): Promise<boolean> => { const r = P.commitCameraScale.call(overlay, 1, { left: 0, top: 0 }); await flush(); return r; };
	/** Switch: the path changes with no file object and no rename record; the next CodeMirror update reaches the REAL
	 * update()/updateInner and its note-switch branch. */
	const switchTo = async (to: string): Promise<void> => {
		path = to;
		P.update.call(overlay, { transactions: [], docChanged: false, geometryChanged: false, viewportChanged: false });
		await flush();
		// The real handleResize re-measures cssScale from the host after the restore (:3588-3592); stubbed here.
		overlay.cssScale = 1; overlay.scale = 1;
	};
	const snap = () => ({ k: k(), scroll: scrollLeft, column: columnScreenX(), debt: overlay.columnMarginDebt as number, baseline: overlay.restingColumnMargin as number | null });
	return { overlay, zoomBy, fitEmpty, switchTo, snap, classes };
}

let fresh: Seed | null = null;
const fmt = (s: { k: number; scroll: number; column: number; debt: number; baseline: number | null }) =>
	`k ${s.k} scrollLeft ${s.scroll.toFixed(2)} column@${s.column.toFixed(2)}px debt ${s.debt.toFixed(2)} baseline ${s.baseline}`;

/** A note taken to `before` (or left untouched), switched away from, then acted on - against a fresh twin given the same act. */
async function switchedVsTwin(before: number | null, act: (r: ReturnType<typeof makeRig>) => Promise<boolean>, plant = false) {
	const r = makeRig(fresh!);
	if (before !== null) expect(await r.zoomBy(before), "precondition: pre-switch zoom committed").toBe(true);
	const preSwitch = r.snap();
	await r.switchTo(SWITCHED);
	expect(f(r.overlay).lastPath, "precondition: the REAL note-switch branch ran").toBe(SWITCHED);
	expect(r.snap().k, "precondition: the switch reset the camera to 100%").toBe(1);
	expect(r.snap().scroll).toBe(0);
	expect(r.classes.has("handwriting-note-viewport"), "precondition: restoreViewportLayout handed the host back").toBe(false);
	if (plant) { f(r.overlay).restingColumnMargin = null; f(r.overlay).columnMarginDebt = 0; }
	const carried = r.snap();
	expect(await act(r), "precondition: the switched editor's commit ran").toBe(true);
	const t = makeRig(fresh!);
	expect(t.snap().column, "precondition: the twin shows the same natural inset at 100%").toBeCloseTo(carried.column, 6);
	expect(await act(t), "precondition: the twin's commit ran").toBe(true);
	return { preSwitch, carried, switched: r.snap(), twin: t.snap() };
}

beforeAll(async () => {
	installOverride();
	await loadNote();
});
afterEach(() => vi.restoreAllMocks());

describe("L-diff20-3 judge: the rename route (J0) and the note-switch branch (J1-J5)", () => {
	it("J0 host route: a rename keeps the instance and, since 1.4.22, its camera and both fields with it", () => {
		expect(overlaySpec instanceof ViewPlugin, "precondition: index 2 of inkOverlayExtension() is the overlay's ViewPlugin").toBe(true);
		const ed = makeEditor(A);
		const a = ed.create();
		expect(a instanceof InkOverlayPlugin).toBe(true);
		expect(f(a).container, "precondition: the real constructor mounted").toBeTruthy();
		expect(f(a).restingColumnMargin, "class-field initial value").toBeNull();
		expect(f(a).columnMarginDebt, "class-field initial value").toBe(0);
		fresh = { restingColumnMargin: f(a).restingColumnMargin, columnMarginDebt: f(a).columnMarginDebt, columnRestMargin: f(a).columnRestMargin ?? null };
		// The note's zoomed-in end state (200%, auto-clamped resting margin 0, an unpaid remainder).
		f(a).pinchScaleNow = 2; f(a).restingColumnMargin = 0; f(a).columnMarginDebt = -170.75;
		// Obsidian's rename: the vault event re-keys the stores (main.ts:3534), the SAME TFile's path moves in place,
		// FileView/MarkdownView.onRename only retitle - no setState, so CodeMirror keeps this instance.
		inlineInk.handleRename(A, RENAMED);
		ed.owner.file.path = RENAMED;
		(a as unknown as { update(u: unknown): void }).update({ transactions: [], docChanged: false, geometryChanged: false, viewportChanged: false });
		// A rename is not a note switch: the kept instance follows the new path and keeps its camera, so the margin
		// baseline and remainder still describe the page on screen and stay.
		expect(f(a).lastPath, "the kept instance follows the new path").toBe(RENAMED);
		expect(f(a).pinchScaleNow, "the rename kept the camera").toBe(2);
		expect(f(a).restingColumnMargin, "baseline kept with the camera").toBe(0);
		expect(f(a).columnMarginDebt, "remainder kept with the camera").toBe(-170.75);
		(a as unknown as { destroy(): void }).destroy();
	});

	it("J1 '-' after a switch from a note left at 200% lands where a freshly opened note lands", async () => {
		const o = await switchedVsTwin(2, (r) => r.zoomBy(0.5));
		expect(o.preSwitch.baseline, "precondition: at 200% the note rests at margin 0").toBe(0);
		const report = `switched: ${fmt(o.switched)} | twin: ${fmt(o.twin)}`;
		expect(o.switched.scroll, `J1 ${report}`).toBeCloseTo(o.twin.scroll, 6);
		expect(o.switched.column, `J1 ${report}`).toBeCloseTo(o.twin.column, 6);
	});

	it("J2 plant: the same switch with ONLY the two fields cleared lands exactly on the twin", async () => {
		const o = await switchedVsTwin(2, (r) => r.zoomBy(0.5), true);
		const report = `switched+plant: ${fmt(o.switched)} | twin: ${fmt(o.twin)}`;
		expect(o.switched.scroll, `J2 ${report}`).toBeCloseTo(o.twin.scroll, 6);
		expect(o.switched.column, `J2 ${report}`).toBeCloseTo(o.twin.column, 6);
	});

	it("J3 '+' (x1.25) after a switch from a note left at 200% lands where a freshly opened note lands", async () => {
		const o = await switchedVsTwin(2, (r) => r.zoomBy(1.25));
		const report = `switched: ${fmt(o.switched)} | twin: ${fmt(o.twin)}`;
		expect(o.switched.scroll, `J3 ${report}`).toBeCloseTo(o.twin.scroll, 6);
		expect(o.switched.column, `J3 ${report}`).toBeCloseTo(o.twin.column, 6);
	});

	it("J4 Fit on an ink-less note (commit at 100%, :9016) after a switch from a note left at 200% leaves it where a fresh note stays", async () => {
		const o = await switchedVsTwin(2, (r) => r.fitEmpty());
		const report = `switched: ${fmt(o.switched)} | twin: ${fmt(o.twin)}`;
		expect(o.switched.scroll, `J4 ${report}`).toBeCloseTo(o.twin.scroll, 6);
		expect(o.switched.column, `J4 ${report}`).toBeCloseTo(o.twin.column, 6);
	});

	it("J5 control: a switch from a note left at 50% (resting at the natural inset) then '-' lands on the twin", async () => {
		const o = await switchedVsTwin(0.5, (r) => r.zoomBy(0.5));
		expect(o.preSwitch.baseline, "precondition: at 50% the note rests at the natural inset").toBeCloseTo(COLUMN_LOCAL, 6);
		const report = `switched: ${fmt(o.switched)} | twin: ${fmt(o.twin)}`;
		expect(o.switched.scroll, `J5 ${report}`).toBeCloseTo(o.twin.scroll, 6);
		expect(o.switched.column, `J5 ${report}`).toBeCloseTo(o.twin.column, 6);
	});
});
