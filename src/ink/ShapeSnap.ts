import { InkPoint, InkStroke, newStrokeId } from "./Stroke";
import { computeBBox } from "./Stroke";

/**
 * Handwriting to shapes (roadmap, 2026-08-27). Hold the pen still at the
 * end of a stroke and the wobbly figure snaps to the clean one you meant:
 * line, triangle, rectangle, circle or ellipse.
 *
 * The dwell IS the request. Recognition never runs on an ordinary lift,
 * so nothing about normal writing changes - a deliberate ~third-of-a-
 * second hold is the whole gesture. Everything here is pure geometry on
 * the stroke's own points: no models, no network, works identically on
 * every platform.
 *
 * The recognizer is honest about ambiguity: it classifies only when the
 * fit error is small relative to the figure's size, and returns null
 * otherwise - a null keeps the freehand stroke exactly as drawn.
 */

/** The hold that asks for a snap: this long ... */
export const DWELL_MS = 350;
/** ... within this world-unit radius (a few screen px). */
export const DWELL_RADIUS = 3;
/** Ignore flicks and dots: a snap candidate has some size to it. */
const MIN_PATH_LENGTH = 24;
/** Endpoints closer than this fraction of path length close the figure. */
const CLOSURE_FRACTION = 0.22;
/** RDP simplification tolerance as a fraction of the bbox diagonal. */
/** Max mean radial error for a circle/ellipse, fraction of mean radius. */
const ROUND_TOLERANCE = 0.16;
/** Max perpendicular deviation for a line, fraction of its length. */
const LINE_TOLERANCE = 0.05;
/** Synthesized point spacing in world units. */
const SYNTH_STEP = 3;

export type SnappedKind = "line" | "triangle" | "rectangle" | "circle" | "ellipse";

export interface SnapResult {
	kind: SnappedKind;
	points: InkPoint[];
}

interface P {
	x: number;
	y: number;
}

function dist(a: P, b: P): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

function pathLength(pts: readonly P[]): number {
	let len = 0;
	for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1]!, pts[i]!);
	return len;
}

/**
 * Did the stroke end with a deliberate hold? True when the final DWELL_MS
 * of samples stay inside DWELL_RADIUS. Returns the index where the dwell
 * begins (so the recognizer can drop the parked tail), or null.
 */
export function dwellStart(points: readonly InkPoint[]): number | null {
	if (points.length < 4) return null;
	// A dot is not a snap request, however long it is held: the WHOLE
	// stroke sitting inside the dwell radius means nothing was drawn.
	let aMinX = Infinity;
	let aMinY = Infinity;
	let aMaxX = -Infinity;
	let aMaxY = -Infinity;
	for (const p of points) {
		if (p.x < aMinX) aMinX = p.x;
		if (p.y < aMinY) aMinY = p.y;
		if (p.x > aMaxX) aMaxX = p.x;
		if (p.y > aMaxY) aMaxY = p.y;
	}
	if (Math.hypot(aMaxX - aMinX, aMaxY - aMinY) <= DWELL_RADIUS * 2) return null;
	const endT = points[points.length - 1]!.t;
	let i = points.length - 1;
	while (i > 0 && endT - points[i - 1]!.t <= DWELL_MS) i--;
	if (i < 4) return null; // all (or nearly all) dwell: that is a dot
	const tail = points.slice(i);
	if ((points[points.length - 1]!.t - tail[0]!.t) < DWELL_MS * 0.8) return null;
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const p of tail) {
		if (p.x < minX) minX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.x > maxX) maxX = p.x;
		if (p.y > maxY) maxY = p.y;
	}
	if (Math.hypot(maxX - minX, maxY - minY) > DWELL_RADIUS * 2) return null;
	return i;
}

/** Ramer-Douglas-Peucker, returning the kept vertices. */
export function simplify(pts: readonly P[], tolerance: number): P[] {
	if (pts.length <= 2) return [...pts];
	const keep = new Array<boolean>(pts.length).fill(false);
	keep[0] = true;
	keep[pts.length - 1] = true;
	const stack: Array<[number, number]> = [[0, pts.length - 1]];
	while (stack.length > 0) {
		const [a, b] = stack.pop()!;
		const pa = pts[a]!;
		const pb = pts[b]!;
		const len = dist(pa, pb);
		let worst = -1;
		let worstD = tolerance;
		for (let i = a + 1; i < b; i++) {
			const p = pts[i]!;
			const d =
				len === 0
					? dist(p, pa)
					: Math.abs((pb.x - pa.x) * (pa.y - p.y) - (pa.x - p.x) * (pb.y - pa.y)) / len;
			if (d > worstD) {
				worstD = d;
				worst = i;
			}
		}
		if (worst >= 0) {
			keep[worst] = true;
			stack.push([a, worst], [worst, b]);
		}
	}
	return pts.filter((_, i) => keep[i]);
}

/** Resample a closed outline to n points at equal arc spacing. */
function resampleClosed(pts: readonly P[], n: number): P[] {
	const closed = [...pts, pts[0]!];
	const total = pathLength(closed);
	const step = total / n;
	const out: P[] = [];
	let i = 0;
	let acc = 0;
	for (let k = 0; k < n; k++) {
		const target = k * step;
		while (i < closed.length - 2 && acc + dist(closed[i]!, closed[i + 1]!) < target) {
			acc += dist(closed[i]!, closed[i + 1]!);
			i++;
		}
		const a = closed[i]!;
		const b = closed[i + 1]!;
		const seg = dist(a, b);
		const f = seg === 0 ? 0 : (target - acc) / seg;
		out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
	}
	return out;
}

function meanRadialError(pts: readonly P[], cx: number, cy: number, rx: number, ry: number): number {
	let err = 0;
	for (const p of pts) {
		// Normalized radial distance for an axis-aligned ellipse: 1 on the rim.
		const nx = (p.x - cx) / rx;
		const ny = (p.y - cy) / ry;
		err += Math.abs(Math.hypot(nx, ny) - 1);
	}
	return err / pts.length;
}

function classifyClosed(body: readonly P[], gapFrac: number): SnapResult | null {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const p of body) {
		if (p.x < minX) minX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.x > maxX) maxX = p.x;
		if (p.y > maxY) maxY = p.y;
	}
	const w = maxX - minX;
	const h = maxY - minY;
	if (w < 4 || h < 4) return null;
	const cx = (minX + maxX) / 2;
	const cy = (minY + maxY) / 2;

	const roundErr = meanRadialError(body, cx, cy, w / 2, h / 2);
	const diag = Math.hypot(w, h);

	// CORNERS OUTRANK ROUNDNESS, found by curvature concentration on an
	// equal-arc resampling of the ring. A corner is a large direction
	// change inside a small window (a square's 90 deg arrives all at
	// once); a circle spreads its 360 evenly (about 34 deg per window at
	// this k), so no window ever spikes. Radial fit alone once called
	// squares circles - a perfect square's mean radial error is 0.148,
	// inside any tolerance loose enough to accept a hand circle
	// (hardware, 2026-08-27).
	const N = 64;
	const K = 3;
	const ring = resampleClosed(body, N);
	// Ring samples past this index lie on the synthetic closing chord, not
	// on ink. A gap that swallowed a whole corner made the chord read as a
	// triangle edge and the classifier fit evidence the pen never drew
	// (hardware, 2026-08-27): chord samples are masked out of corner
	// detection and fit, and junction spikes where chord meets ink too.
	// Only a substantial gap can fake an edge; a small one (seam at a
	// corner) must not mask the real corner sitting there.
	const chordStart = gapFrac > 0.05 ? Math.floor(N * (1 - gapFrac)) : N;
	const onChord = (i: number): boolean => chordStart < N && (i >= chordStart - K || i < K);
	const turns: number[] = new Array(N);
	for (let i = 0; i < N; i++) {
		const a = ring[(i - K + N) % N]!;
		const c = ring[i]!;
		const b = ring[(i + K) % N]!;
		const a1 = Math.atan2(c.y - a.y, c.x - a.x);
		const a2 = Math.atan2(b.y - c.y, b.x - c.x);
		let turn = Math.abs(a2 - a1);
		if (turn > Math.PI) turn = 2 * Math.PI - turn;
		turns[i] = turn;
	}
	// Adaptive threshold: a corner is a turn that towers over the ring's
	// OWN median. A square's median is its near-zero edge turn, so even a
	// well-rounded corner (40-55 deg in the window) towers and counts -
	// the fixed 55 deg bar dropped those and made squares into triangles
	// (hardware, 2026-08-27). A circle's median IS its uniform ~34 deg, so
	// its threshold rises far above anything on the ring.
	const sortedTurns = [...turns].sort((a, b) => a - b);
	const median = sortedTurns[N >> 1]!;
	const threshold = Math.max((40 * Math.PI) / 180, median * 3);
	const strongIdx: number[] = [];
	for (let i = 0; i < N; i++) {
		if (onChord(i)) continue;
		if (turns[i]! <= threshold) continue;
		let isMax = true;
		for (let d = -K - 1; d <= K + 1; d++) {
			if (d === 0) continue;
			const j = (i + d + N) % N;
			if (turns[j]! > turns[i]! || (turns[j]! === turns[i]! && j < i)) {
				isMax = false;
				break;
			}
		}
		if (isMax) strongIdx.push(i);
	}
	let strong: P[] = strongIdx.map((i) => ring[i]!);

	// FIT-VERIFIED synthesis: the shape has to actually hug the drawn
	// outline to win. One rounded corner kept slipping under every
	// threshold and squares came out triangles (hardware, 2026-08-27) -
	// now a triangle that fits poorly gets the strongest suppressed peak
	// rescued as a fourth corner and the two candidates compete on fit,
	// and any polygon that still fits badly falls back to freehand.
	const FIT_TOL = 0.05;
	if (strong.length === 3) {
		let err = polygonFitError(ring, strong, diag, onChord);
		if (err > FIT_TOL) {
			let best = -1;
			let bestTurn = (25 * Math.PI) / 180;
			for (let i = 0; i < N; i++) {
				if (onChord(i)) continue;
				if (strongIdx.some((k) => Math.min(Math.abs(i - k), N - Math.abs(i - k)) <= K + 1)) continue;
				if (turns[i]! > bestTurn) {
					bestTurn = turns[i]!;
					best = i;
				}
			}
			if (best >= 0) {
				const rescuedIdx = [...strongIdx, best].sort((a, b) => a - b);
				const rescued = rescuedIdx.map((i) => ring[i]!);
				const e2 = polygonFitError(ring, rescued, diag, onChord);
				if (e2 < err) {
					strong = rescued;
					err = e2;
				}
			}
		}
		// A gap that swallowed a corner leaves only three drawn corners.
		// The undrawn one sits where the outline's two loose ends point:
		// complete it from the edge directions at the gap and let the quad
		// compete on (masked) fit.
		if (strong.length === 3 && gapFrac > 0.06) {
			const completed = completeGapCorner(body, w, h);
			if (completed) {
				const quad = [...strong, completed];
				const e3 = polygonFitError(ring, quad, diag, onChord);
				if (e3 < err && e3 <= FIT_TOL) {
					strong = quad;
					err = e3;
				}
			}
		}
		if (err > FIT_TOL) return null;
		if (strong.length === 3) return { kind: "triangle", points: synthPolygon(strong) };
	}
	if (strong.length === 4) {
		if (polygonFitError(ring, strong, diag, onChord) > FIT_TOL) return null;
		// Snap near-axis-aligned quads to the true rectangle of their bbox;
		// keep a deliberate diamond/parallelogram on its own corners.
		const axisAligned = strong.every(
			(c) =>
				Math.min(Math.abs(c.x - minX), Math.abs(c.x - maxX)) < w * 0.2 &&
				Math.min(Math.abs(c.y - minY), Math.abs(c.y - maxY)) < h * 0.2
		);
		if (axisAligned) {
			return {
				kind: "rectangle",
				points: synthPolygon([
					{ x: minX, y: minY },
					{ x: maxX, y: minY },
					{ x: maxX, y: maxY },
					{ x: minX, y: maxY },
				]),
			};
		}
		return { kind: "rectangle", points: synthPolygon(strong) };
	}
	// Round needs a cornerless outline (an extreme ellipse's tips can
	// register as up to two curvature spikes); a soft-cornered square
	// rejected above stays freehand rather than becoming a circle.
	if (strong.length <= 2 && roundErr < ROUND_TOLERANCE) {
		const aspect = w / h;
		if (aspect > 0.8 && aspect < 1.25) {
			const r = (w + h) / 4;
			return { kind: "circle", points: synthEllipse(cx, cy, r, r) };
		}
		return { kind: "ellipse", points: synthEllipse(cx, cy, w / 2, h / 2) };
	}
	return null;
}

/**
 * The corner the pen never drew: where the outline's two loose ends point.
 * Averages a few samples at each end for a stable direction; null when the
 * lines are near-parallel or the intersection flies far outside the figure.
 */
function completeGapCorner(body: readonly P[], w: number, h: number): P | null {
	const m = Math.min(6, Math.floor(body.length / 4));
	if (m < 2) return null;
	const a0 = body[0]!;
	const a1 = body[m]!;
	const b0 = body[body.length - 1]!;
	const b1 = body[body.length - 1 - m]!;
	// Rays leaving the drawn ink at each end: from a1 through a0, from b1
	// through b0.
	const dax = a0.x - a1.x;
	const day = a0.y - a1.y;
	const dbx = b0.x - b1.x;
	const dby = b0.y - b1.y;
	const denom = dax * dby - day * dbx;
	if (Math.abs(denom) < 1e-6) return null;
	const t = ((b0.x - a0.x) * dby - (b0.y - a0.y) * dbx) / denom;
	const x = a0.x + dax * t;
	const y = a0.y + day * t;
	const cx = (Math.min(a0.x, b0.x) + Math.max(a0.x, b0.x)) / 2;
	const cy = (Math.min(a0.y, b0.y) + Math.max(a0.y, b0.y)) / 2;
	if (Math.hypot(x - cx, y - cy) > Math.hypot(w, h)) return null;
	return { x, y };
}

/** Mean distance from ring points to the polygon outline, over diag. */
function polygonFitError(
	ring: readonly P[],
	corners: readonly P[],
	diag: number,
	skip?: (i: number) => boolean
): number {
	let total = 0;
	let counted = 0;
	for (let ri = 0; ri < ring.length; ri++) {
		if (skip?.(ri)) continue;
		const p = ring[ri]!;
		counted++;
		let best = Infinity;
		for (let i = 0; i < corners.length; i++) {
			const a = corners[i]!;
			const b = corners[(i + 1) % corners.length]!;
			const vx = b.x - a.x;
			const vy = b.y - a.y;
			const ll = vx * vx + vy * vy;
			const t = ll === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / ll));
			const d = Math.hypot(p.x - (a.x + vx * t), p.y - (a.y + vy * t));
			if (d < best) best = d;
		}
		total += best;
	}
	if (counted === 0) return Infinity;
	return total / counted / diag;
}

function classifyOpen(body: readonly P[]): SnapResult | null {
	const a = body[0]!;
	const b = body[body.length - 1]!;
	const len = dist(a, b);
	if (len < MIN_PATH_LENGTH) return null;
	let worst = 0;
	for (const p of body) {
		const d = Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / len;
		if (d > worst) worst = d;
	}
	if (worst > len * LINE_TOLERANCE) return null;
	return { kind: "line", points: synthSegment(a, b) };
}

function synthSegment(a: P, b: P): InkPoint[] {
	const len = dist(a, b);
	const n = Math.max(2, Math.ceil(len / SYNTH_STEP));
	const out: InkPoint[] = [];
	for (let i = 0; i <= n; i++) {
		const f = i / n;
		out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, pressure: 0.5, t: i * 8 });
	}
	return out;
}

function synthPolygon(corners: readonly P[]): InkPoint[] {
	const out: InkPoint[] = [];
	let t = 0;
	for (let i = 0; i < corners.length; i++) {
		const a = corners[i]!;
		const b = corners[(i + 1) % corners.length]!;
		const len = dist(a, b);
		const n = Math.max(1, Math.ceil(len / SYNTH_STEP));
		for (let j = 0; j < n; j++) {
			const f = j / n;
			out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, pressure: 0.5, t });
			t += 8;
		}
	}
	// Close the outline and continue one step past the corner, so the end
	// cap buries in the first edge instead of meeting the start cap.
	out.push({ ...out[0]!, t });
	if (out.length > 2) out.push({ ...out[1]!, t: t + 8 });
	return out;
}

function synthEllipse(cx: number, cy: number, rx: number, ry: number): InkPoint[] {
	const circumference = Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry)));
	const n = Math.max(16, Math.ceil(circumference / SYNTH_STEP));
	const out: InkPoint[] = [];
	// Two steps past full circle: start and end caps land mid-line instead
	// of meeting at the seam, which rendered as a notch at the top
	// (hardware, 2026-08-27).
	for (let i = 0; i <= n + 2; i++) {
		const a = (i / n) * Math.PI * 2 - Math.PI / 2;
		out.push({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry, pressure: 0.5, t: i * 8 });
	}
	return out;
}

/** Tuning lens: what the classifier saw. Diagnostics only. */
export function diagnoseShape(points: readonly InkPoint[]): Record<string, unknown> {
	const start = dwellStart(points);
	if (start === null) return { dwell: false };
	const body = points.slice(0, Math.max(start, 2)) as unknown as P[];
	const len = pathLength(body);
	const gap = dist(body[0]!, body[body.length - 1]!);
	const closed = gap < len * CLOSURE_FRACTION;
	const out: Record<string, unknown> = {
		dwell: true,
		bodyPts: body.length,
		len: Math.round(len),
		gapFrac: +(gap / len).toFixed(2),
		closed,
	};
	if (closed && body.length >= 8) {
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const q of body) {
			if (q.x < minX) minX = q.x;
			if (q.y < minY) minY = q.y;
			if (q.x > maxX) maxX = q.x;
			if (q.y > maxY) maxY = q.y;
		}
		const w = maxX - minX, h = maxY - minY;
		const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
		out.roundErr = +meanRadialError(body, cx, cy, w / 2, h / 2).toFixed(3);
		const N = 64, K = 3;
		const ring = resampleClosed(body, N);
		const turns: number[] = [];
		for (let i = 0; i < N; i++) {
			const a = ring[(i - K + N) % N]!;
			const c = ring[i]!;
			const b2 = ring[(i + K) % N]!;
			const a1 = Math.atan2(c.y - a.y, c.x - a.x);
			const a2 = Math.atan2(b2.y - c.y, b2.x - c.x);
			let t = Math.abs(a2 - a1);
			if (t > Math.PI) t = 2 * Math.PI - t;
			turns.push((t * 180) / Math.PI);
		}
		const sorted = [...turns].sort((x, y) => x - y);
		out.turnMedianDeg = +sorted[32]!.toFixed(0);
		out.turnPeaksDeg = turns
			.map((t, i) => ({ t, i }))
			.filter(({ t, i }) => {
				if (t <= 55) return false;
				for (let d = -4; d <= 4; d++) {
					if (d === 0) continue;
					const j = (i + d + N) % N;
					if (turns[j]! > t || (turns[j]! === t && j < i)) return false;
				}
				return true;
			})
			.map(({ t }) => Math.round(t));
	}
	return out;
}

/**
 * The whole gesture: a stroke that ended in a dwell either becomes its
 * clean shape or stays itself. Null = no dwell, or nothing recognizable.
 */
export function snapStroke(stroke: InkStroke, dwellConfirmed = false): InkStroke | null {
	// The stroke builder's min-distance filter DISCARDS stationary samples,
	// so a real hold leaves no tail in the stored points - dwell detection
	// from points alone missed nearly every genuine hold (diagnosed on 95
	// hardware strokes, 2026-08-27). The overlay now measures the hold at
	// the raw input layer and passes dwellConfirmed; the points-based path
	// below survives for synthetic tests and any caller without raw timing.
	let body: InkPoint[];
	if (dwellConfirmed) {
		body = [...stroke.points];
	} else {
		const start = dwellStart(stroke.points);
		if (start === null) return null;
		body = stroke.points.slice(0, Math.max(start, 2));
	}
	if (body.length < 8) return null;
	const len = pathLength(body);
	if (len < MIN_PATH_LENGTH) return null;
	const gap = dist(body[0]!, body[body.length - 1]!);
	const closed = gap < len * CLOSURE_FRACTION;
	const result = closed ? classifyClosed(body, gap / (len + gap)) : classifyOpen(body);
	if (!result) return null;
	const width = stroke.width;
	return {
		id: newStrokeId(),
		tool: stroke.tool,
		color: stroke.color,
		width,
		points: result.points,
		bbox: computeBBox(result.points, width * 2),
		createdAt: stroke.createdAt,
		...(stroke.device === "mouse" ? { device: stroke.device } : {}),
	};
}
