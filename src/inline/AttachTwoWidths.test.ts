/**
 * Two panes of different widths on one note with attached ink: each pane reads its own
 * target point and shows the members at stored plus the difference to the record's point, so both show the group at
 * the same place against its words, before and after typing above, with no page write between and no stored point
 * moved. A bare LineAnchors per pane and the shared store: no DOM, no layout read.
 */
import { describe, expect, it } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { inlineInk } from "./InkOverlayRegistry";
import { emptyPage } from "../model/PageData";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { targetAt, type AttachmentRecord } from "./InkAttachments";

const doc = Text.of(Array.from({ length: 30 }, (_, i) => `line ${i + 1} words`));
const DOC = doc.toString();
const word = "line 3 words";
const TYPED = "new line\n";

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

function record(): AttachmentRecord {
	const from = DOC.indexOf(word);
	return { v: 1, id: "att-1", strokeIds: ["s1", "s2"], target: targetAt(DOC, from, from + word.length, "range"), ref: { x: 0, y: 80 }, layout: { width: 892, font: 26 }, probe: { id: "s1", x: 10, y: 89 } };
}

/**
 * A pane: `word` is where its target line's top-left reads, `typedPx` how far the typed line pushes it down (the narrow
 * pane wraps the typed line). Mixed x and y (trap 1).
 */
function pane(path: string, width: number, word: { x: number; y: number }, typedPx: number) {
	const at = { ...word };
	const layout = (): LineLayout => ({ lines: doc.lines, lineText: (n) => doc.line(n).text, lineTop: (n) => (n - 1) * 40, pxPerWorld: 1 });
	const anchors = new LineAnchors(layout);
	anchors.setSignature({ width, fontPx: 26, charWidth: 14 });
	anchors.drawn(1, doc.lines);
	anchors.strokesFor(path, inlineInk.strokes(path));
	anchors.follow.setList(inlineInk.attachments(path));
	anchors.follow.measure({ inView: () => true, refAt: () => ({ ...at }), blockTop: () => at.y });
	const type = (changes: ChangeSet) => {
		at.y += typedPx;
		anchors.follow.docChanged(changes, () => at.y, 1);
	};
	/** Each member's first shown point less the pane's word point. */
	const againstWords = () => anchors.strokesFor(path, inlineInk.strokes(path)).filter((s) => s.id !== "free").map((s) => ({ id: s.id, x: s.points[0]!.x - at.x, y: s.points[0]!.y - at.y }));
	return { anchors, type, againstWords, at };
}

function rig(path: string) {
	const rec = inlineInk.record(path);
	rec.pageId = `page-${path}`;
	rec.basePage = { ...emptyPage(rec.pageId), attachments: [record()] };
	rec.strokes = [strokeAt("s1", 10, 85), strokeAt("s2", 40, 90), strokeAt("free", 10, 205)];
	const writes: number[] = [];
	Object.defineProperty(inlineInk, "persist", { value: () => writes.push(1), configurable: true });
	const wide = pane(path, 892, { x: 0, y: 80 }, 40);
	const narrow = pane(path, 500, { x: 14, y: 200 }, 80);
	const stored = () => inlineInk.strokes(path).map((s) => s.points.map((p) => [p.x, p.y]));
	return { wide, narrow, writes, stored };
}

const close = (got: { id: string; x: number; y: number }[], want: { id: string; x: number; y: number }[]) => {
	expect(got.map((s) => s.id)).toEqual(want.map((s) => s.id));
	got.forEach((s, i) => {
		expect(s.x, s.id).toBeCloseTo(want[i]!.x, 9);
		expect(s.y, s.id).toBeCloseTo(want[i]!.y, 9);
	});
};

describe("attached ink on two panes of different widths", () => {
	it("both panes show the group at the same place against its words, with no write", () => {
		// Defect: a pane shows the members at their stored points (the narrow pane 120 above its words), or a pane's
		// read is spent by the other pane's width.
		const { wide, narrow, writes, stored } = rig("attach-two-widths.md");
		const before = stored();
		const want = [{ id: "s1", x: 10, y: 9 }, { id: "s2", x: 40, y: 14 }];
		close(wide.againstWords(), want);
		close(narrow.againstWords(), want);
		expect(narrow.anchors.strokesFor("attach-two-widths.md", inlineInk.strokes("attach-two-widths.md"))[0]!.points[0]!.x, "narrow pane moved right").toBeCloseTo(24, 9);
		expect(writes).toEqual([]);
		expect(stored()).toEqual(before);
	});

	it("after typing above, each pane by its own height, both still agree against the words, with no write", () => {
		// Defect: the group follows the wide pane's 40 on the narrow pane (40 above its words there), or the typing
		// writes the page to settle the points.
		const { wide, narrow, writes, stored } = rig("attach-two-widths-typed.md");
		const before = stored();
		const changes = ChangeSet.of({ from: 0, insert: TYPED }, doc.length);
		wide.type(changes);
		narrow.type(changes);
		expect(narrow.at.y - wide.at.y, "the panes' words moved by different amounts").toBe(200 + 80 - (80 + 40));
		const want = [{ id: "s1", x: 10, y: 9 }, { id: "s2", x: 40, y: 14 }];
		close(wide.againstWords(), want);
		close(narrow.againstWords(), want);
		expect(writes).toEqual([]);
		expect(stored()).toEqual(before);
	});
});
