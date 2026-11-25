/**
 * Read-only views (Reading view, embeds, hover previews, print) honour a line anchor taken at another text size by the same
 * law as the editor: an anchor counts where its width over its font is the layout's width over the layout's font, within one
 * character. A note edited on two devices at two text sizes holds anchors at both sizes under one held column (805 at 16 and
 * 906 at 18): each stroke keeps its correction in these views, whichever stroke is newest, and under an open editor at
 * either size. An anchor a device saved before the column followed the text size (805 at 18) is off the law and is not
 * honoured, as in the editor; one at the layout's own size and width is honoured exactly as before.
 *
 * The note and the rendered blocks are EmbedInkLines.test.ts's: three paragraphs a reading view lays out with margins in
 * place of their blank lines, so every anchored line's top differs from the editor's and each correction is not 0.
 */
import { describe, expect, it } from "vitest";
import type { InkStroke, LineAnchor } from "../ink/Stroke";
import { shownStrokes, splitLines, type BlockLines, type LineSpans } from "./EmbedInkLines";
import { aboveOf, lineKey, newAboveRun, type LineSignature } from "./LineAnchor";

const TEXT = ["This is the first paragraph.", "", "", "This is second, the middle one.", "", "", "A third paragraph, the last one."].join("\n");
const LINES = splitLines(TEXT);
const LINE = 24;
const aboveIn = (n: number) => aboveOf(newAboveRun(), n, (k) => lineKey(LINES[k - 1]!));
/** The editor's top of 1-based line n, world units: every editor line is 24. */
const editorTop = (n: number) => (n - 1) * LINE;
const block = (lineStart: number, top: number): BlockLines => ({ lineStart, lineEnd: lineStart, box: () => ({ top, height: 24 }), lineHeight: () => LINE });
/** The reading view: margins in place of the blank lines, so line 4 sits at 40 (editor 72) and line 7 at 80 (editor 144). */
const SPANS: LineSpans = { lines: LINES, blocks: [block(0, 0), block(3, 40), block(6, 80)], skip: [] };

let serial = 0;
function anchored(line: number, width: number, fontPx: number, createdAt: number): InkStroke {
	const y = editorTop(line) + 4;
	const a: LineAnchor = { line, top: editorTop(line), y, key: lineKey(LINES[line - 1]!), width, fontPx, above: aboveIn(line) };
	return {
		id: `f${serial++}`, tool: "pen", color: "#000000", width: 2, createdAt,
		points: [{ x: 10, y: y + 2, pressure: 0.5, t: 0 }, { x: 40, y: y + 2, pressure: 0.5, t: 9 }],
		bbox: { x: 8, y, width: 34, height: 4 }, lineAnchor: a,
	} as InkStroke;
}
/** The vertical move each stroke is shown with: its shown copy's bbox top less its own. */
const moves = (strokes: InkStroke[], live: LineSignature | null = null): number[] =>
	shownStrokes(strokes, SPANS, 1, live).map((s, i) => s.bbox.y - strokes[i]!.bbox.y);

describe("anchors at two text sizes under one held column", () => {
	// Line 4 drawn at 16 (column 805), line 7 drawn at 18 (column 805 x 18/16 = 905.6, an integer width 906).
	const at16 = () => anchored(4, 805, 16, 1), at18 = () => anchored(7, 906, 18, 2);

	it("with no editor open, the newest stroke at 18: the stroke at 16 keeps its correction too", () => {
		expect(moves([at16(), at18()])).toEqual([40 - 72, 80 - 144]);
	});

	it("with no editor open, the newest stroke at 16: the stroke at 18 keeps its correction too", () => {
		expect(moves([anchored(7, 906, 18, 1), anchored(4, 805, 16, 2)])).toEqual([80 - 144, 40 - 72]);
	});

	it("under an open editor at 18 (906 wide, 9.6 px characters): both corrections", () => {
		expect(moves([at16(), at18()], { width: 906, fontPx: 18, charWidth: 9.6 })).toEqual([40 - 72, 80 - 144]);
	});

	it("under an open editor at 16 (805 wide, 8.5 px characters): both corrections", () => {
		expect(moves([at16(), at18()], { width: 805, fontPx: 16, charWidth: 8.5 })).toEqual([40 - 72, 80 - 144]);
	});

	it("at a fractional size (18.4 px, 925.75 held as 926): the stroke at 16 keeps its correction", () => {
		expect(moves([at16(), anchored(7, 926, 18.4, 2)])).toEqual([40 - 72, 80 - 144]);
	});
});

describe("pins: as before", () => {
	it("an anchor a device saved before the column followed the text size (805 at 18) is not honoured beside one at 805/16", () => {
		expect(moves([anchored(4, 805, 16, 2), anchored(7, 805, 18, 1)])).toEqual([40 - 72, 0]);
	});

	it("one size, one width: both honoured, exactly as before", () => {
		expect(moves([anchored(4, 805, 16, 1), anchored(7, 805, 16, 2)])).toEqual([40 - 72, 80 - 144]);
	});

	it("one size, another width (a narrower pane's re-take, 668 at 16) is not honoured under 805 at 16", () => {
		expect(moves([anchored(4, 668, 16, 1), anchored(7, 805, 16, 2)])).toEqual([0, 80 - 144]);
	});
});
