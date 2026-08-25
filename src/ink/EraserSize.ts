/**
 * Eraser sizes, matching the nib-size idiom: three steps, expressed as a
 * radius in screen pixels so the eraser stays the same physical size on the
 * glass whatever the note is zoomed to.
 *
 * The eraser was a fixed 12px radius from v0.1 to v0.13.12, when it deleted
 * whole strokes on contact. Now that it takes only what the ring covers, 12
 * felt small on the glass, so medium is 14.
 */

export const ERASER_SIZE_STEPS: ReadonlyArray<{ name: string; radiusPx: number }> = [
	{ name: "fine", radiusPx: 8 },
	{ name: "medium", radiusPx: 14 },
	{ name: "bold", radiusPx: 28 },
];

export const DEFAULT_ERASER_RADIUS_PX = 14;

/** Pure: keep persisted or foreign values inside something usable. */
export function clampEraserRadius(px: number): number {
	if (!Number.isFinite(px) || px <= 0) return DEFAULT_ERASER_RADIUS_PX;
	return Math.min(64, Math.max(3, px));
}

/**
 * Pure: the next step in the fine to medium to bold cycle.
 *
 * A size that matches no step (an old setting, a hand-edited data.json) lands
 * on medium rather than falling to the first step, so one press of the command
 * always puts the eraser somewhere familiar.
 */
export function nextEraserSize(current: number): { name: string; radiusPx: number } {
	const i = ERASER_SIZE_STEPS.findIndex((s) => Math.abs(s.radiusPx - current) < 1e-6);
	if (i < 0) return ERASER_SIZE_STEPS[1]!;
	return ERASER_SIZE_STEPS[(i + 1) % ERASER_SIZE_STEPS.length] ?? ERASER_SIZE_STEPS[1]!;
}
