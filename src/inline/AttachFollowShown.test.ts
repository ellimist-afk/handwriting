/**
 * Ink attached to text, as the note surface shows it: the line anchors answer a member by its
 * group's correction, x and y, never by its own anchor; a pending group's members are left out of the shown list; a stroke
 * in no group is shown as before. Each cell names the defect that must turn it red.
 */
import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { targetAt, type AttachmentRecord } from "./InkAttachments";
import { AttachFollow as AnchorsFollow } from "./AttachFollow";
import { translateStroke } from "../objects/Selection";
import { bumpInkRevision } from "../ink/StrokeRev";

const SIG = { width: 892, fontPx: 26, charWidth: 14 };
const PATH = "attach-follow-shown.md";
const LINES = 40;
const doc = Text.of(Array.from({ length: LINES }, (_, i) => `line ${i + 1} words`));
const DOC = doc.toString();

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

function setup() {
	const state = { shift: 0 };
	const layout = (): LineLayout => ({ lines: doc.lines, lineText: (n) => doc.line(n).text, lineTop: (n) => (n - 1) * 40 + state.shift, pxPerWorld: 1 });
	const anchors = new LineAnchors(layout);
	anchors.setSignature(SIG);
	anchors.drawn(1, LINES);
	anchors.drawn(1, LINES, true, true);
	const list = [strokeAt("s1", 10, 85), strokeAt("s2", 40, 90), strokeAt("free", 10, 205)];
	for (const s of list) anchors.anchorNew(PATH, s);
	anchors.strokesFor(PATH, list);
	return { anchors, list, state };
}

const word = "line 3 words";
const record = (): AttachmentRecord => {
	const from = DOC.indexOf(word);
	return { v: 1, id: "att-1", strokeIds: ["s1", "s2"], target: targetAt(DOC, from, from + word.length, "range"), ref: { x: 0, y: 80 }, layout: { width: 892, font: 26 }, probe: { id: "s1", x: 10, y: 89 } };
};

describe("attached ink as the note surface shows it", () => {
	it("membership wins: a member is shown by its group, not by its own line anchor", () => {
		// Defect: a member keeps its own anchor's correction, so its group splits when the lines above settle.
		const { anchors, list, state } = setup();
		state.shift = 80;
		anchors.layoutChanged(PATH, list, "measure");
		expect(anchors.dyOf(list[0]!)).toBe(80);
		const r = record();
		anchors.follow.setList([r]);
		anchors.follow.attached(r, 80);
		expect(anchors.dyOf(list[0]!)).toBe(0);
		expect(anchors.shownOf(list[0]!)).toBe(list[0]);
		expect(anchors.dyOf(list[2]!), "a stroke in no group keeps its own anchor").toBe(80);
	});

	it("a pending group's members are left out of the shown list, then shown moved by x and y once read", () => {
		// Defect: pending members are painted at their stored points; or the shown copy moves y only.
		const { anchors, list } = setup();
		anchors.follow.setList([record()]);
		const pending = anchors.strokesFor(PATH, list);
		expect(pending.map((s) => s.id)).toEqual(["free"]);
		anchors.follow.measure({ inView: () => true, refAt: () => ({ x: 6, y: 92 }), blockTop: () => 80 });
		const shown = anchors.strokesFor(PATH, list);
		expect(shown.map((s) => s.id)).toEqual(["s1", "s2", "free"]);
		expect(shown[0]!.bbox.x).toBeCloseTo(list[0]!.bbox.x + 6, 9);
		expect(shown[0]!.bbox.y).toBeCloseTo(list[0]!.bbox.y + 12, 9);
		expect(shown[1]!.points[0]!.x).toBeCloseTo(list[1]!.points[0]!.x + 6, 9);
		expect(shown[2]).toBe(list[2]);
		expect(list[0]!.points[0]!.x, "the store's stroke is untouched").toBe(10);
	});

	it("the last member of the last group erased: no stroke is a member, and the free list is the store's own list", () => {
		// The path with no member left (offsetOf and shown return at once on an empty membership).
		const { anchors, list } = setup();
		const r = record();
		anchors.follow.setList([r]);
		anchors.follow.measure({ inView: () => true, refAt: () => ({ x: 6, y: 92 }), blockTop: () => 80 });
		expect(anchors.follow.offsetOf("s1"), "premise: s1 is a member, read").toEqual({ dx: 6, dy: 12 });
		const rest = [list[2]!];
		anchors.follow.setList([{ ...r, strokeIds: [] }]);
		expect([anchors.follow.memberMap.size, anchors.follow.offsetOf("s1"), anchors.follow.offsetOf("free")], "no member: every stroke's own anchor applies").toEqual([0, undefined, undefined]);
		expect([anchors.follow.shown(list[0]!), anchors.follow.shown(rest[0]!)], "shown answers no stroke as a member").toEqual([undefined, undefined]);
		expect(anchors.freeFor(PATH, rest).free, "the free list is the store's own list").toBe(rest);
	});
});

describe("attached groups moved: what the surface held, and what it holds now", () => {
	const view = (y: number) => ({ inView: () => true, refAt: () => ({ x: 0, y }), blockTop: () => (y - 80) * 1 });
	function shownGroup(strokeIds = ["s1", "s2"]) {
		const f = new AnchorsFollow();
		const r = { ...record(), strokeIds };
		const list = [strokeAt("s1", 10, 85), strokeAt("s2", 40, 90)];
		f.setList([r]);
		f.attached(r, 80);
		for (const s of list) f.shown(s);
		return { f, list };
	}

	it("a move from 0 goes per member (the store's own then, the copy now); a move between corrections moves the same copies in place", () => {
		// Defect: the index loses the old object (remove by a fresh copy finds nothing) and the old ink stays painted; or a
		// told move builds a pair and a new copy per member.
		const { f, list } = shownGroup();
		let before = f.snapshot();
		f.layoutChanged();
		expect(f.measure(view(120)).changed).toBe(true);
		const first = f.movesSince(before)!;
		expect([first.moves.length, first.groups.length]).toEqual([1, 0]);
		expect(first.moves[0]!.map((m) => m.old)).toEqual([list[0], list[1]]);
		expect(first.moves[0]![0]!.old).toBe(list[0]);
		expect(first.moves[0]![0]!.now).toBe(f.shown(list[0]!));
		expect(first.moves[0]![0]!.now.bbox.y - list[0]!.bbox.y).toBeCloseTo(40, 9);
		const held = first.moves[0]!.map((m) => m.now);
		const was = held.map((s) => s.bbox);
		before = f.snapshot();
		f.layoutChanged();
		f.measure(view(160));
		const pairs = f.moveCounts.pairs;
		const second = f.movesSince(before)!;
		expect([second.moves.length, f.moveCounts.pairs - pairs], "no pair for a told move").toEqual([0, 0]);
		const g = second.groups[0]!;
		expect(g.shown[0]).toBe(held[0]);
		expect(g.shown[1]).toBe(held[1]);
		expect(g.boxesBefore).toEqual(was);
		expect(f.shown(list[0]!), "the moved copy stays the one shown").toBe(held[0]);
		expect(held[0]!.bbox.y - list[0]!.bbox.y).toBeCloseTo(80, 9);
		expect(held[0]!.points[0]!.y - list[0]!.points[0]!.y, "its points read at the new place").toBeCloseTo(80, 9);
		expect(g.after.y - g.before.y).toBeCloseTo(40, 9);
	});

	it("no move answers an empty list; a dangling member id is passed over", () => {
		// Defect: an unmoved group repaints, or an id with no stroke (a whole-stroke erase) forces a whole repaint.
		const { f } = shownGroup(["s1", "s2", "gone"]);
		const before = f.snapshot();
		f.layoutChanged();
		f.measure(view(80));
		expect(f.movesSince(before)).toEqual({ moves: [], groups: [] });
		f.layoutChanged();
		const b2 = f.snapshot();
		f.measure(view(100));
		expect(f.movesSince(b2)!.moves.flat().map((m) => m.old.id)).toEqual(["s1", "s2"]);
	});

	it("a first read, or a group never shown here, cannot be told exactly: null, the caller repaints whole", () => {
		// Defect: a first read is treated as a move from nowhere and the members are never put in the index.
		const f = new AnchorsFollow();
		f.setList([record()]);
		const before = f.snapshot();
		f.measure(view(120));
		expect(f.movesSince(before)).toBeNull();
		const g = new AnchorsFollow();
		const r = record();
		g.setList([r]);
		g.attached(r, 80);
		const b2 = g.snapshot();
		g.layoutChanged();
		g.measure(view(120));
		expect(g.movesSince(b2)).toBeNull();
	});
});
describe("the shown list is the store list patched", () => {
	it("D1: a store move of two free strokes beside a moved group: no shownOf for a stroke at no correction, remade = members", () => {
		// Defect: one store move makes strokesFor walk the whole note, asking the follow and the line anchors for every stroke
		// (row 9 release: 28k strokes, 10758 shownOf, noteStrokes 6.3 ms against 1.1).
		const layout = (): LineLayout => ({ lines: doc.lines, lineText: (n) => doc.line(n).text, lineTop: (n) => (n - 1) * 40, pxPerWorld: 1 });
		const anchors = new LineAnchors(layout);
		anchors.setSignature(SIG);
		anchors.drawn(1, LINES);
		anchors.drawn(1, LINES, true, true);
		const free = Array.from({ length: 50 }, (_, i) => strokeAt("f" + i, 10 + (i % 5) * 60, 205 + 40 * Math.floor(i / 5)));
		const list = [strokeAt("s1", 10, 85), strokeAt("s2", 40, 90), ...free];
		for (const s of list) anchors.anchorNew(PATH, s);
		anchors.follow.setList([record()]);
		anchors.follow.measure({ inView: () => true, refAt: () => ({ x: 6, y: 92 }), blockTop: () => 80 });
		const first = anchors.strokesFor(PATH, list);
		expect(first[0]!.bbox.x - list[0]!.bbox.x, "premise: the group is shown moved").toBeCloseTo(6, 9);
		expect(free.filter((s) => s.lineAnchor).length, "premise: the free strokes carry line anchors").toBe(50);
		const n = anchors.strokesForCounts, remade = n.remade ?? 0;
		let calls = 0;
		const real = anchors.shownOf.bind(anchors);
		anchors.shownOf = (s: InkStroke) => { calls++; return real(s); };
		translateStroke(free[3]!, 0, 2);
		translateStroke(free[17]!, 0, 2);
		const second = anchors.strokesFor(PATH, list);
		expect(calls, "shownOf only for the two moved strokes").toBeLessThanOrEqual(2);
		expect((n.remade ?? 0) - remade, "remade: the two members (the moved free strokes are at no correction)").toBe(2);
		expect(second.filter((s, i) => s !== first[i] && s.id !== "f3" && s.id !== "f17").map((s) => s.id), "every other shown object kept").toEqual([]);
		expect(second.find((s) => s.id === "f3")!.bbox.y, "the moved stroke shown where it now is").toBeCloseTo(free[3]!.bbox.y, 9);
	});
});
describe("the first build after a store-list answer", () => {
	function zeroGroup() {
		const layout = (): LineLayout => ({ lines: doc.lines, lineText: (n) => doc.line(n).text, lineTop: (n) => (n - 1) * 40, pxPerWorld: 1 });
		const anchors = new LineAnchors(layout);
		anchors.setSignature(SIG);
		anchors.drawn(1, LINES);
		anchors.drawn(1, LINES, true, true);
		const free = Array.from({ length: 50 }, (_, i) => strokeAt("f" + i, 10 + (i % 5) * 60, 205 + 40 * Math.floor(i / 5)));
		const list = [strokeAt("s1", 10, 85), strokeAt("s2", 40, 90), ...free];
		for (const s of list) anchors.anchorNew(PATH, s);
		const r = record();
		anchors.follow.setList([r]);
		anchors.follow.attached(r, 80);
		return { anchors, list, free };
	}

	it("D2: every correction 0, then a store move of two strokes and the group moved: the build remakes the members only", () => {
		// Defect: the store's own list leaves no base, so the release's build (the note's first) walks all 28k strokes.
		const { anchors, list, free } = zeroGroup();
		expect(anchors.strokesFor(PATH, list), "premise: every correction 0, the store's own list").toBe(list);
		const n = anchors.strokesForCounts, remade = n.remade ?? 0;
		let calls = 0;
		const real = anchors.shownOf.bind(anchors);
		anchors.shownOf = (s: InkStroke) => { calls++; return real(s); };
		translateStroke(free[3]!, 0, 2);
		translateStroke(free[17]!, 0, 2);
		anchors.follow.layoutChanged();
		anchors.follow.measure({ inView: () => true, refAt: () => ({ x: 0, y: 120 }), blockTop: () => 40 });
		const out = anchors.strokesFor(PATH, list);
		expect(out[0]!.bbox.y - list[0]!.bbox.y, "premise: the group shown 40 down").toBeCloseTo(40, 9);
		expect([calls <= 2, (n.remade ?? 0) - remade], "shownOf for the two moved only; remade the two members").toEqual([true, 2]);
		expect(out.slice(2).every((s, i) => s === free[i]), "the free strokes shown as themselves").toBe(true);
	});

	it("F1: freeFor across a store move in place: the same answer, no build; a member moved gives the same lists in a new map", () => {
		// Defect: every ink change rebuilds the free list and the member lists (row 9 release: 12 calls, 3.1 ms), and the
		// frontier and the group boxes kept per map are taken again.
		const { anchors, list, free } = zeroGroup();
		const a = anchors.freeFor(PATH, list);
		translateStroke(free[3]!, 0, 2);
		const b = anchors.freeFor(PATH, list);
		expect([b === a, b.free === a.free], "the same answer").toEqual([true, true]);
		expect(anchors.freeCounts.builds, "one build").toBe(1);
		translateStroke(list[0]!, 0, 2);
		const c = anchors.freeFor(PATH, list);
		expect([c.free === a.free, c.members !== a.members, c.members.get("att-1") === a.members.get("att-1")], "free list kept; a new map of the same lists").toEqual([true, true, true]);
		expect(anchors.freeCounts.builds, "still one build").toBe(1);
	});

	it("F2: an erase takes strokes out and puts pieces in: freeFor patches that window only, the lists a whole build gives", () => {
		// Defect: every erase sample rebuilds the free list over the whole note (scrub: 228 builds in 474 frames, 28k each).
		const { anchors, list } = zeroGroup();
		anchors.freeFor(PATH, list);
		const c = anchors.freeCounts, b0 = c.builds, w0 = c.whole;
		const ids = (xs: readonly InkStroke[]) => xs.map((s) => s.id);
		// A free stroke erased in two pieces, in the store's place of the stroke.
		list.splice(10, 1, strokeAt("p1", 130, 285), strokeAt("p2", 140, 285));
		bumpInkRevision();
		const a = anchors.freeFor(PATH, list);
		expect([c.builds - b0, c.patched, c.whole - w0, c.patchVisited <= 3], "one build, patched, no whole build, the window's strokes only").toEqual([1, 1, 0, true]);
		expect(ids(a.free), "the free list as a whole build gives it").toEqual(ids(list.filter((s) => s.id !== "s1" && s.id !== "s2")));
		// A member erased: its group's list loses it.
		list.splice(1, 1);
		bumpInkRevision();
		const m = anchors.freeFor(PATH, list);
		expect([c.patched, c.whole - w0, ids(m.members.get("att-1") ?? [])], "patched again; the group holds s1 only").toEqual([2, 0, ["s1"]]);
		expect(ids(m.free), "free strokes unchanged by a member's erase").toEqual(ids(a.free));
		// A member cut: its pieces join its group, in the store's place of the stroke; a new map, still a patch.
		const rec = anchors.follow.attachments[0] as AttachmentRecord;
		list.splice(0, 1, strokeAt("m1", 10, 85), strokeAt("m2", 14, 85));
		anchors.follow.setList([{ ...rec, strokeIds: ["m1", "m2"] }]);
		bumpInkRevision();
		const k = anchors.freeFor(PATH, list);
		// s2, erased above, still leaves its record here: in no list, so it is skipped, not a whole build.
		expect([c.patched, c.whole - w0, c.absentSkipped, ids(k.members.get("att-1") ?? [])], "patched by the new map; s2 skipped; the pieces in the group").toEqual([3, 0, 1, ["m1", "m2"]]);
		expect(ids(k.free), "free strokes unchanged by a member's cut").toEqual(ids(a.free));
		// An Attach of a stroke outside any changed window: a whole build, counted by its reason.
		anchors.follow.setList([{ ...rec, strokeIds: ["m1", "m2", "f20"] }]);
		bumpInkRevision();
		const w = anchors.freeFor(PATH, list);
		expect([c.whole - w0, c.wholeMapOutside, c.wholeWindowHalf, ids(w.members.get("att-1") ?? [])], "whole, map changed outside the window").toEqual([1, 1, 0, ["m1", "m2", "f20"]]);
	});

	it("F3: a member cut while another member outside the window leaves its group: a whole build, the lists a cold build gives", () => {
		// The changed id outside the window is still a stroke of the store (s2 detached, not erased), in its old group's
		// held list: skipping it would keep s2 in the group and out of the free list.
		const { anchors, list } = zeroGroup();
		anchors.freeFor(PATH, list);
		const c = anchors.freeCounts, w0 = c.whole, o0 = c.wholeMapOutside, s0 = c.absentSkipped;
		const ids = (xs: readonly InkStroke[]) => xs.map((s) => s.id);
		const rec = anchors.follow.attachments[0] as AttachmentRecord;
		list.splice(0, 1, strokeAt("m1", 10, 85), strokeAt("m2", 14, 85));
		anchors.follow.setList([{ ...rec, strokeIds: ["m1", "m2"] }]);
		bumpInkRevision();
		const k = anchors.freeFor(PATH, list);
		expect([list[2]!.id, c.whole - w0, c.wholeMapOutside - o0, c.absentSkipped - s0], "premise s2 after the window; one whole build for the map outside it, nothing skipped").toEqual(["s2", 1, 1, 0]);
		// A cold build by the new membership: every stroke not in a group is free, in store order; the group holds m1, m2.
		expect([ids(k.free), ids(k.members.get("att-1") ?? [])], "free and members as a cold build gives them").toEqual([ids(list.filter((s) => s.id !== "m1" && s.id !== "m2")), ["m1", "m2"]]);
	});
});

describe("the shown list visits the members and the anchored strokes only", () => {
	it("P1: a store move of 200 unanchored strokes beside a moved group: the build asks the follow for the members only, at their last index", () => {
		// Defect: a store move that changes most of the note (row 9 release: 23943 of 28358) makes strokesFor remake every
		// changed stroke, about 0.22 us each (noteStrokes 5.2 ms over no groups).
		const layout = (): LineLayout => ({ lines: doc.lines, lineText: (n) => doc.line(n).text, lineTop: (n) => (n - 1) * 40, pxPerWorld: 1 });
		const anchors = new LineAnchors(layout);
		anchors.setSignature(SIG);
		anchors.drawn(1, LINES);
		anchors.drawn(1, LINES, true, true);
		const members = [strokeAt("s1", 10, 85), strokeAt("s2", 40, 90)], kept = [strokeAt("a1", 10, 205), strokeAt("a2", 10, 245), strokeAt("a3", 10, 285)];
		for (const s of [...members, ...kept]) anchors.anchorNew(PATH, s);
		const loose = Array.from({ length: 200 }, (_, i) => strokeAt("u" + i, 10 + (i % 10) * 60, 325 + 4 * Math.floor(i / 10)));
		const list = [...members, ...loose.slice(0, 100), ...kept, ...loose.slice(100)];
		anchors.follow.setList([record()]);
		anchors.follow.measure({ inView: () => true, refAt: () => ({ x: 6, y: 92 }), blockTop: () => 80 });
		const first = anchors.strokesFor(PATH, list);
		expect([loose.every((s) => !s.lineAnchor), kept.every((s) => !!s.lineAnchor), Math.round(first[0]!.bbox.x - list[0]!.bbox.x)], "premise: 200 unanchored, 3 anchored, the group shown moved").toEqual([true, true, 6]);
		const n = anchors.strokesForCounts, v0 = n.visited ?? NaN, l0 = n.lookups ?? NaN;
		let asked = 0;
		const real = anchors.follow.shown.bind(anchors.follow);
		anchors.follow.shown = (s: InkStroke) => { asked++; return real(s); };
		for (const s of loose) translateStroke(s, 0, 2);
		const second = anchors.strokesFor(PATH, list);
		expect([asked, (n.visited ?? NaN) - v0, (n.lookups ?? NaN) - l0], "[follow asked, visited, member lookups]: the two members; the 2 members (no anchored stroke at a correction); none").toEqual([2, 2, 0]);
		expect(second.map((s) => s.id), "the store order").toEqual(list.map((s) => s.id));
		expect([Math.round(second[0]!.bbox.x - list[0]!.bbox.x), Math.round(second[1]!.bbox.x - list[1]!.bbox.x)], "the members shown moved").toEqual([6, 6]);
		expect(second.filter((s, i) => i > 1 && s !== list[i]).map((s) => s.id), "every other stroke shown as itself").toEqual([]);
	});
});

describe("the anchored patch visits the strokes at a nonzero correction only", () => {
	it("P2: two of four anchored strokes corrected, 200 unanchored moved in the store: the build visits the two; a new layout reads all four again", () => {
		// Defect: the patch reads every anchored stroke on every build (row 9 release: 6429 anchored, list build 1.2 ms over).
		const state = { from: 20, shift: 40 };
		const layout = (): LineLayout => ({ lines: doc.lines, lineText: (n) => doc.line(n).text, lineTop: (n) => (n - 1) * 40 + (n >= state.from ? state.shift : 0), pxPerWorld: 1 });
		const anchors = new LineAnchors(layout);
		anchors.setSignature(SIG);
		anchors.drawn(1, LINES);
		anchors.drawn(1, LINES, true, true);
		const kept = [strokeAt("a1", 10, 85), strokeAt("a2", 10, 165), strokeAt("a3", 10, 845), strokeAt("a4", 10, 925)];
		state.shift = 0;
		for (const s of kept) anchors.anchorNew(PATH, s);
		const loose = Array.from({ length: 200 }, (_, i) => strokeAt("u" + i, 300 + (i % 10) * 20, 325 + 4 * Math.floor(i / 10)));
		const list = [kept[0]!, kept[1]!, ...loose.slice(0, 100), kept[2]!, ...loose.slice(100), kept[3]!];
		state.shift = 40;
		anchors.layoutChanged(PATH, list, "measure");
		const first = anchors.strokesFor(PATH, list);
		const dy = (out: readonly InkStroke[], id: string) => Math.round(out.find((s) => s.id === id)!.bbox.y - list.find((s) => s.id === id)!.bbox.y);
		expect(kept.map((s) => dy(first, s.id)), "premise: a3 and a4 shown 40 down, a1 and a2 at no correction").toEqual([0, 0, 40, 40]);
		const n = anchors.strokesForCounts, v0 = n.visited ?? NaN;
		for (const s of loose) translateStroke(s, 0, 2);
		const second = anchors.strokesFor(PATH, list);
		expect((n.visited ?? NaN) - v0, "visited: the two corrected only").toBe(2);
		expect([second.map((s) => s.id), kept.map((s) => dy(second, s.id))], "the store order, the corrections held").toEqual([list.map((s) => s.id), [0, 0, 40, 40]]);
		expect(second.filter((s) => !kept.some((k) => k.id === s.id) && s !== list.find((x) => x.id === s.id)).length, "every unanchored stroke shown as itself").toBe(0);
		state.from = 4;
		anchors.layoutChanged(PATH, list, "measure");
		const v1 = n.visited ?? NaN, third = anchors.strokesFor(PATH, list);
		expect([(n.visited ?? NaN) - v1, kept.map((s) => dy(third, s.id))], "a new layout read by readAgain: the build visits the three corrected, a2 now shown 40 down too").toEqual([3, [0, 40, 40, 40]]);
	});
});
