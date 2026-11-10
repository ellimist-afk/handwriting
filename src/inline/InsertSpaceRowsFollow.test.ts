/**
 * The insert-space rows cache confirms a
 * stroke by id and store revision, so group members shown as copies do not make it read every stroke again. Each cell
 * compares the cached rows with a fresh InsertSpaceRows over the same list.
 */
import { describe, expect, it } from "vitest";
import { InsertSpaceRows, strokeIdsBelow, type InkRow } from "./InsertSpace";
import { shiftedStroke } from "./LineAnchor";
import { bumpStrokeRev } from "../ink/StrokeRev";
import { computeBBox, type InkStroke } from "../ink/Stroke";

/** A stroke through the given points, in order. */
function stroke(id: string, pts: [number, number][]): InkStroke {
	const points = pts.map(([x, y], t) => ({ x, y, pressure: 0.5, t }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 1), createdAt: 1 };
}

/** A letter-sized stroke, 8 wide and 10 tall, top left at (x, y). */
function letter(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + (i * 8) / 3, y: y + (i % 2 === 0 ? 0 : 10), pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 1), createdAt: 1 };
}

/** Moves a store stroke in place, as moveStrokes does. */
function moveInPlace(s: InkStroke, dy: number): void {
	for (const p of s.points) p.y += dy;
	s.bbox = computeBBox(s.points, s.width);
	bumpStrokeRev(s);
}

const norm = (rows: readonly InkRow[]) => rows.map((r) => ({ top: r.top, bottom: r.bottom, ids: [...r.ids].sort() })).sort((a, b) => a.top - b.top || a.ids[0]!.localeCompare(b.ids[0]!));
const fresh = (list: readonly InkStroke[]) => norm(new InsertSpaceRows().get(list));
const counts = (c: InsertSpaceRows) => (c as unknown as { counts?: { rebuilds: number; touchedRows: number } }).counts;

/** Two rows of free ink, a group of two members on the lower row shown at a correction. */
function note() {
	const a1 = letter("a1", 0, 10), a2 = letter("a2", 12, 10);
	const b1 = letter("b1", 0, 100), m1 = letter("m1", 12, 95), m2 = letter("m2", 24, 95), b2 = letter("b2", 36, 100);
	const store = [a1, a2, b1, m1, m2, b2];
	const shown = (dy: number) => store.map((s) => (s === m1 || s === m2 ? shiftedStroke(s, dy) : s));
	return { store, shown, members: [m1, m2] };
}

describe("rows cache confirms a shown copy by id and store revision", () => {
	it("R1: an insert space with a group below: the first ask after it reads no stroke again, rows as a fresh read", () => {
		const n = note(), cache = new InsertSpaceRows();
		const before = n.shown(5);
		const rows = cache.get(before);
		expect(counts(cache)?.rebuilds, "premise: the first ask reads every stroke once").toBe(1);
		const ids = strokeIdsBelow(before, 50, rows);
		expect([...ids].sort(), "premise: the seam takes the lower row, members too").toEqual(["b1", "b2", "m1", "m2"]);
		cache.queueShift(rows, ids, [40]);
		for (const s of n.store) if (ids.includes(s.id)) moveInPlace(s, 40);
		// The group's correction holds; its copies are made again from the moved store strokes.
		const after = n.shown(5);
		expect(norm(cache.get(after)), "rows as a fresh read").toEqual(fresh(after));
		expect(counts(cache)?.rebuilds, "no stroke read again").toBe(1);
	});

	it("R2: a keystroke moves the group (store unchanged): no stroke read again, rows as a fresh read", () => {
		const n = note(), cache = new InsertSpaceRows();
		cache.get(n.shown(5));
		const after = n.shown(7);
		expect(norm(cache.get(after)), "rows as a fresh read").toEqual(fresh(after));
		expect([counts(cache)?.rebuilds, (counts(cache)?.touchedRows ?? 0) > 0], "no stroke read again; the members' row regrouped").toEqual([1, true]);
	});

	it("R3: a group moved off its row of free ink: the row splits, rows as a fresh read", () => {
		const n = note(), cache = new InsertSpaceRows();
		const before = n.shown(0);
		expect(norm(cache.get(before)).some((r) => r.ids.includes("m1") && r.ids.includes("b1")), "premise: the members share a row with free ink").toBe(true);
		const after = n.shown(300);
		const rows = norm(cache.get(after));
		expect(rows, "rows as a fresh read").toEqual(fresh(after));
		expect(rows.some((r) => r.ids.includes("m1") && r.ids.includes("b1")), "the row split").toBe(false);
	});

	it("R4: a member leaves a full stop's group: the stop joins the drawing beside it, rows as a fresh read", () => {
		// K, a drawing 40 tall; M, a full stop 35 right of K; X, a group member 8 right of M. The stop takes ONE join, to
		// its nearest candidate: X while X is beside it, K once X has gone.
		const k = stroke("k", [[0, 0], [40, 40], [0, 40], [40, 0]]), m = stroke("m", [[75, 20], [77, 22]]), x = letter("x", 85, 15);
		const store = [k, m, x], shown = (dy: number) => store.map((s) => (s === x ? shiftedStroke(s, dy) : s));
		const cache = new InsertSpaceRows(), before = shown(0);
		const rows = norm(cache.get(before));
		expect(rows.some((r) => r.ids.includes("m") && r.ids.includes("x")) && !rows.some((r) => r.ids.includes("k") && r.ids.includes("m")), "premise: the stop is grouped with its nearest neighbour, X").toBe(true);
		const after = shown(300);
		expect(fresh(after).some((r) => r.ids.includes("k") && r.ids.includes("m")), "premise: a fresh read joins the stop to K").toBe(true);
		expect(norm(cache.get(after)), "rows as a fresh read").toEqual(fresh(after));
		expect(counts(cache)?.rebuilds, "re-placed, no stroke read again").toBe(1);
	});

	it("R5: a re-place that falls back inside a shift leaves the cache empty: the next ask reads every stroke", () => {
		const n = note(), cache = new InsertSpaceRows();
		const before = n.shown(5);
		const rows = cache.get(before);
		const ids = strokeIdsBelow(before, 50, rows);
		cache.queueShift(rows, ids, [40]);
		for (const s of n.store) if (ids.includes(s.id)) moveInPlace(s, 40);
		// The correction moved too, so each copy is re-placed; the cache is made blind to one member, so the re-place
		// falls back the way a duplicate id would. A deleted entry would not do: the shift enters its moved group again.
		const c = cache as unknown as { groupOf: Map<string, unknown> };
		c.groupOf = new (class extends Map<string, unknown> { override get(k: string) { return k === "m1" ? undefined : super.get(k); } })(c.groupOf);
		const after = n.shown(6);
		expect(norm(cache.get(after)), "rows as a fresh read").toEqual(fresh(after));
		expect(counts(cache)?.rebuilds, "the fallback read every stroke").toBe(2);
	});

	it("R6: an insert space whose group moves with its text: the shift takes the members as text-moved, reads no stroke again, rows as a fresh read", () => {
		const n = note(), cache = new InsertSpaceRows();
		const misses: unknown[] = [];
		(cache as unknown as { onMiss: (m: unknown) => void }).onMiss = (m) => misses.push(m);
		const before = n.shown(5);
		const rows = cache.get(before);
		// The first ask finds the cache empty and reads every stroke: that miss is the premise, not a fallback.
		expect(misses.length, "premise: the first ask's own miss").toBe(1);
		misses.length = 0;
		const ids = strokeIdsBelow(before, 50, rows);
		expect([...ids].sort(), "premise: the seam takes the lower row, members too").toEqual(["b1", "b2", "m1", "m2"]);
		// Insert Space moves the free strokes in the store; the text change carries the group, so its correction grows by
		// the same 40 and its store strokes stay.
		const store = ids.filter((id) => id !== "m1" && id !== "m2"), text = ["m1", "m2"];
		cache.queueShift(rows, store, [40], text);
		for (const s of n.store) if (store.includes(s.id)) moveInPlace(s, 40);
		const after = n.shown(45);
		expect(norm(cache.get(after)), `rows as a fresh read ${JSON.stringify(misses)}`).toEqual(fresh(after));
		expect([counts(cache)?.rebuilds, misses.length], `no stroke read again, no fallback ${JSON.stringify(misses)}`).toEqual([1, 0]);
	});

	// Free strokes and a group's members share one first-pass group, and the row and the group land on
	// different sides of the seam. The shift takes the group as its moved part and its staying part.
	const partMoved = (name: string, dy: number, moveGroup: boolean) => it(name, () => {
		const n = note(), cache = new InsertSpaceRows();
		const misses: { why: string }[] = [];
		(cache as unknown as { onMiss: (m: { why: string }) => void }).onMiss = (m) => misses.push(m);
		const before = n.shown(5);
		const rows = cache.get(before);
		expect(norm(rows).some((r) => r.ids.includes("m1") && r.ids.includes("b1")), "premise: the members share a row with free ink").toBe(true);
		misses.length = 0;
		let after: InkStroke[];
		if (moveGroup) {
			// Row 9: the free row stays, the attached group moves with its text (store unmoved).
			cache.queueShift(rows, [], [dy], ["m1", "m2"]);
			after = n.shown(5 + dy);
		} else {
			// Mirror: the free row moves in the store, the held group stays.
			const free = ["b1", "b2"];
			cache.queueShift(rows, free, [dy]);
			for (const s of n.store) if (free.includes(s.id)) moveInPlace(s, dy);
			after = n.shown(5);
		}
		const ok = cache.runQueued(after);
		expect(norm(cache.get(after)), `rows as a fresh read ${JSON.stringify(misses)}`).toEqual(fresh(after));
		expect([ok, misses.filter((m) => m.why === "shift:part-group").length, counts(cache)?.rebuilds, misses.length], `shiftOk, part-group refusals, rebuilds, misses ${JSON.stringify(misses)}`).toEqual([true, 0, 1, 0]);
	});
	partMoved("R7: free row stays, attached group moves 40 (row 9): shift takes both parts, rows as a fresh read", 40, true);
	partMoved("R8: free row stays, attached group moves 4, still beside it: the parts rejoin, rows as a fresh read", 4, true);
	partMoved("R9: free row moves 40, held group stays (mirror): shift takes both parts, rows as a fresh read", 40, false);
	partMoved("R10: free row moves 4, held group stays beside it: the parts rejoin, rows as a fresh read", 4, false);

	// The re-place's search.
	const more = (c: InsertSpaceRows) => (c as unknown as { counts: Record<string, number> }).counts;
	it("P2a: a group whose box is near a moved stroke but none of whose strokes joins it is not regrouped, rows as a fresh read", () => {
		// T, a stroke 100 tall at the left; L, a letter joined to its foot. X, a member 40 wide, lands beside T's top: within
		// the box test's reach of the group, but too far for an ordinary join with T and too wide to be a mark.
		const t = stroke("t", [[0, 0], [2, 100]]), l = letter("l", 4, 90);
		const x = stroke("x", [[40, 10], [80, 20]]);
		const store = [t, l, x], shown = (dy: number) => store.map((s) => (s === x ? shiftedStroke(s, dy) : s));
		const cache = new InsertSpaceRows();
		cache.get(shown(300));
		const c0 = { ...more(cache) };
		const after = shown(0);
		expect(norm(cache.get(after)), "rows as a fresh read").toEqual(fresh(after));
		expect([more(cache).rebuilds! - c0.rebuilds!, more(cache).touchedRows! - c0.touchedRows!], "no stroke read again; only the moved stroke's own group regrouped").toEqual([0, 1]);
	});

	it("P2b: a moved stroke tests only the groups in its vertical window, rows as a fresh read", () => {
		// 50 rows of two letters, 40 apart; one member moves from the first row's height to the 25th's.
		const free: InkStroke[] = [];
		for (let r = 0; r < 50; r++) free.push(letter(`a${r}`, 0, r * 40), letter(`b${r}`, 12, r * 40));
		const m = letter("m", 200, 0), store = [...free, m], shown = (dy: number) => store.map((s) => (s === m ? shiftedStroke(s, dy) : s));
		const cache = new InsertSpaceRows();
		cache.get(shown(0));
		const c0 = { ...more(cache) };
		const after = shown(25 * 40);
		expect(norm(cache.get(after)), "rows as a fresh read").toEqual(fresh(after));
		const tested = (more(cache).candidates ?? NaN) - (c0.candidates ?? 0);
		expect(tested <= 4, `groups tested ${tested} of 51`).toBe(true);
	});
});
