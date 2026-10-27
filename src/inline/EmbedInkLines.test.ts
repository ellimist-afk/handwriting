/**
 * Read-only views draw anchored ink on its words: the line-to-block rules, the guards and the cached-section mapping.
 *
 * One note throughout, in the editor's 1-based lines: a three-line frontmatter (hidden in the editor, so line 4 is at
 * the top), three one-line paragraphs with two blank lines between each, a blank line, a three-item list, three blank
 * lines and a last paragraph. Every editor line is 24 px; the frontmatter takes none. The rendered blocks sit where a
 * reading view puts them: paragraph margins in place of the blank lines, the list one 72 px block. A stroke's anchor
 * holds the editor's line top, so its correction is the rendered top minus that.
 */
import { describe, expect, it } from "vitest";
import type { InkStroke, LineAnchor } from "../ink/Stroke";
import { embedInkDy, lineTopIn, mapCachedSections, shownStrokes, spansFromCache, splitLines, type BlockLines, type BlockRows, type LineSpans } from "./EmbedInkLines";
import { aboveOf, lineKey, newAboveRun } from "./LineAnchor";

const TEXT = [
	"---", "tags: note", "---",
	"This is the first paragraph.", "", "",
	"This is second, the middle one.", "", "",
	"A third pargaph, with a trick.", "",
	"- one", "- two", "- three", "", "", "",
	"Last words.",
].join("\n");
const LINES = splitLines(TEXT);
const LINE = 24;
/** The lines-above hash of 1-based line n in `lines`, as the editor takes it. */
const aboveIn = (lines: readonly string[], n: number) => aboveOf(newAboveRun(), n, (k) => lineKey(lines[k - 1]!));
/** The editor's top of 1-based line n: the frontmatter is hidden, line 4 is at 0. */
const editorTop = (n: number) => Math.max(0, n - 4) * LINE;

/** A block of 0-based lines [lineStart, lineEnd] with its rendered box. */
const block = (lineStart: number, lineEnd: number, top: number, height: number): BlockLines => ({
	lineStart,
	lineEnd,
	box: () => ({ top, height }),
	lineHeight: () => LINE,
});
const BLOCKS = [block(3, 3, 0, 24), block(6, 6, 60, 24), block(9, 9, 120, 24), block(11, 13, 180, 72), block(17, 17, 300, 24)];
const SPANS: LineSpans = { lines: LINES, blocks: BLOCKS, skip: [{ from: 0, to: 2 }] };

let serial = 0;
/** A stroke whose bbox top sits `below` px under editor line `line`'s top, anchored there as the editor would. */
function anchored(line: number, below = 4, over: Partial<LineAnchor> = {}): InkStroke {
	const y = editorTop(line) + below;
	const a: LineAnchor = { line, top: editorTop(line), y, key: lineKey(LINES[line - 1]!), width: 668, fontPx: 16, above: aboveIn(LINES, line), ...over };
	return {
		id: `s${serial++}`,
		tool: "pen",
		color: "#000000",
		width: 2,
		createdAt: 0,
		points: [{ x: 10, y: y + 2, pressure: 0.5, t: 0 }, { x: 40, y: y + 2, pressure: 0.5, t: 9 }],
		bbox: { x: 8, y, width: 34, height: 4 },
		lineAnchor: a,
	} as InkStroke;
}

describe("a line's top in the rendered view", () => {
	it("the first line of a block is the block's top, exact", () => {
		expect(lineTopIn(SPANS, 6)).toBe(60);
		expect(embedInkDy(anchored(7), SPANS)).toBe(60 - editorTop(7));
	});

	it("a later line of a block of several lines takes its share of the block's height (an estimate)", () => {
		// 0-based 13 is the list's third line: 180 + 2 * 72 / 3.
		expect(lineTopIn(SPANS, 13)).toBe(228);
		expect(embedInkDy(anchored(14), SPANS)).toBe(228 - editorTop(14));
	});

	it("the anchor's 1-based line N is the renderer's 0-based line N - 1", () => {
		// Line 7 is the middle paragraph's text; its block starts at 0-based 6. Read one line off, the key would be a
		// blank line's and the stroke would keep its page position.
		const s = anchored(7);
		expect(s.lineAnchor!.key).toBe(lineKey(LINES[6]!));
		expect(lineKey(LINES[7]!)).not.toBe(s.lineAnchor!.key);
		expect(embedInkDy(s, SPANS)).toBe(-12);
	});
});

describe("blank lines ride the nearest block", () => {
	it("of two blank lines between paragraphs, the first rides the one above and the second the one below", () => {
		// 0-based 7 is one line below the middle paragraph and two above the third: the middle one's bottom.
		expect(lineTopIn(SPANS, 7)).toBe(60 + 24);
		expect(embedInkDy(anchored(8), SPANS)).toBe(84 - editorTop(8));
		// 0-based 8 is one line above the third paragraph: one line height above its top.
		expect(lineTopIn(SPANS, 8)).toBe(120 - LINE);
		expect(embedInkDy(anchored(9), SPANS)).toBe(96 - editorTop(9));
	});

	it("a tie goes down", () => {
		// 0-based 15 is two lines below the list and two above the last paragraph.
		expect(lineTopIn(SPANS, 15)).toBe(300 - 2 * LINE);
	});

	it("frontmatter lines are crossed as blank", () => {
		// 0-based 1 is inside the frontmatter: the first paragraph, two lines below.
		expect(lineTopIn(SPANS, 1)).toBe(0 - 2 * LINE);
	});

	it("a blank line whose way to a block crosses text with no block has no top", () => {
		const spans: LineSpans = { ...SPANS, blocks: BLOCKS.filter((b) => b.lineStart !== 9) };
		// 0-based 10 is blank; above it is the third paragraph's text, now with no block; below it the list.
		expect(lineTopIn(spans, 10)).toBe(180 - LINE);
		// 0-based 8 is blank; below it the third paragraph's text with no block, above it the middle paragraph.
		expect(lineTopIn(spans, 8)).toBe(60 + 24 + LINE);
		const none: LineSpans = { ...SPANS, blocks: [] };
		expect(lineTopIn(none, 8)).toBeNull();
	});
});

describe("a later line of a block whose element shows one row per line: that row's top, exact", () => {
	// 0-based: a list of three items, the second wrapping to two rendered lines (lines 0-2); a fenced code block of
	// four rows, the third empty (4-9); a paragraph of three lines joined by hard breaks, the first wrapping (11-13).
	const KINDS = splitLines([
		"- one", "- two, long enough to wrap", "- three", "",
		"```js", "a", "b", "", "c", "```", "",
		"First line, long enough to wrap", "second", "third",
	].join("\n"));
	const rows = (kind: BlockRows["kind"], tops: readonly (number | null)[]): BlockRows => ({
		kind,
		count: tops.length,
		top: (k) => tops[k] ?? null,
	});
	const kinded = (lineStart: number, lineEnd: number, top: number, height: number, r: BlockRows | null): BlockLines => ({
		...block(lineStart, lineEnd, top, height),
		rows: () => r,
	});
	const at = (b: BlockLines, i: number, lines: readonly string[] = KINDS) => lineTopIn({ lines, blocks: [b], skip: [] }, i);
	// Item tops 0, 24, 72 in a 96 px list: the estimate would put the items at 32 and 64.
	const LIST = kinded(0, 2, 0, 96, rows("list", [0, 24, 72]));
	// Rows at 12 (the padding), 36, 60, 84 in a 130 px block: the estimate takes each of its six lines as 130 / 6.
	const CODE = kinded(4, 9, 120, 130, rows("code", [12, 36, 60, 84]));
	// Visual lines start at 0, 48 (after the wrapped first line) and 72 in a 96 px paragraph.
	const BREAKS = kinded(11, 13, 264, 96, rows("breaks", [0, 48, 72]));

	it("a flat list: each item's top", () => {
		expect(at(LIST, 1)).toBe(24);
		expect(at(LIST, 2)).toBe(72);
	});

	it("a code block: the opening fence is the block's top, each row its own top, an empty row too", () => {
		expect(at(CODE, 4)).toBe(120);
		expect(at(CODE, 5)).toBe(132);
		expect(at(CODE, 7)).toBe(180);
		expect(at(CODE, 8)).toBe(204);
	});

	it("a code block with no closing fence, or none at all: its rows run to the block's end", () => {
		const open = splitLines(["```", "a", "b"].join("\n"));
		expect(at(kinded(0, 2, 0, 60, rows("code", [12, 36])), 2, open)).toBe(36);
		const indented = splitLines(["    a", "    b", "    c"].join("\n"));
		expect(at(kinded(0, 2, 0, 90, rows("code", [12, 36, 60])), 1, indented)).toBe(36);
	});

	it("a hard-break paragraph: the top of the line each source line starts", () => {
		expect(at(BREAKS, 12)).toBe(264 + 48);
		expect(at(BREAKS, 13)).toBe(264 + 72);
	});

	it("a list whose items are fewer than its lines (nested, loose or continued): the estimate", () => {
		expect(at(kinded(0, 2, 0, 96, rows("list", [0, 24])), 1)).toBe(32);
	});

	it("a code block whose rows are not its lines less the fences: the estimate", () => {
		expect(at(kinded(4, 9, 120, 130, rows("code", [12, 36, 60])), 5)).toBe(120 + 130 / 6);
	});

	it("the closing fence: no row shows it, the estimate", () => {
		expect(at(CODE, 9)).toBe(120 + (5 * 130) / 6);
	});

	it("a paragraph with fewer hard breaks than lines (strict line breaks): the estimate", () => {
		expect(at(kinded(11, 13, 264, 96, rows("breaks", [0, 48])), 12)).toBe(264 + 32);
	});

	it("a row not laid out, or an element of no such kind: the estimate", () => {
		const unlaid = kinded(0, 2, 0, 96, rows("list", [0, null, Number.NaN]));
		expect(at(unlaid, 1)).toBe(32);
		expect(at(unlaid, 2)).toBe(64);
		expect(at(kinded(0, 2, 0, 96, null), 2)).toBe(64);
	});
});

describe("guards: page position", () => {
	it("a key that is not the anchored line's text", () => {
		expect(embedInkDy(anchored(7, 4, { key: lineKey("This is second, edited.") }), SPANS)).toBe(0);
	});

	it("the text above the line edited where no anchor followed it: a blank line's ink keeps its page position", () => {
		// Line 8 is blank and hashes the same after the paragraph on line 7 is edited; the lines above it do not.
		const s = anchored(8);
		expect(embedInkDy(s, SPANS)).toBe(84 - editorTop(8));
		const edited = LINES.map((l, i) => (i === 6 ? "This is second, the middle one, and much longer now." : l));
		expect(lineKey(edited[7]!)).toBe(s.lineAnchor!.key);
		expect(embedInkDy(s, { ...SPANS, lines: edited })).toBe(0);
	});

	it("an anchor saved without the lines-above hash (an older build's) reads as that build read it, in Reading view and export", () => {
		const s = anchored(7);
		delete s.lineAnchor!.above;
		const today = embedInkDy(anchored(7), SPANS);
		expect(today).not.toBe(0);
		expect(embedInkDy(s, SPANS)).toBe(today);
	});

	it("a stroke with no anchor", () => {
		const s = anchored(7);
		delete s.lineAnchor;
		expect(embedInkDy(s, SPANS)).toBe(0);
	});

	it("no section info, or a line of text whose block is not rendered", () => {
		expect(embedInkDy(anchored(7), null)).toBe(0);
		const spans: LineSpans = { ...SPANS, blocks: BLOCKS.filter((b) => b.lineStart !== 6) };
		expect(embedInkDy(anchored(7), spans)).toBe(0);
		const unlaid: LineSpans = { ...SPANS, blocks: BLOCKS.map((b) => (b.lineStart === 6 ? { ...b, box: () => null } : b)) };
		expect(embedInkDy(anchored(7), unlaid)).toBe(0);
	});

	it("a stroke moved off the y its anchor was taken at", () => {
		expect(embedInkDy(anchored(7, 4, { y: editorTop(7) + 5 }), SPANS)).toBe(0);
		expect(embedInkDy(anchored(7, 4, { y: editorTop(7) + 4.4 }), SPANS)).toBe(-12);
	});

	it("a line past the text", () => {
		expect(embedInkDy(anchored(7, 4, { line: LINES.length + 1 }), SPANS)).toBe(0);
	});
});

describe("shown strokes", () => {
	it("the list itself when nothing moves; copies of moved strokes, the stored ones untouched", () => {
		const still = anchored(4);
		const moved = anchored(7);
		const before = JSON.stringify(moved);
		const plain = [still];
		expect(shownStrokes(plain, SPANS)).toBe(plain);
		const out = shownStrokes([still, moved], SPANS);
		expect(out[0]).toBe(still);
		expect(out[1]).not.toBe(moved);
		expect(out[1]!.bbox.y).toBe(moved.bbox.y - 12);
		expect(out[1]!.points[0]!.y).toBe(moved.points[0]!.y - 12);
		expect(out[1]!.bbox.x).toBe(moved.bbox.x);
		expect(JSON.stringify(moved)).toBe(before);
		expect(shownStrokes([still, moved], SPANS)[1]).toBe(out[1]);
	});
});

describe("text at another size than the note's reference: the view draws world units at that zoom", () => {
	it("the correction is the rendered top in world units, the px top over the zoom, less the anchor's top", () => {
		// Text at half the reference: the middle paragraph's px top 60 is 120 world units down.
		expect(embedInkDy(anchored(7), SPANS, 0.5)).toBe(120 - editorTop(7));
		expect(embedInkDy(anchored(8), SPANS, 0.5)).toBe(168 - editorTop(8));
		expect(embedInkDy(anchored(7), SPANS, 1.5)).toBe(40 - editorTop(7));
	});

	it("at zoom 1 the correction is the one in px", () => {
		expect(embedInkDy(anchored(7), SPANS, 1)).toBe(-12);
		expect(embedInkDy(anchored(7), SPANS, 1)).toBe(embedInkDy(anchored(7), SPANS));
	});

	it("shown strokes follow the zoom; a stroke on a line at the view's top still stays as it is", () => {
		const still = anchored(4);
		const moved = anchored(7);
		const out = shownStrokes([still, moved], SPANS, 0.5);
		expect(out[0]).toBe(still);
		expect(out[1]!.bbox.y).toBe(moved.bbox.y + 120 - editorTop(7));
	});
});

describe("a render with no section info: cached sections laid onto its blocks", () => {
	const SECTIONS = [
		{ type: "yaml", lineStart: 0, lineEnd: 2 },
		{ type: "paragraph", lineStart: 3, lineEnd: 3 },
		{ type: "heading", lineStart: 6, lineEnd: 6 },
		{ type: "comment", lineStart: 8, lineEnd: 8 },
		{ type: "list", lineStart: 11, lineEnd: 13 },
		{ type: "footnoteDefinition", lineStart: 15, lineEnd: 15 },
	];
	const TAGS = [["DIV", "P"], ["DIV", "H2"], ["UL", "LI"]] as const;

	it("pairs in order, frontmatter, comments and footnotes left out", () => {
		expect(mapCachedSections(SECTIONS, TAGS)?.map((s) => s.lineStart)).toEqual([3, 6, 11]);
	});

	it("count guard: one block more or fewer than sections, no mapping", () => {
		expect(mapCachedSections(SECTIONS, [...TAGS, ["DIV", "P"]])).toBeNull();
		expect(mapCachedSections(SECTIONS, TAGS.slice(0, 2))).toBeNull();
	});

	it("type guard: a heading, list, code, table or rule must render as one; a paragraph takes any element", () => {
		expect(mapCachedSections(SECTIONS, [["DIV", "P"], ["DIV", "P"], ["UL", "LI"]])).toBeNull();
		expect(mapCachedSections(SECTIONS, [["DIV", "SPAN"], ["H2", null], ["DIV", "OL"]])?.length).toBe(3);
		expect(mapCachedSections([{ type: "code", lineStart: 0, lineEnd: 2 }], [["DIV", "DIV"]])).toBeNull();
		expect(mapCachedSections([{ type: "code", lineStart: 0, lineEnd: 2 }], [["PRE", "CODE"]])?.length).toBe(1);
		expect(mapCachedSections([{ type: "table", lineStart: 0, lineEnd: 2 }], [["DIV", "TABLE"]])?.length).toBe(1);
		expect(mapCachedSections([{ type: "thematicBreak", lineStart: 0, lineEnd: 0 }], [["HR", null]])?.length).toBe(1);
	});

	it("text not yet read: no lines, so the strokes keep their page positions", () => {
		const els = [{ top: 0 }, { top: 60 }];
		const linesOf = (b: { top: number }, lineStart: number, lineEnd: number) => block(lineStart, lineEnd, b.top, 24);
		const tags = () => ["DIV", "P"] as const;
		const sections = [{ type: "paragraph", lineStart: 3, lineEnd: 3 }, { type: "paragraph", lineStart: 6, lineEnd: 6 }];
		expect(spansFromCache(null, els, tags, linesOf)).toBeNull();
		const s = anchored(7);
		expect(shownStrokes([s], spansFromCache(null, els, tags, linesOf))[0]).toBe(s);
		const read = spansFromCache({ sections, text: TEXT }, els, tags, linesOf);
		expect(read?.skip).toEqual([{ from: 0, to: 2 }]);
		expect(embedInkDy(s, read)).toBe(-12);
	});
});

describe("text as lines", () => {
	it("split at line feeds, a carriage return before one dropped", () => {
		expect(splitLines("a\r\nb\n\nc")).toEqual(["a", "b", "", "c"]);
	});
});

describe("anchors are honoured as the editor honours them: under one signature", () => {
	// The editor moves a stroke by its anchor only while the editor's width and font are the anchor's (LineAnchor.ts
	// underSignature). An anchor taken under another width holds that width's wrap: the editor leaves the stroke where it
	// was drawn, so this view does too. Alan's Untitled 1: 918 strokes anchored under eleven older widths jumped up to
	// 694 px into Reading view while the editor left them in place.
	const LIVE = { width: 668, fontPx: 16, charWidth: 8.8 };

	it("with an editor open on the note, an anchor under its signature moves and one under another width does not", () => {
		expect(embedInkDy(anchored(7), SPANS, 1, LIVE)).toBe(-12);
		expect(embedInkDy(anchored(7, 4, { width: 420 }), SPANS, 1, LIVE)).toBe(0);
		expect(embedInkDy(anchored(7, 4, { fontPx: 14 }), SPANS, 1, LIVE)).toBe(0);
	});

	it("a width within one character of the editor's is the editor's own layout", () => {
		expect(embedInkDy(anchored(7, 4, { width: 668 + 9 }), SPANS, 1, LIVE)).toBe(-12);
		expect(embedInkDy(anchored(7, 4, { width: 668 + 10 }), SPANS, 1, LIVE)).toBe(0);
	});

	it("with no editor open, the newest anchored stroke's width and font are the signature", () => {
		const old = { ...anchored(7, 4, { width: 420 }), createdAt: 1 };
		const newest = { ...anchored(10), createdAt: 2 };
		const out = shownStrokes([old, newest], SPANS, 1, null);
		expect(out[0]).toBe(old);
		expect(out[1]!.bbox.y).toBe(newest.bbox.y + (120 - editorTop(10)));
		// The other way round, the old width is the newest: now the 668 stroke stays.
		const flipped = shownStrokes([{ ...old, createdAt: 3 }, newest], SPANS, 1, null);
		expect(flipped[0]!.bbox.y).toBe(old.bbox.y - 12);
		expect(flipped[1]).toBe(newest);
	});

	it("an open editor's signature beats the newest stroke's", () => {
		const old = { ...anchored(7), createdAt: 1 };
		const newest = { ...anchored(10, 4, { width: 420 }), createdAt: 2 };
		const out = shownStrokes([old, newest], SPANS, 1, LIVE);
		expect(out[0]!.bbox.y).toBe(old.bbox.y - 12);
		expect(out[1]).toBe(newest);
	});

	it("an anchor on a frontmatter line takes no correction", () => {
		// Line 1 is the opening fence. Read as a blank line it rode the first paragraph's top less two lines.
		const s = anchored(1, 4, { top: 0 });
		expect(embedInkDy(s, SPANS, 1, LIVE)).toBe(0);
		expect(shownStrokes([s], SPANS, 1, LIVE)[0]).toBe(s);
	});
});
