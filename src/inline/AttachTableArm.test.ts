/**
 * Ink attached to a word in a table cell, on the table recorded in the app (Obsidian 1.15.1, Live Preview, Minimal
 * dark, Bahnschrift 26px; AttachTableArm.fixture.json, recorded 2026-11-17): its widget DOM, its geometry, and the
 * six edits the app wrote, each one replace of the whole table's text.
 *
 * Product rule: attached ink follows its word (Alan 11-08), the one exception to "ink never follows text".
 *
 * A bare overlay over a fake view, as AttachTable.test.ts builds it, with the table drawn by tableWidgetDom.testutil.ts:
 * the widget's DOM as recorded, under view.contentDOM, reached by view.domAtPos; coordsAtPos inside it answers the
 * widget's whole box as recorded (left edge at its first position, right edge everywhere else). Text lines are CW px a
 * character, LH px high. The widget sits 16 px left of the text column, as recorded (cm-embed-block's margin), so its
 * first cell's text lines up with the text lines' and the widget's corner is 16 px left of and above it.
 */
import { describe, expect, it } from "vitest";
import { appendFileSync } from "node:fs";
import { ChangeSet, Text } from "@codemirror/state";
import { BlockType, type ViewUpdate } from "@codemirror/view";
import { InkOverlayPlugin } from "./InkOverlay";
import { inlineInk } from "./InkOverlayRegistry";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { emptyPage } from "../model/PageData";
import { computeBBox, settleLineAnchors, type InkStroke } from "../ink/Stroke";
import { shownStrokes, type LineSpans } from "./EmbedInkLines";
import { SelectionModel } from "../objects/SelectionModel";
import { targetAt, type AttachmentRecord } from "./InkAttachments";
import { FDoc, FEl, FRange, FText, tableWidget, type Box, type TableOpts } from "./tableWidgetDom.testutil";
import ARM from "./AttachTableArm.fixture.json";

declare module "node:fs" { export function appendFileSync(path: string, data: string): void; }
declare const process: { env: Record<string, string | undefined> };

type Step = { from: number; to: number; insert: string; old: string };
type Op = { name: string; what: string; before: string; steps: Step[][] };
type Fixture = { widget: { w: number; h: number }; coordsAtPos: Record<string, number[]>; table: string; rows: { tag: string; rect: number[]; text: string; nodes: { text: string; words: { w: string; at: number; rects: number[][] }[] }[] }[][]; ops: Op[] };
const FIX = ARM as unknown as Fixture;

const CW = 14, LH = 40, FH = 26, COLS = 90, WX = -16;
const SIG = { width: COLS * CW, fontPx: 26, charWidth: CW };
const ABOVE = ["L01 first line.", ""], BELOW = ["", "Text below the table here"];

const OUT = process.env.HW_TABLE_ATTACH_OUT ?? "";
const note = (line: string) => {
	console.log(line);
	if (OUT) appendFileSync(OUT, line + "\n");
};

function loop(id: string, x0: number, x1: number, y0: number, y1: number): InkStroke {
	const pts: [number, number][] = [[x0, (y0 + y1) / 2], [(x0 + x1) / 2, y0], [x1, (y0 + y1) / 2], [(x0 + x1) / 2, y1], [x0 + 2, (y0 + y1) / 2]];
	const points = pts.map(([x, y], i) => ({ x, y, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

/** A note of ABOVE, the table's lines, BELOW; the table drawn as the recorded widget. */
function rig(path: string, table: string, opts: TableOpts = {}) {
	const rec = inlineInk.record(path);
	rec.pageId = `page-${path}`;
	rec.basePage = { ...emptyPage(rec.pageId), attachments: [] };
	rec.attachments = undefined as unknown as typeof rec.attachments;
	rec.strokes = [];
	Object.defineProperty(inlineInk, "persist", { value: () => {}, configurable: true });
	const state = { doc: Text.of([...ABOVE, ...table.split("\n"), ...BELOW]) };
	const fdoc = new FDoc();
	const tableOpts: TableOpts = { ...opts };
	const span = () => {
		let a = 0;
		for (let n = 1; n <= state.doc.lines; n++) if (state.doc.line(n).text.startsWith("|")) { a = n; break; }
		let b = a;
		while (b + 1 <= state.doc.lines && state.doc.line(b + 1).text.startsWith("|")) b++;
		return { a, b, from: state.doc.line(a).from, to: state.doc.line(b).to };
	};
	// One widget per document and options: the same nodes for every read in a layout.
	let built: { key: unknown; opts: string; w: ReturnType<typeof tableWidget> } | null = null;
	const widget = () => {
		const s = span(), key = state.doc, o = JSON.stringify(tableOpts);
		if (built && built.key === key && built.opts === o) return built.w;
		const lines: string[] = [];
		for (let n = s.a; n <= s.b; n++) lines.push(state.doc.line(n).text);
		let top = 0;
		for (let i = 1; i < s.a; i++) top += LH;
		built = { key, opts: o, w: tableWidget(fdoc, lines, WX, top, tableOpts) };
		return built.w;
	};
	const inTable = (n: number) => { const s = span(); return n >= s.a && n <= s.b; };
	const heightOf = (n: number) => (inTable(n) ? (n === span().a ? widget().height : 0) : LH);
	const topOf = (n: number) => { let t = 0; for (let i = 1; i < n; i++) t += heightOf(i); return t; };
	const blockOf = (n: number) => {
		if (inTable(n)) { const s = span(), top = topOf(s.a), h = widget().height; return { from: s.from, to: s.to, top, bottom: top + h, height: h, type: BlockType.WidgetRange }; }
		const line = state.doc.line(n), top = topOf(n);
		return { from: line.from, to: line.to, top, bottom: top + LH, height: LH, type: BlockType.Text };
	};
	const blocks = () => {
		const out: ReturnType<typeof blockOf>[] = [];
		for (let n = 1; n <= state.doc.lines; n++) { const b = blockOf(n); if (!out.length || out[out.length - 1]!.from !== b.from) out.push(b); }
		return out;
	};
	// The editor's DOM: a .cm-line per text line, the widget in its place.
	const editorDom = new FEl("div", "cm-editor", fdoc), scroller = new FEl("div", "cm-scroller", fdoc), content = new FEl("div", "cm-content", fdoc);
	editorDom.append(scroller.append(content));
	const contentNow = () => {
		content.childNodes.length = 0;
		const s = span();
		for (let n = 1; n <= state.doc.lines; n++) {
			if (n === s.a) { const w = widget().el; w.parentNode = null; content.append(w); continue; }
			if (inTable(n)) continue;
			const line = new FEl("div", "cm-line", fdoc), top = topOf(n), t = new FText(state.doc.line(n).text, fdoc);
			line.rect = { left: 0, top, right: COLS * CW, bottom: top + LH, width: COLS * CW, height: LH, x: 0, y: top };
			t.chars = [...t.data].map((_, i) => ({ left: i * CW, right: (i + 1) * CW, top: top + (LH - FH) / 2, bottom: top + (LH + FH) / 2, width: CW, height: FH, x: i * CW, y: top + (LH - FH) / 2 }));
			content.append(line.append(t));
		}
		return content;
	};
	const layout = (): LineLayout => ({ lines: state.doc.lines, lineText: (n) => state.doc.line(n).text, lineTop: (n) => (inTable(n) ? topOf(span().a) : topOf(n)), pxPerWorld: 1 });
	const anchors = new LineAnchors(layout);
	anchors.setSignature(SIG);
	anchors.drawn(1, state.doc.lines);
	anchors.drawn(1, state.doc.lines, true, true);
	const selection = new SelectionModel();
	const noop = () => {};
	const view = {
		scaleY: 1,
		defaultLineHeight: LH,
		state,
		get viewport() { return { from: 0, to: state.doc.length }; },
		get contentDOM() { return contentNow(); },
		dom: editorDom,
		lineBlockAt: (pos: number) => blockOf(state.doc.lineAt(pos).number),
		lineBlockAtHeight: (h: number) => { const all = blocks(); for (const b of all) if (h < b.bottom) return b; return all[all.length - 1]!; },
		domAtPos: (pos: number) => {
			const c = contentNow(), n = state.doc.lineAt(pos).number;
			if (inTable(n)) return { node: c, offset: c.childNodes.indexOf(widget().el) };
			const line = c.childNodes.find((l) => l instanceof FEl && l.rect.top === topOf(n)) as FEl, t = line.childNodes[0] as FText;
			return { node: t, offset: pos - state.doc.line(n).from };
		},
		coordsAtPos: (pos: number) => {
			const s = span();
			if (pos >= s.from && pos <= s.to) {
				const w = widget(), top = topOf(s.a), x = pos === s.from ? WX : WX + w.width;
				return { left: x, right: x, top, bottom: top + w.height };
			}
			const line = state.doc.lineAt(pos), left = (pos - line.from) * CW, top = topOf(line.number) + (LH - FH) / 2;
			return { left, right: left, top, bottom: top + FH };
		},
		requestMeasure: (req: { read: () => unknown; write: (m: unknown) => void }) => req.write(req.read()),
		dispatch: noop,
		hasFocus: true,
		focus: noop,
	};
	const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
	Object.assign(overlay, {
		lineAnchorState: anchors, view,
		container: { getBoundingClientRect: () => ({ left: 0, top: 0, right: 1400, bottom: 1400, width: 1400, height: 1400 }) },
		inkInputPanX: () => 0, inkInputPanY: () => 0, pinchScaleNow: 1, pinchRefScale: null, pinchPreview: false, cssScale: 1, scale: 1, fontZoom: 1,
		camera: { snapshot: { x: 0, y: 0, zoom: 1 }, screenToWorld: (x: number, y: number) => ({ x, y }) },
		filePath: () => path, strokesHere: () => anchors.strokesFor(path, inlineInk.strokes(path)),
		endLiveGestureForHistory: noop, scheduleRepaint: noop, repaintPath: noop, redrawSelectionUI: noop, lineAnchorsMoved: noop, followMoved: noop,
		currentIndexes: () => [], frontierCache: { invalidate: noop }, spaceSnapshot: null, selection, lineAnchorPassTimer: 0, lineDrawnAt: 0,
		frame: { end: noop, begin: noop, locked: false }, damage: { addRect: noop }, refreshStrip: noop,
	});
	/** Whether the line anchors hear each change first, as the editor's update does (cell 10 reads them; the rest read the follow alone). */
	const hear = { anchors: false };
	/** One transaction: its changes, positions from the table's first character. */
	const apply = (changes: { from: number; to: number; insert: string }[]) => {
		const at = span().from, set = ChangeSet.of(changes.map((c) => ({ from: c.from + at, to: c.to + at, insert: c.insert })), state.doc.length);
		const startState = { doc: state.doc };
		state.doc = set.apply(state.doc);
		if (hear.anchors && anchors.tracks(path, inlineInk.strokes(path))) anchors.docChanged(path, inlineInk.strokes(path), startState.doc, set, state.doc);
		overlay.followDocChanged(path, { changes: set, startState, docChanged: true, state: { doc: state.doc } } as unknown as ViewUpdate);
		overlay.requestFollowMeasure();
	};
	const op = (o: Op) => { for (const t of o.steps) apply(t); };
	/** A layout change with no document change (the options changed: a cell under edit, a scroll). */
	const relayout = (o: TableOpts) => {
		Object.assign(tableOpts, o);
		anchors.follow.layoutChanged();
		overlay.requestFollowMeasure();
	};
	const tryAttach = async (s: InkStroke) => {
		inlineInk.record(path).strokes = [s];
		selection.selectExactly([s.id]);
		if (!overlay.attachSelected()) return null;
		await Promise.resolve();
		const list = inlineInk.attachments(path);
		return list.length === 1 ? (list[0] as AttachmentRecord) : null;
	};
	/** Where `word` (its `nth` in the cell's shown text) is drawn now in shown row `row`, column `col`: its first row's box. */
	const wordAt = (row: number, col: number, word: string, nth = 0): Box => {
		const td = widget().cell(row, col)!, texts: FText[] = [];
		const walk = (n: FEl | FText) => { if (n instanceof FText) { if (!n.hidden()) texts.push(n); } else n.childNodes.forEach((k) => walk(k as FEl | FText)); };
		walk(td);
		const all = texts.map((t) => t.data).join("");
		let i = -1;
		for (let k = 0; k <= nth; k++) i = all.indexOf(word, i + 1);
		if (i < 0) throw new Error(`no ${word} in row ${row} col ${col}: ${JSON.stringify(all)}`);
		let at = 0;
		for (const t of texts) {
			if (i < at + t.length) {
				const r = new FRange();
				r.setStart(t, i - at);
				r.setEnd(t, Math.min(t.length, i - at + word.length));
				return r.getClientRects()[0]!;
			}
			at += t.length;
		}
		throw new Error("unreachable");
	};
	const circle = (row: number, col: number, word: string, nth = 0) => {
		const b = wordAt(row, col, word, nth), td = widget().cell(row, col)!.rect;
		return loop("c", b.left - 4, b.right + 4, Math.max(td.top + 6, b.top - 4), Math.min(td.bottom - 6, b.bottom + 4));
	};
	const offset = (id: string) => anchors.follow.groupOffset(id);
	const text = () => state.doc.toString();
	return { tryAttach, apply, op, relayout, wordAt, circle, offset, text, span, widget, overlay, anchors, selection, topOf, hear };
}

const near = (a: number, b: number, tol = 0.5) => Math.abs(a - b) <= tol;
const T0 = FIX.table;

describe("the rig's table is the table recorded in the app", () => {
	it("every recorded word's box, each cell's box and the widget's place answers are the recording's, within half a px", () => {
		const t = rig("arm-geom.md", T0), w = t.widget(), top = t.topOf(t.span().a), off: string[] = [];
		const at = (r: number[]) => [r[0]! + WX, r[1]! + top, r[2]! + WX, r[3]! + top];
		FIX.rows.forEach((row, ri) => row.forEach((c, ci) => {
			const td = w.cell(ri, ci)!.rect, want = at(c.rect);
			if (![td.left, td.top, td.right, td.bottom].every((v, k) => near(v, want[k]!))) off.push(`cell r${ri}c${ci} ${JSON.stringify([td.left, td.top, td.right, td.bottom])} want ${JSON.stringify(want)}`);
			const counts: Record<string, number> = {};
			for (const n of c.nodes) for (const wd of n.words) {
				const nth = counts[wd.w] ?? 0;
				counts[wd.w] = nth + 1;
				const b = t.wordAt(ri, ci, wd.w, nth), r = at(wd.rects[0]!);
				if (![b.left, b.top, b.right, b.bottom].every((v, k) => near(v, r[k]!))) off.push(`${wd.w} r${ri}c${ci} ${JSON.stringify([b.left, b.top, b.right, b.bottom])} want ${JSON.stringify(r)}`);
			}
		}));
		const s = t.span(), from = t.overlay.view.coordsAtPos(s.from)!, mid = t.overlay.view.coordsAtPos(s.from + 30)!;
		void note(`TABLE-ARM rig geometry: ${off.length} off ${JSON.stringify(off.slice(0, 4))}`);
		expect(off, "rig boxes off the recording").toEqual([]);
		expect(near(w.width, FIX.widget.w) && near(w.height, FIX.widget.h), `the widget's size ${w.width} x ${w.height}`).toBe(true);
		expect([from.left - WX, from.top - top, near(from.bottom - top, FIX.coordsAtPos.from![3]!)], "first position: the widget's left edge, whole height").toEqual([0, 0, true]);
		expect(near(mid.left - WX, FIX.coordsAtPos.mid![0]!), "a position inside: the widget's right edge").toBe(true);
	});
});

/**
 * Each recorded word: its shown row, column, and the target Attach takes (the word, or its cell's text when it has markup,
 * from the cell's first drawn character).
 */
const WORDS: { w: string; row: number; col: number; nth?: number; want: string }[] = [
	{ w: "Name", row: 0, col: 0, want: "Name" }, { w: "Note", row: 0, col: 1, want: "Note" }, { w: "Link", row: 0, col: 2, want: "Link" },
	{ w: "kilo", row: 1, col: 0, want: "kilo" }, { w: "beta", row: 1, col: 1, want: "beta" }, { w: "gamma", row: 1, col: 1, want: "gamma" }, { w: "plain", row: 1, col: 2, want: "plain" },
	{ w: "delta", row: 2, col: 0, want: "delta" }, { w: "bold", row: 2, col: 1, want: "bold** word" }, { w: "word", row: 2, col: 1, want: "word" },
	{ w: "other", row: 2, col: 2, want: "other]] and [site](https://example.com)" }, { w: "and", row: 2, col: 2, want: "and" }, { w: "site", row: 2, col: 2, want: "other]] and [site](https://example.com)" },
	{ w: "echo", row: 3, col: 0, want: "echo" }, { w: "foxtrot", row: 3, col: 1, want: "foxtrot" }, { w: "hotel", row: 3, col: 1, want: "foxtrot **hotel** and [[other]]" },
	{ w: "other", row: 3, col: 1, want: "foxtrot **hotel** and [[other]]" }, { w: "golf", row: 3, col: 2, want: "golf" },
];

describe("cell 1 on the recorded table: a circle around a word in a cell targets that word, or its cell when the word has markup", () => {
	it("each recorded word, circled where it is drawn", async () => {
		const bad: string[] = [];
		for (const [i, x] of WORDS.entries()) {
			const path = `arm-word-${i}.md`, t = rig(path, T0);
			const r = await t.tryAttach(t.circle(x.row, x.col, x.w, x.nth));
			const text = r ? t.text().slice(r.target.from, r.target.to) : null;
			if (!r || r.target.kind !== "range" || text !== x.want) bad.push(`${x.w} r${x.row}c${x.col}: ${r ? `${r.target.kind} ${JSON.stringify(text?.slice(0, 40))}` : "no record"}, want ${JSON.stringify(x.want)}`);
		}
		await note(`TABLE-ARM each word circled: ${WORDS.length} words, ${bad.length} off ${JSON.stringify(bad.slice(0, 4))}`);
		expect(bad).toEqual([]);
	});
});

/** The op named `name`. */
const opNamed = (name: string) => FIX.ops.find((o) => o.name === name)!;
/** Where beta's row and column are in each op's table before and after: the recorded edits move them. */
const BETA_AT: Record<string, [[number, number], [number, number]]> = {
	"b1-type": [[1, 1], [1, 1]], "b2-row-above": [[1, 1], [2, 1]], "b3-row-removed-above": [[2, 1], [1, 1]],
	"b4-col-before": [[1, 1], [1, 2]], "b5-row-moved": [[1, 2], [2, 2]], "b6-sort": [[2, 2], [3, 2]],
};

describe("cells 4 and 5 on the recorded edits: the ink follows its word through each whole-table replace the app writes", () => {
	for (const o of FIX.ops) {
		// From b2 on, the recorded table holds b1's typed "Z" in front of beta: the word drawn there is "Zbeta".
		const word = o.name === "b1-type" ? "beta" : "Zbeta";
		it(`${o.name} (${o.what}): the circle around ${word} moves with it, and its target is still ${word}`, async () => {
			const path = `arm-op-${o.name}.md`, t = rig(path, o.before), [[r0, c0], [r1, c1]] = BETA_AT[o.name]!;
			const r = await t.tryAttach(t.circle(r0, c0, word));
			expect(r && t.text().slice(r.target.from, r.target.to), `Attach took ${word}`).toBe(word);
			const was = t.wordAt(r0, c0, word);
			t.op(o);
			const now = t.wordAt(r1, c1, word), want = { dx: now.left - was.left, dy: now.top - was.top }, got = t.offset(r!.id);
			const a = (inlineInk.attachments(path)[0] as AttachmentRecord).target;
			await note(`TABLE-ARM ${o.name}: ${word} moved ${JSON.stringify(want)}, ink ${JSON.stringify(got)}, target ${a.kind} ${JSON.stringify(t.text().slice(a.from, a.to))}`);
			expect(t.text().slice(a.from, a.to), `the target is ${word}`).toBe(word);
			expect(!!got && near(got.dx, want.dx) && near(got.dy, want.dy), `ink ${JSON.stringify(got)} on beta ${JSON.stringify(want)}`).toBe(true);
		});
	}

	it("the word's cell keeps a word with markup through the recorded edits: the circle around bold keeps its cell", async () => {
		const path = "arm-op-bold.md", t = rig(path, opNamed("b2-row-above").before);
		const r = await t.tryAttach(t.circle(2, 1, "bold"));
		expect(r && t.text().slice(r.target.from, r.target.to).trim(), "premise: the cell from its first drawn character").toBe("bold** word");
		const was = t.wordAt(2, 1, "bold");
		t.op(opNamed("b2-row-above"));
		const now = t.wordAt(3, 1, "bold"), got = t.offset(r!.id), a = (inlineInk.attachments(path)[0] as AttachmentRecord).target;
		expect(t.text().slice(a.from, a.to).trim(), "still its cell from its first drawn character").toBe("bold** word");
		expect(!!got && near(got.dx, now.left - was.left) && near(got.dy, now.top - was.top), `ink ${JSON.stringify(got)}`).toBe(true);
	});

	it("the word gone in a rewrite: its cell; the cell gone: needs reattachment, as today", async () => {
		const path = "arm-gone.md", t = rig(path, T0);
		const r = await t.tryAttach(t.circle(1, 1, "beta"));
		expect(r && t.text().slice(r.target.from, r.target.to), "premise").toBe("beta");
		// The whole table rewritten with beta gone from its cell (the app's replace shape, b1's first step).
		t.apply([{ from: 0, to: T0.length, insert: T0.replace("| beta gamma |", "| gamma |") }]);
		const a = (inlineInk.attachments(path)[0] as AttachmentRecord).target;
		await note(`TABLE-ARM word gone: ${a.kind} ${a.from}-${a.to} ${JSON.stringify(t.text().slice(a.from, a.to))}`);
		expect(t.text().slice(a.from, a.to).trim(), "its cell").toBe("gamma");
		const T1 = t.text().slice(t.span().from, t.span().to);
		t.apply([{ from: 0, to: T1.length, insert: T1.replace("| kilo | gamma | plain |\n", "") }]);
		const b = (inlineInk.attachments(path)[0] as AttachmentRecord).target;
		expect(b.from === b.to, `collapsed: ${JSON.stringify(b)}`).toBe(true);
	});
});

describe("cell 5, the same word in another row of its column: the recorded row move and sort keep the ink on its own row's word", () => {
	// The recorded b5 and b6 replaces with another row's Note cell made "Zbeta gamma" too (same length, so every recorded
	// position holds): the word's column then holds the same cell text in two rows, and only the other columns tell the
	// two rows apart. The other row is the one kilo's row passes: delta's in the row move, echo's in the sort. A re-find
	// by the word's own column alone, first match, takes that row's word.
	const OTHER: Record<string, [string, string]> = {
		"b5-row-moved": ["delta", "**bold** word"],
		"b6-sort": ["echo", "foxtrot **hotel** and [[other]]"],
	};
	const lineOf = (doc: string, pos: number) => doc.slice(0, pos).split("\n").length;
	for (const name of ["b5-row-moved", "b6-sort"]) {
		const [who, cell] = OTHER[name]!, dup = (s: string) => s.replace(cell, "Zbeta gamma".padEnd(cell.length));
		it(`${name}, ${who}'s row holding the same Zbeta cell: the target and the ink stay on kilo's Zbeta`, async () => {
			const o = opNamed(name), d: Op = { ...o, before: dup(o.before), steps: o.steps.map((tr) => tr.map((s) => ({ ...s, insert: dup(s.insert), old: dup(s.old) }))) };
			const path = `arm-dup-${name}.md`, t = rig(path, d.before), [[r0, c0], [r1, c1]] = BETA_AT[name]!;
			const rowText = (doc: string, pos: number) => doc.split("\n")[lineOf(doc, pos) - 1]!;
			expect(d.before.split("\n").filter((l) => l.includes("| Zbeta gamma ")).length, "premise: two rows hold the same Zbeta cell").toBe(2);
			const r = await t.tryAttach(t.circle(r0, c0, "Zbeta"));
			expect(r && [t.text().slice(r.target.from, r.target.to), rowText(t.text(), r.target.from).startsWith("| kilo ")], "premise: kilo's Zbeta").toEqual(["Zbeta", true]);
			const was = t.wordAt(r0, c0, "Zbeta");
			t.op(d);
			const now = t.wordAt(r1, c1, "Zbeta"), want = { dx: now.left - was.left, dy: now.top - was.top }, got = t.offset(r!.id);
			const a = (inlineInk.attachments(path)[0] as AttachmentRecord).target, row = rowText(t.text(), a.from);
			await note(`TABLE-ARM dup ${name}: target ${JSON.stringify(t.text().slice(a.from, a.to))} on line ${lineOf(t.text(), a.from)} ${JSON.stringify(row.slice(0, 8))}, Zbeta moved ${JSON.stringify(want)}, ink ${JSON.stringify(got)}`);
			expect([t.text().slice(a.from, a.to), row.startsWith("| kilo ")], "on kilo's Zbeta").toEqual(["Zbeta", true]);
			expect(Math.abs(want.dy), "premise: kilo's row moved").toBeGreaterThan(5);
			expect(!!got && near(got.dx, want.dx) && near(got.dy, want.dy), `ink ${JSON.stringify(got)} on kilo's Zbeta ${JSON.stringify(want)}`).toBe(true);
		});
	}
});

describe("the cell under edit (the app's nested editor in the cell)", () => {
	it("beta's cell under edit, b1's type: the ink on beta read from the nested editor; then at rest, still on beta", async () => {
		const o = opNamed("b1-type"), path = "arm-under-edit.md", t = rig(path, o.before);
		const r = await t.tryAttach(t.circle(1, 1, "beta"));
		const was = t.wordAt(1, 1, "beta");
		t.relayout({ underEdit: [1, 1] });
		t.op(o);
		const now = t.wordAt(1, 1, "beta"), got = t.offset(r!.id);
		await note(`TABLE-ARM under edit: beta moved ${JSON.stringify({ dx: now.left - was.left, dy: now.top - was.top })}, ink ${JSON.stringify(got)}`);
		expect(!!got && near(got.dx, now.left - was.left) && near(got.dy, now.top - was.top), `under edit: ink ${JSON.stringify(got)}`).toBe(true);
		t.relayout({ underEdit: undefined });
		const rest = t.wordAt(1, 1, "beta"), again = t.offset(r!.id);
		expect(!!again && near(again.dx, rest.left - was.left) && near(again.dy, rest.top - was.top), `at rest: ink ${JSON.stringify(again)}`).toBe(true);
	});

	it("a circle around beta while its own cell is under edit, and around kilo while beta's cell is: each takes its word", async () => {
		const a = rig("arm-under-edit-self.md", T0, { underEdit: [1, 1] });
		const ra = await a.tryAttach(a.circle(1, 1, "beta"));
		const b = rig("arm-under-edit-other.md", T0, { underEdit: [1, 1] });
		const rb = await b.tryAttach(b.circle(1, 0, "kilo"));
		await note(`TABLE-ARM circled under edit: beta ${ra ? JSON.stringify(a.text().slice(ra.target.from, ra.target.to)) : "none"}, kilo ${rb ? JSON.stringify(b.text().slice(rb.target.from, rb.target.to)) : "none"}`);
		expect([ra && a.text().slice(ra.target.from, ra.target.to), rb && b.text().slice(rb.target.from, rb.target.to)]).toEqual(["beta", "kilo"]);
	});
});

describe("pin, on the recorded geometry: ink attached in a table before this fix draws where it drew", () => {
	// Saved as Attach made them at 1.5.0 to 1.5.2: the whole table as a paragraph, the first "|" as a word, each with its
	// reference at the widget's corner, which on the recorded widget is 16 px left of and above the first cell.
	const saved = (t: ReturnType<typeof rig>, path: string) => {
		const s = t.span(), text = t.text(), rec = inlineInk.record(path), c = t.overlay.view.coordsAtPos(s.from)!;
		const s1 = loop("s1", 100, 160, c.top + 60, c.top + 90), s2 = loop("s2", 10, 70, c.top + 100, c.top + 130);
		const at = { x: c.left, y: c.top }, layout = { width: SIG.width, font: SIG.fontPx };
		const records: AttachmentRecord[] = [
			{ v: 1, id: "att-table", strokeIds: ["s1"], target: targetAt(text, s.from, s.to, "paragraph"), ref: at, layout, probe: { id: "s1", x: s1.points[0]!.x, y: s1.points[0]!.y } },
			{ v: 1, id: "att-pipe", strokeIds: ["s2"], target: targetAt(text, s.from, s.from + 1, "range"), ref: at, layout, probe: { id: "s2", x: s2.points[0]!.x, y: s2.points[0]!.y } },
		];
		rec.strokes = [s1, s2];
		rec.basePage = { ...rec.basePage!, attachments: records.map((r) => ({ ...r, target: { ...r.target } })) };
		t.overlay.resolveAttachedText(path);
		return records;
	};

	it("at load and after a measure with no change: both at 0 px, targets as saved", () => {
		const path = "arm-saved.md", t = rig(path, T0), records = saved(t, path);
		t.overlay.requestFollowMeasure();
		t.relayout({});
		const now = inlineInk.attachments(path) as AttachmentRecord[];
		void note(`TABLE-ARM saved: offsets ${JSON.stringify([t.offset("att-table"), t.offset("att-pipe")])}`);
		expect(now.map((a) => a.target), "no load re-targets them").toEqual(records.map((r) => r.target));
		expect([t.offset("att-table"), t.offset("att-pipe")], "drawn where drawn").toEqual([{ dx: 0, dy: 0 }, { dx: 0, dy: 0 }]);
	});

	it("b1's type: today's result (both collapse at the table's start: the re-padded text holds neither saved context), never a cell or word target", () => {
		const o = opNamed("b1-type"), path = "arm-saved-b1.md", t = rig(path, o.before), records = saved(t, path), from = t.span().from;
		t.op(o);
		const now = (inlineInk.attachments(path) as AttachmentRecord[]).map((a) => [a.target.kind, a.target.from, a.target.to]);
		void note(`TABLE-ARM saved after b1: ${JSON.stringify(now)}, offsets ${JSON.stringify([t.offset("att-table"), t.offset("att-pipe")])}`);
		expect(now).toEqual([[records[0]!.target.kind, from, from], [records[1]!.target.kind, from, from]]);
		expect(t.offset("att-pipe"), "the pipe group stays put").toEqual({ dx: 0, dy: 0 });
	});

	it("a saved range inside the table across a pipe (\"beta gamma |\", two cells): read as today at load and after a measure, 0 px", () => {
		const path = "arm-saved-across.md", t = rig(path, T0), text = t.text(), rec = inlineInk.record(path);
		const from = text.indexOf("beta gamma |"), to = from + "beta gamma |".length, c = t.overlay.view.coordsAtPos(from)!;
		expect(from > t.span().from && to < t.span().to, "premise: inside the table, past its first position").toBe(true);
		const s = loop("s3", 100, 160, c.top + 60, c.top + 90);
		const record: AttachmentRecord = { v: 1, id: "att-across", strokeIds: ["s3"], target: targetAt(text, from, to, "range"), ref: { x: c.left, y: c.top }, layout: { width: SIG.width, font: SIG.fontPx }, probe: { id: "s3", x: s.points[0]!.x, y: s.points[0]!.y } };
		rec.strokes = [s];
		rec.basePage = { ...rec.basePage!, attachments: [{ ...record, target: { ...record.target } }] };
		t.overlay.resolveAttachedText(path);
		t.overlay.requestFollowMeasure();
		t.relayout({});
		void note(`TABLE-ARM saved across a pipe: offset ${JSON.stringify(t.offset("att-across"))}`);
		expect((inlineInk.attachments(path)[0] as AttachmentRecord).target, "not re-targeted").toEqual(record.target);
		expect(t.offset("att-across"), "drawn where drawn").toEqual({ dx: 0, dy: 0 });
	});
});

describe("cell 10: Reading view, an embed and Export to PDF after the edits above, as their render draws attached ink (shownStrokes)", () => {
	// Only Live Preview was recorded: Reading view's own table boxes are not on record. The read-only view here lays the
	// note out as the editor does (each text line its block, the table one block at the widget's box), so this measures
	// what the plugin hands those views, not Reading view's table geometry (named limit at handback).
	for (const name of ["b1-type", "b2-row-above"]) {
		it(`${name}: the ink drawn where the editor draws it, its anchor on the table's first line`, async () => {
			const o = opNamed(name), path = `arm-reading-${name}.md`, t = rig(path, o.before), [[r0, c0]] = BETA_AT[name]!;
			const word = name === "b1-type" ? "beta" : "Zbeta";
			const r = await t.tryAttach(t.circle(r0, c0, word));
			expect(r && t.text().slice(r.target.from, r.target.to), "premise").toBe(word);
			const before = t.anchors.follow.snapshot();
			t.hear.anchors = true;
			t.op(o);
			// The editor settles the moved group as its paint does (followMoved: the group's kept dx stamped, members whose dy
			// moved carried), draws the changed lines and measures them, then runs the old-ink pass once quiet, which takes each
			// member's anchor at the place its group shows it. The pass's window timer is caught here and fired.
			let pass: (() => void) | null = null;
			Object.assign(t.overlay, {
				attachedLayer: null, lineAnchorsMoved: () => {}, builder: null, router: null, lineOnScreen: () => true, applyColumnHold: () => {}, requestLineBoxes: () => {},
			});
			Object.defineProperty(t.overlay, "winRef", { value: { setTimeout: (f: () => void) => { pass = f; return 1; } } });
			InkOverlayPlugin.prototype.followMoved.call(t.overlay, path, before);
			const n = t.overlay.view.state.doc.lines;
			t.anchors.drawn(1, n);
			t.anchors.drawn(1, n, true, true);
			InkOverlayPlugin.prototype.armLineAnchorPass.call(t.overlay, path, 0);
			expect(pass, "the old-ink pass armed").not.toBeNull();
			(pass as unknown as () => void)();
			settleLineAnchors();
			const s = inlineInk.strokes(path)[0]!, editor = t.anchors.shownOf(s), off = t.offset(r!.id);
			const lines = t.text().split("\n"), sp = t.span(), top = t.topOf(sp.a), h = t.widget().height;
			const spans: LineSpans = {
				lines,
				skip: [],
				blocks: lines.flatMap((_, i) => {
					const n = i + 1;
					if (n === sp.a) return [{ lineStart: i, lineEnd: sp.b - 1, box: () => ({ top, height: h }), lineHeight: () => LH }];
					if (n > sp.a && n <= sp.b) return [];
					return [{ lineStart: i, lineEnd: i, box: () => ({ top: t.topOf(n), height: LH }), lineHeight: () => LH }];
				}),
			};
			const read = shownStrokes(inlineInk.strokes(path), spans, 1, null, inlineInk.attachments(path))[0]!;
			const d = { dx: read.bbox.x - editor.bbox.x, dy: read.bbox.y - editor.bbox.y };
			void note(`TABLE-ARM cell 10 ${name}: editor offset ${JSON.stringify(off)}, anchor line ${s.lineAnchor?.line} (table ${sp.a}), Reading view off the editor by ${JSON.stringify(d)}`);
			expect(s.lineAnchor?.line, "anchored on the table's first line").toBe(sp.a);
			expect(near(d.dx, 0) && near(d.dy, 0), `Reading view off by ${JSON.stringify(d)}`).toBe(true);
		});
	}
});

describe("cell 5 on the groups a real Attach saved before this fix: the whole table, never re-targeted", () => {
	// As the app saved them: beta, kilo and bold each attached as the whole table (paragraph 83-278), ref (-16, 77.99) at the
	// widget's corner, probes at (86.61, 150.79), (1.01, 150.79) and (86.61, 188.89): kept here as offsets from the ref.
	const RUN2 = [{ id: "att-beta", d: [102.61, 72.8] }, { id: "att-kilo", d: [17.01, 72.8] }, { id: "att-bold", d: [102.61, 110.9] }] as const;
	const saved = (t: ReturnType<typeof rig>, path: string) => {
		const s = t.span(), text = t.text(), rec = inlineInk.record(path), c = t.overlay.view.coordsAtPos(s.from)!;
		const strokes = RUN2.map((g) => loop(`s-${g.id}`, c.left + g.d[0], c.left + g.d[0] + 40, c.top + g.d[1] - 10, c.top + g.d[1] + 10));
		const layout = { width: SIG.width, font: SIG.fontPx };
		const records: AttachmentRecord[] = RUN2.map((g, i) => ({ v: 1, id: g.id, strokeIds: [strokes[i]!.id], target: targetAt(text, s.from, s.to, "paragraph"), ref: { x: c.left, y: c.top }, layout, probe: { id: strokes[i]!.id, x: strokes[i]!.points[0]!.x, y: strokes[i]!.points[0]!.y } }));
		rec.strokes = strokes;
		rec.basePage = { ...rec.basePage!, attachments: records.map((r) => ({ ...r, target: { ...r.target } })) };
		t.overlay.resolveAttachedText(path);
		return records;
	};

	it("at load and after a measure: all three at 0 px on the whole table", () => {
		const path = "arm-run2-load.md", t = rig(path, T0), records = saved(t, path);
		t.relayout({});
		const now = inlineInk.attachments(path) as AttachmentRecord[];
		void note(`TABLE-ARM run2 saved: offsets ${JSON.stringify(RUN2.map((g) => t.offset(g.id)))}`);
		expect(now.map((a) => a.target), "no load re-targets them").toEqual(records.map((r) => r.target));
		expect(RUN2.map((g) => t.offset(g.id)), "drawn where drawn").toEqual(RUN2.map(() => ({ dx: 0, dy: 0 })));
	});

	for (const o of FIX.ops) {
		it(`${o.name} (${o.what}): today's result, the three as one, never a word or a cell`, () => {
			const path = `arm-run2-${o.name}.md`, t = rig(path, o.before);
			saved(t, path);
			t.op(o);
			const now = (inlineInk.attachments(path) as AttachmentRecord[]).map((a) => a.target), from = t.span().from;
			const offs = RUN2.map((g) => t.offset(g.id));
			void note(`TABLE-ARM run2 after ${o.name}: ${JSON.stringify(now.map((a) => [a.kind, a.from, a.to]))}, offsets ${JSON.stringify(offs)}`);
			expect(now.map((a) => [a.kind, a.from, a.to]), "each collapsed at the table's start, as today").toEqual(RUN2.map(() => ["paragraph", from, from]));
			expect(offs.every((d) => JSON.stringify(d) === JSON.stringify(offs[0])), `one move for the three ${JSON.stringify(offs)}`).toBe(true);
		});
	}
});

/**
 * G2-17: a column moved, the column count kept. None of the six recorded edits moves a column (type,
 * row above, row removed, column before, row moved, sort), so each move here is modeled: one replace of the whole
 * table's text, the shape every recorded edit has, with the recorded table's columns reordered. The ink follows its word
 * to its column's new place, and its target is still its word, or its whole cell's text.
 */
describe("G2-17: a column moved, the count kept: the ink follows its word to its column's new place", () => {
	/** `table` with its column `from` moved to `to`, in every row. */
	const moveCol = (table: string, from: number, to: number) => table.split("\n").map((l) => {
		const c = l.split("|").slice(1, -1), [x] = c.splice(from, 1);
		c.splice(to, 0, x!);
		return `|${c.join("|")}|`;
	}).join("\n");
	const CASES: { name: string; what: string; from: number; to: number; word: string; at: [number, number]; now: [number, number] }[] = [
		{ name: "note-first", what: "beta's column moved to the left of Name", from: 1, to: 0, word: "beta", at: [1, 1], now: [1, 0] },
		{ name: "note-last", what: "beta's column moved to the right of Link", from: 1, to: 2, word: "beta", at: [1, 1], now: [1, 2] },
		{ name: "name-last", what: "Name moved to the right of Link, so beta's column is first", from: 0, to: 2, word: "beta", at: [1, 1], now: [1, 0] },
		{ name: "link-first-cell", what: "plain's column moved to the left of Name, a circle round its whole cell", from: 2, to: 0, word: "plain", at: [1, 2], now: [1, 0] },
	];
	for (const c of CASES) {
		it(`G2-17 ${c.name} (${c.what}): the circle round ${c.word} moves with it, and its target is still ${c.word}`, async () => {
			const path = `arm-g217-${c.name}.md`, t = rig(path, T0), [r0, c0] = c.at, [r1, c1] = c.now, after = moveCol(T0, c.from, c.to);
			const r = await t.tryAttach(t.circle(r0, c0, c.word));
			expect(r && t.text().slice(r.target.from, r.target.to).trim(), `premise: Attach took ${c.word}`).toBe(c.word);
			const was = t.wordAt(r0, c0, c.word);
			t.op({ name: c.name, what: c.what, before: T0, steps: [[{ from: 0, to: T0.length, insert: after, old: T0 }]] });
			const now = t.wordAt(r1, c1, c.word), want = { dx: now.left - was.left, dy: now.top - was.top }, got = t.offset(r!.id);
			const a = (inlineInk.attachments(path)[0] as AttachmentRecord).target, text = t.text().slice(a.from, a.to).trim();
			await note(`TABLE-ARM G2-17 ${c.name}: ${c.word} moved ${JSON.stringify(want)}, ink ${JSON.stringify(got)}, target ${a.kind} ${JSON.stringify(text)}`);
			expect(want.dx !== 0, `premise: the column move moves ${c.word} sideways (${JSON.stringify(want)})`).toBe(true);
			expect(text, `the target is still ${c.word}`).toBe(c.word);
			expect(!!got && near(got.dx, want.dx) && near(got.dy, want.dy), `ink ${JSON.stringify(got)} on ${c.word} ${JSON.stringify(want)}`).toBe(true);
		});
	}
});
