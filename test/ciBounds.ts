/**
 * The millisecond bounds of the scroll-cost render cells are written for Alan's Windows machine. GitHub's Linux runner
 * (software rendering, shared cores) paints the same repaints at 3 to 10 ms against a 2 ms bound (CI run of 6f156547), so
 * the same cell cannot hold the same number in both places. On a runner that sets CI the bound is widened by a fixed
 * factor; everywhere else it is the number written in the cell. The premises of each cell (strokes mounted, fling moved,
 * carry taken) stay exact on both; only the millisecond bound moves.
 */
declare const process: { env: Record<string, string | undefined> };

export const CI_TIMING_FACTOR = 10;

/** GitHub Actions sets CI=true; an empty value, "0" and "false" mean a local run. */
export function onCi(env: Record<string, string | undefined> = process.env): boolean {
	const v = env.CI;
	return v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";
}

/** The bound a cell asserts: `ms` as written locally, `ms` times CI_TIMING_FACTOR on a CI runner. */
export function timingBound(ms: number, env: Record<string, string | undefined> = process.env): number {
	return onCi(env) ? ms * CI_TIMING_FACTOR : ms;
}

/**
 * The render files whose inputs are the machine's clock: how many frames it delivers, when pen and touch events land,
 * how long a main-thread task runs. The hosted runner sets all three by its own load, so CI runs these in a separate
 * step that prints and never blocks (HW_RENDER_SET=timing in vitest.render.mts); the geometry step runs every other
 * render file. Locally, with HW_RENDER_SET unset, every render file runs as before, and the package gate runs these on
 * a real machine.
 */
export const CI_TIMING_RENDER_FILES: readonly string[] = [
	// The bounce cells count spring frames; a loaded runner delivers fewer of them.
	"PanBakeRepaint.test.ts",
	// The save on a 9 MB page outlasts the fixture's pen-up gap when the main thread is slow.
	"SaveStallPenDown.test.ts",
	// The fling is wall-clock physics; with few frames the band moves fewer, longer times.
	"ScrollCostInk.test.ts",
	// The pen events go in by wall clock; the stroke's bottom row sits at the ink threshold on a slow raster.
	"ScaleSnapLift.test.ts",
	// The pen stroke goes in by wall clock; its bottom row sits at the ink threshold on a slow raster, as in ScaleSnapLift.
	"GridFallbackPixels.test.ts",
	// A millisecond bound on the first wet frame after pen-down; the runner measured 10.5 and 16.7 ms against 8 (1.4.24 push).
	"WetAllocLatency.test.ts",
	// The read waits up to 8 s of frames for a crisp one; the runner's software raster delivered none in 8 s (1.4.24 push).
	"ZoomOutStandInWiggle.arm.test.ts",
];
