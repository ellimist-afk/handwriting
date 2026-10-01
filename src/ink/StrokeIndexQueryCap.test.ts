/**
 * A query rect far larger than the ink does not walk every cell it spans.
 *
 * The cell walk costs the AREA of the rect in buckets. A damage rect around
 * one far-flung stroke (a hand-edited or damaged sidecar) spans millions of
 * empty cells, and the note froze while erasing or dragging near it. A rect
 * with more cells than the index has buckets walks the buckets instead; the
 * answer must be the one the cell walk gives.
 */
import { describe, expect, it } from "vitest";
import { StrokeIndex } from "./StrokeIndex";
import { BBox, InkStroke } from "./Stroke";

function stroke(id: string, x: number, y: number, w = 20, h = 8): InkStroke {
	return {
		id, tool: "pen", color: "#000000", width: 2,
		points: [{ x, y, pressure: 0.5, t: 0 }, { x: x + w, y: y + h, pressure: 0.5, t: 8 }],
		bbox: { x, y, width: w, height: h }, createdAt: 0,
	};
}

function brute(strokes: readonly InkStroke[], r: BBox): string[] {
	return strokes.filter((s) =>
		!(s.bbox.x > r.x + r.width || s.bbox.y > r.y + r.height || s.bbox.x + s.bbox.width < r.x || s.bbox.y + s.bbox.height < r.y)
	).map((s) => s.id);
}

/** Counts the bucket map lookups a query makes. */
function counted(index: StrokeIndex): { gets: number } {
	const buckets = (index as unknown as { buckets: Map<string, InkStroke[]> }).buckets;
	const tally = { gets: 0 };
	const get = buckets.get.bind(buckets);
	buckets.get = (key: string) => { tally.gets++; return get(key); };
	return tally;
}

describe("StrokeIndex.query on a rect far larger than the ink", () => {
	const strokes = [stroke("a", 10, 10), stroke("b", 600, 300), stroke("c", 90_000, 90_000)];

	it("a rect spanning ~2.4 million cells looks up no cell by key and answers as the cell walk would", () => {
		const index = new StrokeIndex();
		index.rebuild(strokes);
		const tally = counted(index);
		const far: BBox = { x: -200_000, y: -200_000, width: 400_000, height: 400_000 };
		const got = index.query(far).map((s) => s.id);
		expect(got).toEqual(brute(strokes, far));
		expect(tally.gets, "cell lookups for a rect larger than the ink").toBe(0);
	});

	it("an ordinary rect on a full page still walks its cells, with the same answer", () => {
		const page: InkStroke[] = [];
		for (let i = 0; i < 400; i++) page.push(stroke(`p${i}`, (i % 20) * 60, Math.floor(i / 20) * 40));
		const index = new StrokeIndex();
		index.rebuild(page);
		const tally = counted(index);
		const near: BBox = { x: 100, y: 100, width: 300, height: 200 };
		expect(index.query(near).map((s) => s.id)).toEqual(brute(page, near));
		expect(tally.gets, "a rect smaller than the ink uses the cell walk").toBeGreaterThan(0);
	});

	it("random rects answer as brute force, in z-order, on either walk", () => {
		let seed = 7;
		const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
		const many: InkStroke[] = [];
		for (let i = 0; i < 300; i++) many.push(stroke(`s${i}`, rnd() * 5000, rnd() * 20000, 5 + rnd() * 400, 5 + rnd() * 60));
		many.push(stroke("huge", -1e6, -1e6, 2e6, 2e6));
		const index = new StrokeIndex();
		index.rebuild(many);
		for (let k = 0; k < 200; k++) {
			const size = k % 2 ? 50 + rnd() * 3000 : 1e5 + rnd() * 1e6;
			const r: BBox = { x: rnd() * 6000 - size / 2, y: rnd() * 22000 - size / 2, width: size, height: size };
			expect(index.query(r).map((s) => s.id)).toEqual(brute(many, r));
		}
	});
});
