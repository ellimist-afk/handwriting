/**
 * Bringing an anchor up to the log head (LineAnchor.ts resolve) asks whether its stroke is a carried member, or a member
 * anchored from a measure, only for a logged change that can move the anchor: one that adds height above its line. A letter
 * typed on a line above anchored ink, with no wrap, adds none, so a measure's walk of every anchored stroke reads neither.
 * At a layout scale other than 1 on fractional line tops, the height an unchanged line logs is float noise (a top over the
 * scale less a height over the scale), so ink below the letter may still read them; ink above it never does.
 *
 * Bare surfaces over one store list and one layout, as LineAnchorMemberCarry.test.ts builds them; no DOM. The lookups are
 * counted per stroke while resolve runs, on every surface: reads of the follow's member map, and reads of the module's
 * carried map, found by identity as the one map a carry writes a member's new anchor into.
 */
import { describe, expect, it } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { AttachFollow } from "./AttachFollow";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { targetAt, type AttachmentData, type AttachmentRecord } from "./InkAttachments";

const SIG = { width: 892, fontPx: 26, charWidth: 14 };
const LH = 40;
const ID = "lookup-group";

/** Every line LH tall (world units), plus `extra` on every line from `from` down. */
const topOf = (from: number, extra: number) => (n: number) => (n - 1) * LH + (n >= from ? extra : 0);

/** The layout in editor px: world tops times `px`, as CodeMirror reports them at a scale and font zoom. */
const layoutOf = (doc: Text, top = topOf(1, 0), px = 1): LineLayout => ({ lines: doc.lines, lineText: (n) => doc.line(n).text, lineTop: (n) => top(n) * px, pxPerWorld: px });

const view = (doc: Text, top = topOf(1, 0)) => ({
	inView: () => true,
	refAt: (pos: number) => ({ x: 0, y: top(doc.lineAt(pos).number) }),
	blockTop: (pos: number) => top(doc.lineAt(pos).number),
});

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

const lines = (n: number) => Text.of(Array.from({ length: n }, (_, i) => `line ${i + 1} words`));

type Pane = { doc: Text; st: { layout: LineLayout }; a: LineAnchors; src: InkStroke[]; list: readonly AttachmentData[]; px: number };

/** One pane on an `n`-line note at `px`, measured through `measuredTo`; a group on line `groupLine`'s paragraph lists `members`. */
function onePane(path: string, n: number, measuredTo: number, strokes: InkStroke[], members: string[], groupLine: number, px = 1, top = topOf(1, 0)): Pane {
	const doc = lines(n);
	const st = { layout: layoutOf(doc, top, px) };
	const a = new LineAnchors(() => st.layout, () => true);
	const src: InkStroke[] = [];
	a.setSignature(SIG);
	a.tracks(path, src);
	a.drawn(1, measuredTo);
	a.drawn(1, measuredTo, true, true);
	for (const s of strokes) {
		src.push(s);
		a.anchorNew(path, s);
	}
	a.layoutChanged(path, src, "measure");
	const line = doc.line(groupLine), m0 = strokes.find((s) => s.id === members[0])!;
	const rec: AttachmentRecord = {
		v: 1, id: ID, strokeIds: members, target: targetAt(doc.toString(), line.from, line.to, "paragraph"),
		ref: { x: 0, y: (groupLine - 1) * LH }, layout: { width: SIG.width, font: SIG.fontPx }, probe: { id: m0.id, x: m0.points[0]!.x, y: m0.points[0]!.y },
	};
	a.follow.setList([rec]);
	a.follow.measure(view(doc, top));
	return { doc, st, a, src, list: [rec], px };
}

/** `insert` typed at line `at`'s end, then followDocChanged's retakeMembers with the snapshot. The layout keeps every line LH. */
function type(path: string, p: Pane, at: number, insert: string, top = topOf(1, 0)) {
	const { doc, st, a, src } = p;
	const changes = ChangeSet.of({ from: doc.line(at).to, insert }, doc.length);
	const after = changes.apply(doc);
	p.doc = after;
	st.layout = layoutOf(after, top, p.px);
	a.docChanged(path, src, doc, changes, after);
	const snap = a.follow.snapshot();
	const mapped = a.follow.docChanged(changes, view(after, top).blockTop, 1);
	const edit = a.follow.takeEdited();
	a.shareAttachments(mapped);
	p.list = mapped;
	if (edit) a.retakeMembers(path, src, snap);
	return { edit, windowOpen: a.windowOpen };
}

/** The measure after the typing: every line drawn and measured where it is, the window closed; then the log folded. */
function measureAll(path: string, p: Pane): void {
	p.a.drawn(1, p.doc.lines);
	p.a.drawn(1, p.doc.lines, true, true);
	p.a.follow.layoutChanged();
	p.a.layoutChanged(path, p.src, "measure");
	p.a.fold();
}

/** The surface's shift log: each entry's kind, and an edit's lines, shift and grown height. */
const logOf = (a: LineAnchors) =>
	((a as unknown as { log: { kind: string; first?: number; last?: number; shift?: number; grew?: number }[] }).log).map((e) =>
		e.kind === "measure" ? { kind: e.kind } : { kind: e.kind, first: e.first, last: e.last, shift: e.shift, grew: e.grew, grewIsPlusZero: Object.is(e.grew, 0) });

const wmGet = WeakMap.prototype.get, wmSet = WeakMap.prototype.set;
let carriedFound: WeakMap<object, unknown> | null = null;

/**
 * The module's carried map, by identity: a carry (a short note, a rebase window open, an Enter above a group) writes each
 * moved member's new anchor into exactly one WeakMap, keyed by the stroke. Found once; the map is the module's own.
 */
function carriedMap(): WeakMap<object, unknown> {
	if (carriedFound) return carriedFound;
	const path = "find-carried.md", ids = ["c1", "c2"];
	const p = onePane(path, 20, 20, [strokeAt("c1", 10, 7 * LH + 5), strokeAt("c2", 40, 9 * LH + 5)], ids, 10);
	const seen: { map: WeakMap<object, unknown>; key: object; value: unknown }[] = [];
	WeakMap.prototype.set = function (this: WeakMap<object, unknown>, key: object, value: unknown) {
		seen.push({ map: this, key, value });
		return wmSet.call(this, key, value) as WeakMap<object, unknown>;
	};
	try {
		type(path, p, 5, "\n");
	} finally {
		WeakMap.prototype.set = wmSet;
	}
	const members = p.src.filter((s) => ids.includes(s.id));
	const maps = [...new Set(seen.filter((x) => members.some((s) => x.key === s && x.value === s.lineAnchor)).map((x) => x.map))];
	expect(maps.length, `premise: a carry writes each member's new anchor into one map, ${maps.length} found`).toBe(1);
	expect(members.every((s) => wmGet.call(maps[0]!, s) === s.lineAnchor), "premise: the map holds every carried member's anchor").toBe(true);
	carriedFound = maps[0]!;
	return carriedFound;
}

type Count = { resolved: number; carriedGets: number; memberMapReads: number };

/** Runs `run`, counting per stroke id, on every surface: resolve calls, and the carried map and member map reads inside them. */
function countLookups(run: () => void): Record<string, Count> {
	const carried = carriedMap();
	const proto = LineAnchors.prototype as unknown as { resolve: (s: InkStroke) => void };
	const resolve = proto.resolve;
	const desc = Object.getOwnPropertyDescriptor(AttachFollow.prototype, "memberMap")!;
	const out: Record<string, Count> = {};
	let cur: Count | null = null;
	proto.resolve = function (this: LineAnchors, s: InkStroke) {
		const was = cur;
		cur = out[s.id] ??= { resolved: 0, carriedGets: 0, memberMapReads: 0 };
		cur.resolved++;
		try {
			resolve.call(this, s);
		} finally {
			cur = was;
		}
	};
	WeakMap.prototype.get = function (this: WeakMap<object, unknown>, key: object) {
		if (cur && this === carried) cur.carriedGets++;
		return wmGet.call(this, key);
	};
	Object.defineProperty(AttachFollow.prototype, "memberMap", {
		configurable: true,
		get(this: AttachFollow) {
			if (cur) cur.memberMapReads++;
			return desc.get!.call(this);
		},
	});
	try {
		run();
	} finally {
		proto.resolve = resolve;
		WeakMap.prototype.get = wmGet;
		Object.defineProperty(AttachFollow.prototype, "memberMap", desc);
	}
	return out;
}

const anchorsOf = (p: Pane) => p.src.map((s) => (s.lineAnchor ? { id: s.id, line: s.lineAnchor.line, top: s.lineAnchor.top, above: s.lineAnchor.above ?? null } : { id: s.id, absent: true }));
/** Every field of every anchor; toEqual compares numbers by Object.is, so -0 against +0 and the last bit both count. */
const fullAnchorsOf = (p: Pane) => p.src.map((s) => ({ id: s.id, ...(s.lineAnchor ?? { absent: true }) }));
/** JSON with a -0 written "-0", for a print. */
const exact = (x: unknown) => JSON.stringify(x, (_k, v: unknown) => (Object.is(v, -0) ? "-0" : v));
const isCarried = (p: Pane, id: string) => {
	const s = p.src.find((x) => x.id === id)!;
	return s.lineAnchor !== undefined && wmGet.call(carriedMap(), s) === s.lineAnchor;
};
const lookupsOf = (c: Record<string, Count>, ids: string[]) => ids.map((id) => ({ id, carriedGets: c[id]?.carriedGets ?? 0, memberMapReads: c[id]?.memberMapReads ?? 0 }));
const resolvedOf = (c: Record<string, Count>, ids: string[]) => ids.map((id) => c[id]?.resolved ?? 0);

/** Every anchor field each cell ends with, printed by the same cells on the code before this change (8d3a52f6). */
const W = { width: 892, fontPx: 26 };
const BASE = {
	px125: [
		{ id: "free-above", line: 3, top: 81.48, y: 87, key: 1494710355, ...W, above: 641265282 },
		{ id: "member-above", line: 6, top: 200.37, y: 207, key: 1538008172, ...W, above: 308677228 },
		{ id: "free-on", line: 10, top: 361.48, y: 367, key: 3510415511, ...W, above: 2156715014 },
		{ id: "member-below", line: 20, top: 760.37, y: 767, key: 1461244882, ...W, above: 215637435 },
		{ id: "free-below", line: 30, top: 1161.85, y: 1167, key: 451462559, ...W, above: 355098574 },
	],
	px125Line2Walk: [
		{ id: "on", line: 2, top: 41.85, y: 47, key: 1948916600, ...W, above: 191566418 },
		{ id: "f1", line: 3, top: 81.47999999999999, y: 87, key: 1494710355, ...W, above: 2155382826 },
		{ id: "m1", line: 3, top: 81.47999999999999, y: 91, key: 1494710355, ...W, above: 2155382826 },
		{ id: "f2", line: 4, top: 121.10999999999999, y: 127, key: 3073749038, ...W, above: 1372551005 },
		{ id: "m2", line: 5, top: 160.74, y: 167, key: 3383925385, ...W, above: 1645030523 },
		{ id: "f9", line: 10, top: 361.48, y: 367, key: 2913666837, ...W, above: 3854356014 },
	],
	px125Line2Enter: [
		{ id: "on", line: 2, top: 41.85, y: 47, key: 1948916600, ...W, above: 191566418 },
		{ id: "f1", line: 3, top: 81.48, y: 87, key: 2166136261, ...W, above: 2155382826 },
		{ id: "m1", line: 4, top: 81.47999999999999, y: 91, key: 1494710355, ...W, above: 2043976911 },
		{ id: "f2", line: 4, top: 121.10999999999999, y: 127, key: 1494710355, ...W, above: 2043976911 },
		{ id: "m2", line: 6, top: 160.74, y: 167, key: 3383925385, ...W, above: 631405312 },
		{ id: "f9", line: 10, top: 361.48, y: 367, key: 2673539493, ...W, above: 2229552286 },
	],
	letter: [
		{ id: "free-above", line: 3, top: 80, y: 87, key: 1494710355, ...W, above: 641265282 },
		{ id: "free-on", line: 10, top: 360, y: 367, key: 3510415511, ...W, above: 2156715014 },
		{ id: "member-on", line: 10, top: 360, y: 371, key: 3510415511, ...W, above: 2156715014 },
		{ id: "member-below", line: 20, top: 760, y: 767, key: 1461244882, ...W, above: 215637435 },
		{ id: "free-below", line: 30, top: 1160, y: 1167, key: 451462559, ...W, above: 355098574 },
	],
	panes: [
		{ id: "free-above", line: 3, top: 80, y: 87, key: 1494710355, ...W },
		{ id: "member-on", line: 10, top: 360, y: 371, key: 3510415511, ...W, above: 2156715014 },
		{ id: "member-below", line: 20, top: 760, y: 767, key: 1461244882, ...W },
		{ id: "free-below", line: 30, top: 1160, y: 1167, key: 451462559, ...W },
	],
	carried: [
		{ id: "m1", line: 9, top: 280, y: 287, key: 1559735466, ...W, above: 2995374234 },
		{ id: "m2", line: 11, top: 360, y: 367, key: 2913666837, ...W, above: 237465481 },
		{ id: "free-below", line: 16, top: 600, y: 567, key: 1172800486, ...W, above: 4229750108 },
	],
	controlFirst: [
		{ id: "free-above", line: 3, top: 80, y: 87, key: 1494710355, ...W },
		{ id: "m1", line: 9, top: 280, y: 287, key: 1559735466, ...W },
		{ id: "m2", line: 11, top: 360, y: 367, key: 2913666837, ...W },
		{ id: "free-below", line: 16, top: 600, y: 567, key: 1172800486, ...W },
	],
	controlEnd: [
		{ id: "free-above", line: 3, top: 80, y: 87, key: 1494710355, ...W, above: 641265282 },
		{ id: "m1", line: 10, top: 280, y: 287, key: 1559735466, ...W, above: 945427889 },
		{ id: "m2", line: 12, top: 360, y: 367, key: 2913666837, ...W, above: 3945593152 },
		{ id: "free-below", line: 17, top: 640, y: 567, key: 1172800486, ...W, above: 1915198755 },
	],
};

describe("resolve's lookups on a letter typed above anchored ink", () => {
	it("at px 1.25 on fractional line tops, a letter typed on line 10, no wrap: ink above it makes no lookup, every anchor is as at the base, and the lookups below are printed", () => {
		const path = "letter-px-125.md", px = 1.25;
		// Fractional tops as CodeMirror measures them: a line LH plus up to 2.22 world units, by line.
		const top = (n: number) => (n - 1) * LH + ((n * 13) % 7) * 0.37;
		const ids = ["free-above", "member-above", "free-on", "member-below", "free-below"];
		const p = onePane(path, 40, 40, [strokeAt(ids[0]!, 10, 2 * LH + 5), strokeAt(ids[1]!, 10, 5 * LH + 5), strokeAt(ids[2]!, 300, 9 * LH + 5), strokeAt(ids[3]!, 40, 19 * LH + 5), strokeAt(ids[4]!, 70, 29 * LH + 5)], [ids[1]!, ids[3]!], 6, px, top);
		const logBefore = logOf(p.a).length;
		type(path, p, 10, "x", top);
		const log = logOf(p.a).slice(logBefore);
		const c = countLookups(() => {
			p.a.boxLines(path, p.src, 1, p.doc.lines);
			p.a.fold();
		});
		const now = fullAnchorsOf(p);
		const info = exact({ log, c, now });
		// Printed, with no bar: at this scale the height an unchanged line logs is float noise, so ink below may still look up.
		console.log(`PX-1.25 lookups on and below the line ${JSON.stringify(lookupsOf(c, ids.slice(2)))}`);
		expect(log.map((x) => [x.kind, x.shift, x.grewIsPlusZero, Math.abs(x.grew ?? 1) < 1e-9]), `premise: the letter logged one edit, no line added, its height float noise ${info}`).toEqual([["edit", 0, false, true]]);
		expect(resolvedOf(c, ids).every((n) => n >= 1), `premise: the walk resolved every stroke ${info}`).toBe(true);
		expect(lookupsOf(c, ids.slice(0, 2)), `no carried or member lookup for ink above the letter ${info}`).toEqual(ids.slice(0, 2).map((id) => ({ id, carriedGets: 0, memberMapReads: 0 })));
		expect(now, `every anchor field as at the base ${info}`).toEqual(BASE.px125);
	});

	it("at px 1.25 on fractional line tops, a letter typed on line 2 with ink just below it at small tops: every anchor field as at the base after the walk and the fold, and again after an Enter on that line", () => {
		const path = "letter-px-125-line-2.md", px = 1.25;
		const top = (n: number) => (n - 1) * LH + ((n * 13) % 7) * 0.37;
		const y = (n: number) => (n - 1) * LH + 5;
		// Near the top of the note, a float-noise height is not lost in the sum, so skipping it or adding it can change a top's last bit.
		const ss = [strokeAt("on", 300, y(2)), strokeAt("f1", 10, y(3)), strokeAt("m1", 40, y(3) + 4), strokeAt("f2", 70, y(4)), strokeAt("m2", 100, y(5)), strokeAt("f9", 130, y(10))];
		const p = onePane(path, 30, 30, ss, ["m1", "m2"], 3, px, top);
		const logBefore = logOf(p.a).length;
		type(path, p, 2, "x", top);
		const log = logOf(p.a).slice(logBefore);
		p.a.boxLines(path, p.src, 1, p.doc.lines);
		p.a.fold();
		const walk = fullAnchorsOf(p);
		const e = type(path, p, 2, "\n", top);
		p.a.boxLines(path, p.src, 1, p.doc.lines);
		p.a.fold();
		const enter = fullAnchorsOf(p), carried = ["m1", "m2"].map((id) => isCarried(p, id));
		const info = exact({ log, walk, e, carried, enter });
		expect(log.map((x) => [x.kind, x.shift, x.grewIsPlusZero, Math.abs(x.grew ?? 1) < 1e-9]), `premise: the letter logged one edit, no line added, its height float noise ${info}`).toEqual([["edit", 0, false, true]]);
		expect([e.windowOpen, carried], `premise: the Enter carried both members ${info}`).toEqual([true, [true, true]]);
		expect({ walk, enter }, `every anchor field as at the base ${info}`).toEqual({ walk: BASE.px125Line2Walk, enter: BASE.px125Line2Enter });
	});

	it("a letter typed on line 10, no wrap: the measure's walk and the fold look up no stroke, free or member, above, on or below the line", () => {
		const path = "letter-one-pane.md";
		const ids = ["free-above", "free-on", "member-on", "member-below", "free-below"];
		const p = onePane(path, 40, 40, [strokeAt(ids[0]!, 10, 2 * LH + 5), strokeAt(ids[1]!, 300, 9 * LH + 5), strokeAt(ids[2]!, 10, 9 * LH + 9), strokeAt(ids[3]!, 40, 19 * LH + 5), strokeAt(ids[4]!, 70, 29 * LH + 5)], [ids[2]!, ids[3]!], 10);
		const was = anchorsOf(p), logBefore = logOf(p.a).length;
		const e = type(path, p, 10, "x");
		const log = logOf(p.a).slice(logBefore);
		const c = countLookups(() => {
			p.a.boxLines(path, p.src, 1, p.doc.lines);
			p.a.fold();
		});
		const info = JSON.stringify({ e, log, c, was, now: anchorsOf(p) });
		expect(log.map((x) => [x.kind, x.shift, x.grewIsPlusZero]), `premise: the letter logged one edit, no line added, no height grown ${info}`).toEqual([["edit", 0, true]]);
		expect(resolvedOf(c, ids).every((n) => n >= 1), `premise: the walk resolved every stroke ${info}`).toBe(true);
		expect(lookupsOf(c, ids), `no carried or member lookup for any stroke ${info}`).toEqual(ids.map((id) => ({ id, carriedGets: 0, memberMapReads: 0 })));
		expect(fullAnchorsOf(p), `every anchor field as at the base ${exact(fullAnchorsOf(p))}`).toEqual(BASE.letter);
	});

	it("two panes: the other pane's walk resolves the typing pane's anchors with no lookup", () => {
		const path = "letter-two-panes.md";
		const ids = ["free-above", "member-on", "member-below", "free-below"];
		const p = onePane(path, 40, 40, [strokeAt(ids[0]!, 10, 2 * LH + 5), strokeAt(ids[1]!, 10, 9 * LH + 9), strokeAt(ids[2]!, 40, 19 * LH + 5), strokeAt(ids[3]!, 70, 29 * LH + 5)], [ids[1]!, ids[2]!], 10);
		const b = new LineAnchors(() => p.st.layout, () => false);
		b.setSignature(SIG);
		b.tracks(path, p.src);
		b.drawn(1, p.doc.lines);
		b.drawn(1, p.doc.lines, true, true);
		b.layoutChanged(path, p.src, "measure");
		b.follow.setList(p.list);
		b.follow.measure(view(p.doc));
		type(path, p, 10, "x");
		const logA = logOf(p.a), logB = logOf(b);
		const c = countLookups(() => b.boxLines(path, p.src, 1, p.doc.lines));
		const info = JSON.stringify({ logA, logB, c });
		expect([logA.length > 0, logB.length], `premise: the typing pane holds the letter's entry, the other pane none ${info}`).toEqual([true, 0]);
		expect(resolvedOf(c, ids).every((n) => n >= 2), `premise: each stroke resolved on both panes ${info}`).toBe(true);
		expect(lookupsOf(c, ids), `no carried or member lookup for any stroke ${info}`).toEqual(ids.map((id) => ({ id, carriedGets: 0, memberMapReads: 0 })));
		expect(fullAnchorsOf(p), `every anchor field as at the base ${exact(fullAnchorsOf(p))}`).toEqual(BASE.panes);
	});

	it("carried members: a letter typed above them, then the walk and the fold: no lookup", () => {
		const path = "letter-carried.md";
		const ids = ["m1", "m2", "free-below"];
		const p = onePane(path, 20, 20, [strokeAt("m1", 10, 7 * LH + 5), strokeAt("m2", 40, 9 * LH + 5), strokeAt("free-below", 70, 14 * LH + 5)], ["m1", "m2"], 10);
		const e = type(path, p, 5, "\n");
		measureAll(path, p);
		const carriedNow = ["m1", "m2"].map((id) => isCarried(p, id)), logBefore = logOf(p.a).length;
		type(path, p, 3, "x");
		const log = logOf(p.a).slice(logBefore);
		const c = countLookups(() => {
			p.a.boxLines(path, p.src, 1, p.doc.lines);
			p.a.fold();
		});
		const info = JSON.stringify({ e, carriedNow, log, c, now: anchorsOf(p) });
		expect([e.windowOpen, carriedNow], `premise: the Enter carried both members, still carried after the measure ${info}`).toEqual([true, [true, true]]);
		expect(log.map((x) => [x.kind, x.shift, x.grewIsPlusZero]), `premise: the letter logged one edit, no height ${info}`).toEqual([["edit", 0, true]]);
		expect(resolvedOf(c, ids).every((n) => n >= 1), `premise: the walk resolved every stroke ${info}`).toBe(true);
		expect(lookupsOf(c, ids), `no carried or member lookup ${info}`).toEqual(ids.map((id) => ({ id, carriedGets: 0, memberMapReads: 0 })));
		expect(fullAnchorsOf(p), `every anchor field as at the base ${exact(fullAnchorsOf(p))}`).toEqual(BASE.carried);
	});

	it("control: an Enter above: an uncarried member and free ink below look up, ink above does not; then carried members read the carried map, not the member map; every anchor as at the base", () => {
		const path = "enter-control.md";
		const ids = ["free-above", "m1", "m2", "free-below"];
		const p = onePane(path, 20, 20, [strokeAt("free-above", 10, 2 * LH + 5), strokeAt("m1", 10, 7 * LH + 5), strokeAt("m2", 40, 9 * LH + 5), strokeAt("free-below", 70, 14 * LH + 5)], ["m1", "m2"], 10);
		const first = countLookups(() => {
			type(path, p, 5, "\n");
			p.a.boxLines(path, p.src, 1, p.doc.lines);
		});
		const afterFirst = anchorsOf(p), afterFirstFull = fullAnchorsOf(p);
		measureAll(path, p);
		const carriedNow = ["m1", "m2"].map((id) => isCarried(p, id));
		const second = countLookups(() => {
			type(path, p, 4, "\n");
			p.a.boxLines(path, p.src, 1, p.doc.lines);
			p.a.fold();
		});
		const end = anchorsOf(p), endFull = fullAnchorsOf(p);
		const info = JSON.stringify({ first, afterFirst, carriedNow, second, end });
		console.log(`ENTER-CONTROL ${info}`);
		expect(carriedNow, `premise: the first Enter carried both members ${info}`).toEqual([true, true]);
		expect([resolvedOf(first, ids), resolvedOf(second, ids)].flat().every((n) => n >= 1), `premise: each Enter's walk resolved every stroke ${info}`).toBe(true);
		const f = lookupsOf(first, ids), s = lookupsOf(second, ids);
		expect(f[0], `first Enter: no lookup for ink above it ${info}`).toEqual({ id: "free-above", carriedGets: 0, memberMapReads: 0 });
		expect(f.slice(1).map((x) => x.carriedGets >= 1 && x.memberMapReads >= 1), `first Enter: each stroke below it, not yet carried, reads both maps ${info}`).toEqual([true, true, true]);
		expect(s[0], `second Enter: no lookup for ink above it ${info}`).toEqual({ id: "free-above", carriedGets: 0, memberMapReads: 0 });
		expect(s.slice(1, 3).map((x) => x.carriedGets >= 1 && x.memberMapReads === 0), `second Enter: each carried member reads the carried map, not the member map ${info}`).toEqual([true, true]);
		expect(s[3]!.carriedGets >= 1 && s[3]!.memberMapReads >= 1, `second Enter: free ink below reads both ${info}`).toBe(true);
		expect({ afterFirst: afterFirstFull, end: endFull }, `every anchor field as at the base ${exact({ afterFirstFull, endFull })}`).toEqual({ afterFirst: BASE.controlFirst, end: BASE.controlEnd });
	});

	it("-0: below a letter, an uncarried anchor's top of -0 comes out +0, as at the base; a carried member's -0 stays -0", () => {
		const path = "letter-minus-zero.md";
		const p = onePane(path, 20, 20, [strokeAt("m1", 10, 7 * LH + 5), strokeAt("m2", 40, 9 * LH + 5), strokeAt("free-below", 70, 14 * LH + 5)], ["m1", "m2"], 10);
		type(path, p, 5, "\n");
		measureAll(path, p);
		const s = (id: string) => p.src.find((x) => x.id === id)!;
		const carriedNow = isCarried(p, "m1");
		s("m1").lineAnchor!.top = -0;
		s("free-below").lineAnchor!.top = -0;
		const logBefore = logOf(p.a).length;
		type(path, p, 3, "x");
		const log = logOf(p.a).slice(logBefore);
		p.a.boxLines(path, p.src, 1, p.doc.lines);
		const tops = { m1: Object.is(s("m1").lineAnchor?.top, -0) ? "-0" : String(s("m1").lineAnchor?.top), free: Object.is(s("free-below").lineAnchor?.top, -0) ? "-0" : String(s("free-below").lineAnchor?.top) };
		const info = JSON.stringify({ carriedNow, log, tops });
		expect([carriedNow, log.map((x) => [x.kind, x.shift, x.grewIsPlusZero])], `premise: m1 carried; the letter logged one edit, no height ${info}`).toEqual([true, [["edit", 0, true]]]);
		expect(tops, `the tops after the walk ${info}`).toEqual({ m1: "-0", free: "0" });
	});
});
