import { InkPoint, InkStroke, newStrokeId } from "./Stroke";
import { computeBBox } from "./Stroke";

/**
 * Handwriting to shapes (roadmap, 2026-08-27). Hold the pen still at the
 * end of a stroke and the wobbly figure snaps to the clean one you meant:
 * line, arrow, triangle, rectangle, pentagon, hexagon, octagon, star, circle or ellipse.
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

/** Why the last snapStroke call kept its stroke as drawn, for tuning tests; the app never reads it. */
let missWhy: string | null = null;
function miss(why: string): null {
	missWhy = why;
	return null;
}
/** Why the last snapStroke call returned null (the first check that turned the stroke down), or null when it snapped. */
export function lastSnapMiss(): string | null {
	return missWhy;
}

export type SnappedKind =
	| "line"
	| "arrow"
	| "double-arrow"
	| "triangle"
	| "rectangle"
	| "pentagon"
	| "hexagon"
	| "octagon"
	| "star"
	| "circle"
	| "ellipse";

/** The figures with more than four corners that snap, by their corner count. */
const POLYGON_KINDS: Partial<Record<number, SnappedKind>> = { 5: "pentagon", 6: "hexagon", 8: "octagon" };
/** A figure of five, six or eight corners snaps only when every drawn corner is within this fraction of its radius of the regular figure's. */
const REGULAR_SLACK = 0.2;
/** A many-sided figure the corners missed wins over the round fit only when its mean radial miss is under this share of the round one's. */
const POLYGON_OVER_ROUND = 0.7;

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
	const byCorners = classifyByCorners(body, gapFrac);
	if (byCorners && byCorners.kind !== "circle" && byCorners.kind !== "ellipse") return byCorners;
	// Five, six and eight corners spread a figure's turning over so many places that a hand's wobble can hide some of them
	// from the corner count (an octagon's 45 deg is close to what a circle turns in the same window); the outline's own
	// distance from its centre still shows the sides. Only what would otherwise be round or freehand gets this second look.
	return classifyStar(body, gapFrac) ?? roundPolygon(body, gapFrac) ?? byCorners;
}

function classifyByCorners(body: readonly P[], gapFrac: number): SnapResult | null {
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
	const turns: number[] = new Array<number>(N);
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
	// A PATH THAT CROSSES ITSELF IS NO POLYGON. A pentagram stopped short of the point it started on has that point inside
	// the gap's masked stretch, so four of its five points count as corners, and three of its five lines run along the
	// four-corner outline they make: the order-free fit passed it, and it snapped to a box. A triangle, rectangle or
	// many-cornered figure never crosses its own outline; a crossing where the pen's two ends meet (the seam: the masked
	// stretch, or a few samples either side of the start when the ends close) is a hand closing the shape, not a crossing.
	// Round figures are judged as before.
	if (strong.length >= 3) {
		const seam = (i: number): boolean => onChord(i) || (chordStart >= N && (i < K || i >= N - K));
		const segmentInSeam = (i: number): boolean => seam(i) || seam((i + 1) % N);
		if (ringCrossesItself(ring, segmentInSeam)) return null;
	}

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
	const many = POLYGON_KINDS[strong.length];
	if (many) {
		if (polygonFitError(ring, strong, diag, onChord) > FIT_TOL) return null;
		const regular = regularized(strong);
		return regular ? { kind: many, points: synthPolygon(regular) } : null;
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
 * The regular figure the drawn corners (in their order round the outline) are near: same centre, their mean radius, the
 * turn that best matches them. Null when any corner sits more than REGULAR_SLACK of the radius from its place: uneven
 * corners are an uneven figure, or a regular one with a corner the count missed (seven corners read as six), and stay as drawn.
 */
function regularized(corners: readonly P[]): P[] | null {
	const n = corners.length;
	const cx = corners.reduce((a, c) => a + c.x, 0) / n;
	const cy = corners.reduce((a, c) => a + c.y, 0) / n;
	const r = corners.reduce((a, c) => a + Math.hypot(c.x - cx, c.y - cy), 0) / n;
	let area = 0;
	for (let i = 0; i < n; i++) {
		const a = corners[i]!;
		const b = corners[(i + 1) % n]!;
		area += a.x * b.y - b.x * a.y;
	}
	const dir = area < 0 ? -1 : 1;
	let sx = 0;
	let sy = 0;
	for (let i = 0; i < n; i++) {
		const c = corners[i]!;
		const a = Math.atan2(c.y - cy, c.x - cx) - (dir * 2 * Math.PI * i) / n;
		sx += Math.cos(a);
		sy += Math.sin(a);
	}
	const phase = Math.atan2(sy, sx);
	const regular = Array.from({ length: n }, (_, i) => {
		const a = phase + (dir * 2 * Math.PI * i) / n;
		return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
	});
	return corners.some((c, i) => dist(c, regular[i]!) > r * REGULAR_SLACK) ? null : regular;
}

/**
 * The second look for five, six and eight corners: the outline's distance from its centre against that of a regular
 * figure of n sides, at its best radius and turn, for n of 3 to 8, and against a circle's. A five-, six- or eight-sided
 * figure that beats every other count and misses by under POLYGON_OVER_ROUND of the circle's miss snaps to that figure;
 * anything else is left to the corner and round fits. Squat or tall outlines are not regular figures and are not looked at.
 */
function roundPolygon(body: readonly P[], gapFrac: number): SnapResult | null {
	const N = 64;
	const K = 3;
	const ring = resampleClosed(body, N);
	const chordStart = gapFrac > 0.05 ? Math.floor(N * (1 - gapFrac)) : N;
	const keep = ring.filter((_, i) => !(chordStart < N && (i >= chordStart - K || i < K)));
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const p of keep) {
		if (p.x < minX) minX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.x > maxX) maxX = p.x;
		if (p.y > maxY) maxY = p.y;
	}
	const w = maxX - minX;
	const h = maxY - minY;
	if (keep.length < N / 2 || w < 4 || h < 4 || w / h < 0.8 || w / h > 1.25) return null;
	// The centre of an outline sampled at equal steps along it: a regular figure's own centre, not its box's.
	const cx = ring.reduce((a, p) => a + p.x, 0) / N;
	const cy = ring.reduce((a, p) => a + p.y, 0) / N;
	const diag = Math.hypot(w, h);
	const rho = keep.map((p) => Math.hypot(p.x - cx, p.y - cy));
	const theta = keep.map((p) => Math.atan2(p.y - cy, p.x - cx));
	const meanR = rho.reduce((a, b) => a + b, 0) / rho.length;
	const roundMiss = rho.reduce((a, b) => a + Math.abs(b - meanR), 0) / rho.length / diag;
	let best: { n: number; miss: number; r: number; phase: number } | null = null;
	for (let n = 3; n <= 8; n++) {
		const half = Math.PI / n;
		for (let s = 0; s < 36; s++) {
			const phase = (s / 36) * 2 * half;
			// A regular figure of circumradius 1 lies at cos(half) / cos(offset from the nearest side's middle) from its centre.
			const unit = theta.map((t) => {
				let u = (t - phase) % (2 * half);
				if (u < 0) u += 2 * half;
				return Math.cos(half) / Math.cos(u - half);
			});
			let num = 0;
			let den = 0;
			for (let i = 0; i < unit.length; i++) {
				num += rho[i]! * unit[i]!;
				den += unit[i]! * unit[i]!;
			}
			const r = num / den;
			let miss = 0;
			for (let i = 0; i < unit.length; i++) miss += Math.abs(rho[i]! - r * unit[i]!);
			miss /= unit.length * diag;
			if (!best || miss < best.miss) best = { n, miss, r, phase };
		}
	}
	if (!best) return null;
	const kind = POLYGON_KINDS[best.n];
	if (!kind || best.miss > 0.05 || best.miss > roundMiss * POLYGON_OVER_ROUND) return null;
	const { n, r, phase } = best;
	const corners = Array.from({ length: n }, (_, i) => {
		const a = phase + (2 * Math.PI * i) / n;
		return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
	});
	return { kind, points: synthPolygon(corners) };
}

/** A five-point star's inner corners sit at this share of its points' radius: the star a pentagram's lines outline. */
const STAR_INNER = Math.cos((2 * Math.PI) / 5) / Math.cos(Math.PI / 5);

/**
 * A five-point star, drawn either as its outline (ten corners, in and out) or as a pentagram (five lines from point to
 * point, crossing). Either way the pen's distance from the centre peaks five times, at the points, and dips well inside
 * between them. It snaps to the regular star turned to the drawn points when the drawing
 * hugs that star's outline or its pentagram; a five-petal flower's round petals miss both by more.
 */
function classifyStar(body: readonly P[], gapFrac: number): SnapResult | null {
	const N = 120;
	const ring = resampleClosed(body, N);
	const chordStart = gapFrac > 0.05 ? Math.floor(N * (1 - gapFrac)) : N;
	const onChord = (i: number): boolean => chordStart < N && (i >= chordStart - 2 || i < 2);
	const cx = ring.reduce((a, p) => a + p.x, 0) / N;
	const cy = ring.reduce((a, p) => a + p.y, 0) / N;
	const rho = ring.map((p) => Math.hypot(p.x - cx, p.y - cy));
	const outer = Math.max(...rho);
	if (!(outer > 0)) return null;
	// The points: the furthest sample in each run of samples beyond the middle radius.
	const mid = outer * 0.65;
	let start = rho.findIndex((r) => r < mid);
	if (start < 0) return null;
	const tips: P[] = [];
	let run = -1;
	for (let k = 1; k <= N; k++) {
		const i = (start + k) % N;
		if (rho[i]! >= mid) {
			if (run < 0 || rho[i]! > rho[run]!) run = i;
		} else if (run >= 0) {
			tips.push(ring[run]!);
			run = -1;
		}
	}
	if (tips.length !== 5 || tips.some((t) => onChord(ring.indexOf(t)))) return null;
	const radii = tips.map((t) => Math.hypot(t.x - cx, t.y - cy));
	const r = radii.reduce((a, b) => a + b, 0) / 5;
	// The turn of the drawn points, whatever order they were drawn in.
	const angles = tips.map((t) => Math.atan2(t.y - cy, t.x - cx));
	let sx = 0;
	let sy = 0;
	for (const a of angles) {
		sx += Math.cos(5 * a);
		sy += Math.sin(5 * a);
	}
	const phase = Math.atan2(sy, sx) / 5;
	const outline: P[] = [];
	for (let k = 0; k < 10; k++) {
		const a = phase + (k * Math.PI) / 5;
		const rr = k % 2 ? r * STAR_INNER : r;
		outline.push({ x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr });
	}
	const points = [0, 2, 4, 6, 8].map((k) => outline[k]!);
	const pentagram = [0, 2, 4, 1, 3].map((k) => points[k]!);
	const diag = 2 * r;
	const fit = Math.min(polygonFitError(ring, outline, diag, onChord), polygonFitError(ring, pentagram, diag, onChord));
	if (fit > 0.028) return null;
	return { kind: "star", points: synthPolygon(outline) };
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

/**
 * Two ring segments this close along the ring (counted both ways round, on the 64-sample ring) never count as crossing.
 * A corner drawn with a small loop crosses itself close along the ring, and the shape is still the polygon. The same
 * loop is a larger share of a small shape's outline, so it spans more samples there: every looped-corner rectangle and
 * triangle in the cells snaps with a window of 16 or more, and the stopped-short pentagrams still count up to 28.
 */
const CROSSING_NEAR = 20;

/**
 * True when two segments of the closed ring more than CROSSING_NEAR samples apart cross each other; segment i runs from
 * ring[i] to ring[i + 1]. Segments `skip` names are left out. A touch or an overlap along one line is not a crossing.
 */
function ringCrossesItself(ring: readonly P[], skip: (i: number) => boolean): boolean {
	const n = ring.length;
	const side = (a: P, b: P, p: P): number => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
	for (let i = 0; i < n; i++) {
		if (skip(i)) continue;
		const a = ring[i]!;
		const b = ring[(i + 1) % n]!;
		for (let j = i + 2; j < n; j++) {
			if ((j + 1) % n === i || skip(j) || Math.min(j - i, n - (j - i)) <= CROSSING_NEAR) continue;
			const c = ring[j]!;
			const d = ring[(j + 1) % n]!;
			if (side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0) return true;
		}
	}
	return false;
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
	if (len < MIN_PATH_LENGTH) return miss(`open: ends ${len.toFixed(0)} apart, under ${MIN_PATH_LENGTH}`);
	let worst = 0;
	for (const p of body) {
		const d = Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / len;
		if (d > worst) worst = d;
	}
	if (worst > len * LINE_TOLERANCE) return classifyArrow(body);
	return { kind: "line", points: synthSegment(a, b) };
}

/** An arrow's simplified outline keeps vertices this far off its path, as a fraction of its box's diagonal. */
const ARROW_SIMPLIFY = 0.05;
/** A head's barb is this long, as a fraction of the shaft ... */
const BARB_MIN = 0.08;
const BARB_MAX = 0.6;
/** ... and leaves the shaft's line at this angle, in degrees. */
const BARB_MIN_DEG = 11;
const BARB_MAX_DEG = 70;
/** A vertex this close to a tip, as a fraction of the shaft (and at least 3 world units), is the pen coming back to it. */
const TIP_RETURN = 0.06;
/** A vertex this close to a tip, as a fraction of the shaft, between two of that tip's barb ends on opposite sides of the
 * shaft, is the pen coming back towards the tip and stopping short of it. */
const TIP_REACH = 0.11;
/** The drawn points along an arrow's shaft stay this near its line, as a fraction of the shaft. */
const ARROW_SHAFT_TOLERANCE = 0.05;

/**
 * A straight shaft with a head at one end or both, drawn in one stroke: the shaft, then out to one barb's end, back to
 * the tip and out to the other (in any order, from either end). Simplified, the stroke is its longest segment (the shaft)
 * plus vertices that are either the pen back at a shaft end or a barb's end; a head is one barb's end on each side of the
 * shaft, leaning back along it. Anything else (a hook, a tick, a zigzag, a third barb) is not an arrow and stays as drawn.
 */
function classifyArrow(body: readonly P[]): SnapResult | null {
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
	const v = simplify(body, Math.max(1.5, Math.hypot(maxX - minX, maxY - minY) * ARROW_SIMPLIFY));
	if (v.length < 4) return miss(`arrow: ${v.length} vertices simplified, under 4`);
	let s = 0;
	for (let i = 1; i < v.length - 1; i++) if (dist(v[i]!, v[i + 1]!) > dist(v[s]!, v[s + 1]!)) s = i;
	const drawnEnds: [P, P] = [v[s]!, v[s + 1]!];
	const drawnShaft = dist(drawnEnds[0], drawnEnds[1]);
	if (drawnShaft < MIN_PATH_LENGTH) return miss(`arrow: longest segment ${drawnShaft.toFixed(0)}, under ${MIN_PATH_LENGTH}`);
	// The shaft is straight: the drawn points between its two vertices stay near its line.
	const i0 = body.indexOf(drawnEnds[0]);
	const i1 = body.indexOf(drawnEnds[1]);
	const offLine = (p: P): number =>
		Math.abs((drawnEnds[1].x - drawnEnds[0].x) * (drawnEnds[0].y - p.y) - (drawnEnds[0].x - p.x) * (drawnEnds[1].y - drawnEnds[0].y)) /
		drawnShaft;
	for (let i = Math.min(i0, i1); i <= Math.max(i0, i1); i++)
		if (offLine(body[i]!) > drawnShaft * ARROW_SHAFT_TOLERANCE)
			return miss(`arrow: shaft not straight, ${(offLine(body[i]!) / drawnShaft).toFixed(3)} of it off its line, over ${ARROW_SHAFT_TOLERANCE}`);
	// The simplified shaft can stop a little short of the tip, where a barb leaves close along it: each tip is the vertex on
	// the shaft's line furthest out past its end.
	const onShaft = (p: P): boolean => offLine(p) <= Math.max(3, drawnShaft * 0.04);
	const ends = drawnEnds.map((end, e) => {
		const other = drawnEnds[1 - e]!;
		const ox = (end.x - other.x) / drawnShaft;
		const oy = (end.y - other.y) / drawnShaft;
		let tip = end;
		let out = 0;
		for (const p of v) {
			const o = (p.x - end.x) * ox + (p.y - end.y) * oy;
			if (o > out && dist(p, end) <= drawnShaft * 0.3 && onShaft(p)) {
				tip = p;
				out = o;
			}
		}
		return tip;
	}) as [P, P];
	const shaft = dist(ends[0], ends[1]);
	const tipReturn = Math.max(3, shaft * TIP_RETURN);
	const barbMin = shaft * BARB_MIN;
	// The pen coming back towards a tip between two of its barbs can stop short of it: a vertex within TIP_REACH of the tip
	// with a barb end of that tip either side of it in the stroke, one each side of the shaft, is that return.
	const returns = new Set<number>();
	for (let i = 1; i < v.length - 1; i++) {
		const p = v[i]!;
		if (p === ends[0] || p === ends[1]) continue;
		const e = dist(p, ends[0]) <= dist(p, ends[1]) ? 0 : 1;
		const [tip, tail] = e === 0 ? ends : [ends[1], ends[0]];
		const d = dist(p, tip);
		if (d <= tipReturn || d > shaft * TIP_REACH) continue;
		const a = v[i - 1]!;
		const b = v[i + 1]!;
		if (a === ends[1 - e] || b === ends[1 - e] || dist(a, tip) <= d || dist(b, tip) <= d) continue;
		if (dist(a, tip) > dist(a, tail) || dist(b, tip) > dist(b, tail)) continue;
		const sideOf = (q: P): number => (q.x - tip.x) * (tail.y - tip.y) - (q.y - tip.y) * (tail.x - tip.x);
		if (sideOf(a) * sideOf(b) < 0) returns.add(i);
	}
	// Barbs per end: [left, right], each the barb end's length and angle off the shaft.
	const barbs: Array<Array<Array<{ len: number; deg: number }>>> = [
		[[], []],
		[[], []],
	];
	for (let i = 0; i < v.length; i++) {
		const p = v[i]!;
		if (p === ends[0] || p === ends[1] || returns.has(i)) continue;
		const near = dist(p, ends[0]) <= dist(p, ends[1]) ? 0 : 1;
		const [tip, tail] = near === 0 ? ends : [ends[1], ends[0]];
		const d = dist(p, tip);
		if (d <= tipReturn) continue;
		// Back along the shaft from the tip, and to which side.
		const ux = (tail.x - tip.x) / shaft;
		const uy = (tail.y - tip.y) / shaft;
		const along = (p.x - tip.x) * ux + (p.y - tip.y) * uy;
		const side = (p.x - tip.x) * uy - (p.y - tip.y) * ux;
		const deg = (Math.atan2(Math.abs(side), along) * 180) / Math.PI;
		// A vertex on the shaft's own line, short of the tip, is the shaft (the pen's path bending where a barb joins it).
		if (onShaft(p) && along > 0 && along < shaft) continue;
		if (d < barbMin) return miss(`arrow: barb ${(d / shaft).toFixed(3)} of the shaft, under ${(barbMin / shaft).toFixed(3)}`);
		if (d > shaft * BARB_MAX) return miss(`arrow: barb ${(d / shaft).toFixed(3)} of the shaft, over ${BARB_MAX}`);
		if (deg < BARB_MIN_DEG) return miss(`arrow: barb at ${deg.toFixed(0)} deg, under ${BARB_MIN_DEG}`);
		if (deg > BARB_MAX_DEG) return miss(`arrow: barb at ${deg.toFixed(0)} deg, over ${BARB_MAX_DEG}`);
		// A barb is drawn from the tip: the pen reaches its end from the tip or goes back to the tip from it. A line that
		// runs on past where the barbs meet it has no tip there.
		const fromTip = (j: number): boolean => j >= 0 && j < v.length && (returns.has(j) || dist(v[j]!, tip) <= tipReturn);
		if (!fromTip(i - 1) && !fromTip(i + 1)) return miss(`arrow: barb end ${(d / shaft).toFixed(3)} of the shaft from the tip, not drawn from the tip`);
		barbs[near]![side < 0 ? 0 : 1]!.push({ len: d, deg });
	}
	const heads = barbs.map((b) => b[0]!.length === 1 && b[1]!.length === 1);
	for (let e = 0; e < 2; e++)
		if (!heads[e] && (barbs[e]![0]!.length || barbs[e]![1]!.length))
			return miss(`arrow: an end has ${barbs[e]![0]!.length} barb(s) one side, ${barbs[e]![1]!.length} the other`);
	if (!heads[0] && !heads[1]) return miss("arrow: no head at either end");
	// The clean head: both barbs at the drawn barbs' mean length and angle, either side of the shaft.
	const all = barbs.flatMap((b) => [...b[0]!, ...b[1]!]);
	const len = all.reduce((a, b) => a + b.len, 0) / all.length;
	const rad = ((all.reduce((a, b) => a + b.deg, 0) / all.length) * Math.PI) / 180;
	const head = (tip: P, tail: P): P[] => {
		const ux = (tail.x - tip.x) / shaft;
		const uy = (tail.y - tip.y) / shaft;
		const at = (sgn: number): P => ({
			x: tip.x + len * (ux * Math.cos(rad) - sgn * uy * Math.sin(rad)),
			y: tip.y + len * (uy * Math.cos(rad) + sgn * ux * Math.sin(rad)),
		});
		return [at(1), tip, at(-1)];
	};
	// One pen path: (the first head,) the shaft, the head at its far end.
	const [a, b] = heads[1] ? ends : [ends[1], ends[0]];
	const path: P[] = [a, b, ...head(b, a), b];
	path.pop();
	const two = heads[0] && heads[1];
	const full = two ? [...head(a, b).reverse(), a, ...path.slice(1)] : path;
	return { kind: two ? "double-arrow" : "arrow", points: synthPath(full) };
}

/** A pen path through `pts` in order, at the synthesized spacing. */
function synthPath(pts: readonly P[]): InkPoint[] {
	const out: InkPoint[] = [];
	let t = 0;
	for (let i = 0; i < pts.length - 1; i++) {
		const a = pts[i]!;
		const b = pts[i + 1]!;
		const n = Math.max(1, Math.ceil(dist(a, b) / SYNTH_STEP));
		for (let j = 0; j < n; j++) {
			const f = j / n;
			out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, pressure: 0.5, t });
			t += 8;
		}
	}
	out.push({ ...pts[pts.length - 1]!, pressure: 0.5, t });
	return out;
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
	missWhy = null;
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
		if (start === null) return miss("no dwell");
		body = stroke.points.slice(0, Math.max(start, 2));
	}
	if (body.length < 8) return miss(`${body.length} points, under 8`);
	const len = pathLength(body);
	if (len < MIN_PATH_LENGTH) return miss(`path ${len.toFixed(0)}, under ${MIN_PATH_LENGTH}`);
	const gap = dist(body[0]!, body[body.length - 1]!);
	const closed = gap < len * CLOSURE_FRACTION;
	const result = closed ? classifyClosed(body, gap / (len + gap)) : classifyOpen(body);
	if (!result) return missWhy === null ? miss(closed ? "closed: no closed shape fits" : "open: none") : null;
	const width = stroke.width;
	// The figure keeps the weight it was drawn with: the body's median
	// pressure (the upper one for an even count), not the fixed 0.5 the
	// generators write, which is three times a light line's width.
	const sorted = body.map((p) => p.pressure).sort((x, y) => x - y);
	const pressure = sorted[sorted.length >> 1]!;
	const points = result.points.map((p) => ({ ...p, pressure }));
	const snapped: InkStroke = {
		id: newStrokeId(),
		tool: stroke.tool,
		color: stroke.color,
		width,
		points,
		bbox: computeBBox(points, width * 2),
		createdAt: stroke.createdAt,
		...(stroke.device === "mouse" ? { device: stroke.device } : {}),
		...(stroke.widthMode === "uniform" ? { widthMode: stroke.widthMode } : {}),
		...(stroke.pressureProfile === "exp7" ? { pressureProfile: stroke.pressureProfile } : {}),
		...(stroke.pressureSensitivity === "on" || stroke.pressureSensitivity === "off"
			? { pressureSensitivity: stroke.pressureSensitivity }
			: {}),
	};
	snappedKinds.set(snapped, result.kind);
	return snapped;
}

/** The kind each snapped stroke was fitted as; a drag that turns the figure reads it (lines, rectangles and triangles settle on right angles, circles do not turn). */
const snappedKinds = new WeakMap<InkStroke, SnappedKind>();

/** The kind snapStroke fitted this stroke as, or undefined for a stroke it did not return. */
export function snapKindOf(stroke: InkStroke): SnappedKind | undefined {
	return snappedKinds.get(stroke);
}
