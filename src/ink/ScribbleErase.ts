/**
 * Scribble to erase: a dense back-and-forth stroke drawn over existing ink,
 * then lifted, erases the ink under it. Pure geometry, no DOM; the overlay asks
 * this module on lift and does the erase itself.
 *
 * The risk is a false erase of ink the user meant to keep, so every test here
 * leans towards "plain ink". A stroke counts as a scribble only when all of
 * these hold:
 *
 * 1. It runs back and forth along ONE line. Reversals are counted along the
 *    stroke's main direction, and only a turn that comes back a large part of
 *    the way counts, so the small hooks and loops of handwriting never do.
 * 2. It has many legs. An m, a w, a double strike-through or a short zigzag
 *    has too few.
 * 3. The legs lie on top of one another. The sideways spread of the whole
 *    stroke, shared out between its legs, is small next to a leg's length,
 *    and small in pen widths. Writing and zigzag hatching move on by a real
 *    gap every leg; long hatch lines leave paper between them, however long
 *    they are next to that gap; a scribble hardly moves.
 * 4. Existing ink sits under it. A stroke is taken when it touches the band
 *    the scribble drew AND most of its points lie inside that band. The band
 *    is measured from the scribble's segments, not its samples, so it covers
 *    the path the same at any pen speed. A circle round a phrase or an underline
 *    grazing a word touches the ink at a few points and leaves it; a scribble
 *    over empty page is plain ink.
 *
 * A stroke drawn round the scribble stays, though the band takes it: a box
 * drawn in one stroke and filled in, or a circle round a phrase that is then
 * scribbled out. It stays when few of its points lie inside the scribble's
 * interior (the scribble's own point extent, shrunk by the band's reach on
 * each side) and its path turns at least three quarters of a full turn round
 * the centre of that extent. A word, a dash or an underline under the scribble
 * turns far less, and goes. A box drawn in several strokes turns under a
 * quarter turn per side, so filling it in erases it.
 */

import { pointSegmentDistSq } from "./Eraser";
import type { BBox, InkPoint, InkStroke } from "./Stroke";

/** Turns along the main direction needed, so at least this many plus one legs. */
export const SCRIBBLE_MIN_REVERSALS = 5;
/** A turn counts once the stroke has come back this share of its length along the main direction. */
export const SCRIBBLE_TURN_SHARE = 0.4;
/** Largest sideways spread per leg, as a share of the mean leg length. */
export const SCRIBBLE_MAX_SPACING = 0.07;
/** Largest sideways spread per leg, in pen widths: legs further apart leave paper between them, as hatching does. */
export const SCRIBBLE_MAX_STEP_WIDTHS = 2;
/** Share of a touched stroke's points that must lie inside the scribble's band for it to be taken. */
export const SCRIBBLE_MIN_INSIDE = 0.6;
/** How far the band reaches beyond the scribble's half-width, from its nearest segment, in world units. */
export const SCRIBBLE_BAND_REACH = 4;
/** Mean leg length, in pen widths, below which the stroke is a dot or a jiggle, not a scribble. */
export const SCRIBBLE_MIN_LEG_WIDTHS = 4;
/** Largest share of a stroke's points inside the scribble's interior for the stroke to stay as drawn round it. */
export const SCRIBBLE_ROUND_MAX_INSIDE = 0.1;
/** Turn round the scribble's centre, in radians, a stroke's path makes at least to stay as drawn round it. */
export const SCRIBBLE_ROUND_MIN_TURN = 1.5 * Math.PI;

export interface ScribbleShape {
	reversals: number;
	legs: number;
	meanLeg: number;
	spacing: number;
	/** Sideways spread of the whole stroke shared out between its legs, in world units. */
	sideStep: number;
}

/** Reversal count, leg length and spacing of a stroke along its main direction. */
export function scribbleShape(points: readonly InkPoint[]): ScribbleShape | null {
	const n = points.length;
	if (n < 3) return null;
	let mx = 0;
	let my = 0;
	for (const p of points) {
		mx += p.x;
		my += p.y;
	}
	mx /= n;
	my /= n;
	let sxx = 0;
	let syy = 0;
	let sxy = 0;
	for (const p of points) {
		const dx = p.x - mx;
		const dy = p.y - my;
		sxx += dx * dx;
		syy += dy * dy;
		sxy += dx * dy;
	}
	// Main direction: the larger eigenvector of the point spread.
	const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
	const ux = Math.cos(angle);
	const uy = Math.sin(angle);
	const along: number[] = [];
	const side: number[] = [];
	for (const p of points) {
		along.push(p.x * ux + p.y * uy);
		side.push(-p.x * uy + p.y * ux);
	}
	const extent = Math.max(...along) - Math.min(...along);
	const sideExtent = Math.max(...side) - Math.min(...side);
	if (!(extent > 0)) return null;
	const turn = extent * SCRIBBLE_TURN_SHARE;
	// Walk the stroke, holding the furthest point reached in the current
	// direction; a turn is counted once the stroke has come back `turn` from it.
	const extremes: number[] = [along[0]!];
	let dir = 0;
	let peak = along[0]!;
	for (let i = 1; i < n; i++) {
		const a = along[i]!;
		if (dir === 0) {
			if (Math.abs(a - peak) >= turn) dir = Math.sign(a - peak);
			continue;
		}
		if ((a - peak) * dir > 0) {
			peak = a;
		} else if (Math.abs(a - peak) >= turn) {
			extremes.push(peak);
			dir = -dir;
			peak = a;
		}
	}
	if (dir !== 0) extremes.push(peak);
	const legs = extremes.length - 1;
	if (legs < 1) return { reversals: 0, legs: 0, meanLeg: 0, spacing: Infinity, sideStep: Infinity };
	let total = 0;
	for (let i = 1; i < extremes.length; i++) total += Math.abs(extremes[i]! - extremes[i - 1]!);
	const meanLeg = total / legs;
	const sideStep = sideExtent / legs;
	return { reversals: legs - 1, legs, meanLeg, spacing: sideStep / meanLeg, sideStep };
}

/** True when the stroke's own shape is a scribble, whatever is under it. */
export function isScribbleShape(stroke: InkStroke): boolean {
	const shape = scribbleShape(stroke.points);
	if (!shape) return false;
	const penWidth = Math.max(stroke.width, 0.5);
	return (
		shape.reversals >= SCRIBBLE_MIN_REVERSALS &&
		shape.spacing <= SCRIBBLE_MAX_SPACING &&
		shape.sideStep <= SCRIBBLE_MAX_STEP_WIDTHS * penWidth &&
		shape.meanLeg >= SCRIBBLE_MIN_LEG_WIDTHS * penWidth
	);
}

/** How far the scribble's band reaches from its nearest segment: its ink's half-width plus SCRIBBLE_BAND_REACH. */
export function scribbleBandReach(scribble: InkStroke): number {
	return scribble.width / 2 + SCRIBBLE_BAND_REACH;
}

/**
 * Squared distance from a point to the nearest of the polyline's segments listed in `near` (segment i joins points i - 1 and
 * i), or to its only point when it has one.
 */
function pathDistSq(px: number, py: number, pts: readonly InkPoint[], near: readonly number[]): number {
	if (pts.length === 1) return (pts[0]!.x - px) ** 2 + (pts[0]!.y - py) ** 2;
	let best = Infinity;
	for (const i of near) {
		const a = pts[i - 1]!;
		const b = pts[i]!;
		const d = pointSegmentDistSq(px, py, a.x, a.y, b.x, b.y);
		if (d < best) best = d;
	}
	return best;
}

/**
 * The polyline's segments whose bounding box meets `box` grown by `r`: every segment within `r` of a point inside `box`.
 * A stroke's points lie inside its bbox, so the inside count asks these alone and answers as it would over all of them.
 */
function segmentsNear(pts: readonly InkPoint[], box: BBox, r: number): number[] {
	const x0 = box.x - r, x1 = box.x + box.width + r, y0 = box.y - r, y1 = box.y + box.height + r;
	const out: number[] = [];
	for (let i = 1; i < pts.length; i++) {
		const a = pts[i - 1]!, b = pts[i]!;
		if (Math.max(a.x, b.x) < x0 || Math.min(a.x, b.x) > x1 || Math.max(a.y, b.y) < y0 || Math.min(a.y, b.y) > y1) continue;
		out.push(i);
	}
	return out;
}

/** The scribble's point extent shrunk by the band's reach on each side, and the extent's centre. */
interface ScribbleInterior {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
	cx: number;
	cy: number;
}

/** The scribble's interior: its point extent shrunk by `r` on each side, or `null` when nothing is left. */
function scribbleInterior(pts: readonly InkPoint[], r: number): ScribbleInterior | null {
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (const p of pts) {
		if (p.x < x0) x0 = p.x;
		if (p.x > x1) x1 = p.x;
		if (p.y < y0) y0 = p.y;
		if (p.y > y1) y1 = p.y;
	}
	if (!(x1 - r > x0 + r && y1 - r > y0 + r)) return null;
	return { x0: x0 + r, y0: y0 + r, x1: x1 - r, y1: y1 - r, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

/**
 * True when the stroke is drawn round the scribble: at most SCRIBBLE_ROUND_MAX_INSIDE of its points lie inside the
 * interior, and its path turns at least SCRIBBLE_ROUND_MIN_TURN round the extent's centre (the signed angle steps between
 * consecutive points, each wrapped to a half turn, summed). The turn is counted only once the inside share passes.
 */
function drawnRound(pts: readonly InkPoint[], inner: ScribbleInterior): boolean {
	const n = pts.length;
	let inside = 0;
	for (const p of pts) if (p.x > inner.x0 && p.x < inner.x1 && p.y > inner.y0 && p.y < inner.y1) inside++;
	if (inside / n > SCRIBBLE_ROUND_MAX_INSIDE) return false;
	let turn = 0;
	let prev = Math.atan2(pts[0]!.y - inner.cy, pts[0]!.x - inner.cx);
	for (let i = 1; i < n; i++) {
		const a = Math.atan2(pts[i]!.y - inner.cy, pts[i]!.x - inner.cx);
		let d = a - prev;
		if (d > Math.PI) d -= 2 * Math.PI;
		else if (d <= -Math.PI) d += 2 * Math.PI;
		turn += d;
		prev = a;
	}
	return Math.abs(turn) >= SCRIBBLE_ROUND_MIN_TURN;
}

function boxesWithin(a: BBox, b: BBox, r: number): boolean {
	return a.x - r <= b.x + b.width && b.x <= a.x + a.width + r && a.y - r <= b.y + b.height && b.y <= a.y + a.height + r;
}

/**
 * Ids of the strokes a finished stroke erases as a scribble, in `existing`
 * order, or `null` when the stroke is plain ink (not a scribble, or nothing
 * under it). The band is everything within `scribbleBandReach` of a segment
 * of the scribble. A stroke is taken when at least SCRIBBLE_MIN_INSIDE of its
 * points are within the band plus its half-width; a stroke with a point that
 * near touches the band, so no separate touch test is made. A bounding-box
 * test skips strokes nowhere near, the count asks only the scribble segments
 * near the stroke's box, and it stops once the share can no longer be reached.
 * A stroke the share takes still stays when it is drawn round the scribble.
 * Runs once, at the lift.
 */
export function scribbleEraseTargets(scribble: InkStroke, existing: readonly InkStroke[]): string[] | null {
	if (!isScribbleShape(scribble)) return null;
	const band = scribbleBandReach(scribble);
	const path = scribble.points;
	const out: string[] = [];
	let inner: ScribbleInterior | null | undefined;
	for (const s of existing) {
		if (s.id === scribble.id || s.points.length === 0) continue;
		const r = band + s.width / 2;
		if (!boxesWithin(scribble.bbox, s.bbox, r)) continue;
		const near = segmentsNear(path, s.bbox, r);
		if (near.length === 0 && path.length > 1) continue;
		const rSq = r * r, n = s.points.length;
		let outside = 0;
		for (const q of s.points) {
			if (pathDistSq(q.x, q.y, path, near) <= rSq) continue;
			outside++;
			if ((n - outside) / n < SCRIBBLE_MIN_INSIDE) break;
		}
		if ((n - outside) / n < SCRIBBLE_MIN_INSIDE) continue;
		if (inner === undefined) inner = scribbleInterior(path, band);
		if (inner && drawnRound(s.points, inner)) continue;
		out.push(s.id);
	}
	return out.length > 0 ? out : null;
}
