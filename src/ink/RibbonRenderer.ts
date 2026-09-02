import { CameraState } from "../camera/coordinates";
import { RibbonPt, jointIndices, ribbonSides } from "./Ribbon";

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
	perSegment = false
): void {
	const n = pts.length;
	if (n === 0) return;
	ctx.fillStyle = color;

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
		ctx.closePath();
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
