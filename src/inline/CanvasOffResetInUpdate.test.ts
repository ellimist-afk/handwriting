/**
 * The canvas-off reset never starts inside CodeMirror's own update.
 *
 * A note zoomed away from 100 percent sits in a hidden tab when the canvas is turned off: the one reset is refused (no
 * box) and stays pending. While the tab is hidden the text size changes. When the tab shows again, CodeMirror's update
 * can reach the overlay before the pane's resize observer does: the update reads the font as changed and runs the
 * resize inside the update, and that resize retries the pending reset. The reset's zoom-button hold reads the editor's
 * layout (posAtCoords), and its settle dispatches a scroll request; CodeMirror refuses both during an update by throwing,
 * which crashes the plugin. So inside an update the reset must not start at all: no layout read, no dispatch, still
 * pending. It lands at 100 percent outside the update, on the pane observer's resize.
 *
 * Rig: the prototype rig of src/__audit__/InkOverlay-5-2.test.ts (the real commitCameraScale, zoomNoteBy, applyCanvasMode,
 * retryCanvasOffReset, handleResize with its zero-size and fronting branches, and the module's canvas setter), with what
 * the update's font path and the zoom-button hold need: a `.cm-sizer` on the editor host, an editor root the overlay owns,
 * the note already open (lastPath), the cached computed style the font read compares, a real EditorState the dispatch
 * updates, and the settle's first consumer. The editor's layout reads throw CodeMirror's own message while the overlay is
 * inside an update, as CodeMirror does, and every read and dispatch is recorded with the update flag at that moment.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";

(globalThis as { window?: unknown }).window = globalThis;

import { InkOverlayPlugin, inlineInk, setScrollExpansionEnabled } from "./InkOverlay";
import type { InlineInkHost } from "./InlineInkStore";
import { MIN_PINCH_SCALE } from "./PinchScale";
import { WheelZoomRun } from "./WheelZoom";
import { emptyPage } from "../model/PageData";

type Fields = Record<string, unknown>;

const PATH = "canvas-off-reset-in-update.md";
/** CodeMirror's message for a layout read during an update (@codemirror/view, readMeasured). */
const LAYOUT_READ_IN_UPDATE = "Reading the editor layout isn't allowed during an update";

interface OverlayMethods {
	zoomNoteBy(factor: number): boolean;
	applyCanvasMode(): void;
	endWheelZoomRun(): void;
	getNoteViewportState(): { zoom: number; busy: boolean; fitAvailable: boolean };
	commitCameraScale(next: number, scroll?: { left: number; top: number }, settleHold?: object | null, preserveScrollDemand?: boolean, bypassFloor?: boolean): boolean;
	handleResize(): void;
	update(u: unknown): void;
}
const proto = InkOverlayPlugin.prototype as unknown as OverlayMethods;

async function loadNote(): Promise<void> {
	const host: InlineInkHost = {
		readPageId: (p) => "reset-in-update-page-" + p,
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
	await inlineInk.ensureLoaded(PATH);
}

function canvasStub() {
	return { width: 1280, height: 960, setCssStyles: vi.fn() };
}

interface EditorCall { name: string; inUpdate: boolean }

function makeRig() {
	// The one computed style the overlay caches and compares on every geometry update.
	const contentStyle = { fontSize: "16px" };
	const win = {
		requestAnimationFrame: vi.fn((): number => 1),
		cancelAnimationFrame: vi.fn(),
		setTimeout: vi.fn((): number => 0),
		clearTimeout: vi.fn(),
		devicePixelRatio: 1,
		getComputedStyle: () => contentStyle,
	};
	const hostStyles: Record<string, string> = {};
	const sizer = { style: {} as Record<string, string>, isConnected: true };
	// The editor host (view.dom). A background tab is display:none: clientWidth/Height read 0.
	const host: Fields = {
		clientWidth: 640, clientHeight: 480,
		ownerDocument: { defaultView: win },
		parentElement: null,
		getBoundingClientRect: () => ({ left: 0, top: 0 }),
		style: {
			getPropertyValue(name: string): string { return hostStyles[name] ?? ""; },
			setProperty(name: string, value: string): void { hostStyles[name] = value; },
			removeProperty(name: string): void { delete hostStyles[name]; },
		},
		setCssStyles(styles: Record<string, string>): void { Object.assign(hostStyles, styles); },
		querySelector: (sel: string) => (sel === ".cm-sizer" ? sizer : null),
		// The note's own editor root: the host is the source view, not inside a table cell, an embed or a popover.
		closest: (sel: string) => (sel === ".markdown-source-view" ? host : null),
	};
	const pane = { clientWidth: 640, clientHeight: 480 };
	const scrollerRect = { left: 0, top: 0, width: 640, height: 480 };
	const scroller = { scrollLeft: 0, scrollTop: 0, scrollWidth: 64000, scrollHeight: 48000, getBoundingClientRect: () => ({ ...scrollerRect }) };
	// The overlay container sits inside the scaled host: its visual rect is its layout box times the zoom.
	const containerRect = { width: 640, height: 480 };

	const o = Object.create(InkOverlayPlugin.prototype) as Fields;
	const reads: EditorCall[] = [];
	const dispatches: (EditorCall & { spec: TransactionSpec })[] = [];
	const layoutRead = (name: string) => {
		const inUpdate = !!o.inUpdate;
		reads.push({ name, inUpdate });
		if (inUpdate) throw new Error(LAYOUT_READ_IN_UPDATE);
		return null;
	};
	const view: Fields = {
		state: EditorState.create({ doc: "one\ntwo\nthree\n" }),
		dom: host,
		scrollDOM: scroller,
		contentDOM: { getBoundingClientRect: () => ({ left: 0, top: 0 }), children: [] as unknown[] },
		scaleX: 1, scaleY: 1, documentTop: 0,
		viewport: { from: 0, to: 0 },
		contentHeight: 1000,
		requestMeasure: vi.fn(),
		measure: vi.fn(),
		posAtCoords: () => layoutRead("posAtCoords"),
		coordsAtPos: () => layoutRead("coordsAtPos"),
		dispatch(spec: TransactionSpec) {
			dispatches.push({ name: "dispatch", inUpdate: !!o.inUpdate, spec });
			view.state = (view.state as EditorState).update(spec).state;
		},
	};
	o.view = view;
	o.container = {
		setCssStyles: vi.fn(),
		getBoundingClientRect: () => ({ left: 0, top: 0, ...containerRect }),
		get offsetWidth() { return containerRect.width === 0 ? 0 : Math.round(containerRect.width / (o.pinchScaleNow as number)); },
		get offsetHeight() { return containerRect.height === 0 ? 0 : Math.round(containerRect.height / (o.pinchScaleNow as number)); },
	};
	o.frame = { locked: false };
	o.builder = null;
	o.mode = "ink";
	o.retiring = false;
	o.inUpdate = false;
	o.canvasMode = false;
	o.router = {
		isStroking: false,
		setCanvasMomentumDisabled: vi.fn(),
		cameraTransformChanged: vi.fn(),
		refreshRect: vi.fn(),
	};
	o.wheelZoomRun = new WheelZoomRun();
	o.wheelZoomTimer = 0;
	o.cssScale = 1; o.fontZoom = 1; o.scale = 1;
	o.pinchScaleNow = 1;
	o.zoomFloor = MIN_PINCH_SCALE;
	o.pinchRasterScale = 1;
	o.pinchRefScale = null;
	o.pinchStartPan = { x: 0, y: 0 };
	o.pinchBand = { history: [] as number[], lastPan: { x: 0, y: 0 } };
	o.pinchAnchor = null;
	o.pinchPending = null;
	o.pinchRaf = 0;
	o.pinchScrollAt = 0;
	o.pinchPreview = false;
	o.pinchGive = null;
	o.pinchHiddenCanvases = new Map();
	o.viewportGeneration = 0;
	o.panAnchorHold = null;
	o.scrollExpansion = null;
	o.mobileTools = null;
	o.scaleGeometryValid = true;
	o.viewportStyleDirty = false;
	o.refFontPx = 16;
	o.dpr = 1;
	o.cssWidth = 1280; o.cssHeight = 960;
	o.committedCanvas = canvasStub(); o.wetCanvas = canvasStub(); o.tailCanvas = canvasStub();
	o.highlightCanvas = canvasStub(); o.highlightWetCanvas = canvasStub();
	o.committedCtx = { setTransform: vi.fn() };
	o.highlightCtx = { setTransform: vi.fn() };
	o.wet = { applyDpr: vi.fn(), clear: vi.fn() };
	o.highlightWet = { applyDpr: vi.fn(), clear: vi.fn() };
	o.tail = {
		applyDpr: vi.fn(), clearAll: vi.fn(),
		configureInlineBacking: () => undefined,
		placeInline: () => undefined,
		restoreFullSurface: () => undefined,
		prepareLive: () => undefined,
	};
	o.damage = { addAll: vi.fn() };
	o.prepareViewportLayout = () => true;
	o.viewportLayout = { width: 640, height: 480, baseTransform: "none", parent: pane, paneWidth: 640, paneHeight: 480, externalScale: 1 };
	o.panX = () => 0;
	o.panY = () => 0;
	for (const name of ["restorePinchLayers", "retirePanSettle", "releaseMeasures", "clearViewportPan", "updatePaperSpacing", "refreshPenCursor", "updateExtent", "reanchorPan", "scheduleRepaint", "repaint", "hideBlankPinchLayers", "cancelOverscrollBounce", "updateLineAnchors"]) o[name] = vi.fn();
	o.applyViewportBox = (next: number) => (host.setCssStyles as (s: Record<string, string>) => void)({ transform: `scale(${next})`, transformOrigin: "0 0" });
	o.setViewportScroll = (left: number, top: number) => { scroller.scrollLeft = left; scroller.scrollTop = top; };
	o.syncBand = () => "none";
	// The pane resized while hidden measures its natural column again: no column to adopt in this rig.
	o.measureNaturalColumn = () => ({ column: 0, columnLocal: null, columnReserve: 0, columnPad: 0, columnAuto: false });
	// The zoom-button hold's column and content reads: layout sinks, not under test.
	o.columnLocalAt = () => null;
	o.contentTopLocalAt = () => null;
	// The note is open in this editor already: the update is a geometry update, not a note switch.
	o.filePath = () => PATH;
	o.currentFile = () => null;
	o.lastPath = PATH;
	o.measureHold = null;
	o.selection = { isEmpty: true };
	// The settle-hold branch, as the overlay's scroll handler at the highest precedence makes it.
	o.firstSettleConsumer = () => true;
	o.ownScrollRange = () => EditorSelection.cursor(0);
	o.ownsPanSettle = () => true;
	o.restingColumnMargin = 0;
	// A commit's own resize is the real handleResize, as in production.
	o.handleResize = function (this: Fields) {
		return proto.handleResize.apply(this);
	};

	const commits: { next: number; ok: boolean; inUpdate: boolean }[] = [];
	o.commitCameraScale = function (this: Fields, ...args: Parameters<OverlayMethods["commitCameraScale"]>) {
		const inUpdate = !!o.inUpdate;
		const ok = proto.commitCameraScale.apply(this, args);
		commits.push({ next: args[0], ok, inUpdate });
		return ok;
	};

	const call = <K extends keyof OverlayMethods>(k: K, ...a: Parameters<OverlayMethods[K]>): ReturnType<OverlayMethods[K]> =>
		(proto[k] as (...x: unknown[]) => ReturnType<OverlayMethods[K]>).apply(o, a);

	return {
		o, commits, reads, dispatches, call, contentStyle, pane,
		scale: () => o.pinchScaleNow as number,
		/** Obsidian hides a non-active tab with display:none: every box reads 0 and the ResizeObserver fires. */
		hideTab() {
			(host as { clientWidth: number }).clientWidth = 0; (host as { clientHeight: number }).clientHeight = 0;
			pane.clientWidth = 0; pane.clientHeight = 0;
			scrollerRect.width = 0; scrollerRect.height = 0;
			containerRect.width = 0; containerRect.height = 0;
			call("handleResize");
		},
		/** The tab shows again: the boxes are back (the pane at `paneWidth`), before any observer has delivered. */
		showBoxes(paneWidth = 640) {
			(host as { clientWidth: number }).clientWidth = 640; (host as { clientHeight: number }).clientHeight = 480;
			pane.clientWidth = paneWidth; pane.clientHeight = 480;
			scrollerRect.width = 640; scrollerRect.height = 480;
			containerRect.width = 640; containerRect.height = 480;
		},
		/** The module's canvas setter, then its per-instance loop body for this overlay. */
		setGlobalCanvas(on: boolean) {
			setScrollExpansionEnabled(on);
			if (!on) call("endWheelZoomRun");
			call("applyCanvasMode");
		},
		/** CodeMirror's update for the reflow the tab's return brings: a geometry change, no transaction. */
		geometryUpdate(): unknown {
			try {
				call("update", { transactions: [], docChanged: false, geometryChanged: true, viewportChanged: false });
				return undefined;
			} catch (e) {
				return e;
			}
		},
	};
}

type Rig = ReturnType<typeof makeRig>;

/** Zoomed, hidden, canvas off (the reset refused and pending), the text size changed while hidden. */
function pendingWhileHidden(): Rig {
	const r = makeRig();
	r.setGlobalCanvas(true);
	expect(r.call("zoomNoteBy", 0.5), "premise: the canvas makes the note zoomable").toBe(true);
	expect(r.scale()).toBe(0.5);
	r.hideTab();
	expect(r.o.scaleGeometryValid, "premise: the zero-size resize branch ran").toBe(false);
	r.commits.length = 0;
	r.setGlobalCanvas(false);
	expect(r.commits, "premise: the one reset was tried at 1 and refused").toEqual([{ next: 1, ok: false, inUpdate: false }]);
	expect(r.o.canvasOffResetPending, "premise: the reset is pending").toBe(true);
	expect(r.o.lastFontStr, "premise: the font was last read before the tab hid").toBe("16px");
	r.contentStyle.fontSize = "18px";
	r.reads.length = 0;
	r.dispatches.length = 0;
	r.commits.length = 0;
	return r;
}

/** Nothing gated ran inside the update, the update did not throw, and the reset is still pending. */
function expectNothingStartedInUpdate(r: Rig, thrown: unknown): void {
	// A red must be the editor's own refusal, never the rig falling over.
	if (thrown !== undefined) expect((thrown as Error).message, "premise: the only throw is the modelled layout read").toBe(LAYOUT_READ_IN_UPDATE);
	expect.soft(r.reads.filter((c) => c.inUpdate), "no editor layout read inside the update").toEqual([]);
	expect.soft(r.dispatches.filter((c) => c.inUpdate).map((c) => c.name), "no dispatch inside the update").toEqual([]);
	expect.soft(r.commits.filter((c) => c.inUpdate && c.next === 1), "no reset commit inside the update").toEqual([]);
	expect.soft(thrown, "the update runs through").toBeUndefined();
	expect.soft(r.o.canvasOffResetPending, "the reset stays pending until it commits").toBe(true);
}

/** The pane's observer delivers after the update (outside it): the reset lands at 100 percent and sizes for it. */
function expectLandsOnTheObserver(r: Rig): void {
	r.call("handleResize");
	expect.soft(r.scale(), "the note is at 100 percent").toBe(1);
	expect.soft(r.o.canvasOffResetPending, "the reset is no longer pending").toBe(false);
	expect.soft(r.call("getNoteViewportState").zoom, "the viewport state reports 100 percent").toBe(1);
	const c = r.o.committedCanvas as { width: number; height: number; setCssStyles: { mock: { calls: unknown[][] } } };
	const calls = c.setCssStyles.mock.calls;
	const box = calls[calls.length - 1]?.[0] as { width: string; height: string; transform: string };
	expect.soft(r.o.committedBacking, "backing at 100%").toBe(1);
	expect.soft([c.width, c.height], "canvas backing size at 100%").toEqual([640, 480]);
	expect.soft(box, "canvas layer box at 100%").toMatchObject({ width: "640px", height: "480px", transform: "" });
	expect.soft(r.dispatches.filter((d) => d.inUpdate), "no dispatch inside an update at any point").toEqual([]);
}

beforeAll(async () => {
	await loadNote();
});
afterEach(() => {
	setScrollExpansionEnabled(false);
	vi.restoreAllMocks();
});

describe("the canvas-off reset never starts inside the editor's update", () => {
	it("a zoomed note in a hidden tab, canvas off, text size changed while hidden: the update the tab's return brings starts no reset; the pane's resize lands it at 100 percent", () => {
		const r = pendingWhileHidden();
		r.showBoxes();
		const thrown = r.geometryUpdate();
		expectNothingStartedInUpdate(r, thrown);
		expectLandsOnTheObserver(r);
	});

	it("the same with the pane resized while the tab was hidden", () => {
		const r = pendingWhileHidden();
		r.showBoxes(800);
		const thrown = r.geometryUpdate();
		expect((r.o.viewportLayout as { paneWidth: number }).paneWidth, "premise: the update's resize took the new pane width").toBe(800);
		expectNothingStartedInUpdate(r, thrown);
		expectLandsOnTheObserver(r);
	});

	it("the same with the pane resized while hidden and the geometry already valid again before the update: the update's resize commits at the current zoom, the reset is tried inside that commit, and it still starts nothing", () => {
		const r = pendingWhileHidden();
		// The real settle retire: the commit inside the update retires the zoom step's hold, and the overlay's own
		// retire clears it (the rig's stub would keep it as the live hold).
		r.o.retirePanSettle = (InkOverlayPlugin.prototype as unknown as { retirePanSettle(reason: string): void }).retirePanSettle;
		const retries: { depth: number; inUpdate: boolean }[] = [];
		const retry = (InkOverlayPlugin.prototype as unknown as { retryCanvasOffReset(): boolean }).retryCanvasOffReset;
		r.o.retryCanvasOffReset = function (this: Fields) {
			retries.push({ depth: (this.commitDepth as number) || 0, inUpdate: !!this.inUpdate });
			return retry.apply(this);
		};
		// Commits recorded on entry: a refused read inside one throws before the rig's own record.
		const entered: { next: number; inUpdate: boolean }[] = [];
		const commit = r.o.commitCameraScale as (...a: unknown[]) => boolean;
		r.o.commitCameraScale = function (this: Fields, ...a: unknown[]) {
			entered.push({ next: a[0] as number, inUpdate: !!this.inUpdate });
			return commit.apply(this, a);
		};
		r.showBoxes(800);
		// A camera sync read the restored box before the update (it sets the geometry valid); the layout still holds the
		// old pane width, so the update's resize takes the new one and commits at the current zoom.
		r.o.scaleGeometryValid = true;
		const thrown = r.geometryUpdate();
		expect(entered.filter((c) => c.inUpdate).map((c) => c.next)[0], "premise: the update's resize committed at the current zoom").toBe(0.5);
		expect(retries.filter((c) => c.inUpdate && c.depth > 0).length, "premise: the reset was tried inside a commit inside the update").toBeGreaterThan(0);
		expect((r.o.viewportLayout as { paneWidth: number }).paneWidth, "premise: the update's resize took the new pane width").toBe(800);
		expectNothingStartedInUpdate(r, thrown);
		expectLandsOnTheObserver(r);
	});
});
