/**
 * Ink line anchors: a line's height joins the measured prefix only once a measure has read the line.
 *
 * CodeMirror runs its plugins' update before it draws the lines that update brings into view, and reads their heights in the
 * DOM at its next measure, so the height the overlay records for a line at the update that draws it is the editor's estimate.
 * A line can leave the view with only that estimate on record in two ways: a second transaction scrolls the view away before
 * the measure, or the measure that reads the line finds it taller than its estimate and moves the view past it in the same
 * pass, so the update that pass makes no longer shows it. Old ink anchored on a prefix holding such an estimate is taken on
 * the wrong line, and that anchor reaches the file.
 *
 * Here the real updateLineAnchors runs on a bare overlay instance over a CodeMirror Text, a view the test scrolls and a height
 * map the test keeps: every line is one line tall but line 40, which is three, and the map gives a line's real height only
 * once a measure has read it. The note holds one stroke with no anchor, on line 45's words. Asserted, each way: the prefix
 * never takes line 40's estimate, and the old-ink pass anchors the stroke on line 45 at its measured top, or not at all.
 *
 * The same holds for the lines a document change leaves under the editor's guess: what they gain at their measure goes on the
 * shift log, so ink below them stays put, only once a measure has read them. A change the view leaves in its own update (an
 * undo or redo scrolls to its cursor) keeps its range of the rebase window open through measures that do not reach it, while
 * a range a measure has read closes on its own; a new signature drops the window with nothing logged.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import { InkOverlayPlugin, inlineInk } from "./InkOverlay";
import { LineAnchors } from "./LineAnchor";
import { emptyPage, type ParseResult } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";

const SIG = { width: 892, fontPx: 26, charWidth: 14 };
const LINE = 24;
/** Line 40 wraps to three rows; the editor guesses one until it measures it. */
const TALL_LINE = 40, TALL = 3 * LINE;
/** Line 45's measured top, and a stroke just below it. */
const INK_LINE = 45, INK_TOP = (INK_LINE - 1) * LINE + (TALL - LINE), INK_Y = INK_TOP + 6;
let serial = 0;
const paths = new Set<string>();

afterEach(() => {
	for (const p of paths) inlineInk.handleDelete(p);
	paths.clear();
});

function rig() {
	const path = `estimates-${++serial}.md`, pageId = `estimates-id-${serial}`;
	paths.add(path);
	const ink: InkStroke = {
		id: "old", tool: "pen", color: "#000000", width: 2, createdAt: 0,
		points: [{ x: 10, y: INK_Y, pressure: 0.5, t: 0 }, { x: 20, y: INK_Y + 10, pressure: 0.5, t: 8 }],
		bbox: { x: 10, y: INK_Y, width: 10, height: 10 },
	};
	inlineInk.attachHost({
		readPageId: (p: string) => (p === path ? pageId : null),
		claimId: async () => ({ pageId }),
		loadSidecar: async (): Promise<ParseResult> => {
			const page = emptyPage(pageId);
			page.surface = "inline";
			page.strokes.push(ink);
			return { data: page, recovered: false };
		},
		scheduleSidecar() {},
		scheduleSidecarNow: async () => {},
		notify() {},
	} as never);
	const doc = Text.of(Array.from({ length: 200 }, (_, i) => `line ${i + 1}`));
	// The editor's height map: a line's real height once a measure has read it, else its one-line estimate.
	const read = new Set<number>(), tall = new Set([TALL_LINE]);
	// Lines whose estimate a new width has made three rows, as the editor's estimate grows for a long line in a narrower column.
	const rewrapped = new Set<number>();
	const height = (n: number): number => ((read.has(n) || rewrapped.has(n)) && tall.has(n) ? TALL : LINE);
	const lineTop = (n: number): number => {
		let top = 0;
		for (let k = 1; k < n; k++) top += height(k);
		return top;
	};
	const win = { setTimeout: vi.fn(() => 1), clearTimeout: () => undefined };
	// Measures asked for, as CodeMirror keeps them: each runs its write in the next pass that leaves the view where it is.
	const requests = new Set<{ write: () => void }>();
	const view = { viewport: { from: 0, to: 0 }, defaultLineHeight: LINE, defaultCharacterWidth: 9, state: { doc },
		requestMeasure: (m: { write: () => void }) => void requests.add(m), dom: { ownerDocument: { defaultView: win } } };
	const anchors = new LineAnchors(() => ({ lines: view.state.doc.lines, lineText: (n) => view.state.doc.line(n).text, lineTop, pxPerWorld: 1 }));
	anchors.setSignature(SIG);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const overlay = Object.create(InkOverlayPlugin.prototype) as any;
	// Object.create skips the field initialisers; the zoom hold reads pinchScaleNow, 1 at rest.
	overlay.pinchScaleNow = 1;
	// The measure the overlay asks for after a document change (its field's initialiser never runs on this instance): its write
	// hands the anchors the note, as the overlay's does.
	const lineWindowMeasure = { key: {}, read: () => null, write: () => void anchors.closeWindow(path, inlineInk.strokes(path)) };
	// A moved correction asks for a repaint, which this instance has nothing to paint with.
	Object.assign(overlay, { filePath: () => path, view, lineAnchorState: anchors, lineAnchorPassTimer: 0, lineDrawnAt: 0, lineWindowMeasure,
		lineAnchorsMoved: () => undefined });
	let shown = { from: 1, to: 1 };
	const show = (a: number, b: number): void => {
		shown = { from: a, to: b };
		view.viewport = { from: view.state.doc.line(a).from, to: view.state.doc.line(b).to };
	};
	const update = (flags: { viewportChanged?: boolean; heightChanged?: boolean }, transaction: boolean): void =>
		overlay.updateLineAnchors({ docChanged: false, viewportChanged: false, heightChanged: false, ...flags, geometryChanged: !!flags.heightChanged,
			transactions: transaction ? [{}] : [], state: view.state, startState: view.state });
	return {
		path, anchors, ink,
		load: () => inlineInk.ensureLoaded(path),
		/** A transaction (a scroll into view, a go-to-line) shows lines `a` to `b`: they are drawn, not yet measured. */
		scrollTo: (a: number, b: number): void => {
			show(a, b);
			update({ viewportChanged: true }, true);
		},
		/**
		 * A transaction that adds `insert` to the end of line `n`, which then wraps to three rows: the editor lays it out under its
		 * one-row guess until a measure reads it. In the same update the view moves to lines `a` to `b`, as an undo or a redo
		 * scrolls to its cursor.
		 */
		edit: (n: number, insert: string, a: number, b: number): void => {
			const startState = view.state, changes = ChangeSet.of({ from: startState.doc.line(n).to, insert }, startState.doc.length);
			view.state = { doc: changes.apply(startState.doc) };
			read.delete(n);
			tall.add(n);
			show(a, b);
			overlay.updateLineAnchors({ docChanged: true, viewportChanged: true, heightChanged: false, geometryChanged: true, transactions: [{}], changes,
				startState, state: view.state });
		},
		/**
		 * A measure: the lines shown are read in the DOM, then, when `moveTo` is given, the view moves there in the same pass. Its
		 * update comes only when a height read differs from its estimate or the view moved, as CodeMirror's does.
		 */
		measure: (moveTo?: [number, number]): void => {
			let changed = false;
			for (let n = shown.from; n <= shown.to; n++) {
				if (tall.has(n) && !read.has(n)) changed = true;
				read.add(n);
			}
			if (moveTo) show(moveTo[0], moveTo[1]);
			if (changed || moveTo) update({ heightChanged: changed, viewportChanged: !!moveTo }, false);
			if (moveTo) return;
			for (const m of requests) m.write();
			requests.clear();
		},
		/**
		 * The content's width moves to `width` (a pane resize): the editor lays the lines out again, its estimate for each of
		 * `lines` now three rows, and the overlay takes the new signature, as its resize observer does.
		 */
		resize: (width: number, lines: number[]): void => {
			for (const n of lines) rewrapped.add(n);
			overlay.lineSignatureMeasured({ ...SIG, width });
		},
		/** The editor has gone quiet: a measure read the lines shown, and the old-ink pass runs. */
		quiet: (): number => {
			for (let n = shown.from; n <= shown.to; n++) read.add(n);
			return anchors.anchorMeasured(path, inlineInk.strokes(path));
		},
	};
}

describe("ink line anchors: a line's height counts as measured only once a measure has read it", () => {
	it("a second transaction scrolls the view past the tall line before the measure reads it: the prefix stops above it, and the old ink waits", async () => {
		const r = rig();
		await r.load();
		r.scrollTo(1, 30);
		// The mount's measure reads them, and its update marks them.
		r.measure([1, 30]);
		expect(r.anchors.measuredThrough, "premise: lines 1 to 30 drawn and measured").toBe(30);
		r.scrollTo(20, 50);
		r.scrollTo(60, 90);
		expect(r.anchors.measuredThrough, "the tall line was drawn under its estimate and never measured").toBeLessThan(TALL_LINE);
		expect(r.quiet(), "no old ink anchored under the estimate").toBe(0);
		expect(r.ink.lineAnchor, "the stroke stays at its page position").toBeUndefined();
		// Back over it: the measure reads it, and the stroke is anchored on its own line at its measured top.
		r.scrollTo(30, 60);
		r.measure();
		expect(r.anchors.measuredThrough, "the tall line, measured, joins the prefix").toBeGreaterThanOrEqual(INK_LINE);
		expect(r.quiet()).toBe(1);
		expect([r.ink.lineAnchor?.line, r.ink.lineAnchor?.top], "on line 45 at its measured top").toEqual([INK_LINE, INK_TOP]);
	});

	it("the measure that reads the tall line moves the view past it in the same pass: the prefix takes the measured height, and the old ink lands on its line", async () => {
		const r = rig();
		await r.load();
		r.scrollTo(1, 30);
		// The mount's measure reads them, and its update marks them.
		r.measure([1, 30]);
		expect(r.anchors.measuredThrough, "premise: lines 1 to 30 drawn and measured").toBe(30);
		// A scroll frame: the measure reads lines 1 to 30, the view moves to 25 to 55 and draws the tall line under its estimate.
		r.measure([25, 55]);
		// The next pass reads lines 25 to 55, finds the tall line three times its estimate, and the view moves past it.
		r.measure([45, 80]);
		expect(r.anchors.measuredThrough, "premise: the prefix reached past the tall line").toBeGreaterThanOrEqual(INK_LINE);
		expect(r.quiet()).toBe(1);
		expect([r.ink.lineAnchor?.line, r.ink.lineAnchor?.top], "on line 45 at its measured top, not on an estimated one").toEqual([INK_LINE, INK_TOP]);
	});

	it("a change the view leaves in its own update keeps the window open through a measure that never reads it, and the measure that does logs it once: the ink below stays on its words", async () => {
		const r = rig();
		await r.load();
		r.scrollTo(1, 30);
		r.measure([1, 30]);
		r.measure([25, 55]);
		r.measure([45, 80]);
		expect(r.quiet(), "premise: the stroke anchored on line 45").toBe(1);
		r.scrollTo(35, 70);
		r.measure();
		const before = r.anchors.dyOf(r.ink);
		// Line 42, three above the ink's, gets words that wrap it to three rows, and the view moves to the top of the note.
		r.edit(42, " and words enough to wrap it onto three rows", 1, 30);
		const logged = r.anchors.pendingShifts;
		expect(r.anchors.windowOpen, "premise: the change opened the window").toBe(true);
		// The measure of the lines shown, and its write: line 42 was never drawn, so it is still the editor's guess.
		r.measure();
		expect(r.anchors.windowOpen, "a measure that never read line 42 leaves the window open").toBe(true);
		expect(r.anchors.pendingShifts, "and logs no measure").toBe(logged);
		expect(r.anchors.dyOf(r.ink), "the ink below reads the correction it read before the change while the window waits").toBe(before);
		// Back to the ink: the draw shows line 42 under its guess, and the measure reads it three rows tall.
		r.scrollTo(35, 70);
		r.measure();
		expect(r.anchors.windowOpen, "the measure that read line 42 closes the window").toBe(false);
		expect(r.anchors.pendingShifts, "with one measure on the log").toBe(logged + 1);
		expect(r.anchors.dyOf(r.ink), "the ink below reads the correction it read before the change").toBe(before);
	});

	it("a window of two ranges closes one range at a time: the measure that reads the first logs it alone, and the ink below reads the same correction while the second waits", async () => {
		const r = rig();
		await r.load();
		r.scrollTo(1, 30);
		r.measure([1, 30]);
		r.measure([25, 55]);
		r.measure([45, 80]);
		expect(r.quiet(), "premise: the stroke anchored on line 45").toBe(1);
		r.scrollTo(35, 70);
		r.measure();
		const before = r.anchors.dyOf(r.ink);
		// Line 42 gets words that wrap it, and the view moves to the top of the note; then line 10, which the view shows.
		r.edit(42, " and words enough to wrap it onto three rows", 1, 30);
		r.edit(10, " and words enough to wrap it onto three rows", 1, 30);
		const logged = r.anchors.pendingShifts;
		// The measure reads line 10 three rows tall; line 42 is still the editor's guess.
		r.measure();
		expect(r.anchors.windowOpen, "line 42 unread: its range stays open").toBe(true);
		expect(r.anchors.pendingShifts, "line 10's range closes, one measure on the log").toBe(logged + 1);
		expect(r.anchors.dyOf(r.ink), "the ink below reads the correction it read before the changes while line 42 waits").toBe(before);
		// Back to the ink: the measure reads line 42 three rows tall, and its range closes the window.
		r.scrollTo(35, 70);
		r.measure();
		expect(r.anchors.windowOpen, "the measure that read line 42 closes the window").toBe(false);
		expect(r.anchors.pendingShifts, "with a second measure on the log").toBe(logged + 2);
		expect(r.anchors.dyOf(r.ink), "the ink below reads the correction it read before the changes").toBe(before);
	});

	it("a new signature with the window open drops it and logs nothing, though the changed line now lays out away from its guess", async () => {
		const r = rig();
		await r.load();
		r.scrollTo(1, 30);
		r.measure([1, 30]);
		r.measure([25, 55]);
		r.measure([45, 80]);
		expect(r.quiet(), "premise: the stroke anchored on line 45").toBe(1);
		r.scrollTo(35, 70);
		r.measure();
		// Line 42 gets words that wrap it, and the view moves to the top of the note: the window waits on line 42.
		r.edit(42, " and words enough to wrap it onto three rows", 1, 30);
		r.measure();
		const logged = r.anchors.pendingShifts;
		expect(r.anchors.windowOpen, "premise: the window waits on line 42").toBe(true);
		// The pane narrows: every line is laid out again, line 42's estimate three rows.
		r.resize(600, [42]);
		expect(r.anchors.windowOpen, "the new signature drops the window").toBe(false);
		expect(r.anchors.pendingShifts, "with no measure on the log").toBe(logged);
	});
});
