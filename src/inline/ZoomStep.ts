/**
 * The zoom bar's + and − step: one grid through 100%, 100% x 1.25^n, so each
 * tap makes the note a quarter larger or smaller and no tap ever doubles.
 *
 * Pure. NoteZoomControls asks for the next value and zooms to it, so the stored
 * zoom sits on the grid and repeated taps stay on it. Pinch, ctrl+wheel, 100%
 * and Fit do not come through here; after one of them the zoom may sit off the
 * grid, and the next tap lands on the nearest grid value in its direction.
 */

/** Each tap's ratio: a quarter. */
export const ZOOM_STEP_RATIO = 1.25;
/**
 * A value within this fraction of a grid value counts as on it: the float
 * residue of zoomNoteBy(target / current), or a pinch that ended next to a step.
 */
export const ZOOM_GRID_TOLERANCE = 0.005;

const LOG_RATIO = Math.log(ZOOM_STEP_RATIO);
const gridAt = (n: number): number => Math.pow(ZOOM_STEP_RATIO, n);

/**
 * The scale one tap lands on from `current` (1 is 100%); `direction` 1 is +,
 * -1 is −. Returns `current` itself when the tap does nothing.
 *
 * Off the grid, the next grid value strictly in the tap's direction, never one
 * skipped (rounding to the nearest first would skip one). − never lands below
 * `floor`: it lands on the floor when the next grid value is under it, and at
 * or under the floor it does nothing (Fit alone goes lower; + from there climbs
 * back onto the grid). + never passes `ceiling`; the last tap lands on it.
 */
export function nextZoomStep(current: number, direction: 1 | -1, floor: number, ceiling: number): number {
	if (!Number.isFinite(current) || current <= 0) return current;
	if (direction < 0 && current <= floor * (1 + ZOOM_GRID_TOLERANCE)) return current;
	if (direction > 0 && current >= ceiling * (1 - ZOOM_GRID_TOLERANCE)) return current;
	const n = Math.log(current) / LOG_RATIO;
	const near = Math.round(n);
	const onGrid = Math.abs(current / gridAt(near) - 1) <= ZOOM_GRID_TOLERANCE;
	const next = gridAt(onGrid ? near + direction : direction > 0 ? Math.ceil(n) : Math.floor(n));
	return direction > 0 ? Math.min(next, ceiling) : Math.max(next, floor);
}
