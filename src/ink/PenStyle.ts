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
	color: "#2f6de0",
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

/**
 * The two fields of a PenStyle that a stroke's tool alone decides:
 * DEFAULT_PEN's for pen/eraser strokes, HIGHLIGHTER_PEN's for the flat wash.
 * StrokeRenderer.drawStroke and StrokeOutline.ribbonOf both call this rather
 * than each restating the four numbers, so a tuning change to either pen
 * moves both the screen and every export in one place.
 */
export function shapeFor(flat: boolean): Pick<PenStyle, "minWidthFactor" | "gamma"> {
	const pen = flat ? HIGHLIGHTER_PEN : DEFAULT_PEN;
	return { minWidthFactor: pen.minWidthFactor, gamma: pen.gamma };
}

/** Layer opacity for highlighter ink. */
export const HIGHLIGHTER_ALPHA = 0.35;

/** What a device that reports no pressure sends, normalized upstream. */
export const NO_PRESSURE = 0.5;

/**
 * Pressure sensitivity, off for anyone who wants an even line.
 *
 * It pins pressure rather than switching the width law off. Speed thinning
 * and the endpoint taper are what make a stroke read as handwriting and they
 * stay in both states; only "how hard you press" stops moving the width.
 * Every stroke is styled at render time, so flipping this restyles ink that
 * was written years ago.
 */
let pressureSensitive = true;

export function setPressureSensitivity(on: boolean): void {
	pressureSensitive = on;
}

export function pressureSensitivityEnabled(): boolean {
	return pressureSensitive;
}

/**
 * Width in world units for a given pressure sample.
 * Devices that report no pressure send 0.5 (normalized upstream).
 */
export function widthForPressure(style: PenStyle, pressure: number): number {
	const raw = pressureSensitive ? pressure : NO_PRESSURE;
	const p = Math.min(1, Math.max(0, raw));
	const effective = Math.pow(p, style.gamma);
	const factor = style.minWidthFactor + (1 - style.minWidthFactor) * effective;
	return style.baseWidth * factor;
}
