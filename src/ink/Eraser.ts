import { BBox, InkPoint, InkStroke, computeBBox } from "./Stroke";

/**
 * Whole-stroke eraser hit-testing (handoff §24, §77).
 *
 * MVP semantics: the eraser is a circle in world space; any stroke it touches
 * is deleted entirely. Partial erase (splitting a stroke into surviving
 * sub-strokes) is explicitly not a prerequisite.
 *
 * Two phases, because a page can hold thousands of strokes and this runs on
 * every eraser sample: reject by bounding box first, then do the exact
 * segment-circle test only on the survivors. A spatial index can replace the
 * linear scan later without changing this interface.
 */

export function bboxHitsCircle(box: BBox, cx: number, cy: number, r: number): boolean {
	const nearestX = Math.max(box.x, Math.min(cx, box.x + box.width));
	const nearestY = Math.max(box.y, Math.min(cy, box.y + box.height));
	const dx = cx - nearestX;
	const dy = cy - nearestY;
	return dx * dx + dy * dy <= r * r;
}

/** Squared distance from a point to segment AB. */
export function pointSegmentDistSq(
	px: number,
	py: number,
	ax: number,
	ay: number,
	bx: number,
	by: number
): number {
	const abx = bx - ax;
	const aby = by - ay;
	const apx = px - ax;
	const apy = py - ay;
	const lenSq = abx * abx + aby * aby;
	let t = lenSq > 0 ? (apx * abx + apy * aby) / lenSq : 0;
	if (t < 0) t = 0;
	else if (t > 1) t = 1;
	const dx = ax + abx * t - px;
	const dy = ay + aby * t - py;
	return dx * dx + dy * dy;
}

export function strokeHitsCircle(
	stroke: InkStroke,
	cx: number,
	cy: number,
	r: number
): boolean {
	if (!bboxHitsCircle(stroke.bbox, cx, cy, r)) return false;
	const pts = stroke.points;
	const rSq = r * r;
	if (pts.length === 1) {
		const p = pts[0]!;
		return (p.x - cx) ** 2 + (p.y - cy) ** 2 <= rSq;
	}
	for (let i = 1; i < pts.length; i++) {
		const a = pts[i - 1]!;
		const b = pts[i]!;
		if (pointSegmentDistSq(cx, cy, a.x, a.y, b.x, b.y) <= rSq) return true;
	}
	return false;
}

/** Ids of every stroke the eraser circle touches. */
export function strokesHitByCircle(
	strokes: readonly InkStroke[],
	cx: number,
	cy: number,
	r: number
): string[] {
	const hits: string[] = [];
	for (const s of strokes) {
		if (strokeHitsCircle(s, cx, cy, r)) hits.push(s.id);
	}
	return hits;
}


/**
 * Partial erase (v0.13.13): what survives dragging a circle across one stroke.
 *
 * The whole-stroke test above answers "does this circle touch the stroke".
 * This answers "what is left of it". The cut is made where the stroke CROSSES
 * the ring, not at the nearest stored sample, so a fast stroke sampled every
 * 30px erases exactly like a slow one sampled every 2px. Dropping whole
 * samples instead would let a small eraser pass clean through a quick line
 * and take nothing.
 *
 * Each surviving run becomes its own stroke, so erasing through the middle of
 * a line leaves two lines. The stroke itself comes back (same object, same id)
 * when the circle missed entirely, so an eraser pass over untouched ink
 * allocates nothing. An empty array means the circle took all of it.
 */
export function splitStrokeByCircle(
	stroke: InkStroke,
	cx: number,
	cy: number,
	r: number,
	makeId: () => string
): InkStroke[] {
	const pts = stroke.points;
	if (pts.length === 0) return [];
	const rSq = r * r;
	const inside = (p: InkPoint): boolean => {
		const dx = p.x - cx;
		const dy = p.y - cy;
		return dx * dx + dy * dy <= rSq;
	};
	if (pts.length === 1) return inside(pts[0]!) ? [] : [stroke];

	const runs: InkPoint[][] = [];
	let run: InkPoint[] = [];
	let cut = false;
	const close = (): void => {
		if (run.length > 0) runs.push(run);
		run = [];
	};

	if (inside(pts[0]!)) cut = true;
	else run.push(pts[0]!);

	for (let i = 0; i < pts.length - 1; i++) {
		const a = pts[i]!;
		const b = pts[i + 1]!;
		const aIn = inside(a);
		const bIn = inside(b);
		if (aIn && bIn) {
			// A circle is convex, so both ends inside means all of it is.
			cut = true;
			close();
			continue;
		}
		const crossings = segmentCircleCrossings(a, b, cx, cy, r);
		if (!aIn && !bIn) {
			if (crossings.length === 2) {
				// Straight through: keep both ends, lose the middle.
				cut = true;
				run.push(lerpPoint(a, b, crossings[0]!));
				close();
				run.push(lerpPoint(a, b, crossings[1]!));
			}
			run.push(b);
			continue;
		}
		if (!aIn && bIn) {
			cut = true;
			if (crossings.length > 0) run.push(lerpPoint(a, b, crossings[0]!));
			close();
			continue;
		}
		// Leaving the circle: the survivor starts on the ring.
		cut = true;
		if (crossings.length > 0) run.push(lerpPoint(a, b, crossings[crossings.length - 1]!));
		run.push(b);
	}
	close();

	if (!cut) return [stroke];
	const out: InkStroke[] = [];
	for (const points of runs) {
		// A lone survivor still has to be drawable, the same way a tap is.
		const kept =
			points.length === 1
				? [points[0]!, { ...points[0]!, x: points[0]!.x + 0.01, t: points[0]!.t + 1 }]
				: points;
		out.push({
			...stroke,
			id: makeId(),
			points: kept,
			bbox: computeBBox(kept, stroke.width * 2),
		});
	}
	return out;
}

/**
 * Where segment AB crosses the circle, as fractions along AB in (0,1),
 * ascending. Endpoints exactly on the ring are not crossings: the caller
 * already knows which side each end is on, and counting them would emit
 * zero-length pieces.
 */
export function segmentCircleCrossings(
	a: InkPoint,
	b: InkPoint,
	cx: number,
	cy: number,
	r: number
): number[] {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const A = dx * dx + dy * dy;
	if (A <= 1e-12) return [];
	const fx = a.x - cx;
	const fy = a.y - cy;
	const B = 2 * (fx * dx + fy * dy);
	const C = fx * fx + fy * fy - r * r;
	const disc = B * B - 4 * A * C;
	if (disc <= 0) return [];
	const root = Math.sqrt(disc);
	const out: number[] = [];
	for (const t of [(-B - root) / (2 * A), (-B + root) / (2 * A)]) {
		if (t > 0 && t < 1) out.push(t);
	}
	return out;
}

/** Straight-line blend of every sample field, for a point born on the ring. */
function lerpPoint(a: InkPoint, b: InkPoint, t: number): InkPoint {
	const p: InkPoint = {
		x: a.x + (b.x - a.x) * t,
		y: a.y + (b.y - a.y) * t,
		pressure: a.pressure + (b.pressure - a.pressure) * t,
		t: Math.round(a.t + (b.t - a.t) * t),
	};
	if (a.tiltX !== undefined && b.tiltX !== undefined) {
		p.tiltX = a.tiltX + (b.tiltX - a.tiltX) * t;
	}
	if (a.tiltY !== undefined && b.tiltY !== undefined) {
		p.tiltY = a.tiltY + (b.tiltY - a.tiltY) * t;
	}
	return p;
}
