/**
 * When a text change or a read moves attached groups, each moved group's members whose anchors no longer show the group's
 * move are anchored again (retakeMembers). That reaches the moved groups' members by id: a keystroke on a long note reads
 * those members, not every stroke of the note.
 *
 * The guard: a script of edits and reads (a letter, Enter above a group, a wrap, an unwrap, a width change, a first read
 * in a pane opened afresh, and the same edits with the note in two panes) runs over a note with a group that moves, a
 * group that does not (one script gives it a member anchored on the line below its word, the line an Enter moves), members
 * whose anchors are taken again and free anchored ink. After each step every stroke's line anchor, each pane's vouch and
 * stamp for it, every count retakeMembers answered and how many anchors each call replaced or cleared are compared with a
 * record taken from the build before the change (test/fixtures/retake-members-64d938be.json). HW_RETAKE_RECORD=<file>
 * writes that record instead of comparing.
 *
 * The rig is a bare overlay over a fake view, as in AttachRangeTarget.test.ts: every character CW world px wide, rows LH
 * high, each line word-wrapped at a column count the cell may change (a pane width change). A text change runs as the
 * editor runs it: the anchors hear it, then the follow; the changed lines are drawn; one measure cycle; then the measure
 * loop's update marks the lines it read.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { ChangeSet, Text } from "@codemirror/state";
import { BlockType, type ViewUpdate } from "@codemirror/view";
import { InkOverlayPlugin } from "./InkOverlay";
import { inlineInk } from "./InkOverlayRegistry";
import { LineAnchors, strokeById, type LineLayout } from "./LineAnchor";
import { emptyPage } from "../model/PageData";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { bumpInkListRevision } from "../ink/StrokeRev";
import { SelectionModel } from "../objects/SelectionModel";
import type { AttachmentRecord } from "./InkAttachments";
import type { FollowSnapshot } from "./AttachFollow";

declare const process: { env: Record<string, string | undefined> };

const CW = 14, LH = 40, FH = 26, COLS = 30, NARROW = 20;
const LINES = ["a first line at the top", "the quick brown fox jumps", "a second plain line", "third line here", "fifth line down here"];
const RECORD = "test/fixtures/retake-members-64d938be.json";

/** The rows of one line wrapped at `cols`: [start, end) offsets, a row's trailing spaces kept on it. */
function rowsOf(text: string, cols: number): { start: number; end: number }[] {
	const rows: { start: number; end: number }[] = [];
	let start = 0;
	for (const m of text.matchAll(/\S+\s*/g)) {
		const at = m.index!, len = m[0].trimEnd().length;
		if (at > start && at - start + len > cols) {
			rows.push({ start, end: at });
			start = at;
		}
	}
	rows.push({ start, end: text.length });
	return rows;
}

/** A stroke through the given points, its box computed. */
function strokeOf(id: string, pts: [number, number][]): InkStroke {
	const points = pts.map(([x, y], i) => ({ x, y, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

/** A loop around [x0, x1] x [y0, y1]. */
const loop = (id: string, x0: number, x1: number, y0: number, y1: number) =>
	strokeOf(id, [[x0, (y0 + y1) / 2], [(x0 + x1) / 2, y0], [x1, (y0 + y1) / 2], [(x0 + x1) / 2, y1], [x0 + 2, (y0 + y1) / 2]]);

/** World x of column `c`. */
const X = (c: number) => c * CW;
const FIRST = LINES[0]!.indexOf("first"), FOX = LINES[1]!.indexOf("fox");

/** The note's ink: group B's two members on "first" (line 1), group A's two on "fox" (line 2), free ink on lines 3 and 5. */
function noteInk(): InkStroke[] {
	return [
		loop("b1", X(FIRST) - 4, X(FIRST + 5) + 4, 4, 36),
		strokeOf("b2", [[X(FIRST), 31], [X(FIRST + 5), 33]]),
		loop("a1", X(FOX) - 4, X(FOX + 3) + 4, LH + 4, LH + 36),
		strokeOf("a2", [[X(FOX), LH + 31], [X(FOX + 3), LH + 33]]),
		strokeOf("f1", [[X(1), 2 * LH + 10], [X(6), 2 * LH + 22]]),
		strokeOf("f2", [[X(2), 4 * LH + 8], [X(9), 4 * LH + 24]]),
	];
}

/** The store's record for `path`, emptied and given `strokes`. */
function freshNote(path: string, strokes: InkStroke[]): void {
	const rec = inlineInk.record(path);
	rec.pageId = `page-${path}`;
	rec.basePage = { ...emptyPage(rec.pageId), attachments: [] };
	rec.attachments = undefined as unknown as typeof rec.attachments;
	rec.strokes = strokes;
	Object.defineProperty(inlineInk, "persist", { value: () => {}, configurable: true });
}

type Pane = ReturnType<typeof pane>;

/**
 * One pane on `path`: its own document copy, anchors, follow and measure queue; the store shared. `lines` is the text the
 * pane opens on, `focused` whether its editor has focus (of two panes, that one writes its changes).
 */
function pane(path: string, lines: readonly string[], focused = true) {
	const state = { doc: Text.of([...lines]) };
	let cols = COLS;
	const rowsAt = (n: number) => rowsOf(state.doc.line(n).text, cols);
	const heightOf = (n: number) => rowsAt(n).length * LH;
	const topOf = (n: number) => {
		let top = 0;
		for (let i = 1; i < n; i++) top += heightOf(i);
		return top;
	};
	const blockOf = (n: number) => {
		const line = state.doc.line(n), top = topOf(n);
		return { from: line.from, to: line.to, top, bottom: top + heightOf(n), height: heightOf(n), type: BlockType.Text };
	};
	const layout = (): LineLayout => ({ lines: state.doc.lines, lineText: (n) => state.doc.line(n).text, lineTop: (n) => topOf(n), pxPerWorld: 1 });
	const anchors = new LineAnchors(layout, () => focused);
	anchors.setSignature({ width: cols * CW, fontPx: 26, charWidth: CW });
	anchors.drawn(1, state.doc.lines);
	anchors.drawn(1, state.doc.lines, true, true);
	const selection = new SelectionModel();
	const noop = () => {};
	const queue: { key?: unknown; read: () => unknown; write: (m: unknown) => void }[] = [];
	const view = {
		scaleY: 1,
		defaultLineHeight: LH,
		state,
		get viewport() { return { from: 0, to: state.doc.length }; },
		lineBlockAt: (pos: number) => blockOf(state.doc.lineAt(pos).number),
		lineBlockAtHeight: (h: number) => {
			for (let n = 1; n <= state.doc.lines; n++) if (h < blockOf(n).bottom || n === state.doc.lines) return blockOf(n);
			return blockOf(1);
		},
		coordsAtPos: (pos: number, side: -1 | 1 = 1) => {
			const line = state.doc.lineAt(pos), o = pos - line.from, rows = rowsAt(line.number);
			let r = 0;
			if (side < 0) while (r < rows.length - 1 && o > rows[r]!.end) r++;
			else while (r < rows.length - 1 && o >= rows[r + 1]!.start) r++;
			const left = (o - rows[r]!.start) * CW, top = topOf(line.number) + r * LH + (LH - FH) / 2;
			return { left, right: left, top, bottom: top + FH };
		},
		requestMeasure: (req: (typeof queue)[number]) => { if (!queue.some((q) => q.key === req.key)) queue.push(req); },
		dispatch: noop,
		hasFocus: focused,
		focus: noop,
		dom: { isConnected: true, ownerDocument: { defaultView: { requestAnimationFrame: () => 1, cancelAnimationFrame: noop } } },
	};
	const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
	Object.assign(overlay, {
		lineAnchorState: anchors,
		view,
		container: { getBoundingClientRect: () => ({ left: 0, top: 0, right: 900, bottom: 900, width: 900, height: 900 }) },
		inkInputPanX: () => 0,
		inkInputPanY: () => 0,
		pinchScaleNow: 1,
		pinchRefScale: null,
		pinchPreview: false,
		cssScale: 1,
		scale: 1,
		fontZoom: 1,
		camera: { snapshot: { x: 0, y: 0, zoom: 1 }, screenToWorld: (x: number, y: number) => ({ x, y }) },
		filePath: () => path,
		strokesHere: () => anchors.strokesFor(path, inlineInk.strokes(path)),
		endLiveGestureForHistory: noop,
		scheduleRepaint: noop,
		repaintPath: noop,
		redrawSelectionUI: noop,
		lineAnchorsMoved: noop,
		followMoved: InkOverlayPlugin.prototype.followMoved,
		armLineAnchorPass: noop,
		currentIndexes: () => [],
		frontierCache: { invalidate: noop },
		spaceSnapshot: null,
		selection,
		lineAnchorPassTimer: 0,
		lineDrawnAt: 0,
		frame: { end: noop, begin: noop, locked: false },
		damage: { addRect: noop },
		refreshStrip: noop,
	});
	Object.assign(overlay, { lineWindowMeasure: { key: {}, read: () => null, write: () => overlay.lineWindowMeasured() } });
	// Every count retakeMembers answers (anchors it cleared), in order; and per call, the strokes whose anchor it replaced
	// or cleared. The anchors are read off the store's own list, not `src`: a cell may hand in a counting proxy of it.
	const answers: number[] = [], retaken: number[] = [];
	const retake = anchors.retakeMembers.bind(anchors);
	anchors.retakeMembers = (p: string, src: readonly InkStroke[], before: FollowSnapshot) => {
		const list = inlineInk.strokes(p), was = list.map((s) => s.lineAnchor);
		const n = retake(p, src, before);
		answers.push(n);
		retaken.push(list.reduce((k, s, i) => k + (s.lineAnchor !== was[i] ? 1 : 0), 0));
		return n;
	};
	/** One measure cycle, CodeMirror's: every read made before any write. */
	const cycle = () => {
		const now = queue.splice(0), reads = now.map((q) => q.read());
		now.forEach((q, i) => q.write(reads[i]));
	};
	/** The editor's update for one change, up to its measure: the anchors hear it, then the follow; the changed lines are drawn. */
	const hear = (changes: ChangeSet) => {
		const startState = { doc: state.doc };
		state.doc = changes.apply(state.doc);
		const u = { changes, startState, state: { doc: state.doc }, docChanged: true } as unknown as ViewUpdate;
		const src = inlineInk.strokes(path);
		if (anchors.tracks(path, src)) {
			anchors.docChanged(path, src, startState.doc, changes, state.doc);
			if (anchors.windowOpen) view.requestMeasure(overlay.lineWindowMeasure);
		}
		overlay.followDocChanged(path, u);
		overlay.requestFollowMeasure();
		const changed = anchors.changedLines, first = Math.max(1, changed.from), last = Math.min(state.doc.lines, changed.to);
		if (first <= last) anchors.drawn(first, last, false);
	};
	/** The measure loop's update: every line read and marked. */
	const settle = () => anchors.drawn(1, state.doc.lines, true, true);
	const edit = (from: number, to: number, insert: string) => {
		hear(ChangeSet.of([{ from, to, insert }], state.doc.length));
		cycle();
		settle();
	};
	/** The editor quiet: every line drawn and measured, then the old-ink pass. */
	const quiet = () => {
		anchors.drawn(1, state.doc.lines);
		anchors.drawn(1, state.doc.lines, true, true);
		return anchors.anchorMeasured(path, inlineInk.strokes(path));
	};
	/** The pane's width changed: the words wrap at `n` columns, and the content's resize observer reads the groups now. */
	const widen = (n: number) => {
		cols = n;
		overlay.followMeasureNow();
	};
	/** The new width's signature read, its lines drawn and measured, then the old-ink pass. */
	const newSignature = () => {
		anchors.setSignature({ width: cols * CW, fontPx: 26, charWidth: CW });
		return quiet();
	};
	/** The follow takes the store's list and reads the groups in view: a pane that has just opened the note. */
	const open = () => {
		anchors.tracks(path, inlineInk.strokes(path));
		anchors.follow.setList(inlineInk.attachments(path));
		overlay.requestFollowMeasure();
		cycle();
		settle();
	};
	const attach = async (ids: string[]) => {
		selection.selectExactly(ids);
		expect(overlay.attachSelected(), "Attach is offered").toBe(true);
		cycle();
		await Promise.resolve();
		cycle();
		const r = inlineInk.attachments(path).find((a) => (a as AttachmentRecord).strokeIds.includes(ids[0]!)) as AttachmentRecord | undefined;
		expect(r, "Attach made a record for the selection").toBeDefined();
		return r!;
	};
	const text = () => state.doc.toString();
	const offset = (id: string) => anchors.follow.groupOffset(id);
	return { anchors, overlay, answers, retaken, hear, cycle, settle, edit, quiet, widen, newSignature, open, attach, text, offset };
}

/** A stroke's anchor as written, every field. */
const anchorOf = (s: InkStroke) => (s.lineAnchor ? { ...s.lineAnchor } : null);

/**
 * What each step leaves: every stroke's anchor, each pane's vouch and stamp for it, every count answered since the last,
 * and per call since the last, how many anchors were replaced or cleared.
 */
function snapshot(path: string, step: string, panes: Pane[]) {
	const strokes = inlineInk.strokes(path).map((s) => ({
		id: s.id,
		anchor: anchorOf(s),
		vouched: panes.map((p) => (p.anchors as unknown as { vouched: WeakSet<InkStroke> }).vouched.has(s)),
		stamp: panes.map((p) => (p.anchors as unknown as { gens: WeakMap<InkStroke, number> }).gens.get(s) ?? null),
	}));
	const answers = panes.map((p) => p.answers.splice(0)), retaken = panes.map((p) => p.retaken.splice(0));
	return { step, answers, retaken, strokes };
}

/** The document offset of line `n`'s start in `text`. */
const lineStart = (text: string, n: number) => text.split("\n").slice(0, n - 1).reduce((o, l) => o + l.length + 1, 0);

/** One pane: the script on a fresh note. */
async function onePane(path: string) {
	freshNote(path, noteInk());
	const p = pane(path, LINES);
	const steps = [];
	const a = await p.attach(["a1", "a2"]);
	const b = await p.attach(["b1", "b2"]);
	p.quiet();
	steps.push(snapshot(path, "attached, quiet", [p]));
	// A letter typed in front of group A's word: it slides along its row, no line moves.
	const q = lineStart(p.text(), 2) + LINES[1]!.indexOf("quick");
	p.edit(q, q, "x");
	steps.push(snapshot(path, "letter", [p]));
	// Enter above group A, below group B: A goes down a line, B stays.
	const l2 = lineStart(p.text(), 2);
	p.edit(l2, l2, "\n");
	expect(p.offset(a.id)?.dy, "premise: A moved down a line").toBe(LH);
	expect(p.offset(b.id)?.dy, "premise: B did not move").toBe(0);
	steps.push(snapshot(path, "enter above", [p]));
	p.quiet();
	steps.push(snapshot(path, "enter above, quiet", [p]));
	// Words typed in front of A's line wrap its word to the line's second row.
	const l3 = lineStart(p.text(), 3), wrap = "and then a big ";
	p.edit(l3, l3, wrap);
	expect(p.offset(a.id)?.dy, "premise: A's word wrapped to the second row").toBe(2 * LH);
	steps.push(snapshot(path, "wrap", [p]));
	p.quiet();
	steps.push(snapshot(path, "wrap, quiet", [p]));
	// The words taken out again: A's word back on the first row.
	p.edit(l3, l3 + wrap.length, "");
	expect(p.offset(a.id)?.dy, "premise: A's word back on the first row").toBe(LH);
	steps.push(snapshot(path, "unwrap", [p]));
	p.quiet();
	steps.push(snapshot(path, "unwrap, quiet", [p]));
	// The pane narrowed: lines wrap at fewer columns and the groups are read in the same frame.
	p.widen(NARROW);
	steps.push(snapshot(path, "width change", [p]));
	p.newSignature();
	steps.push(snapshot(path, "width change, new signature", [p]));
	// The note opened afresh in a new pane, the old one gone: each group's first read there.
	p.anchors.tracks(`${path}.gone`, []);
	const fresh = pane(path, p.text().split("\n"));
	fresh.open();
	steps.push(snapshot(path, "first read", [fresh]));
	fresh.quiet();
	steps.push(snapshot(path, "first read, quiet", [fresh]));
	return steps;
}

/** Two panes on one note: each edit heard by both, the focused pane first. */
async function twoPanes(path: string) {
	freshNote(path, noteInk());
	const p = pane(path, LINES, true);
	const a = await p.attach(["a1", "a2"]);
	await p.attach(["b1", "b2"]);
	p.quiet();
	const o = pane(path, LINES, false);
	o.open();
	o.quiet();
	const both = [p, o];
	const steps = [snapshot(path, "two panes, attached, quiet", both)];
	const edit = (from: number, to: number, insert: string) => {
		const changes = ChangeSet.of([{ from, to, insert }], p.text().length);
		for (const x of both) x.hear(changes);
		for (const x of both) x.cycle();
		for (const x of both) x.settle();
	};
	const l2 = lineStart(p.text(), 2);
	edit(l2, l2, "\n");
	expect(p.offset(a.id)?.dy, "premise: A moved down a line").toBe(LH);
	steps.push(snapshot(path, "two panes, enter above", both));
	const l3 = lineStart(p.text(), 3), wrap = "and then a big ";
	edit(l3, l3, wrap);
	steps.push(snapshot(path, "two panes, wrap", both));
	for (const x of both) x.quiet();
	steps.push(snapshot(path, "two panes, wrap, quiet", both));
	edit(l3, l3 + wrap.length, "");
	steps.push(snapshot(path, "two panes, unwrap", both));
	return steps;
}

/** Group B's third member: a short stroke under "first" at the top of line 2. B's box has its centre on line 1. */
const b3 = () => strokeOf("b3", [[X(FIRST), LH + 6], [X(FIRST + 5), LH + 8]]);

/** A group that does not move, with a member anchored on the line below its word: Enter there moves that line and A, not B. */
async function memberBelow(path: string) {
	freshNote(path, [...noteInk(), b3()]);
	const p = pane(path, LINES);
	const a = await p.attach(["a1", "a2"]);
	const b = await p.attach(["b1", "b2", "b3"]);
	p.quiet();
	const b3Now = inlineInk.strokes(path).find((s) => s.id === "b3");
	expect(b3Now?.lineAnchor?.line, "premise: B's third member is anchored on line 2").toBe(2);
	const steps = [snapshot(path, "member below, quiet", [p])];
	const l2 = lineStart(p.text(), 2);
	p.edit(l2, l2, "\n");
	expect(p.offset(a.id)?.dy, "premise: A moved down a line").toBe(LH);
	expect(p.offset(b.id)?.dy, "premise: B did not move").toBe(0);
	steps.push(snapshot(path, "member below, enter above", [p]));
	p.quiet();
	steps.push(snapshot(path, "member below, enter above, quiet", [p]));
	return steps;
}

/** A note that holds one id twice: the copy of member a1 is a stroke of its own under the same id. */
async function twiceStored(path: string) {
	freshNote(path, noteInk());
	const p = pane(path, LINES);
	const a = await p.attach(["a1", "a2"]);
	await p.attach(["b1", "b2"]);
	const list = inlineInk.strokes(path) as InkStroke[], a1 = list.find((s) => s.id === "a1")!;
	list.push({ ...a1, points: a1.points.slice(), bbox: { ...a1.bbox } });
	bumpInkListRevision();
	p.quiet();
	const steps = [snapshot(path, "id twice, quiet", [p])];
	const l2 = lineStart(p.text(), 2);
	p.edit(l2, l2, "\n");
	expect(p.offset(a.id)?.dy, "premise: A moved down a line").toBe(LH);
	steps.push(snapshot(path, "id twice, enter above", [p]));
	const l3 = lineStart(p.text(), 3), wrap = "and then a big ";
	p.edit(l3, l3, wrap);
	steps.push(snapshot(path, "id twice, wrap", [p]));
	return steps;
}

describe("a moved group's members are anchored again by id", () => {
	it("guard: every anchor, vouch, stamp and answer after each step is the record's", async () => {
		const got = {
			onePane: await onePane("retake-guard-one.md"),
			twoPanes: await twoPanes("retake-guard-two.md"),
			memberBelow: await memberBelow("retake-guard-below.md"),
			twiceStored: await twiceStored("retake-guard-twice.md"),
		};
		// Every line is measured when the follow reads in these scripts, so no member is past the measured lines and none
		// is cleared. At the base build the width change is the step that re-takes members' anchors (the wrap does not), so
		// the guard reaches the re-take. The steps that re-take are kept in the record and compared with it.
		const retook = got.onePane.filter((s) => s.retaken.flat().some((n) => n > 0)).map((s) => s.step);
		expect(retook.length, `premise: some step re-takes a member's anchor (steps that do: ${JSON.stringify(retook)})`).toBeGreaterThan(0);
		const out = process.env.HW_RETAKE_RECORD;
		if (out) {
			writeFileSync(out, JSON.stringify({ ...got, retook }, null, "\t") + "\n");
			return;
		}
		const record = JSON.parse(readFileSync(RECORD, "utf8")) as typeof got & { retook: string[] };
		expect(retook, "the steps that re-take a member's anchor").toEqual(record.retook);
		for (const k of ["onePane", "twoPanes", "memberBelow", "twiceStored"] as const) {
			expect(got[k].map((s) => s.step), `${k}: the same steps`).toEqual(record[k].map((s) => s.step));
			got[k].forEach((s, i) => expect(s, `${k}, step "${s.step}"`).toEqual(record[k][i]));
		}
	});

	it("a group moved on a note of 2000 strokes reads its own members, not the note", async () => {
		const path = "retake-count.md";
		const extra = Array.from({ length: 2000 }, (_, i) => strokeOf(`x${i}`, [[X(1), 6 * LH + i], [X(3), 6 * LH + i + 4]]));
		freshNote(path, [...noteInk(), ...extra]);
		const p = pane(path, [...LINES, "", "a line below the ink"]);
		const a = await p.attach(["a1", "a2"]);
		p.quiet();
		// Every stroke read off the store list inside retakeMembers: one per index read.
		let reads = 0;
		const counted = new WeakMap<readonly InkStroke[], InkStroke[]>();
		const countedOf = (src: readonly InkStroke[]) => {
			let c = counted.get(src);
			if (!c) {
				c = new Proxy(src as InkStroke[], {
					get(t, k, r) {
						if (typeof k === "string" && /^\d+$/.test(k)) reads++;
						return Reflect.get(t, k, r) as unknown;
					},
				});
				counted.set(src, c);
			}
			return c;
		};
		const take = p.anchors.retakeMembers.bind(p.anchors);
		const perMove: number[] = [];
		p.anchors.retakeMembers = (q: string, src: readonly InkStroke[], before: FollowSnapshot) => {
			reads = 0;
			const n = take(q, countedOf(src), before);
			perMove.push(reads);
			return n;
		};
		const enterAbove = () => {
			const l2 = lineStart(p.text(), 2);
			p.edit(l2, l2, "\n");
		};
		enterAbove();
		expect(p.offset(a.id)?.dy, "premise: the first Enter moved A down a line").toBe(LH);
		enterAbove();
		expect(p.offset(a.id)?.dy, "premise: the second Enter moved A down another").toBe(2 * LH);
		expect(perMove.length, "premise: each Enter ran retakeMembers").toBeGreaterThanOrEqual(2);
		// The first move may build the list's id map once (a read per stroke); the next reads A's two members only.
		expect(perMove[perMove.length - 1], `strokes read for the second move (each move: ${perMove.join(", ")})`).toBeLessThanOrEqual(2);
	});

	it("a place in the kept map that holds another stroke now: the free stroke there keeps its anchor, the member is anchored again", async () => {
		const path = "retake-swapped.md";
		freshNote(path, noteInk());
		const p = pane(path, LINES);
		const a = await p.attach(["a1", "a2"]);
		await p.attach(["b1", "b2"]);
		p.quiet();
		const list = inlineInk.strokes(path) as InkStroke[];
		// The store list's id to place map, built now and kept on the list.
		expect(strokeById(list, "a1")?.id, "premise: the map finds a1").toBe("a1");
		// Member a1 and free stroke f1 change places in the list itself; the list's revision does not move.
		const i = list.findIndex((s) => s.id === "a1"), j = list.findIndex((s) => s.id === "f1");
		const a1 = list[i]!, f1 = list[j]!, a2 = list.find((s) => s.id === "a2")!;
		list[i] = f1;
		list[j] = a1;
		const f1Was = f1.lineAnchor, f1WasAt = anchorOf(f1), a1WasAt = anchorOf(a1), a2WasAt = anchorOf(a2);
		expect(f1Was, "premise: free stroke f1 is anchored").toBeDefined();
		expect(a1WasAt, "premise: member a1 is anchored").not.toBeNull();
		// The pane narrowed: the line above A's wraps and A's word stays on its row, so A moves down a line, and its members'
		// anchors, taken under the measure before, no longer show it.
		p.widen(NARROW);
		expect(p.offset(a.id)?.dy, "premise: A moved down a line").toBe(LH);
		expect(anchorOf(a2), "premise: the move anchors A's members again (a2)").not.toEqual(a2WasAt);
		expect(f1.lineAnchor, "free stroke f1 keeps its own anchor").toBe(f1Was);
		expect(anchorOf(f1), "free stroke f1's anchor as it was").toEqual(f1WasAt);
		expect(anchorOf(a1), "member a1 is anchored again").not.toEqual(a1WasAt);
	});

	it("a member the kept map never held, back in the list at the same length with the revision moved, is anchored again", async () => {
		const path = "retake-not-held.md";
		freshNote(path, [...noteInk(), strokeOf("a3", [[X(FOX), LH + 20], [X(FOX + 3), LH + 22]])]);
		const p = pane(path, LINES);
		const a = await p.attach(["a1", "a2", "a3"]);
		await p.attach(["b1", "b2"]);
		p.quiet();
		const list = inlineInk.strokes(path) as InkStroke[], k = list.findIndex((s) => s.id === "a3"), a3 = list[k]!;
		const a3WasAt = anchorOf(a3);
		expect(a3WasAt, "premise: member a3 is anchored").not.toBeNull();
		// a3 out and a stroke drawn in its place: the revision moves, and the map is built then and kept on the list, no a3.
		list[k] = strokeOf("y1", [[X(1), 3 * LH + 10], [X(5), 3 * LH + 20]]);
		bumpInkListRevision();
		expect(strokeById(list, "y1")?.id, "premise: the map is built with y1 in a3's place").toBe("y1");
		// The drawn stroke erased and a3 back in its place: the same length, the revision moved. No other place changed.
		list[k] = a3;
		bumpInkListRevision();
		const a1 = list.find((s) => s.id === "a1")!, a1WasAt = anchorOf(a1);
		const free = list.filter((s) => s.id.startsWith("f")).map((s) => [s, s.lineAnchor] as const);
		expect(free.every(([, was]) => was), "premise: the free strokes are anchored").toBe(true);
		p.widen(NARROW);
		expect(p.offset(a.id)?.dy, "premise: A moved down a line").toBe(LH);
		expect(anchorOf(a1), "premise: the move anchors A's members again (a1)").not.toEqual(a1WasAt);
		expect(anchorOf(a3), "member a3 is anchored again").not.toEqual(a3WasAt);
		for (const [s, was] of free) expect(s.lineAnchor, `free stroke ${s.id} keeps its own anchor`).toBe(was);
	});
});
