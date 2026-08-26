import { Point2 } from "../ink/Smoothing";
import { BBox, InkStroke } from "../ink/Stroke";

/**
 * Lasso selection geometry (handoff §26, §58, §78), all in world coordinates.
 *
 * Working in world space is what makes selection survive pan and zoom for
 * free: the polygon the user drew, the strokes and the text boxes are all in
 * the same space, so the camera never enters the hit test. Nothing here knows
 * what a pixel is.
 *
 * MVP rule, per §78: a thing is selected if the lasso touches it, any part
 * inside, or any edge crossed. Refinement can come later; the point is to
 * prove the interaction, not to perfect the geometry.
 */

export function pointInPolygon(x: number, y: number, poly: readonly Point2[]): boolean {
	let inside = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const a = poly[i]!;
		const b = poly[j]!;
		// Ray cast to the right; count edge crossings.
		if (a.y > y !== b.y > y) {
			const t = (y - a.y) / (b.y - a.y);
			if (x < a.x + t * (b.x - a.x)) inside = !inside;
		}
	}
	return inside;
}

export function polygonBounds(poly: readonly Point2[]): BBox {
	if (poly.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const p of poly) {
		if (p.x < minX) minX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.x > maxX) maxX = p.x;
		if (p.y > maxY) maxY = p.y;
	}
	return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function bboxOverlaps(a: BBox, b: BBox): boolean {
	return !(
		a.x > b.x + b.width ||
		b.x > a.x + a.width ||
		a.y > b.y + b.height ||
		b.y > a.y + a.height
	);
}

function orient(a: Point2, b: Point2, c: Point2): number {
	return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

export function segmentsIntersect(a: Point2, b: Point2, c: Point2, d: Point2): boolean {
	const d1 = orient(a, b, c);
	const d2 = orient(a, b, d);
	const d3 = orient(c, d, a);
	const d4 = orient(c, d, b);
	if (((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))) return true;
	// Collinear touching counts as a crossing; a lasso drawn exactly along a
	// stroke should still catch it.
	const onSeg = (p: Point2, q: Point2, r: Point2) =>
		Math.abs(orient(p, q, r)) < 1e-9 &&
		r.x >= Math.min(p.x, q.x) - 1e-9 &&
		r.x <= Math.max(p.x, q.x) + 1e-9 &&
		r.y >= Math.min(p.y, q.y) - 1e-9 &&
		r.y <= Math.max(p.y, q.y) + 1e-9;
	return onSeg(a, b, c) || onSeg(a, b, d) || onSeg(c, d, a) || onSeg(c, d, b);
}

function polygonCrossesSegment(poly: readonly Point2[], a: Point2, b: Point2): boolean {
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		if (segmentsIntersect(a, b, poly[i]!, poly[j]!)) return true;
	}
	return false;
}

/**
 * A stroke needs a MAJORITY of its samples inside to be selected. The old
 * rule was any-touch: one sample inside, or the lasso line merely crossing
 * the stroke, took the whole thing - so circling a word while clipping the
 * neighbour's descender grabbed the neighbour too (orion 2026-08-26,
 * "keeps picking up other stuff"). Half is the honest threshold: what you
 * circled comes, what you grazed stays.
 */
const LASSO_INSIDE_FRACTION = 0.5;

export function strokeInLasso(
	stroke: InkStroke,
	poly: readonly Point2[],
	bounds: BBox
): boolean {
	if (poly.length < 3) return false;
	if (!bboxOverlaps(stroke.bbox, bounds)) return false;
	const pts = stroke.points;
	if (pts.length === 0) return false;
	let inside = 0;
	for (const p of pts) {
		if (pointInPolygon(p.x, p.y, poly)) inside++;
	}
	return inside >= pts.length * LASSO_INSIDE_FRACTION && inside > 0;
}

export function rectInLasso(
	rect: BBox,
	poly: readonly Point2[],
	bounds: BBox
): boolean {
	if (poly.length < 3) return false;
	if (!bboxOverlaps(rect, bounds)) return false;
	const corners: Point2[] = [
		{ x: rect.x, y: rect.y },
		{ x: rect.x + rect.width, y: rect.y },
		{ x: rect.x + rect.width, y: rect.y + rect.height },
		{ x: rect.x, y: rect.y + rect.height },
	];
	for (const c of corners) {
		if (pointInPolygon(c.x, c.y, poly)) return true;
	}
	// Lasso drawn entirely inside the box: no corner is in the polygon, but
	// every polygon vertex is in the box.
	for (const p of poly) {
		if (
			p.x >= rect.x &&
			p.x <= rect.x + rect.width &&
			p.y >= rect.y &&
			p.y <= rect.y + rect.height
		) {
			return true;
		}
	}
	for (let i = 0; i < 4; i++) {
		if (polygonCrossesSegment(poly, corners[i]!, corners[(i + 1) % 4]!)) return true;
	}
	return false;
}

/** Bounding box of everything selected, for the drag handle and outline. */
export function unionBounds(boxes: readonly BBox[]): BBox | null {
	if (boxes.length === 0) return null;
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const b of boxes) {
		if (b.x < minX) minX = b.x;
		if (b.y < minY) minY = b.y;
		if (b.x + b.width > maxX) maxX = b.x + b.width;
		if (b.y + b.height > maxY) maxY = b.y + b.height;
	}
	return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function pointInBBox(x: number, y: number, b: BBox): boolean {
	return x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;
}

/** Move a stroke in place, keeping its bbox consistent. */
export function translateStroke(stroke: InkStroke, dx: number, dy: number): void {
	for (const p of stroke.points) {
		p.x += dx;
		p.y += dy;
	}
	stroke.bbox = {
		x: stroke.bbox.x + dx,
		y: stroke.bbox.y + dy,
		width: stroke.bbox.width,
		height: stroke.bbox.height,
	};
}
