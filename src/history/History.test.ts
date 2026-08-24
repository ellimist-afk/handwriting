import { describe, expect, it } from "vitest";
import { History, Op } from "./History";
import { InkStroke } from "../ink/Stroke";
import { bboxHitsCircle, strokeHitsCircle, strokesHitByCircle } from "../ink/Eraser";

function counterOp(state: { n: number }, delta: number, label = "delta"): Op {
	return {
		label,
		apply: () => {
			state.n += delta;
		},
		invert: () => {
			state.n -= delta;
		},
	};
}

describe("History", () => {
	it("applies on run and reverses on undo", () => {
		const state = { n: 0 };
		const h = new History();
		h.run(counterOp(state, 5));
		expect(state.n).toBe(5);
		h.undo();
		expect(state.n).toBe(0);
		h.redo();
		expect(state.n).toBe(5);
	});

	it("push records without re-applying (the ink path already drew)", () => {
		const state = { n: 7 };
		const h = new History();
		h.push(counterOp(state, 7));
		expect(state.n).toBe(7); // not 14
		h.undo();
		expect(state.n).toBe(0);
	});

	it("clears redo when new work happens", () => {
		const state = { n: 0 };
		const h = new History();
		h.run(counterOp(state, 1));
		h.undo();
		expect(h.canRedo).toBe(true);
		h.run(counterOp(state, 10));
		expect(h.canRedo).toBe(false);
		expect(state.n).toBe(10);
	});

	it("undo/redo on an empty stack is a no-op", () => {
		const h = new History();
		expect(h.undo()).toBeUndefined();
		expect(h.redo()).toBeUndefined();
		expect(h.canUndo).toBe(false);
	});

	it("caps the stack without breaking further undo", () => {
		const state = { n: 0 };
		const h = new History();
		for (let i = 0; i < 260; i++) h.run(counterOp(state, 1));
		expect(state.n).toBe(260);
		expect(h.depth).toBe(200);
		h.undo();
		expect(state.n).toBe(259);
	});

	it("notifies on change", () => {
		let calls = 0;
		const h = new History(() => calls++);
		h.run(counterOp({ n: 0 }, 1));
		h.undo();
		h.redo();
		expect(calls).toBe(3);
	});
});

function line(id: string, pts: Array<[number, number]>): InkStroke {
	const points = pts.map(([x, y], i) => ({ x, y, pressure: 0.5, t: i }));
	const xs = pts.map((p) => p[0]);
	const ys = pts.map((p) => p[1]);
	return {
		id,
		tool: "pen",
		color: "#000",
		width: 2,
		points,
		bbox: {
			x: Math.min(...xs) - 4,
			y: Math.min(...ys) - 4,
			width: Math.max(...xs) - Math.min(...xs) + 8,
			height: Math.max(...ys) - Math.min(...ys) + 8,
		},
		createdAt: 0,
	};
}

describe("Eraser hit-testing", () => {
	const horizontal = line("h", [
		[0, 0],
		[100, 0],
	]);

	it("hits a segment it crosses", () => {
		expect(strokeHitsCircle(horizontal, 50, 3, 5)).toBe(true);
	});

	it("misses a segment outside the radius", () => {
		expect(strokeHitsCircle(horizontal, 50, 40, 5)).toBe(false);
	});

	it("misses beyond the end of a segment (not the infinite line)", () => {
		expect(strokeHitsCircle(horizontal, 130, 0, 5)).toBe(false);
	});

	it("hits a single-point dot stroke", () => {
		const dot = line("d", [[10, 10]]);
		expect(strokeHitsCircle(dot, 12, 10, 5)).toBe(true);
		expect(strokeHitsCircle(dot, 40, 10, 5)).toBe(false);
	});

	it("rejects early via bbox", () => {
		expect(bboxHitsCircle(horizontal.bbox, 500, 500, 5)).toBe(false);
		expect(bboxHitsCircle(horizontal.bbox, 50, 0, 1)).toBe(true);
	});

	it("collects every stroke under the circle", () => {
		const a = line("a", [
			[0, 0],
			[10, 0],
		]);
		const b = line("b", [
			[0, 5],
			[10, 5],
		]);
		const far = line("far", [
			[900, 900],
			[910, 900],
		]);
		expect(strokesHitByCircle([a, b, far], 5, 2, 4).sort()).toEqual(["a", "b"]);
		expect(strokesHitByCircle([a, b, far], 5, 2, 1)).toEqual([]);
	});

	it("does not hit a diagonal stroke that only shares a bbox corner", () => {
		const diag = line("diag", [
			[0, 0],
			[100, 100],
		]);
		// Near the top-right of the bbox — inside the box, far from the line.
		expect(bboxHitsCircle(diag.bbox, 95, 5, 3)).toBe(true);
		expect(strokeHitsCircle(diag, 95, 5, 3)).toBe(false);
	});
});
