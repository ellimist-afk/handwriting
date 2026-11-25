/**
 * A word in a table cell beside markup (a `<br>`, a link) whose letters the word also holds: the editor reads the word's
 * own drawn letters, for its place and for the circle that takes it.
 *
 * Alan, 2026-11-17: "need this as a bug fix: cant link drawings to text in a table." Product rule: attached ink follows
 * its word (Alan 11-08), the one exception to "ink never follows text", attached ink only.
 *
 * The same bare overlay over a fake Live Preview view as AttachTable.test.ts, trimmed to one resting zoom and Live
 * Preview: text lines CW world px a character, the table one block widget whose DOM is the recorded one
 * (tableWidgetDom.testutil.ts), reached by view.domAtPos, 16 px left of the text column.
 */
import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { BlockType } from "@codemirror/view";
import { InkOverlayPlugin } from "./InkOverlay";
import { inlineInk } from "./InkOverlayRegistry";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { emptyPage } from "../model/PageData";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { SelectionModel } from "../objects/SelectionModel";
import type { AttachmentRecord } from "./InkAttachments";
import { FDoc, FEl, FRange, FText, SEPARATOR_ROW, tableWidget, type Box } from "./tableWidgetDom.testutil";
import { appendFileSync } from "node:fs";

declare module "node:fs" { export function appendFileSync(path: string, data: string): void; }
declare const process: { env: Record<string, string | undefined> };
/** HW_TABLE_ATTACH_OUT=<path>: each cell's TABLE-ALIGN line is appended there too (passing cells' console is not kept). */
const OUT = process.env.HW_TABLE_ATTACH_OUT ?? "";
const note = (line: string) => {
	console.log(line);
	if (OUT) appendFileSync(OUT, line + "\n");
};

const CW = 14, LH = 40, FH = 26, COLS = 60, WX = -16;
const SIG = { width: COLS * CW, fontPx: 26, charWidth: CW };

function strokeOf(id: string, pts: [number, number][]): InkStroke {
	const points = pts.map(([x, y], i) => ({ x, y, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}
const loop = (id: string, x0: number, x1: number, y0: number, y1: number) =>
	strokeOf(id, [[x0, (y0 + y1) / 2], [(x0 + x1) / 2, y0], [x1, (y0 + y1) / 2], [(x0 + x1) / 2, y1], [x0 + 2, (y0 + y1) / 2]]);

/** A note whose table's second body cell in row 1 is `cell`. */
const linesWith = (cell: string) => [
	"Text above the table here",
	"",
	"| Name | Note |",
	"| --- | --- |",
	`| alpha | ${cell} |`,
	"| delta | epsilon |",
	"",
	"Text below the table here",
];

function rig(path: string, lines: readonly string[]) {
	const rec = inlineInk.record(path);
	rec.pageId = `page-${path}`;
	rec.basePage = { ...emptyPage(rec.pageId), attachments: [] };
	rec.attachments = undefined as unknown as typeof rec.attachments;
	rec.strokes = [];
	Object.defineProperty(inlineInk, "persist", { value: () => {}, configurable: true });
	const state = { doc: Text.of([...lines]) };
	const fdoc = new FDoc();
	let reading = false;
	fdoc.reading = () => reading;
	const table = () => {
		let a = 0;
		for (let n = 1; n <= state.doc.lines; n++) if (state.doc.line(n).text.includes("|")) { a = n; break; }
		let b = a;
		while (b + 1 <= state.doc.lines && state.doc.line(b + 1).text.includes("|")) b++;
		const shown: number[] = [];
		for (let n = a; n <= b; n++) if (n !== a + 1 || !SEPARATOR_ROW.test(state.doc.line(n).text)) shown.push(n);
		return { a, b, shown, from: state.doc.line(a).from, to: state.doc.line(b).to };
	};
	const inTable = (n: number) => { const t = table(); return n >= t.a && n <= t.b; };
	let built: ReturnType<typeof tableWidget> | null = null;
	const widget = () => {
		if (built) return built;
		const t = table(), src: string[] = [];
		for (let n = t.a; n <= t.b; n++) src.push(state.doc.line(n).text);
		built = tableWidget(fdoc, src, WX, (t.a - 1) * LH, { scale: 1 });
		return built;
	};
	const heightOf = (n: number) => { const t = table(); return n >= t.a && n <= t.b ? (n === t.a ? widget().height : 0) : LH; };
	const topOf = (n: number) => { let top = 0; for (let i = 1; i < n; i++) top += heightOf(i); return top; };
	const blockOf = (n: number) => {
		const t = table();
		if (n >= t.a && n <= t.b) {
			const top = topOf(t.a), h = widget().height;
			return { from: t.from, to: t.to, top, bottom: top + h, height: h, type: BlockType.WidgetRange };
		}
		const line = state.doc.line(n), top = topOf(n);
		return { from: line.from, to: line.to, top, bottom: top + LH, height: LH, type: BlockType.Text };
	};
	const blocks = () => {
		const out: ReturnType<typeof blockOf>[] = [];
		for (let n = 1; n <= state.doc.lines; n++) {
			const b = blockOf(n);
			if (!out.length || out[out.length - 1]!.from !== b.from) out.push(b);
		}
		return out;
	};
	const editorDom = new FEl("div", "cm-editor", fdoc), scroller = new FEl("div", "cm-scroller", fdoc), content = new FEl("div", "cm-content", fdoc);
	editorDom.append(scroller.append(content));
	const contentNow = () => {
		content.childNodes.length = 0;
		const t = table();
		for (let n = 1; n <= state.doc.lines; n++) {
			if (n === t.a) { const w = widget().el; w.parentNode = null; content.append(w); continue; }
			if (inTable(n)) continue;
			const line = new FEl("div", "cm-line", fdoc), top = topOf(n), ft = new FText(state.doc.line(n).text, fdoc);
			line.rect = { left: 0, top, right: COLS * CW, bottom: top + LH, width: COLS * CW, height: LH, x: 0, y: top };
			const ty = top + (LH - FH) / 2;
			ft.chars = [...ft.data].map((_, i) => ({ left: i * CW, right: (i + 1) * CW, top: ty, bottom: ty + FH, width: CW, height: FH, x: i * CW, y: ty }));
			content.append(line.append(ft));
		}
		return content;
	};
	const layout = (): LineLayout => ({
		lines: state.doc.lines, lineText: (n) => state.doc.line(n).text, lineTop: (n) => (inTable(n) ? topOf(table().a) : topOf(n)), pxPerWorld: 1,
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
			const line = c.childNodes.find((l) => l instanceof FEl && l.rect.top === topOf(n)) as FEl, ft = line.childNodes[0] as FText;
			return { node: ft, offset: pos - state.doc.line(n).from };
		},
		coordsAtPos: (pos: number) => {
			const t = table();
			if (pos >= t.from && pos <= t.to) {
				const w = widget(), top = topOf(t.a), x = pos === t.from ? WX : WX + w.width;
				return { left: x, right: x, top, bottom: top + w.height };
			}
			const line = state.doc.lineAt(pos), left = (pos - line.from) * CW, top = topOf(line.number) + (LH - FH) / 2;
			return { left, right: left, top, bottom: top + FH };
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
	/** Where the last `word` in the cell's shown text is drawn, world units (scale 1). */
	const wordAt = (row: number, col: number, word: string): Box => {
		const td = widget().cell(row, col)!, texts: FText[] = [];
		const walk = (n: FEl | FText) => { if (n instanceof FText) { if (!n.hidden()) texts.push(n); } else n.childNodes.forEach((c) => walk(c as FEl | FText)); };
		walk(td);
		const i = texts.map((x) => x.data).join("").lastIndexOf(word);
		if (i < 0) throw new Error(`no ${word} in row ${row} col ${col}`);
		let at = 0;
		for (const x of texts) {
			if (i < at + x.length) {
				const r = new FRange();
				r.setStart(x, i - at);
				r.setEnd(x, Math.min(x.length, i - at + word.length));
				return r.getClientRects()[0]!;
			}
			at += x.length;
		}
		throw new Error("unreachable");
	};
	const cellBox = (row: number, col: number): Box => widget().cell(row, col)!.rect;
	/** Attach on a circle around the last `word` drawn in row 1, column 1: its one record, or null. */
	const attachOn = async (word: string): Promise<AttachmentRecord | null> => {
		const b = wordAt(1, 1, word), td = cellBox(1, 1);
		inlineInk.record(path).strokes = [loop("c", b.left - 4, b.right + 4, Math.max(td.top + 6, b.top - 4), Math.min(td.bottom - 6, b.bottom + 4))];
		selection.selectExactly(["c"]);
		if (!overlay.attachSelected()) return null;
		await Promise.resolve();
		const list = inlineInk.attachments(path);
		return list.length === 1 ? (list[0] as AttachmentRecord) : null;
	};
	/** The document position of the last `word` on line `n`. */
	const posOf = (n: number, word: string) => state.doc.line(n).from + state.doc.line(n).text.lastIndexOf(word);
	const text = () => state.doc.toString();
	return { overlay, wordAt, attachOn, posOf, text };
}

const near = (a: number, b: number, tol = 0.5) => Math.abs(a - b) <= tol;

describe("a word in a cell beside markup that holds its letters: the editor reads the word's own drawn letters", () => {
	// The cell's source with the word in braces (the braces are not in the note).
	const CASES = [
		"beta<br>{bob}",
		"x<br>{rb}",
		'[a](u "t") {t}',
		"{bob}<br>x",
		"beta<br>{gamma}",
		// Between two <br>s that hold its letters.
		"a<br>{b}<br>c",
		"1<br>{r}<br>2",
		"x<br>{br}<br>y",
		"to oa<br>b<br>{rlu}",
	];
	for (const marked of CASES) {
		const at = marked.indexOf("{"), word = marked.slice(at + 1, marked.indexOf("}")), cell = marked.replace(/[{}]/g, "");
		it(`${JSON.stringify(cell)}: ${word} reads its drawn place, and a circle around it takes it`, async () => {
			const path = `table-align-${cell.replace(/[^a-z0-9]/gi, "")}.md`, t = rig(path, linesWith(cell));
			const drawn = t.wordAt(1, 1, word), read = t.overlay.followRefAt(t.posOf(5, cell) + at);
			const r = await t.attachOn(word), took = r ? t.text().slice(r.target.from, r.target.to) : null;
			note(`TABLE-ALIGN ${JSON.stringify(cell)} ${word}: read ${JSON.stringify(read)}, drawn ${drawn.left},${drawn.top}, took ${JSON.stringify(took)}`);
			expect(!!read && near(read.x, drawn.left) && near(read.y, drawn.top), "its read is its drawn first letter").toBe(true);
			expect(took, "the circle takes the word").toBe(word);
		});
	}
});
