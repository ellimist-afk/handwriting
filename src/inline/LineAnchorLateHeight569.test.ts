/**
 * Lines a document change put in that get their real height only after the change's measure has closed the rebase window.
 * That late height comes with no document change, so the layout read after it reads every correction again, and the ink
 * below rides its line down, though all the user did was edit. The contract: a document change moves no ink
 * (LineAnchor.ts:15, "typing moves no ink"; ink never follows text).
 *
 * The overlay's order (InkOverlayLineAnchors.ts updateLineAnchors, lineWindowMeasured): a change's update takes the change
 * (docChanged) and draws the changed lines (drawn, not whole); the window's measure writes (closeWindow); a later height
 * reaches the measure loop's update, which marks the lines its measure read (drawn, measure) and takes the layout change
 * (layoutChanged "measure").
 *
 * The ink was dropped by the lasso in the blank space under the text, so it rides the note's last line (lineUnder: the last
 * line below the last). The cells:
 *  1. A picture pasted on a new line above the ink's line loads after the window's measure; and the same paste at the
 *     start of the ink's own blank line, as filmed. Both leave the same document.
 *  2. A table typed row by row, two document changes, each row measured as typed; the cursor leaves and the rows are drawn
 *     as a table, taller at that later measure than at their first.
 *  3. After cell 1's paste and late height, the note's anchors written to the page and read back on a fresh surface (the
 *     note opened again, the picture's height known at once): the stroke shows where it was drawn.
 * Guards: a line no edit touched (an old picture that loads late) still moves the ink below it as today
 * (LineAnchorCarriedRead.test.ts:271-286), with no edit and after the paste's window has closed.
 *
 * Bare LineAnchors over a stand-in layout at half an editor px per world unit (LineAnchorBoxReadEdit.test.ts's), with
 * CodeMirror's own Text and ChangeSet, and the page written and read as the file holds it (LineAnchorAbove.test.ts's); no DOM.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import { LineAnchors, aboveOf, lineKey, newAboveRun, type LayoutUpdate, type LineLayout, type LineRange } from "./LineAnchor";
import { InkOverlayPlugin, inlineInk } from "./InkOverlay";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { emptyPage, parsePage, serializePage, type ParseResult } from "../model/PageData";

const SIG = { width: 892, fontPx: 26, charWidth: 14 };
const PX = 0.5;
const LINE_PX = 20;
/** The pasted picture's line before the picture loads, editor px: a little taller than the editor's guess. */
const PRE_PX = 24;
/** The same line once the picture has loaded, editor px. */
const LOADED_PX = 150;
/** What the picture's line gains after the window's measure, world units. */
const LATE = (LOADED_PX - PRE_PX) / PX;
/** The line the picture sits on after the paste, in either shape; the ink's line is the one after it. */
const EMBED = 9;
const EMBED_TEXT = "![[pic.png]]";
/** A table row once the cursor has left the table and it is drawn as one, editor px. */
const TABLE_ROW_PX = 36;
/** What the two typed rows gain at that later measure, world units. */
const TABLE_LATE = (2 * (TABLE_ROW_PX - LINE_PX)) / PX;

/** A layout over `doc` whose line n is `heights[n - 1]` editor px tall. */
function layoutOf(doc: Text, heights: number[]): LineLayout {
	const tops = [0];
	for (const h of heights) tops.push(tops.at(-1)! + h);
	return { lines: doc.lines, lineText: (n) => doc.line(n).text, lineTop: (n) => tops[n - 1]!, pxPerWorld: PX };
}

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

/**
 * Eight lines of text and a blank last line, every line drawn and measured. One stroke drawn 30 editor px below the last
 * line's bottom, then dropped by the lasso where it is shown (retake): it anchors on the last line and shows no correction.
 */
function surface(path: string, start?: number[]) {
	const doc = Text.of([...Array.from({ length: 8 }, (_, i) => `line ${i + 1} words`), ""]);
	const heights = start ?? Array.from({ length: doc.lines }, () => LINE_PX);
	const state = { layout: layoutOf(doc, heights) };
	const a = new LineAnchors(() => state.layout);
	a.setSignature(SIG);
	const src: InkStroke[] = [];
	a.tracks(path, src);
	a.drawn(1, doc.lines);
	a.drawn(1, doc.lines, true, true);
	const ink = strokeAt("ink", 100, (heights.reduce((t, h) => t + h, 0) + 30) / PX);
	src.push(ink);
	a.anchorNew(path, ink);
	a.retake(path, [ink], undefined, src);
	const premise = { line: ink.lineAnchor?.line ?? null, dy: a.dyOf(ink) };
	expect(premise, `premise: the dropped ink anchors on the last line, ${doc.lines}, and shows no correction ${JSON.stringify(premise)}`).toEqual({ line: doc.lines, dy: 0 });
	return { path, doc, heights, state, a, src, ink };
}

type Surface = ReturnType<typeof surface>;

/**
 * One document change that puts in one line, `line` after it, as the overlay takes it: the update draws the changed lines
 * at the editor's guess (LINE_PX), then the window's measure reads the new line at `measuredPx`. Answers the document and
 * heights after it and what each step showed.
 */
function typed(s: Surface, doc: Text, heights: number[], changes: ChangeSet, line: number, measuredPx: number) {
	const { path, state, a, src, ink } = s;
	const after = changes.apply(doc);
	const guess = [...heights.slice(0, line - 1), LINE_PX, ...heights.slice(line - 1)];
	state.layout = layoutOf(after, guess);
	const lazy0 = a.changePaths.lazy;
	a.docChanged(path, src, doc, changes, after);
	a.drawn(a.changedLines.from, a.changedLines.to, false);
	const atChange = { windowOpen: a.windowOpen, lazy: a.changePaths.lazy - lazy0, dy: a.dyOf(ink) };
	const measured = guess.map((h, i) => (i === line - 1 ? measuredPx : h));
	state.layout = layoutOf(after, measured);
	a.closeWindow(path, src);
	// `stored`: the line the stroke's anchor field holds now, for the record only. An anchor takes in the logged changes when
	// it is next read (resolve), so the field may still name the line before the change.
	const atClose = { windowOpen: a.windowOpen, stored: ink.lineAnchor?.line ?? null, dy: a.dyOf(ink) };
	return { after, heights: measured, text: after.line(line).text, atChange, atClose };
}

type Typed = ReturnType<typeof typed>;

/**
 * The paste: `above` puts a new line holding the picture's embed in after line 8, above the ink's line; `on` puts the embed
 * and a line break in at the start of the ink's own blank line, as filmed. Either way the embed is line 9 and the ink's line
 * is line 10 after it; the window's measure reads the picture's line at PRE_PX, before the picture loads.
 */
function paste(s: Surface, shape: "above" | "on"): Typed {
	const { doc } = s;
	const changes = shape === "above"
		? ChangeSet.of({ from: doc.line(8).to, insert: `\n${EMBED_TEXT}` }, doc.length)
		: ChangeSet.of({ from: doc.line(9).from, insert: `${EMBED_TEXT}\n` }, doc.length);
	return typed(s, doc, s.heights, changes, EMBED, PRE_PX);
}

/** The measure loop's update after `heights` came with no document change: the lines it read marked, then the layout read. */
function measured(s: Surface, doc: Text, heights: number[]) {
	s.state.layout = layoutOf(doc, heights);
	s.a.drawn(1, doc.lines, true, true);
	const out = s.a.layoutChanged(s.path, s.src, "measure");
	return { out, dy: s.a.dyOf(s.ink) };
}

/** The premise of each change: its line went in as typed, it opened the window on the logged path, and no step moved the ink. */
function typedPremise(t: Typed, text: string, info: string): void {
	expect([t.text, t.atChange.windowOpen, t.atChange.lazy, t.atChange.dy], `premise: "${text}" went in, the change opened the window on the logged path and moved no ink ${info}`).toEqual([text, true, 1, 0]);
	expect([t.atClose.windowOpen, t.atClose.dy], `premise: the window's measure closed the window, the ink unmoved ${info}`).toEqual([false, 0]);
}

/** The picture's line at LOADED_PX, every other line as the paste left it. */
const loadedAfter = (p: Typed) => p.heights.map((h, i) => (i === EMBED - 1 ? LOADED_PX : h));

describe("a line an edit put in gets its height late: the ink below stays where it was shown", () => {
	for (const shape of ["above", "on"] as const) {
		const how = shape === "above" ? "on a new line put in above the ink's line" : "at the start of the ink's own blank line, as filmed";
		it(`a picture pasted ${how} loads after the window's measure: the ink below stays where it was shown (dyOf 0)`, () => {
			const s = surface(`late-${shape}.md`);
			const p = paste(s, shape);
			const late = measured(s, p.after, loadedAfter(p));
			const info = JSON.stringify({ p: { text: p.text, atChange: p.atChange, atClose: p.atClose }, late, grewWorld: LATE });
			typedPremise(p, EMBED_TEXT, info);
			expect(late.dy, `the picture's late ${LOADED_PX - PRE_PX} px is the paste's own height: the ink stays where it was shown ${info}`).toBe(0);
		});
	}

	it("a table typed row by row (two changes, each row measured as typed), then drawn as a table once the cursor leaves, taller: the ink below stays where it was shown (dyOf 0)", () => {
		const s = surface("late-table.md");
		const row1 = typed(s, s.doc, s.heights, ChangeSet.of({ from: s.doc.line(8).to, insert: "\n| a | b |" }, s.doc.length), 9, LINE_PX);
		const d1 = row1.after;
		const row2 = typed(s, d1, row1.heights, ChangeSet.of({ from: d1.line(9).to, insert: "\n| c | d |" }, d1.length), 10, LINE_PX);
		// The cursor leaves the table: no document change, and the two rows are drawn as a table, each TABLE_ROW_PX tall.
		const table = row2.heights.map((h, i) => (i === 8 || i === 9 ? TABLE_ROW_PX : h));
		const late = measured(s, row2.after, table);
		const pick = (t: Typed) => ({ text: t.text, atChange: t.atChange, atClose: t.atClose });
		const info = JSON.stringify({ row1: pick(row1), row2: pick(row2), late, grewWorld: TABLE_LATE });
		typedPremise(row1, "| a | b |", info);
		typedPremise(row2, "| c | d |", info);
		expect(late.dy, `the table's later ${2 * (TABLE_ROW_PX - LINE_PX)} px is the typed rows' own height: the ink stays where it was shown ${info}`).toBe(0);
	});

	it("after the picture pasted above the ink's line loads late, the anchors written to the page and read on a fresh surface: the stroke shows where it was drawn (dyOf 0, on mount and after a measure)", () => {
		const path = "late-reopen.md";
		const s = surface(path);
		const p = paste(s, "above");
		const loaded = loadedAfter(p);
		const late = measured(s, p.after, loaded);
		// The note closes, and its page is written as the file holds it (serializePage settles every anchor first).
		s.a.detached();
		const page = emptyPage("late");
		page.strokes = s.src;
		const back = parsePage(serializePage(page), "late").data.strokes[0]!;
		const doc = p.after, ba = back.lineAnchor;
		const aboveNow = ba ? aboveOf(newAboveRun(), ba.line, (k) => lineKey(doc.line(k).text)) : null;
		// The note opened again: a fresh surface, every line drawn and measured, the picture's height known at once.
		const layout = layoutOf(doc, loaded);
		const fresh = new LineAnchors(() => layout);
		fresh.setSignature(SIG);
		fresh.drawn(1, doc.lines);
		fresh.drawn(1, doc.lines, true, true);
		const list = [back];
		fresh.tracks(path, list);
		const onMount = fresh.dyOf(back);
		fresh.layoutChanged(path, list, "measure");
		const afterMeasure = fresh.dyOf(back);
		const info = JSON.stringify({ p: { text: p.text, atChange: p.atChange, atClose: p.atClose }, late, written: ba ?? null, aboveNow, onMount, afterMeasure, grewWorld: LATE });
		typedPremise(p, EMBED_TEXT, info);
		expect([ba?.line ?? null, ba?.above === aboveNow, back.bbox.y === s.ink.bbox.y], `premise: the page holds the anchor on line ${EMBED + 1} with the hash of the text above it now, the stroke's points as drawn ${info}`).toEqual([EMBED + 1, true, true]);
		expect([onMount, afterMeasure], `the fresh surface shows the stroke where it was drawn, on mount and after a measure ${info}`).toEqual([0, 0]);
	});

	it("guard: an old picture on line 3 loads late, no edit: the ink below rides its line down by the growth, as today", () => {
		const s = surface("late-guard-plain.md");
		const grown = s.heights.map((h, i) => (i === 2 ? h + (LOADED_PX - PRE_PX) : h));
		const late = measured(s, s.doc, grown);
		const info = JSON.stringify({ late, line: s.ink.lineAnchor?.line ?? null, grewWorld: LATE });
		expect([late.out, late.dy], `an unchanged line's late height: true, the ink shown ${LATE} lower ${info}`).toEqual([true, LATE]);
	});

	it("guard: after the paste's window closed, line 3, which no edit touched, loads late: the ink below moves by line 3's growth", () => {
		const s = surface("late-guard-after-paste.md");
		const p = paste(s, "above");
		const grown = p.heights.map((h, i) => (i === 2 ? h + (LOADED_PX - PRE_PX) : h));
		const late = measured(s, p.after, grown);
		const info = JSON.stringify({ p: { text: p.text, atChange: p.atChange, atClose: p.atClose }, late, grewWorld: LATE });
		typedPremise(p, EMBED_TEXT, info);
		expect([late.out, late.dy], `an unchanged line's late height after a paste: true, the ink shown ${LATE} lower ${info}`).toEqual([true, LATE]);
	});
});

/**
 * The selection's lines now, as the overlay hands them to the anchors at each update (LineAnchors.selected; on a build without
 * it nothing takes them and the call does nothing).
 */
function cursorAt(s: Surface, from: number, to = from): void {
	(s.a as unknown as { selected?(lines: readonly LineRange[]): void }).selected?.([{ from, to }]);
}

/** A transaction that moves the selection alone: its own read (on a build without that read, a transaction's). */
const SELECTION = "selection" as string as LayoutUpdate;

/** `heights` with line `n` at `px`. */
const withLine = (heights: readonly number[], n: number, px: number) => heights.map((h, i) => (i === n - 1 ? px : h));
const sum = (heights: readonly number[]) => heights.reduce((t, h) => t + h, 0);

/**
 * A layout read with the lines at `heights`: the measure loop's ("measure", the lines it read marked first), a transaction that
 * moves the selection alone ("selection"), or any other transaction, such as a fold or an unfold ("transaction"); a
 * transaction's lines are drawn after its read, at the editor's estimate. Answers `ink`'s correction after it.
 */
function readAt(s: Surface, doc: Text, heights: number[], kind: "measure" | "selection" | "transaction", ink: InkStroke = s.ink): number {
	s.state.layout = layoutOf(doc, heights);
	if (kind === "measure") {
		s.a.drawn(1, doc.lines, true, true);
		s.a.layoutChanged(s.path, s.src, "measure");
	} else {
		s.a.layoutChanged(s.path, s.src, kind === "selection" ? SELECTION : "transaction");
		s.a.drawn(1, doc.lines, true, false);
	}
	return s.a.dyOf(ink);
}

/**
 * Any document change as the overlay takes it: the update draws the changed lines at `guess` (editor px, one per line after
 * the change), the window's measure reads them at `measured`. Answers the document after it and the ink's correction.
 */
function edit(s: Surface, doc: Text, changes: ChangeSet, guess: number[], measured: number[]) {
	const after = changes.apply(doc);
	s.state.layout = layoutOf(after, guess);
	s.a.docChanged(s.path, s.src, doc, changes, after);
	s.a.drawn(s.a.changedLines.from, s.a.changedLines.to, false);
	s.state.layout = layoutOf(after, measured);
	s.a.closeWindow(s.path, s.src);
	return { after, heights: measured, dy: s.a.dyOf(s.ink) };
}

/**
 * The note closes, its page written as the file holds it, and opens again on a fresh surface with the lines at `heights`,
 * every line drawn and measured. Answers that surface, the ink read back from the page.
 */
function reopen(s: Surface, doc: Text, heights: number[]): Surface {
	s.a.detached();
	const page = emptyPage("late");
	page.strokes = s.src;
	const src = parsePage(serializePage(page), "late").data.strokes;
	const state = { layout: layoutOf(doc, heights) };
	const a = new LineAnchors(() => state.layout);
	a.setSignature(SIG);
	a.drawn(1, doc.lines);
	a.drawn(1, doc.lines, true, true);
	a.tracks(s.path, src);
	a.layoutChanged(s.path, src, "measure");
	return { path: s.path, doc, heights, state, a, src, ink: src.find((k) => k.id === s.ink.id)! };
}

/** Two rows typed below line 8, each a change measured as typed, the cursor on the row typed. */
function twoRows(s: Surface) {
	cursorAt(s, 9);
	const row1 = typed(s, s.doc, s.heights, ChangeSet.of({ from: s.doc.line(8).to, insert: "\n| a | b |" }, s.doc.length), 9, LINE_PX);
	const d1 = row1.after;
	cursorAt(s, 10);
	const row2 = typed(s, d1, row1.heights, ChangeSet.of({ from: d1.line(9).to, insert: "\n| c | d |" }, d1.length), 10, LINE_PX);
	typedPremise(row1, "| a | b |", "");
	typedPremise(row2, "| c | d |", "");
	return row2;
}

/** An old picture's growth when it loads, editor px. */
const OLD_GROW = 100;

describe("the late height of lines an edit put in, the cases around it", () => {
	it("a picture pasted on a new line after a line whose old picture is still loading: the old picture's late height moves the ink as today, the pasted one's does not", () => {
		const s = surface("late-next-to-old.md");
		const p = paste(s, "above");
		const oldLoaded = withLine(p.heights, 8, LINE_PX + OLD_GROW);
		const afterOld = readAt(s, p.after, oldLoaded, "measure");
		const afterNew = readAt(s, p.after, withLine(oldLoaded, EMBED, LOADED_PX), "measure");
		const info = JSON.stringify({ afterOld, afterNew });
		typedPremise(p, EMBED_TEXT, info);
		expect([afterOld, afterNew], `the old picture moves the ink by its growth, the pasted one adds nothing ${info}`).toEqual([OLD_GROW / PX, OLD_GROW / PX]);
	});

	it("guard: two pictures pasted, and a line between them that no edit touched loads late: the ink moves by that line's growth alone", () => {
		const s = surface("late-two-pastes.md");
		const d0 = s.doc;
		const p1 = typed(s, d0, s.heights, ChangeSet.of({ from: d0.line(3).to, insert: "\n![[a.png]]" }, d0.length), 4, PRE_PX);
		const d1 = p1.after;
		const p2 = typed(s, d1, p1.heights, ChangeSet.of({ from: d1.line(6).to, insert: "\n![[b.png]]" }, d1.length), 7, PRE_PX);
		// Line 5 (line 4 before the pastes) holds an old picture that loads late.
		const dy = readAt(s, p2.after, withLine(p2.heights, 5, LINE_PX + OLD_GROW), "measure");
		const info = JSON.stringify({ dy, between: p2.after.line(5).text });
		typedPremise(p1, "![[a.png]]", info);
		typedPremise(p2, "![[b.png]]", info);
		expect(dy, `the line between the pastes moves the ink by its own growth ${info}`).toBe(OLD_GROW / PX);
	});

	it("an old picture on line 3 and the pasted one load in the same read: the ink moves by line 3's growth alone", () => {
		const s = surface("late-one-read.md");
		const p = paste(s, "above");
		const dy = readAt(s, p.after, withLine(loadedAfter(p), 3, LINE_PX + OLD_GROW), "measure");
		const info = JSON.stringify({ dy });
		typedPremise(p, EMBED_TEXT, info);
		expect(dy, `line 3's growth moves the ink, the pasted picture's does not ${info}`).toBe(OLD_GROW / PX);
	});

	it("guard: lines typed this session folded away with their section: the ink rides up by the whole fold, on the page written and on a fresh surface, and back at the unfold, as today", () => {
		const s = surface("late-fold.md");
		const r1 = typed(s, s.doc, s.heights, ChangeSet.of({ from: s.doc.line(8).to, insert: "\nnew words" }, s.doc.length), 9, LINE_PX);
		const r2 = typed(s, r1.after, r1.heights, ChangeSet.of({ from: r1.after.line(9).to, insert: "\nmore words" }, r1.after.length), 10, LINE_PX);
		const doc = r2.after;
		// The heading on line 4 folds lines 5 to 10, the two typed ones among them.
		const folded = r2.heights.map((h, i) => (i >= 4 && i <= 9 ? 0 : h));
		const FOLD = (6 * LINE_PX) / PX;
		const atFold = readAt(s, doc, folded, "transaction");
		const atMeasure = readAt(s, doc, folded, "measure");
		const f = reopen(s, doc, folded);
		const onFresh = f.a.dyOf(f.ink);
		const atUnfold = readAt(f, doc, r2.heights, "transaction");
		const atUnfoldMeasure = readAt(f, doc, r2.heights, "measure");
		const info = JSON.stringify({ atFold, atMeasure, onFresh, atUnfold, atUnfoldMeasure, fold: FOLD });
		typedPremise(r1, "new words", info);
		typedPremise(r2, "more words", info);
		expect([atFold, atMeasure, onFresh, atUnfold, atUnfoldMeasure], `the fold moves the ink up with its line, the unfold back to where it was drawn ${info}`).toEqual([-FOLD, -FOLD, -FOLD, 0, 0]);
	});

	it("named limit: the note written and closed before the pasted picture loads: on a fresh surface the ink shows pushed by the picture's late height, as today", () => {
		const s = surface("late-closed.md");
		const p = paste(s, "above");
		const f = reopen(s, p.after, loadedAfter(p));
		const dy = f.a.dyOf(f.ink);
		const info = JSON.stringify({ dy });
		typedPremise(p, EMBED_TEXT, info);
		expect(dy, `the late height the closed surface never read pushes the ink, as today ${info}`).toBe(LATE);
	});

	it("the pasted picture loads with the cursor off its line, then grows again with no touch: the ink stays where it was shown (dyOf 0 both times)", () => {
		const s = surface("late-again.md");
		const p = paste(s, "on");
		cursorAt(s, EMBED + 1);
		const loaded = loadedAfter(p);
		const atLoad = readAt(s, p.after, loaded, "measure");
		const again = readAt(s, p.after, withLine(loaded, EMBED, LOADED_PX + 40), "measure");
		const info = JSON.stringify({ atLoad, again });
		typedPremise(p, EMBED_TEXT, info);
		expect([atLoad, again], `both heights are the paste's own ${info}`).toEqual([0, 0]);
	});

	it("a table typed row by row, row 1 fixed before the cursor leaves, then drawn taller: the ink stays where it was shown (dyOf 0)", () => {
		const s = surface("late-table-fix.md");
		const row2 = twoRows(s);
		cursorAt(s, 9);
		const fix = edit(s, row2.after, ChangeSet.of({ from: row2.after.line(9).from + 2, insert: "x" }, row2.after.length), row2.heights, row2.heights);
		cursorAt(s, 1);
		const table = row2.heights.map((h, i) => (i === 8 || i === 9 ? TABLE_ROW_PX : h));
		const atLeave = readAt(s, fix.after, table, "selection");
		const atMeasure = readAt(s, fix.after, table, "measure");
		const info = JSON.stringify({ row1: fix.after.line(9).text, fix: fix.dy, atLeave, atMeasure });
		expect([fix.after.line(9).text, fix.dy, atLeave, atMeasure], `the fixed row and the table's later height are the edit's own ${info}`).toEqual(["| xa | b |", 0, 0, 0]);
	});

	it("the paste undone after its picture loaded, and done again: the ink stays where it was shown at every step (dyOf 0), its points and box as drawn", () => {
		const s = surface("late-undo.md");
		const drawn = JSON.stringify([s.ink.points, s.ink.bbox]);
		const d0 = s.doc;
		const cs = ChangeSet.of({ from: d0.line(8).to, insert: `\n${EMBED_TEXT}` }, d0.length);
		const p = typed(s, d0, s.heights, cs, EMBED, PRE_PX);
		const atLoad = readAt(s, p.after, loadedAfter(p), "measure");
		const undo = edit(s, p.after, cs.invert(d0), s.heights, s.heights);
		const atUndoMeasure = readAt(s, undo.after, s.heights, "measure");
		const redo = typed(s, undo.after, s.heights, cs, EMBED, PRE_PX);
		const atRedoLoad = readAt(s, redo.after, loadedAfter(redo), "measure");
		const info = JSON.stringify({ atLoad, undo: undo.dy, atUndoMeasure, redo: redo.atClose.dy, atRedoLoad });
		typedPremise(p, EMBED_TEXT, info);
		expect(undo.after.eq(d0), `premise: the undo leaves the document as before the paste ${info}`).toBe(true);
		expect([atLoad, undo.dy, atUndoMeasure, redo.atClose.dy, atRedoLoad], `no step moves the ink ${info}`).toEqual([0, 0, 0, 0, 0]);
		expect(JSON.stringify([s.ink.points, s.ink.bbox]), `the stroke's points and box are as drawn ${info}`).toBe(drawn);
	});

	it("a stroke an older build left pushed reads as today; a picture pasted above it then loads late: it stays where it was shown, live and on a fresh surface", () => {
		const s = surface("late-pushed.md");
		const PUSHED = 40;
		const L = s.doc.lines;
		const old = strokeAt("old", 300, s.ink.bbox.y);
		// Saved by an older build: no lines-above hash, its top PUSHED above its line's, so it shows PUSHED lower than its points.
		old.lineAnchor = { line: L, top: s.state.layout.lineTop(L) / PX - PUSHED, y: old.bbox.y, key: lineKey(s.doc.line(L).text), width: SIG.width, fontPx: SIG.fontPx };
		s.src.push(old);
		const onRead = s.a.dyOf(old);
		const p = paste(s, "above");
		const loaded = loadedAfter(p);
		const atLoad = readAt(s, p.after, loaded, "measure", old);
		const f = reopen(s, p.after, loaded);
		const onFresh = f.a.dyOf(f.src.find((k) => k.id === "old")!);
		const info = JSON.stringify({ onRead, atClose: s.a.dyOf(old), atLoad, onFresh });
		typedPremise(p, EMBED_TEXT, info);
		expect([onRead, atLoad, onFresh], `the pushed stroke keeps the place it was shown at ${info}`).toEqual([PUSHED, PUSHED, PUSHED]);
	});

	it("a table typed, drawn taller once the cursor leaves, then the cursor in and out again: the first drawing moves no ink, the toggles move it with the rows, as for a table no edit touched", () => {
		const s = surface("late-toggle.md");
		const row2 = twoRows(s);
		const doc = row2.after, source = row2.heights;
		const table = source.map((h, i) => (i === 8 || i === 9 ? TABLE_ROW_PX : h));
		cursorAt(s, 1);
		const out1 = [readAt(s, doc, table, "selection"), readAt(s, doc, table, "measure")];
		cursorAt(s, 9);
		const in1 = [readAt(s, doc, source, "selection"), readAt(s, doc, source, "measure")];
		cursorAt(s, 1);
		const out2 = [readAt(s, doc, table, "selection"), readAt(s, doc, table, "measure")];
		const info = JSON.stringify({ out1, in1, out2, tableLate: TABLE_LATE });
		expect([...out1, ...in1, ...out2], `the first drawing is the typed rows' own height; after it the rows' source and table heights move the ink ${info}`).toEqual([0, 0, -TABLE_LATE, -TABLE_LATE, 0, 0]);
	});

	// The new stroke is ink placed after the edit, so it rides as today. Its top was read in the layout epoch before the
	// picture's height (the epoch's cached tops), so riding moves it by the late height.
	it("a stroke anchored after the paste, once the picture's height is in the editor but before the read that takes it: the older ink stays where it was shown, the new stroke rides its line as today", () => {
		const s = surface("late-between.md");
		const p = paste(s, "above");
		const loaded = loadedAfter(p);
		s.state.layout = layoutOf(p.after, loaded);
		const late = strokeAt("late", 200, (sum(loaded) + 10) / PX);
		s.src.push(late);
		s.a.anchorNew(s.path, late);
		const atRead = readAt(s, p.after, loaded, "measure");
		const info = JSON.stringify({ atRead, late: s.a.dyOf(late) });
		typedPremise(p, EMBED_TEXT, info);
		expect([atRead, s.a.dyOf(late)], `the older ink stays, the stroke anchored after the edit rides ${LATE} ${info}`).toEqual([0, LATE]);
	});

	it("guard: the pasted picture's line joined onto the old line above it, whose own picture then loads late: that line keeps old text, so the ink moves as today", () => {
		const s = surface("late-join.md");
		const p = paste(s, "above");
		const d = p.after;
		// Backspace at the start of the picture's line.
		const join = ChangeSet.of({ from: d.line(8).to, to: d.line(9).from }, d.length);
		const guess = [...p.heights.slice(0, 7), LINE_PX, ...p.heights.slice(9)];
		const j = edit(s, d, join, guess, withLine(guess, 8, PRE_PX));
		const atLoad = readAt(s, j.after, withLine(j.heights, 8, LOADED_PX), "measure");
		const info = JSON.stringify({ text: j.after.line(8).text, join: j.dy, atLoad });
		typedPremise(p, EMBED_TEXT, info);
		expect([j.after.line(8).text, j.dy, atLoad], `the joined line's late height moves the ink, as today ${info}`).toEqual([`line 8 words${EMBED_TEXT}`, 0, LATE]);
	});

	it("a stroke drawn after the paste, beside the older ink, then the picture loads late: the older ink stays where it was shown, the new stroke rides its line as today", () => {
		const s = surface("late-placed.md");
		const p = paste(s, "above");
		const placed = strokeAt("placed", 300, s.ink.bbox.y);
		s.src.push(placed);
		s.a.anchorNew(s.path, placed);
		const before = s.a.dyOf(placed);
		const atLoad = readAt(s, p.after, loadedAfter(p), "measure");
		const info = JSON.stringify({ before, atLoad, placed: s.a.dyOf(placed) });
		typedPremise(p, EMBED_TEXT, info);
		expect([before, atLoad, s.a.dyOf(placed)], `the older ink stays, the stroke drawn after the edit rides ${LATE} ${info}`).toEqual([0, 0, LATE]);
	});

	it("a row typed letter by letter on a new line, then drawn taller once the cursor leaves: the ink stays where it was shown (dyOf 0)", () => {
		const s = surface("late-letters.md");
		cursorAt(s, 9);
		const enter = typed(s, s.doc, s.heights, ChangeSet.of({ from: s.doc.line(8).to, insert: "\n" }, s.doc.length), 9, LINE_PX);
		let doc = enter.after;
		const heights = enter.heights, dys: number[] = [];
		for (const ch of "| a | b |") {
			const t = edit(s, doc, ChangeSet.of({ from: doc.line(9).to, insert: ch }, doc.length), heights, heights);
			doc = t.after;
			dys.push(t.dy);
		}
		cursorAt(s, 1);
		const row = withLine(heights, 9, TABLE_ROW_PX);
		const atLeave = readAt(s, doc, row, "selection");
		const atMeasure = readAt(s, doc, row, "measure");
		const info = JSON.stringify({ text: doc.line(9).text, dys, atLeave, atMeasure });
		typedPremise(enter, "", info);
		expect([doc.line(9).text, dys.every((d) => d === 0), atLeave, atMeasure], `the row's later height is the typing's own ${info}`).toEqual(["| a | b |", true, 0, 0]);
	});

	it.fails("named limit, after the release: a picture pasted at the end of a line of old text loads late: the ink below stays where it was shown (dyOf 0)", () => {
		const s = surface("late-sentence.md");
		const d0 = s.doc;
		const t = edit(s, d0, ChangeSet.of({ from: d0.line(8).to, insert: EMBED_TEXT }, d0.length), s.heights, withLine(s.heights, 8, PRE_PX));
		const atLoad = readAt(s, t.after, withLine(s.heights, 8, LOADED_PX), "measure");
		expect([t.dy, atLoad], `the picture's late height is the paste's ${JSON.stringify({ t: t.dy, atLoad })}`).toEqual([0, 0]);
	});

	it("guard: a table no edit put in, shown at rest, then the cursor in, a letter typed on a row, and out: the ink moves with the rows and is back where it was drawn, as today", () => {
		const rest = withLine(withLine(Array.from({ length: 9 }, () => LINE_PX), 3, TABLE_ROW_PX), 4, TABLE_ROW_PX);
		const s = surface("late-rest-block.md", rest);
		const source = withLine(withLine(rest, 3, LINE_PX), 4, LINE_PX);
		cursorAt(s, 3);
		const atIn = [readAt(s, s.doc, source, "selection"), readAt(s, s.doc, source, "measure")];
		const t = edit(s, s.doc, ChangeSet.of({ from: s.doc.line(3).to, insert: "x" }, s.doc.length), source, source);
		cursorAt(s, 1);
		const atOut = [readAt(s, t.after, rest, "selection"), readAt(s, t.after, rest, "measure")];
		const info = JSON.stringify({ atIn, typed: t.dy, atOut });
		expect([...atIn, t.dy, ...atOut], `the rows' source height moves the ink up, the table's back ${info}`).toEqual([-TABLE_LATE, -TABLE_LATE, -TABLE_LATE, 0, 0]);
	});

	it("the pasted picture grows in two steps with the cursor on its line: the ink stays where it was shown (dyOf 0 both)", () => {
		const s = surface("late-two-steps.md");
		const p = paste(s, "above");
		cursorAt(s, EMBED);
		const steps = [readAt(s, p.after, withLine(p.heights, EMBED, 84), "measure"), readAt(s, p.after, loadedAfter(p), "measure")];
		const info = JSON.stringify({ steps });
		typedPremise(p, EMBED_TEXT, info);
		expect(steps, `both steps are the paste's own height ${info}`).toEqual([0, 0]);
	});

	it("guard: a new signature after the paste's window closed, then the old one again: the picture's late height moves the ink as today", () => {
		const s = surface("late-signature.md");
		const p = paste(s, "above");
		s.a.setSignature({ ...SIG, width: 600 });
		s.a.layoutChanged(s.path, s.src, "signature");
		const away = s.a.dyOf(s.ink);
		s.a.setSignature(SIG);
		s.a.layoutChanged(s.path, s.src, "signature");
		const back = readAt(s, p.after, p.heights, "measure");
		const atLoad = readAt(s, p.after, loadedAfter(p), "measure");
		const info = JSON.stringify({ away, back, atLoad });
		typedPremise(p, EMBED_TEXT, info);
		expect([away, back, atLoad], `a new signature ends the paste's claim: its late height moves the ink, as today ${info}`).toEqual([0, 0, LATE]);
	});

	for (const first of ["writer", "other"] as const) {
		it(`two panes on the note, the picture loading first in the ${first === "writer" ? "pane that writes the note" : "other pane"}: each pane ends with the ink where it was shown (dyOf 0)`, () => {
			const s = surface(`late-panes-${first}.md`);
			const d0 = s.doc;
			const bState = { layout: layoutOf(d0, s.heights) };
			const b = new LineAnchors(() => bState.layout);
			b.setSignature(SIG);
			b.tracks(s.path, s.src);
			b.drawn(1, d0.lines);
			b.drawn(1, d0.lines, true, true);
			b.layoutChanged(s.path, s.src, "measure");
			const bAt0 = b.dyOf(s.ink);
			const cs = ChangeSet.of({ from: d0.line(8).to, insert: `\n${EMBED_TEXT}` }, d0.length);
			const p = typed(s, d0, s.heights, cs, EMBED, PRE_PX);
			// The other pane takes the same change: it writes nothing; its lines drawn and read as the first pane's.
			bState.layout = layoutOf(p.after, p.heights);
			b.docChanged(s.path, s.src, d0, cs, p.after);
			b.drawn(b.changedLines.from, b.changedLines.to, false);
			b.closeWindow(s.path, s.src);
			const loaded = loadedAfter(p);
			const bRead = (heights: number[]) => {
				bState.layout = layoutOf(p.after, heights);
				b.drawn(1, p.after.lines, true, true);
				b.layoutChanged(s.path, s.src, "measure");
				return b.dyOf(s.ink);
			};
			const steps: Record<string, number> = { bAt0 };
			if (first === "writer") {
				steps.aLoad = readAt(s, p.after, loaded, "measure");
				steps.bBefore = bRead(p.heights);
				steps.bLoad = bRead(loaded);
			} else {
				steps.bLoad1 = bRead(loaded);
				steps.aLoad = readAt(s, p.after, loaded, "measure");
				steps.bLoad = bRead(loaded);
			}
			const info = JSON.stringify(steps);
			typedPremise(p, EMBED_TEXT, info);
			expect([steps.aLoad, steps.bLoad], `once both panes read the picture's height, neither shows the ink moved ${info}`).toEqual([0, 0]);
		});
	}
});

/**
 * A stroke's points moved by `dy` world units, as a lasso move or its undo leaves them, then its anchor re-taken where it is
 * shown (retake), as the overlay does at the move's end and at the undo.
 */
function moved(s: Surface, ink: InkStroke, dy: number): void {
	ink.points = ink.points.map((p) => ({ ...p, y: p.y + dy }));
	ink.bbox = computeBBox(ink.points, 2);
	s.a.retake(s.path, [ink], undefined, s.src);
}

describe("the late height of lines an edit put in: which change armed a line, joins, and an undone move", () => {
	it("a stroke drawn after the paste, then one letter typed on the picture's line, then the picture loads late: the older ink stays where it was shown, the new stroke rides its line as today", () => {
		const s = surface("late-letter-after-placed.md");
		const p = paste(s, "above");
		cursorAt(s, EMBED);
		const placed = strokeAt("placed", 300, s.ink.bbox.y);
		s.src.push(placed);
		s.a.anchorNew(s.path, placed);
		const d = p.after;
		const letter = edit(s, d, ChangeSet.of({ from: d.line(EMBED).to, insert: "x" }, d.length), p.heights, p.heights);
		const atLoad = readAt(s, letter.after, loadedAfter(p), "measure");
		const info = JSON.stringify({ text: letter.after.line(EMBED).text, letter: letter.dy, atLoad, placed: s.a.dyOf(placed) });
		typedPremise(p, EMBED_TEXT, info);
		expect([letter.after.line(EMBED).text, letter.dy], `premise: the letter went on the picture's line and moved no ink ${info}`).toEqual([`${EMBED_TEXT}x`, 0]);
		expect([atLoad, s.a.dyOf(placed)], `the line was armed by the paste: the older ink stays, the stroke drawn after the paste rides ${LATE} ${info}`).toEqual([0, LATE]);
	});

	it("two pictures pasted on new lines, one change each, then the second line joined onto the first: the joined line stays armed, and its late height moves no ink (dyOf 0)", () => {
		const s = surface("late-join-armed.md");
		const p1 = paste(s, "above");
		const d1 = p1.after;
		const p2 = typed(s, d1, p1.heights, ChangeSet.of({ from: d1.line(EMBED).to, insert: "\n![[b.png]]" }, d1.length), EMBED + 1, PRE_PX);
		const d2 = p2.after;
		// Backspace at the start of the second picture's line.
		const join = ChangeSet.of({ from: d2.line(EMBED).to, to: d2.line(EMBED + 1).from }, d2.length);
		const guess = [...p2.heights.slice(0, EMBED - 1), LINE_PX, ...p2.heights.slice(EMBED + 1)];
		const j = edit(s, d2, join, guess, withLine(guess, EMBED, PRE_PX));
		const atLoad = readAt(s, j.after, withLine(j.heights, EMBED, LOADED_PX), "measure");
		const info = JSON.stringify({ text: j.after.line(EMBED).text, join: j.dy, atLoad });
		typedPremise(p1, EMBED_TEXT, info);
		typedPremise(p2, "![[b.png]]", info);
		expect([j.after.line(EMBED).text, j.dy, atLoad], `the joined line's late height is the pastes' own ${info}`).toEqual([`${EMBED_TEXT}![[b.png]]`, 0, 0]);
	});

	it("guard: an old line joined onto the pasted picture's line, whose picture then loads late: that line keeps old text, so the ink moves as today", () => {
		const s = surface("late-join-old-onto.md");
		const d0 = s.doc;
		// The picture on a new line 8, above line 8 of old text (line 9 after it).
		const p = typed(s, d0, s.heights, ChangeSet.of({ from: d0.line(7).to, insert: `\n${EMBED_TEXT}` }, d0.length), 8, PRE_PX);
		const d = p.after;
		// Delete at the end of the picture's line.
		const join = ChangeSet.of({ from: d.line(8).to, to: d.line(9).from }, d.length);
		const guess = [...p.heights.slice(0, 7), LINE_PX, ...p.heights.slice(9)];
		const j = edit(s, d, join, guess, withLine(guess, 8, PRE_PX));
		const atLoad = readAt(s, j.after, withLine(j.heights, 8, LOADED_PX), "measure");
		const info = JSON.stringify({ text: j.after.line(8).text, join: j.dy, atLoad });
		typedPremise(p, EMBED_TEXT, info);
		expect([j.after.line(8).text, j.dy, atLoad], `the joined line's late height moves the ink, as today ${info}`).toEqual([`${EMBED_TEXT}line 8 words`, 0, LATE]);
	});

	// Named limit, after the release: the undo of a lasso move re-takes the stroke's anchor where it is shown, as the move's
	// end does (InkOverlayOps.ts applyInkOp, case "move"), so the stroke counts as placed at the undo, after the paste, and
	// rides the picture's late height. Giving it back the place it had before the move needs the history step to carry it.
	it.fails("named limit, after the release: the older ink moved by the lasso after the paste and the move undone, then the picture loads late: the ink stays where it was shown (dyOf 0)", () => {
		const s = surface("late-undo-move.md");
		const p = paste(s, "above");
		const shown0 = s.ink.bbox.y + s.a.dyOf(s.ink);
		moved(s, s.ink, 40);
		const atMove = s.ink.bbox.y + s.a.dyOf(s.ink);
		moved(s, s.ink, -40);
		const atUndo = s.ink.bbox.y + s.a.dyOf(s.ink);
		const atLoad = readAt(s, p.after, loadedAfter(p), "measure");
		const info = JSON.stringify({ shown0, atMove, atUndo, atLoad });
		typedPremise(p, EMBED_TEXT, info);
		expect([atMove - shown0, atUndo - shown0], `premise: the move showed the ink 40 lower, the undo back where it was ${info}`).toEqual([40, 0]);
		expect(atLoad, `the undone move leaves older ink, which the paste's late height does not move ${info}`).toBe(0);
	});
});

const overlayPaths = new Set<string>();

afterEach(() => {
	for (const p of overlayPaths) inlineInk.handleDelete(p);
	overlayPaths.clear();
});

/**
 * The real updateLineAnchors on a bare overlay instance (LineAnchorEstimates.test.ts's rig), over the same eight lines of
 * text and blank last line, every line one LINE_PX tall at half an editor px per world unit. The note's one stroke loads from
 * its page, is dropped by the lasso 30 editor px below the last line (retake), and shows no correction. `update` hands the
 * overlay an editor update: from the measure loop (no transaction) or from transactions, each with its effects and whether
 * it reconfigured. `measure` is the measure loop's pass: the update, then the window's measure write when one was asked for.
 */
async function overlaySurface(path: string) {
	overlayPaths.add(path);
	const pageId = `${path}-id`;
	const drawn = strokeAt("ink", 100, (9 * LINE_PX + 30) / PX);
	inlineInk.attachHost({
		readPageId: (p: string) => (p === path ? pageId : null),
		claimId: async () => ({ pageId }),
		loadSidecar: async (): Promise<ParseResult> => {
			const page = emptyPage(pageId);
			page.surface = "inline";
			page.strokes.push(drawn);
			return { data: page, recovered: false };
		},
		scheduleSidecar() {},
		scheduleSidecarNow: async () => {},
		notify() {},
	} as never);
	await inlineInk.ensureLoaded(path);
	const src = inlineInk.strokes(path), ink = src[0]!;
	const doc = Text.of([...Array.from({ length: 8 }, (_, i) => `line ${i + 1} words`), ""]);
	const lay = { doc, heights: Array.from({ length: doc.lines }, () => LINE_PX) };
	const a = new LineAnchors(() => layoutOf(lay.doc, lay.heights));
	a.setSignature(SIG);
	a.tracks(path, src);
	a.drawn(1, doc.lines);
	a.drawn(1, doc.lines, true, true);
	a.anchorNew(path, ink);
	a.retake(path, [ink], undefined, src);
	const premise = { line: ink.lineAnchor?.line ?? null, dy: a.dyOf(ink) };
	expect(premise, `premise: the dropped ink anchors on the last line, ${doc.lines}, and shows no correction ${JSON.stringify(premise)}`).toEqual({ line: doc.lines, dy: 0 });
	const sel = (n: number) => ({ ranges: [{ from: lay.doc.line(n).to, to: lay.doc.line(n).to }] });
	const win = { setTimeout: vi.fn(() => 1), clearTimeout: () => undefined };
	let windowAsked = false;
	const lineWindowMeasure = { key: {}, read: () => null, write: () => void a.closeWindow(path, inlineInk.strokes(path)) };
	const view = { viewport: { from: 0, to: doc.length }, defaultLineHeight: LINE_PX, defaultCharacterWidth: 9, state: { doc, selection: sel(1) },
		requestMeasure: (m: unknown) => void (m === lineWindowMeasure && (windowAsked = true)), dom: { ownerDocument: { defaultView: win } } };
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const overlay = Object.create(InkOverlayPlugin.prototype) as any;
	overlay.pinchScaleNow = 1;
	Object.assign(overlay, { filePath: () => path, view, lineAnchorState: a, lineAnchorPassTimer: 0, lineDrawnAt: 0, lineWindowMeasure,
		lineAnchorsMoved: () => undefined });
	type Tr = { effects?: unknown[]; reconfigured?: boolean };
	const update = (flags: { docChanged?: boolean; heightChanged?: boolean; geometryChanged?: boolean; selectionSet?: boolean }, trs: Tr[], extra: object = {}): void =>
		overlay.updateLineAnchors({ docChanged: false, viewportChanged: false, heightChanged: false, geometryChanged: false, selectionSet: false, ...flags,
			transactions: trs.map((t) => ({ docChanged: !!flags.docChanged, effects: t.effects ?? [], reconfigured: !!t.reconfigured })),
			state: view.state, startState: view.state, ...extra });
	return {
		path, a, ink, lay, view,
		/** Line `n`'s height now, editor px. */
		setHeight: (n: number, px: number): void => void (lay.heights[n - 1] = px),
		/** A document change that puts lines in: drawn at LINE_PX, the cursor at the end of line `cursor`. */
		change: (changes: ChangeSet, at: number, added: number, cursor: number): void => {
			const startState = view.state, after = changes.apply(lay.doc);
			lay.doc = after;
			lay.heights.splice(at - 1, 0, ...Array.from({ length: added }, () => LINE_PX));
			view.state = { doc: after, selection: sel(cursor) };
			view.viewport = { from: 0, to: after.length };
			update({ docChanged: true, geometryChanged: true, selectionSet: true }, [{}], { changes, startState });
		},
		/** A click on line `n`: a transaction that moves the selection alone. */
		click: (n: number): void => {
			view.state = { doc: lay.doc, selection: sel(n) };
			update({ selectionSet: true }, [{}]);
		},
		/** A transaction with an effect (a fold or an unfold) whose own update changed no layout. */
		effect: (): void => update({}, [{ effects: [{}] }]),
		/** The measure loop's pass: its update (heights read), then the window's measure write when one was asked for. */
		measure: (): void => {
			update({ heightChanged: true, geometryChanged: true }, []);
			if (windowAsked) {
				windowAsked = false;
				lineWindowMeasure.write();
			}
		},
	};
}

describe("the late height of lines an edit put in, through the overlay's update", () => {
	it("guard: the pasted picture's line folded away with its section by a fold whose own update changed no layout, its height read at the next measure: the ink rides up by the whole fold, and back at the unfold, as today", async () => {
		const o = await overlaySurface("late-fold-no-geometry.md");
		const d0 = o.lay.doc;
		o.change(ChangeSet.of({ from: d0.line(8).to, insert: `\n${EMBED_TEXT}` }, d0.length), EMBED, 1, EMBED);
		o.setHeight(EMBED, PRE_PX);
		o.measure();
		const pasted = { text: o.lay.doc.line(EMBED).text, windowOpen: o.a.windowOpen, settling: o.a.settlingCount, dy: o.a.dyOf(o.ink) };
		// The cursor on the heading on line 4, whose fold takes lines 5 to 9, the picture's among them.
		o.click(4);
		o.effect();
		const atFold = o.a.dyOf(o.ink);
		const settlingAfterFold = o.a.settlingCount;
		const open = [...o.lay.heights];
		for (let n = 5; n <= EMBED; n++) o.setHeight(n, 0);
		o.measure();
		const atFoldMeasure = o.a.dyOf(o.ink);
		o.effect();
		o.lay.heights.splice(0, open.length, ...open);
		o.measure();
		const atUnfoldMeasure = o.a.dyOf(o.ink);
		const FOLD = (4 * LINE_PX + PRE_PX) / PX;
		const info = JSON.stringify({ pasted, atFold, settlingAfterFold, atFoldMeasure, atUnfoldMeasure, fold: FOLD });
		expect(pasted, `premise: the picture's line went in, its window closed, the line settling, no ink moved ${info}`).toEqual({ text: EMBED_TEXT, windowOpen: false, settling: 1, dy: 0 });
		expect([atFold, atFoldMeasure, atUnfoldMeasure], `the fold moves the ink up with its line, the picture's line included, the unfold back to where it was drawn ${info}`).toEqual([0, -FOLD, 0]);
	});

	it("the pasted picture's line typed on, then a click on another line whose own update changed no layout, then the picture loads at the next measure: the ink stays where it was shown (dyOf 0)", async () => {
		const o = await overlaySurface("late-letter-click.md");
		const d0 = o.lay.doc;
		o.change(ChangeSet.of({ from: d0.line(8).to, insert: `\n${EMBED_TEXT}` }, d0.length), EMBED, 1, EMBED);
		o.setHeight(EMBED, PRE_PX);
		o.measure();
		const d1 = o.lay.doc;
		o.change(ChangeSet.of({ from: d1.line(EMBED).to, insert: "x" }, d1.length), EMBED, 0, EMBED);
		o.measure();
		const typed = { text: o.lay.doc.line(EMBED).text, windowOpen: o.a.windowOpen, settling: o.a.settlingCount, dy: o.a.dyOf(o.ink) };
		o.click(2);
		const atClick = { settling: o.a.settlingCount, dy: o.a.dyOf(o.ink) };
		o.setHeight(EMBED, LOADED_PX);
		o.measure();
		const atLoad = o.a.dyOf(o.ink);
		const info = JSON.stringify({ typed, atClick, atLoad });
		expect(typed, `premise: the letter went on the picture's line, its window closed, the line settling, no ink moved ${info}`).toEqual({ text: `${EMBED_TEXT}x`, windowOpen: false, settling: 1, dy: 0 });
		expect([atClick.settling, atClick.dy, atLoad], `the letter and the click keep the line settling, and its late height moves no ink ${info}`).toEqual([1, 0, 0]);
	});
});
