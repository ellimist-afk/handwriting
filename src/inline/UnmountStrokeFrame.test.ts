/**
 * A stroke still being drawn when the pane goes is stored in the note's stored frame, as a lift stores it.
 *
 * The note's ink file stores a font size (20 px) other than the one the editor measures (16 px), and the file lands
 * while the pen is down: the adoption is held for the contact (adoptStoredFontRef) and the store moves its own ink into
 * the stored frame. Then the pane closes with the pen still down: unmount commits the live stroke through the router's
 * finishActiveStroke, which runs the real penUp. A lift with the pane staying (endLiveStroke, the way a window blur
 * ends a stroke) commits the same stroke through the same path. Both must store the same stroke: its points, box,
 * width and the line it remembers (line, that line's top, its y). A retiring overlay re-measures nothing: unmount makes
 * no resize call.
 *
 * Rig: the Object.create overlay of A1-2-ink-during-load-font-ref.test.ts (the real handleResize, loadInk and
 * adoptStoredFontRef over the real inlineInk store, the ink file's read held open by the test), with the fields the
 * real unmount reads seeded as RemountFontRef.test.ts seeds them. A router stand-in whose finishActiveStroke runs the
 * real penUp at once and which has dispose; a frame locked by the contact, with end() and cancel() that unlock it; a
 * builder that hands back the drawn stroke; a view with a document and a height map (lines PITCH editor px apart), so
 * the line anchors read a layout. Each cell uses a note of its own: the store is one for the whole module.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

(globalThis as { window?: unknown }).window = globalThis;

import { Text } from "@codemirror/state";
import { InkOverlayPlugin, inlineInk } from "./InkOverlay";
import { WheelZoomRun } from "./WheelZoom";
import { emptyPage } from "../model/PageData";
import type { InlineInkHost } from "./InlineInkStore";
import type { InkStroke } from "../ink/Stroke";
import { fontZoomFactor } from "./ZoomScale";

type Fields = Record<string, unknown>;

const EDITOR_FONT = 16;
const STORED_REF = 20;
/** Editor px between line tops. */
const PITCH = 24;
const LINES = 80;
const SIG = { width: 700, fontPx: EDITOR_FONT, charWidth: 8 };
const doc = Text.of(Array.from({ length: LINES }, (_, i) => `line ${i + 1}`));

let releaseRead: (() => void) | null = null;
/** The font size stored in each note's ink file, by page id; absent = none stored. */
const storedRef = new Map<string, number>();

const host: InlineInkHost = {
	readPageId: (path) => `pg-${path}`,
	claimId: async (_p, id) => ({ pageId: id }),
	loadSidecar: (id) =>
		new Promise((resolve) => {
			releaseRead = () => {
				const page = emptyPage(id);
				page.surface = "inline";
				const ref = storedRef.get(id);
				if (ref !== undefined) page.fontRefPx = ref;
				page.strokes = [];
				resolve({ data: page, recovered: false });
			};
		}),
	scheduleSidecar: () => undefined,
	notify: () => undefined,
};

beforeAll(() => inlineInk.attachHost(host));
afterAll(() => {
	(inlineInk as unknown as { host: unknown }).host = null;
});

function el(extra: Fields = {}): Fields {
	return {
		setCssStyles: () => undefined,
		remove: () => undefined,
		classList: { add: () => undefined, remove: () => undefined },
		style: { removeProperty: () => undefined },
		...extra,
	};
}

const proto = InkOverlayPlugin.prototype as unknown as {
	handleResize: () => void;
	loadInk: (path: string | null) => void;
	penUp: (ev?: PointerEvent) => void;
	unmount: () => void;
	endLiveStroke: (preserveMouse?: boolean) => void;
	adoptStoredFontRef: (path: string) => void;
};

/**
 * The drawn stroke, in the frame the contact began in (font zoom 1: note px = screen px). One sample, as in
 * A1-2-ink-during-load-font-ref.test.ts: the committed paint draws nothing, where the stroke is stored is the question.
 */
function drawnStroke(id: string): InkStroke {
	return {
		id, tool: "pen", color: "#000000", width: 2,
		points: [{ x: 100, y: 300, pressure: 0.5, t: 0 }],
		bbox: { x: 98, y: 298, width: 44, height: 16 },
		createdAt: 1,
	} as InkStroke;
}

function makeRig() {
	const o = Object.create(InkOverlayPlugin.prototype) as Fields;
	const contentHost = { fontSize: `${EDITOR_FONT}px` };
	let openPath: string | null = null;
	const canvas = (): Fields => el({ width: 0, height: 0, getContext: () => null });
	const canvases = [canvas(), canvas(), canvas(), canvas(), canvas()];
	const rect = { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 };
	const container = el({ getBoundingClientRect: () => rect, offsetWidth: 800, offsetHeight: 600 });
	const scrollDOM = el({
		scrollLeft: 0, scrollTop: 0, clientWidth: 800, clientHeight: 600, scrollWidth: 800, scrollHeight: 600,
		addEventListener: () => undefined, removeEventListener: () => undefined,
	});
	const win = {
		devicePixelRatio: 1,
		getComputedStyle: () => ({ get fontSize() { return contentHost.fontSize; } }),
		requestAnimationFrame: () => 0,
		cancelAnimationFrame: () => undefined,
		clearTimeout: () => undefined,
	};
	o.view = {
		state: { doc, field: () => undefined },
		lineBlockAt: (pos: number) => {
			const n = doc.lineAt(pos).number;
			return { top: (n - 1) * PITCH, bottom: n * PITCH };
		},
		dom: el({ ownerDocument: { defaultView: win }, parentElement: null }),
		scrollDOM,
		contentDOM: el({ children: [] as unknown[], getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }) }),
		scaleX: 1, scaleY: 1, documentTop: 0,
	};
	o.container = container;
	o.committedCanvas = canvases[0];
	o.wetCanvas = canvases[1];
	o.tailCanvas = canvases[2];
	o.highlightCanvas = canvases[3];
	o.highlightWetCanvas = canvases[4];
	o.committedCtx = { setTransform: () => undefined };
	o.highlightCtx = { setTransform: () => undefined };
	const renderer = { applyDpr: () => undefined, clear: () => undefined };
	o.wet = renderer;
	o.highlightWet = renderer;
	o.tail = {
		applyDpr: () => undefined, clearAll: () => undefined, configureInlineBacking: () => undefined,
		placeInline: () => undefined, restoreFullSurface: () => undefined, prepareLive: () => undefined,
		clear: () => undefined,
	};
	// Scale state, as the field initialisers leave it.
	o.contentStyle = null;
	o.refFontPx = 0;
	o.lastFontStr = "";
	o.lastSyncFontStr = "";
	o.cssScale = 1;
	o.fontZoom = 1;
	o.scale = 1;
	o.dpr = 1;
	o.cssWidth = 0;
	o.cssHeight = 0;
	o.frame = { locked: false, end: () => undefined, cancel: () => undefined };
	o.wheelZoomRun = new WheelZoomRun();
	o.paperKindWatch = [];
	o.paperKindFrame = null;
	o.band = null;
	o.router = null;
	o.axisChecked = false;
	o.lastReach = null;
	o.indexDirty = true;
	o.lastPaintCam = null;
	o.damage = { addAll: () => undefined };
	o.spacer = null;
	o.spacerLeft = Number.NaN;
	o.spacerTop = Number.NaN;
	o.pinchScaleNow = 1;
	o.pinchRasterScale = 1;
	o.mobileTools = null;
	o.noteZoomControls = null;
	// What the real unmount reads, seeded as RemountFontRef.test.ts seeds it.
	o.builder = null;
	o.mode = "ink";
	o.erased = [];
	o.erasePieces = new Set<string>();
	o.eraseFrom = [];
	o.eraseWhole = false;
	o.lassoPts = [];
	o.lassoActive = false;
	o.dragFrom = null;
	o.dragTotal = null;
	o.spaceLineY = null;
	o.spaceIds = [];
	o.spaceBounds = null;
	o.spaceClient = null;
	o.spaceTotalDy = 0;
	o.panLast = null;
	o.selection = { clear: () => undefined, isEmpty: true };
	o.selectionDeleteKeys = { reset: () => undefined };
	o.axisGuard = { restore: () => undefined, capture: () => undefined };
	o.penCursorEl = null;
	o.eraserEl = null;
	o.resizeObserver = null;
	o.scrollFn = null;
	o.wheelFn = null;
	o.mediaQuery = null;
	o.mediaFn = null;
	o.offInkChanged = null;
	o.lastExtentInputs = null;
	o.metadataObserver = null;
	o.metadataFrame = null;
	o.pageClassHost = null;
	o.hoverWatchdog = null;
	o.frameTicking = false;
	o.pinchRaf = 0;
	o.pinchPending = null;
	o.pinchRefScale = null;
	o.pinchAnchor = null;
	o.pinchScrollAt = 0;
	o.scrollPositionPatched = false;
	o.hostPositionPatched = false;
	o.chromeHostPatched = null;
	// The lift's own state.
	o.resizeDeferred = false;
	o.canvasOffResetPending = false;
	o.bandSyncDeferred = false;
	o.viewportStyleDirty = false;
	o.pinchGive = null;
	o.pinchPreview = false;
	o.strokePenGesture = true;
	o.strokeRawMax = 0;
	o.mouseStroke = false;
	o.snapPreview = null;
	o.snapSealed = false;
	o.leftReserveHeld = 0;
	o.viewportPan = { x: 0, y: 0 };
	o.boundReadout = { floorX: 0, floorY: 0 };
	o.canvasMode = false;
	o.camera = { snapshot: {} };
	o.activeWet = { clearStroke: () => undefined };
	// Not under test, and they want a real canvas context or a real editor.
	const noop = () => undefined;
	o.repaint = noop;
	o.scheduleRepaint = noop;
	o.updateHandwritingPageClass = noop;
	o.stopFrameTicker = noop;
	o.markCommittedPaint = noop;
	o.committedCtxFor = () => ({});
	o.dispatchInk = noop;
	o.repaintPath = noop;
	o.updateExtent = noop;
	o.filePath = () => openPath;
	// The handleResize calls made while the test watches, through the real method.
	let resizes = 0;
	let counting = false;
	o.handleResize = () => {
		if (counting) resizes++;
		proto.handleResize.call(o);
	};
	// The router: finishActiveStroke ends the contact the way InlinePenRouterEnd does, with a synchronous pen-up
	// carrying no event.
	let routerLive = false;
	const router = {
		finishActiveStroke: () => {
			if (!routerLive) return false;
			routerLive = false;
			proto.penUp.call(o);
			return true;
		},
		dispose: noop,
		cameraTransformChanged: noop,
		refreshRect: noop,
		sampleAt: () => null,
	};
	return {
		overlay: o,
		resize(fontPx: number) {
			contentHost.fontSize = `${fontPx}px`;
			proto.handleResize.call(o);
		},
		resizeRaw(raw: string) {
			contentHost.fontSize = raw;
			proto.handleResize.call(o);
		},
		openNow(path: string) {
			openPath = path;
			proto.loadInk.call(o, path);
		},
		renameTo(path: string) {
			openPath = path;
		},
		/** The pen goes down: the contact owns the frame, the router holds it and the builder holds the stroke. */
		penDown(stroke: InkStroke) {
			const frame = { locked: true, end() { frame.locked = false; }, cancel() { frame.locked = false; } };
			o.frame = frame;
			o.router = router;
			routerLive = true;
			o.builder = { flushRaw: noop, finishReleaseFiltered: () => [structuredClone(stroke)] };
		},
		count<T>(run: () => T): { value: T; resizes: number } {
			resizes = 0;
			counting = true;
			try {
				return { value: run(), resizes };
			} finally {
				counting = false;
			}
		},
	};
}

type Rig = ReturnType<typeof makeRig>;

const settle = async () => {
	for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** Open `note`, put the pen down, let the ink file land while it is down, then give the anchors their signature. */
async function heldThroughLoad(note: string, ref: number | null, opts: { firstFont?: string; lockBeforeOpen?: boolean } = {}): Promise<Rig> {
	if (ref === null) storedRef.delete(`pg-${note}`);
	else storedRef.set(`pg-${note}`, ref);
	releaseRead = null;
	const rig = makeRig();
	if (opts.firstFont !== undefined) rig.resizeRaw(opts.firstFont);
	else rig.resize(EDITOR_FONT);
	if (opts.lockBeforeOpen) rig.penDown(drawnStroke("in-flight"));
	rig.openNow(note);
	expect(releaseRead, "premise: the ink file's read is in flight").not.toBeNull();
	if (!opts.lockBeforeOpen) rig.penDown(drawnStroke("in-flight"));
	releaseRead!();
	await inlineInk.ensureLoaded(note);
	await settle();
	(rig.overlay.lineAnchors as { setSignature(s: typeof SIG): boolean }).setSignature(SIG);
	return rig;
}

/** The full premise of the held state the cells start from. */
function expectHeld(rig: Rig, note: string, stored: number | null, before: number): void {
	const o = rig.overlay;
	expect(inlineInk.fontRefPx(note), "premise: the stored size as the landed file set it").toBe(stored);
	expect(o.refFontPx, "premise: the size the stroke was drawn under").toBe(before);
	expect(o.heldFontRef, "premise: the adoption is held for the contact").toBe(note);
	expect((o.frame as { locked: boolean }).locked, "premise: the contact owns the frame").toBe(true);
	expect(o.builder, "premise: a stroke builder is live").not.toBeNull();
	expect(o.fontZoom, "premise: the stroke is drawn at font zoom 1").toBe(1);
	expect(o.resizeDeferred, "premise: no pane resize held for the stroke").toBe(false);
	expect(o.canvasOffResetPending, "premise: no canvas-off reset pending").toBe(false);
}

interface Committed {
	points: Array<{ x: number; y: number }>;
	bbox: { x: number; y: number; width: number; height: number };
	width: number;
	anchor: { line: number; top: number; y: number } | null;
}

function committedOf(path: string): Committed {
	const s = inlineInk.strokes(path).find((x) => x.id === "in-flight");
	expect(s, "premise: the stroke was committed").toBeDefined();
	const a = s!.lineAnchor;
	return {
		points: s!.points.map((p) => ({ x: p.x, y: p.y })),
		bbox: { ...s!.bbox },
		width: s!.width,
		anchor: a ? { line: a.line, top: a.top, y: a.y } : null,
	};
}

/** Every field compared, each on its own (soft), so a red run names all that differ. */
function expectSame(got: Committed, want: Committed, label: string): void {
	expect(got.points.length, `${label}: point count`).toBe(want.points.length);
	got.points.forEach((p, i) => {
		expect.soft(p.x, `${label}: point ${i} x`).toBeCloseTo(want.points[i]!.x, 9);
		expect.soft(p.y, `${label}: point ${i} y`).toBeCloseTo(want.points[i]!.y, 9);
	});
	for (const k of ["x", "y", "width", "height"] as const) expect.soft(got.bbox[k], `${label}: bbox ${k}`).toBeCloseTo(want.bbox[k], 9);
	expect.soft(got.width, `${label}: width`).toBeCloseTo(want.width, 9);
	expect(got.anchor, `${label}: a line anchor is taken`).not.toBeNull();
	expect.soft(got.anchor!.line, `${label}: anchor line`).toBe(want.anchor!.line);
	expect.soft(got.anchor!.top, `${label}: anchor top`).toBeCloseTo(want.anchor!.top, 9);
	expect.soft(got.anchor!.y, `${label}: anchor y`).toBeCloseTo(want.anchor!.y, 9);
}

/** The stroke as drawn, scaled by `k` about the note's origin, with the anchor the layout gives it at font zoom `zoom`. */
function expected(k: number, zoom: number): Committed {
	const s = drawnStroke("in-flight");
	const bboxY = s.bbox.y * k;
	const px = zoom;
	const line = Math.min(LINES, Math.floor((bboxY * px) / PITCH) + 1);
	return {
		points: s.points.map((p) => ({ x: p.x * k, y: p.y * k })),
		bbox: { x: s.bbox.x * k, y: bboxY, width: s.bbox.width * k, height: s.bbox.height * k },
		width: s.width * k,
		anchor: { line, top: ((line - 1) * PITCH) / px, y: bboxY },
	};
}

const K = STORED_REF / EDITOR_FONT;
const STORED_ZOOM = fontZoomFactor(EDITOR_FONT, STORED_REF);

describe("a stroke committed as the pane goes is stored in the note's stored frame", () => {
	it("control: a lift with the pane staying stores the stroke in the stored frame, on the line under the pen", async () => {
		const note = "unmount-frame-lift.md";
		const rig = await heldThroughLoad(note, STORED_REF);
		expectHeld(rig, note, STORED_REF, EDITOR_FONT);
		proto.endLiveStroke.call(rig.overlay);
		const got = committedOf(note);
		expectSame(got, expected(K, STORED_ZOOM), "lift");
		// The line under the pen as drawn: y 298 editor px at font zoom 1.
		expect(got.anchor!.line).toBe(Math.floor(298 / PITCH) + 1);
		expect(rig.overlay.fontZoom, "the lift puts the pane in the stored frame").toBeCloseTo(STORED_ZOOM, 12);
	});

	it("the pane closing with the pen down stores the same stroke as the lift: points, box, width and line anchor", async () => {
		const lift = await heldThroughLoad("unmount-frame-pair-lift.md", STORED_REF);
		expectHeld(lift, "unmount-frame-pair-lift.md", STORED_REF, EDITOR_FONT);
		proto.endLiveStroke.call(lift.overlay);
		const want = committedOf("unmount-frame-pair-lift.md");

		const gone = await heldThroughLoad("unmount-frame-pair-gone.md", STORED_REF);
		expectHeld(gone, "unmount-frame-pair-gone.md", STORED_REF, EDITOR_FONT);
		proto.unmount.call(gone.overlay);
		expectSame(committedOf("unmount-frame-pair-gone.md"), want, "pane closed");
	});

	it("unmount re-measures nothing: no resize call, the font reference and the font string seen are unchanged", async () => {
		const note = "unmount-frame-no-resize.md";
		const rig = await heldThroughLoad(note, STORED_REF);
		expectHeld(rig, note, STORED_REF, EDITOR_FONT);
		const o = rig.overlay;
		const refBefore = o.refFontPx, fontStrBefore = o.lastSyncFontStr;
		const { resizes } = rig.count(() => proto.unmount.call(o));
		expect(resizes, "no resize call from unmount").toBe(0);
		expect(o.refFontPx, "the font reference is not re-latched").toBe(refBefore);
		expect(o.lastSyncFontStr, "the font string seen is not reset").toBe(fontStrBefore);
		expect(o.heldFontRef ?? null, "the hold goes with the overlay").toBeNull();
	});

	it("with nothing stored the stroke the pane's close commits is the stroke as drawn (factor 1)", async () => {
		const note = "unmount-frame-none-stored.md";
		const rig = await heldThroughLoad(note, null, { lockBeforeOpen: true });
		expectHeld(rig, note, null, EDITOR_FONT);
		const zoomBefore = rig.overlay.fontZoom;
		const { resizes } = rig.count(() => proto.unmount.call(rig.overlay));
		const got = committedOf(note);
		expectSame(got, expected(1, 1), "nothing stored");
		expect(resizes).toBe(0);
		expect(rig.overlay.fontZoom, "factor 1: the font zoom is not written").toBe(zoomBefore);
	});

	it("with no font reference latched yet the stroke the pane's close commits is the stroke as drawn (factor 1)", async () => {
		const note = "unmount-frame-no-latch.md";
		const rig = await heldThroughLoad(note, STORED_REF, { firstFont: "", lockBeforeOpen: true });
		expectHeld(rig, note, STORED_REF, 0);
		const zoomBefore = rig.overlay.fontZoom;
		const { resizes } = rig.count(() => proto.unmount.call(rig.overlay));
		const got = committedOf(note);
		const d = drawnStroke("in-flight");
		got.points.forEach((p, i) => {
			expect(p.x).toBeCloseTo(d.points[i]!.x, 9);
			expect(p.y).toBeCloseTo(d.points[i]!.y, 9);
		});
		expect(got.width).toBeCloseTo(d.width, 9);
		expect(resizes).toBe(0);
		expect(rig.overlay.fontZoom, "factor 1: the font zoom is not written").toBe(zoomBefore);
	});

	it("a note renamed under the contact keeps the stroke as drawn (factor 1): the held path is not the open one", async () => {
		const note = "unmount-frame-renamed-from.md";
		const renamed = "unmount-frame-renamed-to.md";
		const rig = await heldThroughLoad(note, STORED_REF);
		expectHeld(rig, note, STORED_REF, EDITOR_FONT);
		rig.renameTo(renamed);
		const zoomBefore = rig.overlay.fontZoom;
		const { resizes } = rig.count(() => proto.unmount.call(rig.overlay));
		const got = committedOf(renamed);
		const d = drawnStroke("in-flight");
		got.points.forEach((p, i) => {
			expect(p.x).toBeCloseTo(d.points[i]!.x, 9);
			expect(p.y).toBeCloseTo(d.points[i]!.y, 9);
		});
		expect(got.width).toBeCloseTo(d.width, 9);
		expect(resizes).toBe(0);
		expect(rig.overlay.fontZoom, "factor 1: the font zoom is not written").toBe(zoomBefore);
	});

	// The size the stroke is drawn at is the font zoom times the font reference. When that product is no usable size the
	// factor is 1 and nothing is written: the zoom helper's own 1 for a bad input is not a frame to store the stroke in.
	it.each([
		["zero", 0],
		["not a number", Number.NaN],
		["infinite", Number.POSITIVE_INFINITY],
	])("with no usable drawn size (font zoom %s) the stroke the pane's close commits is the stroke as drawn (factor 1)", async (label, zoom) => {
		const note = `unmount-frame-unusable-size-${label.replace(/ /g, "-")}.md`;
		const rig = await heldThroughLoad(note, STORED_REF);
		expectHeld(rig, note, STORED_REF, EDITOR_FONT);
		const o = rig.overlay;
		o.fontZoom = zoom;
		const { resizes } = rig.count(() => proto.unmount.call(o));
		const got = committedOf(note);
		const d = drawnStroke("in-flight");
		got.points.forEach((p, i) => {
			expect.soft(p.x, `point ${i} x`).toBeCloseTo(d.points[i]!.x, 9);
			expect.soft(p.y, `point ${i} y`).toBeCloseTo(d.points[i]!.y, 9);
		});
		for (const k of ["x", "y", "width", "height"] as const) expect.soft(got.bbox[k], `bbox ${k}`).toBeCloseTo(d.bbox[k], 9);
		expect.soft(got.width, "width").toBeCloseTo(d.width, 9);
		expect.soft(o.fontZoom, "the font zoom is not written").toBe(zoom);
		expect(resizes).toBe(0);
		// As before the pane went: at that zoom the editor gives no line layout, so no line is remembered.
		expect(got.anchor, "no line anchor, as the zoom the stroke was drawn at gives").toBeNull();
	});
});
