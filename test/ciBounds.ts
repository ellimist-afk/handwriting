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
