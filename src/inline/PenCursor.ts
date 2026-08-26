/**
 * A reticle has to be findable before it can be useful, and small enough to
 * aim with. A pen nib is about 2px. A 6px floor put a 4px speck under the tip
 * where the hand hides it, which read as "the cursor does not work"; 12 was
 * the correction and overshot, reading as a blob on Orion.
 *
 * The floor is not the whole footprint: styles.css rings the reticle with a
 * 1.5px shadow OUTSIDE the border box, so what lands on screen is this plus 3.
 * At 6 that is 9 painted. The old 6 that read as a speck was 6 painted,
 * before the ring existed.
 */
export const MIN_CURSOR_VISUAL_PX = 6;
const PEN_COMPAT_MOUSE_WINDOW_MS = 120;
const PEN_COMPAT_MOUSE_DISTANCE_PX = 4;
export const PEN_HOVER_CLASS = "handwriting-pen-hover";

export interface PenCursorLayoutInput {
	x: number;
	y: number;
	strokeWidth: number;
	cameraZoom: number;
	cssScale: number;
}

/** Center a tool-size cursor on a pen sample without mixing visual and layout pixels. */
export function penCursorLayout(input: PenCursorLayoutInput): {
	x: number;
	y: number;
	diameter: number;
} {
	const cssScale = Number.isFinite(input.cssScale) && input.cssScale > 0 ? input.cssScale : 1;
	const cameraZoom =
		Number.isFinite(input.cameraZoom) && input.cameraZoom > 0 ? input.cameraZoom : 1;
	const strokeWidth =
		Number.isFinite(input.strokeWidth) && input.strokeWidth > 0 ? input.strokeWidth : 0;
	const diameter = Math.max(MIN_CURSOR_VISUAL_PX / cssScale, strokeWidth * cameraZoom);
	return {
		x: input.x - diameter / 2,
		y: input.y - diameter / 2,
		diameter,
	};
}

/**
 * Windows can follow a pen-hover pointermove with a mouse-compatible move at
 * the same point. Treat that pair as one pen hover; otherwise the synthetic
 * mouse event briefly restores CodeMirror's I-beam before the next pen sample.
 * A real mouse moving elsewhere still replaces the pen cursor immediately.
 */
export function isPenCompatMouseMove(input: {
	now: number;
	lastPenHoverAt: number;
	mouseX: number;
	mouseY: number;
	penX: number;
	penY: number;
}): boolean {
	return (
		input.now - input.lastPenHoverAt >= 0 &&
		input.now - input.lastPenHoverAt <= PEN_COMPAT_MOUSE_WINDOW_MS &&
		Math.hypot(input.mouseX - input.penX, input.mouseY - input.penY) <=
			PEN_COMPAT_MOUSE_DISTANCE_PX
	);
}

/**
 * Marks the hover reticle as showing an eraser rather than a nib: an outline
 * at the erase radius instead of a filled dot at the ink width.
 */
export const ERASER_CURSOR_CLASS = "handwriting-pen-hover-eraser";
