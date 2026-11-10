/**
 * A drawn line's top read from its line box (LineAnchors.boxesRead) answers only when it disagrees with the height map by more
 * than a sixty-fourth of a px, the layout quantum. The box is read at the rendered scale, the quotient CodeMirror measures its
 * own scale by, so at a resting zoom the two readers agree to float noise at every line, however far down: that noise must move
 * no ink, or the first box read after a zoom settle repaints the whole note by path. A gap past the bar, as the 3 px a 60.4
 * percent rest leaves under CodeMirror's 0.005 scale threshold, is the line where the text is painted, and the ink follows it.
 */
import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { computeBBox, type InkStroke } from "../ink/Stroke";

const PATH = "box.md";
// The stand-in rig at its 10 percent rest: CodeMirror's scale times the font zoom, and its line pitch in editor px.
const PX_PER_WORLD = 0.11151960784313726;
const PITCH = 25.5 * PX_PER_WORLD;

const doc = Text.of(Array.from({ length: 30 }, (_, i) => `line ${i + 1} words`));
const layout: LineLayout = { lines: doc.lines, lineText: (n) => doc.line(n).text, lineTop: (n) => (n - 1) * PITCH, pxPerWorld: PX_PER_WORLD };

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

/** A surface with one stroke anchored on each of `lines`, all drawn and reading no correction. */
function surface(lines: number[]): { a: LineAnchors; src: InkStroke[] } {
	const a = new LineAnchors(() => layout);
	a.setSignature({ width: 892, fontPx: 19, charWidth: 10 });
	const src = lines.map((n) => strokeAt(`s${n}`, 10, (n - 1) * 25.5 + 2));
	for (const s of src) a.anchorNew(PATH, s);
	a.tracks(PATH, src);
	a.drawn(1, doc.lines);
	for (const s of src) expect(s.lineAnchor?.line, `premise: ${s.id} anchors on its line`).toBe(Number(s.id.slice(1)));
	for (const s of src) expect(a.dyOf(s), `premise: ${s.id} reads no correction`).toBe(0);
	return { a, src };
}

/** Box tops in world units: each line's height-map top plus `gapPx(n)` editor px. */
function boxTops(lines: number[], gapPx: (n: number) => number): Map<number, number> {
	return new Map(lines.map((n) => [n, (layout.lineTop(n) + gapPx(n)) / PX_PER_WORLD]));
}

describe("a line box read moves ink only past a sixty-fourth of a px", () => {
	it("float noise at every line of a thirty-line note moves nothing and repaints nothing", () => {
		const lines = Array.from({ length: 30 }, (_, i) => i + 1);
		const { a, src } = surface(lines);
		const moved = a.boxesRead(PATH, src, boxTops(lines, (n) => (n % 2 ? 1 : -1) * 1e-6 * n), 32);
		expect(moved, "no shown correction changed").toBe(false);
		for (const s of src) expect(a.dyOf(s), `${s.id} still reads no correction`).toBe(0);
		expect(a.strokesFor(PATH, src), "the store's own list").toBe(src);
		a.detached();
	});

	it("a gap just under the bar moves nothing; one just over it moves its line's ink by the gap", () => {
		const { a, src } = surface([3, 9]);
		const moved = a.boxesRead(PATH, src, boxTops([3, 9], (n) => (n === 3 ? 0.015 : 0.017)), 4);
		expect(moved, "line 9 is past the bar").toBe(true);
		expect(a.dyOf(src[0]!), "line 3 under the bar reads no correction").toBe(0);
		expect(a.dyOf(src[1]!), "line 9 follows its box").toBeCloseTo(0.017 / PX_PER_WORLD, 6);
		a.detached();
	});

	it("the 3 px a sub-threshold rest leaves on a line moves its ink to the box", () => {
		const { a, src } = surface([20]);
		expect(a.boxesRead(PATH, src, boxTops([20], () => -3), 3), "the correction moved").toBe(true);
		expect(a.dyOf(src[0]!) * PX_PER_WORLD).toBeCloseTo(-3, 6);
		a.detached();
	});
});
