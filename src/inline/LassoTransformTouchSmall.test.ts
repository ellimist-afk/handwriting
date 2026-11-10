/**
 * A finger on a small lasso selection (hitTransformHandle, "touch"). A finger's hit square per handle is 44 css px, so on a
 * box under that size the four corner squares cover the whole box and a drag from inside it always grabbed a corner: the
 * selection could be resized but never moved. Inside the drawn box a corner's square reaches in only as far as leaves a
 * finger's width in the middle for the move; outside the box it reaches as before, so every corner stays reachable. A box
 * with room for both is hit as before, and so is a box thin one way only (a lasso round one written line): its long side
 * already leaves a finger a band to move it by. A pen's or a mouse's hit test does not change at any size.
 */
import { describe, expect, it } from "vitest";
import { HANDLE_POINTER_PX, HANDLE_TOUCH_PX, handlePoints, hitTransformHandle, type HandleInput, type TransformHandle } from "./LassoTransform";
import type { BBox } from "../ink/Stroke";

/** The hit test as it was before the inside reach was bounded: a square of the input's size around each handle, nearest wins. */
function squaresOnly(box: BBox, zoom: number, at: { x: number; y: number }, input: HandleInput, cssScale = 1): TransformHandle | null {
	const half = (input === "touch" ? HANDLE_TOUCH_PX : HANDLE_POINTER_PX) / 2 / (zoom * cssScale);
	const h = handlePoints(box, zoom, cssScale);
	let best: TransformHandle | null = null, bestD = Infinity;
	for (const id of ["rotate", "nw", "ne", "se", "sw"] as const) {
		const dx = at.x - h[id].x, dy = at.y - h[id].y;
		if (Math.abs(dx) > half || Math.abs(dy) > half) continue;
		const d = dx * dx + dy * dy;
		if (d < bestD) { best = id; bestD = d; }
	}
	return best;
}

/** Points every `step` world units over the box grown by `margin` on each side. */
function grid(box: BBox, margin: number, step: number): { x: number; y: number }[] {
	const out: { x: number; y: number }[] = [];
	for (let y = box.y - margin; y <= box.y + box.height + margin; y += step)
		for (let x = box.x - margin; x <= box.x + box.width + margin; x += step) out.push({ x, y });
	return out;
}

describe("a finger on a small lasso selection moves it from inside and resizes it from outside", () => {
	it("a finger in the middle of a 20 px box grabs no handle, so the drag moves the box", () => {
		expect(hitTransformHandle({ x: 0, y: 0, width: 20, height: 20 }, 1, { x: 10, y: 10 }, "touch")).toBeNull();
	});

	it("on the same box, a finger just outside each corner still grabs that corner", () => {
		const box = { x: 0, y: 0, width: 20, height: 20 };
		const h = handlePoints(box, 1);
		const out: Record<"nw" | "ne" | "se" | "sw", { x: number; y: number }> = {
			nw: { x: h.nw.x - 8, y: h.nw.y - 8 },
			ne: { x: h.ne.x + 8, y: h.ne.y - 8 },
			se: { x: h.se.x + 8, y: h.se.y + 8 },
			sw: { x: h.sw.x - 8, y: h.sw.y + 8 },
		};
		for (const id of ["nw", "ne", "se", "sw"] as const) expect(hitTransformHandle(box, 1, out[id], "touch"), id).toBe(id);
		expect(hitTransformHandle(box, 1, h.rotate, "touch"), "the knob").toBe("rotate");
	});

	it("a 200 px box gives every input the same handle as before at every point, and a small box gives a pen and a mouse the same", () => {
		const big = { x: 40, y: 60, width: 200, height: 200 };
		for (const [zoom, cssScale] of [[1, 1], [2, 1], [1, 0.5]] as const)
			for (const input of ["touch", "pen", "mouse"] as const)
				for (const at of grid(big, 40, 3))
					expect(hitTransformHandle(big, zoom, at, input, cssScale), `${input} at ${at.x},${at.y}, zoom ${zoom}, canvas ${cssScale}`).toBe(squaresOnly(big, zoom, at, input, cssScale));
		const small = { x: 0, y: 0, width: 20, height: 20 };
		for (const input of ["pen", "mouse"] as const)
			for (const at of grid(small, 40, 1))
				expect(hitTransformHandle(small, 1, at, input), `${input} at ${at.x},${at.y}`).toBe(squaresOnly(small, 1, at, input));
	});
	it("a box round one written line (300 by 40) still gives a finger just inside its top-left corner that corner", () => {
		const box = { x: 0, y: 0, width: 300, height: 40 };
		const at = { x: handlePoints(box, 1).nw.x + 8, y: handlePoints(box, 1).nw.y + 12 };
		expect(squaresOnly(box, 1, at, "touch"), "premise: the corner before").toBe("nw");
		expect(hitTransformHandle(box, 1, at, "touch")).toBe("nw");
	});

	it("boxes thin one way only give a finger the same handle as before at every point", () => {
		for (const box of [
			{ x: 0, y: 0, width: 300, height: 40 },
			{ x: 0, y: 0, width: 40, height: 300 },
			{ x: 0, y: 0, width: 300, height: 20 },
			{ x: 0, y: 0, width: 120, height: 60 },
		]) {
			let diff = 0, first = "";
			for (const at of grid(box, 30, 2)) {
				const now = hitTransformHandle(box, 1, at, "touch"), was = squaresOnly(box, 1, at, "touch");
				if (now !== was && diff++ === 0) first = `${at.x},${at.y} now ${now}, was ${was}`;
			}
			expect(diff, `${box.width} by ${box.height}, first ${first}`).toBe(0);
		}
	});
});
