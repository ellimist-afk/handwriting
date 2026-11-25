/**
 * Ink attached to a word in a table cell follows that word, as ink attached to a word in a paragraph does.
 *
 * Alan, 2026-11-17: "need this as a bug fix: cant link drawings to text in a table." Product rule: attached ink follows
 * its word (Alan 11-08), the one exception to "ink never follows text", attached ink only.
 *
 * A bare overlay over a fake view, as AttachRangeTarget.test.ts builds it: text lines CW world px a character, LH high,
 * coordsAtPos giving a character's letters FH high, centred on its row. Live Preview draws a markdown table as one block
 * widget over the table's source lines (the height map has one block, not a text line). The widget is the DOM recorded
 * in the app (tableWidgetDom.testutil.ts: Obsidian 1.15.1, its cell wrappers, text nodes and geometry), under
 * view.contentDOM and reached by view.domAtPos, 16 px left of the text column as recorded. Its places through
 * coordsAtPos are CodeMirror's for a block widget with no coordsAt of its own (@codemirror/view 6.38.6
 * BlockWidgetView.coordsAt): the widget's whole rect, flattened to its left edge at its first position and to its right
 * edge everywhere else. Where a word sits in its cell is the DOM's (wordAt): the screen the user sees, which the cells
 * draw on. Source mode is the same note with every table line a text line.
 *
 * At a resting zoom other than 1 every screen px (the DOM's rects, coordsAtPos) is the zoom times its layout px; world
 * units are layout px, as AttachZoomRead.test.ts has it.
 */
import { describe, expect, it, vi } from "vitest";
import { appendFileSync } from "node:fs";
import { ChangeSet, Text } from "@codemirror/state";
import { BlockType, type ViewUpdate } from "@codemirror/view";
import { InkOverlayPlugin } from "./InkOverlay";
import { inlineInk } from "./InkOverlayRegistry";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { emptyPage } from "../model/PageData";
import { computeBBox, settleLineAnchors, type InkStroke } from "../ink/Stroke";
import { shownStrokes, tableMoves, type LineSpans } from "./EmbedInkLines";
import { SelectionModel } from "../objects/SelectionModel";
import { KNOWN_ATTACHMENT, isOpaqueAttachment, tableAround, targetAt, type AttachmentRecord } from "./InkAttachments";
import { ATTACH_STRINGS } from "./AttachDecoration";
import { FDoc, FEl, FNode, FRange, FText, SEPARATOR_ROW, TABLE_GEOM, splitRow, tableWidget, type Box, type TableOpts } from "./tableWidgetDom.testutil";
import { embedInkAnchorWatchCount, embedInkChanged, embedInkTileOf, initEmbedInkAttachments, initEmbedInkColumnWidth, initEmbedInkFontRef, initEmbedInkLineSignature, initEmbedInkRefresh, inkZoomOf, MARKER_ATTR, placeStrokes, teardownEmbedInk } from "./EmbedInk";
import { attachEmbedInk } from "./EmbedInkWatch";
import { embedInkIsSectionEmbed } from "./EmbedInkRoot";
import { printVectorFor } from "./EmbedInkPrint";
import { measureSpans, recordLines } from "./EmbedInkMeasure";
import { inkSvgLayers } from "../ink/SvgExport";
import { keptShownStrokes } from "./AttachFollow";
import { paragraphEl, readOnlyView, sectionsOf, VIEWS, type ViewKind, type ViewSection } from "./readOnlyTableDom.testutil";

/**
 * Each stroke an embed paint in a G2-13 cell hands the renderer, with its context and camera: `on` set by those cells
 * only, so every other cell draws through the renderer as the app does.
 */
const drawnBy = vi.hoisted(() => ({ on: null as null | ((ctx: unknown, cam: { zoom?: number }, s: { id: string; bbox: { x: number; y: number; width: number; height: number } }) => void) }));
vi.mock("../ink/StrokeRenderer", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../ink/StrokeRenderer")>();
	return { ...actual, drawStroke: (...a: Parameters<typeof actual.drawStroke>) => (drawnBy.on ? drawnBy.on(a[0], a[1], a[2]) : actual.drawStroke(...a)) };
});

/** Every notice shown, in order. */
const notices = vi.hoisted(() => ({ said: [] as string[] }));
vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	class Notice {
		constructor(message: string) {
			notices.said.push(message);
		}
	}
	return { ...actual, Notice };
});

const CW = 14, LH = 40, FH = 26, COLS = 60, WX = -16;
const SIG = { width: COLS * CW, fontPx: 26, charWidth: CW };
const LINES = [
	"Text above the table here",
	"",
	"| Name | Note |",
	"| --- | --- |",
	"| alpha | beta gamma |",
	"| delta | epsilon |",
	"",
	"Text below the table here",
];

declare module "node:fs" { export function appendFileSync(path: string, data: string): void; }
declare const process: { env: Record<string, string | undefined> };
/** HW_TABLE_ATTACH_OUT=<path>: each cell's TABLE-ATTACH line is appended there too (passing cells' console is not kept). */
const OUT = process.env.HW_TABLE_ATTACH_OUT ?? "";
const note = (line: string) => {
	console.log(line);
	if (OUT) appendFileSync(OUT, line + "\n");
};

/** A stroke through the given points, its box computed. */
function strokeOf(id: string, pts: [number, number][]): InkStroke {
	const points = pts.map(([x, y], i) => ({ x, y, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}
/** A loop around [x0, x1] x [y0, y1]. */
const loop = (id: string, x0: number, x1: number, y0: number, y1: number) =>
	strokeOf(id, [[x0, (y0 + y1) / 2], [(x0 + x1) / 2, y0], [x1, (y0 + y1) / 2], [(x0 + x1) / 2, y1], [x0 + 2, (y0 + y1) / 2]]);

type RigOpts = TableOpts & { zoom?: number };

function rig(path: string, strokes: InkStroke[], mode: "live" | "source", lines: readonly string[] = LINES, opts: RigOpts = {}) {
	const rec = inlineInk.record(path);
	rec.pageId = `page-${path}`;
	rec.basePage = { ...emptyPage(rec.pageId), attachments: [] };
	rec.attachments = undefined as unknown as typeof rec.attachments;
	rec.strokes = strokes;
	Object.defineProperty(inlineInk, "persist", { value: () => {}, configurable: true });
	const state = { doc: Text.of([...lines]) };
	const k = opts.zoom ?? 1;
	const tableOpts: TableOpts = { ...opts, scale: k };
	delete (tableOpts as RigOpts).zoom;
	let viewMode = mode;
	const fdoc = new FDoc();
	let reading = false;
	fdoc.reading = () => reading;
	/** The table's source lines now: the first run of lines holding a "|"; none in Source mode. */
	const table = () => {
		if (viewMode === "source") return null;
		let a = 0;
		for (let n = 1; n <= state.doc.lines; n++) if (state.doc.line(n).text.includes("|")) { a = n; break; }
		if (!a) return null;
		let b = a;
		while (b + 1 <= state.doc.lines && state.doc.line(b + 1).text.includes("|")) b++;
		const shown: number[] = [];
		for (let n = a; n <= b; n++) if (n !== a + 1 || !SEPARATOR_ROW.test(state.doc.line(n).text)) shown.push(n);
		return { a, b, shown, from: state.doc.line(a).from, to: state.doc.line(b).to };
	};
	const inTable = (n: number) => { const t = table(); return !!t && n >= t.a && n <= t.b; };
	/** Extra height on the first line: it re-wrapped at a new pane width, with no document change. */
	let firstLineExtra = 0;
	// One widget per document, mode and options: the same nodes for every read in a layout.
	let built: { key: unknown; opts: string; w: ReturnType<typeof tableWidget> } | null = null;
	const widget = () => {
		const t = table()!, o = JSON.stringify(tableOpts);
		if (built && built.key === state.doc && built.opts === o) return built.w;
		const src: string[] = [];
		for (let n = t.a; n <= t.b; n++) src.push(state.doc.line(n).text);
		let top = 0;
		for (let i = 1; i < t.a; i++) top += i === 1 ? LH + firstLineExtra : LH;
		built = { key: state.doc, opts: o, w: tableWidget(fdoc, src, WX, top, tableOpts) };
		return built.w;
	};
	const heightOf = (n: number) => {
		const t = table();
		if (t && n >= t.a && n <= t.b) return n === t.a ? widget().height : 0;
		return n === 1 ? LH + firstLineExtra : LH;
	};
	const topOf = (n: number) => {
		let top = 0;
		for (let i = 1; i < n; i++) top += heightOf(i);
		return top;
	};
	const blockOf = (n: number) => {
		const t = table();
		if (t && n >= t.a && n <= t.b) {
			const top = topOf(t.a), h = widget().height;
			return { from: t.from, to: t.to, top, bottom: top + h, height: h, type: BlockType.WidgetRange };
		}
		const line = state.doc.line(n), top = topOf(n), h = heightOf(n);
		return { from: line.from, to: line.to, top, bottom: top + h, height: h, type: BlockType.Text };
	};
	const blocks = () => {
		const out: ReturnType<typeof blockOf>[] = [];
		for (let n = 1; n <= state.doc.lines; n++) {
			const b = blockOf(n);
			if (!out.length || out[out.length - 1]!.from !== b.from) out.push(b);
		}
		return out;
	};
	// The editor's DOM: a .cm-line per text line, the widget in its place.
	const editorDom = new FEl("div", "cm-editor", fdoc), scroller = new FEl("div", "cm-scroller", fdoc), content = new FEl("div", "cm-content", fdoc);
	editorDom.append(scroller.append(content));
	const contentNow = () => {
		content.childNodes.length = 0;
		const t = table();
		for (let n = 1; n <= state.doc.lines; n++) {
			if (t && n === t.a) { const w = widget().el; w.parentNode = null; content.append(w); continue; }
			if (inTable(n)) continue;
			const line = new FEl("div", "cm-line", fdoc), top = topOf(n) * k, ft = new FText(state.doc.line(n).text, fdoc);
			line.rect = { left: 0, top, right: COLS * CW * k, bottom: top + LH * k, width: COLS * CW * k, height: LH * k, x: 0, y: top };
			const ty = top + ((LH - FH) / 2) * k;
			ft.chars = [...ft.data].map((_, i) => ({ left: i * CW * k, right: (i + 1) * CW * k, top: ty, bottom: ty + FH * k, width: CW * k, height: FH * k, x: i * CW * k, y: ty }));
			content.append(line.append(ft));
		}
		return content;
	};
	const xAt = (o: number) => o * CW;
	const layout = (): LineLayout => ({
		lines: state.doc.lines, lineText: (n) => state.doc.line(n).text, lineTop: (n) => (inTable(n) ? topOf(table()!.a) : topOf(n)), pxPerWorld: 1,
	});
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
		lineBlockAtHeight: (h: number) => {
			const all = blocks();
			for (const b of all) if (h < b.bottom) return b;
			return all[all.length - 1]!;
		},
		domAtPos: (pos: number) => {
			const c = contentNow(), n = state.doc.lineAt(pos).number;
			if (inTable(n)) return { node: c, offset: c.childNodes.indexOf(widget().el) };
			const line = c.childNodes.find((l) => l instanceof FEl && l.rect.top === topOf(n) * k) as FEl, ft = line.childNodes[0] as FText;
			return { node: ft, offset: pos - state.doc.line(n).from };
		},
		coordsAtPos: (pos: number) => {
			const t = table();
			if (t && pos >= t.from && pos <= t.to) {
				// A block widget with no coordsAt of its own: its whole rect, flattened to the left edge at its first position.
				const w = widget(), top = topOf(t.a), x = pos === t.from ? WX : WX + w.width;
				return { left: x * k, right: x * k, top: top * k, bottom: (top + w.height) * k };
			}
			const line = state.doc.lineAt(pos), left = xAt(pos - line.from), top = topOf(line.number) + (LH - FH) / 2;
			return { left: left * k, right: left * k, top: top * k, bottom: (top + FH) * k };
		},
		requestMeasure: (req: { read: () => unknown; write: (m: unknown) => void }) => {
			reading = true;
			let m: unknown;
			try { m = req.read(); } finally { reading = false; }
			req.write(m);
		},
		dispatch: noop,
		hasFocus: true,
		focus: noop,
	};
	const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
	Object.assign(overlay, {
		lineAnchorState: anchors,
		view,
		container: { getBoundingClientRect: () => ({ left: 0, top: 0, right: 1400, bottom: 1400, width: 1400, height: 1400 }) },
		inkInputPanX: () => 0,
		inkInputPanY: () => 0,
		pinchScaleNow: k,
		pinchRefScale: null,
		pinchPreview: false,
		cssScale: k,
		scale: k,
		fontZoom: 1,
		camera: { snapshot: { x: 0, y: 0, zoom: 1 }, screenToWorld: (x: number, y: number) => ({ x, y }) },
		filePath: () => path,
		strokesHere: () => anchors.strokesFor(path, inlineInk.strokes(path)),
		endLiveGestureForHistory: noop,
		scheduleRepaint: noop,
		repaintPath: noop,
		redrawSelectionUI: noop,
		lineAnchorsMoved: noop,
		followMoved: noop,
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
	/** Whether the line anchors hear each change first, as the editor's update does (the read-only cells read them; the rest read the follow alone). */
	const hear = { anchors: false };
	/** One transaction of `changes` (document positions), then the follow's measure. */
	const apply = (changes: { from: number; to: number; insert: string }[]) => {
		const set = ChangeSet.of(changes, state.doc.length);
		const startState = { doc: state.doc };
		state.doc = set.apply(state.doc);
		if (hear.anchors && anchors.tracks(path, inlineInk.strokes(path))) anchors.docChanged(path, inlineInk.strokes(path), startState.doc, set, state.doc);
		overlay.followDocChanged(path, { changes: set, startState, docChanged: true, state: { doc: state.doc } } as unknown as ViewUpdate);
		overlay.requestFollowMeasure();
	};
	const edit = (from: number, to: number, insert: string) => apply([{ from, to, insert }]);
	const attach = async (ids: string[]) => {
		selection.selectExactly(ids);
		expect(overlay.attachSelected(), "Attach is offered").toBe(true);
		await Promise.resolve();
		const list = inlineInk.attachments(path);
		expect(list, "Attach made one record").toHaveLength(1);
		return list[0] as AttachmentRecord;
	};
	const offset = (id: string) => anchors.follow.groupOffset(id);
	const text = () => state.doc.toString();
	/** Attach on the selection: its one record, or null when Attach is refused or makes none. */
	const tryAttach = async (ids: string[]) => {
		selection.selectExactly(ids);
		if (!overlay.attachSelected()) return null;
		await Promise.resolve();
		const list = inlineInk.attachments(path);
		return list.length === 1 ? (list[0] as AttachmentRecord) : null;
	};
	/** The first line re-wraps `extra` px taller with no document change: a layout change, then the follow's measure. */
	const rewrap = (extra: number) => {
		firstLineExtra = extra;
		anchors.follow.layoutChanged();
		overlay.requestFollowMeasure();
	};
	/** A layout change with no document change (a cell under edit, a scroll the editor measures): then the follow's measure. */
	const relayout = (o: TableOpts) => {
		Object.assign(tableOpts, o);
		anchors.follow.layoutChanged();
		overlay.requestFollowMeasure();
	};
	/** The table scrolled sideways with no editor measure (CodeMirror hears no nested scroll). */
	const scrollSideways = (x: number) => { tableOpts.scrollLeft = x; };
	/** Source mode or Live Preview: the editor lays the note out again, then the follow's measure. */
	const setMode = (m: "live" | "source") => {
		viewMode = m;
		built = null;
		anchors.follow.layoutChanged();
		overlay.requestFollowMeasure();
	};
	const world = (b: Box): Box => ({ left: b.left / k, top: b.top / k, right: b.right / k, bottom: b.bottom / k, width: b.width / k, height: b.height / k, x: b.x / k, y: b.y / k });
	/** Where `word` (its `nth` in the cell's shown text) is drawn now in shown row `row`, column `col`, world units. */
	const wordAt = (row: number, col: number, word: string, nth = 0): Box => {
		const td = widget().cell(row, col)!, texts: FText[] = [];
		const walk = (n: FEl | FText) => { if (n instanceof FText) { if (!n.hidden()) texts.push(n); } else n.childNodes.forEach((c) => walk(c as FEl | FText)); };
		walk(td);
		const all = texts.map((x) => x.data).join("");
		let i = -1;
		for (let j = 0; j <= nth; j++) i = all.indexOf(word, i + 1);
		if (i < 0) throw new Error(`no ${word} in row ${row} col ${col}: ${JSON.stringify(all)}`);
		let at = 0;
		for (const x of texts) {
			if (i < at + x.length) {
				const r = new FRange();
				r.setStart(x, i - at);
				r.setEnd(x, Math.min(x.length, i - at + word.length));
				return world(r.getClientRects()[0]!);
			}
			at += x.length;
		}
		throw new Error("unreachable");
	};
	/** A shown row's cell box, world units (0 the header). */
	const cellBox = (row: number, col: number): Box => world(widget().cell(row, col)!.rect);
	const rowTop = (row: number) => cellBox(row, 0).top;
	const colLeft = (col: number) => cellBox(0, col).left;
	const tableRight = () => world(widget().table.rect).right;
	/** A circle around `word` where it is drawn, inside its cell's height. */
	const circle = (row: number, col: number, word: string, nth = 0, id = "c") => {
		const b = wordAt(row, col, word, nth), td = cellBox(row, col);
		return loop(id, b.left - 4, b.right + 4, Math.max(td.top + 6, b.top - 4), Math.min(td.bottom - 6, b.bottom + 4));
	};
	/** The document position of the `nth` `word` on line `n`. */
	const posOf = (n: number, word: string, nth = 0) => {
		const l = state.doc.line(n);
		let i = -1;
		for (let j = 0; j <= nth; j++) i = l.text.indexOf(word, i + 1);
		if (i < 0) throw new Error(`no ${word} on line ${n}`);
		return l.from + i;
	};
	return { attach, tryAttach, apply, edit, rewrap, relayout, scrollSideways, setMode, offset, text, topOf, table, widget, wordAt, cellBox, rowTop, colLeft, tableRight, circle, posOf, overlay, anchors, selection, fdoc, view, hear };
}

type Rig = ReturnType<typeof rig>;
const near = (a: number, b: number, tol = 0.5) => Math.abs(a - b) <= tol;
/** The group's correction equals the word's move, within half a px. */
const onWord = (got: { dx: number; dy: number } | null, was: Box, now: Box) => !!got && near(got.dx, now.left - was.left) && near(got.dy, now.top - was.top);
const moved = (was: Box, now: Box) => ({ dx: +(now.left - was.left).toFixed(2), dy: +(now.top - was.top).toFixed(2) });
const ROW = LINES[4]!, BETA = ROW.indexOf("beta");
const lineFrom = (n: number, doc: string) => doc.split("\n").slice(0, n - 1).reduce((s, l) => s + l.length + 1, 0);
const textOf = (t: Rig, r: AttachmentRecord | null) => (r ? t.text().slice(r.target.from, r.target.to) : null);

describe("a drawing attached to a word in a table cell follows that word", () => {
	it("Live Preview: a circle around a word in a cell targets that word", async () => {
		const t = rig("table-target.md", [], "live");
		inlineInk.record("table-target.md").strokes = [t.circle(1, 1, "beta")];
		const r = await t.attach(["c"]);
		note(`TABLE-ATTACH live cell word: kind ${r.target.kind} from ${r.target.from} to ${r.target.to} text ${JSON.stringify(r.target.text)}`);
		expect([r.target.kind, r.target.text], "the circle's word").toEqual(["range", "beta"]);
	});

	it("Live Preview: text typed in front of the word in its cell moves the circle right with its word", async () => {
		const t = rig("table-type.md", [], "live");
		inlineInk.record("table-type.md").strokes = [t.circle(1, 1, "beta")];
		const r = await t.attach(["c"]);
		expect(t.offset(r.id), "premise: no correction at Attach").toEqual({ dx: 0, dy: 0 });
		const was = t.wordAt(1, 1, "beta"), at = lineFrom(5, t.text()) + BETA;
		t.edit(at, at, "big ");
		const now = t.wordAt(1, 1, "beta");
		note(`TABLE-ATTACH live typed in front: beta moved ${JSON.stringify(moved(was, now))}, offset ${JSON.stringify(t.offset(r.id))}`);
		expect(now.left - was.left, "premise: beta moved right").toBeGreaterThan(30);
		expect(onWord(t.offset(r.id), was, now), "the circle slides with its word").toBe(true);
	});

	it("Live Preview: a row added above the word's row moves the circle down one row", async () => {
		const t = rig("table-row.md", [], "live");
		inlineInk.record("table-row.md").strokes = [t.circle(1, 1, "beta")];
		const r = await t.attach(["c"]);
		const was = t.wordAt(1, 1, "beta"), at = lineFrom(5, t.text());
		t.edit(at, at, "| new | row |\n");
		const now = t.wordAt(2, 1, "beta");
		note(`TABLE-ATTACH live row above: beta moved ${JSON.stringify(moved(was, now))}, offset ${JSON.stringify(t.offset(r.id))}`);
		expect(onWord(t.offset(r.id), was, now), "the circle moves down with its word's row").toBe(true);
	});

	it("control: Live Preview, a line typed above the table moves the circle down one line", async () => {
		const t = rig("table-line-above.md", [], "live");
		inlineInk.record("table-line-above.md").strokes = [t.circle(1, 1, "beta")];
		const r = await t.attach(["c"]);
		t.edit(0, 0, "a new first line\n");
		expect(t.offset(r.id), "down one line").toEqual({ dx: 0, dy: LH });
	});

	it("observed: Live Preview, a box over a whole table row", async () => {
		const t = rig("table-whole-row.md", [], "live");
		inlineInk.record("table-whole-row.md").strokes = [loop("c", t.colLeft(0) - 4, t.tableRight() + 4, t.rowTop(1) + 4, t.rowTop(2) - 4)];
		const r = await t.tryAttach(["c"]);
		note(`TABLE-ATTACH live whole row: ${r ? `kind ${r.target.kind} from ${r.target.from} to ${r.target.to} text ${JSON.stringify(r.target.text)}` : "no record"}`);
	});

	it("observed: Live Preview, a circle around a word in the first column, away from the table's middle", async () => {
		const t = rig("table-alpha.md", [], "live");
		inlineInk.record("table-alpha.md").strokes = [t.circle(1, 0, "alpha")];
		const r = await t.tryAttach(["c"]);
		note(`TABLE-ATTACH live first column word: ${r ? `kind ${r.target.kind} from ${r.target.from} to ${r.target.to} text ${JSON.stringify(r.target.text.slice(0, 80))}` : "no record"}`);
	});

	it("control: Source mode, a circle around the same word on the table's source line targets it and slides with it", async () => {
		const t = rig("table-source.md", [], "source");
		const y = t.topOf(5);
		inlineInk.record("table-source.md").strokes = [loop("c", BETA * CW - 4, (BETA + 4) * CW + 4, y + 4, y + LH - 4)];
		const r = await t.attach(["c"]);
		expect([r.target.kind, r.target.text], "the circle's word").toEqual(["range", "beta"]);
		const at = lineFrom(5, t.text()) + BETA;
		t.edit(at, at, "big ");
		expect(t.offset(r.id), "the circle slides with its word").toEqual({ dx: 4 * CW, dy: 0 });
	});

	it("control: Live Preview, a word on the line just above the table and one just below each take their word", async () => {
		const above = rig("table-above.md", [], "live"), A = LINES[0]!.indexOf("table");
		inlineInk.record("table-above.md").strokes = [loop("c", A * CW - 4, (A + 5) * CW + 4, 4, LH - 4)];
		const ra = await above.attach(["c"]);
		expect([ra.target.kind, ra.target.text], "above").toEqual(["range", "table"]);
		const below = rig("table-below.md", [], "live"), B = LINES[7]!.indexOf("table"), y = below.topOf(8);
		inlineInk.record("table-below.md").strokes = [loop("c", B * CW - 4, (B + 5) * CW + 4, y + 4, y + LH - 4)];
		const rb = await below.attach(["c"]);
		expect([rb.target.kind, rb.target.text], "below").toEqual(["range", "table"]);
	});
});

/**
 * What a target must never be in a table: the whole table, a pipe at either end, a pipe inside it (a range over two
 * cells is neither a word nor a cell, and its two ends move apart when one column's width changes), or text off one
 * shown row's line. An escaped "\|" is a cell's own text, not a cell border.
 */
function tableTargetFaults(t: Rig, r: AttachmentRecord | null, rowLine: number): string[] {
	if (!r) return [];
	const T = t.table()!, text = t.text(), line = Text.of(text.split("\n")).line(rowLine), out: string[] = [];
	if (r.target.from <= T.from && r.target.to >= T.to) out.push(`the whole table (${r.target.kind} ${r.target.from}-${r.target.to})`);
	const s = text.slice(r.target.from, r.target.to).trim();
	if (s.startsWith("|") || s.endsWith("|")) out.push(`a pipe at an end: ${JSON.stringify(s)}`);
	else if (/(^|[^\\])\|/.test(s)) out.push(`a pipe inside, over two cells: ${JSON.stringify(s)}`);
	if (r.target.from < line.from || r.target.to > line.to) out.push(`off the row's line ${rowLine}: ${r.target.from}-${r.target.to}, line ${line.from}-${line.to}`);
	return out;
}

/**
 * Every position of the table read as the follow reads a point: the table's first position answers the widget's corner
 * (where ink attached in a table before this fix took its reference; the saved-group cells hold it there); every other one a place on
 * its own shown row (top inside the row's cells), or none. The separator row and the cells GFM does not draw read none.
 */
function placesOffTheirRow(t: Rig, noneLines: readonly number[] = []): string[] {
	const T = t.table()!, doc = Text.of(t.text().split("\n")), bad: string[] = [], corner = t.overlay.view.coordsAtPos(T.from)!;
	for (let pos = T.from; pos <= T.to; pos++) {
		const n = doc.lineAt(pos).number, row = T.shown.indexOf(n), ref = t.overlay.followRefAt(pos);
		if (pos === T.from) {
			if (!ref || !near(ref.x, corner.left) || !near(ref.y, corner.top)) bad.push(`pos ${pos} (the table's first): read ${JSON.stringify(ref)}, want the widget's corner`);
			continue;
		}
		if (!ref) continue;
		if (row < 0 || noneLines.includes(n)) bad.push(`pos ${pos} (line ${n}, not drawn): read ${ref.x},${ref.y}, want none`);
		else if (ref.y < t.rowTop(row) || ref.y >= t.cellBox(row, 0).bottom) bad.push(`pos ${pos} (line ${n}, row ${row}): y ${ref.y}, want ${t.rowTop(row)} to ${t.cellBox(row, 0).bottom}`);
	}
	return bad;
}

describe("a table position never reads the table's whole box, and a pipe or the separator row is never a target", () => {
	it("every position in the table reads a place on its own shown row, or none; the separator row reads none", () => {
		const t = rig("table-places.md", [], "live"), bad = placesOffTheirRow(t);
		note(`TABLE-ATTACH places off their row: ${bad.length} ${JSON.stringify(bad.slice(0, 3))}`);
		expect(bad, "places off their own row").toEqual([]);
	});

	it("a box over the border between two cells takes neither the whole table nor a pipe", async () => {
		const t = rig("table-border.md", [], "live");
		inlineInk.record("table-border.md").strokes = [loop("c", t.colLeft(1) - 20, t.colLeft(1) + 20, t.rowTop(1) + 6, t.rowTop(2) - 6)];
		const r = await t.tryAttach(["c"]);
		note(`TABLE-ATTACH live cell border: ${r ? `kind ${r.target.kind} from ${r.target.from} to ${r.target.to} text ${JSON.stringify(r.target.text.slice(0, 80))}` : "no record"}`);
		expect(tableTargetFaults(t, r, 5)).toEqual([]);
	});

	it("control: the target check faults a range over two cells and passes one word or one cell", () => {
		const t = rig("table-faults-check.md", [], "live"), text = t.text(), row = lineFrom(5, text), line = LINES[4]!;
		const rec = (from: number, to: number): AttachmentRecord =>
			({ v: 1, id: "x", strokeIds: [], target: targetAt(text, row + from, row + to, "range"), ref: { x: 0, y: 0 } }) as unknown as AttachmentRecord;
		const A = line.indexOf("alpha"), G = line.indexOf("gamma") + "gamma".length;
		expect(tableTargetFaults(t, rec(A, G), 5), "alpha | beta gamma").toEqual([`a pipe inside, over two cells: ${JSON.stringify(line.slice(A, G))}`]);
		expect(tableTargetFaults(t, rec(BETA, BETA + 4), 5), "beta").toEqual([]);
		expect(tableTargetFaults(t, rec(BETA, G), 5), "beta gamma, its cell").toEqual([]);
	});

	it("each word of the table, circled where it is shown, is the target: Attach's place reads at both ends of every word", async () => {
		// A word whose read is the table's whole box, or a place right at its top but as tall as the table, makes the
		// circle's row band the table's height, and the circle then takes words of other cells or the whole table.
		const words: { row: number; col: number; from: number; word: string; nth: number }[] = [];
		for (const [row, line] of [[0, 3], [1, 5], [2, 6]] as const) {
			const src = LINES[line - 1]!, start = lineFrom(line, LINES.join("\n"));
			let col = 0, at = 1;
			for (const cell of src.split("|").slice(1, -1)) {
				const lead = cell.length - cell.trimStart().length;
				for (const m of cell.trim().matchAll(/\S+/g)) words.push({ row, col, from: start + at + lead + m.index!, word: m[0], nth: 0 });
				at += cell.length + 1;
				col++;
			}
		}
		const bad: string[] = [];
		for (const w of words) {
			const path = `table-each-word-${w.row}-${w.col}-${w.word}.md`, t = rig(path, [], "live");
			inlineInk.record(path).strokes = [t.circle(w.row, w.col, w.word)];
			const r = await t.tryAttach(["c"]);
			const got = r ? [r.target.kind, r.target.from, r.target.to] : null;
			if (!r || r.target.kind !== "range" || r.target.from !== w.from || r.target.to !== w.from + w.word.length)
				bad.push(`${w.word} (row ${w.row} col ${w.col}): ${got ? `${got.join(" ")} ${JSON.stringify(r!.target.text.slice(0, 40))}` : "no record"}`);
		}
		note(`TABLE-ATTACH each word circled: ${words.length} words, ${bad.length} off ${JSON.stringify(bad.slice(0, 4))}`);
		expect(words.map((w) => w.word), "premise: the table's words").toEqual(["Name", "Note", "alpha", "beta", "gamma", "delta", "epsilon"]);
		expect(bad, "words whose circle does not take that word").toEqual([]);
	});

	it("a box over a whole table row takes neither the whole table, a pipe nor a range over two cells, and stays on that row", async () => {
		const t = rig("table-row-box.md", [], "live");
		inlineInk.record("table-row-box.md").strokes = [loop("c", t.colLeft(0) - 4, t.tableRight() + 4, t.rowTop(1) + 4, t.rowTop(2) - 4)];
		const r = await t.tryAttach(["c"]);
		note(`TABLE-ATTACH live row box: ${r ? `kind ${r.target.kind} from ${r.target.from} to ${r.target.to} text ${JSON.stringify(r.target.text.slice(0, 80))}` : "no record"}`);
		expect(tableTargetFaults(t, r, 5)).toEqual([]);
	});
});

/** A cell's whole text on its source line, as a range: what Attach takes when the box is not on that cell's words. */
const cellOn = (line: number, cell: string, lines: readonly string[] = LINES) => {
	const from = lineFrom(line, lines.join("\n")) + lines[line - 1]!.indexOf(cell);
	return ["range", from, from + cell.length, cell];
};
const got = (r: AttachmentRecord | null) => (r ? [r.target.kind, r.target.from, r.target.to, r.target.text] : null);
/** A box `w` x `h` centred on (cx, cy). */
const boxAt = (cx: number, cy: number, w: number, h: number) => loop("c", cx - w / 2, cx + w / 2, cy - h / 2, cy + h / 2);

describe("a box that is not one word in a table: its centre picks one cell", () => {
	// The box's centre picks one cell; in it, the words on the centre's row whose middle is inside the box. None, or a box
	// taller than 1.5 rows (the editor's line height): the cell's text. A centre on a border or in no cell: the nearest
	// cell, a dead-even tie the upper, then the left. An empty cell: nothing attaches, and Attach says "No text under the
	// ink" as today.
	const run = async (path: string, box: (t: Rig) => InkStroke, lines: readonly string[] = LINES) => {
		const t = rig(path, [], "live", lines);
		inlineInk.record(path).strokes = [box(t)];
		const r = await t.tryAttach(["c"]);
		note(`TABLE-ATTACH ${path.replace(/\.md$/, "")}: ${r ? `kind ${r.target.kind} from ${r.target.from} to ${r.target.to} text ${JSON.stringify(r.target.text.slice(0, 80))}` : "no record"}`);
		return r;
	};
	const mid1 = (t: Rig) => (t.rowTop(1) + t.rowTop(2)) / 2;

	it("a box inside a cell over no word's middle takes the cell's text", async () => {
		const r = await run("table-cell-blank-part.md", (t) => boxAt(t.wordAt(1, 1, "gamma").right + 10, mid1(t), 16, 20));
		expect(got(r)).toEqual(cellOn(5, "beta gamma"));
	});

	it("a box taller than 1.5 rows, centred in a cell, takes the cell's text", async () => {
		const r = await run("table-cell-tall.md", (t) => boxAt(t.wordAt(1, 1, "beta").left + 10, mid1(t), 80, 1.5 * LH + 8));
		expect(got(r)).toEqual(cellOn(5, "beta gamma"));
	});

	it("a box over a whole row takes the cell under its centre", async () => {
		const r = await run("table-cell-whole-row.md", (t) => loop("c", t.colLeft(0) - 4, t.tableRight() + 4, t.rowTop(1) + 4, t.rowTop(2) - 4));
		expect(got(r)).toEqual(cellOn(5, "beta gamma"));
	});

	it("a box over words of two cells takes the words of the cell under its centre", async () => {
		const r = await run("table-cell-two-cells.md", (t) => loop("c", t.wordAt(1, 0, "alpha").left - 4, t.wordAt(1, 1, "beta").right + 4, t.rowTop(1) + 6, t.rowTop(2) - 6));
		expect(got(r)).toEqual(cellOn(5, "alpha"));
	});

	it("a box over two rows, its centre in the upper, takes the cell under its centre", async () => {
		const r = await run("table-cell-two-rows.md", (t) => loop("c", t.wordAt(1, 1, "beta").left - 4, t.wordAt(1, 1, "gamma").right + 4, t.rowTop(1) + 4, t.rowTop(2) + 16));
		expect(got(r)).toEqual(cellOn(5, "beta gamma"));
	});

	it("a centre on the border between two columns, dead even: the left cell", async () => {
		const r = await run("table-cell-col-border.md", (t) => boxAt(t.colLeft(1), mid1(t), 40, 20));
		expect(got(r)).toEqual(cellOn(5, "alpha"));
	});

	it("a centre on the border between two rows, dead even: the upper cell", async () => {
		const r = await run("table-cell-row-border.md", (t) => boxAt(t.wordAt(1, 1, "gamma").right + 10, t.rowTop(2), 16, 20));
		expect(got(r)).toEqual(cellOn(5, "beta gamma"));
	});

	it("a centre just past a column border: the nearer cell", async () => {
		const r = await run("table-cell-near-border.md", (t) => boxAt(t.colLeft(1) + 3, mid1(t), 16, 20));
		expect(got(r)).toEqual(cellOn(5, "beta gamma"));
	});

	it("a centre in no cell, right of the table's last column: the nearest cell", async () => {
		const r = await run("table-cell-outside.md", (t) => boxAt(t.tableRight() + 30, mid1(t), 30, 20));
		expect(got(r)).toEqual(cellOn(5, "beta gamma"));
	});

	// A cell of three lines whose middle line is a word Attach cannot place: inline math, which draws no text of its own
	// (its glyphs come from CSS). A circle on that line takes the cell's text, never the line above's word: the cell's
	// lines sit closer (29.57 px) than the editor's line height the row band is sized by. Drawn centred on the line, and
	// 4 px high. Controls: the same cell's first word, and a plain b on the middle line.
	const MATH = LINES.map((l) => (l === "| alpha | beta gamma |" ? "| alpha | a<br>$b$<br>c |" : l));
	const PLAIN3 = LINES.map((l) => (l === "| alpha | beta gamma |" ? "| alpha | a<br>b<br>c |" : l));
	const onLine2 = (t: Rig, up: number) => {
		const a = t.wordAt(1, 1, "a");
		return boxAt(a.left - 4 + (3 * TABLE_GEOM.char + 8) / 2, (a.top + a.bottom) / 2 + TABLE_GEOM.wrapPitch - up, 3 * TABLE_GEOM.char + 8, a.bottom - a.top + 8);
	};
	for (const up of [0, 4]) {
		it(`a circle on a cell's middle line that holds no placed word (inline math), ${up} px high: the cell's text, not the line above's word`, async () => {
			const r = await run(`table-cell-unplaced-${up}.md`, (t) => onLine2(t, up), MATH);
			expect(got(r)).toEqual(cellOn(5, "a<br>$b$<br>c", MATH));
		});
	}
	it("control: in that cell, a circle around its first word takes the word", async () => {
		const r = await run("table-cell-unplaced-a.md", (t) => t.circle(1, 1, "a"), MATH);
		expect(r ? [r.target.kind, r.target.text] : null).toEqual(["range", "a"]);
	});
	it("control: a plain b on a cell's middle line: its circle takes b", async () => {
		const r = await run("table-cell-plain-b.md", (t) => t.circle(1, 1, "b"), PLAIN3);
		expect(r ? [r.target.kind, r.target.text] : null).toEqual(["range", "b"]);
	});
	// A one-line cell keeps the row band when one of its words is not placed: every line of the cell holds a placed word,
	// so the unplaced word shares a line with one. A box round beta, its centre 12 to 14 px above or below beta's middle
	// (past its letters' half height, inside the band), takes beta, with inline math after it and in the plain cell.
	const MATH1 = LINES.map((l) => (l === "| alpha | beta gamma |" ? "| alpha | beta gamma $x$ |" : l));
	const offBeta = (dy: number) => (t: Rig) => {
		const b = t.wordAt(1, 1, "beta"), w = 4 * TABLE_GEOM.char + 8;
		return boxAt(b.left - 4 + w / 2, (b.top + b.bottom) / 2 + dy, w, b.bottom - b.top + 8);
	};
	for (const c of [{ id: "math", lines: MATH1, name: "with inline math after it" }, { id: "plain", lines: LINES, name: "the plain cell" }]) {
		for (const dy of [-14, -12, 12, 13, 14]) {
			it(`a box round beta in a one-line cell, ${c.name}, its centre ${Math.abs(dy)} px ${dy < 0 ? "above" : "below"} beta's middle: takes beta`, async () => {
				const r = await run(`table-cell-off-beta-${c.id}-${dy < 0 ? "up" : "down"}${Math.abs(dy)}.md`, offBeta(dy), c.lines);
				expect(r ? [r.target.kind, r.target.text] : null).toEqual(["range", "beta"]);
			});
		}
	}

	it("an empty cell: nothing attaches, and Attach says there is no text under the ink", async () => {
		const lines = LINES.map((l) => (l === "| delta | epsilon |" ? "| delta | |" : l));
		const path = "table-cell-empty.md", t = rig(path, [], "live", lines);
		inlineInk.record(path).strokes = [boxAt(t.cellBox(2, 1).left + 30, (t.rowTop(2) + t.cellBox(2, 1).bottom) / 2, 30, 20)];
		notices.said.length = 0;
		// One tap of the Attach button: a refused Attach is told "No text under the ink" (toggleAttach).
		t.selection.selectExactly(["c"]);
		if (!t.overlay.attachSelected()) notices.said.push(ATTACH_STRINGS.noText);
		await Promise.resolve();
		await Promise.resolve();
		const list = inlineInk.attachments(path) as AttachmentRecord[];
		note(`TABLE-ATTACH table-cell-empty: ${JSON.stringify(list.map((a) => [a.target.kind, a.target.from, a.target.to, a.target.text.slice(0, 80)]))}; notices ${JSON.stringify(notices.said)}`);
		expect(list.map((a) => got(a)), "no group").toEqual([]);
		expect(notices.said, "today's notice").toContain(ATTACH_STRINGS.noText);
	});
});

describe("pin: the pin drop on a word in a table refuses, as today", () => {
	it("a group attached above the table: its pin dropped on a table word refuses and keeps the target", async () => {
		const path = "table-pin-drop.md", t = rig(path, [], "live"), A = LINES[0]!.indexOf("table");
		inlineInk.record(path).strokes = [loop("c", A * CW - 4, (A + 5) * CW + 4, 4, LH - 4)];
		const r = await t.attach(["c"]);
		const b = t.wordAt(1, 1, "beta");
		expect(t.overlay.dropAttachPin(r.id, { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 }), "the drop refuses").toBe(false);
		expect((inlineInk.attachments(path)[0] as AttachmentRecord).target, "the target kept").toEqual(r.target);
	});
});

/**
 * Source mode draws a table's lines as text lines, so a pin drop there would reach the word road: it can take a pipe,
 * the separator, a cell's padding (the whole row), a word with markup, or a word. Live Preview reads a pipe, the
 * separator, the row or a word with markup at the table widget's edge, so the circle would jump off its word there. A
 * pin drop on a table's line refuses, as on Live Preview's widget: false, the target kept, "No text under the ink". A
 * drop on a line outside the table still takes its word, in both modes.
 */
describe("pin: in Source mode, the pin drop on a table's line refuses, as on Live Preview's table", () => {
	const MARKED = LINES.map((l) => (l === "| alpha | beta gamma |" ? "| alpha | **beta** gamma |" : l));
	const A = LINES[0]!.indexOf("table");
	/** A rig with a group attached round "table" above the table, its record, and the middle of character `col` on line `n`. */
	const scene = async (path: string, mode: "live" | "source", lines: readonly string[]) => {
		const t = rig(path, [], mode, lines);
		inlineInk.record(path).strokes = [loop("c", A * CW - 4, (A + 5) * CW + 4, 4, LH - 4)];
		const r = await t.attach(["c"]);
		return { t, r, at: (n: number, col: number) => ({ x: col * CW + CW / 2, y: t.topOf(n) + LH / 2 }) };
	};
	/** The pin dropped at `w`, its measure's write run: whether the drop was taken, the target now, its text, the notices. */
	const drop = async (t: Rig, path: string, id: string, w: { x: number; y: number }) => {
		notices.said.length = 0;
		const took = t.overlay.dropAttachPin(id, w);
		await Promise.resolve();
		await Promise.resolve();
		const a = (inlineInk.attachments(path)[0] as AttachmentRecord).target;
		return { took, target: a, text: t.text().slice(a.from, a.to), said: [...notices.said] };
	};
	const CASES: { id: string; name: string; lines: readonly string[]; n: number; col: number; ch: string }[] = [
		{ id: "pipe", name: "a row's pipe", lines: LINES, n: 5, col: LINES[4]!.indexOf("|", 1), ch: "|" },
		{ id: "pad", name: "a cell's padding", lines: LINES, n: 5, col: LINES[4]!.indexOf("alpha") + 5, ch: " " },
		{ id: "sep", name: "the separator line", lines: LINES, n: 4, col: LINES[3]!.indexOf("---") + 1, ch: "-" },
		{ id: "word", name: "beta, a word in a cell", lines: LINES, n: 5, col: BETA + 1, ch: "e" },
		{ id: "marked", name: "**beta**, a word with markup", lines: MARKED, n: 5, col: MARKED[4]!.indexOf("beta") + 1, ch: "e" },
		{ id: "head", name: "Name, the header's word", lines: LINES, n: 3, col: LINES[2]!.indexOf("Name") + 1, ch: "a" },
	];
	for (const c of CASES) {
		it(`Source mode, the pin dropped on ${c.name}: refuses, the target kept`, async () => {
			const path = `table-pin-src-${c.id}.md`, { t, r, at } = await scene(path, "source", c.lines), w = at(c.n, c.col);
			const block = t.view.lineBlockAtHeight(w.y);
			expect([c.lines[c.n - 1]![c.col], block.type, block.from], "premise: the drop is on that character of a text line").toEqual([c.ch, BlockType.Text, t.view.state.doc.line(c.n).from]);
			const m = await drop(t, path, r.id, w);
			note(`TABLE-PIN source ${c.id}: took ${m.took}, target ${m.target.kind} ${JSON.stringify(m.text)}, notices ${JSON.stringify(m.said)}`);
			expect(m.took, "the drop refuses").toBe(false);
			expect(m.target, "the target kept").toEqual(r.target);
			expect(m.said, "today's notice").toContain(ATTACH_STRINGS.noText);
		});
	}
	for (const mode of ["source", "live"] as const) {
		it(`control: ${mode === "source" ? "Source mode" : "Live Preview"}, the pin dropped on "below", the line under the table: takes it`, async () => {
			const path = `table-pin-below-${mode}.md`, { t, r, at } = await scene(path, mode, LINES), B = LINES[7]!.indexOf("below");
			const m = await drop(t, path, r.id, at(8, B + 2));
			note(`TABLE-PIN ${mode} below: took ${m.took}, target ${m.target.kind} ${JSON.stringify(m.text)}, notices ${JSON.stringify(m.said)}`);
			expect(m.took, "the drop is taken").toBe(true);
			expect([m.target.kind, m.text], "its word").toEqual(["range", "below"]);
		});
	}
});

describe("pin: ink attached in a table before this fix draws where it drew", () => {
	// Saved as Attach made them at 1.5.0 to 1.5.2: the whole table as a paragraph, or the table's first "|" as a word, each
	// with its reference point at the widget's corner (the block widget's place at its first position).
	const saved = (t: Rig, path: string) => {
		const T = t.table()!, text = t.text(), rec = inlineInk.record(path), c = t.overlay.view.coordsAtPos(T.from)!;
		const s1 = t.circle(1, 1, "beta", 0, "s1"), s2 = t.circle(2, 0, "delta", 0, "s2");
		const at = { x: c.left, y: c.top }, layout = { width: SIG.width, font: SIG.fontPx };
		const records: AttachmentRecord[] = [
			{ v: 1, id: "att-table", strokeIds: ["s1"], target: targetAt(text, T.from, T.to, "paragraph"), ref: at, layout, probe: { id: "s1", x: s1.points[0]!.x, y: s1.points[0]!.y } },
			{ v: 1, id: "att-pipe", strokeIds: ["s2"], target: targetAt(text, T.from, T.from + 1, "range"), ref: at, layout, probe: { id: "s2", x: s2.points[0]!.x, y: s2.points[0]!.y } },
		];
		rec.strokes = [s1, s2];
		rec.basePage = { ...rec.basePage!, attachments: records.map((r) => ({ ...r, target: { ...r.target } })) };
		t.overlay.resolveAttachedText(path);
		return records;
	};

	it("at load: both groups at 0 px, their targets as saved", () => {
		const path = "table-saved-load.md", t = rig(path, [], "live"), records = saved(t, path);
		const now = inlineInk.attachments(path) as AttachmentRecord[];
		note(`TABLE-ATTACH saved at load: offsets ${JSON.stringify([t.offset("att-table"), t.offset("att-pipe")])}`);
		expect(now.map((a) => a.target), "no load re-targets them").toEqual(records.map((r) => r.target));
		expect([t.offset("att-table"), t.offset("att-pipe")], "drawn where drawn").toEqual([{ dx: 0, dy: 0 }, { dx: 0, dy: 0 }]);
	});

	it("text typed in a cell: both stay at 0 px on their saved targets; a line typed above the table: both one line down", () => {
		const path = "table-saved-edit.md", t = rig(path, [], "live"), records = saved(t, path);
		const at = lineFrom(5, t.text()) + BETA;
		t.edit(at, at, "big ");
		const now = inlineInk.attachments(path) as AttachmentRecord[];
		note(`TABLE-ATTACH saved after a cell edit: offsets ${JSON.stringify([t.offset("att-table"), t.offset("att-pipe")])}`);
		expect(now.map((a) => [a.target.kind, a.target.from]), "the same targets").toEqual(records.map((r) => [r.target.kind, r.target.from]));
		expect([t.offset("att-table"), t.offset("att-pipe")], "a cell edit moves neither").toEqual([{ dx: 0, dy: 0 }, { dx: 0, dy: 0 }]);
		t.edit(0, 0, "a new first line\n");
		expect([t.offset("att-table"), t.offset("att-pipe")], "a line above moves both down one line").toEqual([{ dx: 0, dy: LH }, { dx: 0, dy: LH }]);
	});

	it("the line above re-wraps taller with no document change: both follow the table down, as today", () => {
		// No edit, so no group is moved by its block's top in the change; the measure's read of the table's first position
		// is the only thing that moves them. A read of none there leaves them where they were.
		const path = "table-saved-rewrap.md", t = rig(path, [], "live");
		saved(t, path);
		t.overlay.requestFollowMeasure();
		const top = t.topOf(t.table()!.a);
		t.rewrap(LH);
		note(`TABLE-ATTACH saved after a re-wrap above: table top ${top} to ${t.topOf(t.table()!.a)}, offsets ${JSON.stringify([t.offset("att-table"), t.offset("att-pipe")])}`);
		expect(t.topOf(t.table()!.a) - top, "premise: the table moved down").toBe(LH);
		expect([t.offset("att-table"), t.offset("att-pipe")], "both with the table").toEqual([{ dx: 0, dy: LH }, { dx: 0, dy: LH }]);
	});

	it("the whole table's text replaced by itself with a cell edited: today's result, never a new target in a cell", () => {
		// A rewrite of the whole table: both saved targets collapse at the table's start, as any replace of a target's whole
		// text does today. The whole table's old text is gone, so it stays collapsed (needs reattachment); the first "|"
		// with its context is in the new text, so it is found again where it was saved. Neither becomes a word or a cell.
		const path = "table-saved-rewrite.md", t = rig(path, [], "live"), records = saved(t, path), T = t.table()!;
		const old = t.text().slice(T.from, T.to), at = LINES[4]!.indexOf("beta") + lineFrom(5, t.text()) - T.from;
		t.edit(T.from, T.to, old.slice(0, at) + "big " + old.slice(at));
		const now = (inlineInk.attachments(path) as AttachmentRecord[]).map((a) => [a.target.kind, a.target.from, a.target.to]);
		note(`TABLE-ATTACH saved after a whole-table rewrite: ${JSON.stringify(now)}`);
		expect(now, "the whole table collapsed at its start; the first pipe found again as saved").toEqual([
			[records[0]!.target.kind, T.from, T.from],
			[records[1]!.target.kind, records[1]!.target.from, records[1]!.target.to],
		]);
	});
});

/** Attach a circle around `word` in shown row `row`, column `col`: the rig and its record (null when none). */
async function attachedOn(path: string, word: string, row: number, col: number, lines: readonly string[] = LINES, opts: RigOpts = {}) {
	const t = rig(path, [], "live", lines, opts);
	inlineInk.record(path).strokes = [t.circle(row, col, word)];
	const r = await t.tryAttach(["c"]);
	return { t, r };
}

describe("a wrapped earlier cell does not end the word walk before the circled word", () => {
	const lines = LINES.map((l) => (l === "| alpha | beta gamma |" ? "| one two three four five six | beta gamma |" : l));
	for (const valign of ["top", "middle"] as const) {
		it(`column 1 wraps to 3 rows, a circle around beta in column 2, the cells aligned ${valign}: the target is beta`, async () => {
			const { t, r } = await attachedOn(`table-t1-${valign}.md`, "beta", 1, 1, lines, { wrapAt: { 0: 120 }, valign });
			const rows = new Set(["one", "three", "five"].map((w) => t.wordAt(1, 0, w).top)).size;
			note(`TABLE-ATTACH wrapped ${valign}: column 1 in ${rows} rows, target ${JSON.stringify(textOf(t, r))}`);
			expect(rows, "premise: column 1 wraps to 3 rows").toBe(3);
			expect(textOf(t, r)).toBe("beta");
		});
	}
});

describe("an edit after the word that still moves it", () => {
	it("(a) a later row's cell in column 1 typed longer than any above, as a local insert: the ink on beta, right by the column's growth", async () => {
		const { t, r } = await attachedOn("table-t2a.md", "beta", 1, 1);
		expect(textOf(t, r), "premise").toBe("beta");
		const was = t.wordAt(1, 1, "beta"), at = t.posOf(6, "delta");
		t.edit(at, at, "extralongword ");
		const now = t.wordAt(1, 1, "beta");
		note(`TABLE-ATTACH edit after, local: beta moved ${JSON.stringify(moved(was, now))}, ink ${JSON.stringify(t.offset(r!.id))}`);
		expect(now.left - was.left, "premise: beta moved right").toBeGreaterThan(50);
		expect(onWord(t.offset(r!.id), was, now)).toBe(true);
	});

	it("(a) the same, written as the app writes a table edit (one replace of the whole table): the ink on beta", async () => {
		const { t, r } = await attachedOn("table-t2a-whole.md", "beta", 1, 1);
		const was = t.wordAt(1, 1, "beta"), T = t.table()!, old = t.text().slice(T.from, T.to);
		t.edit(T.from, T.to, old.replace("| delta |", "| extralongword delta |"));
		const now = t.wordAt(1, 1, "beta");
		note(`TABLE-ATTACH edit after, whole: beta moved ${JSON.stringify(moved(was, now))}, ink ${JSON.stringify(t.offset(r!.id))}, target ${JSON.stringify(textOf(t, inlineInk.attachments("table-t2a-whole.md")[0] as AttachmentRecord))}`);
		expect(textOf(t, inlineInk.attachments("table-t2a-whole.md")[0] as AttachmentRecord), "still beta").toBe("beta");
		expect(onWord(t.offset(r!.id), was, now)).toBe(true);
	});

	it("(b) the cell right of the word wraps to 2 rows: the ink on beta, down with its centred row", async () => {
		const lines = ["Text above the table here", "", "| Name | Note | More |", "| --- | --- | --- |", "| alpha | beta gamma | x |", "| delta | epsilon | y |", "", "Text below"];
		const { t, r } = await attachedOn("table-t2b.md", "beta", 1, 1, lines, { wrapAt: { 2: 100 }, valign: "middle" });
		expect(textOf(t, r), "premise").toBe("beta");
		const was = t.wordAt(1, 1, "beta"), at = t.posOf(5, "x") + 1;
		t.edit(at, at, " more words here to wrap");
		const now = t.wordAt(1, 1, "beta");
		note(`TABLE-ATTACH edit after, row: beta moved ${JSON.stringify(moved(was, now))}, ink ${JSON.stringify(t.offset(r!.id))}`);
		expect(now.top - was.top, "premise: beta moved down").toBeGreaterThan(5);
		expect(onWord(t.offset(r!.id), was, now)).toBe(true);
	});

	it("(b, as recorded) the same, the cells top-aligned as the app draws them (as recorded in the app): beta stays at its row's top, the ink stays on it", async () => {
		const lines = ["Text above the table here", "", "| Name | Note | More |", "| --- | --- | --- |", "| alpha | beta gamma | x |", "| delta | epsilon | y |", "", "Text below"];
		const { t, r } = await attachedOn("table-t2b-top.md", "beta", 1, 1, lines, { wrapAt: { 2: 100 }, valign: "top" });
		expect(textOf(t, r), "premise").toBe("beta");
		const was = t.wordAt(1, 1, "beta"), at = t.posOf(5, "x") + 1, row = t.rowTop(1);
		t.edit(at, at, " more words here to wrap");
		const now = t.wordAt(1, 1, "beta");
		note(`TABLE-ATTACH edit after, row top-aligned: beta moved ${JSON.stringify(moved(was, now))}, ink ${JSON.stringify(t.offset(r!.id))}`);
		expect(t.rowTop(2) - row, "premise: the row grew past one line").toBeGreaterThan(TABLE_GEOM.rowH + 5);
		expect(onWord(t.offset(r!.id), was, now)).toBe(true);
	});
});

describe("a wide table scrolled sideways", () => {
	const wide = LINES.map((l) => (l === "| alpha | beta gamma |" ? "| alpha | beta gamma | a very long third cell that runs on past the pane's right edge |" : l === "| Name | Note |" ? "| Name | Note | Third |" : l === "| --- | --- |" ? "| --- | --- | --- |" : l === "| delta | epsilon |" ? "| delta | epsilon | z |" : l));

	it("Attach at a sideways scroll of 120 px; the note shown again at 0: the ink on its word", async () => {
		const { t, r } = await attachedOn("table-t3.md", "beta", 1, 1, wide, { scrollLeft: 120, width: 600 });
		expect(textOf(t, r), "premise").toBe("beta");
		const was = t.wordAt(1, 1, "beta");
		t.relayout({ scrollLeft: 0 });
		const now = t.wordAt(1, 1, "beta");
		note(`TABLE-ATTACH scroll reload at 0: beta moved ${JSON.stringify(moved(was, now))}, ink ${JSON.stringify(t.offset(r!.id))}`);
		expect(onWord(t.offset(r!.id), was, now)).toBe(true);
	});

	it("a sideways scroll after Attach: the ink holds until the next measure, then is on its word", async () => {
		const { t, r } = await attachedOn("table-t3-scroll.md", "beta", 1, 1, wide, { width: 600 });
		expect(textOf(t, r), "premise").toBe("beta");
		const was = t.wordAt(1, 1, "beta");
		t.scrollSideways(60);
		const held = t.offset(r!.id);
		t.relayout({});
		const now = t.wordAt(1, 1, "beta");
		note(`TABLE-ATTACH scroll scroll: held ${JSON.stringify(held)}, after the next measure ${JSON.stringify(t.offset(r!.id))}, beta moved ${JSON.stringify(moved(was, now))}`);
		expect(held, "held: no measure hears a sideways scroll").toEqual({ dx: 0, dy: 0 });
		expect(onWord(t.offset(r!.id), was, now), "on its word at the next measure").toBe(true);
	});
});

describe("the row shapes the source-to-cell map reads", () => {
	const swap = (from: string, to: string, lines: readonly string[] = LINES) => lines.map((l) => (l === from ? to : l));

	it("rows with no outer pipes: a circle around beta takes beta; every position on its row or none", async () => {
		const lines = ["Text above the table here", "", "Name | Note", "--- | ---", "alpha | beta gamma", "delta | epsilon", "", "Text below the table here"];
		const { t, r } = await attachedOn("table-t9-no-pipes.md", "beta", 1, 1, lines);
		const bad = placesOffTheirRow(t);
		note(`TABLE-ATTACH shape no outer pipes: ${JSON.stringify(textOf(t, r))}, ${bad.length} places off ${JSON.stringify(bad.slice(0, 2))}`);
		expect(textOf(t, r)).toBe("beta");
		expect(bad).toEqual([]);
	});

	it("a row with fewer cells than the header: its word is taken; a box over the missing cell attaches nothing", async () => {
		const lines = swap("| delta | epsilon |", "| delta |");
		const { t, r } = await attachedOn("table-t9-fewer.md", "delta", 2, 0, lines);
		expect(textOf(t, r), "the word in the short row").toBe("delta");
		const u = rig("table-t9-fewer-missing.md", [], "live", lines), c = u.cellBox(2, 1);
		inlineInk.record("table-t9-fewer-missing.md").strokes = [boxAt(c.left + 30, (c.top + c.bottom) / 2, 30, 20)];
		const m = await u.tryAttach(["c"]);
		note(`TABLE-ATTACH shape fewer cells: delta ${JSON.stringify(textOf(t, r))}, missing cell ${m ? JSON.stringify(textOf(u, m)) : "no record"}`);
		expect(m, "the missing cell: nothing").toBeNull();
	});

	it("a row with more cells than the header: the extra cell reads none, and beta is taken", async () => {
		const lines = swap("| alpha | beta gamma |", "| alpha | beta gamma | extra |");
		const { t, r } = await attachedOn("table-t9-more.md", "beta", 1, 1, lines);
		const extra = t.posOf(5, "extra"), reads = [0, 1, 2, 3, 4].map((i) => t.overlay.followRefAt(extra + i));
		note(`TABLE-ATTACH shape more cells: ${JSON.stringify(textOf(t, r))}, extra reads ${JSON.stringify(reads)}`);
		expect(textOf(t, r)).toBe("beta");
		expect(reads, "the extra cell is not drawn").toEqual([null, null, null, null, null]);
	});

	it("an escaped pipe in a cell: one cell, its word not split", async () => {
		const lines = swap("| alpha | beta gamma |", "| al\\|pha | beta gamma |");
		const { t, r } = await attachedOn("table-t9-escaped.md", "al|pha", 1, 0, lines);
		const { t: u, r: b } = await attachedOn("table-t9-escaped-beta.md", "beta", 1, 1, lines);
		note(`TABLE-ATTACH shape escaped pipe: ${JSON.stringify(textOf(t, r))}, beta ${JSON.stringify(textOf(u, b))}`);
		expect(textOf(t, r)).toBe("al\\|pha");
		expect(textOf(u, b)).toBe("beta");
	});

	it("a wikilink alias and a sized embed (markup with an escaped pipe): their cell", async () => {
		const alias = swap("| alpha | beta gamma |", "| [[alpha\\|al]] | beta gamma |");
		const { t, r } = await attachedOn("table-t9-alias.md", "al", 1, 0, alias);
		const embed = swap("| alpha | beta gamma |", "| ![[p.png\\|100]] | beta gamma |");
		const { t: u, r: e } = await attachedOn("table-t9-embed.md", "p.png", 1, 0, embed);
		note(`TABLE-ATTACH shape alias ${JSON.stringify(textOf(t, r))}, embed ${JSON.stringify(textOf(u, e))}`);
		// A cell target starts at its cell's first drawn character: the alias's "al", and the embed's first character after
		// its hidden "![[" (the text only; no screen shows it).
		expect(textOf(t, r)).toBe("al]]");
		expect(textOf(u, e)).toBe("p.png\\|100]]");
	});

	it("a <br> in a cell: the word after it reads its cell's second row, and its circle takes it", async () => {
		const lines = swap("| alpha | beta gamma |", "| alpha | beta<br>gamma |");
		const { t, r } = await attachedOn("table-t9-br.md", "gamma", 1, 1, lines);
		const b = t.overlay.followRefAt(t.posOf(5, "beta")), g = t.overlay.followRefAt(t.posOf(5, "gamma")), drawn = t.wordAt(1, 1, "gamma");
		note(`TABLE-ATTACH shape br: ${JSON.stringify(textOf(t, r))}, beta read ${JSON.stringify(b)}, gamma read ${JSON.stringify(g)}, gamma drawn ${drawn.left},${drawn.top}`);
		expect(textOf(t, r)).toBe("gamma");
		expect(!!g && near(g.x, drawn.left) && near(g.y, drawn.top), "gamma's read is its second-row place").toBe(true);
		expect(!!b && !!g && g.y - b.y > 20, "a row below beta").toBe(true);
	});

	it("alignment colons in the separator: never a word, read none; beta still taken", async () => {
		const lines = swap("| --- | --- |", "| :---: | ---: |");
		const { t, r } = await attachedOn("table-t9-colons.md", "beta", 1, 1, lines);
		const bad = placesOffTheirRow(t);
		note(`TABLE-ATTACH shape colons: ${JSON.stringify(textOf(t, r))}, ${bad.length} places off`);
		expect(textOf(t, r)).toBe("beta");
		expect(bad).toEqual([]);
	});
});

describe("cell 6: Source mode to Live Preview and back", () => {
	it("attached in Live Preview: on its word in Source mode, and again in Live Preview", async () => {
		const { t, r } = await attachedOn("table-c6.md", "beta", 1, 1);
		expect(textOf(t, r), "premise").toBe("beta");
		const live = t.wordAt(1, 1, "beta");
		t.setMode("source");
		const src = { left: BETA * CW, top: t.topOf(5) + (LH - FH) / 2 }, inSource = t.offset(r!.id);
		t.setMode("live");
		const back = t.offset(r!.id);
		note(`TABLE-ATTACH cell 6: Source ${JSON.stringify(inSource)} (beta at ${src.left},${src.top}, was ${live.left},${live.top}), Live Preview again ${JSON.stringify(back)}`);
		expect(!!inSource && near(inSource.dx, src.left - live.left) && near(inSource.dy, src.top - live.top), "on beta in Source mode").toBe(true);
		expect(!!back && near(back.dx, 0) && near(back.dy, 0), "on beta in Live Preview").toBe(true);
	});

	it("text typed in front of the word in Source mode, then Live Preview: on its word", async () => {
		const { t, r } = await attachedOn("table-c6-edit.md", "beta", 1, 1);
		const was = t.wordAt(1, 1, "beta");
		t.setMode("source");
		const at = t.posOf(5, "beta");
		t.edit(at, at, "big ");
		t.setMode("live");
		const now = t.wordAt(1, 1, "beta");
		note(`TABLE-ATTACH cell 6 Source edit: beta moved ${JSON.stringify(moved(was, now))}, ink ${JSON.stringify(t.offset(r!.id))}`);
		expect(onWord(t.offset(r!.id), was, now)).toBe(true);
	});

	// A whole-cell link (a cell with markup, taken whole) is read at its cell's first drawn character in both modes, so
	// the ink stays on the same letters: beta's, not the "**" Source mode shows in front of it.
	const BOLD = LINES.map((l) => (l === "| alpha | beta gamma |" ? "| alpha | **beta** [gamma](g.md) |" : l));
	const BOLD_BETA = BOLD[4]!.indexOf("beta");
	it("a whole-cell link attached in Live Preview: on beta's letters in Source mode, and again in Live Preview", async () => {
		const { t, r } = await attachedOn("table-c6-whole.md", "beta", 1, 1, BOLD);
		expect(textOf(t, r), "premise: the link is the cell's text from its first drawn character").toBe("beta** [gamma](g.md)");
		const live = t.wordAt(1, 1, "beta");
		t.setMode("source");
		const src = { left: BOLD_BETA * CW, top: t.topOf(5) + (LH - FH) / 2 }, inSource = t.offset(r!.id);
		t.setMode("live");
		const back = t.offset(r!.id);
		note(`TABLE-ATTACH cell 6 whole-cell: Source ${JSON.stringify(inSource)} (beta at ${src.left},${src.top}, was ${live.left},${live.top}), Live Preview again ${JSON.stringify(back)}`);
		expect(!!inSource && near(inSource.dx, src.left - live.left) && near(inSource.dy, src.top - live.top), `on beta in Source mode (${JSON.stringify(inSource)})`).toBe(true);
		expect(!!back && near(back.dx, 0) && near(back.dy, 0), `on beta in Live Preview (${JSON.stringify(back)})`).toBe(true);
	});
	it("a whole-cell link attached in Source mode: on beta in Live Preview, and no move back in Source mode", async () => {
		const path = "table-c6-whole-src.md", t = rig(path, [], "source", BOLD), x0 = BOLD_BETA * CW;
		inlineInk.record(path).strokes = [loop("c", x0 - 4, x0 + 4 * CW + 4, t.topOf(5) + 4, t.topOf(5) + LH - 4)];
		const r = await t.tryAttach(["c"]);
		expect(textOf(t, r), "premise: the Source-mode target is the cell's text from its first drawn character").toBe("beta** [gamma](g.md)");
		const src = { left: x0, top: t.topOf(5) + (LH - FH) / 2 };
		t.setMode("live");
		const live = t.wordAt(1, 1, "beta"), inLive = t.offset(r!.id);
		t.setMode("source");
		const again = t.offset(r!.id);
		note(`TABLE-ATTACH cell 6 whole-cell Source attach: Live Preview ${JSON.stringify(inLive)} (beta at ${live.left},${live.top}, was ${src.left},${src.top}), Source again ${JSON.stringify(again)}`);
		expect(!!inLive && near(inLive.dx, live.left - src.left) && near(inLive.dy, live.top - src.top), `on beta in Live Preview (${JSON.stringify(inLive)})`).toBe(true);
		expect(!!again && near(again.dx, 0) && near(again.dy, 0), `no move in Source mode (${JSON.stringify(again)})`).toBe(true);
	});

	// A read phase builds the note's whole text at most once, however many attached groups on table lines it reads in
	// Source mode (each such read looks for its cell in the text): four groups in two rows, read in the width measure's
	// one phase and in one follow measure.
	it("text builds: Source mode reads four table groups with at most one whole-note text per read phase", async () => {
		const path = "table-c6-builds.md", t = rig(path, [], "source");
		const words: [number, string][] = [[5, "alpha"], [5, "beta"], [6, "delta"], [6, "epsilon"]];
		inlineInk.record(path).strokes = words.map(([n, w], i) => {
			const x0 = (t.posOf(n, w) - t.view.state.doc.line(n).from) * CW;
			return loop(`c${i}`, x0 - 4, x0 + w.length * CW + 4, t.topOf(n) + 4, t.topOf(n) + LH - 4);
		});
		for (let i = 0; i < words.length; i++) {
			t.selection.selectExactly([`c${i}`]);
			expect(t.overlay.attachSelected(), `Attach is offered for ${words[i]![1]}`).toBe(true);
			await Promise.resolve();
		}
		const list = inlineInk.attachments(path).filter((a): a is AttachmentRecord => !isOpaqueAttachment(a));
		const onTable = list.filter((a) => t.view.state.doc.lineAt(a.target.from).text.includes("|"));
		expect(onTable.length, `premise: four groups on table lines (${JSON.stringify(list.map((a) => a.target))})`).toBe(4);
		const builds = vi.spyOn(t.view.state.doc, "toString"), refs = vi.spyOn(t.overlay, "followRefAt");
		const req = t.view.requestMeasure;
		let phases = 0;
		t.view.requestMeasure = (r) => { phases++; req(r); };
		t.overlay.followMeasureNow();
		const now = { builds: builds.mock.calls.length, refs: refs.mock.calls.length };
		builds.mockClear();
		refs.mockClear();
		t.relayout({});
		const measure = { builds: builds.mock.calls.length, refs: refs.mock.calls.length, phases };
		t.view.requestMeasure = req;
		builds.mockRestore();
		refs.mockRestore();
		note(`TABLE-ATTACH cell 6 text builds: width measure ${JSON.stringify(now)}, follow measure ${JSON.stringify(measure)}`);
		expect(now.refs, "premise: the width measure reads every group").toBeGreaterThanOrEqual(4);
		expect(measure.refs, "premise: the follow measure reads every group").toBeGreaterThanOrEqual(4);
		expect(measure.phases, "premise: the follow measure is one read phase").toBe(1);
		expect(now.builds, "width measure: whole-note text builds").toBeLessThanOrEqual(1);
		expect(measure.builds, "follow measure: whole-note text builds").toBeLessThanOrEqual(1);
	});

	// Its Live Preview twin: there each read of a table group asks whether the target starts at a character its cell
	// draws (the follow's legacy test), which reads the note's whole text; the read phase's one reader builds it once.
	it("text builds: Live Preview reads four table groups with at most one whole-note text per read phase", async () => {
		const path = "table-c6-builds-live.md", t = rig(path, [], "live");
		const words: [number, number, string][] = [[1, 0, "alpha"], [1, 1, "beta"], [2, 0, "delta"], [2, 1, "epsilon"]];
		inlineInk.record(path).strokes = words.map(([row, col, w], i) => t.circle(row, col, w, 0, `c${i}`));
		for (let i = 0; i < words.length; i++) {
			t.selection.selectExactly([`c${i}`]);
			expect(t.overlay.attachSelected(), `Attach is offered for ${words[i]![2]}`).toBe(true);
			await Promise.resolve();
		}
		const list = inlineInk.attachments(path).filter((a): a is AttachmentRecord => !isOpaqueAttachment(a));
		const onTable = list.filter((a) => t.view.state.doc.lineAt(a.target.from).text.includes("|"));
		expect(onTable.length, `premise: four groups on table lines (${JSON.stringify(list.map((a) => a.target))})`).toBe(4);
		const builds = vi.spyOn(t.view.state.doc, "toString"), refs = vi.spyOn(t.overlay, "followRefAt");
		const req = t.view.requestMeasure;
		let phases = 0;
		t.view.requestMeasure = (r) => { phases++; req(r); };
		t.overlay.followMeasureNow();
		const now = { builds: builds.mock.calls.length, refs: refs.mock.calls.length };
		builds.mockClear();
		refs.mockClear();
		t.relayout({});
		const measure = { builds: builds.mock.calls.length, refs: refs.mock.calls.length, phases };
		t.view.requestMeasure = req;
		builds.mockRestore();
		refs.mockRestore();
		note(`TABLE-ATTACH cell 6 Live Preview text builds: width measure ${JSON.stringify(now)}, follow measure ${JSON.stringify(measure)}`);
		expect(now.refs, "premise: the width measure reads every group").toBeGreaterThanOrEqual(4);
		expect(measure.refs, "premise: the follow measure reads every group").toBeGreaterThanOrEqual(4);
		expect(measure.phases, "premise: the follow measure is one read phase").toBe(1);
		expect(now.builds, "width measure: whole-note text builds").toBeLessThanOrEqual(1);
		expect(measure.builds, "follow measure: whole-note text builds").toBeLessThanOrEqual(1);
	});

	// 1b, the ink contract: a group saved by 1.5.1 in Source mode on a word with markup in a table cell ("**beta**", the
	// link "[gamma](g.md)": 1.5.1's Source Attach took the word under the box, and its ref was read at the target's first
	// source character, coordsAtPos as 1.5.1's followRefAt). Opened in Source mode now: no move. Live Preview's read is
	// logged (1.5.1 read the widget's edge there; the number is ruled on, not asserted here).
	for (const w of [{ id: "bold", word: "**beta**" }, { id: "link", word: "[gamma](g.md)" }]) {
		it(`1b saved 1.5.1 ink, Source-mode word ${w.word} in a cell: opened in Source mode, no move`, async () => {
			const path = `table-c6-151-${w.id}.md`, t = rig(path, [], "source", BOLD), n = 5, col = BOLD[n - 1]!.indexOf(w.word);
			const from = t.view.state.doc.line(n).from + col, x0 = col * CW, top = t.topOf(n) + (LH - FH) / 2;
			const s = loop("s1", x0 - 4, x0 + w.word.length * CW + 4, t.topOf(n) + 4, t.topOf(n) + LH - 4);
			inlineInk.record(path).strokes = [s];
			const rec: AttachmentRecord = {
				v: 1, id: `att-151-${w.id}`, strokeIds: ["s1"], target: targetAt(t.text(), from, from + w.word.length, "range"),
				ref: { x: x0, y: top }, layout: { width: SIG.width, font: SIG.fontPx }, probe: { id: "s1", x: s.points[0]!.x, y: s.points[0]!.y },
			};
			expect(t.text().slice(rec.target.from, rec.target.to), "premise: the saved target is the word as 1.5.1 took it").toBe(w.word);
			const legacyRef = t.view.coordsAtPos(from);
			expect(near(legacyRef.left, rec.ref.x) && near(legacyRef.top, rec.ref.y), `premise: the saved ref is 1.5.1's read, coordsAtPos (${JSON.stringify(legacyRef)})`).toBe(true);
			inlineInk.setAttachments(path, [rec], false);
			t.anchors.follow.setList(inlineInk.attachments(path));
			t.overlay.followMeasureNow();
			const inSource = t.offset(rec.id);
			t.setMode("live");
			const inLive = t.offset(rec.id);
			note(`TABLE-ATTACH 1b saved 1.5.1 ${w.id}: opened in Source ${JSON.stringify(inSource)}, then Live Preview ${JSON.stringify(inLive)}`);
			expect(!!inSource && near(inSource.dx, 0) && near(inSource.dy, 0), `no move in Source mode (${JSON.stringify(inSource)})`).toBe(true);
		});
	}

	// 1b rest: the same 1.5.1 records, and one each on "**beta**", "~~beta~~", "==beta==" and "`beta`" in a cell
	// "<word> gamma" (each word's first character a mark that opens a pair). Source mode: on its word on open and after
	// text typed above the table, beside the word (alpha's cell) and in its cell after it (as the app writes it: the
	// cell's span replaced). Live Preview: read as 1.5.1 read it, coordsAtPos at the target's first character (the
	// widget's edge). The three views: drawn at the stored place, as 1.5.1 drew it (no table move for it). Each pinned
	// against trunk.
	const inCell = (word: string) => LINES.map((l) => (l === "| alpha | beta gamma |" ? `| alpha | ${word} gamma |` : l));
	const B1 = inCell("**beta**");
	for (const w of [
		{ id: "bold", word: "**beta**", lines: BOLD }, { id: "link", word: "[gamma](g.md)", lines: BOLD }, { id: "bold-gamma", word: "**beta**", lines: B1 },
		{ id: "strike-gamma", word: "~~beta~~", lines: inCell("~~beta~~") }, { id: "highlight-gamma", word: "==beta==", lines: inCell("==beta==") },
		{ id: "code-gamma", word: "`beta`", lines: inCell("`beta`") },
	]) {
		it(`1b saved 1.5.1 ink, ${w.word} in "${w.lines[4]}": Source on its word after edits, Live Preview and the views as 1.5.1`, async () => {
			const path = `table-c6-151r-${w.id}.md`, t = rig(path, [], "source", w.lines), n = 5, col = w.lines[n - 1]!.indexOf(w.word);
			const from = t.view.state.doc.line(n).from + col, x0 = col * CW, top = t.topOf(n) + (LH - FH) / 2;
			const s = loop("s1", x0 - 4, x0 + w.word.length * CW + 4, t.topOf(n) + 4, t.topOf(n) + LH - 4);
			inlineInk.record(path).strokes = [s];
			const stored = { ...s.bbox };
			const rec: AttachmentRecord = {
				v: 1, id: `att-151r-${w.id}`, strokeIds: ["s1"], target: targetAt(t.text(), from, from + w.word.length, "range"),
				ref: { x: x0, y: top }, layout: { width: SIG.width, font: SIG.fontPx }, probe: { id: "s1", x: s.points[0]!.x, y: s.points[0]!.y },
			};
			expect(t.text().slice(rec.target.from, rec.target.to), "premise: the saved target is the word as 1.5.1 took it").toBe(w.word);
			inlineInk.setAttachments(path, [rec], false);
			t.anchors.follow.setList(inlineInk.attachments(path));
			t.overlay.followMeasureNow();
			const said: string[] = [];
			const target = () => (inlineInk.attachments(path)[0] as AttachmentRecord).target;
			/** Source mode: the group's move against its word's first source character's move since the save. */
			const onWord = (step: string) => {
				t.overlay.followMeasureNow();
				const at = target().from, c = t.view.coordsAtPos(at), got = t.offset(rec.id);
				const want = { dx: +(c.left - rec.ref.x).toFixed(2), dy: +(c.top - rec.ref.y).toFixed(2) };
				said.push(`${step} ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
				expect(t.text().slice(at, at + w.word.length), `premise: ${step}: the target still starts at the word`).toBe(w.word);
				expect(!!got && near(got.dx, want.dx) && near(got.dy, want.dy), `${step}: on its word in Source mode (${JSON.stringify(got)}, want ${JSON.stringify(want)})`).toBe(true);
			};
			onWord("open");
			// Live Preview: 1.5.1's read, coordsAtPos at the target's first character.
			t.setMode("live");
			const lp = t.view.coordsAtPos(target().from), inLive = t.offset(rec.id);
			const lpWant = { dx: +(lp.left - rec.ref.x).toFixed(2), dy: +(lp.top - rec.ref.y).toFixed(2) };
			said.push(`live ${JSON.stringify(inLive)} want ${JSON.stringify(lpWant)}`);
			expect(!!inLive && near(inLive.dx, lpWant.dx) && near(inLive.dy, lpWant.dy), `Live Preview reads it as 1.5.1 (${JSON.stringify(inLive)}, want ${JSON.stringify(lpWant)})`).toBe(true);
			// The three views, no editor change since the save: the stored place.
			for (const kind of VIEWS) {
				const v = viewOf(kind, t.text().split("\n"), { geom: "forced" }), p = placedIn(v, path, SIG).find((x) => x.id === "s1")!;
				const off = { dx: +(p.bbox.x - stored.x).toFixed(2), dy: +(p.bbox.y - stored.y).toFixed(2) };
				said.push(`${kind} ${JSON.stringify(off)}`);
				expect(onIt(off), `${kind}: drawn at its stored place, as 1.5.1 (${JSON.stringify(off)})`).toBe(true);
			}
			t.setMode("source");
			onWord("source again");
			t.edit(0, 0, "New line on top\n\n");
			onWord("typed above");
			const a = t.view.state.doc.line(n + 2), ai = a.text.indexOf("alpha") + 5;
			t.edit(a.from + ai, a.from + ai, " x");
			onWord("typed beside");
			const l = t.view.state.doc.line(n + 2), p1 = l.text.indexOf("|", 1), p2 = l.text.indexOf("|", p1 + 1), span = l.text.slice(p1 + 1, p2);
			t.edit(l.from + p1 + 1, l.from + p2, span.replace(/ $/, " new "));
			onWord("typed in its cell after it");
			note(`TABLE-ATTACH 1b rest ${w.id}: ${said.join("; ")}`);
		});
	}

	// Saved 1.5.1 ink typed at: a 1.5.1 record that is its cell's whole text from the cell's
	// start ("**beta**" alone in its cell), text typed at its first character as a plain insert in Source mode. Not taken
	// by the cell-target branch of refindInTables: the target keeps the mapping, still starting at "**beta**", and the
	// ink stays on it (0 px against its word's first source character), as on trunk.
	const B2 = LINES.map((l) => (l === "| alpha | beta gamma |" ? "| alpha | **beta** |" : l));
	it(`1b saved 1.5.1 ink, **beta** alone in its cell, typed at its first character in Source mode: on its word`, async () => {
		const path = "table-c6-151-alone.md", t = rig(path, [], "source", B2), n = 5, word = "**beta**", col = B2[n - 1]!.indexOf(word);
		const from = t.view.state.doc.line(n).from + col, x0 = col * CW, top = t.topOf(n) + (LH - FH) / 2;
		const s = loop("s1", x0 - 4, x0 + word.length * CW + 4, t.topOf(n) + 4, t.topOf(n) + LH - 4);
		inlineInk.record(path).strokes = [s];
		const rec: AttachmentRecord = {
			v: 1, id: "att-151-alone", strokeIds: ["s1"], target: targetAt(t.text(), from, from + word.length, "range"),
			ref: { x: x0, y: top }, layout: { width: SIG.width, font: SIG.fontPx }, probe: { id: "s1", x: s.points[0]!.x, y: s.points[0]!.y },
		};
		inlineInk.setAttachments(path, [rec], false);
		t.anchors.follow.setList(inlineInk.attachments(path));
		t.overlay.followMeasureNow();
		t.edit(from, from, "big ");
		t.overlay.followMeasureNow();
		const at = (inlineInk.attachments(path)[0] as AttachmentRecord).target.from, c = t.view.coordsAtPos(at), got = t.offset(rec.id);
		const want = { dx: +(c.left - rec.ref.x).toFixed(2), dy: +(c.top - rec.ref.y).toFixed(2) };
		note(`TABLE-ATTACH 1b alone typed at its start: target ${JSON.stringify(t.text().slice(at, at + 12))}, ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
		expect(t.text().slice(at, at + word.length), "the target still starts at the word as 1.5.1 took it").toBe(word);
		expect(!!got && near(got.dx, want.dx) && near(got.dy, want.dy), `on its word in Source mode (${JSON.stringify(got)}, want ${JSON.stringify(want)})`).toBe(true);
	});

	// The cost of keeping a cell target its cell's through an edit at
	// its edge. A keystroke that reaches no cell target's edge builds no whole-note text from the note before it (the
	// line alone is read): one in the paragraph above, one in alpha's cell beside the cell target, one at a word target's
	// first letter in a table (delta, no markup). One at the cell target's first letter is the control: it builds.
	it(`P10 whole-cell cost: a keystroke that reaches no cell target's edge builds no note text`, async () => {
		const path = "table-c6-edge-cost.md", t = rig(path, [], "source", BOLD), bx = BOLD_BETA * CW, dl = BOLD[5]!.indexOf("delta"), dx0 = dl * CW;
		inlineInk.record(path).strokes = [
			loop("c", bx - 4, bx + 4 * CW + 4, t.topOf(5) + 4, t.topOf(5) + LH - 4),
			loop("d", dx0 - 4, dx0 + 5 * CW + 4, t.topOf(6) + 4, t.topOf(6) + LH - 4),
		];
		const rc = await t.tryAttach(["c"]);
		await t.tryAttach(["d"]); // tryAttach hands back a record only when it is the note's one; the word target is the second
		const rd = (inlineInk.attachments(path).find((a) => a.id !== rc?.id) ?? null) as AttachmentRecord | null;
		expect(textOf(t, rc), "premise: the cell target").toBe("beta** [gamma](g.md)");
		expect(textOf(t, rd), "premise: the word target").toBe("delta");
		const builds = (f: () => void) => { const spy = vi.spyOn(t.view.state.doc, "toString"); f(); const k = spy.mock.calls.length; spy.mockRestore(); return k; };
		const above = builds(() => { const p = t.posOf(1, "above"); t.edit(p, p, "x"); });
		const beside = builds(() => { const p = t.posOf(5, "alpha") + 2; t.edit(p, p, "x"); });
		const word = builds(() => { const p = t.posOf(6, "delta"); t.edit(p, p, "x"); });
		const control = builds(() => { const p = t.posOf(5, "beta"); t.edit(p, p, "big "); });
		const now = inlineInk.attachments(path).find((a) => a.id === rc!.id) as AttachmentRecord;
		note(`TABLE-ATTACH whole-cell cost: note text builds, above ${above}, beside ${beside}, word edge ${word}, cell edge ${control}; target now ${JSON.stringify(t.text().slice(now.target.from, now.target.to))}`);
		expect(control, "premise: the cell target's edge builds the note text (the count reads)").toBeGreaterThan(0);
		expect([above, beside, word], "no note text built when no cell target's edge is reached").toEqual([0, 0, 0]);
	});

	// A target made now never starts at a mark: a cell group made now on "beta gamma" (its cell's whole text, which
	// starts drawn), then the cell rewritten "**beta** gamma" as the app writes it (the cell's span replaced): the target
	// starts at the cell's first drawn character, beta's b, never at a mark, and the ink stays on beta in both modes.
	it("rule 4: a cell group, its cell rewritten with a mark in front: the target starts at beta, the ink on beta", async () => {
		const path = "table-c6-rule4.md", t = rig(path, [], "source", LINES), n = 5, col = LINES[n - 1]!.indexOf("beta");
		const x0 = col * CW;
		inlineInk.record(path).strokes = [loop("c", x0 - 4, x0 + "beta gamma".length * CW + 4, t.topOf(n) + 4, t.topOf(n) + LH - 4)];
		const r = await t.tryAttach(["c"]);
		expect(r, "premise: Attach made a record").not.toBeNull();
		expect(textOf(t, r), "premise: the target is the cell's whole text").toBe("beta gamma");
		const b0 = t.view.coordsAtPos(r!.target.from);
		const l = t.view.state.doc.line(n), p1 = l.text.indexOf("|", 1), p2 = l.text.indexOf("|", p1 + 1);
		t.edit(l.from + p1 + 1, l.from + p2, " **beta** gamma ");
		t.overlay.followMeasureNow();
		const now = (inlineInk.attachments(path)[0] as AttachmentRecord).target, text = t.text();
		const b = t.view.state.doc.line(n).from + t.view.state.doc.line(n).text.indexOf("beta");
		const c = t.view.coordsAtPos(b), inSource = t.offset(r!.id);
		const want = { dx: +(c.left - b0.left).toFixed(2), dy: +(c.top - b0.top).toFixed(2) };
		t.setMode("live");
		const inLive = t.offset(r!.id), word = t.wordAt(1, 1, "beta");
		t.setMode("source");
		note(`TABLE-ATTACH rule 4: target ${JSON.stringify(text.slice(now.from, now.to))}, Source ${JSON.stringify(inSource)} want ${JSON.stringify(want)}, Live Preview ${JSON.stringify(inLive)} word ${JSON.stringify({ left: word.left, top: word.top })}`);
		expect(text.slice(now.from, now.to), "the target: from beta's b to the cell's end").toBe("beta** gamma");
		expect(!!inSource && near(inSource.dx, want.dx) && near(inSource.dy, want.dy), `on beta in Source mode (${JSON.stringify(inSource)}, want ${JSON.stringify(want)})`).toBe(true);
	});

	// Rule 4 for a word target: "_id" (a lone "_", which the cell draws) attached in Live Preview, then its cell rewritten
	// "_id_ gamma" as the app writes it (the cell's span replaced, so the target collapses and is found again). The "_"
	// pair now marks id, so the cell no longer draws the first "_": the target keeps its word and starts at its i.
	it("rule 4, a word target: its cell rewritten so its first character becomes a mark: the target starts after the mark", async () => {
		const path = "table-c6-rule4-word.md", L = LINES.map((l) => (l === "| alpha | beta gamma |" ? "| alpha | _id gamma |" : l));
		const { t, r } = await attachedOn(path, "_id", 1, 1, L);
		expect(textOf(t, r), "premise: the word is the target").toBe("_id");
		t.setMode("source");
		const l = t.view.state.doc.line(5), p1 = l.text.indexOf("|", 1), p2 = l.text.indexOf("|", p1 + 1);
		t.edit(l.from + p1 + 1, l.from + p2, " _id_ gamma ");
		t.overlay.followMeasureNow();
		const now = (inlineInk.attachments(path)[0] as AttachmentRecord).target;
		note(`TABLE-ATTACH rule 4 word: target ${JSON.stringify(t.text().slice(now.from, now.to))}`);
		expect(t.text().slice(now.from, now.to), "the target: from id's i to its word's end").toBe("id");
	});
});

describe("a table word that starts with a lone mark character the cell draws (~, =, _, a backtick)", () => {
	// A lone mark opens or closes no pair, so the cell draws it and the word is drawn one to one: a word target made now.
	// Attached in Live Preview, it stays on its word through a relayout and through Source mode and back. Control: beta.
	// "_a_b": its second "_" is inside a word, so it closes nothing and the first opens no pair.
	for (const w of ["beta", "~5", "=SUM", "_id", "`x", "_a_b"]) {
		it(`P10 lone mark ${JSON.stringify(w)}: attached in Live Preview, no move on a relayout or after Source mode and back`, async () => {
			const L = LINES.map((l) => (l === "| alpha | beta gamma |" ? `| alpha | ${w} gamma |` : l));
			const { t, r } = await attachedOn(`table-lone-mark-${w.charCodeAt(0)}-${w.length}.md`, w, 1, 1, L);
			expect(textOf(t, r), "premise: the word is the target").toBe(w);
			t.relayout({});
			const again = r ? t.offset(r.id) : null;
			t.setMode("source");
			t.setMode("live");
			t.relayout({});
			const back = r ? t.offset(r.id) : null;
			note(`TABLE-ATTACH lone mark ${JSON.stringify(w)}: relayout ${JSON.stringify(again)}, Source mode and back ${JSON.stringify(back)}`);
			expect(!!again && onIt(again), `no move on a relayout (${JSON.stringify(again)})`).toBe(true);
			expect(!!back && onIt(back), `no move after Source mode and back (${JSON.stringify(back)})`).toBe(true);
		});
	}
});

describe("cell 10 after cell 6: Reading view, an embed and Export to PDF after Source mode, as their render draws attached ink (shownStrokes): on its word", () => {
	// The read-only view lays the note out as Live Preview does (the table one block at the widget's box), taken from a
	// Live Preview rig on the same text: this measures what the plugin hands those views, not Reading view's own table
	// geometry (cell 10's named limit). Those views draw a member at its line anchor plus its group's kept dx, both written
	// by whichever mode's pass ran last; after Source mode they are off the word as the table shows it, saved so, and a
	// view with no editor open draws it the same (no editor's signature is given here). The one cell left here is the
	// Live Preview control; the note below it names where the cells that want the ink on its word went.
	/** The editor's paint after a move (followMoved), its line measure, then its old-ink pass once quiet: the pass's timer caught and fired. */
	const painter = (t: Rig, path: string) => {
		let pass: (() => void) | null = null;
		Object.assign(t.overlay, { attachedLayer: null, builder: null, router: null, lineOnScreen: () => true, applyColumnHold: () => {}, requestLineBoxes: () => {} });
		Object.defineProperty(t.overlay, "winRef", { value: { setTimeout: (f: () => void) => { pass = f; return 1; } } });
		return (before: ReturnType<Rig["anchors"]["follow"]["snapshot"]>) => {
			pass = null;
			InkOverlayPlugin.prototype.followMoved.call(t.overlay, path, before);
			const n = t.view.state.doc.lines;
			t.anchors.drawn(1, n);
			t.anchors.drawn(1, n, true, true);
			InkOverlayPlugin.prototype.armLineAnchorPass.call(t.overlay, path, 0);
			expect(pass, "the old-ink pass armed").not.toBeNull();
			(pass as unknown as () => void)();
			settleLineAnchors();
		};
	};
	/** The read-only view's line boxes: Live Preview's layout of `g`'s text, the table one block. */
	const spansOf = (g: Rig): LineSpans => {
		const lines = g.text().split("\n"), T = g.table()!, top = g.topOf(T.a), h = g.widget().height;
		return {
			lines,
			skip: [],
			blocks: lines.flatMap((_, i) => {
				const n = i + 1;
				if (n === T.a) return [{ lineStart: i, lineEnd: T.b - 1, box: () => ({ top, height: h }), lineHeight: () => LH }];
				if (n > T.a && n <= T.b) return [];
				return [{ lineStart: i, lineEnd: i, box: () => ({ top: g.topOf(n), height: LH }), lineHeight: () => LH }];
			}),
		};
	};

	/** Attach on beta in Live Preview, the line anchors hearing each change; steps, each followed by the editor's paint and pass; the read-only view's read. */
	const scene = async (path: string) => {
		const { t, r } = await attachedOn(path, "beta", 1, 1);
		expect(textOf(t, r), "premise").toBe("beta");
		const paint = painter(t, path), b0 = { ...inlineInk.strokes(path)[0]!.bbox }, was = t.wordAt(1, 1, "beta");
		t.hear.anchors = true;
		let reads = 0;
		const step = (f: () => void) => {
			const before = t.anchors.follow.snapshot();
			f();
			paint(before);
		};
		const source = () => step(() => t.setMode("source"));
		const live = () => step(() => t.setMode("live"));
		/** "big " typed in front of beta, in the mode shown now. */
		const type = () => step(() => { const at = t.posOf(5, "beta"); t.edit(at, at, "big "); });
		/** Where the read-only view draws the ink, less where beta is drawn in Live Preview now (0, 0 = on its word); the anchor's line; beta's move. */
		const read = () => {
			const g = rig(`${path}-geom-${reads++}.md`, [], "live", t.text().split("\n")), now = g.wordAt(1, 1, "beta"), want = moved(was, now);
			const s = shownStrokes(inlineInk.strokes(path), spansOf(g), 1, null, inlineInk.attachments(path))[0]!;
			const off = { dx: +(s.bbox.x - b0.x - want.dx).toFixed(2), dy: +(s.bbox.y - b0.y - want.dy).toFixed(2) };
			return { off, line: inlineInk.strokes(path)[0]!.lineAnchor?.line, want, editorOnWord: onWord(t.offset(r!.id), was, now) };
		};
		return { t, source, live, type, read };
	};
	const said = (name: string, x: ReturnType<Awaited<ReturnType<typeof scene>>["read"]>) =>
		note(`TABLE-ATTACH cell 10 after cell 6, ${name}: beta moved ${JSON.stringify(x.want)}, read-only off its word ${JSON.stringify(x.off)}, anchor line ${x.line}, Live Preview editor on beta ${x.editorOnWord}`);
	const at = (off: { dx: number; dy: number }, dx: number, dy: number) => near(off.dx, dx) && near(off.dy, dy);

	it("control: text typed in front of beta in Live Preview: drawn on its word, anchored on the table's first line", async () => {
		const s = await scene("table-c10-live-type.md");
		s.type();
		const x = s.read();
		said("Live Preview type", x);
		expect(x.want.dx, "premise: beta moved right").toBeGreaterThan(20);
		expect([at(x.off, 0, 0), x.line, x.editorOnWord], `off ${JSON.stringify(x.off)}`).toEqual([true, 3, true]);
	});

	// The four cells that wanted the fix here (Source and back; Source-mode type, pass in Source; the same then Live
	// Preview; Source and back then Live Preview type) were it.fails on this borrowed rig, which has no table DOM, so no
	// table-reading fix could turn them green. They are removed in the test commit (plan addendum 3, Q2). Their twins are
	// cases 2, 3, 4 and 5 in "a read-only view draws table-linked ink on its word", in each view and both geometries.
});

describe("cell 7: one cell at a resting zoom of 150%", () => {
	it("Attach on beta at 1.5, text typed in front, then a row added above: on its word each time", async () => {
		const { t, r } = await attachedOn("table-c7.md", "beta", 1, 1, LINES, { zoom: 1.5 });
		expect(textOf(t, r), "the circle's word").toBe("beta");
		const was = t.wordAt(1, 1, "beta"), at = t.posOf(5, "beta");
		t.edit(at, at, "big ");
		const typed = t.wordAt(1, 1, "beta"), a = t.offset(r!.id);
		const row = lineFrom(5, t.text());
		t.edit(row, row, "| new | row |\n");
		const down = t.wordAt(2, 1, "beta"), b = t.offset(r!.id);
		note(`TABLE-ATTACH cell 7 at 1.5: typed ${JSON.stringify(moved(was, typed))} ink ${JSON.stringify(a)}; row above ${JSON.stringify(moved(was, down))} ink ${JSON.stringify(b)}`);
		expect(onWord(a, was, typed), "typed in front").toBe(true);
		expect(onWord(b, was, down), "row above").toBe(true);
	});
});

describe("cell 11: the reads a table costs", () => {
	const big = ["Text above the table here", "", "| Key | Word |", "| --- | --- |", ...Array.from({ length: 30 }, (_, i) => `| r${i + 1} | w${i + 1} x |`), "", "Text below the table here"];

	it("20 groups in a 30-row table, read in one layout: each on its word, one DOM rect read per group read, one table walk per measure", () => {
		const path = "table-t11.md", t = rig(path, [], "live", big), text = t.text(), rec = inlineInk.record(path), layout = { width: SIG.width, font: SIG.fontPx };
		const records: AttachmentRecord[] = [], strokes: InkStroke[] = [];
		for (let i = 1; i <= 20; i++) {
			const from = t.posOf(4 + i, `w${i} `), s = t.circle(i, 1, `w${i}`, 0, `s${i}`);
			strokes.push(s);
			records.push({ v: 1, id: `g${i}`, strokeIds: [`s${i}`], target: targetAt(text, from, from + `w${i}`.length, "range"), ref: { x: 0, y: 0 }, layout, probe: { id: `s${i}`, x: s.points[0]!.x, y: s.points[0]!.y } });
		}
		rec.strokes = strokes;
		rec.basePage = { ...rec.basePage!, attachments: records };
		t.overlay.resolveAttachedText(path);
		const counts = t.anchors.follow.counts, read0 = counts.groupsMeasured;
		t.fdoc.reads.rect = 0;
		t.fdoc.reads.walk = 0;
		let measures = 0;
		const req = t.overlay.view.requestMeasure.bind(t.overlay.view);
		(t.overlay.view as { requestMeasure: typeof req }).requestMeasure = (m) => { measures++; req(m); };
		t.relayout({});
		const groups = counts.groupsMeasured - read0, off: string[] = [];
		for (let i = 1; i <= 20; i++) {
			const w = t.wordAt(i, 1, `w${i}`), o = t.offset(`g${i}`);
			if (!o || !near(o.dx, w.left) || !near(o.dy, w.top)) off.push(`w${i}: ${JSON.stringify(o)} want ${w.left},${w.top}`);
		}
		note(`TABLE-ATTACH reads: ${groups} group reads in ${measures} measures, ${t.fdoc.reads.rect} rect reads, ${t.fdoc.reads.walk} walks, ${off.length} off ${JSON.stringify(off.slice(0, 2))}`);
		expect(off, "each group on its word").toEqual([]);
		expect(groups, "premise: every group read").toBeGreaterThanOrEqual(20);
		expect(t.fdoc.reads.rect, "one rect read per group read").toBeLessThanOrEqual(groups);
		expect(t.fdoc.reads.walk, "one table walk per measure").toBeLessThanOrEqual(measures);
	});

	it("Attach, the recorded kinds of edit and a layout change: no DOM read outside a measure's read phase", async () => {
		const { t, r } = await attachedOn("table-c11.md", "beta", 1, 1);
		expect(textOf(t, r), "premise: the circle's word").toBe("beta");
		const at = t.posOf(5, "beta");
		t.edit(at, at, "big ");
		const row = lineFrom(5, t.text());
		t.edit(row, row, "| new | row |\n");
		const T = t.table()!;
		t.edit(T.from, T.to, t.text().slice(T.from, T.to).replace("| delta |", "| delta two |"));
		t.relayout({ underEdit: [2, 1] });
		note(`TABLE-ATTACH cell 11: target ${JSON.stringify(textOf(t, inlineInk.attachments("table-c11.md")[0] as AttachmentRecord))}, reads outside a measure's read ${JSON.stringify(t.fdoc.reads.outside)}`);
		expect(t.fdoc.reads.outside, "no read outside a read phase").toEqual([]);
	});
});

describe("cell 12: no stored field, no new target kind, no new screen words, no notice", () => {
	it("Attach on a table word and its follow through edits write only today's fields and kinds, and say nothing", async () => {
		notices.said.length = 0;
		const { t, r } = await attachedOn("table-c12.md", "beta", 1, 1);
		expect(textOf(t, r), "premise: the circle's word").toBe("beta");
		const at = t.posOf(5, "beta");
		t.edit(at, at, "big ");
		const T = t.table()!;
		t.edit(T.from, T.to, t.text().slice(T.from, T.to).replace("| delta |", "| delta two |"));
		const list = inlineInk.attachments("table-c12.md") as AttachmentRecord[];
		const fields = [...new Set(list.flatMap((a) => Object.keys(a)))].filter((f) => !KNOWN_ATTACHMENT.has(f));
		note(`TABLE-ATTACH cell 12: target ${JSON.stringify(textOf(t, list[0] ?? null))}, kinds ${JSON.stringify(list.map((a) => a.target.kind))}, new fields ${JSON.stringify(fields)}, notices ${JSON.stringify(notices.said)}`);
		expect(textOf(t, list[0] ?? null), "still on beta").toBe("beta");
		expect(fields, "no new stored field").toEqual([]);
		expect(list.map((a) => a.target.kind), "today's kinds").toEqual(["range"]);
		expect(Object.keys(list[0]!.target).sort(), "the target's fields as today").toEqual(["after", "before", "from", "kind", "text", "to"]);
		expect(ATTACH_STRINGS, "the screen words as today").toEqual({ button: "Attach", attached: "Attached", needs: "Drag the pin to the text", noText: "No text under the ink" });
		expect(notices.said, "no notice").toEqual([]);
	});
});

/*
 * Reading view, an embed and Export to PDF draw ink linked to a word in a
 * table on that word, by the table the view itself draws. Each view is driven through its own entry (EmbedInk.ts
 * placeStrokes over a root of rendered blocks, EmbedInkMeasure.ts measureSpans reading it): Reading view with section
 * info, an embed with the cached sections laid onto its blocks, a print with the tops it held before paging.
 *
 * The view's table block is built from the Rogue record (RECORD_IN below): the table where Live Preview's is, its block's
 * top-left where the app draws it in that view, every other section a paragraph at its Live Preview top. Each cell also
 * runs at FORCED_IN, at least 5 px off Live Preview's block on each axis, and asserts which geometry took (offFromLp).
 * In the app at fbf1405b case 1 is far off in every view (37 px left, 247 to 270 px down: ARM-NOTE-run-20261117T081911Z),
 * so case 1 is a cell that wants the fix here too, not a control.
 *
 * Off its word: where the view draws the ink less where its word is drawn in that view, each taken from where the ink and
 * its word were at Attach in the editor (0, 0 = on its word).
 */

/** The editor's paint after a move (followMoved), its line measure, then its old-ink pass once quiet (cell 10's painter). */
function painterOf(t: Rig, path: string) {
	let pass: (() => void) | null = null;
	Object.assign(t.overlay, { attachedLayer: null, builder: null, router: null, lineOnScreen: () => true, applyColumnHold: () => {}, requestLineBoxes: () => {} });
	Object.defineProperty(t.overlay, "winRef", { value: { setTimeout: (f: () => void) => { pass = f; return 1; } }, configurable: true });
	return (before: ReturnType<Rig["anchors"]["follow"]["snapshot"]>) => {
		pass = null;
		InkOverlayPlugin.prototype.followMoved.call(t.overlay, path, before);
		const n = t.view.state.doc.lines;
		t.anchors.drawn(1, n);
		t.anchors.drawn(1, n, true, true);
		InkOverlayPlugin.prototype.armLineAnchorPass.call(t.overlay, path, 0);
		if (pass) (pass as unknown as () => void)();
		settleLineAnchors();
	};
}

/** `word` (its `nth` in the cell's shown text) as drawn in `cell`, world units at `k` px each, read `dy` px higher than drawn. */
function cellWordAt(cell: FEl, word: string, k = 1, nth = 0, dy = 0): Box {
	const texts: FText[] = [];
	const walk = (n: FEl | FText) => { if (n instanceof FText) { if (!n.hidden()) texts.push(n); } else n.childNodes.forEach((c) => walk(c as FEl | FText)); };
	walk(cell);
	const all = texts.map((x) => x.data).join("");
	let i = -1;
	for (let j = 0; j <= nth; j++) i = all.indexOf(word, i + 1);
	if (i < 0) throw new Error(`no ${word} in the view's cell: ${JSON.stringify(all)}`);
	let at = 0;
	for (const x of texts) {
		if (i < at + x.length) {
			const r = new FRange();
			r.setStart(x, i - at);
			r.setEnd(x, Math.min(x.length, i - at + word.length));
			const b = r.getClientRects()[0]!;
			return { left: b.left / k, top: (b.top - dy) / k, right: b.right / k, bottom: (b.bottom - dy) / k, width: b.width / k, height: b.height / k, x: b.left / k, y: (b.top - dy) / k };
		}
		at += x.length;
	}
	throw new Error("unreachable");
}

type View = ReturnType<typeof readOnlyView> & {
	kind: ViewKind;
	zoom: number;
	word: (row: number, col: number, word: string, nth?: number) => Box;
	/** beta's top-left from its table block in this view, less the same in Live Preview's widget (world units). */
	offFromLp: () => { dx: number; dy: number };
	/** beta's top-left from the view's table (its own column and row layout), less the same in Live Preview's table (world units). */
	inTableFromLp: () => { dx: number; dy: number };
};
let viewsMade = 0;

/**
 * Where the view's table sits in its table block, px from the block's top-left to the table's (world units at zoom 1).
 * Live Preview's widget is 16, 16 (TABLE_GEOM.inset). The record (Rogue, run-20261117T081911Z, app 1.15.1 at fbf1405b,
 * the C lines "word from its block" less "from its table"): Reading view 0, 12.99 (an embed in a Reading view the same);
 * an embed in a Live Preview note 0, 45.49; the print of Export to PDF 0, 45.5 (its block the table's classless parent).
 * In each the word sits in its table as in Live Preview (85.59, 45.44 from the table in all four), and the table's left
 * is where Live Preview's table is. Recorded Reading is 3 px off Live Preview's in y, under the 5 px a cell needs to tell
 * a fix that reads the view's own table from one that borrows Live Preview's: so every family also runs at FORCED_IN.
 */
const RECORD_IN: Record<ViewKind, { x: number; y: number }> = { reading: { x: 0, y: 12.99 }, embed: { x: 0, y: 45.49 }, print: { x: 0, y: 45.5 } };
/** A table block geometry at least 5 px off Live Preview's on each axis (16, 12) in every view. */
const FORCED_IN = { x: 0, y: 4 };
type Geom = "record" | "forced";
const GEOMS: readonly Geom[] = ["record", "forced"];
const inOf = (kind: ViewKind, geom: Geom) => (geom === "record" ? RECORD_IN[kind] : FORCED_IN);

/**
 * The view `kind` of a note whose text is `lines`, its text at `zoom` px per world unit. Its table is drawn where Live
 * Preview's table is, in a block whose top-left is `inOf(kind, geom)` above-left of it (the record, or the forced
 * offset). A print is paged by `pagedBy` px from the table on; the word is read where it was before paging (the held
 * layout). `shown` replaces the table's source lines as the view draws them (a render that does not match the text).
 * `table` is the view's own table layout (a column wrapped where Live Preview's is not, as a print's narrower page
 * wraps a wide table); the blocks after the table sit lower by any height it adds. Unset: Live Preview's layout.
 * `layerLeft` lays the view's text and the ink layer that many px right of the root's edge, as the plugin's left reserve
 * does (its root attribute, read by layerAt): `word` then reads in the layer's frame. Unset: 0, as every other cell.
 * `rootAt` lays the root (and all under it) at that client offset; `scrollY` scrolls the root that many px down: every
 * client box under it is that much higher and the root's scrollTop holds it, the blocks' offsetTops unchanged. `word`
 * and `offFromLp` read in the root's frame (the client box less the root's offset, plus its scroll). Unset: 0.
 * `part` (G2-12, an embed or a print only): the view draws only the sections inside source lines a to b (0-based,
 * inclusive), laid from the root's top, as a heading or block embed renders its excerpt; the note's cached sections and
 * text stay the whole note's, as the metadata cache gives them. With `part` set a line "# ..." alone is a heading section
 * drawn as an h1, in the blocks and the cached sections alike. Unset: every section, no heading.
 */
type ViewOpts = { zoom?: number; pagedBy?: number; shown?: (src: string) => string; geom?: Geom; table?: TableOpts; layerLeft?: number; rootAt?: { x: number; y: number }; scrollY?: number; crlf?: boolean; firstTable?: boolean; part?: readonly [number, number] };
/** Every rect and character box under `n` (and `n`'s own), `dx` px further right and `dy` px lower. */
function shiftBy(n: FEl | FText, dx: number, dy: number): void {
	const s = (b: Box): Box => ({ ...b, left: b.left + dx, right: b.right + dx, x: b.x + dx, top: b.top + dy, bottom: b.bottom + dy, y: b.y + dy });
	if (n instanceof FEl) n.rect = s(n.rect);
	if (n instanceof FText) n.chars = n.chars.map(s);
	n.childNodes.forEach((c) => shiftBy(c as FEl | FText, dx, dy));
}
const shiftRight = (n: FEl | FText, dx: number) => shiftBy(n, dx, 0);
function viewOf(kind: ViewKind, lines: readonly string[], o: ViewOpts = {}): View {
	const k = o.zoom ?? 1, tin = inOf(kind, o.geom ?? "record");
	const g = rig(`table-view-geom-${viewsMade++}.md`, [], "live", lines);
	const doc = new FDoc();
	let cell: ((row: number, col: number) => FEl | null) | null = null, tableAt = -1, widgetTop = 0, tableEl: FEl | null = null, extra = 0;
	if (o.part && kind === "reading") throw new Error("viewOf: part is an embed's or a print's (Reading view gives each block's own lines)");
	const part = o.part, all = sectionsOf(lines).map((s) => (part && s.lineStart === s.lineEnd && /^#{1,6} /.test(lines[s.lineStart]!) ? { ...s, type: "heading" } : s));
	const kept = part ? all.filter((s) => s.lineStart >= part[0] && s.lineEnd <= part[1]) : all;
	if (!kept.length) throw new Error("viewOf: the part holds no section");
	const top0 = part ? g.topOf(kept[0]!.lineStart + 1) - g.topOf(all[0]!.lineStart + 1) : 0;
	const sections: ViewSection[] = kept.map((s, i) => {
		const top = g.topOf(s.lineStart + 1) + extra - top0;
		if (s.type === "callout") {
			// A callout (P9): its title line as text, then the table its quoted pipe lines draw, in one block. v.word reads
			// that table.
			const body = lines.slice(s.lineStart, s.lineEnd + 1).map((l) => l.replace(/^\s*>\s?/, ""));
			const first = body.findIndex((l) => l.includes("|")), box = new FEl("div", "callout", doc);
			box.append(paragraphEl(doc, body[0]!, 0, top * k, LH * k, CW * k, FH * k));
			let h = LH * body.length;
			if (first > 0) {
				const w = tableWidget(doc, body.filter((l) => l.includes("|")), WX, top + first * LH, { scale: k });
				w.wrapper.childNodes.length = 0;
				w.table.parentNode = null;
				box.append(w.table);
				cell = w.cell;
				tableEl = w.table;
				h = first * LH + w.height;
			}
			box.rect = { left: 0, top: top * k, right: 1400, bottom: (top + h) * k, width: 1400, height: h * k, x: 0, y: top * k };
			return { ...s, el: box, top: top * k, height: h * k };
		}
		if (s.type === "table") {
			const src = lines.slice(s.lineStart, s.lineEnd + 1).map((l) => (o.shown ? o.shown(l) : l));
			// tableWidget lays its table at (x0 + inset, y0 + inset): x0 = WX puts it where Live Preview's table is (the
			// record: same left in every view). The view's block is laid tin.y above the table; its left is the root's 0,
			// which is the table's left, so tin.x must be 0 (it is, in the record and the forced offset).
			if (tin.x !== 0) throw new Error("viewOf lays the block's left at the table's left: tin.x must be 0");
			const w = tableWidget(doc, src, WX, top, { ...o.table, scale: k });
			w.wrapper.childNodes.length = 0;
			w.table.parentNode = null;
			// `firstTable` (P13 print, two tables): word and offFromLp read the first table, as the Live Preview rig draws it.
			if (!(o.firstTable && cell)) {
				cell = w.cell;
				tableAt = i;
				widgetTop = top;
				tableEl = w.table;
			}
			if (o.table) extra = w.height - (g.topOf(s.lineEnd + 2) - top0 - top);
			const blockTop = (top + TABLE_GEOM.inset - tin.y) * k, tableBottom = (top + w.height - TABLE_GEOM.inset) * k;
			return { ...s, el: w.table, top: blockTop, height: tableBottom - blockTop };
		}
		const p = paragraphEl(doc, lines[s.lineStart]!, 0, top * k, LH * k, CW * k, FH * k);
		if (s.type !== "heading") return { ...s, el: p, top: top * k, height: LH * k };
		const h = new FEl("h1", "", doc).append(...p.childNodes);
		h.rect = p.rect;
		return { ...s, el: h, top: top * k, height: LH * k };
	});
	const paged = kind === "print" ? o.pagedBy ?? 0 : 0, R = o.layerLeft ?? 0;
	if (R) for (const s of sections) shiftRight(s.el as unknown as FEl, R);
	// `crlf`: the note's file has CRLF line ends, so the text the view's sections and cache give holds them (the layout as LF).
	const text = o.crlf ? lines.map((l, i) => (i < lines.length - 1 ? `${l}\r` : l)) : lines;
	const v = readOnlyView(doc, kind, text, sections, { pagedBy: paged, pagedFrom: tableAt });
	// `part`: the cache answers the whole note's sections and text, not the excerpt's (readOnlyView's own answer replaced).
	if (part) recordLines(v.root, v.root, { section: () => null, cached: () => ({ sections: all.map((s) => ({ type: s.type, lineStart: s.lineStart, lineEnd: s.lineEnd })), text: text.join("\n") }) });
	// The plugin's left reserve as it holds it on the root (EmbedInk.ts RESERVE_ATTR): layerAt reads its px as the layer's left.
	if (R) (v.root as unknown as FEl).attrs["data-handwriting-embed-left-reserve"] = JSON.stringify({ reserve: R, prop: "padding-left", ours: `${R}px`, was: "", priority: "" });
	// The root's frame (plan addendum 2, P16): its client offset, then its scroll (the blocks' offsetTops stand).
	const RX = o.rootAt?.x ?? 0, RY = o.rootAt?.y ?? 0, SY = o.scrollY ?? 0;
	if (RX || RY) shiftBy(v.root as unknown as FEl, RX, RY);
	if (SY) {
		(v.root as unknown as FEl).childNodes.forEach((c) => shiftBy(c as FEl | FText, 0, -SY));
		Object.defineProperty(v.root, "scrollTop", { value: SY, configurable: true, writable: true });
	}
	/** The word's client box (world units), the root's edge at 0. */
	const wordClient = (row: number, col: number, wd: string, nth = 0) => {
		const td = cell?.(row, col);
		if (!td) throw new Error(`no cell ${row}, ${col} in the view`);
		return cellWordAt(td, wd, k, nth, paged);
	};
	/** The word in the ink layer's frame (world units): its client box less the root's offset and the layer's left, plus the root's scroll. */
	const word = (row: number, col: number, wd: string, nth = 0) => {
		const b = wordClient(row, col, wd, nth), d = (R + RX) / k, e = (RY - SY) / k;
		return { ...b, left: b.left - d, right: b.right - d, x: b.x - d, top: b.top - e, bottom: b.bottom - e, y: b.y - e };
	};
	return {
		...v,
		kind,
		zoom: k,
		word,
		offFromLp: () => {
			// Measured, not taken from tin: the view's word from its block's held top-left, less Live Preview's from its widget.
			const b = v.blocks[tableAt]!, now = word(1, 1, "beta"), lp = g.wordAt(1, 1, "beta");
			const bx = (b.rect.left - RX) / k, by = (b.rect.top - paged - RY + SY) / k;
			return { dx: +(now.left - bx - (lp.left - WX)).toFixed(2), dy: +(now.top - by - (lp.top - widgetTop)).toFixed(2) };
		},
		inTableFromLp: () => {
			// Measured from the view's table element and from Live Preview's table (its widget's top-left plus the inset).
			const tb = tableEl!.rect, now = wordClient(1, 1, "beta"), lp = g.wordAt(1, 1, "beta");
			const tx = tb.left / k, ty = (tb.top - paged) / k, G = TABLE_GEOM.inset;
			return { dx: +(now.left - tx - (lp.left - WX - G)).toFixed(2), dy: +(now.top - ty - (lp.top - widgetTop - G)).toFixed(2) };
		},
	};
}

/** The strokes as view `v` draws them, an editor of signature `editor` open on the note (null: none open). */
function placedIn(v: View, path: string, editor: typeof SIG | null): readonly InkStroke[] {
	initEmbedInkAttachments((p) => inlineInk.attachments(p));
	initEmbedInkLineSignature(() => editor);
	try {
		return placeStrokes(v.root, inlineInk.strokes(path), v.held, v.zoom, path).strokes;
	} finally {
		initEmbedInkAttachments(null);
		initEmbedInkLineSignature(null);
	}
}

type Step = "source" | "live" | "type" | "type-app" | "draw" | "type-above" | "move-rows" | "space-open" | "space-close";

/**
 * The table's source as the app's table editor rewrites it on a cell edit (the app's record, OP case-1-type and b1-type: the
 * first of its transactions replaces the whole table with every cell padded to its column's width, the separator's
 * dashes to the same; the typed text comes in a second transaction).
 */
function paddedTable(src: string): string {
	const rows = src.split("\n").map((l) => splitRow(l).map((c) => c.trim()));
	const sep = src.split("\n").map((l) => SEPARATOR_ROW.test(l));
	const w = rows[0]!.map((_, c) => Math.max(3, ...rows.map((r, i) => (sep[i] ? 0 : (r[c] ?? "").length))));
	return rows.map((r, i) => "| " + w.map((n, c) => (sep[i] ? "-".repeat(n) : (r[c] ?? "").padEnd(n))).join(" | ") + " |").join("\n");
}

/**
 * Attach on beta (in Live Preview, or in Source mode on its table line), the line anchors hearing each change; steps, each
 * followed by the editor's paint and pass; the view's read.
 */
async function readScene(path: string, mode: "live" | "source" = "live", lines: readonly string[] = LINES, wide = 0) {
	let t: Rig, r: AttachmentRecord | null, was: Box;
	if (mode === "live") {
		({ t, r } = await attachedOn(path, "beta", 1, 1, lines));
		was = t.wordAt(1, 1, "beta");
	} else {
		t = rig(path, [], "source", lines);
		const n = 5, x0 = lines[n - 1]!.indexOf("beta") * CW, y0 = t.topOf(n) + (LH - FH) / 2;
		was = { left: x0, top: y0, right: x0 + 4 * CW, bottom: y0 + FH, width: 4 * CW, height: FH, x: x0, y: y0 };
		// `wide`: the circle reaches that many px further left (over the pipe before beta when it is 2 characters or more).
		inlineInk.record(path).strokes = [loop("c", x0 - 4 - wide, x0 + 4 * CW + 4, t.topOf(n) + 4, t.topOf(n) + LH - 4)];
		r = await t.tryAttach(["c"]);
	}
	const paint = painterOf(t, path), b0 = { ...inlineInk.strokes(path)[0]!.bbox };
	t.hear.anchors = true;
	const step = (f: () => void) => {
		const before = t.anchors.follow.snapshot();
		f();
		paint(before);
	};
	/** The anchor paths taken by the padded rewrite of the last type-app step (LineAnchors.changePaths after it). */
	const padPaths = { lazy: -1, eager: -1, why: "" };
	const run = (s: Step, front = "big ") => {
		if (s === "source" || s === "live") step(() => t.setMode(s));
		else if (s === "type") step(() => { const at = t.posOf(5, "beta"); t.edit(at, at, front); });
		else if (s === "type-app") {
			// The note is drawn and measured before the click, as in the app: without this paint the record holds no line read
			// whole and the padded rewrite takes the eager path (probe-c1-20261117T094603Z), which the app's anchor did not.
			step(() => {});
			const T = t.table()!, old = t.text().slice(T.from, T.to), pad = paddedTable(old);
			if (pad === old) throw new Error("premise: the app's rewrite pads this table (it would be no change)");
			const p0 = { ...t.anchors.changePaths };
			step(() => t.edit(T.from, T.to, pad));
			Object.assign(padPaths, { lazy: t.anchors.changePaths.lazy - p0.lazy, eager: t.anchors.changePaths.eager - p0.eager, why: t.anchors.changePaths.why });
			// The app's second transaction (its record, changes/case-1-type.json): the cell's whole span between its pipes replaced, the
			// typed text in front of beta, not an insert at beta. The app's pad took up the typed length, so its span kept its
			// length; here the column is beta's cell's own width and the span grows by the typed text. refindInTables reads the
			// trimmed cell text, which is the same in both.
			step(() => {
				const l = t.view.state.doc.line(5), p1 = l.text.indexOf("|", 1), p2 = l.text.indexOf("|", p1 + 1), span = l.text.slice(p1 + 1, p2);
				if (!span.startsWith(" beta")) throw new Error(`premise: beta's cell span starts " beta" (${JSON.stringify(span)})`);
				t.edit(l.from + p1 + 1, l.from + p2, span.replace(" beta", ` ${front}beta`));
			});
		}
		// A new line typed at the note's top, above the table (unsaved: a view built from the saved text does not have it).
		else if (s === "type-above") step(() => t.edit(0, 0, "New line on top\n\n"));
		// The table's two body rows swapped in one edit, as a row move or a sort writes them.
		else if (s === "move-rows") step(() => {
			const a = t.view.state.doc.line(5), b = t.view.state.doc.line(6);
			t.edit(a.from, b.to, `${b.text}\n${a.text}`);
		});
		// Insert Space with its seam at the table's first line, as the lift writes it (spaceUp): the text change
		// spaceTextChange gives for a drag of two lines down (open) or one line up (close: the blank line above taken back).
		// First the store move spaceUp makes, before its text change: the moving strokes spaceStoreIds keeps, by the same dy.
		else if (s === "space-open" || s === "space-close") step(() => {
			const T = t.table();
			if (!T) throw new Error("premise: the table is drawn as a table (Live Preview)");
			const c = t.overlay.spaceTextChange({ y: t.topOf(T.a), from: T.from, lineHeight: LH, doc: t.view.state.doc }, (s === "space-open" ? 2 : -1) * LH);
			if (!c.changes) throw new Error(`premise: Insert Space writes a text change at the table (${JSON.stringify(c)})`);
			const ids = t.overlay.spaceStoreIds(inlineInk.strokes(path).map((x) => x.id));
			if (ids.length) inlineInk.moveStrokes(path, ids, 0, c.dy);
			t.edit(c.changes.from, c.changes.to, c.changes.insert);
		});
		// A free stroke drawn over the first line: a page write, in the mode shown now.
		else step(() => { inlineInk.record(path).strokes = [...inlineInk.strokes(path), loop("f", 20, 120, 6, 34)]; });
	};
	/** In view `kind` now, an editor open (its signature) or none: the ink off its word, the anchor's line, the record's kept move. */
	const read = (kind: ViewKind, editor: "open" | "closed", o: Omit<ViewOpts, "shown"> = {}, lines = t.text().split("\n")) => {
		const v = viewOf(kind, lines, o), now = v.word(1, 1, "beta");
		const s = placedIn(v, path, editor === "open" ? SIG : null).find((x) => x.id === "c")!;
		const off = { dx: +(s.bbox.x - b0.x - (now.left - was.left)).toFixed(2), dy: +(s.bbox.y - b0.y - (now.top - was.top)).toFixed(2) };
		const rec = inlineInk.attachments(path)[0] as AttachmentRecord | undefined;
		/** The ink off another letter of beta's cell: `w` as this view draws it, less `at`, where it was when the ink was drawn. */
		const offAt = (w: string, at: { left: number; top: number }) => {
			const n = v.word(1, 1, w);
			return { dx: +(s.bbox.x - b0.x - (n.left - at.left)).toFixed(2), dy: +(s.bbox.y - b0.y - (n.top - at.top)).toFixed(2) };
		};
		return { off, offAt, line: inlineInk.strokes(path)[0]!.lineAnchor?.line, kept: rec?.shown ?? null, moved: { dx: +(now.left - was.left).toFixed(2), dy: +(now.top - was.top).toFixed(2) }, fromLp: v.offFromLp(), inTable: v.inTableFromLp() };
	};
	return { t, r, run, read, padPaths };
}
const readSaid = (name: string, kind: ViewKind, x: ReturnType<Awaited<ReturnType<typeof readScene>>["read"]>) =>
	note(`TABLE-ATTACH read-only ${name}, ${kind}: off its word ${JSON.stringify(x.off)}, anchor line ${x.line}, kept ${JSON.stringify(x.kept)}, word moved ${JSON.stringify(x.moved)}, word from its block less Live Preview's ${JSON.stringify(x.fromLp)}`);
const onIt = (off: { dx: number; dy: number }) => near(off.dx, 0) && near(off.dy, 0);
/**
 * Premise: the view's geometry took. Record: beta from its block is Live Preview's less (16 - RECORD_IN) on each axis.
 * Forced: at least 5 px off Live Preview's on each axis. A view that borrowed Live Preview's block would give 0, 0.
 */
function geomTook(x: { fromLp: { dx: number; dy: number } }, kind: ViewKind, geom: Geom): void {
	const tin = inOf(kind, geom), want = { dx: tin.x - TABLE_GEOM.inset, dy: tin.y - TABLE_GEOM.inset };
	expect(nearBy(x.fromLp, want, 0.01), `premise: the ${geom} block geometry took (beta from its block less Live Preview's ${JSON.stringify(x.fromLp)}, want ${JSON.stringify(want)})`).toBe(true);
	if (geom === "forced") expect(Math.min(Math.abs(x.fromLp.dx), Math.abs(x.fromLp.dy)), "premise: forced offset at least 5 px on each axis").toBeGreaterThanOrEqual(5);
}

/** The cases, by their steps after Attach and the editor at the read. */
const READ_CASES: { id: string; name: string; steps: Step[]; editor: "open" | "closed"; attach?: "live" | "source"; views?: readonly ViewKind[]; moves?: boolean; pagedBy?: number }[] = [
	{ id: "2", name: "Source mode and back, no edit", steps: ["source", "live"], editor: "open" },
	{ id: "3", name: "text typed in front of beta in Source mode, the pass in Source mode", steps: ["source", "type"], editor: "open", moves: true },
	{ id: "4", name: "case 3, then Live Preview and its pass", steps: ["source", "type", "live"], editor: "open", moves: true },
	{ id: "5", name: "Source mode and back, then text typed in Live Preview", steps: ["source", "live", "type"], editor: "open", moves: true },
	{ id: "a", name: "Source mode shown, no edit, the view read while it shows", steps: ["source"], editor: "open" },
	{ id: "b", name: "a stroke drawn in Source mode (a page write), then a reload with no editor open", steps: ["source", "draw"], editor: "closed" },
	{ id: "b-typed", name: "case 3, a stroke drawn in Source mode, then a reload with no editor open", steps: ["source", "type", "draw"], editor: "closed", moves: true },
	{ id: "c-3", name: "Export to PDF with no editor open, after case 3", steps: ["source", "type"], editor: "closed", views: ["print"], moves: true },
	{ id: "c-b", name: "Export to PDF with no editor open, after case b", steps: ["source", "draw"], editor: "closed", views: ["print"] },
	{ id: "e", name: "Attach made in Source mode on beta's table line, read at rest", steps: [], editor: "open", attach: "source" },
	{ id: "e-typed", name: "Attach made in Source mode, text typed in front of beta there", steps: ["type"], editor: "open", attach: "source" },
	{ id: "3-paged", name: "case 3, the print paged 120 px lower from the table on (its held tops stand)", steps: ["source", "type"], editor: "open", views: ["print"], moves: true, pagedBy: 120 },
];
/**
 * The four that were green on the stand-in only because its block was Live Preview's (plan addendum 3, Q1): in the app
 * case 1 is far off in every view. Each wants the fix here, in each view and both geometries; "case d, Live Preview
 * passed last" is the fourth, below. If one is green at base, its geometry did not take: fix the premise, never pin it.
 */
const READ_WERE_CONTROLS: typeof READ_CASES = [
	{ id: "1", name: "text typed in front of beta in Live Preview", steps: ["type"], editor: "open", moves: true },
	{ id: "1-paged", name: "case 1, the print paged 120 px lower from the table on (its held tops stand)", steps: ["type"], editor: "open", views: ["print"], moves: true, pagedBy: 120 },
	// Case 1 as the app writes it (its record, OP case-1-type): the table padded whole, then the typed text. In the app at fbf1405b
	// this one is 37 px left and 247 to 270 px below its word in every view.
	{ id: "1-app", name: "case 1 as the app writes it: the whole table padded, then text typed in front of beta", steps: ["type-app"], editor: "open", moves: true },
	{ id: "e-live", name: "Attach made in Source mode, then Live Preview and its pass", steps: ["live"], editor: "open", attach: "source" },
];
/** Attach in Live Preview, no step: the rest cell (plan addendum 1, P3). The app at fbf1405b: 3.5 px down in Reading view, 29 to 30 px up in an embed in Live Preview and the print. */
const READ_REST: (typeof READ_CASES)[number] = { id: "rest", name: "attached in Live Preview, no edit", steps: [], editor: "open" };


describe("a read-only view draws table-linked ink on its word, by the table it draws (Reading view, an embed, Export to PDF)", () => {
	const body = (c: (typeof READ_CASES)[number], kind: ViewKind, geom: Geom) => async () => {
		const s = await readScene(`table-ro-${c.id}-${kind}-${geom}.md`, c.attach ?? "live");
		expect(textOf(s.t, s.r), "premise: the link is on beta").toBe("beta");
		for (const st of c.steps) s.run(st);
		const x = s.read(kind, c.editor, { pagedBy: c.pagedBy, geom });
		readSaid(`case ${c.id} (${geom})`, kind, x);
		geomTook(x, kind, geom);
		if (c.moves) expect(x.moved.dx, "premise: beta moved right").toBeGreaterThan(20);
		// The app's anchor after case 1 (its saved sidecar e8734286): the table's last line, as the lazy re-take takes a run of equal tops.
		if (c.id === "1-app") {
			// The padded rewrite went the lazy way, as the app's anchor shows it did, and the anchor is then on the
			// table's last line, as the app saved it (its sidecar e8734286: line 12 of lines 6-12).
			note(`TABLE-ATTACH read-only case 1-app (${geom}), ${kind}: the padded rewrite's anchor paths ${JSON.stringify(s.padPaths)}`);
			expect([s.padPaths.lazy, s.padPaths.eager], "premise: the padded rewrite took the lazy path").toEqual([1, 0]);
			expect(x.line, "premise: the anchor on the table's last line, as the app saved it").toBe(s.t.table()!.b);
		}
		expect(onIt(x.off), `off its word by ${JSON.stringify(x.off)}`).toBe(true);
	};
	// Text typed in front of the word, written as the app writes it, keeps the target on
	// the word. At fbf1405b the app's whole-cell replace takes the whole cell ("big beta gamma", its sidecar e8734286) when the
	// typed text shares the word's first letters: "big " one, "be " two. "huge " shares none: green at base, the
	// control that the fix keeps.
	const FRONTS: { front: string; shares: number }[] = [{ front: "big ", shares: 1 }, { front: "be ", shares: 2 }, { front: "huge ", shares: 0 }];
	for (const { front, shares } of FRONTS) {
		it(`case 1-app, Live Preview, ${JSON.stringify(front)} typed in front (${shares} letter(s) shared with beta): the target stays on beta`, async () => {
			const path = `table-ro-1-app-target-${shares}.md`, s = await readScene(path);
			expect(textOf(s.t, s.r), "premise: the link is on beta").toBe("beta");
			let p = 0;
			while (p < front.length && front[p] === "beta"[p]) p++;
			expect(p, "premise: letters the typed text shares with beta").toBe(shares);
			s.run("type-app", front);
			const rec = inlineInk.attachments(path)[0] as AttachmentRecord, now = s.t.text().slice(rec.target.from, rec.target.to);
			note(`TABLE-ATTACH read-only case 1-app target, ${JSON.stringify(front)} in front: ${rec.target.from}-${rec.target.to} ${JSON.stringify(now)}`);
			expect(s.t.text().includes(`${front}beta gamma`), "premise: the typed text is in front of beta").toBe(true);
			expect(now, "the target after the app's typing").toBe("beta");
		});
	}
	for (const geom of GEOMS) {
		for (const c of [READ_REST, ...READ_WERE_CONTROLS, ...READ_CASES]) {
			for (const kind of c.views ?? VIEWS) it(`case ${c.id}, ${kind}, ${geom} block: ${c.name}: on its word`, body(c, kind, geom));
		}
	}

	// Case d: two panes on the note, Live Preview in one and Source mode in the other; whichever passed last.
	const twoPanes = async (path: string) => {
		const s = await readScene(path);
		expect(textOf(s.t, s.r), "premise: the link is on beta").toBe("beta");
		const rec = inlineInk.record(path), strokes = inlineInk.strokes(path), list = inlineInk.attachments(path).map((a) => ({ ...a }));
		// The second pane opens the note in Source mode: its own editor over the same text, the records as stored.
		const t2 = rig(path, [...strokes], "source", s.t.text().split("\n"));
		rec.basePage = { ...rec.basePage!, attachments: list };
		t2.overlay.resolveAttachedText(path);
		t2.hear.anchors = true;
		const paint2 = painterOf(t2, path), paint1 = painterOf(s.t, path);
		const pass = (t: Rig, paint: (b: ReturnType<Rig["anchors"]["follow"]["snapshot"]>) => void) => { const before = t.anchors.follow.snapshot(); t.anchors.follow.layoutChanged(); t.overlay.requestFollowMeasure(); paint(before); };
		return { s, live: () => pass(s.t, paint1), source: () => pass(t2, paint2) };
	};
	for (const geom of GEOMS) {
		for (const last of ["source", "live"] as const) {
			for (const kind of VIEWS) {
				// The Live Preview pane passing last was a control on the stand-in; it wants the fix too (addendum 3, Q1).
				it(`case d, ${kind}, ${geom} block: two panes, the ${last === "source" ? "Source mode" : "Live Preview"} pane passed last: on its word`, async () => {
					const d = await twoPanes(`table-ro-d-${last}-${kind}-${geom}.md`);
					if (last === "source") { d.live(); d.source(); } else { d.source(); d.live(); }
					const x = d.s.read(kind, "open", { geom });
					readSaid(`case d, ${last} last (${geom})`, kind, x);
					geomTook(x, kind, geom);
					expect(onIt(x.off), `off its word by ${JSON.stringify(x.off)}`).toBe(true);
				});
			}
		}
	}

	// The view lays the table out its own way (not Live Preview's in-table offset): its first column wraps at 60 px where Live Preview's
	// does not, as a print's narrower page wraps a wide table, so beta's column sits left of Live Preview's and its row
	// lower, inside the table. A fix that adds Live Preview's in-table word offset to the view's table origin is off here.
	const M1_LINES = [...LINES.slice(0, 2), "| Name of it | Note |", LINES[3]!, "| alpha one | beta gamma |", ...LINES.slice(5)];
	const M1_TABLE: TableOpts = { wrapAt: { 0: 60 } };
	const M1_CASES = [READ_REST, READ_WERE_CONTROLS[0]!, READ_CASES[1]!, READ_WERE_CONTROLS[1]!];
	for (const geom of GEOMS) {
		for (const c of M1_CASES) {
			for (const kind of c.views ?? VIEWS) {
				it(`case ${c.id}, ${kind}, ${geom} block, the view's table laid out unlike Live Preview's: ${c.name}: on its word`, async () => {
					const s = await readScene(`table-ro-m1-${c.id}-${kind}-${geom}.md`, "live", M1_LINES);
					expect(textOf(s.t, s.r), "premise: the link is on beta").toBe("beta");
					for (const st of c.steps) s.run(st);
					const x = s.read(kind, c.editor, { pagedBy: c.pagedBy, geom, table: M1_TABLE });
					readSaid(`case m1-${c.id} (${geom})`, kind, x);
					note(`TABLE-ATTACH read-only case m1-${c.id} (${geom}), ${kind}: beta from its table less Live Preview's ${JSON.stringify(x.inTable)}`);
					// Premise: the block geometry took (the in-table part taken out), and inside the table beta is at least 5 px
					// off Live Preview's on each axis.
					geomTook({ fromLp: { dx: +(x.fromLp.dx - x.inTable.dx).toFixed(2), dy: +(x.fromLp.dy - x.inTable.dy).toFixed(2) } }, kind, geom);
					expect(Math.min(Math.abs(x.inTable.dx), Math.abs(x.inTable.dy)), "premise: the view's table puts beta at least 5 px off Live Preview's on each axis").toBeGreaterThanOrEqual(5);
					// The view's word less Live Preview's at Attach holds the in-table offset too; the typing's move is the rest.
					if (c.moves) expect(x.moved.dx - x.inTable.dx, "premise: beta moved right").toBeGreaterThan(20);
					expect(onIt(x.off), `off its word by ${JSON.stringify(x.off)}`).toBe(true);
				});
			}
		}
	}

	// The ink layer at a left other than the root's edge (the word's x read in the layer's frame): the plugin's left reserve lays the
	// text and the layer 37 px right, as Reading view's readable column sits right of its root in the app. A fix that reads
	// the word's client x without the layer's left is 37 px off here; every other cell's layer is at the root's edge.
	const LAYER_LEFT = 37;
	for (const c of [READ_REST, READ_CASES[1]!]) {
		for (const kind of VIEWS) {
			it(`case ${c.id}, ${kind}, the ink layer ${LAYER_LEFT} px right of the root's edge: ${c.name}: on its word`, async () => {
				const s = await readScene(`table-ro-left-${c.id}-${kind}.md`);
				expect(textOf(s.t, s.r), "premise: the link is on beta").toBe("beta");
				for (const st of c.steps) s.run(st);
				const x = s.read(kind, c.editor, { layerLeft: LAYER_LEFT });
				readSaid(`case left-${c.id}`, kind, x);
				geomTook(x, kind, "record");
				// Premise: the root holds the reserve, and the view's word less its client box is the layer's left. (The reserve
				// is read by layerAt, which 60dcf1e8 lacks; the y1 plant shows the cell needs it.)
				const v = viewOf(kind, s.t.text().split("\n"), { layerLeft: LAYER_LEFT });
				expect(JSON.parse(v.root.getAttribute("data-handwriting-embed-left-reserve") ?? "{}").reserve, "premise: the root holds the reserve").toBe(LAYER_LEFT);
				// The root's first "beta" is the table's (no paragraph holds one): its client box less the layer-frame read.
				expect(+(cellWordAt(v.root as unknown as FEl, "beta").left - v.word(1, 1, "beta").left).toFixed(2), "premise: the word is read in the layer's frame").toBe(LAYER_LEFT);
				if (c.moves) expect(x.moved.dx, "premise: beta moved right").toBeGreaterThan(20);
				expect(onIt(x.off), `off its word by ${JSON.stringify(x.off)}`).toBe(true);
			});
		}
	}

	// The root's frame (its client offset and its scroll, the other half of the layer's frame): the root at client 237, 113, and Reading
	// view also scrolled 400 px down, the blocks' offsetTops unchanged. A fix that takes the character's client box as the
	// layer's frame, or adds a block's offsetTop to a client y, is off here; every other cell's root is at client 0, 0.
	const ROOT_AT = { x: 237, y: 113 }, SCROLL_Y = 400;
	for (const c of [READ_CASES[0]!, READ_CASES[1]!]) {
		for (const kind of VIEWS) {
			const sy = kind === "reading" ? SCROLL_Y : 0;
			it(`case ${c.id}, ${kind}, forced block, the root at client ${ROOT_AT.x}, ${ROOT_AT.y}${sy ? `, scrolled ${sy} px down` : ""}: ${c.name}: on its word`, async () => {
				const s = await readScene(`table-ro-frame-${c.id}-${kind}.md`);
				expect(textOf(s.t, s.r), "premise: the link is on beta").toBe("beta");
				for (const st of c.steps) s.run(st);
				const o = { geom: "forced" as const, rootAt: ROOT_AT, scrollY: sy };
				const x = s.read(kind, c.editor, o);
				readSaid(`case frame-${c.id}`, kind, x);
				geomTook(x, kind, "forced");
				const v = viewOf(kind, s.t.text().split("\n"), o), flat = viewOf(kind, s.t.text().split("\n"), { geom: "forced" });
				const root = v.root as unknown as FEl;
				expect([root.rect.left, root.rect.top], "premise: the root's client offset").toEqual([ROOT_AT.x, ROOT_AT.y]);
				expect((v.root as unknown as { scrollTop?: number }).scrollTop ?? 0, "premise: the root's scroll").toBe(sy);
				const tops = (w: View) => w.blocks.map((b) => (b as unknown as { offsetTop: number }).offsetTop);
				expect(tops(v), "premise: the blocks' offsetTops are as with the root at 0, 0").toEqual(tops(flat));
				// The root's first "beta" is the table's: its client box less the root-frame read is the offset less the scroll.
				const client = cellWordAt(root, "beta"), framed = v.word(1, 1, "beta");
				expect([+(client.left - framed.left).toFixed(2), +(client.top - framed.top).toFixed(2)], "premise: the word's client box is the root's offset less its scroll from its frame read").toEqual([ROOT_AT.x, ROOT_AT.y - sy]);
				const fw = flat.word(1, 1, "beta");
				expect(near(framed.left, fw.left, 0.01) && near(framed.top, fw.top, 0.01), `premise: the frame read is the flat view's (${framed.left}, ${framed.top} vs ${fw.left}, ${fw.top})`).toBe(true);
				if (c.moves) expect(x.moved.dx, "premise: beta moved right").toBeGreaterThan(20);
				expect(onIt(x.off), `off its word by ${JSON.stringify(x.off)}`).toBe(true);
			});
		}
	}
});

/** Where `s` is drawn less where it is stored, world units, rounded to 0.01. */
const shownBy = (placed: readonly InkStroke[], id: string, stored: { x: number; y: number }) => {
	const s = placed.find((x) => x.id === id)!;
	return { dx: +(s.bbox.x - stored.x).toFixed(2) || 0, dy: +(s.bbox.y - stored.y).toFixed(2) || 0 };
};
/** Within `tol` of `want` on each axis. */
const nearBy = (got: { dx: number; dy: number }, want: { dx: number; dy: number }, tol = 0.5) => near(got.dx, want.dx, tol) && near(got.dy, want.dy, tol);

type PinD = { dx: number; dy: number };
const pd = (dx: number, dy: number): PinD => ({ dx, dy });
/**
 * Base pins, measured at fbf1405b in the record-geometry views (swap1-23cc71ad-20261117T085206Z/lines.txt): what each
 * view draws today for ink the fix must not move. On the stand-in (Live Preview's block) they were the same in all three
 * views (old links 0, -3.52 and 16, 3.48 after cases 2 and 3, as BASE-MEASURE 6cbe76df); the record's block offsets
 * (Reading 3 px lower, an embed and the print 29.5 px higher) now carry into each.
 */
const PIN = {
	/** Links made before the fix (the whole table, the first "|"): drawn this far from stored, per case and view. */
	old: {
		"1": { reading: { table: pd(0, 3.01), pipe: pd(0, 3.01) }, embed: { table: pd(0, -29.49), pipe: pd(0, -29.49) }, print: { table: pd(0, -29.5), pipe: pd(0, -29.5) } },
		"2": { reading: { table: pd(0, -5.26), pipe: pd(0, -13.53) }, embed: { table: pd(0, -29.64), pipe: pd(0, -29.78) }, print: { table: pd(0, -29.64), pipe: pd(0, -29.79) } },
		"3": { reading: { table: pd(16, 1.74), pipe: pd(16, -6.53) }, embed: { table: pd(16, -22.64), pipe: pd(16, -22.78) }, print: { table: pd(16, -22.64), pipe: pd(16, -22.79) } },
	} as Record<string, Record<ViewKind, { table: PinD; pipe: PinD }>>,
	/** Free ink over the table, and a link on a paragraph word ("below"): drawn this far from stored, per case and view. */
	free: {
		"2": { reading: { free: pd(0, -5.26), para: pd(0, 0) }, embed: { free: pd(0, -29.64), para: pd(0, 0) }, print: { free: pd(0, -29.64), para: pd(0, 0) } },
		"3": { reading: { free: pd(0, -5.26), para: pd(0, 0) }, embed: { free: pd(0, -29.64), para: pd(0, 0) }, print: { free: pd(0, -29.64), para: pd(0, 0) } },
	} as Record<string, Record<ViewKind, { free: PinD; para: PinD }>>,
	/** A link whose word was deleted in Source mode, then Live Preview: drawn this far from stored, per view. */
	reattach: { reading: pd(54.38, 11.85), embed: pd(54.38, -4.4), print: pd(54.38, -4.4) } as Record<ViewKind, PinD>,
	/** Case 3 in a view that does not draw the word as the text has it: drawn this far from stored, per view (rule 3). */
	unread: { reading: pd(110.38, 11.85), embed: pd(110.38, -4.4), print: pd(110.38, -4.4) } as Record<ViewKind, PinD>,
	/** Tree walks a placement build makes at base with no table link (an embed's and a print's title look-up). */
	walks: { reading: 0, embed: 1, print: 1 } as Record<ViewKind, number>,
};

describe("pins: what the fix must not move, in each read-only view", () => {
	const stepsOf: Record<string, Step[]> = { "1": ["type"], "2": ["source", "live"], "3": ["source", "type"] };
	/** The editor rig `t` on `path`, painted after each step. */
	const stepper = (t: Rig, path: string) => {
		const paint = painterOf(t, path);
		t.hear.anchors = true;
		return (s: Step) => {
			const before = t.anchors.follow.snapshot();
			if (s === "source" || s === "live") t.setMode(s);
			else if (s === "type") { const at = t.posOf(5, "beta"); t.edit(at, at, "big "); }
			paint(before);
		};
	};

	for (const id of Object.keys(PIN.old)) {
		for (const kind of VIEWS) {
			it(`links made before the fix (the whole table, the first pipe), case ${id}, ${kind}: never re-targeted, drawn as base`, () => {
				// Saved as Attach made them at 1.5.0 to 1.5.2, as the pin above builds them.
				const path = `table-ro-old-${id}-${kind}.md`, t = rig(path, [], "live"), T = t.table()!, text = t.text(), rec = inlineInk.record(path), c = t.overlay.view.coordsAtPos(T.from)!;
				const s1 = t.circle(1, 1, "beta", 0, "s1"), s2 = t.circle(2, 0, "delta", 0, "s2"), at = { x: c.left, y: c.top }, layout = { width: SIG.width, font: SIG.fontPx };
				const records: AttachmentRecord[] = [
					{ v: 1, id: "att-table", strokeIds: ["s1"], target: targetAt(text, T.from, T.to, "paragraph"), ref: at, layout, probe: { id: "s1", x: s1.points[0]!.x, y: s1.points[0]!.y } },
					{ v: 1, id: "att-pipe", strokeIds: ["s2"], target: targetAt(text, T.from, T.from + 1, "range"), ref: at, layout, probe: { id: "s2", x: s2.points[0]!.x, y: s2.points[0]!.y } },
				];
				rec.strokes = [s1, s2];
				rec.basePage = { ...rec.basePage!, attachments: records.map((r) => ({ ...r, target: { ...r.target } })) };
				t.overlay.resolveAttachedText(path);
				const b1 = { ...s1.bbox }, b2 = { ...s2.bbox }, step = stepper(t, path);
				for (const s of stepsOf[id]!) step(s);
				const kinds = (inlineInk.attachments(path) as AttachmentRecord[]).map((a) => [a.target.kind, a.target.to - a.target.from]);
				const placed = placedIn(viewOf(kind, t.text().split("\n")), path, SIG);
				const got = { table: shownBy(placed, "s1", b1), pipe: shownBy(placed, "s2", b2) };
				note(`TABLE-ATTACH read-only pin old links, case ${id}, ${kind}: drawn from stored ${JSON.stringify(got)}, targets ${JSON.stringify(kinds)}`);
				expect(kinds.map((k) => k[0]), "never re-targeted").toEqual(["paragraph", "range"]);
				expect(kinds[1]![1], "the pipe link stays one character").toBe(1);
				expect([nearBy(got.table, PIN.old[id]![kind].table), nearBy(got.pipe, PIN.old[id]![kind].pipe)], `drawn ${JSON.stringify(got)}, base ${JSON.stringify(PIN.old[id]![kind])}`).toEqual([true, true]);
			});
		}
	}

	for (const id of Object.keys(PIN.free)) {
		for (const kind of VIEWS) {
			it(`free ink over the table and a link on a paragraph word, case ${id}, ${kind}: drawn as base`, async () => {
				const path = `table-ro-free-${id}-${kind}.md`, t = rig(path, [], "live"), n = 8, x0 = LINES[n - 1]!.indexOf("below") * CW, top = t.topOf(n);
				inlineInk.record(path).strokes = [loop("p", x0 - 4, x0 + 5 * CW + 4, top + 4, top + LH - 4)];
				const r = await t.tryAttach(["p"]);
				expect(textOf(t, r), "premise: the paragraph link is on below").toBe("below");
				const td = t.cellBox(1, 1), free = loop("f", td.left + 4, td.right - 4, td.top + 4, td.bottom - 4);
				inlineInk.record(path).strokes = [...inlineInk.strokes(path), free];
				const bp = { ...inlineInk.strokes(path)[0]!.bbox }, bf = { ...free.bbox }, step = stepper(t, path);
				for (const s of stepsOf[id]!) step(s);
				const placed = placedIn(viewOf(kind, t.text().split("\n")), path, SIG);
				const got = { free: shownBy(placed, "f", bf), para: shownBy(placed, "p", bp) };
				note(`TABLE-ATTACH read-only pin free ink + paragraph link, case ${id}, ${kind}: drawn from stored ${JSON.stringify(got)}`);
				expect([nearBy(got.free, PIN.free[id]![kind].free), nearBy(got.para, PIN.free[id]![kind].para)], `drawn ${JSON.stringify(got)}, base ${JSON.stringify(PIN.free[id]![kind])}`).toEqual([true, true]);
			});
		}
	}

	for (const kind of VIEWS) {
		it(`a link that needs reattachment (its word deleted), ${kind}: at its stored place plus today's correction, as base`, async () => {
			const s = await readScene(`table-ro-reattach-${kind}.md`);
			expect(textOf(s.t, s.r), "premise").toBe("beta");
			s.run("source");
			const at = s.t.posOf(5, "beta");
			s.t.edit(at, at + "beta gamma".length, "");
			s.run("live");
			const v = viewOf(kind, s.t.text().split("\n"));
			const placed = placedIn(v, `table-ro-reattach-${kind}.md`, SIG), stored = inlineInk.record(`table-ro-reattach-${kind}.md`);
			const got = shownBy(placed, "c", stored.strokes.find((x) => x.id === "c")!.bbox);
			note(`TABLE-ATTACH read-only pin needs reattachment, ${kind}: drawn from stored ${JSON.stringify(got)}`);
			expect(nearBy(got, PIN.reattach[kind]), `drawn ${JSON.stringify(got)}, base ${JSON.stringify(PIN.reattach[kind])}`).toBe(true);
		});
	}

	/** The strokes as `v` draws them with no attached group known (the records left out): what a free stroke's own anchor gives. */
	const placedNoRecords = (v: View, path: string, editor: typeof SIG | null) => {
		initEmbedInkAttachments(null);
		initEmbedInkLineSignature(() => editor);
		try {
			return placeStrokes(v.root, inlineInk.strokes(path), v.held, v.zoom, path).strokes;
		} finally {
			initEmbedInkLineSignature(null);
		}
	};
	// A table group whose members carry no lineAnchor (brief addendum 2 Q4, plan addendum 1 P4): rule 3, the stored place,
	// as today, in each view, an editor's live signature given and none. Case 3 then the anchor and the kept move taken
	// away; the view's word is read in the forced block, so it is off where the group was stored by more than 5 px on one
	// axis (premise; case 3 moves it 40 px in x, 0 in y): a fix that reads the table for this group would move it. (a) the group is the note's only ink; (b) the
	// group beside one anchored free stroke, which gets past the early return, and is itself drawn as with no group known.
	for (const kind of VIEWS) {
		for (const ed of ["live", "none"] as const) {
			for (const shape of ["a", "b"] as const) {
				it(`pin P4${shape}, ${kind}, editor ${ed === "live" ? "open" : "none"}: a table group with no member anchor${shape === "b" ? ", beside an anchored free stroke," : ""} is drawn at its stored place`, async () => {
					const path = `table-ro-p4${shape}-${kind}-${ed}.md`, s = await readScene(path);
					expect(textOf(s.t, s.r), "premise: the link is on beta").toBe("beta");
					s.run("source");
					s.run("type");
					if (shape === "b") s.run("draw");
					const c = inlineInk.strokes(path).find((x) => x.id === "c")!, rec = inlineInk.attachments(path)[0] as AttachmentRecord;
					delete (c as { lineAnchor?: unknown }).lineAnchor;
					delete (rec as { shown?: unknown }).shown;
					const v = viewOf(kind, s.t.text().split("\n"), { geom: "forced" }), now = v.word(1, 1, "beta");
					const off = { dx: now.left - rec.ref.x, dy: now.top - rec.ref.y };
					expect(Math.max(Math.abs(off.dx), Math.abs(off.dy)), `premise: the view's word is more than 5 px from the stored ref on one axis (${JSON.stringify(off)})`).toBeGreaterThan(5);
					const anchored = inlineInk.strokes(path).filter((x) => x.lineAnchor).map((x) => x.id);
					expect(anchored, "premise: which strokes carry an anchor").toEqual(shape === "b" ? ["f"] : []);
					expect(rec.target.kind, "premise: the group's target is a range in the cell").toBe("range");
					const sig = ed === "live" ? SIG : null, placed = placedIn(v, path, sig);
					const got = shownBy(placed, "c", c.bbox);
					note(`TABLE-ATTACH read-only pin P4${shape}, ${kind}, editor ${ed}: the group drawn from stored ${JSON.stringify(got)}, view's word from the ref ${JSON.stringify(off)}`);
					expect(got, "the stored place").toEqual({ dx: 0, dy: 0 });
					if (shape === "b") {
						const f = inlineInk.strokes(path).find((x) => x.id === "f")!.bbox;
						const fGot = shownBy(placed, "f", f), fBase = shownBy(placedNoRecords(v, path, sig), "f", f);
						note(`TABLE-ATTACH read-only pin P4b, ${kind}, editor ${ed}: the free stroke drawn from stored ${JSON.stringify(fGot)}, with no group known ${JSON.stringify(fBase)}`);
						expect(fGot, "the free stroke as with no group known").toEqual(fBase);
					}
				});
			}
		}
	}
});

describe("read-only views: the stored place where the view cannot read the word, a text size by one ratio, the cost", () => {
	it("a view whose width today's signature rule does not honour (case 3): every view draws the link at its stored place, as today", async () => {
		const s = await readScene("table-ro-width.md");
		s.run("source");
		s.run("type");
		for (const kind of VIEWS) {
			const v = viewOf(kind, s.t.text().split("\n")), stored = inlineInk.strokes("table-ro-width.md").find((x) => x.id === "c")!.bbox;
			const got = shownBy(placedIn(v, "table-ro-width.md", { width: 700, fontPx: SIG.fontPx, charWidth: SIG.charWidth }), "c", stored);
			note(`TABLE-ATTACH read-only width not honoured, ${kind}: drawn from stored ${JSON.stringify(got)}`);
			expect(got, kind).toEqual({ dx: 0, dy: 0 });
		}
	});

	for (const how of ["shown text", "hidden cell"] as const) {
		for (const kind of VIEWS) it(`a view whose table does not draw the word as the text has it (${how}), case 3, ${kind}: as base`, async () => {
			const path = `table-ro-unread-${how === "shown text" ? "text" : "hidden"}-${kind}.md`, s = await readScene(path);
			s.run("source");
			s.run("type");
			{
				const lines = s.t.text().split("\n");
				const v = how === "shown text" ? viewOf(kind, lines, { shown: (l) => l.replace("big beta", "big BETA") }) : viewOf(kind, lines);
				if (how === "hidden cell") Object.assign(((v.root as unknown as FEl).querySelectorAll("td")[0]!.parentNode as FEl).children[1]!.style, { display: "none" });
				const stored = inlineInk.strokes(path).find((x) => x.id === "c")!.bbox, base = placedIn(viewOf(kind, lines), path, SIG).find((x) => x.id === "c")!.bbox;
				const got = shownBy(placedIn(v, path, SIG), "c", stored), want = { dx: +(base.x - stored.x).toFixed(2), dy: +(base.y - stored.y).toFixed(2) };
				note(`TABLE-ATTACH read-only word not drawn (${how}), ${kind}: drawn from stored ${JSON.stringify(got)}`);
				expect(nearBy(got, PIN.unread[kind]), `${kind}: drawn ${JSON.stringify(got)}, base's ${JSON.stringify(want)} in a view that draws it`).toBe(true);
			}
		});
	}

	for (const kind of VIEWS) {
		it(`case 3 at a text size of 125% (width and font by one ratio), ${kind}: on its word, the anchor honoured as today`, async () => {
			const s = await readScene(`table-ro-size-${kind}.md`), was = s.t.wordAt(1, 1, "beta");
			s.run("source");
			s.run("type");
			const k = 1.25, v = viewOf(kind, s.t.text().split("\n"), { zoom: k }), stored = inlineInk.strokes(`table-ro-size-${kind}.md`).find((x) => x.id === "c")!.bbox;
			const big = { width: Math.round(SIG.width * k), fontPx: SIG.fontPx * k, charWidth: SIG.charWidth * k };
			const placed = placedIn(v, `table-ro-size-${kind}.md`, big), now = v.word(1, 1, "beta");
			const got = shownBy(placed, "c", stored);
			// Stored is where the ink was at Attach, beside beta where it was then (was): the ink less beta's move since.
			const off = { dx: +(got.dx - (now.left - was.left)).toFixed(2), dy: +(got.dy - (now.top - was.top)).toFixed(2) };
			note(`TABLE-ATTACH read-only text size 125%, ${kind}: drawn from stored ${JSON.stringify(got)}, off its word ${JSON.stringify(off)}`);
			expect(got.dy !== 0 || got.dx !== 0, "premise: the anchor is honoured at one ratio (not the stored place)").toBe(true);
			expect(onIt(off), `off its word by ${JSON.stringify(off)}`).toBe(true);
		});
	}

	// The same, with the zoom the paint uses: inkZoomOf reads the view's text size over the note's reference font (the
	// cell above hands the ratio in, so a view that read its zoom wrong would pass there). On the word first, then the
	// zoom read, so a wrong zoom shows as ink off the word.
	for (const kind of VIEWS) {
		it(`case 3 at a text size of 125%, the zoom read from the view's text size (inkZoomOf), ${kind}: on its word`, async () => {
			const path = `table-ro-size-read-${kind}.md`, s = await readScene(path), was = s.t.wordAt(1, 1, "beta");
			s.run("source");
			s.run("type");
			const k = 1.25, v = viewOf(kind, s.t.text().split("\n"), { zoom: k }), stored = inlineInk.strokes(path).find((x) => x.id === "c")!.bbox;
			const win = v.doc.defaultView as unknown as { getComputedStyle: (e: unknown) => Record<string, unknown> }, css = win.getComputedStyle.bind(win);
			win.getComputedStyle = (e) => ({ ...css(e), fontSize: `${SIG.fontPx * k}px` });
			initEmbedInkFontRef(() => SIG.fontPx);
			let zoom: number;
			try {
				zoom = inkZoomOf(v.root, path);
			} finally {
				initEmbedInkFontRef(null);
			}
			const big = { width: Math.round(SIG.width * k), fontPx: SIG.fontPx * k, charWidth: SIG.charWidth * k };
			const got = shownBy(placedIn({ ...v, zoom }, path, big), "c", stored), now = v.word(1, 1, "beta");
			const off = { dx: +(got.dx - (now.left - was.left)).toFixed(2), dy: +(got.dy - (now.top - was.top)).toFixed(2) };
			note(`TABLE-ATTACH read-only text size 125% by inkZoomOf, ${kind}: zoom ${zoom}, drawn from stored ${JSON.stringify(got)}, off its word ${JSON.stringify(off)}`);
			expect(got.dy !== 0 || got.dx !== 0, "premise: the anchor is honoured at one ratio (not the stored place)").toBe(true);
			expect(onIt(off), `off its word by ${JSON.stringify(off)} (zoom ${zoom})`).toBe(true);
			expect(zoom, "the view's ink zoom is its text size over the note's reference font").toBeCloseTo(k, 6);
		});
	}

	for (const kind of VIEWS) {
		it(`the count, ${kind}: one placement build reads the table at most once and at most one character box per table link; a note with no table link reads none`, async () => {
			const s = await readScene(`table-ro-count-${kind}.md`);
			s.run("source");
			s.run("type");
			const v = viewOf(kind, s.t.text().split("\n"));
			let ranges = 0;
			const make = v.doc.createRange.bind(v.doc);
			v.doc.createRange = () => { ranges++; return make(); };
			v.doc.reads.walk = 0;
			placedIn(v, `table-ro-count-${kind}.md`, SIG);
			const one = { walks: v.doc.reads.walk, ranges };
			// The same note with its link on a paragraph word and free ink over the table: no table link.
			const path = `table-ro-count-none-${kind}.md`, t = rig(path, [], "live"), n = 8, x0 = LINES[n - 1]!.indexOf("below") * CW, top = t.topOf(n);
			const td = t.cellBox(1, 1);
			inlineInk.record(path).strokes = [loop("p", x0 - 4, x0 + 5 * CW + 4, top + 4, top + LH - 4)];
			expect(textOf(t, await t.tryAttach(["p"])), "premise: the paragraph link").toBe("below");
			inlineInk.record(path).strokes = [...inlineInk.strokes(path), loop("f", td.left + 4, td.right - 4, td.top + 4, td.bottom - 4)];
			const w = viewOf(kind, t.text().split("\n"));
			let none = 0;
			const make2 = w.doc.createRange.bind(w.doc);
			w.doc.createRange = () => { none++; return make2(); };
			w.doc.reads.walk = 0;
			placedIn(w, path, SIG);
			note(`TABLE-ATTACH read-only count, ${kind}: one table link: ${JSON.stringify(one)}; no table link: walks ${w.doc.reads.walk}, ranges ${none}`);
			expect(one.walks - PIN.walks[kind], "one walk of the table, over base's own").toBeLessThanOrEqual(1);
			expect(one.ranges, "at most one character box for the one link").toBeLessThanOrEqual(1);
			expect([w.doc.reads.walk, none], "no table link: no read over base's own").toEqual([PIN.walks[kind], 0]);
		});
	}

	// Two links in one table (the table read once per build, not once per link): the table is walked once for both, and
	// each link reads at most one character box. Both are drawn on their words, so each went through the table.
	for (const kind of VIEWS) {
		it(`the count, ${kind}, two links in one table: one walk of the table, at most one character box per link, each on its word`, async () => {
			const path = `table-ro-count-two-${kind}.md`, s = await readScene(path);
			expect(textOf(s.t, s.r), "premise: the first link is on beta").toBe("beta");
			const e0 = s.t.wordAt(2, 1, "epsilon");
			inlineInk.record(path).strokes = [...inlineInk.strokes(path), loop("e", e0.left - 4, e0.right + 4, e0.top - 4, e0.bottom + 4)];
			s.t.selection.selectExactly(["e"]);
			expect(s.t.overlay.attachSelected(), "premise: Attach is offered for the second").toBe(true);
			await Promise.resolve();
			const list = inlineInk.attachments(path) as AttachmentRecord[], r2 = list.find((a) => a.strokeIds.includes("e")) ?? null;
			expect(list, "premise: two records").toHaveLength(2);
			expect(textOf(s.t, r2), "premise: the second link is on epsilon").toBe("epsilon");
			const b0 = s.t.wordAt(1, 1, "beta"), stored = new Map(inlineInk.strokes(path).map((x) => [x.id, { ...x.bbox }]));
			expect(inlineInk.strokes(path).filter((x) => x.lineAnchor).map((x) => x.id).sort(), "premise: both links carry an anchor").toEqual(["c", "e"]);
			const v = viewOf(kind, s.t.text().split("\n"), { geom: "forced" });
			let ranges = 0;
			const make = v.doc.createRange.bind(v.doc);
			v.doc.createRange = () => { ranges++; return make(); };
			v.doc.reads.walk = 0;
			const placed = placedIn(v, path, SIG);
			const walks = v.doc.reads.walk;
			const offOf = (id: string, now: Box, was: Box) => { const d = shownBy(placed, id, stored.get(id)!); return { dx: +(d.dx - (now.left - was.left)).toFixed(2), dy: +(d.dy - (now.top - was.top)).toFixed(2) }; };
			const offs = { c: offOf("c", v.word(1, 1, "beta"), b0), e: offOf("e", v.word(2, 1, "epsilon"), e0) };
			note(`TABLE-ATTACH read-only count, ${kind}, two links in one table: walks ${walks} (base's own ${PIN.walks[kind]}), ranges ${ranges}, off ${JSON.stringify(offs)}`);
			expect(onIt(offs.c) && onIt(offs.e), `both on their words: ${JSON.stringify(offs)}`).toBe(true);
			expect(walks - PIN.walks[kind], "one walk of the table for both links, over base's own").toBeLessThanOrEqual(1);
			expect(ranges, "at most one character box per link").toBeLessThanOrEqual(2);
		});
	}
});

/** The strokes as `v` draws them with `records` as the note's groups (null: none known), an editor of signature `editor`. */
function placedWith(v: View, path: string, editor: typeof SIG | null, records: readonly AttachmentRecord[] | null): readonly InkStroke[] {
	initEmbedInkAttachments(records ? () => records : null);
	initEmbedInkLineSignature(() => editor);
	try {
		return placeStrokes(v.root, inlineInk.strokes(path), v.held, v.zoom, path).strokes;
	} finally {
		initEmbedInkAttachments(null);
		initEmbedInkLineSignature(null);
	}
}
/**
 * The note's groups with no target a view can find in a table (each one's kind a paragraph): what a view drew before
 * tables were read, each member at its anchor's dy plus its group's kept dx while its anchor passes. Base's own output.
 */
const notInTable = (path: string) => (inlineInk.attachments(path) as AttachmentRecord[]).map((r) => ({ ...r, target: { ...r.target, kind: "paragraph" as const } }));
/** Where view `v` draws each of `ids` less where it is stored, as the fix draws it and as base drew it. */
function bothWays(v: View, path: string, editor: typeof SIG | null, ids: readonly string[], stored: ReadonlyMap<string, { x: number; y: number }>) {
	const fix = placedIn(v, path, editor), base = placedWith(v, path, editor, notInTable(path));
	return Object.fromEntries(ids.map((id) => [id, { fix: shownBy(fix, id, stored.get(id)!), base: shownBy(base, id, stored.get(id)!) }]));
}
const storedOf = (path: string) => new Map(inlineInk.strokes(path).map((x) => [x.id, { x: x.bbox.x, y: x.bbox.y }]));
const lessMove = (d: { dx: number; dy: number }, now: { left: number; top: number }, was: { left: number; top: number }) => ({ dx: +(d.dx - (now.left - was.left)).toFixed(2), dy: +(d.dy - (now.top - was.top)).toFixed(2) });

describe("read-only views: a table link's correction is the word's alone; the word's place in its cell; base's own output where the view cannot read the word", () => {
	// P5 (plan addendum 1): the view's word less the group's ref, never on top of the member's anchor dy or its group's kept
	// dx. Case 3 in the forced block: base draws the link at its anchor's dy and its kept dx, each more than 5 px (premise).
	for (const kind of VIEWS) {
		it(`P5a, case 3, ${kind}, forced block: the anchor's dy and the kept dx are each over 5 px at base; the link is drawn on its word, not on top of them`, async () => {
			const path = `table-ro-p5a-${kind}.md`, s = await readScene(path);
			expect(textOf(s.t, s.r), "premise: the link is on beta").toBe("beta");
			const was = s.t.wordAt(1, 1, "beta"), stored = storedOf(path);
			s.run("source");
			s.run("type");
			const v = viewOf(kind, s.t.text().split("\n"), { geom: "forced" }), now = v.word(1, 1, "beta");
			const got = bothWays(v, path, SIG, ["c"], stored).c!, rec = inlineInk.attachments(path)[0] as AttachmentRecord;
			note(`TABLE-ATTACH read-only P5a, ${kind}: drawn from stored ${JSON.stringify(got)}, kept ${JSON.stringify(rec.shown ?? null)}, word moved ${JSON.stringify(moved(was, now))}`);
			expect(Math.abs(got.base.dy), `premise: base's anchor dy over 5 px (${got.base.dy})`).toBeGreaterThan(5);
			expect(Math.abs(rec.shown?.dx ?? 0), "premise: the kept dx over 5 px").toBeGreaterThan(5);
			expect(Math.abs(got.base.dx), `premise: base draws the kept dx (${got.base.dx})`).toBeGreaterThan(5);
			expect(onIt(lessMove(got.fix, now, was)), `off its word by ${JSON.stringify(lessMove(got.fix, now, was))}`).toBe(true);
		});
	}
	// P5 (b): a group of two members whose anchors sit on two lines (Attach in Source mode: the circle on beta's line, a
	// short mark on the next row's line), text then typed in front of beta there. Both are drawn by the word's one move.
	for (const kind of VIEWS) {
		it(`P5b, ${kind}, forced block: a two-member group, its members' anchors on two lines: each member drawn by the word's move`, async () => {
			const path = `table-ro-p5b-${kind}.md`, t = rig(path, [], "source"), n = 5;
			const x0 = LINES[n - 1]!.indexOf("beta") * CW, y5 = t.topOf(n), y6 = t.topOf(n + 1);
			const was = { left: x0, top: y5 + (LH - FH) / 2 };
			inlineInk.record(path).strokes = [loop("c", x0 - 4, x0 + 4 * CW + 4, y5 + 4, y5 + LH - 4), loop("u", x0, x0 + 4 * CW, y6 + 4, y6 + 12)];
			const r = await t.tryAttach(["c", "u"]);
			expect(textOf(t, r), "premise: the link is on beta").toBe("beta");
			expect([...r!.strokeIds].sort(), "premise: both strokes in the group").toEqual(["c", "u"]);
			const stored = storedOf(path), paint = painterOf(t, path);
			t.hear.anchors = true;
			const before = t.anchors.follow.snapshot(), at = t.posOf(n, "beta");
			t.edit(at, at, "big ");
			paint(before);
			const lines = inlineInk.strokes(path).map((x) => x.lineAnchor?.line);
			const v = viewOf(kind, t.text().split("\n"), { geom: "forced" }), now = v.word(1, 1, "beta");
			const got = bothWays(v, path, SIG, ["c", "u"], stored), offs = { c: lessMove(got.c!.fix, now, was), u: lessMove(got.u!.fix, now, was) };
			const baseOff = { c: lessMove(got.c!.base, now, was), u: lessMove(got.u!.base, now, was) };
			note(`TABLE-ATTACH read-only P5b, ${kind}: anchor lines ${JSON.stringify(lines)}, drawn from stored ${JSON.stringify(got)}, off ${JSON.stringify(offs)}, base off ${JSON.stringify(baseOff)}`);
			expect(lines.every((l) => l !== undefined) && new Set(lines).size, "premise: both members anchored, on two lines").toBe(2);
			// Premise: base draws the two members apart (each by its own line's anchor), each over 5 px off the word.
			expect(Math.abs(got.c!.base.dy - got.u!.base.dy), "premise: base draws the members by two anchors").toBeGreaterThan(5);
			expect(Math.min(...[baseOff.c, baseOff.u].map((o) => Math.max(Math.abs(o.dx), Math.abs(o.dy)))), "premise: each member over 5 px off the word at base").toBeGreaterThan(5);
			expect(onIt(offs.c) && onIt(offs.u), `both members on the word's move: ${JSON.stringify(offs)}`).toBe(true);
		});
	}

	// P10: Attach made in Source mode, at rest: a circle that reaches over the pipe before beta, one that reaches on over
	// alpha's middle (its centre still in beta's cell), and a row with no spaces. Red at 36c7cbf9 on the target, not the
	// view: Source mode's word pick (attachTargetIn, wordsIn on the table's text line) took the pipe as a word ("| beta"),
	// two cells ("alpha | beta") and a row with no spaces as one word ("|alpha|beta|"); none is inside one cell, so no view
	// read the table for it. The fix (sourceRowTargetIn, InkOverlayLineAnchors.ts) picks the cell by the box's centre, as
	// tableTargetIn does in a drawn table, then the words of that cell only.
	const NOSPACE = [...LINES.slice(0, 2), "|Name|Note|", "|---|---|", "|alpha|beta|", "|delta|epsilon|", ...LINES.slice(6)];
	const P10: { id: string; name: string; lines: readonly string[]; wide: number }[] = [
		{ id: "wide", name: "a circle reaching over the pipe before beta", lines: LINES, wide: 3 * CW },
		{ id: "span", name: "a circle reaching on over alpha's middle, its centre in beta's cell", lines: LINES, wide: 5.6 * CW },
		{ id: "nospace", name: "the row written |alpha|beta| with no spaces", lines: NOSPACE, wide: 0 },
	];
	for (const c of P10) {
		for (const kind of VIEWS) {
			it(`P10 ${c.id}, ${kind}, forced block: Attach made in Source mode, ${c.name}: on its word`, async () => {
				const path = `table-ro-p10-${c.id}-${kind}.md`, s = await readScene(path, "source", c.lines, c.wide);
				expect(textOf(s.t, s.r), "the Source-mode target is beta, inside one cell").toBe("beta");
				if (c.wide) {
					const l = c.lines[4]!, x0 = l.indexOf("beta") * CW, pipe = l.lastIndexOf("|", l.indexOf("beta")) * CW;
					const bb = inlineInk.strokes(path)[0]!.bbox;
					expect(bb.x, "premise: the circle reaches over the pipe").toBeLessThan(pipe);
					expect(pipe, "premise").toBeLessThan(x0);
					if (c.id === "span") {
						const alphaMid = (l.indexOf("alpha") + 2.5) * CW;
						expect(bb.x, "premise: the circle reaches over alpha's middle").toBeLessThan(alphaMid);
						expect(bb.x + bb.width / 2, "premise: the circle's centre is right of the pipe, in beta's cell").toBeGreaterThan(pipe + CW);
					}
				}
				const x = s.read(kind, "open", { geom: "forced" });
				readSaid(`P10 ${c.id}`, kind, x);
				geomTook(x, kind, "forced");
				expect(onIt(x.off), `off its word by ${JSON.stringify(x.off)}`).toBe(true);
			});
		}
	}

	// P10, the rest of Source mode's pick. A word with markup in its cell ("**beta**" in the bold-link and bold-word rows):
	// its cell's text, as tableTargetIn takes a word not drawn one to one, and each view then draws the ink on beta. Red at
	// 36c7cbf9 and ac22db28: the target was "**beta**", which no view draws as the text has it, so the ink kept its
	// stored place, 82 px off.
	const swapRow = (to: string) => LINES.map((l) => (l === "| alpha | beta gamma |" ? to : l));
	const MARKUP = [
		// `cell`: the cell's text from its first drawn character.
		{ id: "bold-link", lines: swapRow("| alpha | **beta** [gamma](g.md) |"), cell: "beta** [gamma](g.md)" },
		{ id: "bold-word", lines: swapRow("| alpha | **beta** gamma |"), cell: "beta** gamma" },
	];
	for (const c of MARKUP) {
		for (const kind of VIEWS) {
			it(`P10 markup ${c.id}, ${kind}, forced block: Attach made in Source mode on a word with markup: its cell's text, on its word`, async () => {
				const path = `table-ro-p10-markup-${c.id}-${kind}.md`, s = await readScene(path, "source", c.lines);
				expect(textOf(s.t, s.r), "the Source-mode target is the cell's text").toBe(c.cell);
				const x = s.read(kind, "open", { geom: "forced" });
				readSaid(`P10 markup ${c.id}`, kind, x);
				geomTook(x, kind, "forced");
				expect(onIt(x.off), `off its word by ${JSON.stringify(x.off)}`).toBe(true);
			});
		}
	}

	/** Attach in Source mode, a small circle centred at `cx` on line `n`: the target's text or null, the notices, the centre. */
	const sourcePick = async (path: string, lines: readonly string[], n: number, cx: number, half: number) => {
		const t = rig(path, [], "source", lines);
		inlineInk.record(path).strokes = [loop("c", cx - half, cx + half, t.topOf(n) + 4, t.topOf(n) + LH - 4)];
		notices.said.length = 0;
		t.selection.selectExactly(["c"]);
		if (!t.overlay.attachSelected()) notices.said.push(ATTACH_STRINGS.noText);
		await Promise.resolve();
		await Promise.resolve();
		const list = inlineInk.attachments(path) as AttachmentRecord[], bb = inlineInk.strokes(path)[0]!.bbox;
		const got = list.length === 1 ? textOf(t, list[0]!) : list.length === 0 ? null : `${list.length} groups`;
		note(`TABLE-ATTACH Source pick ${path}: target ${JSON.stringify(got)}, notices ${JSON.stringify(notices.said)}`);
		return { got, said: [...notices.said], cx: bb.x + bb.width / 2 };
	};
	it("P10 separator, Source mode: a circle on the separator line's dashes: nothing attaches, and Attach says there is no text under the ink", async () => {
		const l = LINES[3]!, x0 = l.indexOf("---") * CW;
		const r = await sourcePick("table-src-p10-sep.md", LINES, 4, x0 + 1.5 * CW, 1.5 * CW + 4);
		expect(r.got, "no target on the separator row").toBeNull();
		expect(r.said.includes(ATTACH_STRINGS.noText), `today's notice (${JSON.stringify(r.said)})`).toBe(true);
	});
	it("P10 empty cell, Source mode: a circle on an empty cell: nothing attaches, and Attach says there is no text under the ink", async () => {
		const r = await sourcePick("table-src-p10-empty.md", swapRow("|  | beta gamma |"), 5, 2 * CW, CW);
		expect(r.got, "no target in an empty cell, not the row").toBeNull();
		expect(r.said.includes(ATTACH_STRINGS.noText), `today's notice (${JSON.stringify(r.said)})`).toBe(true);
	});
	it("P10 padding, Source mode: a centre in beta's padding, nearer alpha's text than beta's, under no word: beta's cell text", async () => {
		// A cell's place runs pipe to pipe, not its text alone; no word under the box gives the cell's text, not the row.
		const lines = swapRow("| alpha |    beta gamma |"), l = lines[4]!, pipe = l.lastIndexOf("|", l.indexOf("beta")) * CW;
		const r = await sourcePick("table-src-p10-pad.md", lines, 5, pipe + 1.5 * CW, 0.4 * CW);
		expect(r.cx - (pipe + CW), "premise: the centre is past the pipe's glyph").toBeGreaterThan(0);
		expect(l.indexOf("beta") * CW - r.cx, "premise: nearer alpha's text than beta's").toBeGreaterThan(r.cx - (l.indexOf("alpha") + 5) * CW);
		expect(r.got, "beta's cell text").toBe("beta gamma");
	});
	it("P10 tie, Source mode: a centre at the middle of the pipe between alpha and beta, under no word: the left cell's text", async () => {
		const l = LINES[4]!, pipe = l.lastIndexOf("|", l.indexOf("beta")) * CW;
		const r = await sourcePick("table-src-p10-tie.md", LINES, 5, pipe + CW / 2, 0.3 * CW);
		expect(Math.abs(r.cx - (pipe + CW / 2)), `premise: the centre is at the pipe's middle, as far from alpha's cell as from beta's (${r.cx})`).toBeLessThan(1e-7);
		expect(r.got, "a dead-even tie: the left cell").toBe("alpha");
	});

	// P10, the ref of a whole-cell link after Source mode: the bold-link row attached in Live Preview (its target the
	// cell's text), then the steps. Each view draws the ink on the cell's first drawn character: beta's place at rest, and
	// where beta was when "big " is typed in front of it inside the cell (the ink follows its cell, not the word).
	for (const c of READ_CASES.filter((x) => ["2", "3", "4", "5", "a"].includes(x.id))) {
		for (const kind of VIEWS) {
			it(`P10 whole-cell ref, case ${c.id}, ${kind}, forced block: the bold-link row attached in Live Preview, ${c.name}: on its cell's first drawn character`, async () => {
				const s = await readScene(`table-ro-p10-wholeref-${c.id}-${kind}.md`, "live", MARKUP[0]!.lines);
				expect(textOf(s.t, s.r), "premise: the link is the cell's text").toBe(MARKUP[0]!.cell);
				for (const st of c.steps) s.run(st);
				const x = s.read(kind, c.editor, { geom: "forced" });
				readSaid(`P10 whole-cell ref ${c.id}`, kind, x);
				geomTook(x, kind, "forced");
				const offCell = { dx: +(x.off.dx + x.moved.dx).toFixed(2), dy: +(x.off.dy + x.moved.dy).toFixed(2) };
				expect(onIt(offCell), `off its cell's first drawn character by ${JSON.stringify(offCell)}`).toBe(true);
			});
		}
	}

	// Trap shapes: beta's cell starting with markup the source and the drawing do not share one to
	// one. Attach in Source mode and in Live Preview: each view draws the ink on its ref's letter (0 px); Live Preview to
	// Source mode and back, and Source mode to Live Preview and back: the ink keeps its ref's letter (`src` in the source
	// line, `drawn` in the drawn cell; the cell's first drawn character for a whole-cell target, beta for a word).
	// Not here: inline math ($x$), which the app draws with no text node and a width this rig does
	// not model (a 0 here would be no proof).
	const TRAPS = [
		{ id: "alias", row: "| alpha | [[page\\|beta]] gamma |", src: "beta", drawn: "beta" },
		{ id: "tag", row: "| alpha | <u>beta</u> gamma |", src: "beta", drawn: "beta" },
		{ id: "escape", row: "| alpha | \\*beta gamma |", src: "*", drawn: "*" },
		{ id: "escape-under", row: "| alpha | \\_beta gamma |", src: "_", drawn: "_" },
		{ id: "entity", row: "| alpha | &amp;beta gamma |", src: "&", drawn: "&" },
	];
	for (const c of TRAPS) {
		const lines = swapRow(c.row);
		/** The ref's letter: the cell's first drawn one for a whole-cell target, else beta (Source: its column; Live Preview: drawn). */
		const refOf = (t: Rig, r: AttachmentRecord | null) => {
			const whole = textOf(t, r) !== "beta", l = lines[4]!, col = whole ? l.indexOf(c.src) : l.indexOf("beta");
			return { whole, src: { left: col * CW, top: t.topOf(5) + (LH - FH) / 2 }, live: () => t.wordAt(1, 1, whole ? c.drawn : "beta") };
		};
		for (const mode of ["live", "source"] as const) {
			for (const kind of VIEWS) {
				it(`trap ${c.id}, Attach in ${mode}, ${kind}, forced block: on its ref's letter`, async () => {
					const s = await readScene(`table-ro-trap-${c.id}-${mode}-${kind}.md`, mode, lines);
					expect(s.r, "premise: Attach made a record").not.toBeNull();
					// Where the ref's letter was when the ink was drawn, in the mode it was drawn in (no mode change before here).
					const ref = refOf(s.t, s.r), at = mode === "source" ? ref.src : ref.live();
					const x = s.read(kind, "open", { geom: "forced" }), off = ref.whole ? x.offAt(c.drawn, at) : x.off;
					readSaid(`trap ${c.id} ${mode} (target ${JSON.stringify(textOf(s.t, s.r))}, off beta ${JSON.stringify(x.off)})`, kind, x);
					geomTook(x, kind, "forced");
					expect(onIt(off), `off its ref's letter (${ref.whole ? JSON.stringify(c.drawn) : "beta"}) by ${JSON.stringify(off)}`).toBe(true);
				});
			}
		}
		it(`trap ${c.id}, editor: attached in Live Preview, Source mode then Live Preview: on its ref's letter`, async () => {
			const { t, r } = await attachedOn(`table-c6-trap-${c.id}.md`, "beta", 1, 1, lines);
			expect(r, "premise: Attach made a record").not.toBeNull();
			const live = refOf(t, r).live();
			t.setMode("source");
			// The source line's top is read in Source mode: in Live Preview line 5 lies under the table widget.
			const ref = refOf(t, r), inSource = t.offset(r!.id);
			t.setMode("live");
			const back = t.offset(r!.id), want = { dx: +(ref.src.left - live.left).toFixed(2), dy: +(ref.src.top - live.top).toFixed(2) };
			note(`TABLE-ATTACH trap ${c.id} editor LP: target ${JSON.stringify(textOf(t, r))}, Source ${JSON.stringify(inSource)} want ${JSON.stringify(want)}, Live Preview again ${JSON.stringify(back)}`);
			expect(!!inSource && near(inSource.dx, want.dx) && near(inSource.dy, want.dy), `on its ref in Source mode (${JSON.stringify(inSource)}, want ${JSON.stringify(want)})`).toBe(true);
			expect(!!back && near(back.dx, 0) && near(back.dy, 0), `on its ref in Live Preview (${JSON.stringify(back)})`).toBe(true);
		});
		it(`trap ${c.id}, editor: attached in Source mode, Live Preview then Source mode: on its ref's letter`, async () => {
			const path = `table-c6-trap-${c.id}-src.md`, t = rig(path, [], "source", lines), x0 = lines[4]!.indexOf("beta") * CW;
			inlineInk.record(path).strokes = [loop("c", x0 - 4, x0 + 4 * CW + 4, t.topOf(5) + 4, t.topOf(5) + LH - 4)];
			const r = await t.tryAttach(["c"]);
			expect(r, "premise: Attach made a record").not.toBeNull();
			const ref = refOf(t, r);
			t.setMode("live");
			const live = ref.live(), inLive = t.offset(r!.id);
			t.setMode("source");
			const again = t.offset(r!.id), want = { dx: +(live.left - ref.src.left).toFixed(2), dy: +(live.top - ref.src.top).toFixed(2) };
			note(`TABLE-ATTACH trap ${c.id} editor Source: target ${JSON.stringify(textOf(t, r))}, Live Preview ${JSON.stringify(inLive)} want ${JSON.stringify(want)}, Source again ${JSON.stringify(again)}`);
			expect(!!inLive && near(inLive.dx, want.dx) && near(inLive.dy, want.dy), `on its ref in Live Preview (${JSON.stringify(inLive)}, want ${JSON.stringify(want)})`).toBe(true);
			expect(!!again && near(again.dx, 0) && near(again.dy, 0), `no move in Source mode (${JSON.stringify(again)})`).toBe(true);
		});
	}

	// P11: the word second in its cell ("x beta"), and a view whose cell padding differs from Live Preview's.
	const SECOND = [...LINES.slice(0, 4), "| alpha | x beta |", ...LINES.slice(5)];
	for (const kind of VIEWS) {
		for (const c of [READ_REST, READ_CASES[1]!]) {
			it(`P11 second word, case ${c.id}, ${kind}, forced block: beta second in its cell ("x beta"): ${c.name}: on its word`, async () => {
				const s = await readScene(`table-ro-p11-second-${c.id}-${kind}.md`, "live", SECOND);
				expect(textOf(s.t, s.r), "premise: the link is on beta").toBe("beta");
				expect(s.t.wordAt(1, 1, "beta").left - s.t.cellBox(1, 1).left, "premise: beta is not at its cell's first character").toBeGreaterThan(TABLE_GEOM.padIn + 5);
				for (const st of c.steps) s.run(st);
				const x = s.read(kind, c.editor, { geom: "forced" });
				readSaid(`P11 second ${c.id}`, kind, x);
				geomTook(x, kind, "forced");
				expect(onIt(x.off), `off its word by ${JSON.stringify(x.off)}`).toBe(true);
			});
			it(`P11 padding, case ${c.id}, ${kind}, forced block: the view's cells padded 22 px in and 6 px more above their text: ${c.name}: on its word`, async () => {
				const s = await readScene(`table-ro-p11-pad-${c.id}-${kind}.md`);
				expect(textOf(s.t, s.r), "premise: the link is on beta").toBe("beta");
				for (const st of c.steps) s.run(st);
				const x = s.read(kind, c.editor, { geom: "forced", table: { pad: { left: 22, top: 6 } } });
				readSaid(`P11 pad ${c.id}`, kind, x);
				geomTook({ fromLp: { dx: +(x.fromLp.dx - x.inTable.dx).toFixed(2), dy: +(x.fromLp.dy - x.inTable.dy).toFixed(2) } }, kind, "forced");
				expect(Math.min(Math.abs(x.inTable.dx), Math.abs(x.inTable.dy)), `premise: the padding puts beta at least 5 px off Live Preview's in its table on each axis (${JSON.stringify(x.inTable)})`).toBeGreaterThanOrEqual(5);
				expect(onIt(x.off), `off its word by ${JSON.stringify(x.off)}`).toBe(true);
			});
		}
	}

	// P12: where the view cannot honour or read the link, base's own output, in a state where the kept dx is not 0 and the
	// view's word is more than 5 px from where base draws the link: a fix that reads the table there would move it.
	for (const kind of VIEWS) {
		it(`P12 width, case 3, ${kind}, forced block: the pane resized (the editor's signature at 700 px, no ink written since): as base's own output`, async () => {
			const path = `table-ro-p12-width-${kind}.md`, s = await readScene(path), was = s.t.wordAt(1, 1, "beta"), stored = storedOf(path);
			s.run("source");
			s.run("type");
			const v = viewOf(kind, s.t.text().split("\n"), { geom: "forced" }), now = v.word(1, 1, "beta"), rec = inlineInk.attachments(path)[0] as AttachmentRecord;
			const got = bothWays(v, path, { width: 700, fontPx: SIG.fontPx, charWidth: SIG.charWidth }, ["c"], stored).c!, word = moved(was, now);
			note(`TABLE-ATTACH read-only P12 width, ${kind}: drawn from stored ${JSON.stringify(got)}, word moved ${JSON.stringify(word)}, kept ${JSON.stringify(rec.shown ?? null)}`);
			expect(Math.abs(rec.shown?.dx ?? 0), "premise: the kept dx is not 0").toBeGreaterThan(5);
			expect(Math.max(Math.abs(word.dx - got.base.dx), Math.abs(word.dy - got.base.dy)), "premise: the view's word over 5 px from base's place").toBeGreaterThan(5);
			expect(got.fix, "as base's own output").toEqual(got.base);
		});
		for (const how of ["shown text", "hidden cell"] as const) {
			it(`P12 unread (${how}), case 3, ${kind}, forced block: the view does not draw the word as the text has it: as base's own output`, async () => {
				const path = `table-ro-p12-unread-${how === "shown text" ? "text" : "hidden"}-${kind}.md`, s = await readScene(path), was = s.t.wordAt(1, 1, "beta"), stored = storedOf(path);
				s.run("source");
				s.run("type");
				const lines = s.t.text().split("\n");
				const v = how === "shown text" ? viewOf(kind, lines, { geom: "forced", shown: (l) => l.replace("big beta", "big BETA") }) : viewOf(kind, lines, { geom: "forced" });
				const word = moved(was, viewOf(kind, lines, { geom: "forced" }).word(1, 1, "beta"));
				if (how === "hidden cell") Object.assign(((v.root as unknown as FEl).querySelectorAll("td")[0]!.parentNode as FEl).children[1]!.style, { display: "none" });
				const got = bothWays(v, path, SIG, ["c"], stored).c!, rec = inlineInk.attachments(path)[0] as AttachmentRecord;
				note(`TABLE-ATTACH read-only P12 unread (${how}), ${kind}: drawn from stored ${JSON.stringify(got)}, the word (where a view draws it) moved ${JSON.stringify(word)}`);
				expect(Math.abs(rec.shown?.dx ?? 0), "premise: the kept dx is not 0").toBeGreaterThan(5);
				expect(Math.max(Math.abs(word.dx - got.base.dx), Math.abs(word.dy - got.base.dy)), "premise: the word over 5 px from base's place").toBeGreaterThan(5);
				expect(got.fix, "as base's own output").toEqual(got.base);
			});
		}
		it(`P12 reattach, ${kind}, forced block: a link whose word was deleted in Source mode, then Live Preview: as base's own output`, async () => {
			const path = `table-ro-p12-reattach-${kind}.md`, s = await readScene(path), stored = storedOf(path);
			s.run("source");
			const at = s.t.posOf(5, "beta");
			s.t.edit(at, at + "beta gamma".length, "");
			s.run("live");
			const v = viewOf(kind, s.t.text().split("\n"), { geom: "forced" });
			const got = bothWays(v, path, SIG, ["c"], stored).c!;
			note(`TABLE-ATTACH read-only P12 reattach, ${kind}: drawn from stored ${JSON.stringify(got)}`);
			expect(got.base.dx !== 0 || got.base.dy !== 0, "premise: base moves it (its anchor dy or kept dx is not 0)").toBe(true);
			expect(got.fix, "as base's own output").toEqual(got.base);
		});
		// G2-14: a cell that holds only an image embed has no drawn character in the view (the image draws no text; here
		// its source is not shown). The link on it (cell 9's target "p.png\|100]]") is drawn at the stored place, as base,
		// never at the next cell's word.
		it(`P14 G2-14, ${kind}, forced block: a link on a cell that holds only an image embed: the stored place, as base's own output`, async () => {
			const path = `table-ro-p14-g214-${kind}.md`, EMBED = "![[p.png\\|100]]";
			const lines = LINES.map((l) => (l === "| alpha | beta gamma |" ? `| ${EMBED} | beta gamma |` : l));
			const { t, r } = await attachedOn(path, "p.png", 1, 0, lines);
			expect(r ? t.text().slice(r.target.from, r.target.to) : null, "premise: the link is on the embed's cell").toBe("p.png\\|100]]");
			const stored = storedOf(path), was = t.wordAt(1, 0, "p.png");
			const v = viewOf(kind, t.text().split("\n"), { geom: "forced", shown: (l) => l.replace(EMBED, "") });
			const got = bothWays(v, path, SIG, ["c"], stored).c!, next = moved(was, v.word(1, 1, "beta"));
			note(`TABLE-ATTACH read-only P14 G2-14, ${kind}: drawn from stored ${JSON.stringify(got)}, the next cell's beta from p.png ${JSON.stringify(next)}`);
			expect(Math.max(Math.abs(next.dx - got.base.dx), Math.abs(next.dy - got.base.dy)), "premise: the next cell's word over 5 px from base's place").toBeGreaterThan(5);
			expect(got.fix, "as base's own output").toEqual(got.base);
		});
	}

	// G2-12: a heading embed (![[note#Part]]) or a block embed (![[note#^id]]) renders an excerpt of the note. The app
	// draws no ink on either: the section-embed gate (EmbedInkRoot.ts embedInkIsSectionEmbed, read by
	// attachEmbedInkOnceReady before any layout; EmbedFold-4 runs it through the post-processor), whatever the note holds.
	// Below the gate, a render of the excerpt laid onto the whole note's cached sections pairs no block (mapCachedSections),
	// so the view reads no line and the link is at its stored place, as base, never on another word. Its word in the
	// excerpt sits higher than in the note, so a view that read the excerpt's table would move it. Covered elsewhere: a
	// hover preview takes the same root path as an embed, and draws no ink unless the render is the whole note
	// (EmbedFold-4's hover cells). Not covered: a note in a Canvas card, whose rects carry a CSS transform scale, not a zoom.
	const PART = ["Text above the table here", "", "# Part", "", "| Name | Note |", "| --- | --- |", "| alpha | beta gamma |", "| delta | epsilon |", "", "Text below the table here"];
	for (const c of [{ id: "heading", how: "a heading embed holding the table", sub: "#Part", part: [2, 9] }, { id: "block", how: "a block embed of the table", sub: "#^tbl", part: [4, 7] }] as const) {
		it(`P14 G2-12, ${c.id}, embed, forced block: ${c.how}: no ink by the section-embed gate; below it, the stored place, as base's own output, never another word`, async () => {
			const path = `table-ro-p14-g212-${c.id}.md`, { t, r } = await attachedOn(path, "beta", 1, 1, PART);
			expect(textOf(t, r), "premise: the link is on beta").toBe("beta");
			const fd = new FDoc(), host = new FEl("div", "internal-embed markdown-embed", fd), whole = new FEl("div", "internal-embed markdown-embed", fd);
			host.attrs.src = `${path.replace(/\.md$/, "")}${c.sub}`;
			whole.attrs.src = path.replace(/\.md$/, "");
			const inPart = new FEl("div", "", fd), inWhole = new FEl("div", "", fd);
			host.append(inPart);
			whole.append(inWhole);
			expect(embedInkIsSectionEmbed(inWhole as unknown as HTMLElement, null), "control: a whole-note embed is no section embed").toBe(false);
			expect(embedInkIsSectionEmbed(inPart as unknown as HTMLElement, null), `the gate: ![[${host.attrs.src}]] is a section embed, so it gets no ink`).toBe(true);
			const stored = storedOf(path), was = t.wordAt(1, 1, "beta"), lines = t.text().split("\n");
			const all = viewOf("embed", lines, { geom: "forced", part: [0, lines.length - 1] }), w = bothWays(all, path, SIG, ["c"], stored).c!;
			expect(onIt(lessMove(w.fix, all.word(1, 1, "beta"), was)), `control: the whole note's embed draws it on beta (off by ${JSON.stringify(lessMove(w.fix, all.word(1, 1, "beta"), was))})`).toBe(true);
			expect(w.fix, "control: there it reads the table (base, which does not, draws it elsewhere)").not.toEqual(w.base);
			const v = viewOf("embed", lines, { geom: "forced", part: c.part }), now = moved(was, v.word(1, 1, "beta"));
			const got = bothWays(v, path, SIG, ["c"], stored).c!;
			note(`TABLE-ATTACH read-only P14 G2-12, ${c.id}: drawn from stored ${JSON.stringify(got)}, beta in the excerpt from stored ${JSON.stringify(now)}, whole note ${JSON.stringify(w)}`);
			expect(Math.max(Math.abs(now.dx), Math.abs(now.dy)), "premise: beta in the excerpt over 5 px from its stored place").toBeGreaterThan(5);
			expect(got.fix, "the stored place").toEqual({ dx: 0, dy: 0 });
			expect(got.fix, "as base's own output").toEqual(got.base);
		});
	}
});

/** Attach in Live Preview on `word` (shown row `row`, column `col`) of `lines`; read: the ink off that word in a view of the text now. */
async function wordScene(path: string, lines: readonly string[], word: string, row: number, col: number) {
	const { t, r } = await attachedOn(path, word, row, col, lines);
	const was = t.wordAt(row, col, word), b0 = { ...inlineInk.strokes(path)[0]!.bbox };
	const read = (kind: ViewKind, o: Omit<ViewOpts, "shown"> = {}) => {
		const v = viewOf(kind, t.text().split("\n"), o), now = v.word(row, col, word);
		const s = placedIn(v, path, SIG).find((x) => x.id === "c")!;
		return { off: { dx: +(s.bbox.x - b0.x - (now.left - was.left)).toFixed(2), dy: +(s.bbox.y - b0.y - (now.top - was.top)).toFixed(2) }, fromLp: v.offFromLp() };
	};
	return { t, r, read };
}

describe("read-only views: the row shapes, the text the view draws from, and two tables", () => {
	const swap = (from: string, to: string, lines: readonly string[] = LINES) => lines.map((l) => (l === from ? to : l));
	const ROW = "| alpha | beta gamma |";
	// P9: the record's shapes (bold and a link, an empty cell, a line break in a cell, an escaped pipe) and a header-row
	// target and a short body row, each attached in Live Preview at rest, read in the forced block.
	const SHAPES: { id: string; lines: readonly string[]; word: string; row: number; col: number; target: string }[] = [
		// A cell with markup is taken whole (as an alias or an embed's cell); its first drawn character is beta's.
		{ id: "bold-link", lines: swap(ROW, "| alpha | **beta** [gamma](g.md) |"), word: "beta", row: 1, col: 1, target: "beta** [gamma](g.md)" },
		{ id: "empty-cell", lines: swap(ROW, "|  | beta gamma |"), word: "beta", row: 1, col: 1, target: "beta" },
		{ id: "br", lines: swap(ROW, "| alpha | gamma<br>beta |"), word: "beta", row: 1, col: 1, target: "beta" },
		{ id: "escaped-pipe", lines: swap(ROW, "| al\\|pha | beta gamma |"), word: "beta", row: 1, col: 1, target: "beta" },
		{ id: "header", lines: LINES, word: "Note", row: 0, col: 1, target: "Note" },
		{ id: "short-row", lines: swap("| delta | epsilon |", "| delta |"), word: "delta", row: 2, col: 0, target: "delta" },
	];
	for (const c of SHAPES) {
		for (const kind of VIEWS) {
			it(`P9 ${c.id}, ${kind}, forced block: attached in Live Preview on ${c.word}, at rest: on its word`, async () => {
				const s = await wordScene(`table-ro-p9-${c.id}-${kind}.md`, c.lines, c.word, c.row, c.col);
				expect(textOf(s.t, s.r), `premise: the link is on ${c.target}`).toBe(c.target);
				const x = s.read(kind, { geom: "forced" });
				note(`TABLE-ATTACH read-only P9 ${c.id}, ${kind}: off its word ${JSON.stringify(x.off)}, beta from its block less Live Preview's ${JSON.stringify(x.fromLp)}`);
				geomTook(x, kind, "forced");
				expect(onIt(x.off), `off its word by ${JSON.stringify(x.off)}`).toBe(true);
			});
		}
	}

	// A word led by a lone mark the cell draws ("~5", "=SUM", "_id", "`x", "_a_b"): drawn one to one, a word target made
	// now, so the views move its link with its word as they do beta's. Beta follows it in its cell: the view's block is
	// placed by beta (offFromLp).
	for (const w of ["~5", "=SUM", "_id", "`x", "_a_b"]) {
		for (const kind of VIEWS) {
			it(`P10 lone mark ${JSON.stringify(w)}, ${kind}, forced block: attached in Live Preview, at rest: on its word`, async () => {
				const s = await wordScene(`table-ro-lone-mark-${w.charCodeAt(0)}-${w.length}-${kind}.md`, swap(ROW, `| alpha | ${w} beta |`), w, 1, 1);
				expect(textOf(s.t, s.r), "premise: the link is on its word").toBe(w);
				const x = s.read(kind, { geom: "forced" });
				note(`TABLE-ATTACH read-only lone mark ${JSON.stringify(w)}, ${kind}: off its word ${JSON.stringify(x.off)}, from its block less Live Preview's ${JSON.stringify(x.fromLp)}`);
				geomTook(x, kind, "forced");
				expect(onIt(x.off), `off its word by ${JSON.stringify(x.off)}`).toBe(true);
			});
		}
	}

	// P9 rest (G2-11): a pipe run drawn as a paragraph above the table, holding the same row; two identical tables with the
	// link in the second; a table in a callout. Each attached in Source mode on its own line (the Live Preview rig draws
	// the first pipe run only), read in the forced block.
	const TABLE = LINES.slice(2, 6);
	const REST: { id: string; lines: readonly string[]; line: number; types: string[] }[] = [
		{ id: "pipe-paragraph", lines: [ROW, "", ...LINES], line: 7, types: ["paragraph", "paragraph", "table", "paragraph"] },
		{ id: "twin-tables", lines: [...LINES.slice(0, 7), ...TABLE, "", LINES[7]!], line: 10, types: ["paragraph", "table", "table", "paragraph"] },
	];
	/** Attach in Source mode on beta in source line `n` (1-based): the scene, beta's place then and the stroke's stored box. */
	const sourceOn = async (path: string, lines: readonly string[], n: number) => {
		const t = rig(path, [], "source", lines), x0 = lines[n - 1]!.indexOf("beta") * CW, y0 = t.topOf(n);
		inlineInk.record(path).strokes = [loop("c", x0 - 4, x0 + 4 * CW + 4, y0 + 4, y0 + LH - 4)];
		const r = await t.tryAttach(["c"]);
		return { t, r, was: { left: x0, top: y0 + (LH - FH) / 2 }, b0: { ...inlineInk.strokes(path)[0]!.bbox } };
	};
	for (const c of REST) {
		for (const kind of VIEWS) {
			it(`P9 ${c.id}, ${kind}, forced block: attached in Source mode on the table's beta: on that beta`, async () => {
				const path = `table-ro-p9-${c.id}-${kind}.md`, s = await sourceOn(path, c.lines, c.line);
				expect([textOf(s.t, s.r), s.r?.target.kind, s.t.view.state.doc.lineAt(s.r!.target.from).number], "premise: the link is on the table's beta, on its line").toEqual(["beta", "range", c.line]);
				expect(sectionsOf(c.lines).map((x) => x.type), "premise: the view's sections").toEqual(c.types);
				const v = viewOf(kind, c.lines, { geom: "forced" }), now = v.word(1, 1, "beta");
				// The other beta: the paragraph's, or the first table's.
				const tds = (v.root as unknown as FEl).querySelectorAll("td"), firstTd = tds.find((td) => cellWordAtOr(td, "beta"))!;
				const other = c.id === "twin-tables" ? cellWordAt(firstTd, "beta") : v.blocks[0]!.rect;
				expect(Math.abs(now.top - other.top), "premise: the other beta over 5 px above").toBeGreaterThan(5);
				const got = shownBy(placedIn(v, path, SIG), "c", s.b0), off = lessMove(got, now, s.was);
				note(`TABLE-ATTACH read-only P9 ${c.id}, ${kind}: drawn from stored ${JSON.stringify(got)}, off its word ${JSON.stringify(off)}`);
				expect(onIt(off), `off its word by ${JSON.stringify(off)}`).toBe(true);
			});
		}
	}
	// A callout holding a table: words in a callout are a later change (AttachBlockWidgets.test.ts), so its link is no
	// table link; each view draws it as base did.
	const CALLOUT = [LINES[0]!, "", "> [!note] Title", ...TABLE.map((l) => `> ${l}`), "", LINES[7]!];
	for (const kind of VIEWS) {
		it(`P9 callout, ${kind}, forced block: a table in a callout, attached in Source mode on beta: drawn as base`, async () => {
			const path = `table-ro-p9-callout-${kind}.md`, s = await sourceOn(path, CALLOUT, 6);
			expect(sectionsOf(CALLOUT).map((x) => x.type), "premise: the view's sections").toEqual(["paragraph", "callout", "paragraph"]);
			note(`TABLE-ATTACH read-only P9 callout, ${kind}: target ${JSON.stringify(s.r ? { kind: s.r.target.kind, text: textOf(s.t, s.r) } : null)}`);
			expect(s.r, "premise: Attach made a link").not.toBeNull();
			const v = viewOf(kind, CALLOUT, { geom: "forced" });
			expect(cellWordAtOr((v.root as unknown as FEl).querySelectorAll("td").find((td) => cellWordAtOr(td, "beta"))!, "beta"), "premise: the view draws beta in the callout's table").toBe(true);
			const both = bothWays(v, path, SIG, ["c"], storedOf(path));
			note(`TABLE-ATTACH read-only P9 callout, ${kind}: drawn from stored ${JSON.stringify(both)}`);
			expect(both.c!.fix, "as base").toEqual(both.c!.base);
		});
	}

	// P14: the view's table scrolled sideways (a wide table in a narrow column): the word sits that far left in the view.
	for (const kind of VIEWS) {
		for (const c of [READ_REST, READ_CASES[1]!]) {
			it(`P14 sideways, case ${c.id}, ${kind}, forced block: the view's table scrolled 30 px sideways: ${c.name}: on its word`, async () => {
				const s = await readScene(`table-ro-p14-side-${c.id}-${kind}.md`);
				expect(textOf(s.t, s.r), "premise: the link is on beta").toBe("beta");
				for (const st of c.steps) s.run(st);
				const x = s.read(kind, c.editor, { geom: "forced", table: { scrollLeft: 30 } });
				readSaid(`P14 sideways ${c.id}`, kind, x);
				expect(x.fromLp.dx, "premise: the view's word 30 px further left than the block geometry alone").toBeCloseTo(FORCED_IN.x - TABLE_GEOM.inset - 30, 1);
				expect(onIt(x.off), `off its word by ${JSON.stringify(x.off)}`).toBe(true);
			});
		}
	}

	// P8: the text a view draws from. (a) Unsaved typing above the table with the view open: the view draws the saved text.
	// (b) The two body rows swapped (a row move or a sort) with beta in both: the link stays on its own row's beta.
	// (c) A note with CRLF line ends: the view's text holds them.
	for (const kind of VIEWS) {
		it(`P8 unsaved, case 3, ${kind}, forced block: a line typed above the table, unsaved, the view drawing the saved text: on its word`, async () => {
			const s = await readScene(`table-ro-p8-unsaved-${kind}.md`);
			expect(textOf(s.t, s.r), "premise: the link is on beta").toBe("beta");
			s.run("source");
			s.run("type");
			const saved = s.t.text().split("\n");
			s.run("type-above");
			expect(s.t.text().split("\n").length, "premise: the editor's text has two lines more than the saved").toBe(saved.length + 2);
			const x = s.read(kind, "open", { geom: "forced" }, saved);
			readSaid("P8 unsaved", kind, x);
			geomTook(x, kind, "forced");
			expect(onIt(x.off), `off its word by ${JSON.stringify(x.off)}`).toBe(true);
		});
		it(`P8 rows, ${kind}, forced block: the body rows swapped, beta in both rows: on its own row's beta`, async () => {
			const lines = swap("| delta | epsilon |", "| delta | beta epsilon |"), path = `table-ro-p8-rows-${kind}.md`;
			const s = await readScene(path, "live", lines);
			expect(textOf(s.t, s.r), "premise: the link is on beta").toBe("beta");
			const was = s.t.wordAt(1, 1, "beta"), b0 = { ...inlineInk.strokes(path)[0]!.bbox };
			s.run("move-rows");
			const rec = inlineInk.attachments(path)[0] as AttachmentRecord, line = s.t.view.state.doc.lineAt(rec.target.from).number;
			note(`TABLE-ATTACH read-only P8 rows, ${kind}: target ${JSON.stringify(textOf(s.t, rec))} on line ${line}`);
			expect([textOf(s.t, rec), line], "premise: the link is on beta, in its row's new line").toEqual(["beta", 6]);
			const v = viewOf(kind, s.t.text().split("\n"), { geom: "forced" }), now = v.word(2, 1, "beta"), other = v.word(1, 1, "beta");
			expect(Math.abs(now.top - other.top), "premise: the two rows' beta over 5 px apart").toBeGreaterThan(5);
			const got = shownBy(placedIn(v, path, SIG), "c", b0), off = lessMove(got, now, was);
			note(`TABLE-ATTACH read-only P8 rows, ${kind}: drawn from stored ${JSON.stringify(got)}, off its row's beta ${JSON.stringify(off)}`);
			expect(onIt(off), `off its word by ${JSON.stringify(off)}`).toBe(true);
		});
		it(`P8 CRLF, case 3, ${kind}, forced block: the note's file has CRLF line ends: on its word`, async () => {
			const s = await readScene(`table-ro-p8-crlf-${kind}.md`);
			expect(textOf(s.t, s.r), "premise: the link is on beta").toBe("beta");
			s.run("source");
			s.run("type");
			const x = s.read(kind, "open", { geom: "forced", crlf: true });
			readSaid("P8 CRLF", kind, x);
			geomTook(x, kind, "forced");
			expect(onIt(x.off), `off its word by ${JSON.stringify(x.off)}`).toBe(true);
		});
	}

	// P13: links in two tables (the second attached in Source mode on its own line): two walks of the view's tables at
	// most, one per table, and each link on its word.
	const TWO = [...LINES.slice(0, 7), "| Key | Value |", "| --- | --- |", "| one | zeta |", "", ...LINES.slice(7)];
	for (const kind of VIEWS) {
		it(`P13 two tables, ${kind}: a link in each of two tables: at most one walk per table over base's own, each on its word`, async () => {
			const path = `table-ro-p13-two-${kind}.md`, s = await readScene(path, "live", TWO);
			expect(textOf(s.t, s.r), "premise: the first link is on beta").toBe("beta");
			const b0 = s.t.wordAt(1, 1, "beta");
			s.t.setMode("source");
			const n = 10, x0 = TWO[n - 1]!.indexOf("zeta") * CW, y0 = s.t.topOf(n);
			const z0 = { left: x0, top: y0 + (LH - FH) / 2 };
			inlineInk.record(path).strokes = [...inlineInk.strokes(path), loop("z", x0 - 4, x0 + 4 * CW + 4, y0 + 4, y0 + LH - 4)];
			s.t.selection.selectExactly(["z"]);
			expect(s.t.overlay.attachSelected(), "premise: Attach is offered for the second").toBe(true);
			await Promise.resolve();
			const list = inlineInk.attachments(path) as AttachmentRecord[], r2 = list.find((a) => a.strokeIds.includes("z")) ?? null;
			expect(textOf(s.t, r2), "premise: the second link is on zeta").toBe("zeta");
			const stored = storedOf(path);
			const v = viewOf(kind, s.t.text().split("\n"), { geom: "forced" });
			v.doc.reads.walk = 0;
			const placed = placedIn(v, path, SIG), walks = v.doc.reads.walk;
			const tds = Array.from((v.root as unknown as FEl).querySelectorAll("td") as unknown as ArrayLike<FEl>);
			const betaTd = tds.find((td) => cellWordAtOr(td, "beta")), zetaTd = tds.find((td) => cellWordAtOr(td, "zeta"));
			const nb = cellWordAt(betaTd!, "beta"), nz = cellWordAt(zetaTd!, "zeta");
			const offs = { c: lessMove(shownBy(placed, "c", stored.get("c")!), nb, b0), z: lessMove(shownBy(placed, "z", stored.get("z")!), nz, z0) };
			note(`TABLE-ATTACH read-only P13 two tables, ${kind}: walks ${walks} (base's own ${PIN.walks[kind]}), off ${JSON.stringify(offs)}`);
			expect(onIt(offs.c) && onIt(offs.z), `both on their words: ${JSON.stringify(offs)}`).toBe(true);
			expect(walks - PIN.walks[kind], "at most one walk per table, over base's own").toBeLessThanOrEqual(2);
		});
	}
});
/** Whether `word` is drawn in `cell`. */
const cellWordAtOr = (cell: FEl, word: string) => { try { cellWordAt(cell, word); return true; } catch { return false; } };

/*
 * P6 (plan addendum 1 and 2): Export to PDF through its own print path. The container is Obsidian's print container (a
 * markdown-preview-view with no sizer: the file-name title, then each block of the note in a div of its own, the theme's
 * 32 px padding each side), and the print runs as the app runs it: printVectorFor at the screen call (screen media: the
 * column width set, each block's top held), then at the print-media call (the paper measured, the zoom set, the ink placed
 * by the held tops and cut into one strip per block). Both placements and the fit run. The ink is read where the paper
 * shows it: the strip that holds the stroke, laid in its block; the word as the print lays it out. Both in the container's
 * layout px. Every client rect under the container is its layout box times the container's zoom (as the code reads them:
 * columnInset divides by it). Case c: no editor open, the records known (attachmentsFor set, lineSignatureFor null).
 */
const PR = { pad: 32, title: 54, paper: 1000, narrow: 520, breakBy: 24 };
type PrintOpts = { geom?: Geom; paper?: number; breakBy?: number; noLink?: boolean; firstTable?: boolean };
const camel = (p: string) => p.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
const firstM = (d: string) => {
	const m = /M (-?[\d.]+) (-?[\d.]+)/.exec(d);
	if (!m) throw new Error(`no M in ${d.slice(0, 40)}`);
	return { x: Number(m[1]), y: Number(m[2]) };
};
type Laid = { offsetTop: number; offsetLeft: number; offsetHeight: number };
const laid = (n: FEl) => n as unknown as Laid;

/** `el` with the members the print path writes through: style properties, attributes, children, classes, `:scope >` look-ups. */
function domOf(el: FEl): FEl {
	const style = el.style as Record<string, unknown>;
	Object.defineProperties(style, {
		removeProperty: { value: (p: string) => { delete style[camel(p)]; }, configurable: true },
		setProperty: { value: (p: string, v: string) => { style[camel(p)] = v; }, configurable: true },
		getPropertyValue: { value: (p: string) => String(style[camel(p)] ?? ""), configurable: true },
	});
	const names = () => el.className.split(/\s+/).filter(Boolean);
	Object.defineProperty(el, "classList", {
		get: () => ({
			contains: (c: string) => names().includes(c),
			add: (c: string) => { if (!names().includes(c)) el.className = [...names(), c].join(" "); },
			remove: (c: string) => { el.className = names().filter((x) => x !== c).join(" "); },
		}),
		configurable: true,
	});
	const detach = (c: FNode) => {
		const p = c.parentNode;
		if (p) { const i = p.childNodes.indexOf(c); if (i >= 0) p.childNodes.splice(i, 1); }
		c.parentNode = null;
	};
	Object.assign(el, {
		setAttribute: (k: string, v: string) => { if (k === "class") el.className = v; else el.attrs[k] = v; },
		removeAttribute: (k: string) => { delete el.attrs[k]; },
		setCssStyles: (s: Record<string, string>) => Object.assign(style, s),
		appendChild: (c: FEl) => { detach(c); c.parentNode = el; el.childNodes.push(c); return c; },
		removeChild: (c: FEl) => { detach(c); return c; },
		remove: () => detach(el),
		querySelector: (sel: string) => {
			const m = /^:scope > ([a-z0-9]*)((?:\.[\w-]+)*)$/i.exec(sel);
			if (!m) return FEl.prototype.querySelector.call(el, sel);
			const cls = m[2]!.split(".").filter(Boolean);
			return el.children.find((c) => (!m[1] || c.tagName === m[1].toUpperCase()) && cls.every((x) => c.className.split(/\s+/).includes(x))) ?? null;
		},
	});
	return el;
}

/**
 * The print container of a note whose text is `lines`, its blocks the print view's (`viewOf`, geometry `geom`), at a
 * paper `paper` px wide. `breakBy`: the table runs past a page's foot with beta's row first on the next page: in the
 * print layout every row from beta's on, and each block after the table, lies that many px lower, and the table's block
 * is that much taller (the screen layout has no page). `noLink`: the records with every target a paragraph (no table link).
 */
function printOf(lines: readonly string[], o: PrintOpts = {}) {
	const v = viewOf("print", lines, { geom: o.geom, firstTable: o.firstTable }), doc = v.doc, fromLp = v.offFromLp(), wordLp = v.word(1, 1, "beta");
	// The view's cells, found once before the counts start: `cellOf` names the cell that draws a word.
	const tds = (v.root as unknown as FEl).querySelectorAll("td"), cellOf = (w: string) => tds.find((td) => cellWordAtOr(td, w))!;
	const beta = cellOf("beta");
	const tableAt = v.blocks.findIndex((b) => b.contains(beta)), tops = v.held!.tops.slice(), heights = v.blocks.map((b) => laid(b).offsetHeight);
	const paper = o.paper ?? PR.paper, G = o.breakBy ?? 0, state = { print: false, flat: false };
	const root = domOf(new FEl("div", "markdown-preview-view markdown-rendered", doc)), title = domOf(new FEl("h1", "", doc));
	const styleOf = (e: FEl) => e.style as Record<string, unknown>;
	const width = () => Number.parseFloat(String(styleOf(root).width ?? "")) || paper;
	const zoomNow = () => (state.flat ? 1 : Number.parseFloat(String(styleOf(root).zoom ?? "")) || 1);
	title.rect = { left: PR.pad, top: 0, right: PR.pad + 600, bottom: PR.title, width: 600, height: PR.title, x: PR.pad, y: 0 };
	root.append(title, ...v.blocks);
	for (const b of v.blocks) { domOf(b); shiftBy(b, PR.pad, PR.title); }
	// The page break: beta's row and every row after it, and each later block, lower in the print layout.
	const dyOf = new Map<FNode, number>(), growOf = new Map<FNode, number>();
	if (G) {
		const trs = v.blocks[tableAt]!.querySelectorAll("tr"), from = trs.indexOf(beta.parentNode as FEl);
		if (from < 1) throw new Error("premise: beta's row is a body row");
		for (const tr of trs.slice(from)) dyOf.set(tr, G);
		v.blocks.forEach((b, i) => { if (i > tableAt) dyOf.set(b, G); });
		growOf.set(v.blocks[tableAt]!, G);
	}
	const lay = (b: Box, dy: number, grow: number): Box => {
		const z = zoomNow(), y = state.print ? dy : 0, g = state.print ? grow : 0;
		return { left: b.left * z, right: b.right * z, x: b.x * z, width: b.width * z, top: (b.top + y) * z, y: (b.y + y) * z, bottom: (b.bottom + y + g) * z, height: (b.height + g) * z };
	};
	const install = (n: FNode, above: number) => {
		const dy = above + (dyOf.get(n) ?? 0);
		if (n instanceof FEl) { let base = n.rect; Object.defineProperty(n, "rect", { get: () => lay(base, dy, growOf.get(n) ?? 0), set: (b: Box) => { base = b; }, configurable: true }); }
		if (n instanceof FText) { const base = n.chars; Object.defineProperty(n, "chars", { get: () => base.map((c) => lay(c, dy, 0)), set: () => {}, configurable: true }); }
		n.childNodes.forEach((c) => install(c, dy));
	};
	root.childNodes.forEach((c) => install(c, 0));
	const H = PR.title + Math.max(...tops.map((t, i) => t + heights[i]!)) + G;
	Object.defineProperties(root, {
		rect: { get: () => { const z = zoomNow(), w = width() * z, h = H * z; return { left: 0, top: 0, right: w, bottom: h, width: w, height: h, x: 0, y: 0 }; }, configurable: true },
		offsetParent: { get: () => ({}), configurable: true },
		offsetWidth: { get: width, configurable: true },
		clientWidth: { get: width, configurable: true },
		offsetHeight: { value: H, configurable: true },
		clientTop: { value: 0, configurable: true },
		clientLeft: { value: 0, configurable: true },
		scrollLeft: { value: 0, configurable: true, writable: true },
		scrollTop: { value: 0, configurable: true, writable: true },
	});
	Object.defineProperties(title, { offsetParent: { value: root }, offsetTop: { value: 0 }, offsetLeft: { value: PR.pad }, offsetHeight: { value: PR.title } });
	v.blocks.forEach((b, i) => Object.defineProperties(b, {
		offsetParent: { get: () => root, configurable: true },
		offsetTop: { get: () => PR.title + tops[i]! + (state.print && i > tableAt ? G : 0), configurable: true },
		offsetLeft: { value: PR.pad, configurable: true },
		offsetHeight: { get: () => heights[i]! + (state.print && i === tableAt ? G : 0), configurable: true },
	}));
	const sections = sectionsOf(lines).map((s) => ({ type: s.type, lineStart: s.lineStart, lineEnd: s.lineEnd })), text = lines.join("\n");
	recordLines(root as unknown as HTMLElement, root as unknown as HTMLElement, { section: () => null, cached: () => ({ sections, text }) });
	const view = doc.defaultView as unknown as Record<string, unknown>, computed = doc.defaultView.getComputedStyle;
	Object.assign(view, {
		getComputedStyle: (e: FEl) => (e === root ? { display: "block", position: "relative", paddingLeft: `${PR.pad}px`, paddingRight: `${PR.pad}px`, paddingTop: "0px", boxSizing: "border-box", getPropertyValue: () => "" } : computed(e)),
		matchMedia: () => ({ matches: state.print, addEventListener: () => {}, removeEventListener: () => {} }),
	});
	let ranges = 0;
	const make = doc.createRange.bind(doc);
	Object.assign(doc, { createElementNS: (_ns: string, tag: string) => domOf(new FEl(tag, "", doc)), createRange: () => { ranges++; return make(); } });
	doc.reads.walk = 0;
	doc.reads.rect = 0;
	/**
	 * P13 (the print counted per build): the reads at the start of each placement build, and one more at the run's end. A
	 * build is marked where placeStrokes asks for the records (once a build, before anything else it reads; EmbedInk.ts),
	 * the only place the print path asks for them.
	 */
	const snap = () => ({ walks: doc.reads.walk, rects: doc.reads.rect, ranges }), marks: ReturnType<typeof snap>[] = [];
	/** The print as the app runs it: the screen call, then the print-media call. */
	const run = (path: string) => {
		initEmbedInkAttachments((p) => { marks.push(snap()); return o.noLink ? notInTable(p) : inlineInk.attachments(p); });
		initEmbedInkLineSignature(() => null);
		initEmbedInkRefresh((p) => inlineInk.strokes(p));
		initEmbedInkColumnWidth(() => SIG.width);
		try {
			state.print = false;
			printVectorFor(root as unknown as HTMLElement, path, true);
			state.print = true;
			printVectorFor(root as unknown as HTMLElement, path, true);
		} finally {
			marks.push(snap());
			initEmbedInkAttachments(null);
			initEmbedInkLineSignature(null);
			initEmbedInkRefresh(() => []);
			initEmbedInkColumnWidth(() => null);
		}
	};
	/** `w`'s box (beta's by default) as the print (or the screen) lays it out, layout px in the container's frame. */
	const wordAt = (print: boolean, w = "beta") => {
		const was = { ...state };
		Object.assign(state, { print, flat: true });
		try { return cellWordAt(cellOf(w), w); } finally { Object.assign(state, was); }
	};
	const px = (e: FEl, k: "left" | "top") => Number.parseFloat(String(styleOf(e)[k] ?? "")) || 0;
	const vb = (e: FEl) => e.getAttribute("viewBox")!.split(" ").map(Number) as [number, number, number, number];
	/**
	 * Stroke `c0.id` on the paper, less its word `w` (beta by default) on the paper, less the same at Attach (`c0` the
	 * stroke and `was` the word then): 0, 0 on its word. A stroke's place is its outline's first point, which moves with
	 * the stroke whole.
	 */
	const read = (path: string, c0: InkStroke, was: Pick<Box, "left" | "top">, w = "beta") => {
		const svg = root.children.find((c) => c.tagName === "SVG" && c.classList.contains("handwriting-embed-ink"));
		if (!svg) throw new Error("no print layer");
		const pens = inlineInk.strokes(path).filter((s) => s.tool !== "highlighter"), paths = svg.children.filter((c) => c.tagName === "PATH");
		const m = firstM(paths[pens.findIndex((s) => s.id === c0.id)]!.getAttribute("d")!), ref = firstM(inkSvgLayers([c0], "#ffffff", { penPerStroke: true }).pen[0]!.d);
		const strips = v.blocks.flatMap((b) => b.children.filter((c) => c.classList.contains("handwriting-embed-ink-strip")));
		const hold = strips.find((s) => { const [, y, , h] = vb(s); return m.y >= y && m.y < y + h; });
		let at: { x: number; y: number };
		if (hold) { const b = laid(hold.parentNode as FEl), [x, y] = vb(hold); at = { x: b.offsetLeft + px(hold, "left") + m.x - x, y: b.offsetTop + px(hold, "top") + m.y - y }; }
		else { const [x, y] = vb(svg); at = { x: px(svg, "left") + m.x - x, y: px(svg, "top") + m.y - y }; }
		const word = wordAt(true, w);
		const off = { dx: +(at.x - word.left - (ref.x - was.left)).toFixed(2), dy: +(at.y - word.top - (ref.y - was.top)).toFixed(2) };
		return { off, strips: strips.length, held: !!hold, stripped: svg.classList.contains("is-stripped"), zoom: zoomNow(), paths: paths.length, pens: pens.length };
	};
	/** Each build's reads, from its mark to the next (the last build's to the run's end). */
	const perBuild = () => marks.slice(1).map((m, i) => ({ walks: m.walks - marks[i]!.walks, rects: m.rects - marks[i]!.rects, ranges: m.ranges - marks[i]!.ranges }));
	return { fromLp, wordLp, run, read, wordAt, perBuild, counts: () => ({ walks: doc.reads.walk, ranges }) };
}

describe("Export to PDF through its own print path: the screen call, then the print-media call (printVectorFor)", () => {
	const C3 = READ_CASES.find((c) => c.id === "c-3")!, CB = READ_CASES.find((c) => c.id === "c-b")!;
	/** Attach on beta in Live Preview: the scene, beta and the stroke as they were at Attach. */
	const scene = async (path: string, lines: readonly string[] = LINES) => {
		const s = await readScene(path, "live", lines);
		expect(textOf(s.t, s.r), "premise: the link is on beta").toBe("beta");
		const was = s.t.wordAt(1, 1, "beta"), c0 = JSON.parse(JSON.stringify(inlineInk.strokes(path).find((x) => x.id === "c")!)) as InkStroke;
		return { s, was, c0 };
	};
	const said = (name: string, x: ReturnType<ReturnType<typeof printOf>["read"]>) =>
		note(`TABLE-ATTACH print path ${name}: off its word on the paper ${JSON.stringify(x.off)}, strips ${x.strips} (the stroke in one: ${x.held}), zoom ${+x.zoom.toFixed(4)}, paths ${x.paths} of ${x.pens} pen strokes`);
	const premises = (x: ReturnType<ReturnType<typeof printOf>["read"]>) => {
		expect(x.stripped && x.strips > 0 && x.held, "premise: the print-media call cut the layer into strips by the held tops, one holding the stroke").toBe(true);
		expect(x.paths, "premise: one path per pen stroke").toBe(x.pens);
	};

	for (const geom of GEOMS) {
		for (const c of [C3, CB]) {
			it(`P6 case ${c.id}, print path, ${geom} block, the paper wider than the column (no zoom): ${c.name}: on its word`, async () => {
				const path = `table-print-${c.id}-${geom}.md`, { s, was, c0 } = await scene(path);
				for (const st of c.steps) s.run(st);
				const p = printOf(s.t.text().split("\n"), { geom });
				p.run(path);
				const x = p.read(path, c0, was);
				said(`case ${c.id} (${geom})`, x);
				geomTook(p, "print", geom);
				if (c.moves) expect(p.wordLp.left - was.left, "premise: beta moved right").toBeGreaterThan(20);
				premises(x);
				expect(x.zoom, "premise: no zoom").toBe(1);
				expect(onIt(x.off), `off its word by ${JSON.stringify(x.off)}`).toBe(true);
			});
		}
	}

	// G2-8 (plan addendum 1): the paper narrower than the column (the container zoomed to it), and a table taller than a page
	// with beta's row past the break.
	it(`P6 G2-8 narrow paper, case c-3, print path, forced block: the paper ${PR.narrow} px, the container zoomed to it: on its word`, async () => {
		const path = "table-print-narrow.md", { s, was, c0 } = await scene(path);
		for (const st of C3.steps) s.run(st);
		const p = printOf(s.t.text().split("\n"), { geom: "forced", paper: PR.narrow });
		p.run(path);
		const x = p.read(path, c0, was);
		said("G2-8 narrow paper", x);
		geomTook(p, "print", "forced");
		premises(x);
		expect(x.zoom, "premise: the container is zoomed below 0.9").toBeLessThan(0.9);
		expect(onIt(x.off), `off its word by ${JSON.stringify(x.off)}`).toBe(true);
	});

	const TALL = [...LINES.slice(0, 6), ...Array.from({ length: 24 }, (_, i) => `| r${i + 1} | w${i + 1} |`), ...LINES.slice(6)];
	it(`P6 G2-8 page break, case c-3, print path, forced block: a ${TALL.length - 4}-line table, beta's row first past a page's foot (${PR.breakBy} px lower in print): on its word`, async () => {
		const path = "table-print-break.md", { s, was, c0 } = await scene(path, TALL);
		for (const st of C3.steps) s.run(st);
		const p = printOf(s.t.text().split("\n"), { geom: "forced", breakBy: PR.breakBy });
		p.run(path);
		const x = p.read(path, c0, was), shift = +(p.wordAt(true).top - p.wordAt(false).top).toFixed(2);
		said(`G2-8 page break (beta ${shift} px lower in print)`, x);
		geomTook(p, "print", "forced");
		premises(x);
		expect(shift, "premise: beta lies lower in the print layout by the break").toBe(PR.breakBy);
		expect(onIt(x.off), `off its word by ${JSON.stringify(x.off)}`).toBe(true);
	});

	// G2-8 and P13 (the print counted per build): the screen call and the print-media call each build the placement twice
	// (EmbedInkPrint.ts, the sideways read before the fit and the placement by the held tops): at most one table walk and one
	// character box per build over the same note with no table link.
	it("P6 count, case c-3, print path, forced block, narrow paper: at most one table walk and one character box per placement build, four builds", async () => {
		const path = "table-print-count.md", { s } = await scene(path);
		for (const st of C3.steps) s.run(st);
		const lines = s.t.text().split("\n"), p = printOf(lines, { geom: "forced", paper: PR.narrow }), q = printOf(lines, { geom: "forced", paper: PR.narrow, noLink: true });
		p.run(path);
		q.run(path);
		const one = p.counts(), none = q.counts();
		note(`TABLE-ATTACH print path count: one table link ${JSON.stringify(one)}, no table link ${JSON.stringify(none)}`);
		expect(one.walks - none.walks, "at most one table walk per build").toBeLessThanOrEqual(4);
		expect(one.ranges - none.ranges, "at most one character box per build").toBeLessThanOrEqual(4);
	});

	// P13 (plan addendum 1 :70, addendum 2 :18): the print counted per build, not over its four. A build's reads run from
	// its mark (printOf, where placeStrokes asks for the records) to the next mark or the run's end, less the same build's
	// over the same note with no table link. Per character box the table reads three rects (EmbedInkMeasure.ts tableOf
	// charAt: the character's, the block's frame, the root's edge), so N boxes are at most 3N rect reads.
	const builds = (p: ReturnType<typeof printOf>, q: ReturnType<typeof printOf>) => {
		const a = p.perBuild(), b = q.perBuild();
		expect([a.length, b.length], "premise: four placement builds, each side (two a call)").toEqual([4, 4]);
		return a.map((x, i) => ({ walks: x.walks - b[i]!.walks, rects: x.rects - b[i]!.rects, ranges: x.ranges - b[i]!.ranges }));
	};
	const bound = (got: { walks: number; rects: number; ranges: number }[], walks: number, n: number) =>
		got.every((g) => g.walks <= walks && g.ranges <= n && g.rects <= 3 * n);
	/** The scene with a second link, on epsilon (beta's row's own table, row 2) or zeta (a second table, Source mode). */
	const TWO_T = [...LINES.slice(0, 7), "| Key | Value |", "| --- | --- |", "| one | zeta |", "", ...LINES.slice(7)];
	const second = async (path: string, where: "epsilon" | "zeta") => {
		const { s, was, c0 } = await scene(path, where === "zeta" ? TWO_T : LINES);
		let w0: Pick<Box, "left" | "top">, id: string;
		if (where === "epsilon") {
			const e = s.t.wordAt(2, 1, "epsilon");
			w0 = e; id = "e";
			inlineInk.record(path).strokes = [...inlineInk.strokes(path), loop("e", e.left - 4, e.right + 4, e.top - 4, e.bottom + 4)];
		} else {
			s.t.setMode("source");
			const n = 10, x0 = TWO_T[n - 1]!.indexOf("zeta") * CW, y0 = s.t.topOf(n);
			w0 = { left: x0, top: y0 + (LH - FH) / 2 }; id = "z";
			inlineInk.record(path).strokes = [...inlineInk.strokes(path), loop("z", x0 - 4, x0 + 4 * CW + 4, y0 + 4, y0 + LH - 4)];
		}
		s.t.selection.selectExactly([id]);
		expect(s.t.overlay.attachSelected(), "premise: Attach is offered for the second").toBe(true);
		await Promise.resolve();
		const list = inlineInk.attachments(path) as AttachmentRecord[];
		expect(list, "premise: two records").toHaveLength(2);
		expect(textOf(s.t, list.find((a) => a.strokeIds.includes(id)) ?? null), `premise: the second link is on ${where}`).toBe(where);
		expect(inlineInk.strokes(path).filter((x) => x.lineAnchor).map((x) => x.id).sort(), "premise: both links carry an anchor").toEqual(["c", id].sort());
		const w1 = JSON.parse(JSON.stringify(inlineInk.strokes(path).find((x) => x.id === id)!)) as InkStroke;
		return { s, was, c0, w0, w1, id };
	};

	it("P13 print per build, case c-3, forced block, narrow paper: one link: each of the four builds at most one table walk, one character box, three rect reads", async () => {
		const path = "table-print-p13-build.md", { s } = await scene(path);
		for (const st of C3.steps) s.run(st);
		const lines = s.t.text().split("\n"), p = printOf(lines, { geom: "forced", paper: PR.narrow }), q = printOf(lines, { geom: "forced", paper: PR.narrow, noLink: true });
		p.run(path);
		q.run(path);
		const got = builds(p, q);
		note(`TABLE-ATTACH print path P13 per build, one link: ${JSON.stringify(got)}; no table link ${JSON.stringify(q.perBuild())}`);
		expect(bound(got, 1, 1), `per build over no table link: ${JSON.stringify(got)}`).toBe(true);
	});

	for (const where of ["epsilon", "zeta"] as const) {
		const what = where === "epsilon" ? "two links in one table" : "a link in each of two tables";
		it(`P13 print per build, ${what}, forced block, narrow paper: each build at most ${where === "epsilon" ? "one table walk" : "one walk per table"}, one character box per link, each on its word`, async () => {
			const path = `table-print-p13-${where}.md`, { s, was, c0, w0, w1, id } = await second(path, where);
			const lines = s.t.text().split("\n"), firstTable = where === "zeta";
			const p = printOf(lines, { geom: "forced", paper: PR.narrow, firstTable }), q = printOf(lines, { geom: "forced", paper: PR.narrow, noLink: true, firstTable });
			p.run(path);
			const x = p.read(path, c0, was), y = p.read(path, w1, w0, where);
			q.run(path);
			const got = builds(p, q);
			note(`TABLE-ATTACH print path P13 per build, ${what}: ${JSON.stringify(got)}; beta off ${JSON.stringify(x.off)}, ${where} off ${JSON.stringify(y.off)}`);
			premises(x);
			expect(onIt(x.off) && onIt(y.off), `both on their words: beta ${JSON.stringify(x.off)}, ${where} ${JSON.stringify(y.off)}`).toBe(true);
			expect(bound(got, where === "epsilon" ? 1 : 2, 2), `per build over no table link: ${JSON.stringify(got)}`).toBe(true);
		});
	}

	// The two export roads (RegisterExportCommands.ts exportedStrokes): an editor showing the note (its overlay's
	// exportStrokes) and none (keptShownStrokes, each group at its record's kept correction). Neither reads a view's table:
	// pins at base, after case 3 and after case b (measured at base 60dcf1e8 src, run cells-p6-08fef94d-20261117T1459Z
	// lines-fixout.txt; the fix side read the same).
	const ROADS: Record<string, { pane: PinD; none: PinD }> = { "c-3": { pane: pd(110.38, 25.39), none: pd(110.38, 25.39) }, "c-b": { pane: pd(54.38, 25.39), none: pd(54.38, 25.39) } };
	for (const c of [C3, CB]) {
		it(`P6 pin, the export roads after case ${c.id}: the editor's (exportStrokes) and no pane's (keptShownStrokes), as base`, async () => {
			const path = `table-print-roads-${c.id}.md`, { s, c0 } = await scene(path);
			for (const st of c.steps) s.run(st);
			const got = { pane: shownBy(s.t.overlay.exportStrokes(path), "c", c0.bbox), none: shownBy(keptShownStrokes(inlineInk.strokes(path), inlineInk.attachments(path)), "c", c0.bbox) };
			note(`TABLE-ATTACH print path pin roads, case ${c.id}: drawn from stored at Attach ${JSON.stringify(got)}`);
			expect([nearBy(got.pane, ROADS[c.id]!.pane), nearBy(got.none, ROADS[c.id]!.none)], `drawn ${JSON.stringify(got)}, base ${JSON.stringify(ROADS[c.id])}`).toEqual([true, true]);
		});
	}
});

/**
 * P7 (plan addendum 1 :56, addendum 2 :14; rule 7: none per scroll frame, none in an editor update): the view's own paint
 * (EmbedInk.ts paint, through attachEmbedInk and embedInkChanged) on a root that holds what paint writes through. `v`'s
 * root gains: the `:scope >` look-ups, attributes and styles (domOf), createEl and createDiv, a canvas with no 2d
 * context (the cost is the layout read, not the drawing), scroll and client size, and its own scroll listeners; its
 * window gains a frame queue (flush runs it), the display's ratio, matchMedia and listeners. `sizer`: a note's own Reading
 * view (markdown-preview-view with an empty `:scope > .markdown-preview-sizer` at 0, 0, so the layer's top-left is the
 * root's as before) at a display ratio of 2 in an 800 x 600 client: an ink box past 2 M px is drawn as a tile and scrolls
 * through the listener (EmbedInk.ts paint, tiled). Reads are counted on the view's document: walks, rects and ranges.
 */
function paintable(v: View, o: { sizer?: boolean } = {}) {
	const root = domOf(v.root as unknown as FEl), doc = v.doc, win = doc.defaultView as unknown as Record<string, unknown>;
	type On = Map<string, Set<() => void>>;
	const listen = (m: On) => ({
		addEventListener: (k: string, f: () => void) => { if (!m.has(k)) m.set(k, new Set()); m.get(k)!.add(f); },
		removeEventListener: (k: string, f: () => void) => { m.get(k)?.delete(f); },
	});
	const mine: On = new Map(), frames = new Map<number, () => void>();
	let ids = 0, asked = 0, ran = 0, ranges = 0;
	Object.assign(win, {
		devicePixelRatio: o.sizer ? 2 : 1,
		requestAnimationFrame: (f: () => void) => { asked++; frames.set(++ids, f); return ids; },
		cancelAnimationFrame: (id: number) => { frames.delete(id); },
		matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
		...listen(new Map()),
	});
	const make = doc.createRange.bind(doc);
	doc.createRange = () => { ranges++; return make(); };
	const createEl = (tag: string, a: { cls?: string } = {}) => {
		const el = domOf(new FEl(tag, a.cls ?? "", doc));
		if (tag === "canvas") Object.assign(el, { width: 0, height: 0, getContext: () => null });
		(root as unknown as { appendChild(c: FEl): FEl }).appendChild(el);
		return el;
	};
	Object.assign(root, listen(mine), { createEl, createDiv: (a: { cls?: string } = {}) => createEl("div", a) });
	Object.defineProperties(root, {
		scrollTop: { value: 0, writable: true, configurable: true },
		scrollLeft: { value: 0, writable: true, configurable: true },
		clientWidth: { value: 800, configurable: true },
		clientHeight: { value: 600, configurable: true },
	});
	if (o.sizer) {
		root.className = `${root.className} markdown-preview-view`;
		const sizer = domOf(new FEl("div", "markdown-preview-sizer", doc));
		Object.defineProperties(sizer, { offsetParent: { value: root }, offsetLeft: { value: 0 }, offsetTop: { value: 0 }, offsetHeight: { value: 0 } });
		(root as unknown as { appendChild(c: FEl): FEl }).appendChild(sizer);
	}
	return {
		root: root as unknown as HTMLElement,
		/** The root's own listeners for `type`, as the browser calls them on a scroll. */
		fire: (type: string) => { for (const f of [...(mine.get(type) ?? [])]) f(); },
		/** Every frame asked, in order, until none is left (a frame that asks another runs it too). */
		flush: () => {
			for (let n = 0; frames.size > 0 && n < 20; n++) {
				const [id, f] = [...frames][0]!;
				frames.delete(id);
				ran++;
				f();
			}
		},
		counts: () => ({ walks: doc.reads.walk, rects: doc.reads.rect, ranges, frames: { asked, ran } }),
		zero: () => { doc.reads.walk = 0; doc.reads.rect = 0; ranges = 0; asked = 0; ran = 0; },
		marker: () => root.getAttribute(MARKER_ATTR),
	};
}

/**
 * The task's queued work run out, so a placement deferred past the flush is still counted: the src defers a view's placement to a microtask (EmbedInk.ts queueReplace),
 * so a count taken before these run cannot see it. A cell drains after each flush and before withViewInk lets go.
 */
const drain = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

/**
 * `f` with the note's ink, records and an editor's signature wired as the plugin wires them for its views; the task's
 * queued work drained, then every view let go.
 */
async function withViewInk(f: () => void | Promise<void>): Promise<void> {
	initEmbedInkAttachments((p) => inlineInk.attachments(p));
	initEmbedInkLineSignature(() => SIG);
	initEmbedInkRefresh((p) => inlineInk.strokes(p));
	try {
		await f();
		await drain();
	} finally {
		teardownEmbedInk();
		initEmbedInkAttachments(null);
		initEmbedInkLineSignature(null);
		initEmbedInkRefresh(() => []);
		initEmbedInkColumnWidth(() => null);
	}
}

describe("P7: the cost on a scroll and in an editor update, through the view's own paint (rule 7)", () => {
	it("a Reading view drawn as a tile: each scroll that redraws the tile reads no table (0 walks, 0 rects, 0 character boxes), its queued work run", async () => {
		const path = "table-p7-scroll.md", s = await readScene(path);
		s.run("source");
		s.run("type");
		// Free ink taller than the view: the view's tile cannot hold it, so a scroll past the tile redraws it.
		inlineInk.record(path).strokes = [...inlineInk.strokes(path), loop("tall", 20, 700, 10, 3000)];
		const L = paintable(viewOf("reading", s.t.text().split("\n")), { sizer: true });
		await withViewInk(async () => {
			attachEmbedInk(L.root, path, inlineInk.strokes(path));
			await drain();
			const built = L.counts(), tiles = [embedInkTileOf(L.root)];
			expect(tiles[0], "premise: the view draws a tile").not.toBeNull();
			expect(built.ranges, "premise: the paint read the word's character box (the table link went through its table)").toBeGreaterThanOrEqual(1);
			L.zero();
			// Each scroll's frame, then the task's queued work (a frame that asks for the placement again defers it, so the count waits for it).
			for (const y of [1500, 2400, 700]) {
				(L.root as unknown as { scrollTop: number }).scrollTop = y;
				L.fire("scroll");
				L.flush();
				await drain();
				tiles.push(embedInkTileOf(L.root));
			}
			const got = L.counts(), ys = tiles.map((x) => x?.y ?? null);
			note(`TABLE-ATTACH P7 scroll: paint ${JSON.stringify(built)}; three scrolls ${JSON.stringify(got)}; tile tops ${JSON.stringify(ys)}`);
			expect(got.frames.ran, "premise: each scroll asked a frame and it ran").toBeGreaterThanOrEqual(3);
			expect(new Set(ys).size, `premise: each scroll redrew the tile: ${JSON.stringify(ys)}`).toBe(4);
			// Rects too: a frame that reads the character boxes the build kept makes no range, only rect reads.
			expect({ walks: got.walks, rects: got.rects, ranges: got.ranges }, "no table read per scroll frame").toEqual({ walks: 0, rects: 0, ranges: 0 });
		});
	});

	it("an editor update with the note's views registered: no view builds or reads its table, and the editor reads as with no view open", async () => {
		const path = "table-p7-update.md", s = await readScene(path), bare = await readScene("table-p7-update-bare.md");
		s.run("source");
		bare.run("source");
		const ranges = (t: Rig) => { let n = 0; const make = t.fdoc.createRange.bind(t.fdoc); t.fdoc.createRange = () => { n++; return make(); }; return () => n; };
		const edR = ranges(s.t), bareR = ranges(bare.t);
		const kinds = VIEWS, views = kinds.map((kind) => paintable(viewOf(kind, s.t.text().split("\n")), { sizer: kind === "reading" }));
		const members = new Set((inlineInk.attachments(path) as AttachmentRecord[]).flatMap((r) => r.strokeIds));
		const anchorsOf = () => inlineInk.strokes(path).filter((x) => members.has(x.id)).map((x) => JSON.stringify(x.lineAnchor ?? null));
		await withViewInk(async () => {
			for (const L of views) attachEmbedInk(L.root, path, inlineInk.strokes(path));
			await drain();
			expect(views.map((L) => L.counts().ranges >= 1), "premise: each view's first paint read the word's character box").toEqual(kinds.map(() => true));
			// Two updates: typing in front of beta (the step the count cells run), then a letter typed at the end of the line above the table.
			const updates: [string, (t: Rig) => void][] = [
				["type in front of beta", (t) => { const at = t.posOf(5, "beta"); t.edit(at, at, "big "); }],
				["type above the table", (t) => { const end = t.view.state.doc.line(1).to; t.edit(end, end, "s"); }],
			];
			for (const [name, edit] of updates) {
				for (const L of views) L.zero();
				s.t.fdoc.reads.walk = 0;
				s.t.fdoc.reads.rect = 0;
				bare.t.fdoc.reads.walk = 0;
				bare.t.fdoc.reads.rect = 0;
				const r0 = [edR(), bareR()], a0 = anchorsOf(), m0 = views.map((L) => L.marker());
				for (const [t, p] of [[s.t, path], [bare.t, "table-p7-update-bare.md"]] as const) {
					const paint = painterOf(t, p), before = t.anchors.follow.snapshot();
					edit(t);
					paint(before);
				}
				await drain();
				const took = anchorsOf().filter((x, i) => x !== a0[i]).length, builds = views.map((L, i) => (L.marker() !== m0[i] ? 1 : 0));
				const per = views.map((L) => L.counts());
				const ed = { walks: s.t.fdoc.reads.walk, rects: s.t.fdoc.reads.rect, ranges: edR() - r0[0]! };
				const none = { walks: bare.t.fdoc.reads.walk, rects: bare.t.fdoc.reads.rect, ranges: bareR() - r0[1]! };
				note(`TABLE-ATTACH P7 editor update (${name}): members' anchors changed ${took}; builds ${JSON.stringify(builds)}; views ${JSON.stringify(Object.fromEntries(kinds.map((k, i) => [k, per[i]])))}; editor ${JSON.stringify(ed)}, with no view ${JSON.stringify(none)}`);
				// Typing moves the member's anchor in the editor's own change (measured 15:22Z: anchor changed 1, builds 0), so it
				// is an update a view could hear.
				if (name === "type in front of beta") expect(took, "premise: the edit moved the member's anchor").toBeGreaterThanOrEqual(1);
				expect(builds, `${name}: no view builds its placement in the editor update`).toEqual(kinds.map(() => 0));
				expect(per.map((c) => [c.walks, c.rects, c.ranges]), `${name}: no view reads its table in the editor update`).toEqual(kinds.map(() => [0, 0, 0]));
				expect(ed, `${name}: the editor reads as it does with no view open`).toEqual(none);
			}
			// The views above were drawn before the edits (as an open Reading view is until the save renders it again), and both
			// edits move the link's target in the editor's text, which the stale view's text does not hold there: tableMoves
			// skips the link before any walk (EmbedInkLines.ts, the moved-target road), so a zero there proves nothing. So those views cannot read
			// in the updates above, and the update below is the one that can. Control: views drawn from the edited text,
			// registered, then the note's repaint (embedInkChanged, as a save or a member's anchor taken in the pass gives it)
			// builds each once and reads its table at most once.
			const fresh = kinds.map((kind) => paintable(viewOf(kind, s.t.text().split("\n")), { sizer: kind === "reading" }));
			for (const L of fresh) attachEmbedInk(L.root, path, inlineInk.strokes(path));
			await drain();
			for (const L of fresh) L.zero();
			const m1 = fresh.map((L) => L.marker());
			embedInkChanged(path);
			await drain();
			const after = fresh.map((L) => L.counts());
			note(`TABLE-ATTACH P7 control, the note's repaint on views of the edited text: ${JSON.stringify(Object.fromEntries(kinds.map((k, i) => [k, after[i]])))}`);
			expect(fresh.map((L, i) => L.marker() !== m1[i]), "premise: the repaint built each view").toEqual(kinds.map(() => true));
			kinds.forEach((k, i) => {
				expect(after[i]!.ranges, `premise, ${k}: the build read the word's character box`).toBe(1);
				expect(after[i]!.walks - PIN.walks[k], `${k}: one table walk a build, over base's own`).toBeLessThanOrEqual(1);
			});
			// An update the views can read in, so a read there would show. The fresh views hold the current text; a letter typed at the note's end
			// (below the table) leaves the link's target where it is. No view builds or reads its table in that update, its queued
			// work run; premise after: the note's repaint of the same views reads the word's character box (they could read).
			for (const L of fresh) L.zero();
			const m2 = fresh.map((L) => L.marker());
			{
				const paint = painterOf(s.t, path), before = s.t.anchors.follow.snapshot();
				const end = s.t.view.state.doc.line(s.t.view.state.doc.lines).to;
				s.t.edit(end, end, " s");
				paint(before);
			}
			await drain();
			const below = fresh.map((L, i) => (L.marker() !== m2[i] ? 1 : 0)), perBelow = fresh.map((L) => L.counts());
			for (const L of fresh) L.zero();
			const m3 = fresh.map((L) => L.marker());
			embedInkChanged(path);
			await drain();
			const ctl = fresh.map((L) => L.counts());
			note(`TABLE-ATTACH P7 editor update (type below the table, views of the current text): builds ${JSON.stringify(below)}; views ${JSON.stringify(Object.fromEntries(kinds.map((k, i) => [k, perBelow[i]])))}; control repaint built ${JSON.stringify(fresh.map((L, i) => L.marker() !== m3[i]))}, ${JSON.stringify(Object.fromEntries(kinds.map((k, i) => [k, ctl[i]])))}`);
			expect(ctl.map((c) => c.ranges), "premise: these views read their table when built after the edit").toEqual(kinds.map(() => 1));
			expect(below, "type below the table: no view builds its placement in the editor update").toEqual(kinds.map(() => 0));
			expect(perBelow.map((c) => [c.walks, c.rects, c.ranges]), "type below the table: no view reads its table in the editor update").toEqual(kinds.map(() => [0, 0, 0]));
		});
	});
});

/**
 * G2-13 (READ-g354-2-fbf1405b.md G2-13; plan P14-REST item 4): an image in a table row above the word loads after the
 * view placed the ink. The view's own paint (attachEmbedInk on a paintable root: a Reading view with its sizer, an embed
 * whose root is its `.markdown-embed-content`), then the load as modelled here, not recorded: the image's row grows
 * LOAD_H px; every row below it, every block below the table and every character box in them sits that much lower; the
 * boxes holding the row grow by it (the image, its row's cells, the row, the table's body, the table, its block, and the
 * box that holds the blocks: a Reading view's sizer, which holds the sections in the app, or an embed's root, which
 * sizes to its content). The renderer renders no section again for a load. Then what the browser gives code on a load:
 * the image's own "load" listeners and the capture listeners on the root (a load does not bubble), then each
 * ResizeObserver watching a box that grew, called once (the window's stand-in; its MutationObserver stand-in never
 * fires, as a load adds no child). Read: where the paint drew the stroke, the layer's right and bottom edge (its canvas's
 * left + width, top + height; the layer starts at the note's origin, EmbedInk.ts embedInkBounds, so with the one stroke
 * past it the edge is the stroke's): its move by the load less beta's move in the view, and the edge less where the view
 * places the stroke when read again, each within 1 px. Re-placements: the character-box reads (createRange)
 * after the load, one per placement that reads beta. Not covered: Export to PDF (its print path places from the tops it
 * holds at print time) and a font that loads late (every row moves; the same observers).
 */
const LOAD_H = 80;
const G213_LINES = [...LINES.slice(0, 4), "| ![[p.png]] | pic |", ...LINES.slice(4)];

/** The window's ResizeObserver and MutationObserver stand-ins; `resized(boxes)` calls each RO watching one of `boxes` once and says how many it called. */
function observersOn(win: Record<string, unknown>) {
	type W = { f: (entries: { target: unknown }[], o: unknown) => void; on: Set<unknown> };
	const all = new Set<W>();
	class RO {
		readonly w: W;
		constructor(f: W["f"]) { this.w = { f, on: new Set() }; all.add(this.w); }
		observe(el: unknown) { this.w.on.add(el); }
		unobserve(el: unknown) { this.w.on.delete(el); }
		disconnect() { this.w.on.clear(); }
	}
	class MO { observe() {} disconnect() {} takeRecords() { return []; } }
	Object.assign(win, { ResizeObserver: RO, MutationObserver: MO });
	return {
		watching: (el: unknown) => [...all].some((w) => w.on.has(el)),
		resized: (boxes: readonly unknown[]) => {
			let called = 0;
			for (const w of [...all]) {
				const hit = boxes.filter((b) => w.on.has(b));
				if (hit.length) { called++; w.f(hit.map((target) => ({ target })), null); }
			}
			return called;
		},
	};
}
const grownBy = (e: FEl, h: number) => { e.rect = { ...e.rect, bottom: e.rect.bottom + h, height: e.rect.height + h }; };

type G213Hear = { f: (e: unknown) => void; capture: boolean };
type G213Opts = { free?: boolean; images?: number };

/**
 * One G2-13 scene, its view not painted yet: the note with its link on beta (and, `free`, two strokes on no word: one
 * beside the text above the table, one in alpha's cell on beta's row, below the image), its view, `images` images in
 * the image row's first cell with no size until each loads, the load as modelled (see above), and the reads. An embed's
 * canvas gets a context whose clearRect counts the paints, and its strokes come through `drawnBy` as the paint hands
 * them to the renderer: `drawnAt(id)` is where the last paint drew a stroke, in the root's px.
 */
async function g213Setup(kind: "reading" | "embed", path: string, o: G213Opts = {}) {
	const { t, r } = await attachedOn(path, "beta", 2, 1, G213_LINES);
	expect(r ? t.text().slice(r.target.from, r.target.to) : null, "premise: the link is on beta").toBe("beta");
	if (o.free) {
		inlineInk.record(path).strokes = [...inlineInk.strokes(path), loop("fa", t.tableRight() + 40, t.tableRight() + 100, 6, 34), loop("fb", t.colLeft(0) + 4, t.colLeft(1) - 30, t.rowTop(2) + 6, t.rowTop(3) - 6)];
	}
	const was = t.wordAt(2, 1, "beta"), b0 = { ...inlineInk.strokes(path).find((x) => x.id === "c")!.bbox };
	const v = viewOf(kind, t.text().split("\n"), { geom: "forced", shown: (l) => l.replace("![[p.png]]", "") });
	const L = paintable(v, { sizer: kind === "reading" }), root = L.root as unknown as FEl;
	if (kind === "embed") root.className = `${root.className} markdown-embed-content`;
	const obs = observersOn(v.doc.defaultView as unknown as Record<string, unknown>);
	// The images, no size until they load; each one's own load listeners, and the root's with their phase.
	type Opt = boolean | { capture?: boolean } | undefined;
	const onRoot: G213Hear[] = [];
	const hearOn = (list: G213Hear[], rest?: { add: (k: string, f: () => void) => void; remove: (k: string, f: () => void) => void }) => ({
		addEventListener: (k: string, f: (e: unknown) => void, o2?: Opt) => {
			if (k === "load" || k === "error") list.push({ f, capture: o2 === true || (typeof o2 === "object" && o2.capture === true) });
			else rest?.add(k, f as () => void);
		},
		removeEventListener: (k: string, f: (e: unknown) => void) => {
			if (k !== "load" && k !== "error") return rest?.remove(k, f as () => void);
			const i = list.findIndex((x) => x.f === f);
			if (i >= 0) list.splice(i, 1);
		},
	});
	const was0 = root as unknown as { addEventListener: (k: string, f: () => void) => void; removeEventListener: (k: string, f: () => void) => void };
	Object.assign(root, hearOn(onRoot, { add: was0.addEventListener, remove: was0.removeEventListener }));
	const block = v.blocks.find((b) => b.children[0]?.tagName === "TABLE")!, table = block.children[0]!;
	const trs = table.children.flatMap((s) => s.children), row = trs[1]!, wrap = row.children[0]!.children[0]!;
	const { left: il, top: it0 } = wrap.rect;
	const imgs = Array.from({ length: o.images ?? 1 }, () => {
		const on: G213Hear[] = [], img = Object.assign(new FEl("img", "", v.doc), hearOn(on)), span = new FEl("span", "internal-embed image-embed", v.doc).append(img);
		span.rect = img.rect = { left: il, top: it0, right: il, bottom: it0, width: 0, height: 0, x: il, y: it0 };
		wrap.append(span);
		return { img, span, on };
	});
	// An embed's paints, counted, and the strokes each one drew.
	let paints = 0;
	const last: { id: string; box: { x: number; y: number }; zoom: number }[] = [];
	if (kind === "embed") {
		const ctx = { globalAlpha: 1, setTransform() {}, clearRect() { paints++; last.length = 0; } };
		const mk = (root as unknown as { createEl: (tag: string, a?: { cls?: string }) => FEl }).createEl;
		Object.assign(root, { createEl: (tag: string, a?: { cls?: string }) => { const el = mk(tag, a); if (tag === "canvas") Object.assign(el, { getContext: () => ctx }); return el; } });
		drawnBy.on = (c, cam, s) => { if (c === ctx) last.push({ id: s.id, box: { x: s.bbox.x, y: s.bbox.y }, zoom: cam.zoom ?? 1 }); };
	}
	const canvas = () => root.children.find((e) => e.tagName === "CANVAS");
	const sizer = root.children.find((e) => e.classList.contains("markdown-preview-sizer")) ?? null;
	const holder = kind === "reading" ? sizer! : root;
	const watches0 = embedInkAnchorWatchCount();
	let grew: unknown[] = [];
	const s = {
		t, path, was, b0, v, L, root, obs, block, row, holder, imgs, onRoot, watches0,
		paints: () => paints,
		zero: () => { L.zero(); paints = 0; },
		canvas,
		paint: async () => {
			attachEmbedInk(L.root, path, inlineInk.strokes(path));
			await drain();
			expect(canvas(), "premise: the view drew a layer").toBeDefined();
		},
		word: () => v.word(2, 1, "beta"),
		/** Where the last paint drew stroke `id`, the root's px: the layer's place now, its origin, the stroke's box. */
		drawnAt: (id: string) => {
			const st = canvas()!.style as Record<string, string>, e = last.find((d) => d.id === id);
			if (!e) return null;
			const x = Math.floor(Math.min(0, ...last.map((d) => d.box.x * d.zoom))), y = Math.floor(Math.min(0, ...last.map((d) => d.box.y * d.zoom)));
			return { left: +(parseFloat(st.left ?? "") - x + e.box.x * e.zoom).toFixed(2), top: +(parseFloat(st.top ?? "") - y + e.box.y * e.zoom).toFixed(2) };
		},
		/** Image `k`'s box as it loads: its row grows `h` px, every row and block below moves that much lower, the boxes holding the row grow (the root too unless `fixed`). No event, no read. */
		grow: (h: number, o2: { k?: number; fixed?: boolean } = {}) => {
			const im = imgs[o2.k ?? 0]!, cells = row.children, inCells = cells.flatMap((c) => c.children);
			for (const e of [row, ...cells, ...inCells, table.children[1]!, table, block]) grownBy(e, h);
			im.span.rect = im.img.rect = { ...im.img.rect, right: il + 100, bottom: im.img.rect.bottom + h, width: 100, height: im.img.rect.height + h };
			for (const tr of trs.slice(2)) shiftBy(tr, 0, h);
			const hb = block as unknown as { offsetHeight: number };
			Object.defineProperty(block, "offsetHeight", { value: hb.offsetHeight + h, configurable: true });
			for (const b of v.blocks.slice(v.blocks.indexOf(block) + 1)) {
				shiftBy(b, 0, h);
				(b as unknown as { offsetTop: number }).offsetTop += h;
			}
			if (kind === "embed" && !o2.fixed) grownBy(root, h);
			grew = [...new Set([...grew, im.img, im.span, row, ...cells, ...inCells, table.children[1]!, table, block, ...(kind === "embed" && o2.fixed ? [] : [holder])])];
		},
		/** The box, then its event (`type`) as the browser gives it. Says how many listeners heard it. */
		load: async (h: number, o2: { k?: number; fixed?: boolean; type?: "load" | "error" } = {}) => {
			s.grow(h, o2);
			return s.fire(o2.k ?? 0, o2.type ?? "load");
		},
		/** The event alone, for image `k`: the root's capture listeners, then the image's own (it does not bubble). Says how many heard it. */
		fire: async (k: number, type: "load" | "error" = "load") => {
			const im = imgs[k]!, ev = { type, target: im.img, bubbles: false }, heard = onRoot.filter((x) => x.capture).length + im.on.length;
			for (const x of onRoot.filter((y) => y.capture)) x.f({ ...ev, currentTarget: root, eventPhase: 1 });
			for (const x of [...im.on]) x.f({ ...ev, currentTarget: im.img, eventPhase: 2 });
			await drain();
			return heard;
		},
		/** The frame: each ResizeObserver watching a box that grew since the last frame, called once. Says how many it called. */
		frame: async () => {
			const told = obs.resized(grew);
			grew = [];
			await drain();
			return told;
		},
		/** Any of our observers on the root or a box in it; load listeners left on the root or an image. */
		watched: () => obs.watching(root) || root.children.some((e) => obs.watching(e)) || obs.watching(sizer),
		listeners: () => onRoot.length + imgs.reduce((n, im) => n + im.on.length, 0),
	};
	return s;
}

async function g213Run(kind: "reading" | "embed", path: string, o: G213Opts, body: (s: Awaited<ReturnType<typeof g213Setup>>) => Promise<void>) {
	try {
		const s = await g213Setup(kind, path, o);
		await withViewInk(async () => {
			await s.paint();
			await body(s);
		});
	} finally {
		drawnBy.on = null;
	}
}

describe("P14 G2-13: an image in a table row above the word loads after the view placed the ink", () => {
	for (const kind of ["reading", "embed"] as const) {
		it(`P14 G2-13, ${kind}, forced block: the image's row grows ${LOAD_H} px after the paint: the drawn ink moves with beta, within 1 px, the re-placements counted`, async () => {
			await g213Run(kind, `table-ro-p14-g213-${kind}.md`, {}, async (s) => {
				const { v, L, root, obs, holder, path, b0, was } = s, canvas = s.canvas()!;
				// Where the paint drew the stroke: the layer's box starts at the note's origin (EmbedInk.ts embedInkBounds) and
				// ends at the ink's right and bottom, so with one stroke past the origin its right and bottom edge are the stroke's.
				expect(inlineInk.strokes(path).length, "premise: the note holds the one stroke").toBe(1);
				expect(b0.x > 0 && b0.y > 0, "premise: the stroke is past the note's origin").toBe(true);
				const at = () => { const st = canvas.style as Record<string, string>, n = (k: string) => parseFloat(st[k] ?? ""); return { left: n("left") + n("width"), top: n("top") + n("height") }; };
				expect(L.counts().ranges, "premise: the paint read beta's character box (the link went through its table)").toBeGreaterThanOrEqual(1);
				const placed = () => placeStrokes(L.root, inlineInk.strokes(path), v.held, v.zoom, path).strokes.find((x) => x.id === "c")!;
				const offOf = (st: InkStroke, now: Box) => ({ dx: +(st.bbox.x - b0.x - (now.left - was.left)).toFixed(2), dy: +(st.bbox.y - b0.y - (now.top - was.top)).toFixed(2) });
				/** The drawn edge less where the view places the stroke's right and bottom now (px, the layer's origin the root's). */
				const drawnLess = (st: InkStroke) => { const e = at(), o = canvas.style as Record<string, string>; return { dx: +(e.left - parseFloat(o.left ?? "") - (st.bbox.x + st.bbox.width)).toFixed(2), dy: +(e.top - parseFloat(o.top ?? "") - (st.bbox.y + st.bbox.height)).toFixed(2) }; };
				const w0 = s.word(), p0 = placed(), before = offOf(p0, w0), a0 = at(), painted = drawnLess(p0);
				expect(onIt(before), `premise: before the load the view places it on beta (off ${JSON.stringify(before)})`).toBe(true);
				expect(Math.max(Math.abs(painted.dx), Math.abs(painted.dy)), `premise: the paint drew it where the view places it (the edge less the stroke's, ${JSON.stringify(painted)})`).toBeLessThanOrEqual(1);
				const H = LOAD_H;
				s.grow(H);
				const w1 = s.word(), moved = { dx: +(w1.left - w0.left).toFixed(2), dy: +(w1.top - w0.top).toFixed(2) };
				expect(moved, `premise: the load moved beta ${H} px down in the view`).toEqual({ dx: 0, dy: H });
				L.zero();
				const heard = await s.fire(0);
				const told = await s.frame();
				const cost = L.counts(), a1 = at();
				const drawn = { dx: +(a1.left - a0.left).toFixed(2), dy: +(a1.top - a0.top).toFixed(2) };
				const off = { dx: +(drawn.dx - moved.dx).toFixed(2), dy: +(drawn.dy - moved.dy).toFixed(2) };
				const p1 = placed(), after = offOf(p1, w1), still = drawnLess(p1);
				note(`TABLE-ATTACH read-only P14 G2-13, ${kind}: beta moved ${JSON.stringify(moved)}, the drawn stroke's edge moved ${JSON.stringify(drawn)}, off ${JSON.stringify(off)}; re-placements ${cost.ranges} (reads after the load ${JSON.stringify(cost)}); load listeners ${heard}, resize observers called ${told}, the holder watched ${obs.watching(holder)}; read again now ${JSON.stringify(after)}, drawn less that ${JSON.stringify(still)}; painted at the paint ${JSON.stringify(painted)}; root ${root.className}`);
				expect(onIt(after), `premise: read again after the load, the view places it on beta (off ${JSON.stringify(after)})`).toBe(true);
				expect(Math.max(Math.abs(off.dx), Math.abs(off.dy), Math.abs(still.dx), Math.abs(still.dy)), `the drawn ink within 1 px of beta after the load (off ${JSON.stringify(off)}, drawn less the view's place ${JSON.stringify(still)}, re-placements ${cost.ranges})`).toBeLessThanOrEqual(1);
			});
		});
	}
});

/**
 * G2-13 break roads (BREAK-READ-g213-embed-watch-900d7194.md), the embed only: the Reading view path is
 * the one above and is not changed. Each stroke is read where the paint drew it (`drawnAt`: the strokes the paint
 * handed the renderer, at the layer's place now), not by the layer's edge. B1: strokes on no word stay where they were
 * (ink never follows text; attached ink follows its word, Alan 11-08). B2, B7: the root keeps its size (a max-height
 * with its content scrolling inside, or the min-height the ink gave it), and the row grows on a load or on a broken
 * image's error. B3: the watch and the paint settle. B4: five loads before one frame, and a load that changes no box.
 * B5: nothing runs after teardown, after the last stroke is erased, or once the root left the DOM. Not covered: print
 * and Export to PDF (B6), an embed inside a Reading view and a section the renderer detaches and puts back (B4 c, B5 c),
 * a pop-out window closed with its roots (B5 b), a video's metadata and a font that loads late (B7, the same boxes), a
 * collapsed embed that expands (B8).
 */
const g213Near = (a: { dx: number; dy: number }, b: { dx: number; dy: number }) => Math.max(Math.abs(a.dx - b.dx), Math.abs(a.dy - b.dy));
const g213Moved = (a: { left: number; top: number } | null, b: { left: number; top: number } | null) => (a && b ? { dx: +(b.left - a.left).toFixed(2), dy: +(b.top - a.top).toFixed(2) } : { dx: NaN, dy: NaN });

describe("P14 G2-13 break roads: the embed's watch moves the ink on the word and nothing else, settles, and lets go", () => {
	it("P14 G2-13 B1, embed: two strokes on no word, one above the image and one below it in the table: the load moves the stroke on beta with beta and leaves the other two where they were, each as the paint drew it, within 1 px", async () => {
		await g213Run("embed", "table-ro-p14-g213-b1.md", { free: true }, async (s) => {
			expect(inlineInk.strokes(s.path).filter((x) => !x.lineAnchor).map((x) => x.id).sort(), "premise: fa and fb carry no line anchor; c, the linked one, does").toEqual(["fa", "fb"]);
			const ids = ["c", "fa", "fb"] as const, before = ids.map((id) => s.drawnAt(id));
			expect(before.map((b) => b !== null), "premise: the paint drew all three").toEqual([true, true, true]);
			const w0 = s.word();
			s.grow(LOAD_H);
			const w1 = s.word(), beta = { dx: +(w1.left - w0.left).toFixed(2), dy: +(w1.top - w0.top).toFixed(2) };
			s.zero();
			await s.fire(0);
			const told = await s.frame(), cost = { paints: s.paints(), ranges: s.L.counts().ranges };
			const moved = ids.map((id, i) => g213Moved(before[i]!, s.drawnAt(id))), want = [beta, { dx: 0, dy: 0 }, { dx: 0, dy: 0 }];
			note(`TABLE-ATTACH read-only P14 G2-13 B1, embed: beta moved ${JSON.stringify(beta)}; drawn moved c ${JSON.stringify(moved[0])}, fa ${JSON.stringify(moved[1])}, fb ${JSON.stringify(moved[2])}; paints ${cost.paints}, re-placements ${cost.ranges}, resize observers called ${told}`);
			expect(beta, "premise: the load moved beta down").toEqual({ dx: 0, dy: LOAD_H });
			expect(moved.map((m, i) => g213Near(m, want[i]!) <= 1), `each stroke as drawn after the load: c with beta, fa and fb where they were (moved ${JSON.stringify(moved)})`).toEqual([true, true, true]);
		});
	});

	for (const type of ["load", "error"] as const) {
		it(`P14 G2-13 ${type === "load" ? "B2" : "B7"}, embed: the root keeps its size (its content scrolling inside it), the image's row grows ${LOAD_H} px on ${type === "load" ? "its load" : "a broken image's error"}: the drawn ink moves with beta, within 1 px`, async () => {
			await g213Run("embed", `table-ro-p14-g213-fixed-${type}.md`, {}, async (s) => {
				const w0 = s.word(), d0 = s.drawnAt("c"), r0 = { ...s.root.rect };
				s.grow(LOAD_H, { fixed: true });
				const w1 = s.word(), beta = { dx: +(w1.left - w0.left).toFixed(2), dy: +(w1.top - w0.top).toFixed(2) };
				s.zero();
				const heard = await s.fire(0, type);
				const told = await s.frame(), cost = { paints: s.paints(), ranges: s.L.counts().ranges }, drawn = g213Moved(d0, s.drawnAt("c"));
				note(`TABLE-ATTACH read-only P14 G2-13 ${type === "load" ? "B2" : "B7"}, embed, root fixed, ${type}: beta moved ${JSON.stringify(beta)}, drawn moved ${JSON.stringify(drawn)}; paints ${cost.paints}, re-placements ${cost.ranges}, listeners ${heard}, resize observers called ${told}`);
				expect(s.root.rect, "premise: the root's box did not change").toEqual(r0);
				expect(beta, "premise: the load moved beta down").toEqual({ dx: 0, dy: LOAD_H });
				expect(g213Near(drawn, beta), `the drawn ink with beta (drawn moved ${JSON.stringify(drawn)}, beta ${JSON.stringify(beta)})`).toBeLessThanOrEqual(1);
			});
		});
	}

	it("P14 G2-13 B3, embed: after the load the watch and the paint settle: each round calls the observers again for the root when the pass changed its min-height; quiet by round 3, at most 2 placements and 1 paint, the ink on beta", async () => {
		await g213Run("embed", "table-ro-p14-g213-b3.md", {}, async (s) => {
			const w0 = s.word(), d0 = s.drawnAt("c"), style = s.root.style as Record<string, string>;
			s.grow(LOAD_H);
			const w1 = s.word(), beta = { dx: +(w1.left - w0.left).toFixed(2), dy: +(w1.top - w0.top).toFixed(2) };
			s.zero();
			let min = style.minHeight ?? "";
			await s.fire(0);
			const rounds = [{ told: await s.frame(), ranges: s.L.counts().ranges, paints: s.paints(), min: style.minHeight ?? "" }];
			let quiet = 0;
			for (let k = 2; k <= 10 && !quiet; k++) {
				const now = style.minHeight ?? "";
				if (now === min) { quiet = k; break; }
				// The min-height the pass wrote resizes the root when it is taller than the root's box.
				const want = parseFloat(now) || 0;
				if (want > s.root.rect.height) grownBy(s.root, want - s.root.rect.height);
				min = now;
				const told = s.obs.resized([s.root]);
				await drain();
				rounds.push({ told, ranges: s.L.counts().ranges, paints: s.paints(), min: style.minHeight ?? "" });
			}
			const cost = { ranges: s.L.counts().ranges, paints: s.paints() }, drawn = g213Moved(d0, s.drawnAt("c"));
			note(`TABLE-ATTACH read-only P14 G2-13 B3, embed: rounds ${JSON.stringify(rounds)}, quiet at round ${quiet}; beta moved ${JSON.stringify(beta)}, drawn moved ${JSON.stringify(drawn)}`);
			expect({ quiet: quiet > 0 && quiet <= 3, placements: cost.ranges <= 2, paints: cost.paints <= 1 }, `settled (rounds ${JSON.stringify(rounds)}, quiet at ${quiet})`).toEqual({ quiet: true, placements: true, paints: true });
			expect(g213Near(drawn, beta), `the drawn ink with beta (drawn moved ${JSON.stringify(drawn)})`).toBeLessThanOrEqual(1);
		});
	});

	it("P14 G2-13 B4, embed: five images in the row load as five tasks before one frame: no placement until the frame, then one, the ink on beta; then a load that changes no box: no placement, no paint", async () => {
		await g213Run("embed", "table-ro-p14-g213-b4.md", { images: 5 }, async (s) => {
			const w0 = s.word(), d0 = s.drawnAt("c");
			s.zero();
			for (let k = 0; k < 5; k++) await s.load(LOAD_H / 5, { k });
			const atLoads = s.L.counts().ranges, told = await s.frame(), atFrame = s.L.counts().ranges, paints = s.paints();
			const w1 = s.word(), beta = { dx: +(w1.left - w0.left).toFixed(2), dy: +(w1.top - w0.top).toFixed(2) }, drawn = g213Moved(d0, s.drawnAt("c"));
			// The word read above is the cell's, not the view's: the counts restart after it.
			s.zero();
			const heard = await s.fire(0), still = await s.frame();
			const quiet = { ranges: s.L.counts().ranges, paints: s.paints() };
			note(`TABLE-ATTACH read-only P14 G2-13 B4, embed: 5 loads, placements at the loads ${atLoads}, after the frame ${atFrame} (observers called ${told}), paints ${paints}; beta moved ${JSON.stringify(beta)}, drawn moved ${JSON.stringify(drawn)}; a load that changes no box: listeners ${heard}, observers called ${still}, ${JSON.stringify(quiet)}`);
			expect(beta, "premise: the loads moved beta down").toEqual({ dx: 0, dy: LOAD_H });
			expect({ atLoads, atFrame, paints: paints <= 1 }, "one placement per frame, none per load").toEqual({ atLoads: 0, atFrame: 1, paints: true });
			expect(g213Near(drawn, beta), `the drawn ink with beta (drawn moved ${JSON.stringify(drawn)})`).toBeLessThanOrEqual(1);
			expect(quiet, "a load that changes no box").toEqual({ ranges: 0, paints: 0 });
		});
	});

	for (const how of ["teardown", "erase"] as const) {
		it(`P14 G2-13 B5, embed: after ${how === "teardown" ? "teardownEmbedInk" : "the last stroke is erased"}, a load runs nothing: no placement, no paint, no listener left, nothing watched`, async () => {
			await g213Run("embed", `table-ro-p14-g213-b5-${how}.md`, {}, async (s) => {
				expect({ watched: s.watched(), count: embedInkAnchorWatchCount() - s.watches0 }, "premise: the paint watches the embed").toEqual({ watched: true, count: 1 });
				if (how === "teardown") teardownEmbedInk();
				else {
					// The app's erase: the record loses its last stroke, then the note's repaint (a revision bump) paints it empty.
					inlineInk.record(s.path).strokes = [];
					embedInkChanged(s.path);
					await drain();
				}
				s.zero();
				await s.load(LOAD_H);
				const told = await s.frame();
				const after = { ranges: s.L.counts().ranges, paints: s.paints(), told, listeners: s.listeners(), watched: s.watched(), count: embedInkAnchorWatchCount() - s.watches0 };
				note(`TABLE-ATTACH read-only P14 G2-13 B5, embed, ${how}: after the load ${JSON.stringify(after)}`);
				expect(after).toEqual({ ranges: 0, paints: 0, told: 0, listeners: 0, watched: false, count: 0 });
			});
		});
	}

	it("P14 G2-13 B5, embed: a root the DOM let go of, no paint after: its own next tick stops its watch, the count back to where it was, no placement", async () => {
		await g213Run("embed", "table-ro-p14-g213-b5-detach.md", {}, async (s) => {
			expect(embedInkAnchorWatchCount() - s.watches0, "premise: the paint watches the embed").toBe(1);
			Object.defineProperty(s.root, "isConnected", { value: false, configurable: true });
			s.zero();
			await s.load(LOAD_H);
			const told = await s.frame();
			const after = { ranges: s.L.counts().ranges, paints: s.paints(), told, watched: s.watched(), count: embedInkAnchorWatchCount() - s.watches0 };
			note(`TABLE-ATTACH read-only P14 G2-13 B5, embed, detached: after the load ${JSON.stringify(after)}`);
			expect({ ...after, told: undefined }).toEqual({ ranges: 0, paints: 0, told: undefined, watched: false, count: 0 });
		});
	});
});

/**
 * P14 G2-16 (reviews/READ-g354-2-fbf1405b.md, G2-16): Insert Space above a table group, as the lift writes it (spaceUp).
 * The step makes spaceUp's store move (the strokes spaceStoreIds keeps), then the text change spaceTextChange gives at the
 * seam (the table's first line). The group follows its text, so it is left out of the store move and the text change is
 * the one move it gets; the line anchors hear it. Open: two lines. Close: the blank line
 * above the table taken back. Then the editor's export (exportStrokes) and each read-only view of the text now, with the
 * editor open and with none: the ink off beta within 1 px in each, the stored points where they were. Not covered here: a
 * group whose words need reattachment, which Insert Space moves in the store with its record's reference point and probe
 * (spaceHeldShift reads no table): InsertSpaceAttached.test.ts, the cells at :245 and :286.
 */
describe("P14 G2-16: Insert Space above a table group: the editor and each view draw the ink on its word", () => {
	const Z = { dx: 0, dy: 0 };
	for (const how of ["open", "close"] as const) {
		for (const kind of VIEWS) {
			it(`P14 G2-16, ${how}, ${kind}, forced block: Insert Space ${how === "open" ? "opens two lines" : "takes back the blank line"} above the table: the group is left to the text change; the editor's export and the view draw the ink on beta within 1 px`, async () => {
				const path = `table-ro-p14-g216-${how}-${kind}.md`, s = await readScene(path);
				expect(textOf(s.t, s.r), "premise: the link is on beta").toBe("beta");
				// The strokes the step's store move takes (spaceUp's list), read before it; checked last, so a wrong list shows
				// its double move in the checks above it.
				const storeIds = s.t.overlay.spaceStoreIds(["c"]);
				const n0 = s.t.view.state.doc.lines, was = s.t.wordAt(1, 1, "beta"), b0 = { ...inlineInk.strokes(path)[0]!.bbox };
				// The view's beta before, from its DOM alone (no placement read): a view need not draw blank lines as height.
				const v0 = viewOf(kind, s.t.text().split("\n"), { geom: "forced" }).word(1, 1, "beta");
				s.run(how === "open" ? "space-open" : "space-close");
				const lines = s.t.view.state.doc.lines - n0, now = s.t.wordAt(1, 1, "beta"), moved = { dx: +(now.left - was.left).toFixed(2), dy: +(now.top - was.top).toFixed(2) };
				const v1 = viewOf(kind, s.t.text().split("\n"), { geom: "forced" }).word(1, 1, "beta"), inView = { dx: +(v1.left - v0.left).toFixed(2), dy: +(v1.top - v0.top).toFixed(2) };
				const pane = lessMove(shownBy(s.t.overlay.exportStrokes(path), "c", b0), now, was), at = inlineInk.strokes(path)[0]!.bbox;
				const open = s.read(kind, "open", { geom: "forced" }), none = s.read(kind, "closed", { geom: "forced" });
				note(`TABLE-ATTACH read-only P14 G2-16, ${how}, ${kind}: lines ${lines}, beta moved in the editor ${JSON.stringify(moved)}, in the view ${JSON.stringify(inView)}; off beta: the editor's export ${JSON.stringify(pane)}, the view with the editor open ${JSON.stringify(open.off)}, with none ${JSON.stringify(none.off)}; anchor line ${open.line}; store move took ${JSON.stringify(storeIds)}; stored moved ${JSON.stringify({ dx: +(at.x - b0.x).toFixed(2), dy: +(at.y - b0.y).toFixed(2) })}`);
				const want = how === "open" ? 2 : -1;
				expect(lines, "premise: the text change opened or closed that many lines").toBe(want);
				expect(moved, "premise: beta moved by those lines in the editor").toEqual({ dx: 0, dy: want * LH });
				geomTook(open, kind, "forced");
				expect({ x: at.x, y: at.y }, "the stored points did not move: the text change carries the group").toEqual({ x: b0.x, y: b0.y });
				expect([nearBy(pane, Z, 1), nearBy(open.off, Z, 1), nearBy(none.off, Z, 1)], `off beta: the editor's export ${JSON.stringify(pane)}, the view with the editor open ${JSON.stringify(open.off)}, with none ${JSON.stringify(none.off)}`).toEqual([true, true, true]);
				expect(storeIds, "Insert Space leaves the group out of its store move (the text change moves it)").toEqual([]);
			});
		}
	}
});

/**
 * One list item as a read-only view draws it (`listView`): its text, its table (inside an embed, a callout or a quote),
 * a code block (`code`: its fence's text, the fence lines left out), its own list.
 */
type ListItem = { text?: string; table?: readonly string[]; wrap?: "embed" | "callout" | "quote"; code?: readonly string[]; kids?: readonly ListItem[] };
const rectOf = (l: number, t: number, r: number, b: number) => ({ left: l, top: t, right: r, bottom: b, width: r - l, height: b - t, x: l, y: t });
/**
 * The view `kind` of a note whose text is `lines`: one list block drawing `items` in order, each item its text, then its
 * table (inside an embed, a callout or a quote, as `wrap` says), then its own list, laid one under the other. An embed's
 * root sits in its span.internal-embed.markdown-embed, as the app draws one. `word(t, ...)` reads the t-th table drawn,
 * in document order.
 */
function listView(kind: ViewKind, lines: readonly string[], items: readonly ListItem[]) {
	const doc = new FDoc(), tables: ReturnType<typeof tableWidget>[] = [];
	let top = 0;
	const list = (its: readonly ListItem[], x: number): FEl => {
		const ul = new FEl("ul", "", doc), t0 = top;
		for (const it of its) {
			const li = new FEl("li", "", doc), l0 = top;
			if (it.text !== undefined) {
				li.append(paragraphEl(doc, it.text, x, top, LH, CW, FH));
				top += LH;
			}
			if (it.table) {
				const w = tableWidget(doc, it.table, WX + x, top);
				w.wrapper.childNodes.length = 0;
				w.table.parentNode = null;
				let host: FEl = li;
				if (it.wrap === "embed") {
					const content = new FEl("div", "markdown-embed-content", doc);
					li.append(new FEl("span", "internal-embed markdown-embed inline-embed", doc).append(content));
					host = content;
				} else if (it.wrap === "callout") {
					const content = new FEl("div", "callout-content", doc);
					li.append(new FEl("div", "callout", doc).append(content));
					host = content;
				} else if (it.wrap === "quote") {
					const q = new FEl("blockquote", "", doc);
					li.append(q);
					host = q;
				}
				host.append(w.table);
				tables.push(w);
				top += w.height;
			}
			if (it.code) {
				// A code block: its text in a pre (no table), as tall as its lines and its two fence lines.
				const pre = new FEl("pre", "", doc), h = LH * (it.code.length + 2);
				pre.append(doc.createTextNode(it.code.join("\n")));
				pre.rect = rectOf(x, top, 1400, top + h);
				li.append(pre);
				top += h;
			}
			if (it.kids) li.append(list(it.kids, x + 2 * CW));
			li.rect = rectOf(x, l0, 1400, top);
			ul.append(li);
		}
		ul.rect = rectOf(x, t0, 1400, top);
		return ul;
	};
	const ul = list(items, 0);
	const v = readOnlyView(doc, kind, lines, [{ lineStart: 0, lineEnd: lines.length - 1, type: "list", el: ul, top: 0, height: top }]);
	if (kind === "embed") new FEl("span", "internal-embed markdown-embed", doc).append(v.root as unknown as FEl);
	return { ...v, kind, zoom: 1, word: (t: number, row: number, col: number, wd: string) => cellWordAt(tables[t]!.cell(row, col)!, wd) };
}
/** A day table: its header, its separator, a Mon row. `dayUnder(pre)`: its lines as a list item holds them, `pre` before each. */
const DAY = ["| day | task |", "| --- | --- |", "| Mon | gym |"];
const dayUnder = (pre: string) => DAY.map((l) => pre + l);
/** A ring round Mon on `lines`'s line `n` (1-based) in the Source rig `t`, and Mon's place there. */
const monRing = (t: Rig, lines: readonly string[], id: string, n: number) => {
	const x0 = lines[n - 1]!.indexOf("Mon") * CW, y0 = t.topOf(n);
	return { stroke: loop(id, x0 - 4, x0 + 3 * CW + 4, y0 + 4, y0 + LH - 4), was: { left: x0, top: y0 + (LH - FH) / 2 } };
};
/** A group round Mon on `lines`'s line `n`, attached in Source mode: its record and Mon's place there. */
const monScene = async (path: string, lines: readonly string[], n: number) => {
	const t = rig(path, [], "source", lines), { stroke, was } = monRing(t, lines, "c", n);
	inlineInk.record(path).strokes = [stroke];
	const r = await t.attach(["c"]);
	expect([textOf(t, r), t.view.state.doc.lineAt(r.target.from).number], `premise: the link is on Mon, line ${n}`).toEqual(["Mon", n]);
	return { t, r, was };
};

/**
 * G2-19: one rendered block drawing more than one table, a list whose items hold tables (one list section, one UL). The
 * source's tables in the block's lines pair one to one, in order, with the tables the block draws for its own lines:
 * not an embed's (another note's text), a quote's or a callout's (the source reads no table in quoted lines). A group
 * is placed by the drawn table of its own index; a block whose two counts differ (a raw HTML table) is drawn as before
 * tables were read. Each group is attached in Source mode. Each cell prints where the group is drawn against its own
 * word, the other table's word and its stored place.
 */
describe("G2-19: tables in one rendered block: the read-only views draw each group on its own table's word", () => {
	/**
	 * Each case: the note's lines, the list's items as drawn, the line (1-based) of the group's Mon, and the drawn table
	 * the group's Mon is in (own) and the one ahead of it (other).
	 */
	const CASES: Record<string, { lines: readonly string[]; items: readonly ListItem[]; line: number; own: number; other: number }> = {
		// C1: two same-shape tables, one in each item.
		two: { lines: ["- one", ...dayUnder("  "), "- two", ...dayUnder("  ")], items: [{ text: "one", table: DAY }, { text: "two", table: DAY }], line: 8, own: 1, other: 0 },
		// C2: an embedded note's table of the same shape and text ahead: the source holds one table.
		embed: { lines: ["- ![[week 1]]", "- two", ...dayUnder("  ")], items: [{ table: DAY, wrap: "embed" }, { text: "two", table: DAY }], line: 5, own: 1, other: 0 },
		// C3: a callout's table ahead (quoted lines: the source reads no table there).
		callout: { lines: ["- > [!note] week 1", ...dayUnder("  > "), "- two", ...dayUnder("  ")], items: [{ table: DAY, wrap: "callout" }, { text: "two", table: DAY }], line: 8, own: 1, other: 0 },
		// C3, a plain quote's table ahead.
		quote: { lines: ["- quote", ...dayUnder("  > "), "- two", ...dayUnder("  ")], items: [{ text: "quote", table: DAY, wrap: "quote" }, { text: "two", table: DAY }], line: 8, own: 1, other: 0 },
		// C4: a table in an inner item, then one in an outer item.
		nested: { lines: ["- one", "  - inner", ...dayUnder("    "), "- two", ...dayUnder("  ")], items: [{ text: "one", kids: [{ text: "inner", table: DAY }] }, { text: "two", table: DAY }], line: 9, own: 1, other: 0 },
	};
	for (const [name, c] of Object.entries(CASES)) {
		for (const kind of VIEWS) {
			it(`G2-19 ${name}, ${kind}: a group on the second table's Mon is drawn on its own Mon, never on the first's`, async () => {
				const path = `table-ro-g219-${name}-${kind}.md`, { was } = await monScene(path, c.lines, c.line);
				const v = listView(kind, c.lines, c.items), own = v.word(c.own, 1, 0, "Mon"), first = v.word(c.other, 1, 0, "Mon");
				expect(Math.abs(own.top - first.top), "premise: the two tables' Mon over 5 px apart").toBeGreaterThan(5);
				expect(Math.abs(own.left - was.left) + Math.abs(own.top - was.top), "premise: the view draws Mon away from its Source place").toBeGreaterThan(5);
				const d = shownBy(placedIn(v as unknown as View, path, SIG), "c", storedOf(path).get("c")!);
				const offOwn = lessMove(d, own, was), offFirst = lessMove(d, first, was);
				note(`TABLE-ATTACH read-only G2-19 ${name}, ${kind}: drawn from stored ${JSON.stringify(d)}, off its own Mon ${JSON.stringify(offOwn)}, off the first table's Mon ${JSON.stringify(offFirst)}`);
				expect(onIt(offFirst), `drawn on the first table's Mon: ${JSON.stringify(offFirst)}`).toBe(false);
				expect(onIt(offOwn), `off its own Mon by ${JSON.stringify(offOwn)}`).toBe(true);
			});
		}
	}
	for (const kind of VIEWS) {
		it(`G2-19 ${kind}, rig check: a group on the first table's Mon is drawn on it`, async () => {
			const c = CASES.two!, path = `table-ro-g219-first-${kind}.md`, { was } = await monScene(path, c.lines, 4);
			const v = listView(kind, c.lines, c.items), own = v.word(0, 1, 0, "Mon");
			expect(Math.abs(own.left - was.left) + Math.abs(own.top - was.top), "premise: the view draws Mon away from its Source place").toBeGreaterThan(5);
			const d = shownBy(placedIn(v as unknown as View, path, SIG), "c", storedOf(path).get("c")!), off = lessMove(d, own, was);
			note(`TABLE-ATTACH read-only G2-19 first, ${kind}: drawn from stored ${JSON.stringify(d)}, off its Mon ${JSON.stringify(off)}`);
			expect(onIt(off), `off its word by ${JSON.stringify(off)}`).toBe(true);
		});
		// C5: both groups placed in one paint. A read kept by table shape only would hand table 1's read to the second.
		it(`G2-19 ${kind}, one group in each table, one paint: each is drawn on its own Mon`, async () => {
			const c = CASES.two!, path = `table-ro-g219-both-${kind}.md`, t = rig(path, [], "source", c.lines);
			const a = monRing(t, c.lines, "c", 4), b = monRing(t, c.lines, "e", 8);
			inlineInk.record(path).strokes = [a.stroke];
			const r1 = await t.attach(["c"]);
			inlineInk.record(path).strokes = [...inlineInk.strokes(path), b.stroke];
			t.selection.selectExactly(["e"]);
			expect(t.overlay.attachSelected(), "premise: Attach is offered for the second").toBe(true);
			await Promise.resolve();
			const list = inlineInk.attachments(path) as AttachmentRecord[], r2 = list.find((x) => x.strokeIds.includes("e")) ?? null;
			expect(list, "premise: two records").toHaveLength(2);
			expect([textOf(t, r1), textOf(t, r2), t.view.state.doc.lineAt(r2!.target.from).number], "premise: the links are on Mon, lines 4 and 8").toEqual(["Mon", "Mon", 8]);
			const v = listView(kind, c.lines, c.items), mon = [v.word(0, 1, 0, "Mon"), v.word(1, 1, 0, "Mon")], stored = storedOf(path);
			const placed = placedIn(v as unknown as View, path, SIG);
			const offs = { c: lessMove(shownBy(placed, "c", stored.get("c")!), mon[0]!, a.was), e: lessMove(shownBy(placed, "e", stored.get("e")!), mon[1]!, b.was) };
			note(`TABLE-ATTACH read-only G2-19 both, ${kind}: off their own Mon ${JSON.stringify(offs)}`);
			expect(onIt(offs.c) && onIt(offs.e), `each on its own Mon: ${JSON.stringify(offs)}`).toBe(true);
		});
		// C6: a raw HTML table ahead: the block draws two tables where the source reads one, so no index pairs them.
		it(`G2-19 ${kind}, a raw HTML table ahead in the list: the counts differ, so the group is drawn as before tables were read`, async () => {
			const lines = ["- <table><tr><th>day</th><th>task</th></tr><tr><td>Mon</td><td>gym</td></tr></table>", "- two", ...dayUnder("  ")];
			const path = `table-ro-g219-html-${kind}.md`, { was } = await monScene(path, lines, 5);
			const v = listView(kind, lines, [{ table: DAY }, { text: "two", table: DAY }]), own = v.word(1, 1, 0, "Mon"), html = v.word(0, 1, 0, "Mon");
			const moves = tableMoves(inlineInk.attachments(path), measureSpans(v.root, v.held), v.zoom, SIG);
			const d = shownBy(placedIn(v as unknown as View, path, SIG), "c", storedOf(path).get("c")!);
			note(`TABLE-ATTACH read-only G2-19 html, ${kind}: table move ${JSON.stringify(moves?.get("c") ?? null)}, drawn from stored ${JSON.stringify(d)}, off its own Mon ${JSON.stringify(lessMove(d, own, was))}, off the HTML table's Mon ${JSON.stringify(lessMove(d, html, was))}`);
			expect(moves?.get("c") ?? null, "no table move: the group is drawn as before tables were read").toBeNull();
			expect(onIt(lessMove(d, html, was)), "never on the HTML table's Mon").toBe(false);
		});
		// C7 control: one table in a list, nothing else: the table road is kept.
		it(`G2-19 ${kind}, control: one table in a list: the group is drawn on its Mon`, async () => {
			const lines = ["- one", ...dayUnder("  ")], path = `table-ro-g219-one-${kind}.md`, { was } = await monScene(path, lines, 4);
			const v = listView(kind, lines, [{ text: "one", table: DAY }]), own = v.word(0, 1, 0, "Mon");
			expect(Math.abs(own.left - was.left) + Math.abs(own.top - was.top), "premise: the view draws Mon away from its Source place").toBeGreaterThan(5);
			const d = shownBy(placedIn(v as unknown as View, path, SIG), "c", storedOf(path).get("c")!), off = lessMove(d, own, was);
			note(`TABLE-ATTACH read-only G2-19 one, ${kind}: drawn from stored ${JSON.stringify(d)}, off its Mon ${JSON.stringify(off)}`);
			expect(onIt(off), `off its word by ${JSON.stringify(off)}`).toBe(true);
		});
	}
});

/**
 * G2-20: a code fence inside a list item is indented past three spaces (a nested item) or opens on the item's marker
 * line ("- ```"). Its pipe lines are code, not a table, in the source read too: no table move, no cell target, and no
 * source table to pair with the view's. A fence at three spaces or less was read before; a real table after a closed
 * fence, and a line holding ``` past its start, keep the table.
 */
describe("P14 G2-20: a code fence in a list item: its pipe lines are code, not a table", () => {
	const CODE = ["| a | b |", "| --- | --- |", "| c | d |"];
	/** `pre` before each line of `lines`, then the text's offset of "c" on the code's last row. */
	const fenced = (pre: string, open: string, lines: readonly string[]) => {
		const text = [...lines, `${open}${"```"}`, ...CODE.map((l) => pre + l), `${pre}${"```"}`, "after"].join("\n");
		return { text, at: text.indexOf("| c | d |") + 2 };
	};
	it("G2-20 nested: a fence four spaces in, in an inner item: its pipe lines read as no table", () => {
		const { text, at } = fenced("    ", "    ", ["- one", "  - inner"]);
		expect(text.slice(at, at + 1), "premise: on c").toBe("c");
		const t = tableAround(text, at);
		note(`TABLE-ATTACH G2-20 nested fence: table ${JSON.stringify(t && { from: t.from, ncol: t.ncol, rows: t.rows.length })}`);
		expect(t, "a nested fence's text is code").toBeNull();
	});
	it("G2-20 marker: a fence opened on a list item's marker line: its pipe lines read as no table", () => {
		const { text, at } = fenced("  ", "- ", []);
		const t = tableAround(text, at);
		note(`TABLE-ATTACH G2-20 marker fence: table ${JSON.stringify(t && { from: t.from, ncol: t.ncol, rows: t.rows.length })}`);
		expect(t, "the item's fence text is code").toBeNull();
	});
	it("G2-20 control: a fence two spaces in, in an item: no table, as before", () => {
		const { text, at } = fenced("  ", "  ", ["- one"]);
		expect(tableAround(text, at), "read as code, as before").toBeNull();
	});
	it("G2-20 control: a real table after a closed nested fence is read", () => {
		const { text } = fenced("    ", "    ", ["- one", "  - inner"]);
		const full = `${text}\n- two\n${dayUnder("  ").join("\n")}`, at = full.lastIndexOf("Mon");
		const t = tableAround(full, at);
		expect(t && { ncol: t.ncol, rows: t.rows.length, from: t.from }, "the table after the fence").toEqual({ ncol: 2, rows: 2, from: full.lastIndexOf("  | day") });
	});
	it("G2-20 control: a line holding ``` past its start does not open a fence", () => {
		const full = ["see ``` here", "", ...DAY].join("\n"), at = full.lastIndexOf("Mon");
		const t = tableAround(full, at);
		expect(t && { ncol: t.ncol, rows: t.rows.length }, "the table").toEqual({ ncol: 2, rows: 2 });
	});
	it("G2-20 Source mode: a ring round --- on a nested fence's code line attaches to it, not refused as a table's separator", async () => {
		const lines = ["- one", "  - inner", "    ```", ...CODE.map((l) => "    " + l), "    ```"], n = 5, path = "table-g220-fence-attach.md";
		const t = rig(path, [], "source", lines), x0 = lines[n - 1]!.indexOf("---") * CW, y0 = t.topOf(n);
		inlineInk.record(path).strokes = [loop("c", x0 - 4, x0 + 3 * CW + 4, y0 + 4, y0 + LH - 4)];
		const r = await t.tryAttach(["c"]);
		note(`TABLE-ATTACH G2-20 Source attach on a nested fence's --- line: ${JSON.stringify(r && { text: textOf(t, r), kind: r.target.kind })}`);
		expect(r && textOf(t, r), "attached to the code's ---").toBe("---");
	});
	// With the fence missed, the block's source reads two tables (the code's and the real one) where the view draws one,
	// so the real table's group is drawn as before tables were read (G2-19's count check), off its word.
	for (const kind of VIEWS) {
		it(`G2-20 ${kind}: a list holding a nested fence's pipe lines, then a table: the group is drawn on its Mon`, async () => {
			const lines = ["- one", "  - inner", "    ```", ...CODE.map((l) => "    " + l), "    ```", "- two", ...dayUnder("  ")];
			const path = `table-ro-g220-${kind}.md`, { was } = await monScene(path, lines, 11);
			const v = listView(kind, lines, [{ text: "one", kids: [{ text: "inner", code: CODE }] }, { text: "two", table: DAY }]), own = v.word(0, 1, 0, "Mon");
			expect(Math.abs(own.left - was.left) + Math.abs(own.top - was.top), "premise: the view draws Mon away from its Source place").toBeGreaterThan(5);
			const d = shownBy(placedIn(v as unknown as View, path, SIG), "c", storedOf(path).get("c")!), off = lessMove(d, own, was);
			note(`TABLE-ATTACH read-only G2-20 fence, ${kind}: drawn from stored ${JSON.stringify(d)}, off its Mon ${JSON.stringify(off)}`);
			expect(onIt(off), `off its word by ${JSON.stringify(off)}`).toBe(true);
		});
	}
});
