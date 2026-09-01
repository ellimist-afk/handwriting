/**
 * Ink colors (v0.13.6): a small, intentional first-release palette.
 *
 * Strokes have always stored their own color (`InkStroke.color`, rendered
 * verbatim by the stroke renderer), so no schema change is involved: the
 * selected color is simply what the StrokeBuilder is handed when a stroke
 * BINDS its style at pen-down. Changing the selection never touches
 * existing strokes, and every stroke ever saved renders exactly as before.
 *
 * Per-tool palettes: pens are opaque writing inks; highlighter colors are
 * bright bases designed for the highlight layer's single 0.35 alpha (the
 * v0.6.0 rule: strokes paint opaque, the LAYER carries the translucency,
 * so overlaps never double-blend). Selection state lives here (pure,
 * testable); the plugin persists it per tool like the nib size.
 */

import { InkTool } from "./Stroke";

export interface InkColorChoice {
	readonly name: string;
	readonly hex: string;
}

/** Pen inks. First entry is the default, the original Handwriting blue. */
export const PEN_COLORS: ReadonlyArray<InkColorChoice> = [
	{ name: "blue", hex: "#2f6de0" },
	{ name: "black", hex: "#1c1f26" },
	{ name: "graphite", hex: "#5f6673" },
	{ name: "white", hex: "#f4f4f2" },
	{ name: "red", hex: "#cf3040" },
	{ name: "orange", hex: "#de6b12" },
	{ name: "green", hex: "#2f8f5b" },
	{ name: "purple", hex: "#7a4bbd" },
];

/** Highlighter bases. First entry is the default, the original yellow. */
export const HIGHLIGHTER_COLORS: ReadonlyArray<InkColorChoice> = [
	{ name: "yellow", hex: "#ffd60a" },
	{ name: "green", hex: "#a9e34b" },
	{ name: "pink", hex: "#ff6b9d" },
	{ name: "blue", hex: "#3bc9db" },
	{ name: "orange", hex: "#ffa94d" },
];

/**
 * Persistence hook, the eraser slider's pattern: main registers a writer so
 * the strip's swatches can apply a color directly. They used to run the
 * per-name color commands, which are registered only behind an off-by-default
 * setting - a fresh install had a palette of dead swatches (audit,
 * 2026-08-31).
 */
let persistColor: ((tool: InkTool, hex: string) => void) | null = null;
export function setPersistInkColor(fn: (tool: InkTool, hex: string) => void): void {
	persistColor = fn;
}

/** Set and persist a tool's color in one move; the strip's path. */
export function applyInkColor(tool: InkTool, hex: string): void {
	setInkColorHex(tool, hex);
	persistColor?.(tool, hex);
}

export function colorsFor(tool: InkTool): ReadonlyArray<InkColorChoice> {
	return tool === "highlighter" ? HIGHLIGHTER_COLORS : PEN_COLORS;
}

const HEX_RE = /^#[0-9a-f]{6}$/i;

/**
 * Pure, unit-tested: a persisted/foreign value is kept if it is an ordinary
 * six-digit hex color (future-proof for custom colors); anything else
 * falls back to the tool's default. Never throws, never returns nonsense.
 */
export function normalizeInkColor(tool: InkTool, value: unknown): string {
	if (typeof value === "string" && HEX_RE.test(value)) return value.toLowerCase();
	return colorsFor(tool)[0]!.hex;
}

/** Pure, unit-tested: next palette entry; off-palette values restart at 0. */
export function nextInkColor(tool: InkTool, currentHex: string): InkColorChoice {
	const palette = colorsFor(tool);
	const i = palette.findIndex((c) => c.hex.toLowerCase() === currentHex.toLowerCase());
	return palette[(i + 1) % palette.length]!;
}

// ---- selection state (session; the plugin persists it per tool) ------------

const selected: Record<InkTool, string> = {
	pen: PEN_COLORS[0]!.hex,
	highlighter: HIGHLIGHTER_COLORS[0]!.hex,
};

export function getInkColorHex(tool: InkTool): string {
	return selected[tool];
}

export function setInkColorHex(tool: InkTool, hex: unknown): string {
	selected[tool] = normalizeInkColor(tool, hex);
	return selected[tool];
}
