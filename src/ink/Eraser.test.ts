import { describe, expect, it } from "vitest";
import { bboxHitsCircle, eraserRect } from "./Eraser";
import { BBox } from "./Stroke";

/**
 * eraserRect (design doc §5 C1, 2026-09-02).
 *
 * The note eraser asks StrokeIndex.query for candidates with this rect, so
 * anything the circle can touch has to lie inside it. A rect one unit short
 * on any side drops strokes at the edge of the eraser, silently, and only on
 * a note dense enough for the index to matter - which is why it is one
 * function with its own test rather than four expressions at the call sites.
 */
describe("eraserRect", () => {
	it("is the circle's bounding box", () => {
		expect(eraserRect(10, 20, 3)).toEqual({ x: 7, y: 17, width: 6, height: 6 });
	});

	it("covers the circle exactly - no slack, no shortfall", () => {
		const cx = -12.5;
		const cy = 7.25;
		const r = 4.75;
		const rect = eraserRect(cx, cy, r);
		// Every extreme point of the circle sits on the rect's boundary.
		expect(rect.x).toBe(cx - r);
		expect(rect.y).toBe(cy - r);
		expect(rect.x + rect.width).toBe(cx + r);
		expect(rect.y + rect.height).toBe(cy + r);
		// And every point ON the circle is inside it.
		for (let a = 0; a < Math.PI * 2; a += Math.PI / 16) {
			const px = cx + Math.cos(a) * r;
			const py = cy + Math.sin(a) * r;
			expect(px).toBeGreaterThanOrEqual(rect.x);
			expect(px).toBeLessThanOrEqual(rect.x + rect.width);
			expect(py).toBeGreaterThanOrEqual(rect.y);
			expect(py).toBeLessThanOrEqual(rect.y + rect.height);
		}
	});

	it("a zero radius is the degenerate rect at the point", () => {
		expect(eraserRect(5, 5, 0)).toEqual({ x: 5, y: 5, width: 0, height: 0 });
	});

	it("every box the circle touches overlaps the rect", () => {
		// The containment property the index depends on, over a grid of
		// boxes around a fixed circle: bboxHitsCircle implies rect overlap,
		// so a query for the rect can never skip a stroke the circle hits.
		const cx = 40;
		const cy = 30;
		const r = 9;
		const rect = eraserRect(cx, cy, r);
		const overlaps = (b: BBox): boolean =>
			!(
				b.x > rect.x + rect.width ||
				b.y > rect.y + rect.height ||
				b.x + b.width < rect.x ||
				b.y + b.height < rect.y
			);
		let touched = 0;
		for (let x = 0; x < 80; x += 1.5) {
			for (let y = 0; y < 70; y += 1.5) {
				const box: BBox = { x, y, width: 3, height: 2 };
				if (!bboxHitsCircle(box, cx, cy, r)) continue;
				touched++;
				expect(overlaps(box)).toBe(true);
			}
		}
		expect(touched).toBeGreaterThan(50);
	});
});
