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
	/** Upper width factor at full pressure. */
	maxWidthFactor: number;
	/** Historical width factor when pressure sensitivity is disabled. */
	pressureOffWidthFactor: number;
	/** Per-stroke geometry generation, absent for the 1.4.12 policy. */
	pressureProfile?: "exp7";
}

export const DEFAULT_PEN: PenStyle = {
	color: "#2f6de0",
	baseWidth: 2.2,
	minWidthFactor: 0.35,
	gamma: 0.75,
	maxWidthFactor: 1,
	// Preserve the 1.4.12 width law at NO_PRESSURE for saved and new pen ink.
	pressureOffWidthFactor: 0.7364923123758843,
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
	maxWidthFactor: 1,
	pressureOffWidthFactor: 0.95,
};

/** Exact accepted pressure generation, recovered from before-rollback.json. */
export const EXP7_PEN: PenStyle = {
	...DEFAULT_PEN,
	minWidthFactor: 0.18,
	gamma: 1.15,
	maxWidthFactor: 3.2,
	pressureOffWidthFactor: 0.9945718882219903,
	pressureProfile: "exp7",
};

/**
 * The shape fields of a PenStyle that a stroke's tool alone decides:
 * DEFAULT_PEN's for pen/eraser strokes, HIGHLIGHTER_PEN's for the flat wash.
 * StrokeRenderer.drawStroke and StrokeOutline.ribbonOf both call this rather
 * than each restating the four numbers, so a tuning change to either pen
 * moves both the screen and every export in one place.
 */
export function shapeFor(
	flat: boolean,
	pressureProfile?: "exp7"
): Pick<
	PenStyle,
	"minWidthFactor" | "gamma" | "maxWidthFactor" | "pressureOffWidthFactor"
> {
	const pen = flat ? HIGHLIGHTER_PEN : pressureProfile === "exp7" ? EXP7_PEN : DEFAULT_PEN;
	return {
		minWidthFactor: pen.minWidthFactor,
		gamma: pen.gamma,
		maxWidthFactor: pen.maxWidthFactor,
		pressureOffWidthFactor: pen.pressureOffWidthFactor,
	};
}

/** Layer opacity for highlighter ink. */
export const HIGHLIGHTER_ALPHA = 0.35;

/** What a device that reports no pressure sends, normalized upstream. */
export const NO_PRESSURE = 0.5;

/**
 * Pressure sensitivity, off for anyone who wants an even line.
 *
 * Each style carries its OFF width. Speed thinning and geometric endpoint
 * taper stay active in both states. Every stroke is styled at render time,
 * so flipping this restyles ink that was written years ago.
 */
let pressureSensitive = true;

export function setPressureSensitivity(on: boolean): void {
	pressureSensitive = on;
}

/**
 * The pressure setting of the stroke being drawn or exported right now, when
 * that stroke carries one; undefined otherwise, and then the switch decides.
 * Set by enterStrokePressure and put back by leaveStrokePressure in a finally,
 * around one stroke's draw or flatten.
 */
let strokePressure: boolean | undefined;

/**
 * Enters one stroke's own pressure setting, if it carries one; returns what to
 * hand back to leaveStrokePressure. A stroke with no mark changes nothing.
 */
export function enterStrokePressure(mark: "on" | "off" | undefined): boolean | undefined {
	const previous = strokePressure;
	if (mark === "on") strokePressure = true;
	else if (mark === "off") strokePressure = false;
	return previous;
}

export function leaveStrokePressure(previous: boolean | undefined): void {
	strokePressure = previous;
}

/** Whether pressure moves width: the stroke's own setting while one is entered, else the switch. */
export function pressureSensitivityEnabled(): boolean {
	return strokePressure ?? pressureSensitive;
}

/**
 * Width in world units for a given pressure sample.
 * Devices that report no pressure send 0.5 (normalized upstream).
 */
export function widthForPressure(style: PenStyle, pressure: number): number {
	if (!pressureSensitivityEnabled()) return style.baseWidth * style.pressureOffWidthFactor;
	const p = Math.min(1, Math.max(0, pressure));
	const effective = Math.pow(p, style.gamma);
	const factor =
		style.minWidthFactor + (style.maxWidthFactor - style.minWidthFactor) * effective;
	return style.baseWidth * factor;
}
