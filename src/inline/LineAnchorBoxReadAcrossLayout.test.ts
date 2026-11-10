/**
 * A first box read taken in one layout is not applied against the height map of the next. New ink taken under the map
 * before its line's box is read moves to that box at the first read. When the box arrives in Visible and agrees with the
 * map, and the view then switches to Source (the frontmatter takes height), the Visible box must not move the anchor by the
 * frontmatter height against the Source map. A first box that disagrees moves the anchor at once, in the box read's own
 * update, and the stroke stays where it is shown.
 */
import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { computeBBox, type InkStroke } from "../ink/Stroke";

const PATH = "box-read-across-layout.md";
const PX_PER_WORLD = 0.11151960784313726;
const W = 25.5;
const PITCH = W * PX_PER_WORLD;
const FM = 3; // frontmatter lines 1-3, body from line 4
const FM_WORLD = FM * W; // the frontmatter height in Source, world units

const doc = Text.of(["---", "id: abc", "---", ...Array.from({ length: 27 }, (_, i) => `body ${i + 1} words`)]);
type View = "visible" | "source";
let view: View = "visible";
const layoutOf = (v: View): LineLayout => ({
	lines: doc.lines,
	lineText: (n) => doc.line(n).text,
	// Visible: the frontmatter takes no height, every line above the body sits at the body's top. Source: every line a pitch.
	lineTop: (n) => (v === "source" ? (n - 1) * PITCH : Math.max(0, n - 1 - FM) * PITCH),
	pxPerWorld: PX_PER_WORLD,
	bodyFrom: FM + 1,
});
const layouts = { visible: layoutOf("visible"), source: layoutOf("source") };

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

/** Box tops (world) of lines in a view: line 7 painted `gap7` px below the view's height map, every other line on it. */
function tops(v: View, lines: number[], gap7: number): Map<number, number> {
	return new Map(lines.map((n) => [n, (layouts[v].lineTop(n) + (n === 7 ? gap7 : 0)) / PX_PER_WORLD]));
}

const round = (x: number): number => Math.round(x * 1000) / 1000;

/** Line 4 inked and its box read on the map; new ink on line 7 with no box read yet, then line 7's first box read in Visible. */
function setUp(gap7: number): { a: LineAnchors; s4: InkStroke; s7: InkStroke; all: InkStroke[]; top7: number } {
	view = "visible";
	const a = new LineAnchors(() => layouts[view]);
	a.setSignature({ width: 892, fontPx: 19, charWidth: 10 });
	const s4 = strokeAt("s4", 10, 2);
	a.anchorNew(PATH, s4);
	a.tracks(PATH, [s4]);
	a.drawn(1, doc.lines);
	expect(s4.lineAnchor?.line, "premise: s4 anchors on line 4").toBe(4);
	expect(a.dyOf(s4), "premise: s4 reads no correction").toBe(0);
	expect(a.boxesRead(PATH, [s4], tops("visible", [4], gap7), 1), "premise: line 4's box agrees, nothing moves").toBe(false);
	const s7 = strokeAt("s7", 10, 3 * W + 2);
	a.anchorNew(PATH, s7);
	const all = [s4, s7];
	a.tracks(PATH, all);
	expect(s7.lineAnchor?.line, "premise: s7 anchors on line 7").toBe(7);
	expect(a.dyOf(s7), "premise: s7 drawn at its shown place").toBe(0);
	const top7 = s7.lineAnchor!.top;
	a.boxesRead(PATH, all, tops("visible", [7], gap7), 1);
	return { a, s4, s7, all, top7 };
}

/** Switch to Source, read its boxes, switch back to Visible and read its boxes: the values each step shows. */
function acrossViews(a: LineAnchors, s4: InkStroke, s7: InkStroke, all: InkStroke[], gap7: number) {
	const top0 = s7.lineAnchor!.top;
	view = "source";
	a.layoutChanged(PATH, all, "transaction");
	const movedAtSwitch = a.takeBoxTopMoved();
	const topShift = round(s7.lineAnchor!.top - top0);
	a.boxesRead(PATH, all, tops("source", [4, 7], gap7), 2);
	const dySource = round(a.dyOf(s7)), dySource4 = round(a.dyOf(s4));
	view = "visible";
	a.layoutChanged(PATH, all, "transaction");
	a.boxesRead(PATH, all, tops("visible", [4, 7], gap7), 2);
	const dyVisible = round(a.dyOf(s7)), dyVisible4 = round(a.dyOf(s4));
	return { movedAtSwitch, topShift, dySource, dyVisible, dySource4, dyVisible4 };
}

/** The anchor holds across both switches: one frontmatter height down in Source, at its drawn place in Visible. */
const HOLDS = { movedAtSwitch: false, topShift: 0, dySource: FM_WORLD, dyVisible: 0, dySource4: FM_WORLD, dyVisible4: 0 };

describe("a first box read taken in one layout is not applied against the height map of the next", () => {
	it("line 7's box agrees in Visible, then the switch to Source: the new stroke keeps its anchor top", () => {
		// Defect: the first-box move compared the epoch the anchor was taken in with the box read's, both Visible, so at the
		// switch it moved the anchor by the Visible box against the Source map: top one frontmatter height up, the stroke two
		// heights down in Source and one in Visible.
		const { a, s4, s7, all } = setUp(0);
		expect(a.takeBoxTopMoved(), "premise: line 7's agreeing box moves nothing").toBe(false);
		expect(acrossViews(a, s4, s7, all, 0)).toEqual(HOLDS);
		a.detached();
	});

	it("control: a Visible layout update between the box read and the switch, the anchor holds the same way", () => {
		const { a, s4, s7, all } = setUp(0);
		a.layoutChanged(PATH, all, "transaction");
		expect(a.takeBoxTopMoved(), "premise: nothing moves in Visible, where box and map agree").toBe(false);
		expect(acrossViews(a, s4, s7, all, 0)).toEqual(HOLDS);
		a.detached();
	});

	it("line 7's first box 3 px off the map in Visible: the anchor moves at once in that read's update, the stroke stays", () => {
		const gap = 3;
		const { a, s4, s7, all, top7 } = setUp(gap);
		expect(a.takeBoxTopMoved(), "the anchor top moved at its line's first box read").toBe(true);
		expect(round(s7.lineAnchor!.top - top7), "moved by the box's offset from the map").toBe(round(gap / PX_PER_WORLD));
		expect(a.dyOf(s7), "the stroke stays where it is shown").toBe(0);
		expect(acrossViews(a, s4, s7, all, gap)).toEqual(HOLDS);
		a.detached();
	});
});
