import { CameraState } from "../camera/coordinates";
import { RibbonPt, jointIndices, ribbonSides } from "./Ribbon";
import { flooredHalfWidth } from "./WidthFloor";

/**
 * Canvas side of ribbon rendering. Everything a stroke needs (both sides of
 * the outline, its end caps, and the discs that fill hard turns) goes into a
 * single path and is filled once, so the antialiased edge is composited
 * exactly once. Nonzero winding unions the overlapping pieces.
 */

function toScreenX(cam: CameraState, x: number): number {
	return (x - cam.x) * cam.zoom;
}

function toScreenY(cam: CameraState, y: number): number {
	return (y - cam.y) * cam.zoom;
}

/** Shoelace. Sign tells us which way the outline is wound. */
export function signedArea(poly: ReadonlyArray<readonly [number, number]>): number {
	let sum = 0;
	for (let i = 0; i < poly.length; i++) {
		const a = poly[i]!;
		const b = poly[(i + 1) % poly.length]!;
		sum += a[0] * b[1] - b[0] * a[1];
	}
	return sum / 2;
}

export const MAX_RASTER_PATH_EXTENT = 16000;
let boundsPasses = 0;
/** How many ribbons fillRibbon has measured point by point; a test reads it to see a committed draw skip the measure. */
export function ribbonBoundsPasses(): number {
	return boundsPasses;
}
type XY = [number, number];
type Rect = { left: number; top: number; right: number; bottom: number };
type Disc = { x: number; y: number; r: number };

function intersect(a: Rect, b: Rect): Rect | null {
	const box = { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
	return box.left < box.right && box.top < box.bottom ? box : null;
}

/** All pixels that can be written, expressed in this context's logical coordinates. */
function visibleBounds(ctx: CanvasRenderingContext2D, bounds: Rect): Rect | null {
	const m = ctx.getTransform();
	const { width, height } = ctx.canvas;
	if (![...Object.values(bounds), m.a, m.b, m.c, m.d, m.e, m.f, width, height].every(Number.isFinite)) {
		throw new RangeError("Non-finite bounded ribbon geometry");
	}
	if (width <= 0 || height <= 0) return null;
	const det = m.a * m.d - m.b * m.c;
	if (det === 0) return null; // A singular transform paints no area.
	const xs: number[] = [], ys: number[] = [];
	for (const [x, y] of [[0, 0], [width, 0], [0, height], [width, height]]) {
		xs.push((m.d * (x! - m.e) - m.c * (y! - m.f)) / det);
		ys.push((m.a * (y! - m.f) - m.b * (x! - m.e)) / det);
	}
	if (![...xs, ...ys].every(Number.isFinite)) throw new RangeError("Unrepresentable ribbon viewport");
	return intersect(bounds, { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) });
}

function ribbonBounds(cam: CameraState, pts: readonly RibbonPt[]): Rect {
	const box = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
	for (const p of pts) {
		const x = toScreenX(cam, p.x), y = toScreenY(cam, p.y);
		const r = Math.max(0.25, Math.abs(p.hw * cam.zoom));
		box.left = Math.min(box.left, x - r); box.right = Math.max(box.right, x + r);
		box.top = Math.min(box.top, y - r); box.bottom = Math.max(box.bottom, y + r);
	}
	return box;
}

/** Grid edges land on backing-pixel boundaries for the renderer's scale/translate contexts. */
function rasterGrid(ctx: CanvasRenderingContext2D, box: Rect): { xs: number[]; ys: number[] } {
	const m = ctx.getTransform();
	const axis = (lo: number, hi: number, scale: number, offset: number): number[] => {
		const limit = MAX_RASTER_PATH_EXTENT - 2;
		const aligned = m.b === 0 && m.c === 0 && Number.isFinite(scale) && scale > 0 && scale * limit >= 1;
		const first = aligned ? (Math.floor(lo * scale + offset) - offset) / scale : lo;
		const last = aligned ? (Math.ceil(hi * scale + offset) - offset) / scale : hi;
		const step = aligned ? Math.floor(limit * scale) / scale : limit;
		if (![first, last, step].every(Number.isFinite) || first + step <= first) throw new RangeError("Unrepresentable ribbon grid");
		const edges = [first];
		for (let i = 1, v = first + step; v < last; v = first + (++i) * step) {
			if (v <= edges[edges.length - 1]!) throw new RangeError("Non-progressing ribbon grid");
			edges.push(v);
		}
		edges.push(last);
		return edges;
	};
	return { xs: axis(box.left, box.right, m.a, m.e), ys: axis(box.top, box.bottom, m.d, m.f) };
}

function cellRange(edges: number[], lo: number, hi: number): [number, number] {
	const search = (value: number, inclusive: boolean) => {
		let left = 0, right = edges.length;
		while (left < right) {
			const mid = (left + right) >>> 1;
			if (edges[mid]! < value || (inclusive && edges[mid] === value)) left = mid + 1;
			else right = mid;
		}
		return left;
	};
	return [Math.max(0, search(lo, true) - 1), Math.min(edges.length - 1, search(hi, false))];
}

function clipPolygon(poly: XY[], rect: Rect): XY[] {
	for (const [axis, edge, sign] of [[0, rect.left, 1], [0, rect.right, -1], [1, rect.top, 1], [1, rect.bottom, -1]] as const) {
		const out: XY[] = [];
		for (let i = 0; i < poly.length; i++) {
			const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
			const da = (a[axis] - edge) * sign, db = (b[axis] - edge) * sign;
			if (da >= 0) out.push(a);
			if ((da >= 0) !== (db >= 0)) {
				const t = da / (da - db);
				const p: XY = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
				p[axis] = edge;
				out.push(p);
			}
		}
		poly = out;
	}
	return poly;
}

/** Exact boundary of disc intersect rectangle: original arcs plus straight clip edges. */
function clippedDisc(ctx: CanvasRenderingContext2D, d: Disc, box: Rect): boolean {
	const { x, y, r } = d;
	if (x + r <= box.left || x - r >= box.right || y + r <= box.top || y - r >= box.bottom) return false;
	const tau = Math.PI * 2;
	const at = (t: number): XY => [x + r * Math.cos(t), y + r * Math.sin(t)];
	const inside = (p: XY) => p[0] >= box.left - 1e-7 && p[0] <= box.right + 1e-7 && p[1] >= box.top - 1e-7 && p[1] <= box.bottom + 1e-7;
	const angles = [0, tau];
	for (const edge of [box.left, box.right]) {
		const q = (edge - x) / r;
		if (q > -1 && q < 1) { const a = Math.acos(q); angles.push(a, tau - a); }
	}
	for (const edge of [box.top, box.bottom]) {
		const q = (edge - y) / r;
		if (q > -1 && q < 1) { const a = Math.asin(q); angles.push((a + tau) % tau, (Math.PI - a + tau) % tau); }
	}
	angles.sort((a, b) => a - b);
	const pieces: Array<{ from: XY; to: XY; arc?: [number, number] }> = [];
	for (let i = 1; i < angles.length; i++) {
		const a = angles[i - 1]!, b = angles[i]!;
		if (b - a > 1e-12 && inside(at((a + b) / 2))) pieces.push({ from: at(b), to: at(a), arc: [b, a] });
	}
	const corners: XY[] = [[box.left, box.top], [box.left, box.bottom], [box.right, box.bottom], [box.right, box.top]];
	for (let i = 0; i < 4; i++) {
		const a = corners[i]!, b = corners[(i + 1) % 4]!;
		const dx = b[0] - a[0], dy = b[1] - a[1], ax = a[0] - x, ay = a[1] - y;
		const aa = dx * dx + dy * dy, bb = 2 * (ax * dx + ay * dy), cc = ax * ax + ay * ay - r * r;
		const det = bb * bb - 4 * aa * cc;
		const cuts = [0, 1];
		if (det >= 0 && aa > 0) for (const t of [(-bb - Math.sqrt(det)) / (2 * aa), (-bb + Math.sqrt(det)) / (2 * aa)]) if (t > 0 && t < 1) cuts.push(t);
		cuts.sort((a, b) => a - b);
		for (let j = 1; j < cuts.length; j++) {
			const lo = cuts[j - 1]!, hi = cuts[j]!, mid = (lo + hi) / 2;
			if ((ax + mid * dx) ** 2 + (ay + mid * dy) ** 2 <= r * r && hi > lo) {
				pieces.push({ from: [a[0] + lo * dx, a[1] + lo * dy], to: [a[0] + hi * dx, a[1] + hi * dy] });
			}
		}
	}
	if (!pieces.length) return false;
	let piece = pieces.shift()!;
	ctx.moveTo(...piece.from);
	for (;;) {
		if (piece.arc) ctx.arc(x, y, r, piece.arc[0], piece.arc[1], true);
		else ctx.lineTo(...piece.to);
		if (!pieces.length) break;
		let closest = 0, distance = Infinity;
		for (let i = 0; i < pieces.length; i++) {
			const p = pieces[i]!.from, dd = (p[0] - piece.to[0]) ** 2 + (p[1] - piece.to[1]) ** 2;
			if (dd < distance) { closest = i; distance = dd; }
		}
		piece = pieces.splice(closest, 1)[0]!;
	}
	return true;
}

function fillBoundedRibbon(ctx: CanvasRenderingContext2D, cam: CameraState, pts: readonly RibbonPt[], perSegment: boolean, bounds: Rect): void {
	const visible = visibleBounds(ctx, bounds);
	if (!visible) return;
	const polys: XY[][] = [], discs: Disc[] = [];
	let poly: XY[] = [];
	// Collect the existing construction, so winding, normals and joint choice
	// stay identical. Splitting the centerline would invent caps and normals.
	// A polygon starts at each moveTo: the quad loop leaves its quads open
	// (fill closes them), and a disc's moveTo leaves a one-point polygon that
	// the length check below drops.
	const sink = {
		beginPath() {}, moveTo(x: number, y: number) { poly = [[x, y]]; polys.push(poly); },
		lineTo(x: number, y: number) { poly.push([x, y]); },
		closePath() {},
		arc(x: number, y: number, r: number) { discs.push({ x, y, r }); }, fill() {},
	} as unknown as CanvasRenderingContext2D;
	paintRibbon(sink, cam, pts, perSegment);
	// Bucket only intersected cells. Slice each primitive into grid rows first,
	// so a sparse diagonal costs crossed rows/cells, not its bbox's full area.
	// Offscreen points above still determine the original visible normals.
	const { xs, ys } = rasterGrid(ctx, visible);
	const buckets = new Map<number, { cell: Rect; polys: XY[][]; discs: Disc[] }>();
	const bucket = (x: number, y: number) => {
		const key = y * xs.length + x;
		let entry = buckets.get(key);
		if (!entry) {
			entry = { cell: { left: xs[x]!, top: ys[y]!, right: xs[x + 1]!, bottom: ys[y + 1]! }, polys: [], discs: [] };
			buckets.set(key, entry);
		}
		return entry;
	};
	for (const original of polys) {
		const poly = clipPolygon(original, visible);
		if (poly.length < 3) continue;
		const [first, end] = cellRange(ys, Math.min(...poly.map(p => p[1])), Math.max(...poly.map(p => p[1])));
		for (let y = first; y < end; y++) {
			const row = clipPolygon(poly, { ...visible, top: ys[y]!, bottom: ys[y + 1]! });
			if (row.length < 3) continue;
			const [left, right] = cellRange(xs, Math.min(...row.map(p => p[0])), Math.max(...row.map(p => p[0])));
			for (let x = left; x < right; x++) bucket(x, y).polys.push(row);
		}
	}
	for (const disc of discs) {
		if (!intersect(visible, { left: disc.x - disc.r, top: disc.y - disc.r, right: disc.x + disc.r, bottom: disc.y + disc.r })) continue;
		const [first, end] = cellRange(ys, disc.y - disc.r, disc.y + disc.r);
		for (let y = first; y < end; y++) {
			const dy = Math.max(ys[y]! - disc.y, disc.y - ys[y + 1]!, 0);
			const dx = Math.sqrt(Math.max(0, (disc.r - dy) * (disc.r + dy)));
			const [left, right] = cellRange(xs, disc.x - dx, disc.x + dx);
			for (let x = left; x < right; x++) bucket(x, y).discs.push(disc);
		}
	}
	for (const { cell, polys: cellPolys, discs: cellDiscs } of buckets.values()) {
		ctx.save();
		try {
			ctx.beginPath(); ctx.rect(cell.left, cell.top, cell.right - cell.left, cell.bottom - cell.top); ctx.clip();
			// No closePath for a polygon or a disc piece: fill closes every subpath,
			// and a close per piece is the cost the quad loop's note below describes.
			ctx.beginPath();
			let present = false;
			for (const poly of cellPolys) {
				const clipped = clipPolygon(poly, cell);
				if (clipped.length < 3) continue;
				ctx.moveTo(...clipped[0]!);
				for (let i = 1; i < clipped.length; i++) ctx.lineTo(...clipped[i]!);
				present = true;
			}
			for (const disc of cellDiscs) present = clippedDisc(ctx, disc, cell) || present;
			if (present) ctx.fill();
		} finally { ctx.restore(); }
	}
}

/**
 * Fill a ribbon. `pts` is a centerline in world coordinates carrying a local
 * half-width; the context transform is CSS pixels (dpr already applied).
 *
 * `perSegment` is for a RAW centerline - the polyline through the stored
 * samples, drawn when "Ink smoothing" is off. It offsets each quad by the
 * perpendicular of its OWN segment and fills the joins with discs, instead of
 * sharing one normal per point.
 *
 * Why the raw path needs its own offsetter. `ribbonSides` takes the normal to
 * the CENTRAL-DIFFERENCE tangent p[i-1] -> p[i+1], which is the angle
 * bisector only when the two adjacent segments are the same length. On a
 * smoothed centerline they effectively are: `subdivisionsFor` re-spaces every
 * segment by flatness, so consecutive points are near-collinear and evenly
 * spread. On a raw polyline they are not - sample spacing follows pen speed,
 * which varies inside every letter - so the shared normal skews toward the
 * longer segment and is wrong for BOTH of its segments rather than splitting
 * the error between them. One side pinches while the other bulges, at a
 * magnitude that follows speed variation rather than turn angle, and the two
 * offset side-polylines serrate along the whole stroke. An antialiased
 * serrated outline covers its boundary pixels only partly, which is why the
 * author's raw ink on a PDF came out "thinner, soft edged, lighter grey"
 * (2026-09-02) rather than merely faceted.
 *
 * Per-segment quads have no shared normal, so there is no asymmetry and no
 * notch to fill by construction: each quad IS the rectangle a round nib
 * sweeps along that segment, and a disc at each join is the nib sitting at
 * the vertex. This is already what the wet layer draws (it fills one
 * two-point strip per sample, where a central difference degenerates to the
 * segment's own direction, with a cap at each end), so the commit now matches
 * the line the user watched.
 */
export function fillRibbon(
	ctx: CanvasRenderingContext2D,
	cam: CameraState,
	pts: readonly RibbonPt[],
	color: string,
	perSegment = false,
	/**
	 * Committed-paint sites only (see WidthFloor.ts). The exact backing
	 * multiplier the canvas's own transform was set with, and the dpr that
	 * same call received - never re-derived here from pinch scale or
	 * cssScale. Undefined preserves today's behaviour exactly (wet, tail,
	 * snip/export all pass nothing).
	 */
	floor?: { backing: number; dpr: number },
	/**
	 * Set by drawStroke when the stroke's bbox shows this ribbon cannot reach
	 * MAX_RASTER_PATH_EXTENT, so the point-by-point measure below is skipped.
	 * The wet strip, the tail and drawSegment's long-segment route call this
	 * directly, pass nothing, and are always measured.
	 */
	extentKnownSmall = false
): void {
	const n = pts.length;
	if (n === 0) return;
	ctx.fillStyle = color;
	// Floor every point's half-width once, up front, so the quad body and
	// both disc cases below all read the same already-floored value. The
	// disc's own `Math.max(0.25, ...)` stays untouched - a dot-visibility
	// constant at 100%, not a second floor - and now simply operates on hw
	// after this pass instead of before it.
	if (floor) {
		pts = pts.map(p => ({ ...p, hw: flooredHalfWidth(p.hw, floor.backing, floor.dpr) }));
	}
	if (!extentKnownSmall) {
		boundsPasses++;
		const bounds = ribbonBounds(cam, pts);
		if (!Object.values(bounds).every(Number.isFinite)) throw new RangeError("Non-finite bounded ribbon geometry");
		if (bounds.right - bounds.left > MAX_RASTER_PATH_EXTENT || bounds.bottom - bounds.top > MAX_RASTER_PATH_EXTENT) {
			fillBoundedRibbon(ctx, cam, pts, perSegment, bounds);
			return;
		}
	}
	paintRibbon(ctx, cam, pts, perSegment);
}

function paintRibbon(ctx: CanvasRenderingContext2D, cam: CameraState, pts: readonly RibbonPt[], perSegment: boolean): void {
	const n = pts.length;

	// A dot: one disc.
	if (n === 1) {
		const p = pts[0]!;
		const r = Math.max(0.25, p.hw * cam.zoom);
		ctx.beginPath();
		ctx.arc(toScreenX(cam, p.x), toScreenY(cam, p.y), r, 0, Math.PI * 2);
		ctx.fill();
		return;
	}

	// The offsets each quad's corners are built from. Shared per point on the
	// smoothed path (normals transition smoothly, which is what keeps a
	// varying width from stepping at every sample); per segment on the raw
	// path, where a shared normal is the defect - see the header.
	const sides = perSegment ? null : ribbonSides(pts);

	// One quad per segment rather than one long outline around the whole
	// stroke. A single outline self-intersects wherever the half-width exceeds
	// the radius of curvature (the inside of any tight turn), and the inner
	// loop comes out wound backwards, so nonzero winding cancels it to a hole.
	// Per-segment quads are each simple and identically wound, so overlaps can
	// only add. Everything still goes into one path and one fill, which is what
	// keeps the antialiased edge single-pass.
	ctx.beginPath();
	for (let i = 0; i < n - 1; i++) {
		const a = pts[i]!;
		const b = pts[i + 1]!;
		let quad: Array<[number, number]>;
		if (sides) {
			quad = [
				[toScreenX(cam, sides.left[i]!.x), toScreenY(cam, sides.left[i]!.y)],
				[toScreenX(cam, sides.left[i + 1]!.x), toScreenY(cam, sides.left[i + 1]!.y)],
				[toScreenX(cam, sides.right[i + 1]!.x), toScreenY(cam, sides.right[i + 1]!.y)],
				[toScreenX(cam, sides.right[i]!.x), toScreenY(cam, sides.right[i]!.y)],
			];
		} else {
			// This segment's own perpendicular, so the quad is exactly the
			// rectangle a round nib of the local half-width sweeps from a to
			// b. A zero-length segment (a stationary pen repeats coordinates
			// on webkit) has no direction and no area to contribute; its
			// join disc still lands below.
			let tx = b.x - a.x;
			let ty = b.y - a.y;
			const len = Math.hypot(tx, ty);
			if (len < 1e-9) continue;
			tx /= len;
			ty /= len;
			const nx = -ty;
			const ny = tx;
			quad = [
				[toScreenX(cam, a.x + nx * a.hw), toScreenY(cam, a.y + ny * a.hw)],
				[toScreenX(cam, b.x + nx * b.hw), toScreenY(cam, b.y + ny * b.hw)],
				[toScreenX(cam, b.x - nx * b.hw), toScreenY(cam, b.y - ny * b.hw)],
				[toScreenX(cam, a.x - nx * a.hw), toScreenY(cam, a.y - ny * a.hw)],
			];
		}
		// Every quad is normalised to NEGATIVE winding by construction. The
		// old code guessed one winding for the whole stroke from quad 0's
		// sign, and the ipad showed why that guess goes wrong: a stationary
		// pen repeats coordinates (webkit delivers moves for a nib that is
		// not travelling), quad 0 collapses to zero area, and its sign is
		// numeric noise. Guessed wrong, every disc below subtracts instead of
		// filling, and a tight loop has a joint disc at nearly every point at
		// one-sample-per-frame density, so the whole stroke was eaten. Each
		// frame re-flattens and the guess could flip back, which is the
		// "disappears, then repairs itself" both ipad testers reported.
		if (signedArea(quad) > 0) quad.reverse();
		ctx.moveTo(quad[0]![0], quad[0]![1]);
		for (let k = 1; k < 4; k++) ctx.lineTo(quad[k]![0], quad[k]![1]);
		// NO `closePath()` HERE, AND ITS ABSENCE IS LOAD-BEARING. `fill()` closes
		// every open subpath implicitly, and this path is only ever filled (:96,
		// :199) and never stroked, so the close changed no pixel - measured, not
		// assumed: RibbonClosePathParity.test.ts replays this painter's own call
		// stream closed and open and compares the rasters byte for byte.
		//
		// It was not free. A device trace bills `closePath` 3332.0 ms of a
		// 3536.8 ms pinch-end task, beside `lineTo`'s 5.6 ms at three times the
		// call count, and the cost of one close grows with the length of the path
		// it closes (1.17 us at 419 subpaths, 2.57 us at 799). One close per
		// sample on a page of ink is therefore quadratic, and it froze the app.
	}

	// Discs must wind the same way as the quads, or they subtract instead of
	// filling. Round caps at both ends; joints only where the path bends hard
	// enough for the sides to pinch. `arc(..., anticlockwise=true)` traces a
	// negatively-signed loop, matching the quads' enforced winding, so a disc
	// can only add.
	const disc = (p: RibbonPt) => {
		const r = Math.max(0.25, p.hw * cam.zoom);
		const sx = toScreenX(cam, p.x);
		const sy = toScreenY(cam, p.y);
		ctx.moveTo(sx + r, sy);
		ctx.arc(sx, sy, r, 0, Math.PI * 2, true);
	};
	disc(pts[0]!);
	if (perSegment) {
		// EVERY join, and the count is not negotiable. A per-segment quad
		// ends at the vertex, on an edge square to its own segment, so the
		// next quad's start edge diverges from it by the whole turn angle:
		// the gap on the outside of a join is a wedge of depth hw, not the
		// sub-percent shortfall a shared-normal mitre leaves. Measured over
		// a 300-sample handwriting stroke: per-segment quads with a disc at
		// every join hold the painted width at 99.8% of intended at worst,
		// while skipping the joins that sit under a pixel apart drops the
		// worst case to 49% and puts 24% of the stroke under 95% - the disc
		// is load-bearing here, not a redundant cap.
		//
		// The cost is one arc per sample, and it is charged per repaint: the
		// ribbon cache holds the flatten, not the canvas path. On that same
		// 300-sample stroke the disc count goes from 66 to 300 and the whole
		// path from 1627 canvas calls to 2095, +29%, against a quad that
		// already costs five calls a sample. Boox mode forces smoothing off,
		// so the e-ink repaint is the one that pays it.
		for (let i = 1; i < n - 1; i++) disc(pts[i]!);
	} else {
		for (const i of jointIndices(pts)) disc(pts[i]!);
	}
	disc(pts[n - 1]!);

	ctx.fill();
}
