/**
 * An eraser cut, an undo or a replaced stroke below 100 percent. A held picture of the note's ink (the extent raster, its build,
 * the zoom stand-in) may stand for the note only while its list is as it was, or as it was with strokes added at the end. A list
 * that grew any other way (a stroke split in two, a trim after an add, a stroke put back mid-list by an undo, a stroke replaced in
 * place) had the old picture copied back over the changed boxes with only the list's last strokes drawn on top, so the cut or the
 * undone ink showed only when the rebuild landed. After such a change the first paint draws by path; a pen commit keeps the
 * picture as before, and so does a zoom commit over a list unchanged or added to at the end. A synced file adopted with a
 * stroke more, the new one first, is drawn by path too.
 *
 * Runs the real store edits (commit, commitGesture, takeLive, reinsertLive, applyRemove, applyAdd, adoptExternal) and the real
 * armExtentBuild, runExtentPiece, extentBuildHolds, usableExtent, takeStandIn, usableStandIn, drawIntoExtent,
 * noteExternallyReloaded and paintCommittedWork on a bare overlay whose canvases record every call with its arguments.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { InkOverlayPlugin, committedFloorFor, inlineInk } from "./InkOverlay";
import { EXTENT_PIECE_MS } from "./InkOverlayConstants";
import type { InlineInkHost } from "./InlineInkStore";
import { emptyPage, type PageData, type ParseResult } from "../model/PageData";
import { SelectionModel } from "../objects/SelectionModel";
import { computeBBox, type BBox, type InkStroke } from "../ink/Stroke";

type Cam = { x: number; y: number; zoom: number };
type Call = { name: string; args: unknown[] };
type Build = NonNullable<InkOverlayPlugin["extentBuild"]>;
type Raster = NonNullable<InkOverlayPlugin["extentRaster"]>;

// At zoom 0.5 on a 128 device px canvas 64 css px wide, backing 2: the view holds world 0 to 128 each way.
const CAM: Cam = { x: 0, y: 0, zoom: 0.5 };
// A zoom out: the raster no longer holds and is kept as the stand-in, copied at 0.8.
const OUT: Cam = { x: 0, y: 0, zoom: 0.4 };
const FLOOR = committedFloorFor(2, 1);

/** A pen stroke from (x, y), `len` world units to the right over seven samples. */
function stroke(id: string, x: number, y: number, len = 24): InkStroke {
	const points = Array.from({ length: 7 }, (_, i) => ({ x: x + (i * len) / 6, y: y + (i % 2), pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

/** A canvas context that records every method called on it, with its arguments. */
function recordingCtx(calls: Call[]): CanvasRenderingContext2D {
	return new Proxy({} as Record<string, unknown>, {
		get: (target, key) => (key in target ? target[key as string] : (...args: unknown[]) => { calls.push({ name: String(key), args }); return key === "measureText" ? { width: 0 } : undefined; }),
		set: (target, key, value) => { target[key as string] = value; return true; },
	}) as unknown as CanvasRenderingContext2D;
}

type Fake = { width: number; height: number; calls: Call[]; getContext: () => CanvasRenderingContext2D; cloneNode: () => Fake };

/** A canvas whose one context records; its clones (the build's layers, a stand-in's copy) record on their own. */
function fakeCanvas(width: number, height: number): Fake {
	const calls: Call[] = [];
	const ctx = recordingCtx(calls);
	return { width, height, calls, getContext: () => ctx, cloneNode: () => fakeCanvas(0, 0) };
}

const PATH_OPS = new Set(["moveTo", "lineTo", "arc", "quadraticCurveTo", "bezierCurveTo"]);

/** Whether a path call among `calls` lands on `s`'s box, in css px at `cam` with 1 px of slack: `s` was drawn there. */
function drawnIn(calls: readonly Call[], s: InkStroke, cam: Cam): boolean {
	const b = s.bbox, slack = 1;
	const x0 = (b.x - cam.x) * cam.zoom - slack, x1 = (b.x + b.width - cam.x) * cam.zoom + slack;
	const y0 = (b.y - cam.y) * cam.zoom - slack, y1 = (b.y + b.height - cam.y) * cam.zoom + slack;
	return calls.some(({ name, args: [x, y] }) => PATH_OPS.has(name) && typeof x === "number" && typeof y === "number" && x >= x0 && x <= x1 && y >= y0 && y <= y1);
}

const meets = (a: BBox, b: BBox) => a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;

/** Each piece of a build draws one stroke: the clock moves a whole piece's time at every read. */
function onePerPiece(): void {
	let clock = 0;
	vi.spyOn(performance, "now").mockImplementation(() => (clock += EXTENT_PIECE_MS));
}

let notes = 0;

/**
 * A bare overlay at `cam` below 100 percent over a fresh note holding `ink` in the store, its free list the store's own list (no
 * attached group, nothing shown as a copy). Nothing is held until a cell builds it. `at` names a note the cell has loaded itself.
 */
function rig(ink: readonly InkStroke[], cam: Cam = CAM, at?: string) {
	const path = at ?? `erase-cut-held-picture-${++notes}.md`;
	for (const s of ink) inlineInk.commit(path, s);
	const proto = Object.create(InkOverlayPlugin.prototype) as object;
	const o = new Proxy(proto, {
		set(target, key, value) {
			Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: true });
			return true;
		},
	}) as Record<string, unknown>;
	const asked: string[] = [];
	const gate = { pieces: true };
	const committed = fakeCanvas(128, 128), highlight = fakeCanvas(128, 128);
	const list = () => inlineInk.strokes(path);
	o.selection = new SelectionModel();
	o.filePath = () => path;
	o.freeStrokes = () => list();
	o.committedBacking = 2;
	o.committedCanvas = committed;
	o.highlightCanvas = highlight;
	o.committedCtx = committed.getContext();
	o.highlightCtx = highlight.getContext();
	o.cssWidth = 64;
	o.cssHeight = 64;
	o.dpr = 1;
	o.cssScale = cam.zoom;
	o.lastPaintCam = { ...cam };
	o.highlightPairDeferred = false;
	o.highlightBlank = true;
	o.committedBlank = false;
	o.paintedStrokeCount = ink.length;
	// A whole paint of this note, faked: its record names the note as well as the count.
	o.paintedPath = path;
	o.pinchHeld = () => false;
	o.previewPaperSettling = false;
	o.pinchPreview = false;
	o.heldRaster = null;
	o.retiring = false;
	o.inQueuedFrame = true;
	o.extentMayBuild = false;
	o.extentArmAsked = false;
	o.extentRaster = null;
	o.extentBuild = null;
	o.standIn = null;
	o.indexDirty = false;
	o.paintMoving = false;
	o.attachedLayer = null;
	o.lastWholePaint = null;
	o.wholePaints = 0;
	o.standInCopies = 0;
	o.standInSnapshots = 0;
	o.standInRetryTimer = 0;
	o.markCommittedPaint = () => {};
	o.retryStandInLater = () => {};
	// Pieces are run by the cell, never by a timer or a channel.
	o.scheduleExtentPiece = () => asked.push("piece");
	o.extentPieceAllowed = () => gate.pieces;
	o.frame = { locked: false };
	o.repaintScrollOnly = false;
	o.builder = null;
	o.overview = null;
	o.overviewBuild = null;
	o.scheduleOverviewPiece = () => asked.push("overview");
	o.strokeIndex = { query: (r: BBox) => list().filter((s) => meets(s.bbox, r)) };
	o.damage = { addAll: () => asked.push("addAll") };
	o.frontierCache = { invalidate: () => {} };
	o.scheduleRepaint = (via?: string) => asked.push(via ?? "other");
	o.lineAnchors = { takeStep: () => null, retakeMembers: () => 0, writesAttachments: false, follow: { any: false, memberMap: new Map(), groupOf: () => undefined } };
	o.shownSteps = Array.from({ length: 16 }, () => ({ step: 0, bound: null }));
	o.shownMoves = 0;
	o.paintedShownMoves = 0;
	const plugin = o as unknown as InkOverlayPlugin;
	/** Arm a build over the note as it is now and run its pieces until the raster is whole; the raster, or null. */
	const build = (at: Cam = cam): Raster | null => {
		plugin.armExtentBuild(at, list(), FLOOR);
		for (let i = 0; i < 100 && o.extentBuild; i++) plugin.runExtentPiece();
		return o.extentRaster as Raster | null;
	};
	/** A zoom to `to`: the paint's raster test fails on the zoom, and the raster is kept as the stand-in. */
	const zoomTo = (to: Cam) => {
		o.cssScale = to.zoom;
		o.lastPaintCam = { ...to };
		return plugin.usableExtent(to, list());
	};
	/** One committed paint at `at`: the pen layer's calls it made. */
	const paint = (at: Cam, work: "all" | BBox[]): Call[] => {
		const from = committed.calls.length;
		plugin.paintCommittedWork(at, work, list());
		return committed.calls.slice(from);
	};
	return { path, o, plugin, asked, gate, list, build, zoomTo, paint };
}

const images = (calls: readonly Call[]) => calls.filter((c) => c.name === "drawImage").length;

afterEach(() => vi.restoreAllMocks());

describe("a list that grew other than at its end is never pictured by a held picture", () => {
	it("a split under a whole raster at rest: the first partial paint draws the box by path, the raster is not kept as the stand-in", () => {
		const s1 = stroke("s1", 10, 20), s2 = stroke("s2", 10, 60), s3 = stroke("s3", 10, 100);
		const h = rig([s1, s2, s3]);
		expect(h.build(), "premise: the raster is whole").not.toBeNull();
		expect(h.o.standIn, "premise: no stand-in held").toBeNull();
		const list = h.list(), gen = inlineInk.generation(h.path);
		const s2a = stroke("s2a", 10, 60, 8), s2b = stroke("s2b", 26, 60, 8);
		const [taken] = inlineInk.takeLive(h.path, ["s2"]);
		inlineInk.reinsertLive(h.path, [{ index: taken!.index, pieces: [s2a, s2b] }]);
		expect(h.list(), "premise: the same list object").toBe(list);
		expect(list.length, "premise: one longer").toBe(4);
		expect(inlineInk.generation(h.path), "premise: the generation moved").not.toBe(gen);
		const calls = h.paint(CAM, [{ ...s2.bbox }]);
		expect(h.o.standIn, "the raster is not kept as the stand-in").toBeNull();
		expect(images(calls), "nothing copied from an old picture").toBe(0);
		expect([drawnIn(calls, s2a, CAM), drawnIn(calls, s2b, CAM)], "both pieces drawn by path").toEqual([true, true]);
	});

	it("a trim after one stroke was added under a stand-in: the stand-in is refused", () => {
		const s1 = stroke("s1", 10, 20), s2 = stroke("s2", 10, 60), s3 = stroke("s3", 10, 100), s4 = stroke("s4", 10, 120);
		const h = rig([s1, s2, s3]);
		expect(h.build(), "premise: the raster is whole").not.toBeNull();
		h.zoomTo(OUT);
		const st = h.o.standIn;
		expect(st, "premise: the raster kept as the stand-in at the zoom").not.toBeNull();
		inlineInk.commit(h.path, s4);
		expect(h.plugin.usableStandIn(h.list(), false, OUT), "premise: one stroke added at the end keeps it").toBe(st);
		const gen = inlineInk.generation(h.path);
		const [taken] = inlineInk.takeLive(h.path, ["s1"]);
		inlineInk.reinsertLive(h.path, [{ index: taken!.index, pieces: [stroke("s1t", 14, 20, 20)] }]);
		expect(h.list(), "premise: the stand-in's own list").toBe((st as { strokes: unknown }).strokes);
		expect(h.list().length, "premise: still one longer than the stand-in").toBe(4);
		expect(inlineInk.generation(h.path), "premise: the generation moved").not.toBe(gen);
		expect(h.plugin.usableStandIn(h.list(), false, OUT), "the trimmed list is not the stand-in's plus an add").toBeNull();
	});

	it("a split behind a running build's position: the build is dropped at its next piece, and no raster is finished from it", () => {
		const s1 = stroke("s1", 10, 20), s2 = stroke("s2", 10, 60), s3 = stroke("s3", 10, 100), s4 = stroke("s4", 10, 120);
		const h = rig([s1, s2, s3, s4]);
		onePerPiece();
		h.plugin.armExtentBuild(CAM, h.list(), FLOOR);
		const b = h.o.extentBuild as Build;
		expect(b, "premise: armed").not.toBeNull();
		h.plugin.runExtentPiece();
		h.plugin.runExtentPiece();
		expect([b.next, b.count], "premise: two pieces ran, s1 and s2 drawn").toEqual([2, 4]);
		const gen = inlineInk.generation(h.path);
		const [taken] = inlineInk.takeLive(h.path, ["s1"]);
		inlineInk.reinsertLive(h.path, [{ index: taken!.index, pieces: [stroke("s1a", 10, 20, 8), stroke("s1b", 26, 20, 8)] }]);
		expect(h.list(), "premise: the build's own list").toBe(b.strokes);
		expect(h.list().length, "premise: one longer").toBe(5);
		expect(inlineInk.generation(h.path), "premise: the generation moved").not.toBe(gen);
		h.gate.pieces = false;
		h.plugin.runExtentPiece();
		expect(h.o.extentBuild, "the build that drew the uncut s1 is dropped").toBeNull();
		h.gate.pieces = true;
		for (let i = 0; i < 20 && h.o.extentBuild; i++) h.plugin.runExtentPiece();
		expect(h.o.extentRaster, "no raster is finished from that build").toBeNull();
	});

	it("an undo of a whole-stroke erase puts s2 back mid-list: the whole paint draws it", () => {
		const s1 = stroke("s1", 10, 20), s2 = stroke("s2", 10, 60), s3 = stroke("s3", 10, 100);
		const h = rig([s1, s2, s3]);
		inlineInk.applyRemove(h.path, ["s2"]);
		const ext = h.build();
		expect(ext?.count, "premise: the raster is whole over s1 and s3").toBe(2);
		inlineInk.applyAdd(h.path, [s2], [1]);
		expect(h.list(), "premise: the raster's own list").toBe(ext!.strokes);
		expect(h.list()[1], "premise: s2 back at index 1").toBe(s2);
		h.o.extentMayBuild = true;
		const copies = h.o.standInCopies, whole = h.o.wholePaints;
		const calls = h.paint(CAM, "all");
		expect(drawnIn(calls, s2, CAM), "s2 drawn on the pen layer").toBe(true);
		expect(h.o.standInCopies, "no copy of the old picture").toBe(copies);
		expect(h.o.wholePaints, "the whole layer by path").toBe((whole as number) + 1);
	});

	it("an undo of a delete puts the first stroke back after the rebuild: the queued frame's whole repaint draws it", () => {
		const s1 = stroke("s1", 10, 20), s2 = stroke("s2", 10, 60), s3 = stroke("s3", 10, 100);
		const h = rig([s1, s2, s3]);
		expect(h.build()?.count, "premise: the raster is whole over three").toBe(3);
		inlineInk.applyRemove(h.path, ["s1"]);
		const ext = h.build();
		expect(ext?.count, "premise: rebuilt over s2 and s3").toBe(2);
		expect(h.o.standIn, "premise: no stand-in held").toBeNull();
		inlineInk.applyAdd(h.path, [s1], [0]);
		expect(h.list(), "premise: the raster's own list").toBe(ext!.strokes);
		expect(h.list()[0], "premise: s1 back at index 0").toBe(s1);
		h.o.extentMayBuild = true;
		h.o.inQueuedFrame = true;
		const copies = h.o.standInCopies;
		const calls = h.paint(CAM, "all");
		expect(drawnIn(calls, s1, CAM), "s1 drawn on the pen layer").toBe(true);
		expect(h.o.standInCopies, "no copy of the old picture").toBe(copies);
	});

	it("a pen commit that replaces a stroke in place and adds one: the stand-in is refused", () => {
		const s1 = stroke("s1", 10, 20), s2 = stroke("s2", 10, 60), s3 = stroke("s3", 10, 100), s4 = stroke("s4", 10, 120);
		const h = rig([s1, s2, s3]);
		expect(h.build(), "premise: the raster is whole").not.toBeNull();
		h.zoomTo(OUT);
		const st = h.o.standIn;
		expect(st, "premise: the raster kept as the stand-in at the zoom").not.toBeNull();
		const gen = inlineInk.generation(h.path);
		const s2x: InkStroke = { ...s2, points: s2.points.map((p) => ({ ...p, y: p.y + 4 })), bbox: { ...s2.bbox, y: s2.bbox.y + 4 } };
		inlineInk.commitGesture(h.path, [s2x, s4]);
		expect(h.list(), "premise: the stand-in's own list").toBe((st as { strokes: unknown }).strokes);
		expect(h.list().length, "premise: one longer").toBe(4);
		expect(h.list()[1], "premise: s2 replaced in place by a new object").toBe(s2x);
		expect(inlineInk.generation(h.path), "premise: the generation moved").not.toBe(gen);
		expect(h.plugin.usableStandIn(h.list(), false, OUT), "a replaced stroke is not an add at the end").toBeNull();
	});

	it("a synced file adopted with one stroke more, the new one first: the queued frame's whole repaint draws it", async () => {
		// The real store loads the note and adopts the other device's file as a sync does; the overlay is told as the reload is.
		const s0 = stroke("s0", 10, 4), s1 = stroke("s1", 10, 20), s2 = stroke("s2", 10, 60), s3 = stroke("s3", 10, 100);
		const path = `erase-cut-held-picture-${++notes}.md`, pageId = `erase-cut-held-picture-id-${notes}`;
		const file = (strokes: InkStroke[]): PageData => ({ ...emptyPage(pageId), surface: "inline", strokes });
		let incoming: PageData | null = null;
		const store = inlineInk as unknown as { host: InlineInkHost | null };
		const hostBefore = store.host;
		vi.stubGlobal("window", globalThis);
		try {
			inlineInk.attachHost({
				readPageId: (p: string) => (p === path ? pageId : null),
				claimId: async () => ({ pageId }),
				loadSidecar: async (): Promise<ParseResult> => ({ data: file([s1, s2, s3]), recovered: false }),
				scheduleSidecar() {},
				prepareExternalAdoption: async () => ({ kind: "prepared", prepared: { pageId, data: incoming!, reused: false, mtime: 1, stamp: "s" } as never }),
				acceptExternalAdoption() {},
				notify() {},
			} as unknown as InlineInkHost);
			await inlineInk.ensureLoaded(path);
			const h = rig([], CAM, path);
			h.o.paintedStrokeCount = h.list().length;
			h.o.paintedPath = h.path;
			h.o.adoptStoredFontRef = () => {};
			h.o.resolveAttachedText = () => {};
			const ext = h.build();
			expect(ext?.count, "premise: the raster is whole over s1 to s3").toBe(3);
			expect(h.o.standIn, "premise: no stand-in held").toBeNull();
			incoming = file([s0, s1, s2, s3]);
			expect((await inlineInk.adoptExternal(path, () => true)).outcome, "premise: the file adopted").toBe("adopted");
			h.plugin.noteExternallyReloaded(path);
			expect(h.asked.includes("external-reload"), "premise: the reload asks a repaint").toBe(true);
			expect(h.list().map((s) => s.id), "premise: one stroke more, the new one first").toEqual(["s0", "s1", "s2", "s3"]);
			h.o.extentMayBuild = true;
			h.o.inQueuedFrame = true;
			const copies = h.o.standInCopies;
			const calls = h.paint(CAM, "all");
			expect(drawnIn(calls, s0, CAM), "s0 drawn on the pen layer").toBe(true);
			expect(h.o.standInCopies, "no copy of the old picture").toBe(copies);
		} finally {
			inlineInk.handleDelete(path);
			store.host = hostBefore;
			vi.unstubAllGlobals();
		}
	});
});

describe("strokes added at the end keep the held picture, for every way a picture is made", () => {
	it("a stand-in kept from the raster at a zoom, then a pen commit: kept and copied, the new stroke drawn on top", () => {
		const s1 = stroke("s1", 10, 20), s2 = stroke("s2", 10, 60), s3 = stroke("s3", 10, 100), s4 = stroke("s4", 10, 120);
		const h = rig([s1, s2, s3]);
		expect(h.build(), "premise: the raster is whole").not.toBeNull();
		h.zoomTo(OUT);
		const st = h.o.standIn;
		expect(st, "premise: the raster kept as the stand-in").not.toBeNull();
		inlineInk.commit(h.path, s4);
		const calls = h.paint(OUT, [{ ...s4.bbox }]);
		expect(h.o.standIn, "the stand-in is kept").toBe(st);
		expect(h.asked.includes("addAll"), "no whole repaint asked").toBe(false);
		expect(images(calls), "the box copied from the stand-in").toBeGreaterThan(0);
		expect(drawnIn(calls, s4, OUT), "s4 drawn on top").toBe(true);
	});

	it("a pen commit drawn into the whole raster: the raster is kept and holds the store", () => {
		const s1 = stroke("s1", 10, 20), s2 = stroke("s2", 10, 60), s3 = stroke("s3", 10, 100), s4 = stroke("s4", 12, 40, 8);
		const h = rig([s1, s2, s3]);
		const ext = h.build();
		expect(ext, "premise: the raster is whole").not.toBeNull();
		expect(h.plugin.extentHoldsStore(h.path), "premise: it holds the store just before the commit").toBe(true);
		inlineInk.commit(h.path, s4);
		h.plugin.drawIntoExtent(h.path, [s4]);
		expect(h.o.extentRaster, "the raster is kept").toBe(ext);
		expect(ext!.count, "it counts the added stroke").toBe(4);
		expect(h.plugin.extentHolds(ext!, CAM, h.list()), "and holds at the next paint").toBe(true);
	});

	it("a pen commit while a build runs: the build holds, takes the stroke, and its raster holds", () => {
		const s1 = stroke("s1", 10, 20), s2 = stroke("s2", 10, 60), s3 = stroke("s3", 10, 100), s4 = stroke("s4", 12, 40, 8);
		const h = rig([s1, s2, s3]);
		onePerPiece();
		h.plugin.armExtentBuild(CAM, h.list(), FLOOR);
		const b = h.o.extentBuild as Build;
		h.plugin.runExtentPiece();
		expect(b.next, "premise: one piece ran").toBe(1);
		inlineInk.commit(h.path, s4);
		expect(h.plugin.extentBuildHolds(b), "the build holds").toBe(true);
		expect(b.count, "and takes the added stroke").toBe(4);
		for (let i = 0; i < 20 && h.o.extentBuild; i++) h.plugin.runExtentPiece();
		const ext = h.o.extentRaster as Raster | null;
		expect(ext?.count, "the raster is whole over four").toBe(4);
		expect(h.plugin.extentHolds(ext!, CAM, h.list()), "and holds").toBe(true);
	});

	it("a pen commit drawn into the raster, a zoom, a second pen commit: the stand-in is kept and copied", () => {
		const s1 = stroke("s1", 10, 20), s2 = stroke("s2", 10, 60), s3 = stroke("s3", 10, 100), s4 = stroke("s4", 12, 40, 8), s5 = stroke("s5", 10, 140);
		const h = rig([s1, s2, s3]);
		const ext = h.build();
		expect(ext, "premise: the raster is whole").not.toBeNull();
		inlineInk.commit(h.path, s4);
		h.plugin.drawIntoExtent(h.path, [s4]);
		expect(ext!.count, "premise: s4 drawn into the raster").toBe(4);
		h.zoomTo(OUT);
		const st = h.o.standIn;
		expect((st as { pen: unknown } | null)?.pen, "premise: the raster kept as the stand-in").toBe(ext!.pen);
		inlineInk.commit(h.path, s5);
		const calls = h.paint(OUT, [{ ...s5.bbox }]);
		expect(h.o.standIn, "the stand-in is kept").toBe(st);
		expect(h.asked.includes("addAll"), "no whole repaint asked").toBe(false);
		expect(images(calls), "the box copied from the stand-in").toBeGreaterThan(0);
		expect(drawnIn(calls, s5, OUT), "s5 drawn on top").toBe(true);
	});

	it("a stand-in copied from the layers, then a pen commit: kept and copied", () => {
		const s1 = stroke("s1", 10, 20), s2 = stroke("s2", 10, 60), s3 = stroke("s3", 10, 100), s4 = stroke("s4", 10, 120);
		const h = rig([s1, s2, s3]);
		h.plugin.takeStandIn(1, 2);
		const st = h.o.standIn;
		expect(st, "premise: a stand-in copied from the layers").not.toBeNull();
		expect(h.o.standInSnapshots, "premise: taken as a layer copy").toBe(1);
		inlineInk.commit(h.path, s4);
		const calls = h.paint(CAM, [{ ...s4.bbox }]);
		expect(h.o.standIn, "the stand-in is kept").toBe(st);
		expect(h.asked.includes("addAll"), "no whole repaint asked").toBe(false);
		expect(images(calls), "the box copied from the stand-in").toBeGreaterThan(0);
		expect(drawnIn(calls, s4, CAM), "s4 drawn on top").toBe(true);
	});

	it("a stand-in shrunk by an arm whose pair does not fit, then a pen commit: kept and copied", () => {
		// Two strokes 4000 device px apart at 0.5: the raster is about 4006 px a side; at 0.55 the build is about 4407 a side, and
		// with the held raster the pair is over the desktop cap, so the arm shrinks the stand-in.
		const a = stroke("a", 0, 0, 8), z = stroke("z", 3990, 3990, 8), c = stroke("c", 20, 20, 8);
		const NEAR: Cam = { x: 0, y: 0, zoom: 0.55 };
		const h = rig([a, z]);
		const ext = h.build();
		expect(ext, "premise: the raster is whole").not.toBeNull();
		h.zoomTo(NEAR);
		const held = h.o.standIn as { pen: unknown } | null;
		expect(held?.pen, "premise: the raster kept as the stand-in").toBe(ext!.pen);
		h.plugin.armExtentBuild(NEAR, h.list(), FLOOR);
		const st = h.o.standIn as { backing: number } | null;
		expect(h.o.extentBuild, "premise: a build armed").not.toBeNull();
		expect(st !== null && (st as object | null) !== (held as object | null), "premise: the stand-in replaced by a shrunk one").toBe(true);
		expect(st!.backing, "premise: on a smaller grid").toBeLessThan(2);
		inlineInk.commit(h.path, c);
		const calls = h.paint(NEAR, [{ ...c.bbox }]);
		expect(h.o.standIn, "the stand-in is kept").toBe(st);
		expect(h.asked.includes("addAll"), "no whole repaint asked").toBe(false);
		expect(images(calls), "the box copied from the stand-in").toBeGreaterThan(0);
		expect(drawnIn(calls, c, NEAR), "c drawn on top").toBe(true);
	});

	/**
	 * A zoom commit: the raster kept as the stand-in at the new zoom, then two whole repaints outside the queued frame (one per
	 * backing write) and the queued frame's own. The first two draw nothing and defer; the queued frame copies the stand-in once.
	 */
	const zoomCommit = (h: ReturnType<typeof rig>) => {
		h.o.standInDeferrals = 0;
		const whole = h.o.wholePaints as number, copies = h.o.standInCopies as number;
		for (const n of [1, 2]) {
			h.o.inQueuedFrame = false;
			h.o.extentMayBuild = true;
			const calls = h.paint(OUT, "all");
			expect(calls.filter((c) => PATH_OPS.has(c.name)).length, `repaint ${n} outside the queued frame: nothing drawn by path`).toBe(0);
		}
		expect(h.o.standInDeferrals, "both deferred to the queued frame").toBe(2);
		h.o.inQueuedFrame = true;
		h.o.extentMayBuild = true;
		const calls = h.paint(OUT, "all");
		expect(h.o.standInCopies, "the queued frame copies the stand-in once").toBe(copies + 1);
		expect(h.o.wholePaints, "no whole layer drawn by path").toBe(whole);
		return calls;
	};

	it("a zoom commit over the list as it was: the stand-in is kept through its whole repaints, no whole draw by path", () => {
		const s1 = stroke("s1", 10, 20), s2 = stroke("s2", 10, 60), s3 = stroke("s3", 10, 100);
		const h = rig([s1, s2, s3]);
		expect(h.build(), "premise: the raster is whole").not.toBeNull();
		h.zoomTo(OUT);
		const st = h.o.standIn;
		expect(st, "premise: the raster kept as the stand-in").not.toBeNull();
		const calls = zoomCommit(h);
		expect(h.o.standIn, "the stand-in is kept").toBe(st);
		expect(drawnIn(calls, s1, OUT), "s1 not drawn by path").toBe(false);
	});

	it("a zoom commit over the list with a stroke added at the end: the stand-in is kept, only the new stroke drawn on top", () => {
		const s1 = stroke("s1", 10, 20), s2 = stroke("s2", 10, 60), s3 = stroke("s3", 10, 100), s4 = stroke("s4", 10, 120);
		const h = rig([s1, s2, s3]);
		expect(h.build(), "premise: the raster is whole").not.toBeNull();
		h.zoomTo(OUT);
		const st = h.o.standIn;
		expect(st, "premise: the raster kept as the stand-in").not.toBeNull();
		inlineInk.commit(h.path, s4);
		const calls = zoomCommit(h);
		expect(h.o.standIn, "the stand-in is kept").toBe(st);
		expect([drawnIn(calls, s4, OUT), drawnIn(calls, s1, OUT)], "s4 drawn on top, s1 not drawn by path").toEqual([true, false]);
	});
});
