/**
 * Pen appearance (handoff §12). Deliberately simple.
 */

export interface PenStyle {
	color: string;
	/** Base stroke width in world units. */
	baseWidth: number;
	/** Fraction of baseWidth drawn at zero pressure (floor). */
	minWidthFactor: number;
	/** Pressure gamma: effective = pow(pressure, gamma). */
	gamma: number;
}

export const DEFAULT_PEN: PenStyle = {
	color: "#4b7bec",
	baseWidth: 2.2,
	minWidthFactor: 0.35,
	gamma: 0.75,
};

/**
 * Highlighter (§51, §57). Wide and nearly flat: a chisel tip does not taper
 * the way a nib does, so pressure barely moves the width.
 *
 * The translucency is deliberately NOT in this colour. It lives on the layer,
 * as CSS opacity, and the ink itself is drawn opaque. Translucent ink would
 * double-blend everywhere a stroke crosses itself or another highlight, giving
 * muddy dark seams, the one thing a highlighter must not do. One opaque layer
 * at one alpha gives a flat, even wash no matter how much overlaps.
 */
export const HIGHLIGHTER_PEN: PenStyle = {
	color: "#ffd60a",
	baseWidth: 16,
	minWidthFactor: 0.9,
	gamma: 1,
};

/** Layer opacity for highlighter ink. */
export const HIGHLIGHTER_ALPHA = 0.35;

/**
 * Width in world units for a given pressure sample.
 * Devices that report no pressure send 0.5 (normalized upstream).
 */
export function widthForPressure(style: PenStyle, pressure: number): number {
	const p = Math.min(1, Math.max(0, pressure));
	const effective = Math.pow(p, style.gamma);
	const factor = style.minWidthFactor + (1 - style.minWidthFactor) * effective;
	return style.baseWidth * factor;
}
