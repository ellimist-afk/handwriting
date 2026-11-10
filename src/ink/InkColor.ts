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
	/** Tooltip and aria name of a live slot: the name, plus the hex when the colour is custom. */
	readonly title?: string;
}

/** Pen inks. First entry is the default, the original Handwriting blue. */
export const PEN_COLORS: ReadonlyArray<InkColorChoice> = [
	{ name: "blue", hex: "#2f6de0" },
	{ name: "black", hex: "#000000" },
	{ name: "graphite", hex: "#5f6673" },
	{ name: "white", hex: "#f4f4f2" },
	{ name: "red", hex: "#cf3040" },
	{ name: "orange", hex: "#de6b12" },
	{ name: "green", hex: "#12873d" },
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

/** The shipped palette for a tool: the defaults every slot resets to. */
export function defaultColorsFor(tool: InkTool): ReadonlyArray<InkColorChoice> {
	return tool === "highlighter" ? HIGHLIGHTER_COLORS : PEN_COLORS;
}

// ---- the live palette (1.5.0: every slot is the user's to change) ----------
//
// Pushed in from settings the way the selected colour is (setInkPalette at
// load and at every edit); this file imports no settings. A slot keeps its
// default name as its identity - command ids, aria-labels and tooltips are
// written in it - and only its hex is the user's.

/** Slot `index` of `tool` holding `hex`: the default name kept, the title made from both. */
function slotChoice(tool: InkTool, index: number, hex: string): InkColorChoice {
	const d = defaultColorsFor(tool)[index]!;
	return { name: d.name, hex, title: hex === d.hex ? d.name : `${d.name} ${hex}` };
}

const live: Record<InkTool, InkColorChoice[]> = {
	pen: PEN_COLORS.map((c, i) => slotChoice("pen", i, c.hex)),
	highlighter: HIGHLIGHTER_COLORS.map((c, i) => slotChoice("highlighter", i, c.hex)),
};

/** The live palette for a tool, in slot order. */
export function colorsFor(tool: InkTool): ReadonlyArray<InkColorChoice> {
	return live[tool];
}

const HEX_RE = /^#[0-9a-f]{6}$/i;

/**
 * Pure, unit-tested: a persisted/foreign value is kept if it is an ordinary
 * six-digit hex color; anything else falls back to the tool's DEFAULT slot 0.
 * The fallback never follows the user's edit of slot 0: this is the
 * sanitiser saved strokes and exports go through, and saved ink never
 * changes how it looks.
 */
export function normalizeInkColor(tool: InkTool, value: unknown): string {
	if (typeof value === "string" && HEX_RE.test(value)) return value.toLowerCase();
	return defaultColorsFor(tool)[0]!.hex;
}

/**
 * Pure, unit-tested: a stored palette read slot by slot. Takes the list form
 * or the slot map form ({"0": hex, ...}); a bad or missing slot gets that
 * slot's default, slots past the tool's count are dropped. Always returns
 * 8 pen or 5 highlighter hexes.
 */
export function normalizeInkPalette(tool: InkTool, value: unknown): string[] {
	const slots = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
	return defaultColorsFor(tool).map((d, i) => {
		const v = slots[String(i)];
		return typeof v === "string" && HEX_RE.test(v) ? v.toLowerCase() : d.hex;
	});
}

/** Replace a tool's live palette; the value is read through normalizeInkPalette. */
export function setInkPalette(tool: InkTool, value: unknown): void {
	const hexes = normalizeInkPalette(tool, value);
	live[tool] = hexes.map((hex, i) => slotChoice(tool, i, hex));
}

/**
 * Change one slot. The selected colour follows the edit when it was the
 * slot's old colour; otherwise it is left alone. Returns the tool's selected
 * colour after the edit, so the caller can persist it beside the palette.
 */
export function setInkPaletteSlot(tool: InkTool, index: number, hex: unknown): string {
	const slot = live[tool][index];
	if (!slot) return selected[tool];
	const next = normalizeInkPalette(tool, { [index]: hex })[index]!;
	live[tool] = live[tool].map((c, i) => (i === index ? slotChoice(tool, i, next) : c));
	if (selected[tool] === slot.hex) selected[tool] = next;
	return selected[tool];
}

/** A slot's short label: its default name while it holds its default colour, else its hex. */
export function inkColorLabel(tool: InkTool, index: number): string {
	const slot = live[tool][index];
	const d = defaultColorsFor(tool)[index];
	if (!slot || !d) return "";
	return slot.hex === d.hex ? d.name : slot.hex;
}

/** A slot's tooltip and aria name: its default name, with the hex added when the colour is custom. */
export function inkColorTitle(tool: InkTool, index: number): string {
	return live[tool][index]?.title ?? "";
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

/** A bad value falls back to the LIVE slot 0: the selected colour is the user's, not saved ink. */
export function setInkColorHex(tool: InkTool, hex: unknown): string {
	selected[tool] = typeof hex === "string" && HEX_RE.test(hex) ? hex.toLowerCase() : live[tool][0]!.hex;
	return selected[tool];
}
