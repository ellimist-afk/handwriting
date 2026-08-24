import { BBox, InkStroke } from "./Stroke";

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
