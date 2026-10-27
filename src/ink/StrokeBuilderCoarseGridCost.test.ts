import { describe, expect, it } from "vitest";

import { coarseGridFor, StrokeBuilder } from "./StrokeBuilder";
import strokeBuilderSource from "./StrokeBuilder.ts?raw";

/**
 * The intake runs once per pen sample, so the coarse-grid filter's cost is
 * bounded: at most 100 ns added per sample at the median, and nothing
 * allocated per sample. Measured with no pen in the loop, at about 16 ns added.
 */
const SAMPLES = 200;
const STROKES = 200;
const REPS = 9;

function staircase(): Float64Array {
	const xy = new Float64Array(SAMPLES * 2);
	for (let i = 0; i < SAMPLES; i++) {
		xy[2 * i] = Math.round(0.3 * i * 4 + 9 * Math.sin(i / 14));
		xy[2 * i + 1] = Math.round(10 * Math.sin(i / 9));
	}
	return xy;
}

function nsPerSample(xy: Float64Array, smoothed: boolean): number {
	let sink = 0;
	const t0 = performance.now();
	for (let s = 0; s < STROKES; s++) {
		const builder = new StrokeBuilder("pen", "#2f6de0", 5);
		builder.start(0, smoothed ? coarseGridFor("cost-cell", "pen", 1, 1) : undefined);
		for (let i = 0; i < SAMPLES; i++) {
			const point = builder.add(xy[2 * i]!, xy[2 * i + 1]!, 0.5, i * 4);
			if (point) sink += point.x;
		}
	}
	const ns = ((performance.now() - t0) * 1e6) / (STROKES * SAMPLES);
	return sink === Infinity ? -1 : ns;
}

describe("coarse-grid smoothing cost", () => {
	it("adds at most 100 ns per sample at the median", () => {
		const xy = staircase();
		nsPerSample(xy, false);
		nsPerSample(xy, true);
		const added: number[] = [];
		for (let r = 0; r < REPS; r++) {
			const base = nsPerSample(xy, false);
			added.push(nsPerSample(xy, true) - base);
		}
		added.sort((a, b) => a - b);
		expect(added[Math.floor(REPS / 2)]!).toBeLessThanOrEqual(100);
	});

	it("allocates nothing per sample: the filter is scalar arithmetic on fields", () => {
		const source = strokeBuilderSource.replace(/\r\n/g, "\n");
		const filter = source.slice(source.indexOf("\t\tconst grid = this.grid;"), source.indexOf("\t\tconst prev = this.lastPoint;"));
		const observe = source.slice(source.indexOf("\tobserve(dx: number, dy: number): void {"), source.indexOf("const coarseGrids = new Map"));
		for (const body of [filter, observe]) {
			expect(body.length).toBeGreaterThan(100);
			expect(body).not.toMatch(/\bnew\b|\[|=>|\.\.\.|[=(,]\s*\{|`/);
		}
	});
});
