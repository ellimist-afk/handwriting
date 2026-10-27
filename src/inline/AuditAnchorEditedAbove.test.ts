/**
 * Ink beside a blank line, and the paragraph above it edited while no surface was watching: on another device, in an
 * older build, with inline ink off, or in another editor. The note is reopened here.
 *
 * The anchor checks only its own line's text. A blank line hashes the same before and after, so the stroke is shown
 * moved down by the rows the edited paragraph gained. With a surface mounted, the same typing moves no ink.
 */
import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { emptyPage, parsePage, serializePage } from "../model/PageData";
import { embedInkDy, type BlockLines, type LineSpans } from "./EmbedInkLines";

const PATH = "edited-above.md";
const ROW = 40;

function layoutOf(doc: Text, heights: number[]): LineLayout {
	const tops = [0];
	for (const h of heights) tops.push(tops.at(-1)! + h);
	return { lines: doc.lines, lineText: (n) => doc.line(n).text, lineTop: (n) => tops[n - 1]!, pxPerWorld: 1 };
}

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

function surface(doc: Text, heights: number[]): LineAnchors {
	const layout = layoutOf(doc, heights);
	const a = new LineAnchors(() => layout);
	a.setSignature({ width: 892, fontPx: 26, charWidth: 14 });
	return a;
}

function reload(strokes: InkStroke[]): InkStroke[] {
	const page = emptyPage("edited-above");
	page.strokes = strokes;
	return parsePage(serializePage(page), "edited-above").data.strokes;
}

// Line 7 is a one-row paragraph; line 8 is blank, where the ink sits.
const lines = Array.from({ length: 20 }, (_, i) => (i === 7 ? "" : `line ${i + 1} words`));
const before = Text.of(lines);
const beforeHeights = lines.map(() => ROW);

// The same note after the paragraph on line 7 was lengthened elsewhere: no line added, it now wraps to three rows.
const afterLines = lines.map((l, i) => (i === 6 ? `${l} ${"and a great deal more text ".repeat(6)}` : l));
const after = Text.of(afterLines);
const afterHeights = afterLines.map((_, i) => (i === 6 ? ROW * 3 : ROW));

describe("ink beside a blank line, the paragraph above edited while unseen", () => {
	it("stays where it was drawn when the note is reopened", () => {
		const first = surface(before, beforeHeights);
		const s = strokeAt("s", 10, ROW * 7 + 3);
		first.anchorNew(PATH, s);
		first.tracks(PATH, [s]);
		expect(first.dyOf(s)).toBe(0);
		expect(s.lineAnchor?.line).toBe(8);
		first.detached();

		const [back] = reload([s]);
		const reopened = surface(after, afterHeights);
		reopened.tracks(PATH, [back!]);
		reopened.drawn(1, after.lines);
		// Ink never follows text: the stroke shows at its stored position.
		expect(reopened.dyOf(back!), "correction after an unseen edit above").toBe(0);
		reopened.detached();
	});

	it("stays where it was drawn in Reading view and export", () => {
		const first = surface(before, beforeHeights);
		const s = strokeAt("s", 10, ROW * 7 + 3);
		first.anchorNew(PATH, s);
		first.tracks(PATH, [s]);
		first.detached();
		const [back] = reload([s]);
		// The rendered view: one block per line of text, at the editor's tops after the edit; line 8 stays blank.
		const tops = [0];
		for (const h of afterHeights) tops.push(tops.at(-1)! + h);
		const blocks: BlockLines[] = afterLines.flatMap((l, i) =>
			l === "" ? [] : [{ lineStart: i, lineEnd: i, box: () => ({ top: tops[i]!, height: afterHeights[i]! }), lineHeight: () => ROW }]
		);
		const spans: LineSpans = { lines: afterLines, blocks, skip: [] };
		expect(embedInkDy(back!, spans), "Reading view correction after an unseen edit above").toBe(0);
	});
});
