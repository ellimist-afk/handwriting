import { PenStyle, widthForPressure } from "./PenStyle";
import { Point2, SmoothSegment, smoothSegments } from "./Smoothing";
import { InkPoint } from "./Stroke";

/**
 * Ribbon rendering: a stroke drawn as ONE filled variable-width outline
 * instead of a chain of separately stroked segments.
 *
 * Why this exists. Stroking each segment on its own paints a capsule per
 * segment, and the union of hundreds of antialiased capsules composites its
 * edge pixels over and over. Every overlap darkens and roughens the silhouette
 * a little, and each capsule's width is constant along its length, so a
 * pressure change puts a step in the outline. At zoom 1 with 2-pixel segments
 * none of that is visible. Magnify it six times and the edge reads as beaded
 * and stair-stepped, which is exactly the reported defect, and it is not a
 * raster resolution problem: it is what the geometry was asking the rasterizer
 * to draw.
 *
 * A ribbon is built once, filled once, antialiased once. Width varies
 * continuously along it because each side point carries its own half-width.
 *
 * The centerline is the same midpoint-quadratic curve as before, flattened at
 * a density chosen from the current zoom, so zooming in subdivides further
 * instead of revealing the flattening. Canonical stroke points are untouched;
 * this is rendering geometry only.
 */

export interface RibbonPt {
	/** World coordinates. */
	x: number;
	y: number;
	/** Half-width in world units at this point. */
	hw: number;
}

/**
 * How far the flattened polyline may deviate from the true curve, in screen
 * pixels. Below a third of a pixel the difference is inside the antialiasing.
 */
const FLATTEN_TOLERANCE_PX = 0.25;
const MAX_SUBDIVISIONS = 24;

function quadAt(seg: SmoothSegment, t: number): Point2 {
	const mt = 1 - t;
	return {
		x: mt * mt * seg.from.x + 2 * mt * t * seg.ctrl.x + t * t * seg.to.x,
		y: mt * mt * seg.from.y + 2 * mt * t * seg.ctrl.y + t * t * seg.to.y,
	};
}

/**
 * Maximum distance between a quadratic and its chord, in screen pixels: half
 * the perpendicular distance from the control point to the chord.
 *
 * Note this is a geometric test, not the second-derivative one
 * (|P0 - 2·P1 + P2| / 8). That version reports curvature for a segment whose
 * control point sits ON the chord, which happens at the start and end of
 * every stroke, where the curve is straight and merely unevenly
 * parameterised. It would subdivide long straight strokes dozens of times for
 * nothing.
 */
export function segmentDeviationPx(seg: SmoothSegment, pxPerWorld: number): number {
	const ax = seg.to.x - seg.from.x;
	const ay = seg.to.y - seg.from.y;
	const cx = seg.ctrl.x - seg.from.x;
	const cy = seg.ctrl.y - seg.from.y;
	const chord = Math.hypot(ax, ay);
	const dist =
		chord < 1e-9
			? Math.hypot(cx, cy) // degenerate chord: control point is the bulge
			: Math.abs(cx * ay - cy * ax) / chord;
	return (dist / 2) * pxPerWorld;
}

/**
 * Subdivide by flatness, not by length. Splitting a quadratic into n pieces
 * cuts its deviation by n², so the count follows from how bent the segment is
 * and how magnified it is, nothing else.
 *
 * This matters in both directions. A long fast straight stroke needs exactly
 * one line no matter how far you zoom, and a tight little curl at 8× gets as
 * many pieces as it needs to stop looking polygonal.
 */
export function subdivisionsFor(seg: SmoothSegment, pxPerWorld: number): number {
	const dev = segmentDeviationPx(seg, pxPerWorld);
	if (!Number.isFinite(dev) || dev <= FLATTEN_TOLERANCE_PX) return 1;
	const n = Math.ceil(Math.sqrt(dev / FLATTEN_TOLERANCE_PX));
	return Math.max(1, Math.min(MAX_SUBDIVISIONS, n));
}

/**
 * Flatten one smoothed segment into ribbon points, excluding its start (the
 * previous segment already emitted it). Used by the wet layer, one segment at
 * a time, so drawing stays O(1) per sample.
 */
export function flattenSegment(
	seg: SmoothSegment,
	style: PenStyle,
	pxPerWorld: number
): RibbonPt[] {
	const n = subdivisionsFor(seg, pxPerWorld);
	const hw = widthForPressure(style, seg.pressure) / 2;
	const out: RibbonPt[] = [];
	for (let i = 1; i <= n; i++) {
		const p = quadAt(seg, i / n);
		out.push({ x: p.x, y: p.y, hw });
	}
	return out;
}

/**
 * Like flattenSegment, but the half-width is interpolated from hwFrom to
 * hwTo along the segment instead of held constant, so width flows through a
 * sample instead of stepping at it. Used by the shaped pipeline (InkShape).
 */
export function flattenSegmentHw(
	seg: SmoothSegment,
	hwFrom: number,
	hwTo: number,
	pxPerWorld: number
): RibbonPt[] {
	const n = subdivisionsFor(seg, pxPerWorld);
	const out: RibbonPt[] = [];
	for (let i = 1; i <= n; i++) {
		const t = i / n;
		const p = quadAt(seg, t);
		out.push({ x: p.x, y: p.y, hw: hwFrom + (hwTo - hwFrom) * t });
	}
	return out;
}

/**
 * The whole stroke as ribbon points. Used for committed rendering.
 *
 * `smooth` chooses the CENTERLINE, not the width law. With it on (the
 * default, and everything this function did before 1.4.6) the centerline is
 * the midpoint-quadratic curve: every sample becomes a control point, so the
 * drawn line never passes through the sample itself and every corner comes
 * out rounded. With it off the centerline is the raw polyline through the
 * stored samples - one ribbon point per sample, in order, unmoved.
 *
 * Why off exists: the "Ink smoothing" setting only ever switched SHAPING (the
 * width law in InkShape - pressure settling, velocity thinning, end taper).
 * `smoothSegments` ran unconditionally underneath it, so a user who turned
 * smoothing off still got rounded corners and no way to stop it - reported
 * with a photo on r/Onyx_Boox (batendalyn, Boox Tab XC, 2026-09-02:
 * "Stroke smoothing is still a little more aggressive for my taste", with
 * smoothing, prediction and pressure all off).
 *
 * The raw path needs no subdivision. `subdivisionsFor` already returns 1 for
 * a segment whose deviation from its chord is under the flatness tolerance,
 * and a straight run has zero deviation, so the smoothed path emits exactly
 * one point per straight segment too: the offsetter has never depended on
 * intermediate points, only on each point's neighbours. `ribbonSides` takes
 * its normal from a central difference, which at a sharp sample is the angle
 * bisector; the outside of the bend is left short, and `fillRibbon` already
 * covers that with the joint discs `jointIndices` finds (>= 12 degrees of
 * turn). So a raw corner draws as a mitred joint, not a fold, with no corner
 * treatment added here - the point of the setting is that nothing is added.
 */
export function flattenStroke(
	points: readonly InkPoint[],
	style: PenStyle,
	pxPerWorld: number,
	smooth = true
): RibbonPt[] {
	if (points.length === 0) return [];
	const first = points[0]!;
	if (points.length === 1) {
		return [{ x: first.x, y: first.y, hw: widthForPressure(style, first.pressure) / 2 }];
	}
	if (!smooth) {
		return points.map((p) => ({
			x: p.x,
			y: p.y,
			hw: widthForPressure(style, p.pressure) / 2,
		}));
	}
	const segs = smoothSegments(points);
	const out: RibbonPt[] = [
		{ x: segs[0]!.from.x, y: segs[0]!.from.y, hw: widthForPressure(style, segs[0]!.pressure) / 2 },
	];
	for (const seg of segs) {
		for (const p of flattenSegment(seg, style, pxPerWorld)) out.push(p);
	}
	return out;
}

export interface RibbonSides {
	left: Point2[];
	right: Point2[];
}

/**
 * Offset the centerline to both sides by its local half-width. Normals come
 * from a central difference so the width transitions smoothly instead of
 * stepping at each point.
 */
export function ribbonSides(pts: readonly RibbonPt[]): RibbonSides {
	const left: Point2[] = [];
	const right: Point2[] = [];
	const n = pts.length;
	for (let i = 0; i < n; i++) {
		const prev = pts[Math.max(0, i - 1)]!;
		const next = pts[Math.min(n - 1, i + 1)]!;
		const cur = pts[i]!;
		let tx = next.x - prev.x;
		let ty = next.y - prev.y;
		const len = Math.hypot(tx, ty);
		if (len < 1e-9) {
			tx = 1;
			ty = 0;
		} else {
			tx /= len;
			ty /= len;
		}
		// Normal is the tangent rotated 90°.
		const nx = -ty;
		const ny = tx;
		left.push({ x: cur.x + nx * cur.hw, y: cur.y + ny * cur.hw });
		right.push({ x: cur.x - nx * cur.hw, y: cur.y - ny * cur.hw });
	}
	return { left, right };
}

/**
 * Points where the path turns hard enough that the offset sides pinch and
 * leave a notch on the outside of the bend. A disc at each of these fills the
 * wedge; anywhere else it would be redundant work.
 */
export function jointIndices(pts: readonly RibbonPt[], minTurnDeg = 12): number[] {
	const out: number[] = [];
	for (let i = 1; i < pts.length - 1; i++) {
		const a = pts[i - 1]!;
		const b = pts[i]!;
		const c = pts[i + 1]!;
		const ux = b.x - a.x;
		const uy = b.y - a.y;
		const vx = c.x - b.x;
		const vy = c.y - b.y;
		const lu = Math.hypot(ux, uy);
		const lv = Math.hypot(vx, vy);
		if (lu < 1e-9 || lv < 1e-9) continue;
		const cos = Math.min(1, Math.max(-1, (ux * vx + uy * vy) / (lu * lv)));
		if ((Math.acos(cos) * 180) / Math.PI >= minTurnDeg) out.push(i);
	}
	return out;
}
