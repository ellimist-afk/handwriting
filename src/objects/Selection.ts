import { Point2 } from "../ink/Smoothing";
import { BBox, InkStroke } from "../ink/Stroke";
import { bumpStrokeRev } from "../ink/StrokeRev";

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
	// Non-zero winding, not even-odd: a hand-drawn lasso often overshoots its
	// start or goes round twice, and even-odd calls what is covered twice
	// "outside".
	let winding = 0;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const a = poly[j]!;
		const b = poly[i]!;
		// Ray cast to the right; sum signed edge crossings.
		const side = (b.x - a.x) * (y - a.y) - (x - a.x) * (b.y - a.y);
		if (a.y <= y) {
			if (b.y > y && side > 0) winding++;
		} else if (b.y <= y && side < 0) {
			winding--;
		}
	}
	return winding !== 0;
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
 * A stroke needs a MAJORITY of its ink, by length, inside to be selected. The old
 * rule was any-touch: one sample inside, or the lasso line merely crossing
 * the stroke, took the whole thing - so circling a word while clipping the
 * neighbour's descender grabbed the neighbour too (orion 2026-08-26,
 * "keeps picking up other stuff"). More than half is the honest threshold: what you
 * circled comes, what you grazed stays. Length, not sample count: a pen
 * writes slowly where it starts, so a long line can begin with a dense run of
 * samples that says nothing about how much of the line was circled.
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
	let total = 0;
	for (let i = 1; i < pts.length; i++) {
		const a = pts[i - 1]!;
		const b = pts[i]!;
		const length = Math.hypot(b.x - a.x, b.y - a.y);
		total += length;
		// A segment whose box misses the lasso's box has no ink inside; skip
		// the crossing pass over the lasso.
		if (segmentMissesBounds(a, b, bounds)) continue;
		inside += length * insideFraction(a, b, poly);
	}
	if (total > 0) return inside > total * LASSO_INSIDE_FRACTION;
	// No length (a dot): fall back to counting its samples.
	let count = 0;
	for (const p of pts) {
		if (pointInPolygon(p.x, p.y, poly)) count++;
	}
	return count >= pts.length * LASSO_INSIDE_FRACTION && count > 0;
}

function segmentMissesBounds(a: Point2, b: Point2, bounds: BBox): boolean {
	return (
		(a.x < bounds.x && b.x < bounds.x) ||
		(a.x > bounds.x + bounds.width && b.x > bounds.x + bounds.width) ||
		(a.y < bounds.y && b.y < bounds.y) ||
		(a.y > bounds.y + bounds.height && b.y > bounds.y + bounds.height)
	);
}

/** The part of segment ab inside the polygon, 0 to 1. */
function insideFraction(a: Point2, b: Point2, poly: readonly Point2[]): number {
	const cuts = [0, 1];
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const c = poly[j]!;
		const ex = poly[i]!.x - c.x;
		const ey = poly[i]!.y - c.y;
		const den = dx * ey - dy * ex;
		if (den === 0) continue;
		const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / den;
		const u = ((c.x - a.x) * dy - (c.y - a.y) * dx) / den;
		if (t > 0 && t < 1 && u >= 0 && u <= 1) cuts.push(t);
	}
	cuts.sort((p, q) => p - q);
	let fraction = 0;
	for (let k = 1; k < cuts.length; k++) {
		const mid = (cuts[k - 1]! + cuts[k]!) / 2;
		if (pointInPolygon(a.x + dx * mid, a.y + dy * mid, poly)) fraction += cuts[k]! - cuts[k - 1]!;
	}
	return fraction;
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

/**
 * A box grown by `pad` on every side, for a hit test that needs tolerance.
 *
 * The grab test that starts a selection drag is the caller. A stroke's box is
 * its points plus twice its width, so a horizontal line is only a few units
 * thick, and an unpadded test asks the user to land the nib on that exact
 * row. The pad is in the box's own units; each surface converts its screen-px
 * tolerance before calling.
 */
export function padBBox(b: BBox, pad: number): BBox {
	return { x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 };
}

/**
 * Move a stroke in place, keeping its bbox consistent.
 *
 * This and `scaleStroke` below are the ONLY in-place mutations of a committed
 * stroke in the codebase (audited 2026-09-02: nothing else writes `.points`,
 * `.bbox`, `.width` or `.color` on a stroke a store already holds; the eraser,
 * the shape snap and every parse build new objects). Both callers -
 * `InlineInkStore.moveStrokes` for the inline surface and
 * `ObjectOps.moveObjects` for the page view, which between them carry the
 * lasso drag, the insert-space drag and the undo/redo of both - come through
 * here, so bumping the revision at this one spot is what keeps derived
 * geometry (StrokeRenderer's ribbon cache) from rendering the ink where it WAS.
 */
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
	bumpStrokeRev(stroke);
}

/**
 * Scale a stroke in place about the note origin: every point, the base width
 * and the bbox (which already carries its width padding, so it scales with
 * them). In place for the same reason as `translateStroke`: the history ops
 * that recorded the stroke hold this same object, so undo and redo put back
 * the scaled stroke, not the one from before.
 *
 * The in-place caller is the ink-file read (`InlineInkStore`): ink drawn while
 * a note's file was still loading is in the frame of the editor's font size at
 * the time, and moves into the frame stored with the note when the file lands.
 * The overlay also uses it, on copies, for a stroke still in flight then.
 */
export function scaleStroke(stroke: InkStroke, k: number): void {
	for (const p of stroke.points) {
		p.x *= k;
		p.y *= k;
	}
	stroke.width *= k;
	stroke.bbox = {
		x: stroke.bbox.x * k,
		y: stroke.bbox.y * k,
		width: stroke.bbox.width * k,
		height: stroke.bbox.height * k,
	};
	bumpStrokeRev(stroke);
}
