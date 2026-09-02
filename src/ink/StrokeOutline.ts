/**
 * A stroke's filled geometry, once, for every exporter.
 *
 * `StrokeRenderer` draws to a canvas, `SvgExport` writes path data and
 * `InkPdf` writes content-stream operators, and all three must describe the
 * SAME shape or a note looks different depending on how it left the plugin.
 * The flatten and the ribbon offsets live here so that stays true by
 * construction rather than by three copies agreeing.
 *
 * The shape is an outline plus discs, and the discs are not decoration: the
 * outline self-intersects inside tight turns, and filling outline-plus-discs
 * under a NONZERO winding rule unions them into the pinch-free shape the
 * canvas renderer produces. Any consumer that fills these must use nonzero.
 *
 * Pure. Same reason ScrollBand and PinchScale are.
 */

import { flattenStroke, ribbonSides, jointIndices, RibbonPt } from "./Ribbon";
import { flattenStrokeShaped } from "./InkShape";
import { PenStyle } from "./PenStyle";
import { InkStroke } from "./Stroke";

/** Density for curve flattening: world px are CSS px, 2 samples per px. */
export const EXPORT_PX_PER_WORLD = 2;

export interface Pt {
	x: number;
	y: number;
}

export interface Disc {
	x: number;
	y: number;
	r: number;
}

export interface StrokeOutline {
	/** One side of the ribbon, then the other reversed, closes the outline. */
	left: readonly Pt[];
	right: readonly Pt[];
	/** Caps and joints. A dot-stroke has these and no outline. */
	discs: readonly Disc[];
}

/** The flattened ribbon, exactly as the committed renderer would build it. */
export function ribbonOf(stroke: InkStroke): RibbonPt[] {
	const pts = stroke.points;
	if (pts.length === 0) return [];
	const flat = stroke.tool === "highlighter";
	// drawStroke's exact style derivation, so the widths match the note.
	const style: PenStyle = {
		color: stroke.color,
		baseWidth: stroke.width,
		minWidthFactor: flat ? 0.9 : 0.35,
		gamma: flat ? 1 : 0.75,
	};
	// Exports are always shaped (§5n, Alan, 2026-09-02): inkShapingEnabled()
	// used to gate this too, so a Boox user - whose boox mode turns shaping
	// off to save e-ink redraw cost on screen - was exporting rough geometry
	// into every PDF and SVG for a reason that has nothing to do with paper.
	// The toggle still governs the on-screen path (StrokeRenderer.drawStroke,
	// WetInkRenderer) untouched; it never reaches here. The flat (highlighter)
	// and mouse rules stay: those strokes were never shaped and must not start.
	return !flat && stroke.device !== "mouse"
		? flattenStrokeShaped(pts, style, EXPORT_PX_PER_WORLD)
		: flattenStroke(pts, style, EXPORT_PX_PER_WORLD);
}

/** A disc is never thinner than this, so a dot is still visible. */
const MIN_DISC_R = 0.125;

const discOf = (p: RibbonPt): Disc => ({ x: p.x, y: p.y, r: Math.max(MIN_DISC_R, p.hw) });

/**
 * One stroke as outline and discs, or null when there is nothing to draw.
 *
 * A single-sample stroke - a dot - has no outline at all, only its cap disc.
 * Consumers must handle `left`/`right` being empty rather than assuming a
 * path is always present.
 */
export function strokeOutline(stroke: InkStroke): StrokeOutline | null {
	const ribbon = ribbonOf(stroke);
	if (ribbon.length === 0) return null;
	if (ribbon.length === 1) {
		return { left: [], right: [], discs: [discOf(ribbon[0]!)] };
	}
	const { left, right } = ribbonSides(ribbon);
	return {
		left,
		right,
		discs: [
			discOf(ribbon[0]!),
			discOf(ribbon[ribbon.length - 1]!),
			...jointIndices(ribbon).map((i) => discOf(ribbon[i]!)),
		],
	};
}
