/**
 * Ink written while a note's ink file is still loading keeps its place on screen and on disk.
 *
 * A note whose ink was drawn at a 20 px editor font (stored reference 20) is opened at 16 px, and the user writes
 * while the note's ink file is still being read. Until the read lands the overlay has no stored reference, so it
 * latches the editor's 16 px (handleResize) and the new stroke is drawn and stored in that frame. When the read
 * lands, adoptStoredFontRef switches the note to the stored 20, and the stroke drawn a moment ago is now painted at
 * 16/20 of where the pen put it, and saved in the 20 frame at its 16-frame coordinates. That is an ink jump after
 * the stroke landed (zero-snap contract) and ink saved in the wrong place.
 *
 * Rig: the Object.create overlay of FontRefPerNote.test.ts, driving the real handleResize (the measurement that
 * latches the font) and the real loadInk/adoptStoredFontRef, over the real inlineInk store. The sidecar read is
 * held open by the test so the stroke lands inside the read window. The stroke enters through inlineInk.applyAdd,
 * the store call a committed pen stroke makes, at note coordinates equal to its screen coordinates (cssScale 1,
 * fontZoom 1, no scroll). Where it is painted is note x times the overlay's fontZoom, the factor repaint draws
 * committed ink with.
 *
 * Expected: red until ink drawn inside the read window keeps its place on screen and on disk.
 */
import { afterAll, beforeAll, expect, it } from "vitest";

(globalThis as { window?: unknown }).window = globalThis;

import { InkOverlayPlugin, inlineInk } from "../inline/InkOverlay";
import { WheelZoomRun } from "../inline/WheelZoom";
import { emptyPage } from "../model/PageData";
import type { PageData } from "../model/PageData";
import type { InlineInkHost } from "../inline/InlineInkStore";
import type { InkStroke } from "../ink/Stroke";
import { fontZoomFactor } from "../inline/ZoomScale";

type Fields = Record<string, unknown>;

const NOTE = "a1-2-load20.md";
const STORED_REF = 20;
const EDITOR_FONT = 16;

let releaseRead: (() => void) | null = null;
const saved = new Map<string, PageData>();
const savedFor = (id: string): PageData | undefined => saved.get(id);
/** The font reference stored in each note's sidecar, by page id. */
const storedRef = new Map<string, number>();
/** The strokes each note's sidecar holds, by page id (none when absent). */
const fileStrokes = new Map<string, InkStroke[]>();

const host: InlineInkHost = {
	readPageId: (path) => `pg-${path}`,
	claimId: async (_p, id) => ({ pageId: id }),
	loadSidecar: (id) =>
		new Promise((resolve) => {
			releaseRead = () => {
				const page = emptyPage(id);
				page.surface = "inline";
				page.fontRefPx = storedRef.get(id)!;
				page.strokes = structuredClone(fileStrokes.get(id) ?? []);
				resolve({ data: page, recovered: false });
			};
		}),
	scheduleSidecar: (id, page) => {
		saved.set(id, structuredClone(page));
	},
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

/** FontRefPerNote.test.ts's rig, unchanged apart from the open note being fixed. */
function makeRig() {
	const o = Object.create(InkOverlayPlugin.prototype) as Fields;
	const contentHost = { fontSize: "16px" };
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
		cancelAnimationFrame: () => undefined,
		clearTimeout: () => undefined,
	};
	o.view = {
		state: { field: () => undefined },
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
	};
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
	o.frame = { locked: false, cancel: () => undefined };
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
	o.repaint = () => undefined;
	o.scheduleRepaint = () => undefined;
	o.updateHandwritingPageClass = () => undefined;
	o.filePath = () => openPath;
	const proto = InkOverlayPlugin.prototype as unknown as { handleResize: () => void; loadInk: (path: string | null) => void };
	return {
		resize(fontPx: number) {
			contentHost.fontSize = `${fontPx}px`;
			proto.handleResize.call(o);
		},
		openNow(path: string) {
			openPath = path;
			proto.loadInk.call(o, path);
		},
		refFontPx: () => o.refFontPx as number,
		fontZoom: () => o.fontZoom as number,
		overlay: o,
	};
}

function stroke(id: string, x: number, y: number): InkStroke {
	return {
		id, tool: "pen", color: "#000000", width: 2,
		points: [{ x, y, pressure: 0.5, t: 0 }, { x: x + 20, y: y + 10, pressure: 0.5, t: 8 }],
		bbox: { x: x - 2, y: y - 2, width: 24, height: 14 },
		createdAt: 1,
	} as InkStroke;
}

const settle = async () => {
	for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** Open `note` (sidecar stored at `ref`) in an editor at EDITOR_FONT, write one stroke inside the read window, let
 * the read land, and report where that stroke is painted now and where a reopen at EDITOR_FONT would paint it. */
async function writeDuringLoad(note: string, ref: number) {
	storedRef.set(`pg-${note}`, ref);
	releaseRead = null;
	const rig = makeRig();
	rig.resize(EDITOR_FONT); // mount measures the editor first
	rig.openNow(note); // the read starts and is held open
	expect(releaseRead, "precondition: the sidecar read is in flight").not.toBeNull();
	expect(rig.fontZoom(), "precondition: before the read lands the stroke is drawn in the editor's own frame").toBe(1);

	// The pen lands at screen x 100 inside the read window; with fontZoom 1 that is note x 100.
	inlineInk.applyAdd(note, [stroke("during-load", SCREEN_X / rig.fontZoom(), 50)]);

	releaseRead!();
	await inlineInk.ensureLoaded(note);
	await settle();
	expect(inlineInk.fontRefPx(note), "precondition: the stored reference landed").toBe(ref);

	const after = inlineInk.strokes(note).find((s) => s.id === "during-load")!;
	const paintedX = after.points[0]!.x * rig.fontZoom();
	// On disk: the last page saved for this note, reopened in an editor at the same 16 px.
	const page = savedFor(`pg-${note}`);
	expect(page, "precondition: the stroke was saved after the read").toBeDefined();
	const onDisk = page!.strokes.find((s) => s.id === "during-load")!;
	const reopenedX = onDisk.points[0]!.x * fontZoomFactor(EDITOR_FONT, page!.fontRefPx ?? EDITOR_FONT);
	return { paintedX, reopenedX };
}

const SCREEN_X = 100;

it("a stroke written while the note's ink file loads stays where the pen put it, on screen and on disk", async () => {
	const { paintedX, reopenedX } = await writeDuringLoad(NOTE, STORED_REF);
	expect.soft(paintedX, `drawn at screen x ${SCREEN_X}, now painted at ${paintedX}`).toBeCloseTo(SCREEN_X, 6);
	expect(reopenedX, `saved so that a reopen at ${EDITOR_FONT} px paints it at ${reopenedX}`).toBeCloseTo(SCREEN_X, 6);
});

it("control: a note stored at the editor's own size keeps the stroke in place", async () => {
	const { paintedX, reopenedX } = await writeDuringLoad("a1-2-load16.md", EDITOR_FONT);
	expect(paintedX).toBeCloseTo(SCREEN_X, 6);
	expect(reopenedX).toBeCloseTo(SCREEN_X, 6);
});

it("a stroke in flight when the ink file lands is stored and painted where its wet ink showed it", async () => {
	const note = "a1-2-inflight20.md";
	storedRef.set(`pg-${note}`, STORED_REF);
	releaseRead = null;
	const rig = makeRig();
	const o = rig.overlay;
	rig.resize(EDITOR_FONT);
	rig.openNow(note);
	expect(releaseRead, "precondition: the sidecar read is in flight").not.toBeNull();

	// The pen goes down: the contact owns the frame. The wet ink is drawn at fontZoom 1, so note x 100 shows at
	// screen x 100.
	const frame = { locked: true, end() { frame.locked = false; }, cancel: () => undefined };
	o.frame = frame;
	const wetZoom = rig.fontZoom();
	const inFlight = { ...stroke("in-flight", SCREEN_X / wetZoom, 50) };
	inFlight.points = [inFlight.points[0]!]; // one sample: the paint path draws nothing, the position is the question

	// The read lands while the pen is still down.
	releaseRead!();
	await inlineInk.ensureLoaded(note);
	await settle();

	// The lift: the real endPenGesture ink branch, its collaborators stubbed. The committed paint records the font
	// zoom it paints with.
	let paintZoom = Number.NaN;
	const noop = () => undefined;
	Object.assign(o, {
		mode: "ink",
		builder: { flushRaw: () => undefined, finishReleaseFiltered: () => [inFlight] },
		strokePenGesture: true,
		strokeRawMax: 0,
		mouseStroke: false,
		snapPreview: null,
		clearSnapPreview: noop,
		stopFrameTicker: noop,
		bandSyncDeferred: false,
		viewportStyleDirty: false,
		pinchGive: null,
		pinchPreview: false,
		activeWet: { clearStroke: noop },
		tail: { ...(o.tail as object), clear: noop, prepareLive: noop },
		camera: { snapshot: {} },
		markCommittedPaint: () => {
			paintZoom = o.fontZoom as number;
		},
		committedCtxFor: () => ({}),
		dispatchInk: noop,
		repaintPath: noop,
		updateExtent: noop,
	});
	(InkOverlayPlugin.prototype as unknown as { endPenGesture: (ev?: unknown) => void }).endPenGesture.call(o);

	const committed = inlineInk.strokes(note).find((s) => s.id === "in-flight")!;
	expect(committed, "precondition: the stroke was committed").toBeDefined();
	expect(paintZoom, "precondition: the committed paint ran").not.toBeNaN();
	const wetX = SCREEN_X;
	const committedX = committed.points[0]!.x * paintZoom;
	expect(committedX, `wet at screen x ${wetX}, committed painted at ${committedX}`).toBeCloseTo(wetX, 6);
	// After the lift the note reads in its stored frame, and so does every later repaint.
	const settled = fontZoomFactor(EDITOR_FONT, STORED_REF);
	expect(rig.fontZoom(), "after the lift the note reads in its stored frame").toBeCloseTo(settled, 10);
	expect(committed.points[0]!.x * settled, "where every later repaint paints it").toBeCloseTo(wetX, 6);
});

it("ink drawn while the ink file loads keeps its drawn width on screen after the read lands", async () => {
	const note = "a1-2-width20.md";
	storedRef.set(`pg-${note}`, STORED_REF);
	releaseRead = null;
	const rig = makeRig();
	rig.resize(EDITOR_FONT);
	rig.openNow(note);
	expect(releaseRead, "precondition: the sidecar read is in flight").not.toBeNull();
	const drawnZoom = rig.fontZoom();
	const drawn = stroke("width-during-load", SCREEN_X / drawnZoom, 50);
	const DRAWN_WIDTH = drawn.width * drawnZoom; // what the pen showed: base width times the font zoom then
	inlineInk.applyAdd(note, [drawn]);

	releaseRead!();
	await inlineInk.ensureLoaded(note);
	await settle();
	expect(rig.fontZoom(), "precondition: the note now reads in its stored frame").toBeCloseTo(fontZoomFactor(EDITOR_FONT, STORED_REF), 10);

	const after = inlineInk.strokes(note).find((s) => s.id === "width-during-load")!;
	expect(after.width * rig.fontZoom(), `drawn ${DRAWN_WIDTH} px wide, now painted ${after.width * rig.fontZoom()} px wide`).toBeCloseTo(DRAWN_WIDTH, 6);
});

it("the note's own saved strokes are untouched when the read lands; only the ink drawn during the read moves", async () => {
	const note = "a1-2-saved-plus-drawn20.md";
	const id = `pg-${note}`;
	storedRef.set(id, STORED_REF);
	const saved = { ...stroke("saved-in-file", 40, 30), width: 3 };
	fileStrokes.set(id, [saved]);
	releaseRead = null;
	const rig = makeRig();
	rig.resize(EDITOR_FONT);
	rig.openNow(note);
	expect(releaseRead, "precondition: the sidecar read is in flight").not.toBeNull();
	inlineInk.applyAdd(note, [stroke("drawn-during-load", SCREEN_X / rig.fontZoom(), 50)]);

	releaseRead!();
	await inlineInk.ensureLoaded(note);
	await settle();

	const strokes = inlineInk.strokes(note);
	const savedAfter = strokes.find((s) => s.id === "saved-in-file")!;
	const drawnAfter = strokes.find((s) => s.id === "drawn-during-load")!;
	expect(savedAfter, "precondition: the file's stroke was read").toBeDefined();
	expect(JSON.stringify({ points: savedAfter.points, width: savedAfter.width, bbox: savedAfter.bbox }), "the saved stroke is exactly as the file holds it")
		.toBe(JSON.stringify({ points: saved.points, width: saved.width, bbox: saved.bbox }));
	expect(drawnAfter.points[0]!.x * rig.fontZoom(), "precondition: the drawn stroke moved into the stored frame").toBeCloseTo(SCREEN_X, 6);
});
