/**
 * A SNAPPED FIGURE RESIZED BY THE DRAG STOPS AT THE TOP AND LEFT WALLS.
 *
 * Top and left are bounded: nothing goes above the top or past the left wall, where nothing can scroll. The drag scales
 * a shown figure about its centre, so a figure near the top-left corner, dragged larger, used to be stored with points
 * above and left of the page. The resized figure now slides back so its own box lands on the wall: the wall at 0, or
 * where the figure's box already was past it, as the lasso slides a selection. The figure keeps the pen's width, so its
 * box keeps the same pad at every size and the points sit that pad inside the wall.
 *
 * Runs the real SnapPreview with a fit that returns a fixed figure, the screen and the note's units the same.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SnapPreview } from "./SnapPreview";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { DWELL_MS } from "../ink/ShapeSnap";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** A square outline from (lo, lo) to (hi, hi) at width 2, so its box is padded 4 units each side. */
function square(lo: number, hi: number): InkStroke {
	const points = [[lo, lo], [hi, lo], [hi, hi], [lo, hi], [lo, lo]].map(([x, y], i) => ({ x: x!, y: y!, pressure: 0.5, t: i * 40 }));
	return { id: "fig", tool: "pen", color: "#fff", width: 2, points, bbox: computeBBox(points, 4), createdAt: 1 };
}

/** Hold the pen at (30, 30) until `figure` shows, then drag from `from` to `to`; the shape the gesture end takes. */
function dragTo(figure: InkStroke, from: { x: number; y: number }, to: { x: number; y: number }): InkStroke | null {
	const body = square(20, 40);
	const p = new SnapPreview({
		clock: { setTimeout: (fn: TimerHandler, ms?: number) => setTimeout(fn as () => void, ms) as unknown as number, clearTimeout: (id: number) => clearTimeout(id) },
		valid: () => true,
		snapshot: () => [body],
		show: () => true,
		hide: () => {},
	}, () => figure);
	p.start(30, 30);
	vi.advanceTimersByTime(DWELL_MS + 50);
	expect(p.holding, "precondition: the figure shows").toBe(true);
	p.move(from.x, from.y);
	p.move(to.x, to.y);
	return p.take([body]);
}

describe("a snapped figure dragged larger near the top-left corner", () => {
	it("is not stored above the top or left of the left wall", () => {
		const shown = dragTo(square(4, 56), { x: 64, y: 30 }, { x: 150, y: 30 });
		expect(shown, "precondition: the gesture end took the shape").not.toBeNull();
		expect(shown!.bbox.x, "the figure's box went past the left wall").toBeGreaterThanOrEqual(0);
		expect(shown!.bbox.y, "the figure's box went above the top").toBeGreaterThanOrEqual(0);
		expect(Math.min(...shown!.points.map(q => q.x)), "a point went past the left wall").toBeGreaterThanOrEqual(0);
		expect(Math.min(...shown!.points.map(q => q.y)), "a point went above the top").toBeGreaterThanOrEqual(0);
	});

	it("lands with its own box on the wall exactly, its points the pen's pad inside it", () => {
		const shown = dragTo(square(4, 56), { x: 64, y: 30 }, { x: 150, y: 30 })!;
		expect(Math.abs(shown.bbox.x), "the box stopped short of the left wall or past it").toBeLessThanOrEqual(1e-6);
		expect(Math.abs(shown.bbox.y), "the box stopped short of the top or past it").toBeLessThanOrEqual(1e-6);
		expect(Math.abs(Math.min(...shown.points.map(q => q.x)) - 4), "the points are not one pad inside the left wall").toBeLessThanOrEqual(1e-6);
		expect(shown.bbox.width, "precondition: the figure was resized").toBeGreaterThan(150);
	});

	it("a figure whose box already sat past the left wall stops where it was, not further", () => {
		const shown = dragTo(square(-6, 46), { x: 54, y: 20 }, { x: 150, y: 20 })!;
		expect(Math.abs(shown.bbox.x - -10), "the box did not stop at the wall its grab was already past").toBeLessThanOrEqual(1e-6);
	});

	it("control: a figure clear of the walls is resized about its centre and not moved", () => {
		const shown = dragTo(square(204, 256), { x: 264, y: 230 }, { x: 350, y: 230 })!;
		const cx = shown.bbox.x + shown.bbox.width / 2, cy = shown.bbox.y + shown.bbox.height / 2;
		expect(Math.abs(cx - 230) + Math.abs(cy - 230), "a figure clear of the walls moved off its centre").toBeLessThanOrEqual(1e-6);
		expect(shown.bbox.width, "precondition: the figure was resized").toBeGreaterThan(150);
	});
});
