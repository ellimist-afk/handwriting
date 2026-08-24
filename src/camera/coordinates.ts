/**
 * Pure coordinate math for the Handwriting canvas.
 *
 * Conventions (handoff §5):
 * - World coordinates are the only persistent coordinates.
 * - At zoom 1, 1 world unit ≈ 1 CSS pixel.
 * - Camera state = the world point visible at the viewport's top-left corner,
 *   plus a zoom scalar.
 * - Screen coordinates are CSS pixels relative to the canvas root's top-left.
 *
 * All conversion math lives here and ONLY here. Event handlers convert
 * immediately and never do their own arithmetic.
 */

export interface CameraState {
	/** World x visible at viewport left edge. */
	x: number;
	/** World y visible at viewport top edge. */
	y: number;
	/** Screen pixels per world unit. */
	zoom: number;
}

export interface Point {
	x: number;
	y: number;
}

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;

export function clampZoom(zoom: number): number {
	if (!Number.isFinite(zoom)) return 1;
	return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function screenToWorld(cam: CameraState, sx: number, sy: number): Point {
	return {
		x: cam.x + sx / cam.zoom,
		y: cam.y + sy / cam.zoom,
	};
}

export function worldToScreen(cam: CameraState, wx: number, wy: number): Point {
	return {
		x: (wx - cam.x) * cam.zoom,
		y: (wy - cam.y) * cam.zoom,
	};
}

/**
 * Pan the camera by a screen-space delta (e.g. finger dragged dx,dy pixels).
 * Dragging content right (positive dx) moves the camera left in world space.
 */
export function panBy(cam: CameraState, dxScreen: number, dyScreen: number): CameraState {
	return {
		x: cam.x - dxScreen / cam.zoom,
		y: cam.y - dyScreen / cam.zoom,
		zoom: cam.zoom,
	};
}

/**
 * Zoom to `newZoom`, keeping the world point currently under screen point
 * (sx, sy) stationary on screen. This is the invariant that makes zoom feel
 * right (handoff §30).
 */
export function zoomAtPoint(cam: CameraState, sx: number, sy: number, newZoom: number): CameraState {
	const z = clampZoom(newZoom);
	const anchor = screenToWorld(cam, sx, sy);
	return {
		x: anchor.x - sx / z,
		y: anchor.y - sy / z,
		zoom: z,
	};
}

/**
 * Combined pinch update: previous midpoint/distance -> new midpoint/distance.
 * Keeps the world point under the (moving) midpoint pinned to it while
 * scaling zoom by the distance ratio.
 */
export function pinchUpdate(
	cam: CameraState,
	prevMid: Point,
	prevDist: number,
	nextMid: Point,
	nextDist: number
): CameraState {
	const scale = prevDist > 0 ? nextDist / prevDist : 1;
	const z = clampZoom(cam.zoom * scale);
	// World point that was under the previous midpoint must land under the
	// next midpoint at the new zoom.
	const anchor = screenToWorld(cam, prevMid.x, prevMid.y);
	return {
		x: anchor.x - nextMid.x / z,
		y: anchor.y - nextMid.y / z,
		zoom: z,
	};
}
