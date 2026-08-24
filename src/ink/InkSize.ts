/**
 * Nib sizes (v0.13.6), OneNote-style: three steps per tool, expressed as
 * multipliers on the tool's default width so pen (2.2px) and highlighter
 * (16px) scale proportionally. Pure module: state application lives in the
 * overlay (bound per stroke at pen-down), persistence in the plugin.
 */

export const INK_SIZE_STEPS: ReadonlyArray<{ name: string; mult: number }> = [
	{ name: "fine", mult: 0.6 },
	{ name: "medium", mult: 1 },
	{ name: "bold", mult: 1.8 },
];

/** Pure, unit-tested: keep persisted/foreign values sane. */
export function clampInkSize(mult: number): number {
	if (!Number.isFinite(mult) || mult <= 0) return 1;
	return Math.min(4, Math.max(0.25, mult));
}

/** Pure, unit-tested: the next step in the fine→medium→bold cycle. */
export function nextInkSize(current: number): { name: string; mult: number } {
	const i = INK_SIZE_STEPS.findIndex((s) => Math.abs(s.mult - current) < 1e-6);
	return INK_SIZE_STEPS[(i + 1) % INK_SIZE_STEPS.length] ?? INK_SIZE_STEPS[1]!;
}
