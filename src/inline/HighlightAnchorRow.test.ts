/** A highlight across one row takes that row's line as its anchor, and Reading view and Export to PDF draw it on its words. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import { computeBBox, type InkPoint, type InkStroke, type LineAnchor } from "../ink/Stroke";
import { splitStrokeByCircle } from "../ink/Eraser";
import { parsePage, serializePage } from "../model/PageData";
import { embedInkDy, shownStrokes, splitLines, type BlockLines, type LineSpans } from "./EmbedInkLines";
import { targetAt, type AttachmentRecord } from "./InkAttachments";
import { LineAnchors, aboveOf, bodyFromOf, lineKey, lineUnder, newAboveRun, type LineLayout, type LineSignature } from "./LineAnchor";

const DIR = "test/fixtures/hl-anchor-run2";
const NOTE = readFileSync(`${DIR}/Why it rains.md`, "utf8");
const INK = readFileSync(`${DIR}/ink-499189be-9164-473d-a2ad-ff608bd334d3.json`, "utf8");
const PAGE_ID = "499189be-9164-473d-a2ad-ff608bd334d3";
const PATH = "Why it rains.md";
const SIG: LineSignature = { width: 1171, fontPx: 16, charWidth: 8 };
const LINE = 24;
const MARGIN = 16;
const HL = 16;
const PEN = 2.2;
const SIZES = [0.5, 1, 1.366, 2];

const FM = ["---", "handwriting-page-id: 6a670000-0000-4000-8000-00000000000b", "---"];
const LEAD2 = [...FM, "", "", "First paragraph words here.", "", "Second paragraph words here.", ""];
const GAP4 = ["Paragraph A words here.", "", "", "", "", "Paragraph B words here.", ""];

interface Editor {
	doc: Text;
	layout: LineLayout;
	/** World top of 1-based line n. */
	top(n: number): number;
}

/** A note in the editor: frontmatter hidden, each body line LINE world units (rows[n] rows for line n), `shift` px lower. */
function editorOf(lines: readonly string[], px = 1, rows: Record<number, number> = {}, shift = 0): Editor {
	const doc = Text.of([...lines]);
	const from = bodyFromOf(doc);
	const tops = [0];
	for (let n = 1; n <= doc.lines; n++) tops.push(tops.at(-1)! + (n < from ? 0 : (rows[n] ?? 1) * LINE));
	const at = (n: number) => tops[n - 1]! * px + (n >= from ? shift : 0);
	const layout: LineLayout = { lines: doc.lines, lineText: (n) => doc.line(n).text, lineTop: at, pxPerWorld: px, bodyFrom: from };
	return { doc, layout, top: (n) => tops[n - 1]! };
}

/** The note as Reading view and the PDF lay it out: one block per text line (rows[n] rows tall), MARGIN between, blank lines folded. */
function paperOf(lines: readonly string[], rows: Record<number, number> = {}): { spans: LineSpans; blockTop: Map<number, number> } {
	const from = bodyFromOf(Text.of([...lines])) - 1;
	const blocks: BlockLines[] = [];
	const blockTop = new Map<number, number>();
	let top = 0;
	lines.forEach((t, i) => {
		if (i < from || t === "") return;
		const at = top, h = (rows[i + 1] ?? 1) * LINE;
		blocks.push({ lineStart: i, lineEnd: i, box: () => ({ top: at, height: h }), lineHeight: () => LINE });
		blockTop.set(i + 1, at);
		top += h + MARGIN;
	});
	return { spans: { lines: [...lines], blocks, skip: from > 0 ? [{ from: 0, to: from - 1 }] : [] }, blockTop };
}

let serial = 0;
/** A stroke along world height `y` from x0 to x1, its box padded by twice its width as the builder pads it. */
function strokeAlong(tool: "pen" | "highlighter", y: number, width: number, x0 = 40, x1 = 400, id = `s${serial++}`): InkStroke {
	const points: InkPoint[] = Array.from({ length: 11 }, (_, i) => ({ x: x0 + ((x1 - x0) * i) / 10, y: y + (i % 2) * 0.5, pressure: 0.5, t: i * 8 }));
	return { id, tool, color: tool === "pen" ? "#111111" : "#ffd60a", width, points, bbox: computeBBox(points, width * 2), createdAt: 1 };
}

/** A highlighter stroke across the middle of line n's first row, at size `mult`. */
const highlightOn = (E: Editor, n: number, mult = 1, id?: string) => strokeAlong("highlighter", E.top(n) + LINE / 2, HL * mult, 40, 400, id);
/** A pen stroke across the middle of line n's first row, at size `mult`. */
const penOn = (E: Editor, n: number, mult = 1, id?: string) => strokeAlong("pen", E.top(n) + LINE / 2, PEN * mult, 40, 400, id);

/** A surface on the note over `layout`, its lines drawn and measured from 1 to `measured` (0: none). */
function surfaceOf(state: { layout: LineLayout }, measured = 0, sig = SIG): LineAnchors {
	const a = new LineAnchors(() => state.layout, () => true);
	a.setSignature(sig);
	a.tracks(PATH, []);
	if (measured > 0) {
		a.drawn(1, measured);
		a.drawn(1, measured, true, true);
	}
	return a;
}

const middle = (s: InkStroke) => s.bbox.y + s.bbox.height / 2;
/** Where Reading view and the PDF draw the stroke's middle, against the block of line n: [the middle, block top, block bottom]. */
function onPaper(s: InkStroke, lines: readonly string[], n: number, rows: Record<number, number> = {}): { mid: number; top: number; bottom: number } {
	const { spans, blockTop } = paperOf(lines, rows);
	const [shown] = shownStrokes([s], spans, 1, SIG);
	const top = blockTop.get(n)!;
	return { mid: middle(shown!), top, bottom: top + (rows[n] ?? 1) * LINE };
}
const inBlock = (p: { mid: number; top: number; bottom: number }) => p.mid >= p.top && p.mid < p.bottom;

/** The base rule a pen keeps: the line under its box top, that line's top, the box top as y. */
function penRule(s: InkStroke, layout: LineLayout, dy = 0): Pick<LineAnchor, "line" | "top" | "y" | "key"> {
	const px = layout.pxPerWorld;
	const line = lineUnder((s.bbox.y + dy) * px, layout.lines, (n) => layout.lineTop(n), layout.bodyFrom);
	return { line, top: layout.lineTop(line) / px - dy, y: s.bbox.y, key: lineKey(layout.lineText(line)) };
}
const fields = (a: LineAnchor | undefined) => (a ? { line: a.line, top: a.top, y: a.y, key: a.key } : null);

/** Run 2's strokes as the store loads them from the file. */
const saved = (): InkStroke[] => parsePage(INK, PAGE_ID).data.strokes;
/** Run 2's strokes without their saved anchors: as at pen-up. */
const fresh = (): InkStroke[] => saved().map((s) => ({ ...s, lineAnchor: undefined }));
const RUN2 = splitLines(NOTE);
const shownOf = (a: LineAnchors, src: InkStroke[]) => a.strokesFor(PATH, src).map((s) => JSON.stringify({ id: s.id, bbox: s.bbox, points: s.points }));
const rawStrokes = (json: string): Record<string, unknown>[] => (JSON.parse(json) as { strokes: Record<string, unknown>[] }).strokes;

describe("run 2 (two leading blank lines): the highlight on paragraph 1", () => {
	it("is anchored on paragraph 1's line, line 6, when drawn", () => {
		const E = editorOf(RUN2), state = { layout: E.layout };
		const src = fresh(), a = surfaceOf(state);
		const hl = src.find((s) => s.tool === "highlighter")!;
		a.anchorNew(PATH, hl);
		expect(E.layout.lineText(6)).toMatch(/^Warm air holds more water vapor/);
		expect(hl.lineAnchor?.line).toBe(6);
		expect(hl.lineAnchor?.y, "the anchor's y is the box top").toBe(hl.bbox.y);
	});

	it("prints on paragraph 1's row in Reading view and Export to PDF, not paragraph 2's", () => {
		const E = editorOf(RUN2), state = { layout: E.layout };
		const src = fresh(), a = surfaceOf(state);
		const hl = src.find((s) => s.tool === "highlighter")!;
		a.anchorNew(PATH, hl);
		const p = onPaper(hl, RUN2, 6);
		expect(inBlock(p), JSON.stringify(p)).toBe(true);
	});

	it("GUARD: the 25 pen strokes take the anchor their file holds (line 9, top 120)", () => {
		const E = editorOf(RUN2), state = { layout: E.layout };
		const was = saved().filter((s) => s.tool === "pen");
		const pens = fresh().filter((s) => s.tool === "pen"), a = surfaceOf(state);
		expect(pens).toHaveLength(25);
		for (const s of pens) a.anchorNew(PATH, s);
		expect(pens.map((s) => fields(s.lineAnchor))).toEqual(was.map((s) => ({ ...fields(s.lineAnchor)!, y: s.bbox.y })));
	});

	it("GUARD: in the editor the new highlight shows at its page position, the store's own object", () => {
		const E = editorOf(RUN2), state = { layout: E.layout };
		const src = fresh(), a = surfaceOf(state);
		for (const s of src) a.anchorNew(PATH, s);
		expect(a.strokesFor(PATH, src)).toBe(src);
	});

	it("the saved file opened in the editor: after the measured pass the highlight names line 6, and Reading view and the PDF print it on paragraph 1's row", () => {
		const E = editorOf(RUN2), state = { layout: E.layout };
		const src = saved(), a = surfaceOf(state, E.layout.lines);
		const hl = src.find((s) => s.tool === "highlighter")!;
		expect(hl.lineAnchor?.line, "premise: saved on the first leading blank line").toBe(4);
		const y = hl.lineAnchor!.y;
		a.strokesFor(PATH, src);
		a.anchorMeasured(PATH, src);
		expect(hl.lineAnchor?.line).toBe(6);
		expect(hl.lineAnchor?.y, "the anchor's y is the saved box top").toBe(y);
		const p = onPaper(hl, RUN2, 6);
		expect(inBlock(p), JSON.stringify(p)).toBe(true);
	});

	it("written back after that pass, the file carries line 6 for the highlight", () => {
		const E = editorOf(RUN2), state = { layout: E.layout };
		const page = parsePage(INK, PAGE_ID).data, a = surfaceOf(state, E.layout.lines);
		a.strokesFor(PATH, page.strokes);
		a.anchorMeasured(PATH, page.strokes);
		const out = rawStrokes(serializePage(page)).find((s) => s.tool === "highlighter")!;
		expect((out.lineAnchor as LineAnchor).line).toBe(6);
	});

	it("GUARD: written back after that pass, every stroke but the highlight's anchor is the file's own record, points byte for byte", () => {
		const E = editorOf(RUN2), state = { layout: E.layout };
		const page = parsePage(INK, PAGE_ID).data, a = surfaceOf(state, E.layout.lines);
		a.strokesFor(PATH, page.strokes);
		a.anchorMeasured(PATH, page.strokes);
		const drop = (s: Record<string, unknown>) => (s.tool === "highlighter" ? { ...s, lineAnchor: null } : s);
		expect(rawStrokes(serializePage(page)).map(drop)).toEqual(rawStrokes(INK).map(drop));
	});

	it("GUARD: the editor shows every stroke where it showed before the pass, opened 10 px lower than it was saved, and again after a reopen", () => {
		const E = editorOf(RUN2, 1, {}, 10), state = { layout: E.layout };
		const page = parsePage(INK, PAGE_ID).data, a = surfaceOf(state, E.layout.lines);
		const before = shownOf(a, page.strokes);
		expect(a.dyOf(page.strokes.find((s) => s.tool === "highlighter")!), "premise: shown 10 lower").toBe(10);
		a.anchorMeasured(PATH, page.strokes);
		expect(shownOf(a, page.strokes), "after the pass").toEqual(before);
		const again = parsePage(serializePage(page), PAGE_ID).data.strokes, b = surfaceOf(state, E.layout.lines);
		expect(shownOf(b, again), "reopened from the written file").toEqual(before);
	});

	it("GUARD: the pass asks for no save, and further passes and a measure keep the highlight's anchor as it is", () => {
		const E = editorOf(RUN2), state = { layout: E.layout };
		const src = saved(), a = surfaceOf(state, E.layout.lines);
		const hl = src.find((s) => s.tool === "highlighter")!;
		a.strokesFor(PATH, src);
		a.anchorMeasured(PATH, src);
		expect(a.takeBoxTopMoved(), "no box move asks the store to save").toBe(false);
		const once = JSON.stringify(hl.lineAnchor);
		a.anchorMeasured(PATH, src);
		a.layoutChanged(PATH, src, "measure");
		a.anchorMeasured(PATH, src);
		a.strokesFor(PATH, src);
		expect(JSON.stringify(hl.lineAnchor)).toBe(once);
		expect(a.takeBoxTopMoved()).toBe(false);
	});

	it("GUARD: Reading view and the PDF print every pen where the file's own anchors put it", () => {
		const E = editorOf(RUN2), state = { layout: E.layout };
		const src = saved(), a = surfaceOf(state, E.layout.lines);
		const { spans } = paperOf(RUN2);
		const want = shownStrokes(saved().filter((s) => s.tool === "pen"), spans, 1, SIG).map((s) => s.bbox.y);
		a.strokesFor(PATH, src);
		a.anchorMeasured(PATH, src);
		expect(shownStrokes(src.filter((s) => s.tool === "pen"), spans, 1, SIG).map((s) => s.bbox.y)).toEqual(want);
	});
});

describe("a highlight at sizes 0.5 to 2 takes its row's line, and prints on its words", () => {
	it.each(SIZES)("size %s, on the first body row under two leading blank lines and frontmatter", (mult) => {
		const E = editorOf(LEAD2), state = { layout: E.layout }, n = 6;
		const hl = highlightOn(E, n, mult), a = surfaceOf(state);
		a.anchorNew(PATH, hl);
		expect(hl.lineAnchor?.line).toBe(n);
		const p = onPaper(hl, LEAD2, n);
		expect(inBlock(p), JSON.stringify(p)).toBe(true);
	});

	it.each(SIZES)("size %s, on the second paragraph under two leading blank lines", (mult) => {
		const E = editorOf(LEAD2), state = { layout: E.layout }, n = 8;
		const hl = highlightOn(E, n, mult), a = surfaceOf(state);
		a.anchorNew(PATH, hl);
		expect(hl.lineAnchor?.line).toBe(n);
		expect(inBlock(onPaper(hl, LEAD2, n))).toBe(true);
	});

	it.each(SIZES)("size %s, on a paragraph under four blank lines above it", (mult) => {
		const E = editorOf(GAP4), state = { layout: E.layout }, n = 6;
		const hl = highlightOn(E, n, mult), a = surfaceOf(state);
		a.anchorNew(PATH, hl);
		expect(hl.lineAnchor?.line).toBe(n);
		const p = onPaper(hl, GAP4, n);
		expect(inBlock(p), JSON.stringify(p)).toBe(true);
	});

	it.each([0.5, 1, 2])("editor scale %s px per world unit: size 2 on the first body row names the same line", (px) => {
		const E = editorOf(LEAD2, px), state = { layout: E.layout }, n = 6;
		const hl = highlightOn(E, n, 2), a = surfaceOf(state);
		a.anchorNew(PATH, hl);
		expect(hl.lineAnchor?.line).toBe(n);
	});

	it("on the last row of a three-row paragraph, one blank line under it, two leading blank lines: the paragraph's line, its last row on paper", () => {
		const rows = { 6: 3 }, E = editorOf(LEAD2, 1, rows), state = { layout: E.layout }, n = 6;
		const hl = strokeAlong("highlighter", E.top(n) + 2.5 * LINE, HL * 2), a = surfaceOf(state);
		a.anchorNew(PATH, hl);
		expect(hl.lineAnchor?.line).toBe(n);
		const p = onPaper(hl, LEAD2, n, rows);
		expect(p.mid >= p.top + 2 * LINE && p.mid < p.bottom, JSON.stringify(p)).toBe(true);
	});
});

describe("every re-take keeps a highlight on its row", () => {
	it("a line typed above, no line measured: re-taken where it is shown, on the line under its middle, not its box top's", () => {
		const E = editorOf(GAP4), state = { layout: E.layout };
		const hl = highlightOn(E, 6, 2), src = [hl], a = surfaceOf(state);
		a.anchorNew(PATH, hl);
		const changes = ChangeSet.of({ from: E.doc.line(1).to, insert: "\nTyped line." }, E.doc.length);
		const after = changes.apply(E.doc);
		state.layout = editorOf(after.toJSON()).layout;
		a.docChanged(PATH, src, E.doc, changes, after);
		expect(a.dyOf(hl), "typing moves no ink").toBe(0);
		expect(hl.lineAnchor?.line).toBe(6);
		expect(hl.lineAnchor?.y).toBe(hl.bbox.y);
	});

	it("an edit across the blank lines and the highlighted row, lines measured", () => {
		const E = editorOf(GAP4), state = { layout: E.layout };
		const hl = highlightOn(E, 6, 2), src = [hl], a = surfaceOf(state, E.layout.lines);
		a.anchorNew(PATH, hl);
		const changes = ChangeSet.of({ from: E.doc.line(3).from, to: E.doc.line(6).to, insert: "\n\n\nParagraph B more words here." }, E.doc.length);
		const after = changes.apply(E.doc);
		state.layout = editorOf(after.toJSON()).layout;
		a.docChanged(PATH, src, E.doc, changes, after);
		a.drawn(a.changedLines.from, a.changedLines.to, false);
		a.drawn(a.changedLines.from, a.changedLines.to, false, true);
		a.layoutChanged(PATH, src, "measure");
		a.dyOf(hl);
		expect(hl.lineAnchor?.line).toBe(6);
		expect(hl.lineAnchor?.key).toBe(lineKey("Paragraph B more words here."));
	});

	it("a lasso drop's re-take where it is shown", () => {
		const E = editorOf(GAP4), state = { layout: E.layout };
		const hl = highlightOn(E, 6, 2), src = [hl], a = surfaceOf(state);
		a.anchorNew(PATH, hl);
		a.retake(PATH, [hl], undefined, src);
		expect(hl.lineAnchor?.line).toBe(6);
	});

	it("another content width: the measured pass takes it anew on its row", () => {
		const E = editorOf(GAP4), state = { layout: E.layout };
		const hl = highlightOn(E, 6, 2), src = [hl], a = surfaceOf(state);
		a.anchorNew(PATH, hl);
		a.setSignature({ ...SIG, width: 700 });
		a.drawn(1, E.layout.lines);
		a.drawn(1, E.layout.lines, true, true);
		expect(a.anchorMeasured(PATH, src), "premise: taken anew").toBe(1);
		expect(hl.lineAnchor?.line).toBe(6);
		expect(hl.lineAnchor?.width).toBe(700);
	});

	it("an attached pen word and a highlight over it: an Enter above moves both as one; the highlight names its row, the pen keeps its rule", () => {
		const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1} words`);
		const E = editorOf(lines), state = { layout: E.layout }, n = 8;
		const pen = penOn(E, n, 1, "gp"), hl = highlightOn(E, n, 2, "gh"), src: InkStroke[] = [];
		const a = surfaceOf(state, lines.length);
		for (const s of [pen, hl]) {
			src.push(s);
			a.anchorNew(PATH, s);
		}
		a.layoutChanged(PATH, src, "measure");
		const top = (doc: Text) => (pos: number) => (doc.lineAt(pos).number - 1) * LINE;
		const view = (doc: Text) => ({ inView: () => true, refAt: (pos: number) => ({ x: 0, y: top(doc)(pos) }), blockTop: top(doc) });
		const line = E.doc.line(n);
		const rec: AttachmentRecord = {
			v: 1, id: "g", strokeIds: ["gp", "gh"], target: targetAt(E.doc.toString(), line.from, line.to, "paragraph"),
			ref: { x: 0, y: (n - 1) * LINE }, layout: { width: SIG.width, font: SIG.fontPx }, probe: { id: "gp", x: pen.points[0]!.x, y: pen.points[0]!.y },
		};
		a.follow.setList([rec]);
		a.follow.measure(view(E.doc));
		const penWas = penRule(pen, E.layout);
		const changes = ChangeSet.of({ from: E.doc.line(2).to, insert: "\n" }, E.doc.length);
		const after = changes.apply(E.doc);
		state.layout = editorOf(after.toJSON()).layout;
		a.docChanged(PATH, src, E.doc, changes, after);
		const snap = a.follow.snapshot();
		const mapped = a.follow.docChanged(changes, view(after).blockTop, 1);
		if (a.follow.takeEdited()) a.retakeMembers(PATH, src, snap);
		a.shareAttachments(mapped);
		expect(a.follow.groupOffset("g")?.dy, "premise: the group moved one line").toBe(LINE);
		expect(hl.lineAnchor?.line).toBe(n + 1);
		expect(pen.lineAnchor?.line).toBe(penWas.line + 1);
		const spans: LineSpans = { lines: after.toJSON(), blocks: after.toJSON().map((_, i) => ({ lineStart: i, lineEnd: i, box: () => ({ top: i * LINE, height: LINE }), lineHeight: () => LINE })), skip: [] };
		expect([embedInkDy(pen, spans, 1, SIG), embedInkDy(hl, spans, 1, SIG)], "both members drawn at the group's move").toEqual([LINE, LINE]);
	});

	it("a group moved by a measure, a member highlight saved on a line above its row: re-taken on the line under its shown middle", () => {
		const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1} words`);
		const E = editorOf(lines), state = { layout: E.layout }, n = 8;
		const pen = penOn(E, n, 1, "mp"), hl = highlightOn(E, n, 2, "mh"), src: InkStroke[] = [pen, hl];
		const a = surfaceOf(state, lines.length);
		a.anchorNew(PATH, pen);
		hl.lineAnchor = { ...penRule(hl, E.layout), width: SIG.width, fontPx: SIG.fontPx };
		expect(hl.lineAnchor.line, "premise: saved two lines above its row").toBeLessThan(n - 1);
		a.strokesFor(PATH, src);
		const view = (grown: number) => {
			const top = (pos: number) => {
				const k = E.doc.lineAt(pos).number;
				return (k - 1) * LINE + (k > grown ? LINE : 0);
			};
			return { inView: () => true, refAt: (pos: number) => ({ x: 0, y: top(pos) }), blockTop: top };
		};
		const line = E.doc.line(n);
		const rec: AttachmentRecord = {
			v: 1, id: "m", strokeIds: ["mp", "mh"], target: targetAt(E.doc.toString(), line.from, line.to, "paragraph"),
			ref: { x: 0, y: (n - 1) * LINE }, layout: { width: SIG.width, font: SIG.fontPx }, probe: { id: "mp", x: pen.points[0]!.x, y: pen.points[0]!.y },
		};
		a.follow.setList([rec]);
		a.follow.measure(view(Infinity));
		// Line 6, between the saved line and the row, wraps to a second row; the measure reads it and the group moves one row.
		state.layout = editorOf(lines, 1, { 6: 2 }).layout;
		a.drawn(1, lines.length);
		a.drawn(1, lines.length, true, true);
		const snap = a.follow.snapshot();
		a.follow.layoutChanged();
		a.follow.measure(view(6));
		expect(a.follow.groupOffset("m")?.dy, "premise: the group moved one row").toBe(LINE);
		a.retakeMembers(PATH, src, snap);
		expect(hl.lineAnchor?.line).toBe(n);
		expect(hl.lineAnchor?.y).toBe(hl.bbox.y);
		expect(pen.lineAnchor?.line, "the pen word was already on its row").toBe(n);
	});
});

describe("pens keep the base rule", () => {
	const PENS: [string, (E: Editor) => InkStroke][] = [
		["the widest pen (size 3)", (E) => penOn(E, 6, 3)],
		["the finest pen (size 0.3)", (E) => penOn(E, 6, 0.3)],
		["a mouse pen", (E) => ({ ...penOn(E, 6, 3), device: "mouse" })],
		["a record with no tool", (E) => ({ ...highlightOn(E, 6, 2), tool: undefined as unknown as "pen" })],
	];

	it.each(PENS)("GUARD: %s across a row under two leading blank lines: the line under its box top", (_, make) => {
		const E = editorOf(LEAD2), state = { layout: E.layout };
		const s = make(E), a = surfaceOf(state);
		a.anchorNew(PATH, s);
		expect(fields(s.lineAnchor)).toEqual(penRule(s, E.layout));
	});

	it.each(PENS)("GUARD: %s re-taken after a line typed above and after a lasso drop: still the line under its box top", (_, make) => {
		const E = editorOf(LEAD2), state = { layout: E.layout };
		const s = make(E), src = [s], a = surfaceOf(state);
		a.anchorNew(PATH, s);
		a.retake(PATH, [s], undefined, src);
		expect(fields(s.lineAnchor), "lasso drop").toEqual(penRule(s, E.layout));
		const changes = ChangeSet.of({ from: E.doc.line(4).from, insert: "Typed line.\n" }, E.doc.length);
		const after = changes.apply(E.doc);
		state.layout = editorOf(after.toJSON()).layout;
		a.docChanged(PATH, src, E.doc, changes, after);
		a.dyOf(s);
		expect(fields(s.lineAnchor), "line typed above").toEqual(penRule(s, state.layout));
	});

	it("GUARD: a pen stroke saved on a blank line above its row keeps that anchor through the measured pass", () => {
		const E = editorOf(GAP4), state = { layout: E.layout };
		const s = penOn(E, 6, 3), src = [s];
		s.lineAnchor = { ...penRule(s, E.layout), line: 4, top: E.top(4), key: lineKey(""), width: SIG.width, fontPx: SIG.fontPx };
		const was = fields(s.lineAnchor);
		const a = surfaceOf(state, E.layout.lines);
		a.strokesFor(PATH, src);
		a.anchorMeasured(PATH, src);
		expect(fields(s.lineAnchor)).toEqual(was);
	});
});

describe("erased pieces", () => {
	it("a long highlight on a row erased in the middle: after the measured pass each piece holds and names that row", () => {
		const E = editorOf(GAP4), state = { layout: E.layout }, n = 6;
		const hl = highlightOn(E, n, 2), a = surfaceOf(state, E.layout.lines);
		a.anchorNew(PATH, hl);
		const pieces = splitStrokeByCircle(hl, 220, E.top(n) + LINE / 2, 20, () => `p${serial++}`);
		expect(pieces.length, "premise: cut in two").toBe(2);
		a.strokesFor(PATH, pieces);
		a.anchorMeasured(PATH, pieces);
		for (const p of pieces) {
			expect(p.lineAnchor?.line).toBe(n);
			expect(Math.abs(p.lineAnchor!.y - p.bbox.y)).toBeLessThanOrEqual(0.5);
			expect(inBlock(onPaper(p, GAP4, n))).toBe(true);
		}
	});

	it("GUARD: a pen erased in the middle: each piece keeps its parent's line", () => {
		const E = editorOf(GAP4), state = { layout: E.layout }, n = 6;
		const pen = penOn(E, n, 3), a = surfaceOf(state, E.layout.lines);
		a.anchorNew(PATH, pen);
		const pieces = splitStrokeByCircle(pen, 220, E.top(n) + LINE / 2, 20, () => `q${serial++}`);
		a.strokesFor(PATH, pieces);
		a.anchorMeasured(PATH, pieces);
		expect(pieces.map((p) => p.lineAnchor?.line)).toEqual(pieces.map(() => pen.lineAnchor!.line));
	});
});

describe("a highlight saved by 1.5.1 with its anchor above its row", () => {
	/** A size-2 highlight on paragraph B under four blank lines, anchored as 1.5.1 anchored it: the line under its box top. */
	function oldHighlight(E: Editor, withAbove: boolean): InkStroke {
		const hl = highlightOn(E, 6, 2);
		const r = penRule(hl, E.layout);
		hl.lineAnchor = { ...r, width: SIG.width, fontPx: SIG.fontPx };
		if (withAbove) hl.lineAnchor.above = aboveOf(newAboveRun(), r.line, (k) => lineKey(E.doc.line(k).text));
		return hl;
	}

	it.each([true, false])("lines-above hash saved %s: after the measured pass it names its row and prints on its words; the editor shows it where it showed", (withAbove) => {
		const E = editorOf(GAP4, 1, {}, 7), state = { layout: E.layout };
		const hl = oldHighlight(E, withAbove), src = [hl];
		expect(hl.lineAnchor!.line, "premise: saved on a blank line above its row").toBeLessThan(6);
		const a = surfaceOf(state, E.layout.lines);
		const before = shownOf(a, src);
		a.anchorMeasured(PATH, src);
		expect(hl.lineAnchor?.line).toBe(6);
		expect(shownOf(a, src)).toEqual(before);
		const p = onPaper(hl, GAP4, 6);
		expect(inBlock(p), JSON.stringify(p)).toBe(true);
	});

	it("GUARD: a saved highlight already on its row keeps its anchor object through the pass", () => {
		const E = editorOf(GAP4), state = { layout: E.layout };
		const hl = highlightOn(E, 6, 2), src = [hl];
		hl.lineAnchor = { line: 6, top: E.top(6), y: hl.bbox.y, key: lineKey(E.doc.line(6).text), width: SIG.width, fontPx: SIG.fontPx, above: aboveOf(newAboveRun(), 6, (k) => lineKey(E.doc.line(k).text)) };
		const was = hl.lineAnchor, json = JSON.stringify(was);
		const a = surfaceOf(state, E.layout.lines);
		a.strokesFor(PATH, src);
		a.anchorMeasured(PATH, src);
		expect(hl.lineAnchor).toBe(was);
		expect(JSON.stringify(hl.lineAnchor)).toBe(json);
	});

	it("sharing its saved line with a pen mark, a line typed above, no line measured: each re-taken on the line under where it is shown", () => {
		const E = editorOf(GAP4), state = { layout: E.layout };
		const hl = oldHighlight(E, false), pen = penOn(E, 3), src = [pen, hl], a = surfaceOf(state);
		a.anchorNew(PATH, pen);
		expect([pen.lineAnchor?.line, hl.lineAnchor?.line], "premise: both saved on line 3").toEqual([3, 3]);
		a.strokesFor(PATH, src);
		const changes = ChangeSet.of({ from: E.doc.line(1).to, insert: "\nTyped line." }, E.doc.length);
		const after = changes.apply(E.doc);
		state.layout = editorOf(after.toJSON()).layout;
		a.docChanged(PATH, src, E.doc, changes, after);
		expect([a.dyOf(pen), a.dyOf(hl)], "typing moves no ink").toEqual([0, 0]);
		expect(hl.lineAnchor?.line).toBe(6);
		expect(hl.lineAnchor?.y).toBe(hl.bbox.y);
		expect(fields(pen.lineAnchor)).toEqual(penRule(pen, state.layout));
	});
});
