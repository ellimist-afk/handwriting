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
 */
export function fillRibbon(
	ctx: CanvasRenderingContext2D,
	cam: CameraState,
	pts: readonly RibbonPt[],
	color: string
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

	const { left, right } = ribbonSides(pts);

	// One quad per segment rather than one long outline around the whole
	// stroke. A single outline self-intersects wherever the half-width exceeds
	// the radius of curvature (the inside of any tight turn), and the inner
	// loop comes out wound backwards, so nonzero winding cancels it to a hole.
	// Per-segment quads are each simple and identically wound, so overlaps can
	// only add. Everything still goes into one path and one fill, which is what
	// keeps the antialiased edge single-pass.
	ctx.beginPath();
	for (let i = 0; i < n - 1; i++) {
		const quad: Array<[number, number]> = [
			[toScreenX(cam, left[i]!.x), toScreenY(cam, left[i]!.y)],
			[toScreenX(cam, left[i + 1]!.x), toScreenY(cam, left[i + 1]!.y)],
			[toScreenX(cam, right[i + 1]!.x), toScreenY(cam, right[i + 1]!.y)],
			[toScreenX(cam, right[i]!.x), toScreenY(cam, right[i]!.y)],
		];
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
	disc(pts[n - 1]!);
	for (const i of jointIndices(pts)) disc(pts[i]!);

	ctx.fill();
}
