/**
 * Quick pens (1.4.12 design §4): a handful of starred colour+width pairs.
 *
 * The request, verbatim: "Would love to have like some starred pens in the
 * ink tool bar so i can really quickly change to like a thick red pen"
 * (Natural_Reputation42). The owner answered it in public - "will put that
 * feature on the roadmap" - so the feature is promised; only its shape was
 * open.
 *
 * NOT ON THE STRIP, which is the one thing the request asked for and the one
 * thing it cannot have. The strip had just been cut from thirteen buttons to
 * ten at rest (1.4.12, the selection group hiding instead of dimming), and
 * four more chips on it would spend that cut in the same release. The nib's
 * SIZE POP is the honest home: it already holds half a preset - the width -
 * and it opens off the button you already press when you want the pen to
 * write differently. The row sits BELOW the value chip and above the swatches
 * - the slider stays at the top, under the thumb that just opened the pop, and
 * a pop with no presets grows by one small row. (See the build order at
 * MobileTools.ts's `handwriting-pop-presets`, which is the truth; design §10
 * asked for presets first and the pop was not rebuilt around it.)
 *
 * Four per tool. Not a measurement - a decision, and it has a reason: the row
 * hangs under one 28px strip button, and the colour pop beside it already
 * proved what happens when a pop wants more width than a narrow tablet has
 * (batendalyn, Boox Tab XC, 2026-09-02: swatches squeezed into ovals). Four
 * chips and a star fit the width the colour pop already occupies. A fifth
 * would not, and a preset you have to hunt for is slower than the slider it
 * replaced.
 *
 * The list operations here are total functions over a plain array: the
 * plugin normalises whatever data.json holds without trusting a byte of it,
 * and every mutation returns a NEW array so a caller can never half-apply
 * one. The session list and the action hook at the foot follow InkColor.ts's
 * shape - module state the strip reads, a writer main registers - for the
 * reason that file gives in its own comment: the strip must not reach the
 * feature through commands, because commands can live behind an
 * off-by-default setting and a control that only works when a hidden toggle
 * is on is a dead control.
 */

import { InkTool } from "./Stroke";
import { colorsFor, normalizeInkColor } from "./InkColor";
import { INK_SIZE_STEPS, clampInkSize } from "./InkSize";

export interface InkPreset {
	/** Which nib wears it. Each tool keeps its own slots. */
	tool: InkTool;
	/** Six-digit hex, normalised through `normalizeInkColor`. */
	hex: string;
	/**
	 * The colour's name when it was starred. Redundant with `hex` today -
	 * `presetLabel` re-derives the word from the live palette so a renamed
	 * or retuned palette entry relabels every preset that wears it - and
	 * kept because it is in the persisted shape the design names, and
	 * because a hex the palette no longer knows still deserves a word.
	 */
	name: string;
	/**
	 * The nib size MULTIPLIER, exactly the number `settings.inkSizes` already
	 * persists - not pixels. Pen and highlighter have different base widths,
	 * so a multiplier is the only form that means the same thing in both.
	 */
	size: number;
}

/** Slots per tool. See the header for why it is four and not more. */
export const MAX_PRESETS_PER_TOOL = 4;

function isTool(value: unknown): value is InkTool {
	return value === "pen" || value === "highlighter";
}

/**
 * The palette's word for a hex, or the hex itself when nothing matches.
 * Off-palette colours are already legal everywhere else (`normalizeInkColor`
 * keeps any six-digit hex on purpose, "future-proof for custom colors"), so
 * a preset must be able to name one without inventing a word for it.
 */
export function colorNameFor(tool: InkTool, hex: string): string {
	const hit = colorsFor(tool).find((c) => c.hex.toLowerCase() === hex.toLowerCase());
	return hit ? hit.name : hex;
}

/**
 * The size word, taken from the three the "Ink size:" commands already use
 * (`INK_SIZE_STEPS`: fine, medium, bold) rather than a fourth vocabulary
 * invented here. The nib sliders are continuous now, so a starred pen very
 * often sits between two steps; the NEAREST step names it, and a dead tie
 * goes to the finer word because the list is walked in order.
 *
 * The epsilon is what makes that tie rule TRUE rather than a coin flip.
 * 0.8 sits exactly between fine (0.6) and medium (1), and in binary it does
 * not: |0.6-0.8| computes as 0.20000000000000007 against |1-0.8|'s
 * 0.19999999999999996, so a bare `<` handed the halfway point to medium on
 * arithmetic noise alone. A step must beat the incumbent by more than that
 * noise to take the word.
 */
export function sizeWordFor(mult: number): string {
	let best = INK_SIZE_STEPS[0]!;
	for (const step of INK_SIZE_STEPS) {
		if (Math.abs(step.mult - mult) < Math.abs(best.mult - mult) - 1e-9) best = step;
	}
	return best.name;
}

/** What a chip says it is: "red, bold". */
export function presetLabel(preset: InkPreset): string {
	return `${colorNameFor(preset.tool, preset.hex)}, ${sizeWordFor(preset.size)}`;
}

/**
 * Whatever data.json holds, turned into a list this plugin can act on.
 * Junk entries are DROPPED rather than repaired into something the user
 * never starred; a junk hex or size inside an otherwise valid entry is
 * clamped, because those two have real fallbacks and the entry is still the
 * slot somebody saved.
 */
export function normalizeInkPresets(raw: unknown): InkPreset[] {
	if (!Array.isArray(raw)) return [];
	const out: InkPreset[] = [];
	const used: Record<InkTool, number> = { pen: 0, highlighter: 0 };
	for (const item of raw) {
		if (typeof item !== "object" || item === null) continue;
		const rec = item as Record<string, unknown>;
		const tool = rec.tool;
		if (!isTool(tool)) continue;
		if (used[tool] >= MAX_PRESETS_PER_TOOL) continue;
		used[tool] += 1;
		const hex = normalizeInkColor(tool, rec.hex);
		const size = clampInkSize(typeof rec.size === "number" ? rec.size : Number.NaN);
		const name =
			typeof rec.name === "string" && rec.name.trim() !== ""
				? rec.name
				: colorNameFor(tool, hex);
		out.push({ tool, hex, name, size });
	}
	return out;
}

/** One tool's slots, in slot order. The chips index into exactly this. */
export function presetsFor(list: ReadonlyArray<InkPreset>, tool: InkTool): InkPreset[] {
	return list.filter((p) => p.tool === tool).slice(0, MAX_PRESETS_PER_TOOL);
}

/**
 * Put one tool's slots back into the flat list without disturbing the other
 * tool's entries. The list is flat because that is the persisted shape, but
 * the indices a chip and a "Pen preset 2" hotkey use are PER TOOL, so the
 * one thing that must be stable across a write is each tool's own order.
 */
function withSlots(
	list: ReadonlyArray<InkPreset>,
	tool: InkTool,
	slots: ReadonlyArray<InkPreset>
): InkPreset[] {
	const out: InkPreset[] = [];
	let written = false;
	for (const p of list) {
		if (p.tool !== tool) {
			out.push(p);
			continue;
		}
		if (written) continue;
		out.push(...slots);
		written = true;
	}
	if (!written) out.push(...slots);
	return out;
}

/**
 * Star a pen: it takes the first empty slot, and when the tool is full it
 * replaces the LAST one. Replacing the last rather than the first keeps
 * "Pen preset 1" - the slot most likely to be on a hotkey - the one the user
 * chose first and has not asked to lose; the tail is where a fifth star
 * lands and where a sixth lands after it.
 */
export function addPreset(list: ReadonlyArray<InkPreset>, preset: InkPreset): InkPreset[] {
	const mine = presetsFor(list, preset.tool);
	const slots =
		mine.length < MAX_PRESETS_PER_TOOL
			? [...mine, preset]
			: [...mine.slice(0, MAX_PRESETS_PER_TOOL - 1), preset];
	return withSlots(list, preset.tool, slots);
}

/**
 * The slot a save lands in. With an index, that slot when it holds a preset
 * and the next free one when it does not, so the row never has a gap; without
 * one, the rule `addPreset` has always had.
 */
export function presetSlotFor(
	list: ReadonlyArray<InkPreset>,
	tool: InkTool,
	index?: number
): number {
	const count = presetsFor(list, tool).length;
	if (index === undefined) return count < MAX_PRESETS_PER_TOOL ? count : MAX_PRESETS_PER_TOOL - 1;
	return Math.max(0, Math.min(index, count, MAX_PRESETS_PER_TOOL - 1));
}

/**
 * Save a pen into slot `index`, replacing what is there. A slot past the end
 * appends instead, in the next free slot, so a hotkey for slot 4 with two
 * saved cannot leave slots 3 and 4 empty and the chips out of order.
 */
export function addPresetAt(
	list: ReadonlyArray<InkPreset>,
	preset: InkPreset,
	index: number
): InkPreset[] {
	const mine = presetsFor(list, preset.tool);
	const slots = [...mine];
	slots[presetSlotFor(list, preset.tool, index)] = preset;
	return withSlots(list, preset.tool, slots);
}

/** Drop one slot. An index nothing occupies leaves the list alone. */
export function removePreset(
	list: ReadonlyArray<InkPreset>,
	tool: InkTool,
	index: number
): InkPreset[] {
	const mine = presetsFor(list, tool);
	if (index < 0 || index >= mine.length) return [...list];
	return withSlots(
		list,
		tool,
		mine.filter((_, i) => i !== index)
	);
}

// ---- what the strip's row draws, decided without a DOM -------------------

/**
 * The smallest and largest a chip's dot may be drawn, in px. The cell it
 * sits in is the swatch's 22px, so 20 is a dot that fills its cell without
 * touching its neighbour's, and 8 is still a target a thumb can hit through
 * the button around it - the BUTTON is the hit area, not the dot.
 */
export const PRESET_DOT_MIN_PX = 8;
export const PRESET_DOT_MAX_PX = 20;

/**
 * How close two multipliers have to be to count as the same pen.
 *
 * Not exact equality: the nib sliders are continuous and work in PIXELS,
 * so a size makes a px-to-multiplier round trip between being starred and
 * being compared, and a preset the user has plainly re-selected must not
 * lose its ring to the last decimal of that trip. A thousandth of a
 * multiplier is 0.002px of pen and 0.016px of highlighter - under any
 * screen's ability to show it.
 */
const SAME_SIZE = 1e-3;

/** One chip, decided: what colour, how big, and whether it is the one in hand. */
export interface PresetChip {
	/** The slot, so a tap and a long-press both know what they hit. */
	index: number;
	hex: string;
	/** "red, bold" - the aria-label and the toast's words alike. */
	label: string;
	/** Dot diameter in px, from the width multiplier. */
	dotPx: number;
	/** Live colour AND size both equal this preset's. */
	current: boolean;
}

/**
 * The dot's diameter from a preset's width multiplier, in the slider's own
 * vocabulary: `INK_SIZE_STEPS`'s finest step draws the smallest dot, its
 * boldest the largest, and anything between lands proportionally between.
 *
 * The two nibs are NOT scaled by their own base widths, which would be the
 * literal reading of "sized by its width": the highlighter's base is 16px
 * against the pen's 2.2, so a fair pixel scale would draw every highlighter
 * preset at the cap and every pen preset in a heap at the floor. The chips
 * answer "which of my pens is this", and within one tool the multiplier is
 * exactly that question.
 */
export function presetDotPx(mult: number): number {
	const lo = INK_SIZE_STEPS[0]!.mult;
	const hi = INK_SIZE_STEPS[INK_SIZE_STEPS.length - 1]!.mult;
	const t = Math.min(1, Math.max(0, (mult - lo) / (hi - lo)));
	return Math.round(PRESET_DOT_MIN_PX + t * (PRESET_DOT_MAX_PX - PRESET_DOT_MIN_PX));
}

/**
 * The row, as data. Pure so the decisions in it - which chips exist, which
 * one is ringed, how big each dot is - are testable without a strip, a pop
 * or a document; the builder in MobileTools.ts only turns this into buttons.
 */
export function presetChips(
	presets: ReadonlyArray<InkPreset>,
	liveHex: string,
	liveSize: number
): PresetChip[] {
	return presets.map((p, index) => ({
		index,
		hex: p.hex,
		label: presetLabel(p),
		dotPx: presetDotPx(p.size),
		// Both halves, because either alone would ring a pen the user is not
		// holding: a red bold and a red fine are two different presets, and
		// the row's whole job is telling them apart.
		current:
			p.hex.toLowerCase() === liveHex.toLowerCase() &&
			Math.abs(p.size - liveSize) < SAME_SIZE,
	}));
}

/**
 * Whether the star will REPLACE rather than append - all four slots full.
 * The star is enabled either way (a fifth star is a legitimate thing to
 * want); this is only for what its label says it will do.
 */
export function starReplaces(presets: ReadonlyArray<InkPreset>): boolean {
	return presets.length >= MAX_PRESETS_PER_TOOL;
}

// ---- session state (the plugin owns the settings copy and pushes it here) --

let current: InkPreset[] = [];

/** The whole list, for anything that wants both tools at once. */
export function getInkPresets(): ReadonlyArray<InkPreset> {
	return current;
}

/** Called on load and after every star or removal. Copied, never aliased. */
export function setInkPresets(list: ReadonlyArray<InkPreset>): void {
	current = [...list];
}

/** What the strip's row draws. */
export function inkPresetsFor(tool: InkTool): InkPreset[] {
	return presetsFor(current, tool);
}

// ---- the strip's route to the plugin (InkColor.ts's `setPersistInkColor`) --

/**
 * The three things a chip can do. Registered by main, which owns the
 * settings, the persistence and the one toast per action; the strips call
 * through the three wrappers below so neither surface has to know how any of
 * that is done, and so the pdf strip and the note strip cannot drift.
 */
export interface InkPresetActions {
	apply(tool: InkTool, index: number): void;
	star(tool: InkTool, index?: number): void;
	remove(tool: InkTool, index: number): void;
}

let actions: InkPresetActions | null = null;

export function setInkPresetActions(next: InkPresetActions | null): void {
	actions = next;
}

/** A chip was tapped. Silent when nothing is registered, never a throw. */
export function applyInkPreset(tool: InkTool, index: number): void {
	actions?.apply(tool, index);
}

/**
 * The star was pressed, or a save command ran: save what is in hand. The
 * chip's star names no slot; a "Save ... as preset N" command names N.
 */
export function starInkPreset(tool: InkTool, index?: number): void {
	actions?.star(tool, index);
}

/** A chip was held or right-clicked. */
export function forgetInkPreset(tool: InkTool, index: number): void {
	actions?.remove(tool, index);
}
