/**
 * A Fit on a long note moves almost every anchored stroke by a fraction of a device pixel (the measure update reads each line
 * again; measured on a 5570 stroke note: 5564 strokes moved, at most 0.41 device px). The queued frame refused the stand-in for
 * any move of the shown strokes and drew the whole note by path, so the ink froze and popped in. The stand-in is kept when every
 * move since it was painted is known and the moves' bounds sum under one device pixel at the painting camera; any other move
 * refuses as before.
 *
 * Runs the real lineAnchorsMoved, followMoved, usableStandIn, paintCommittedWork, armExtentBuild and runExtentPiece on a bare
 * overlay holding one stand-in, and the real LineAnchors step accounting over a fake layout.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Text } from "@codemirror/state";

import { InkOverlayPlugin, committedFloorFor, inkLookKey, inlineInk } from "./InkOverlay";
import { SelectionModel } from "../objects/SelectionModel";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { computeBBox, type InkStroke } from "../ink/Stroke";

const PATH = "stand-in-under-one-pixel.md";
// At zoom 0.5 on a 128 device px canvas 64 css px wide: one world unit is one device pixel, so a bound reads as device px.
const CAM = { x: 0, y: 0, zoom: 0.5 };

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

/** A canvas context that records every method called on it by name. */
function recordingCtx(calls: string[]): CanvasRenderingContext2D {
	return new Proxy({} as Record<string, unknown>, {
		get: (target, key) => (key in target ? target[key as string] : () => { calls.push(String(key)); return key === "measureText" ? { width: 0 } : undefined; }),
		set: (target, key, value) => { target[key as string] = value; return true; },
	}) as unknown as CanvasRenderingContext2D;
}

/**
 * A bare overlay holding a stand-in painted with shownMoves 0 over the list `held`. The line anchors are a fake whose takeStep
 * answers the scripted steps in order (world units, null for a move whose size is not known), then null.
 */
function overlay(steps: (number | null)[] = []) {
	const proto = Object.create(InkOverlayPlugin.prototype) as object;
	const o = new Proxy(proto, {
		set(target, key, value) {
			Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: true });
			return true;
		},
	}) as Record<string, unknown>;
	const asked: string[] = [], pen: string[] = [], hl: string[] = [], queried: unknown[] = [];
	const held: readonly InkStroke[] = [strokeAt("s1", 10, 20), strokeAt("s2", 10, 60)];
	// The list the overlay shows after a move: the same strokes in a new array, as the line anchors give it.
	const shown: readonly InkStroke[] = held.slice();
	const script = steps.slice();
	o.selection = new SelectionModel();
	o.filePath = () => PATH;
	o.committedBacking = 2;
	o.committedCanvas = { width: 128, height: 128 };
	o.cssWidth = 64;
	o.cssHeight = 64;
	o.committedCtx = recordingCtx(pen);
	o.highlightCtx = recordingCtx(hl);
	o.dpr = 1;
	o.cssScale = 0.5;
	o.highlightPairDeferred = false;
	o.pinchHeld = () => false;
	o.previewPaperSettling = false;
	o.retiring = false;
	o.inQueuedFrame = true;
	o.extentMayBuild = false;
	o.extentArmAsked = false;
	o.extentRaster = null;
	o.extentBuild = null;
	o.indexDirty = false;
	o.paintMoving = false;
	o.attachedLayer = null;
	o.lastWholePaint = null;
	o.wholePaints = 0;
	o.standInCopies = 0;
	o.standInRetryTimer = 0;
	o.markCommittedPaint = () => {};
	o.retryStandInLater = () => {};
	o.scheduleExtentPiece = () => asked.push("piece");
	// A whole repaint with no extent raster held or building arms the overview (1.4.25): an unlocked frame and no builder let the
	// arm run; its first piece is only asked for here, never drawn.
	o.frame = { locked: false };
	o.repaintScrollOnly = false;
	o.builder = null;
	o.overview = null;
	o.overviewBuild = null;
	o.scheduleOverviewPiece = () => asked.push("overview");
	o.strokeIndex = { query: (r: unknown) => (queried.push(r), shown) };
	o.damage = { addAll: () => asked.push("addAll") };
	o.frontierCache = { invalidate: () => {} };
	o.scheduleRepaint = (via?: string) => asked.push(via ?? "other");
	o.lineAnchors = {
		takeStep: () => (script.length > 0 ? script.shift()! : null),
		retakeMembers: () => 0,
		writesAttachments: false,
		follow: { any: false, memberMap: new Map(), groupOf: () => undefined },
	};
	o.shownSteps = Array.from({ length: 16 }, () => ({ step: 0, bound: null }));
	o.shownMoves = 0;
	o.paintedShownMoves = 0;
	o.standIn = {
		path: PATH, pen: { width: 128, height: 128 }, hl: null, at: { ...CAM }, backing: 2, dpr: 1, look: inkLookKey(), strokes: held,
		count: held.length, generation: inlineInk.generation(PATH), mark: null, shownMoves: 0, store: inlineInk.strokes(PATH),
	};
	const plugin = o as unknown as InkOverlayPlugin;
	/** Path draws on the pen layer: a whole paint by path or a rect's drawRegion fills ribbons. */
	const pathDraws = () => pen.filter((n) => n === "fill" || n === "stroke").length;
	const copies = () => pen.filter((n) => n === "drawImage").length;
	return { o, plugin, held, shown, asked, pen, queried, script, pathDraws, copies };
}

type Harness = ReturnType<typeof overlay>;

/** The queued frame's whole paint on the shown list (or `list`); answers what it did. */
function wholeFrame(h: Harness, list: readonly InkStroke[] = h.shown) {
	const before = { copies: h.o.standInCopies as number, whole: h.o.wholePaints as number, draws: h.pathDraws(), images: h.copies() };
	h.plugin.paintCommittedWork(CAM, "all", list);
	return {
		copied: (h.o.standInCopies as number) - before.copies,
		whole: (h.o.wholePaints as number) - before.whole,
		pathDraws: h.pathDraws() - before.draws,
		images: h.copies() - before.images,
		held: h.o.standIn !== null,
	};
}

const KEPT = { copied: 1, whole: 0, pathDraws: 0, images: 1, held: true };

describe("the stand-in is kept through moves that sum under one device pixel", () => {
	it("A1: one read step of 0.4 device px: the queued frame copies the stand-in and draws nothing by path", () => {
		const h = overlay([0.4]);
		h.plugin.lineAnchorsMoved(PATH);
		expect(h.o.shownMoves, "premise: one move").toBe(1);
		expect(wholeFrame(h), "one copy, no whole paint, no path draw").toEqual(KEPT);
		expect(h.o.paintedShownMoves, "the layers show the places the stand-in was painted at").toBe(0);
	});

	it("A2: two steps of 0.4 keep the stand-in; two of 0.6 refuse it", () => {
		const keep = overlay([0.4, 0.4]);
		keep.plugin.lineAnchorsMoved(PATH);
		keep.plugin.lineAnchorsMoved(PATH);
		expect(wholeFrame(keep), "0.8 device px in all: kept").toEqual(KEPT);
		const refuse = overlay([0.6, 0.6]);
		refuse.plugin.lineAnchorsMoved(PATH);
		refuse.plugin.lineAnchorsMoved(PATH);
		const r = wholeFrame(refuse);
		expect([r.copied, r.whole, r.held], "1.2 device px in all: the whole note by path, the stand-in let go").toEqual([0, 1, false]);
	});

	it("A3: the threshold is one device pixel: a step of 1.0 refuses, a step of 0.99 keeps", () => {
		const at = overlay([1.0]);
		at.plugin.lineAnchorsMoved(PATH);
		const r = wholeFrame(at);
		expect([r.copied, r.whole, r.held], "1.0 device px: refused").toEqual([0, 1, false]);
		const under = overlay([0.99]);
		under.plugin.lineAnchorsMoved(PATH);
		expect(wholeFrame(under), "0.99 device px: kept").toEqual(KEPT);
	});

	it("A4: a move whose size is not known refuses as before: a reset, and followMoved's membership move over a pending read step", () => {
		// (a) The line anchors' generation moved from no read (another note, a remount): the step is unknown.
		const reset = overlay([null]);
		reset.plugin.lineAnchorsMoved(PATH);
		const a = wholeFrame(reset);
		expect([a.copied, a.whole, a.held], "unknown step: the whole note by path, the stand-in let go").toEqual([0, 1, false]);
		// (b) A read step of 0.1 device px is pending when followMoved's membership branch reports a move: that move is not a read,
		// and the pending step is discarded with it, never recorded as known.
		const member = overlay([0.1]);
		member.plugin.followMoved(PATH, { members: new Map() } as never);
		expect(member.o.shownMoves, "premise: the membership branch moved the shown strokes").toBe(1);
		const b = wholeFrame(member);
		expect([b.copied, b.whole, b.held], "membership move: the whole note by path, the stand-in let go").toEqual([0, 1, false]);
	});

	it("A5: control: a step older than the ring is unknown: 17 moves of 0.01 while held refuse", () => {
		const h = overlay(Array.from({ length: 17 }, () => 0.01));
		for (let i = 0; i < 17; i++) h.plugin.lineAnchorsMoved(PATH);
		const r = wholeFrame(h);
		expect([r.copied, r.whole, r.held], "the first move's entry is gone: refused").toEqual([0, 1, false]);
	});

	it("A6: after A1's frame, a rect paint over either stroke copies from the stand-in and draws none of its strokes by path", () => {
		const h = overlay([0.4]);
		h.plugin.lineAnchorsMoved(PATH);
		expect(wholeFrame(h), "premise: A1's frame kept the stand-in").toEqual(KEPT);
		for (const s of h.held) {
			const images = h.copies(), draws = h.pathDraws();
			h.plugin.paintCommittedWork(CAM, [{ ...s.bbox }], h.shown);
			expect([h.copies() - images, h.pathDraws() - draws, h.queried.length], `the rect over ${s.id}: one copy, no path draw, no index query`).toEqual([1, 0, 0]);
		}
	});

	it("A7: control: a build armed before the move fails its hold on the new list and is dropped; the next arm records the move", () => {
		const h = overlay([0.4]);
		let free = h.held;
		h.o.freeStrokes = () => free;
		h.o.lastPaintCam = { ...CAM };
		h.o.extentPieceAllowed = () => true;
		const floor = committedFloorFor(2, 1);
		h.plugin.armExtentBuild(CAM, h.held, floor);
		const b = h.o.extentBuild as NonNullable<InkOverlayPlugin["extentBuild"]>;
		expect([b !== null, b.shownMoves], "premise: armed on the held list before the move").toEqual([true, 0]);
		h.plugin.lineAnchorsMoved(PATH);
		free = h.shown;
		expect(h.plugin.extentBuildHolds(b), "the build no longer holds on the new list").toBe(false);
		h.plugin.runExtentPiece();
		expect(h.o.extentBuild, "and is dropped").toBeNull();
		h.plugin.armExtentBuild(CAM, h.shown, floor);
		expect((h.o.extentBuild as NonNullable<InkOverlayPlugin["extentBuild"]>).shownMoves, "the next arm records the move").toBe(1);
	});
});

describe("the stand-in is kept through a small move only over the store list it was taken from", () => {
	afterEach(() => vi.restoreAllMocks());

	it("a replaced store list that lost a stroke and gained two, its generation moved, with one known 0.4 step: refused, whole repaint, path draw", () => {
		const h = overlay([0.4]);
		const gen = inlineInk.generation(PATH);
		const now = [h.held[1]!, strokeAt("s3", 10, 100), strokeAt("s4", 10, 140)];
		vi.spyOn(inlineInk, "strokes").mockReturnValue(now);
		vi.spyOn(inlineInk, "generation").mockReturnValue(gen + 1);
		h.plugin.lineAnchorsMoved(PATH);
		const r = wholeFrame(h, now);
		expect([r.copied, r.whole, r.held, r.pathDraws > 0], "the whole note by path, the stand-in let go").toEqual([0, 1, false, true]);
	});

	it("a replaced store list of the same count, its generation unchanged, with one known 0.4 step: refused", () => {
		const h = overlay([0.4]);
		const now = [strokeAt("t1", 10, 20), strokeAt("t2", 10, 60)];
		vi.spyOn(inlineInk, "strokes").mockReturnValue(now);
		h.plugin.lineAnchorsMoved(PATH);
		const r = wholeFrame(h, now);
		expect([r.copied, r.whole, r.held], "the whole note by path, the stand-in let go").toEqual([0, 1, false]);
	});

	it("control: a line correction gives a new free list over the same store list, with one known 0.4 step: kept, one copy", () => {
		const h = overlay([0.4]);
		const store = inlineInk.strokes(PATH);
		vi.spyOn(inlineInk, "strokes").mockReturnValue(store);
		h.plugin.lineAnchorsMoved(PATH);
		expect(wholeFrame(h), "one copy, no whole paint, no path draw").toEqual(KEPT);
	});

	it("an eraser cut edits the store list in place (s1 taken, its two pieces put back), count and generation up by one, with one known 0.4 step: refused", () => {
		const h = overlay([0.4]);
		const store: InkStroke[] = [...h.held];
		(h.o.standIn as { store: readonly InkStroke[] }).store = store;
		const gen = inlineInk.generation(PATH);
		vi.spyOn(inlineInk, "strokes").mockReturnValue(store);
		vi.spyOn(inlineInk, "generation").mockReturnValue(gen + 1);
		store.splice(0, 1);
		store.push(strokeAt("s1a", 10, 20), strokeAt("s1b", 22, 20));
		h.plugin.lineAnchorsMoved(PATH);
		const r = wholeFrame(h, store.slice());
		expect([r.copied, r.whole, r.held], "the same list object, edited: the whole note by path, the stand-in let go").toEqual([0, 1, false]);
	});

	it("control: the same store list unedited, its generation unchanged, a new free list, with one known 0.4 step: kept, one copy", () => {
		const h = overlay([0.4]);
		const store: InkStroke[] = [...h.held];
		(h.o.standIn as { store: readonly InkStroke[] }).store = store;
		vi.spyOn(inlineInk, "strokes").mockReturnValue(store);
		h.plugin.lineAnchorsMoved(PATH);
		expect(wholeFrame(h), "one copy, no whole paint, no path draw").toEqual(KEPT);
	});
});

// ---- the line anchors' step accounting -------------------------------------------------------------------------------------

const SIG = { width: 892, fontPx: 26, charWidth: 14 };
const lines = (n: number) => Text.of(Array.from({ length: n }, (_, i) => `line ${i + 1} words`));

function layoutOf(doc: Text, heights: number[], px = 1): LineLayout {
	const tops = [0];
	for (const h of heights) tops.push(tops.at(-1)! + h);
	return { lines: doc.lines, lineText: (n) => doc.line(n).text, lineTop: (n) => tops[n - 1]!, pxPerWorld: px };
}

function surface(doc: Text, heights: number[]) {
	const state = { layout: layoutOf(doc, heights) };
	const anchors = new LineAnchors(() => state.layout);
	anchors.setSignature(SIG);
	return { state, anchors };
}

/** Old ink taken while the editor holds estimates for lines 1 and 2 of `estimate` px each, 40 measured: a take of 80 - 2 * estimate. */
function measuredTake(estimate: number) {
	const doc = lines(8), heights = [40, 40, 40, 40, 40, 40, 40, 40], { state, anchors } = surface(doc, heights);
	const seen = (from: number, to: number) => { anchors.drawn(from, to); anchors.drawn(from, to, true, true); };
	const old = strokeAt("old", 10, 140), src = [old];
	anchors.tracks(PATH, src);
	seen(1, 8);
	state.layout = layoutOf(doc, [estimate, estimate, 40, 40, 40, 40, 40, 40]);
	anchors.layoutChanged(PATH, src);
	seen(4, 8);
	// Whatever the setup moved is taken: the step open now holds only the take.
	anchors.takeStep();
	expect(anchors.anchorMeasured(PATH, src), "premise: the stroke is taken").toBe(1);
	return { anchors, old };
}

/** One anchored stroke on line 4, every move taken; `line1(px)` lays line 1 out that tall and reads the corrections again. */
function readSurface() {
	const doc = lines(6), { state, anchors } = surface(doc, [40, 40, 40, 40, 40, 40]);
	const s = strokeAt("s", 10, 125), src = [s];
	anchors.anchorNew(PATH, s);
	anchors.layoutChanged(PATH, src);
	anchors.takeStep();
	const line1 = (first: number) => {
		state.layout = layoutOf(doc, [first, 40, 40, 40, 40, 40]);
		return anchors.layoutChanged(PATH, src);
	};
	return { anchors, s, src, line1 };
}

describe("the line anchors report the size of each move", () => {
	it("A8 (a): anchorMeasured's first take counts from 0: a take of 0.3 reads 0.3 and keeps the stand-in, a take of 3 reads 3 and refuses it", () => {
		const small = measuredTake(39.85);
		expect(small.anchors.dyOf(small.old), "premise: shown 0.3 above its page position").toBeCloseTo(-0.3, 9);
		expect(small.anchors.takeStep(), "the take's size").toBeCloseTo(0.3, 9);
		const large = measuredTake(38.5);
		expect(large.anchors.takeStep(), "the take's size").toBeCloseTo(3, 9);
		// The same takes reported through the overlay: 0.3 device px keeps the stand-in, 3 refuse it.
		for (const [estimate, kept] of [[39.85, true], [38.5, false]] as const) {
			const { anchors } = measuredTake(estimate);
			const h = overlay();
			h.o.lineAnchors = anchors;
			h.plugin.lineAnchorsMoved(PATH);
			const r = wholeFrame(h);
			expect([r.copied, r.whole, r.held], `a take of ${80 - 2 * estimate}`).toEqual(kept ? [1, 0, true] : [0, 1, false]);
		}
	});

	it("A8 (b): two reads that move a stroke 0.4 each before a take report 0.8", () => {
		const { anchors, line1 } = readSurface();
		expect(line1(39.6), "premise: the first read moved it").toBe(true);
		expect(line1(39.2), "premise: the second read moved it").toBe(true);
		expect(anchors.takeStep()).toBeCloseTo(0.8, 9);
	});

	it("A8 (c) to (e): control: a reset between reads, no move since the last take, and a read under float noise report no size", () => {
		const c = readSurface();
		c.line1(39.6);
		// Another note: every correction of this one is read again from nothing.
		c.anchors.layoutChanged("other-note.md", []);
		c.line1(39.2);
		expect(c.anchors.takeStep(), "(c) a reset in the step").toBeNull();
		const d = readSurface();
		d.line1(39.6);
		d.anchors.takeStep();
		expect(d.anchors.takeStep(), "(d) nothing since the last take").toBeNull();
		const e = readSurface();
		expect(e.line1(40 - 1e-4), "premise: a change under float noise moves nothing").toBe(false);
		expect(e.anchors.takeStep(), "(e) nothing seen").toBeNull();
	});
});
