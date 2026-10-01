import { describe, expect, it } from "vitest";
import {
	blankLinesAbove,
	boundsOf,
	lineSteps,
	rowsOf as legacyRowsOf,
	snapLine,
	strokeIdsBelow as idsBelow,
	sweptRect,
	InsertSpaceRows,
	nearestSpaceBoundary,
	canSplitParagraph,
	spaceProtectedBlocks,
} from "./InsertSpace";
import { InkPoint, InkStroke, computeBBox } from "../ink/Stroke";
import { translateStroke } from "../objects/Selection";

// Exercise the ordinary-note policy through the actual production cache.
// PDF callers retain legacyRowsOf and the default membership argument.
const rowsOf=(strokes:readonly InkStroke[])=>new InsertSpaceRows().get(strokes);
const strokeIdsBelow=(strokes:readonly InkStroke[],y:number,rows=rowsOf(strokes))=>idsBelow(strokes,y,rows);

describe("shared space boundary",()=>{
 const at=(y:number,direction:-1|1)=>({y:(direction<0?Math.floor(y/24):Math.ceil(y/24))*24,from:0,lineHeight:24});
 it("chooses the closest text wrap without consulting ink",()=>{
  expect(nearestSpaceBoundary(104,at)?.y).toBe(96);
  expect(nearestSpaceBoundary(80,at)?.y).toBe(72);
 });
 it("keeps a nearby seam even where a tall drawing could cross it",()=>{
  expect(nearestSpaceBoundary(100,at)?.y).toBe(96);
 });
 it("keeps a seam in a clear gap and resolves ties toward the lower seam",()=>{
  expect(nearestSpaceBoundary(96,at)?.y).toBe(96);
  expect(nearestSpaceBoundary(108,at)?.y).toBe(120);
 });
 it("does not fabricate a text position outside measured geometry",()=>{
  expect(nearestSpaceBoundary(40,()=>null)).toBeNull();
 });
 it("invalidates cached rows on real in-place movement, replacement and removal",()=>{
  const cache=new InsertSpaceRows(),s=letter("a",0,100);
  const first=cache.get([s]);expect(cache.get([s])).toBe(first);
  translateStroke(s,0,24);expect(cache.get([s])[0]!.top).toBe(116);
  expect(cache.get([letter("a",0,200)])[0]!.top).toBe(192);
  expect(cache.get([])).toEqual([]);
 });
});

describe("paragraph break safety",()=>{
 it.each(["---","==="])("keeps all lines of a Setext heading with its %s underline",underline=>{
  const lines=["First heading words","next heading words",underline,"","paragraph"];
  expect(spaceProtectedBlocks(n=>lines[n-1]!,lines.length)).toEqual([{from:1,to:3}]);
 });
 it("keeps leading YAML and fenced bodies out of paragraph splitting",()=>{
  const lines=["---","title: ordinary words","---","","~~~~","ordinary words","~~~","~~~~","paragraph"];
  expect(spaceProtectedBlocks(n=>lines[n-1]!,lines.length)).toEqual([{from:1,to:3,frontmatter:true},{from:5,to:8,frontmatter:undefined}]);
 });
 it("does not treat a separated thematic rule as a Setext underline",()=>{
  const lines=["paragraph","","---"];
  expect(spaceProtectedBlocks(n=>lines[n-1]!,lines.length)).toEqual([]);
 });
 it("protects an unclosed fence through the document end",()=>{
  const lines=["paragraph","```text","ordinary words"];
  expect(spaceProtectedBlocks(n=>lines[n-1]!,lines.length)).toEqual([{from:2,to:3,frontmatter:undefined}]);
 });
 it("permits a break between words without rewriting either side",()=>{
  expect(canSplitParagraph("first words next words",12)).toBe(true);
 });
 it.each(["**first words next words**","[first words next words](url)","`first words next words`","> first words next words","- first words next words","# first words next words","    first words next words"])("keeps structured Markdown intact: %s",text=>{
  expect(canSplitParagraph(text,text.indexOf("next"))).toBe(false);
 });
 it("never inserts a paragraph break in the middle of a word",()=>{
  expect(canSplitParagraph("aVeryLongWordWithoutSpaces",10)).toBe(false);
 });
});

function pt(x: number, y: number): InkPoint {
	return { x, y, pressure: 0.5, t: 0 };
}

function stroke(id: string, points: InkPoint[]): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#000",
		width: 2,
		points,
		bbox: computeBBox(points, 0),
		createdAt: 0,
	};
}

/** A letter body sitting on a writing line, no ascender. */
function letter(id: string, x: number, lineY: number): InkStroke {
	return stroke(id, [pt(x, lineY - 8), pt(x + 2, lineY), pt(x + 6, lineY - 4)]);
}

describe("rowsOf", () => {
	it("groups a line of writing into one row", () => {
		const row = [letter("a", 0, 100), letter("b", 10, 100), letter("c", 20, 100)];
		const rows = rowsOf(row);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.ids.sort()).toEqual(["a", "b", "c"]);
	});

	it("keeps a dotted i whole: the dot joins its stem's row", () => {
		// The reported bug. The dot sits well above the stem's centre, so
		// any per-stroke rule can put the two on opposite sides of a line.
		const stem = stroke("i-stem", [pt(30, 88), pt(30, 100)]);
		const dot = stroke("i-dot", [pt(30, 81), pt(31, 82)]);
		const neighbour = letter("n", 0, 100);
		const rows = rowsOf([stem, dot, neighbour]);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.ids).toContain("i-dot");
		expect(rows[0]!.ids).toContain("i-stem");
	});

	it("separates two rows written tight against each other", () => {
		const rows = rowsOf([letter("up", 0, 100), letter("down", 0, 130)]);
		expect(rows).toHaveLength(2);
		expect(rows[0]!.ids).toEqual(["up"]);
		expect(rows[1]!.ids).toEqual(["down"]);
	});
	it("keeps nearby overlapping ascenders connected despite an interleaved distant stroke",()=>{
		const page=[letter("a",0,100),stroke("far",[pt(600,90),pt(630,110)]),stroke("ascender",[pt(10,70),pt(12,100)]),letter("b",20,100)];
		const groups=rowsOf(page);
		expect(groups).toHaveLength(2);
		expect(groups.find(r=>r.ids.includes("a"))!.ids.sort()).toEqual(["a","ascender","b"]);
	});
	it.each([.1,1,4])("attaches dot and crossbar locally across interleaved columns at scale %s",scale=>{
		const raw=[stroke("stem",[pt(30,88),pt(30,100)]),stroke("dot",[pt(30,81),pt(31,82)]),
			stroke("far",[pt(600,84),pt(640,95)]),stroke("t",[pt(60,85),pt(60,105)]),stroke("crossbar",[pt(55,89),pt(65,89)])];
		const page=raw.map(s=>stroke(s.id,s.points.map(p=>({...p,x:7+p.x*scale,y:9+p.y*scale}))));
		const groups=rowsOf(page);
		expect(groups.find(r=>r.ids.includes("stem"))!.ids).toContain("dot");
		expect(groups.find(r=>r.ids.includes("t"))!.ids).toContain("crossbar");
		expect(groups.find(r=>r.ids.includes("far"))!.ids).toEqual(["far"]);
	});
	it("attaches a dot to an isolated narrow stem without consuming a stacked stem",()=>{
		const page=[stroke("stem",[pt(30,88),pt(30,100)]),stroke("dot",[pt(30,81),pt(31,82)]),stroke("next-stem",[pt(30,110),pt(30,122)])];
		const groups=rowsOf(page);
		expect(groups).toHaveLength(2);
		expect(groups.find(r=>r.ids.includes("stem"))!.ids).toContain("dot");
		expect(groups.find(r=>r.ids.includes("next-stem"))!.ids).toEqual(["next-stem"]);
	});
});

describe("snapLine", () => {
	const rows = rowsOf([letter("up", 0, 100), letter("down", 0, 200)]);

	it("leaves a line drawn in the gap alone", () => {
		expect(snapLine(rows, 150)).toBe(150);
	});

	it("pushes a line drawn through a row out to its nearer edge", () => {
		// Row "down" spans 192..200; a line at 199 is nearest its bottom.
		expect(snapLine(rows, 199)).toBe(200);
		// ...and one at 193 is nearest its top.
		expect(snapLine(rows, 193)).toBe(192);
	});
	it("chooses the nearest edge independently of overlapping local-group order",()=>{
		const groups=[{top:110,bottom:150,ids:["left"]},{top:125,bottom:160,ids:["right"]}];
		expect(snapLine(groups,130)).toBe(125);expect(snapLine([...groups].reverse(),130)).toBe(125);
	});
});

describe("strokeIdsBelow (insert-space membership)", () => {
	it("retains the existing PDF grouping and globally snapped guide contract",()=>{
		const page=localColumns(),groups=legacyRowsOf(page);
		expect(groups).toEqual([{top:60,bottom:170,ids:["left-upper","right-upper","left-crossing","right-lower"]}]);
		expect(idsBelow(page,snapLine(groups,130))).toEqual([]);
	});
	it("moves a lower word independently of the distant crossing group", () => {
		const page=localColumns();
		expect(strokeIdsBelow(page,130)).toEqual(["right-lower"]);
	});
	it("classifies each local group at the original guide, never another group's edge",()=>{
		const page=localColumns();
		// Isolate the second trap from group formation: a global cut would
		// snap 130 to the left group's 150 and incorrectly exclude right 140.
		const groups=page.map(s=>({top:s.points[0]!.y,bottom:s.points[1]!.y,ids:[s.id]}));
		expect(strokeIdsBelow(page,130,groups)).toEqual(["right-lower"]);
	});
	it.each([.1,1,4])("keeps columns independent under geometry scale %s and translation",scale=>{
		const page=localColumns().map(s=>stroke(s.id,s.points.map(p=>({...p,x:40+p.x*scale,y:80+p.y*scale}))));
		expect(strokeIdsBelow(page,80+130*scale)).toEqual(["right-lower"]);
	});
	it("unrelated left heights and removal do not change the right word",()=>{
		for(const left of [[],[stroke("left",[pt(0,20),pt(200,800)])],[stroke("left",[pt(0,125),pt(200,135)])]]){
			const page=[...left,...localColumns().filter(s=>s.id.startsWith("right"))];
			expect(strokeIdsBelow(page,130).filter(id=>id.startsWith("right"))).toEqual(["right-lower"]);
		}
	});
	it("takes the row below and leaves the row above", () => {
		const strokes = [letter("above", 0, 100), letter("below", 0, 200)];
		expect(strokeIdsBelow(strokes, 150)).toEqual(["below"]);
	});

	it("never splits a letter, wherever the line lands inside a row", () => {
		const stem = stroke("i-stem", [pt(30, 88), pt(30, 100)]);
		const dot = stroke("i-dot", [pt(30, 81), pt(31, 82)]);
		const neighbour = letter("n", 0, 100);
		const below = letter("next", 0, 200);
		const page = [stem, dot, neighbour, below];
		// A line drawn between the dot and the stem would once have taken
		// the stem and left the dot behind. Now they cannot be separated:
		// whichever way the row goes, the two travel together.
		const moved = new Set(strokeIdsBelow(page, 85));
		expect(moved.has("i-dot")).toBe(moved.has("i-stem"));
		expect(moved.has("next")).toBe(true);
	});

	it("keeps a word whole when the line crosses its lower half", () => {
		const word = [letter("P", 0, 100), letter("r", 10, 100), letter("i", 20, 100)];
		const below = letter("next", 0, 200);
		// Through the word: the line snaps out of it, so the word is all on
		// one side. Which side is the snap's business; never being torn in
		// half is the contract.
		const moved = new Set(strokeIdsBelow([...word, below], 98));
		expect(moved.has("P")).toBe(moved.has("r"));
		expect(moved.has("r")).toBe(moved.has("i"));
		expect(moved.has("next")).toBe(true);
	});

	it("empty page yields an empty list", () => {
		expect(strokeIdsBelow([], 50)).toEqual([]);
	});

	it("returns ids in store order", () => {
		const strokes = [letter("b", 0, 200), letter("a", 10, 200), letter("skip", 0, 50)];
		expect(strokeIdsBelow(strokes, 150)).toEqual(["b", "a"]);
	});
});

function localColumns():InkStroke[] {
	return [
		stroke("left-upper",[pt(0,60),pt(200,95)]),
		stroke("right-upper",[pt(600,90),pt(900,115)]),
		stroke("left-crossing",[pt(0,110),pt(200,150)]),
		stroke("right-lower",[pt(600,140),pt(900,170)]),
	];
}

describe("boundsOf", () => {
	it("unions only the named strokes", () => {
		const strokes = [letter("a", 0, 100), letter("b", 0, 200), letter("ignored", 0, 900)];
		const b = boundsOf(strokes, ["a", "b"]);
		expect(b).not.toBeNull();
		expect(b!.y).toBe(92);
		expect(b!.y + b!.height).toBe(200);
	});

	it("is null when nothing is named, so the caller can fall back", () => {
		expect(boundsOf([letter("a", 0, 10)], [])).toBeNull();
		expect(boundsOf([], ["ghost"])).toBeNull();
	});
});

describe("sweptRect", () => {
	const box = { x: 0, y: 100, width: 50, height: 20 };

	it("covers old and new positions when dragging down", () => {
		const r = sweptRect(box, 30);
		expect(r.y).toBe(100);
		expect(r.y + r.height).toBe(150);
	});

	it("covers old and new positions when dragging up", () => {
		const r = sweptRect(box, -30);
		expect(r.y).toBe(70);
		expect(r.y + r.height).toBe(120);
	});

	it("degenerates to the box itself at zero travel", () => {
		expect(sweptRect(box, 0)).toEqual(box);
	});
});

describe("lineSteps", () => {
	it("rounds a drag to the nearest whole line", () => {
		expect(lineSteps(44, 20)).toBe(2);
		expect(lineSteps(29, 20)).toBe(1);
		expect(lineSteps(31, 20)).toBe(2);
	});

	it("is zero for a drag shorter than half a line, so text is left alone", () => {
		expect(lineSteps(9, 20)).toBe(0);
	});

	it("goes negative when the drag closes a gap", () => {
		expect(lineSteps(-42, 20)).toBe(-2);
	});

	it("refuses to divide by a line height it does not have", () => {
		expect(lineSteps(40, 0)).toBe(0);
	});
});

/** The document reader the real caller passes: 1-based line numbers. */
function reader(lines: readonly string[]): (n: number) => string {
	return (n) => lines[n - 1] ?? "";
}

describe("blankLinesAbove", () => {
	const doc = ["alpha", "", "", "beta"];

	it("counts the blank run directly above the line", () => {
		expect(blankLinesAbove(reader(doc), 4, 5)).toBe(2);
	});

	it("never returns more than asked for", () => {
		expect(blankLinesAbove(reader(doc), 4, 1)).toBe(1);
	});

	it("stops at the first line with writing on it", () => {
		expect(blankLinesAbove(reader(doc), 2, 5)).toBe(0);
	});

	it("treats whitespace-only lines as blank", () => {
		expect(blankLinesAbove(reader(["alpha", "   ", "beta"]), 3, 5)).toBe(1);
	});

	it("stops at the top of the document", () => {
		expect(blankLinesAbove(reader(["", "", "beta"]), 3, 9)).toBe(2);
	});
});
