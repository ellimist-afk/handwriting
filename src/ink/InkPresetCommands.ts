/**
 * Quick pens in the command palette (1.4.12 design §4/§10): sixteen entries,
 * eight that wear a preset and eight that save one.
 *
 * WHY COMMANDS AT ALL, when the chips are two taps away in the nib's pop: the
 * request that started this feature was for SPEED ("so i can really quickly
 * change to like a thick red pen"), and the owner's public interim answer was
 * hotkeys for colour and size. A preset command is the one-key version of
 * that advice - "Pen preset 2" is a single chord for a pair that used to cost
 * two commands and a guess at which size step you were on.
 *
 * BEHIND `colorSizeCommands` ("Extra commands for hotkeys"), like every other
 * per-value entry, and for the same reason the palette split names: eleven
 * per-colour and per-size commands already buried the pen commands, and
 * sixteen more would bury them again for the many people who never star a
 * pen. The chips themselves are NOT behind the setting - they go through
 * `applyInkPreset` and the action hook, never through these commands, so a
 * fresh install with the setting off has a fully working row. A control that
 * only works when a hidden toggle is on is a dead control (InkColor.ts's
 * `setPersistInkColor` comment, and the audit that produced it).
 *
 * THE TABLE IS EXPORTED for the settings tab: the palette split renders the
 * gated commands' NAMES under the switch, on or off, from the same table
 * registration reads, so the list cannot drift from what actually registers.
 * That list lives in the palette-split slice, which is being built in
 * parallel; `PRESET_COMMANDS` is the seam it splices onto.
 */

import { InkTool } from "./Stroke";
import { MAX_PRESETS_PER_TOOL } from "./InkPresets";
import { applyInkPreset, starInkPreset } from "./InkPresets";

/** One palette entry, and the action behind it. */
export interface PresetCommand {
	id: string;
	name: string;
	/** Whose slots it acts on. Named, never "the active tool". */
	tool: InkTool;
	/** Zero-based slot; the NAME counts from one, the way a user does. */
	index: number;
	/** Wear the preset, or save the pair in hand into that slot. */
	kind: "apply" | "save";
}

const TOOL_WORD: Record<InkTool, string> = { pen: "Pen", highlighter: "Highlighter" };

/**
 * The sixteen, in the order they register: both of one tool's groups before
 * the other tool's, so the palette shows "Pen preset 1-4" together and
 * "Save current pen as preset 1-4" together under them.
 *
 * Built rather than typed out: sixteen hand-written literals are sixteen
 * chances to mistype an id, and an id is the one field a user's hotkey is
 * bound to - a typo fixed later silently unbinds their key.
 */
export const PRESET_COMMANDS: ReadonlyArray<PresetCommand> = (
	["pen", "highlighter"] as const
).flatMap((tool) => {
	const slots = Array.from({ length: MAX_PRESETS_PER_TOOL }, (_, i) => i);
	return [
		...slots.map(
			(index): PresetCommand => ({
				id: `ink-preset-${tool}-${index + 1}`,
				name: `${TOOL_WORD[tool]} preset ${index + 1}`,
				tool,
				index,
				kind: "apply",
			})
		),
		...slots.map(
			(index): PresetCommand => ({
				id: `ink-preset-save-${tool}-${index + 1}`,
				name: `Save current ${tool} as preset ${index + 1}`,
				tool,
				index,
				kind: "save",
			})
		),
	];
});

/** The narrow slice of the plugin this file needs, so a test can stand in. */
export interface PresetCommandHost {
	addCommand(command: { id: string; name: string; callback: () => void }): unknown;
}

/**
 * Register all sixteen. Called from main's existing
 * `if (this.settings.colorSizeCommands)` mechanism, so nothing here reads a
 * setting: the caller decides, exactly as it does for the per-colour set.
 *
 * "Save as preset N" writes slot N, replacing what is there. When N is past
 * the end of the row it takes the next free slot instead, because a save
 * command that wrote slot 4 while slots 2 and 3 were empty would make the
 * chips' left-to-right order stop meaning anything; the notice names the slot
 * that was actually written.
 */
export function registerInkPresetCommands(plugin: PresetCommandHost): void {
	for (const entry of PRESET_COMMANDS) {
		plugin.addCommand({
			id: entry.id,
			name: entry.name,
			callback: () => {
				// An empty slot reports through the host's own Notice rather
				// than guessing at a neighbour - see `InkPresetHost.apply`.
				if (entry.kind === "apply") applyInkPreset(entry.tool, entry.index);
				else starInkPreset(entry.tool, entry.index);
			},
		});
	}
}
