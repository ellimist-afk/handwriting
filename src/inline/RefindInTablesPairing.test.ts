/**
 * K550-1: refindInTables when two rows or two columns of a table hold the same text. A row or column the edit left in
 * place from the table's start, then from its end, keeps its pair; then equal rows or columns pair in order only when the
 * edit kept how many there are; the rest are placed by their place between the ones kept. Where neither the text nor the
 * place tells two apart, the target is left collapsed (needs reattachment): never read on its twin. Pure, through
 * refindInTables, as RefindInTables.test.ts runs it; each edit is one the app writes: a whole-table replace (every table
 * edit), a cell's span replaced (a typed character, Live Preview), or a point insert at a cell target's end (typing in
 * Source mode). What the caller does next with a target left collapsed (refindCollapsed) is not read here.
 */
import { describe, expect, it } from "vitest";
import { ChangeSet, Text, type ChangeSpec } from "@codemirror/state";
import { cellEdgeReached, mapTarget, refindInTables, tableAround, tableCellIn, targetAt, type AttachmentData, type AttachmentRecord } from "./InkAttachments";

const ABOVE = "Text above\n\n", BELOW = "\n\nText below\n";
const note = (table: string) => ABOVE + table + BELOW;
const lines = (...l: string[]) => l.join("\n");

const record = (id: string, doc: string, from: number, to: number): AttachmentRecord => ({
	v: 1, id, strokeIds: [`s-${id}`], target: targetAt(doc, from, to, "range"),
	ref: { x: 0, y: 0 }, layout: { width: 1180, font: 26 }, probe: { id: `s-${id}`, x: 0, y: 0 },
});

/** The cell at row `r` (0 the header) and column `c` of the note's table. */
function cellOf(doc: string, r: number, c: number) {
	const x = tableAround(doc, ABOVE.length)?.rows[r]?.[c];
	if (!x || x.to <= x.from) throw new Error(`premise: cell ${r},${c} in ${JSON.stringify(doc)}`);
	return x;
}

/** Where a target is in `doc`: "row,col text" of the cell holding it, or "collapsed". */
function place(doc: string, a: AttachmentData): string {
	const t = (a as AttachmentRecord).target;
	if (t.from === t.to) return "collapsed";
	const tb = tableAround(doc, t.from), c = tb && tableCellIn(tb, t.from, t.to);
	return c ? `${c.row},${c.col} ${doc.slice(t.from, t.to)}` : `outside ${doc.slice(t.from, t.to)}`;
}

/** One replace of the whole table, the shape every table edit the app writes has. */
const wholeTable = (was: string, now: string) => (): ChangeSpec => ({ from: ABOVE.length, to: ABOVE.length + was.length, insert: now });
/** A typed character as the app writes it: the cell's whole span between its pipes replaced (one space each side). */
const cellReplace = (r: number, c: number, now: string) => (doc: string): ChangeSpec => {
	const x = cellOf(doc, r, c);
	return { from: x.from - 1, to: x.to + 1, insert: ` ${now} ` };
};
/** Text typed at a cell's last character as plain typing in Source mode writes it: a point insert. */
const atCellEnd = (r: number, c: number, text: string) => (doc: string): ChangeSpec => ({ from: cellOf(doc, r, c).to, insert: text });

/**
 * `table` (in a note with text above and below) edited by `edit`, ink on the whole text of each cell in `inks` (its
 * first drawn character to its end: a cell target made now, or a word target when the cell is one word): where
 * refindInTables leaves each target.
 */
function edited(table: string, inks: [number, number][], edit: (doc: string) => ChangeSpec) {
	const o = note(table);
	const before: AttachmentData[] = inks.map(([r, c], k) => { const x = cellOf(o, r, c); return record(`att-${k}`, o, x.from, x.to); });
	const changes = ChangeSet.of([edit(o)], o.length);
	const n = changes.apply(Text.of(o.split("\n"))).toString();
	const mapped = before.map((a) => ({ ...a, target: mapTarget((a as AttachmentRecord).target, changes) }));
	const found = refindInTables(before, mapped, () => o, () => n, changes);
	return {
		collapsed: mapped.map((a) => a.target.from === a.target.to),
		edge: cellEdgeReached(before, changes, (pos) => Text.of(o.split("\n")).lineAt(pos)),
		at: found.map((a) => place(n, a)),
	};
}

const TWO_COLS = (row: string) => lines("| a | a |", "| --- | --- |", row);
const HEAD2 = lines("| h1 | h2 |", "| --- | --- |");
const X = "| x | y |";

describe("columns: two columns with the same header", () => {
	it("the sweep's case: A's 1 made 2 by a whole-table replace; B's ink keeps column B (base read it on A's 2)", () => {
		const t = TWO_COLS("| 1 | 2 |"), r = edited(t, [[1, 0], [1, 1]], wholeTable(t, TWO_COLS("| 2 | 2 |")));
		expect(r.collapsed, "premise: the replace collapsed both targets").toEqual([true, true]);
		expect(r.at, "A's ink in A's cell (its word edited: the cell), B's in B's").toEqual(["1,0 2", "1,1 2"]);
	});
	it("its reverse: two equal columns, A's 1 made 2 by a whole-table replace; A's ink stays in A (base read it on B's 1)", () => {
		const t = TWO_COLS("| 1 | 1 |"), r = edited(t, [[1, 0], [1, 1]], wholeTable(t, TWO_COLS("| 2 | 1 |")));
		expect(r.collapsed, "premise: the replace collapsed both targets").toEqual([true, true]);
		expect(r.at, "A's ink in A's cell, B's on B's 1").toEqual(["1,0 2", "1,1 1"]);
	});
	it("typed: two equal columns, 2 typed after A's 1 (its cell's span replaced); A's ink stays in A (base read it on B's 1)", () => {
		const r = edited(TWO_COLS("| 1 | 1 |"), [[1, 0]], cellReplace(1, 0, "12"));
		expect(r.collapsed, "premise: the cell replace collapsed A's target").toEqual([true]);
		expect(r.at, "A's ink on A's cell").toEqual(["1,0 12"]);
	});
	it("cannot tell: two equal columns, one gone, the third moved first, a new one between; both inks left collapsed (base read A's on the one left)", () => {
		const t = lines("| a | a | c |", "| --- | --- | --- |", "| 1 | 1 | 3 |");
		const r = edited(t, [[1, 0], [1, 1]], wholeTable(t, lines("| c | d | a |", "| --- | --- | --- |", "| 3 | 4 | 1 |")));
		expect(r.collapsed, "premise: the replace collapsed both targets").toEqual([true, true]);
		expect(r.at, "neither text nor place tells which column is left: no guess").toEqual(["collapsed", "collapsed"]);
	});
	it("guard G3: two equal columns, a column added at the end; each ink in its own column (as base)", () => {
		const t = TWO_COLS("| 1 | 1 |"), r = edited(t, [[1, 0], [1, 1]], wholeTable(t, lines("| a | a | c |", "| --- | --- | --- |", "| 1 | 1 | 3 |")));
		expect(r.collapsed, "premise: the replace collapsed both targets").toEqual([true, true]);
		expect(r.at).toEqual(["1,0 1", "1,1 1"]);
	});
	it("guard, bound line 4: a column copied beside itself; the ink stays attached in the left one (as base)", () => {
		const t = lines("| a |", "| --- |", "| 1 |"), r = edited(t, [[1, 0]], wholeTable(t, TWO_COLS("| 1 | 1 |")));
		expect(r.collapsed, "premise: the replace collapsed the target").toEqual([true]);
		expect(r.at).toEqual(["1,0 1"]);
	});
	it("guard: two equal columns, the right one deleted; A's ink stays on the one left, B's left collapsed (as base)", () => {
		const t = TWO_COLS("| 1 | 1 |"), r = edited(t, [[1, 0], [1, 1]], wholeTable(t, lines("| a |", "| --- |", "| 1 |")));
		expect(r.collapsed, "premise: the replace collapsed both targets").toEqual([true, true]);
		expect(r.at).toEqual(["1,0 1", "collapsed"]);
	});
});

describe("rows: two rows with the same text", () => {
	it("typed: two TBD rows, s typed after the upper row's first TBD (its cell's span replaced); the ink stays on the upper row (base read it on the lower)", () => {
		const t = lines(HEAD2, "| TBD | TBD |", "| TBD | TBD |"), r = edited(t, [[1, 0]], cellReplace(1, 0, "TBDs"));
		expect(r.collapsed, "premise: the cell replace collapsed the target").toEqual([true]);
		expect(r.at, "the upper row's cell").toEqual(["1,0 TBDs"]);
	});
	it("typed, left standing: two a b rows, c typed at the upper cell target's end (a point insert); it stays the upper row's cell (base moved it to the lower)", () => {
		const t = lines("| h |", "| --- |", "| a b |", "| a b |"), r = edited(t, [[1, 0]], atCellEnd(1, 0, "c"));
		expect(r.collapsed, "premise: the point insert left the target standing").toEqual([false]);
		expect(r.edge, "premise: the caller calls refindInTables (cellEdgeReached)").toBe(true);
		expect(r.at, "the upper row's cell, its new text").toEqual(["1,0 a bc"]);
	});
	it("whole-table replace: the upper of two rows a/y then x/y made x/y; the lower row's ink stays on the lower row (base read it on the upper)", () => {
		const t = lines(HEAD2, "| a | y |", X), r = edited(t, [[2, 0]], wholeTable(t, lines(HEAD2, X, X)));
		expect(r.collapsed, "premise: the replace collapsed the target").toEqual([true]);
		expect(r.at).toEqual(["2,0 x"]);
	});
	it("cannot tell: two equal rows, one gone, a row below them moved up, a new one between; both inks left collapsed (base read the upper's on the one left)", () => {
		const t = lines(HEAD2, X, X, "| p | q |"), r = edited(t, [[1, 0], [2, 0]], wholeTable(t, lines(HEAD2, "| p | q |", "| r | s |", X)));
		expect(r.collapsed, "premise: the replace collapsed both targets").toEqual([true, true]);
		expect(r.at, "neither text nor place tells which row is left: no guess").toEqual(["collapsed", "collapsed"]);
	});
	it("guard G1: two equal rows, an empty row added at the end; each ink on its own row (as base)", () => {
		const t = lines(HEAD2, X, X), r = edited(t, [[1, 0], [2, 0]], wholeTable(t, lines(HEAD2, X, X, "|  |  |")));
		expect(r.collapsed, "premise: the replace collapsed both targets").toEqual([true, true]);
		expect(r.at).toEqual(["1,0 x", "2,0 x"]);
	});
	it("guard G2: two equal rows, a row added above them; each ink on its own row, not swapped (as base)", () => {
		const t = lines(HEAD2, X, X), r = edited(t, [[1, 0], [2, 0]], wholeTable(t, lines(HEAD2, "| n | m |", X, X)));
		expect(r.collapsed, "premise: the replace collapsed both targets").toEqual([true, true]);
		expect(r.at).toEqual(["2,0 x", "3,0 x"]);
	});
	it("guard, bound line 4: a row copied below itself; the ink stays attached on the upper row (as base)", () => {
		const t = lines(HEAD2, X), r = edited(t, [[1, 0]], wholeTable(t, lines(HEAD2, X, X)));
		expect(r.collapsed, "premise: the replace collapsed the target").toEqual([true]);
		expect(r.at).toEqual(["1,0 x"]);
	});
	it("guard: two equal rows, the lower deleted; the upper's ink stays on the row left, the lower's left collapsed (as base)", () => {
		const t = lines(HEAD2, X, X), r = edited(t, [[1, 0], [2, 0]], wholeTable(t, lines(HEAD2, X)));
		expect(r.collapsed, "premise: the replace collapsed both targets").toEqual([true, true]);
		expect(r.at).toEqual(["1,0 x", "collapsed"]);
	});
});
