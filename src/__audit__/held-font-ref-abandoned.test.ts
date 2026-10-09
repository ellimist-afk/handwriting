/**
 * Ink keeps its frame when a contact ends without a lift while the note's ink file loads.
 *
 * A font reference adoption that arrives while a contact owns the frame is held (adoptStoredFontRef) and released
 * only by endPenGesture (releaseHeldFontRef). A contact that ends without a lift - strokeAbandoned (window blur, a
 * second finger turning finger ink into a pinch through cancelFingerInkForPinch) or endLiveGestureForHistory (undo
 * with the pen down) - cancels the frame in resetGestureState and never reaches endPenGesture, so the hold stays.
 * The store has already moved the note's ink into the stored frame when the read landed (loadRecord), so every
 * repaint draws it in the old frame until the next pen lift, and then the whole note jumps (zero-snap contract).
 *
 * Rig: A1-2-ink-during-load-font-ref.test.ts's own rig, unchanged, driving the real loadInk, adoptStoredFontRef,
 * strokeAbandoned and resetGestureState over the real inlineInk store. Stored reference 20, editor font 16.
 *
 * Expected: red until a contact that ends without a lift releases the held adoption.
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


const SCREEN_X = 100;

function abandonStubs(o: Fields): void {
	const noop = () => undefined;
	Object.assign(o, {
		mode: "ink",
		builder: null,
		clearSnapPreview: noop,
		hidePenCursor: noop,
		hideEraserCursor: noop,
		snapChip: null,
		selection: { clear: noop },
		erasePieces: new Set<string>(),
		selectionDeleteKeys: { reset: noop },
		resizeDeferred: false,
		bandSyncDeferred: false,
	});
}

async function readLandsDuringContact(note: string, contactLocked: boolean) {
	storedRef.set(`pg-${note}`, STORED_REF);
	fileStrokes.set(`pg-${note}`, [stroke("saved", SCREEN_X, 50)]);
	releaseRead = null;
	const rig = makeRig();
	const o = rig.overlay;
	rig.resize(EDITOR_FONT);
	rig.openNow(note);
	expect(releaseRead, "precondition: the sidecar read is in flight").not.toBeNull();
	const frame = { locked: contactLocked, end() { frame.locked = false; }, cancel() { frame.locked = false; } };
	o.frame = frame;
	releaseRead!();
	await inlineInk.ensureLoaded(note);
	await settle();
	expect(inlineInk.fontRefPx(note), "precondition: the stored reference landed").toBe(STORED_REF);
	return { rig, o };
}

it("a contact abandoned without a lift (window blur, finger ink turned pinch) leaves the note in its stored frame", async () => {
	const note = "held-font-abandon20.md";
	const { rig, o } = await readLandsDuringContact(note, true);
	expect(o.heldFontRef, "precondition: the adoption was held for the contact").toBe(note);
	abandonStubs(o);
	(InkOverlayPlugin.prototype as unknown as { strokeAbandoned: () => void }).strokeAbandoned.call(o);
	await settle();
	const stored = fontZoomFactor(EDITOR_FONT, STORED_REF);
	const saved = inlineInk.strokes(note).find((s) => s.id === "saved")!;
	const paintedX = saved.points[0]!.x * rig.fontZoom();
	const wantX = saved.points[0]!.x * stored;
	expect.soft(o.heldFontRef ?? null, "the hold is released with the contact").toBeNull();
	expect(paintedX, `saved ink painted at ${paintedX}, its stored frame puts it at ${wantX}`).toBeCloseTo(wantX, 6);
});

it("control: the read landing with no contact puts the note in its stored frame at once", async () => {
	const note = "held-font-nocontact20.md";
	const { rig, o } = await readLandsDuringContact(note, false);
	expect(o.heldFontRef ?? null, "precondition: nothing held").toBeNull();
	const stored = fontZoomFactor(EDITOR_FONT, STORED_REF);
	expect(rig.fontZoom(), "the note reads in its stored frame").toBeCloseTo(stored, 10);
});

/** The note's saved stroke, painted against where its stored frame puts it. */
function expectStoredFrame(rig: ReturnType<typeof makeRig>, note: string): void {
	const stored = fontZoomFactor(EDITOR_FONT, STORED_REF);
	const saved = inlineInk.strokes(note).find((s) => s.id === "saved")!;
	const paintedX = saved.points[0]!.x * rig.fontZoom();
	const wantX = saved.points[0]!.x * stored;
	expect(paintedX, `saved ink painted at ${paintedX}, its stored frame puts it at ${wantX}`).toBeCloseTo(wantX, 6);
}

function tickerStubs(o: Fields): void {
	Object.assign(o, { frameTicking: false, frameTickToken: null, frameRaf: 0 });
}

it("finger ink turned into a pinch by a second finger releases the hold and leaves the note in its stored frame", async () => {
	const note = "held-font-pinch20.md";
	const { rig, o } = await readLandsDuringContact(note, true);
	expect(o.heldFontRef, "precondition: the adoption was held for the contact").toBe(note);
	abandonStubs(o);
	tickerStubs(o);
	(InkOverlayPlugin.prototype as unknown as { cancelFingerInkForPinch: () => void }).cancelFingerInkForPinch.call(o);
	await settle();
	expect.soft(o.heldFontRef ?? null, "the hold is released with the contact").toBeNull();
	expectStoredFrame(rig, note);
});

it("undo with the pen down during a lasso drag releases the hold and leaves the note in its stored frame", async () => {
	const note = "held-font-undo20.md";
	const { rig, o } = await readLandsDuringContact(note, true);
	expect(o.heldFontRef, "precondition: the adoption was held for the contact").toBe(note);
	abandonStubs(o);
	tickerStubs(o);
	o.mode = "lasso";
	(InkOverlayPlugin.prototype as unknown as { endLiveGestureForHistory: () => void }).endLiveGestureForHistory.call(o);
	await settle();
	expect.soft(o.heldFontRef ?? null, "the hold is released with the contact").toBeNull();
	expectStoredFrame(rig, note);
});

it("a note switch with a hold clears it, and the note opened next takes its own frame", async () => {
	const note = "held-font-switch20.md";
	const next = "held-font-switch-next24.md";
	const { rig, o } = await readLandsDuringContact(note, true);
	expect(o.heldFontRef, "precondition: the adoption was held for the contact").toBe(note);
	abandonStubs(o);
	storedRef.set(`pg-${next}`, 24);
	fileStrokes.set(`pg-${next}`, []);
	releaseRead = null;
	// update()'s path-change order: the editor already shows the next note when the gesture is torn down.
	(o.filePath as unknown) = () => next;
	(InkOverlayPlugin.prototype as unknown as { resetGestureState: () => void }).resetGestureState.call(o);
	expect(o.heldFontRef ?? null, "the switch clears the old note's hold").toBeNull();
	rig.openNow(next);
	releaseRead!();
	await inlineInk.ensureLoaded(next);
	await settle();
	expect(rig.refFontPx(), "the next note reads in its own stored frame").toBe(24);
	expect(rig.fontZoom()).toBeCloseTo(fontZoomFactor(EDITOR_FONT, 24), 10);
});

it("an unmount with a hold clears it without throwing and without a resize", async () => {
	const note = "held-font-unmount20.md";
	const { o } = await readLandsDuringContact(note, true);
	expect(o.heldFontRef, "precondition: the adoption was held for the contact").toBe(note);
	abandonStubs(o);
	let resizes = 0;
	o.handleResize = () => { resizes++; };
	o.retiring = true;
	expect(() => (InkOverlayPlugin.prototype as unknown as { resetGestureState: () => void }).resetGestureState.call(o)).not.toThrow();
	expect(o.heldFontRef ?? null, "the hold goes with the overlay").toBeNull();
	expect(resizes, "nothing is re-measured on the way out").toBe(0);
});
