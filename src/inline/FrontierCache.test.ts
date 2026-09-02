import { describe, expect, it } from "vitest";
import { ExtentInputs, FrontierCache, sameExtentInputs } from "./FrontierCache";
import { InkStroke } from "../ink/Stroke";

function stroke(x: number, y: number, w: number, h: number): InkStroke {
	return {
		id: `s-${x}-${y}-${w}-${h}`,
		tool: "pen",
		color: "#000",
		width: 2,
		points: [],
		bbox: { x, y, width: w, height: h },
		createdAt: 0,
	};
}

describe("FrontierCache", () => {
	it("returns the SAME object on a hit, so callers can compare by identity", () => {
		const cache = new FrontierCache();
		const strokes = [stroke(10, 20, 30, 40)];
		const first = cache.get("a.md", strokes);
		expect(first).toEqual({ x: 40, y: 60 });
		expect(cache.get("a.md", strokes)).toBe(first);
		expect(cache.get("a.md", strokes)).toBe(first);
	});

	it("recomputes after invalidate, so a mutation in place is not missed", () => {
		const cache = new FrontierCache();
		const strokes = [stroke(0, 0, 10, 10)];
		const first = cache.get("a.md", strokes);
		// The store mutates its array in place; a lasso move changes no count.
		strokes[0] = stroke(0, 0, 100, 100);
		expect(cache.get("a.md", strokes)).toBe(first);
		cache.invalidate("a.md");
		const second = cache.get("a.md", strokes);
		expect(second).not.toBe(first);
		expect(second).toEqual({ x: 100, y: 100 });
	});

	it("recomputes when the stroke count changed, with no invalidate at all", () => {
		const cache = new FrontierCache();
		const strokes = [stroke(0, 0, 10, 10)];
		expect(cache.get("a.md", strokes)).toEqual({ x: 10, y: 10 });
		// The lazy sidecar load: strokes appear without an ink-changed event.
		strokes.push(stroke(0, 0, 500, 300));
		expect(cache.get("a.md", strokes)).toEqual({ x: 500, y: 300 });
		// And the other direction: an erase that splices strokes out.
		strokes.length = 1;
		expect(cache.get("a.md", strokes)).toEqual({ x: 10, y: 10 });
	});

	it("keeps paths independent, and invalidate touches only its own", () => {
		const cache = new FrontierCache();
		const a = [stroke(0, 0, 10, 10)];
		const b = [stroke(0, 0, 20, 20)];
		const frontierA = cache.get("a.md", a);
		const frontierB = cache.get("b.md", b);
		expect(frontierA).toEqual({ x: 10, y: 10 });
		expect(frontierB).toEqual({ x: 20, y: 20 });
		cache.invalidate("a.md");
		expect(cache.get("b.md", b)).toBe(frontierB);
		expect(cache.get("a.md", a)).not.toBe(frontierA);
	});

	it("gives an empty note a zero frontier and still caches it", () => {
		const cache = new FrontierCache();
		const first = cache.get("a.md", []);
		expect(first).toEqual({ x: 0, y: 0 });
		expect(cache.get("a.md", [])).toBe(first);
	});
});

const BASE: ExtentInputs = {
	path: "a.md",
	frontier: { x: 10, y: 20 },
	writtenOn: false,
	camX: 1,
	camY: 2,
	camZoom: 1,
	fontZoom: 1,
	pinchScale: 1,
	cssScale: 1,
	cssWidth: 800,
	cssHeight: 600,
};

describe("sameExtentInputs", () => {
	it("is false against nothing applied yet", () => {
		expect(sameExtentInputs(null, BASE)).toBe(false);
	});

	it("is true for a field-identical snapshot sharing the frontier object", () => {
		expect(sameExtentInputs(BASE, { ...BASE })).toBe(true);
	});

	it("compares the frontier by identity, not by value", () => {
		expect(sameExtentInputs(BASE, { ...BASE, frontier: { x: 10, y: 20 } })).toBe(false);
	});

	it("is false when any single input moved", () => {
		const moved: Array<Partial<ExtentInputs>> = [
			{ path: "b.md" },
			{ writtenOn: true },
			{ camX: 0 },
			{ camY: 0 },
			{ camZoom: 2 },
			{ fontZoom: 1.2 },
			{ pinchScale: 1.5 },
			{ cssScale: 2 },
			{ cssWidth: 801 },
			{ cssHeight: 601 },
		];
		for (const patch of moved) {
			expect(sameExtentInputs(BASE, { ...BASE, ...patch })).toBe(false);
		}
	});
});
