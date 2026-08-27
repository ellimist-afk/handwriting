import { describe, expect, it } from "vitest";
import { BUCKET_WORLD, StrokeIndex } from "./StrokeIndex";
import { InkStroke } from "./Stroke";

function stroke(id: string, x: number, y: number, w = 10, h = 10): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#000",
		width: 2,
		points: [{ x, y, pressure: 0.5, t: 0 }],
		bbox: { x, y, width: w, height: h },
		createdAt: 0,
	} as InkStroke;
}

describe("StrokeIndex", () => {
	it("finds strokes intersecting a rect and misses the rest", () => {
		const idx = new StrokeIndex();
		idx.rebuild([stroke("a", 0, 0), stroke("b", 1000, 1000), stroke("c", 40, 40)]);
		const hit = idx.query({ x: 0, y: 0, width: 60, height: 60 });
		expect(hit.map((s) => s.id)).toEqual(["a", "c"]);
	});

	it("a stroke spanning buckets is returned once", () => {
		const idx = new StrokeIndex();
		idx.rebuild([stroke("wide", 10, 10, BUCKET_WORLD * 3, 5)]);
		const hit = idx.query({ x: 0, y: 0, width: BUCKET_WORLD * 4, height: 100 });
		expect(hit.map((s) => s.id)).toEqual(["wide"]);
	});

	it("preserves z-order across buckets", () => {
		const idx = new StrokeIndex();
		const list = [
			stroke("under", BUCKET_WORLD + 5, 5),
			stroke("mid", 5, 5),
			stroke("over", BUCKET_WORLD + 6, 6),
		];
		idx.rebuild(list);
		const hit = idx.query({ x: 0, y: 0, width: BUCKET_WORLD * 2, height: 100 });
		expect(hit.map((s) => s.id)).toEqual(["under", "mid", "over"]);
	});

	it("negative coordinates bucket correctly", () => {
		const idx = new StrokeIndex();
		idx.rebuild([stroke("neg", -300, -300)]);
		expect(idx.query({ x: -320, y: -320, width: 50, height: 50 }).length).toBe(1);
		expect(idx.query({ x: 0, y: 0, width: 50, height: 50 }).length).toBe(0);
	});

	it("bbox test still applies inside a shared bucket", () => {
		const idx = new StrokeIndex();
		idx.rebuild([stroke("far", 5, 5), stroke("near", 200, 200)]);
		// same bucket (both under 256), disjoint rects
		expect(idx.query({ x: 190, y: 190, width: 30, height: 30 }).map((s) => s.id)).toEqual([
			"near",
		]);
	});

	it("rebuild replaces the previous contents", () => {
		const idx = new StrokeIndex();
		idx.rebuild([stroke("old", 0, 0)]);
		idx.rebuild([stroke("new", 0, 0)]);
		expect(idx.query({ x: 0, y: 0, width: 20, height: 20 }).map((s) => s.id)).toEqual(["new"]);
	});
});
