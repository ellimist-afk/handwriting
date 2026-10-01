/**
 * The palette split (1.4.12). Alan, 2026-09-05: "people are opening the
 * command palette and not seeing the flatten or the export as svg bc there
 * are too many gd options".
 *
 * ONE table, read by three callers, which is the whole point of the file:
 * main.ts registers from it, the settings tab lists it under the switch, and
 * the test pins it. A list rendered from a second copy would drift, and the
 * row promises "these are the commands you get" - a promise only a shared
 * table can keep.
 *
 * The generated entries (per-colour, per-size) are computed here from the
 * same `PEN_COLORS` / `HIGHLIGHTER_COLORS` / `INK_SIZE_STEPS` main.ts loops
 * over, in the same order, so adding a colour adds it to the settings list
 * and the registration in one move.
 *
 * QUICK PENS' sixteen preset entries are in the gated set too (`PRESET_COMMANDS`,
 * InkPresetCommands.ts), and are borrowed from that file rather than restated
 * here. They are the one gated group main.ts does not spell out - it hands
 * `addGatedCommand` to `registerInkPresetCommands` and the table does the
 * naming - so a copy in this file would be the second list this file exists to
 * prevent, and the settings row would promise ids nothing registered.
 */

import { HIGHLIGHTER_COLORS, PEN_COLORS } from "./ink/InkColor";
import { INK_SIZE_STEPS } from "./ink/InkSize";
import { PRESET_COMMANDS } from "./ink/InkPresetCommands";

/** A palette entry: the hotkey contract (`id`) and what the palette shows. */
export interface PaletteCommand {
	readonly id: string;
	readonly name: string;
}

/**
 * The fifteen that stay registered whatever the setting says: everything the
 * pen toolbar cannot do, plus the two nibs and the two input toggles, which
 * are the way BACK when the strip is hidden, and the toolbar and zoom bar
 * toggle, which is the way back when both bars are hidden.
 *
 * FOURTEEN until 1.4.20: `Pen on / off` absorbed the other pen command, and the toolbar
 * auto/show/hide command left with its retired settings row.
 * Alan, 2026-09-05: "there are two of these Handwriting: Pen and Handwriting:
 * toggle pen input on/off - i think that's stupid there should only be one" ->
 * "Pen on / off like Mouse on / off". `inline-tool-pen` kept its id, so a
 * hotkey bound to it still resolves, and the `pen-ink-toggle` entry that used
 * to sit under this one is gone from the palette entirely. Its MECHANISM is
 * untouched - the strip's keyboard button still flips `penInkEnabled`, and
 * still reaches it by that same id through `setRetiredCommandAction` below.
 *
 * Not exhaustive of the palette: `Bug report: record / send / show as text`
 * are always registered too and are deliberately outside this table - they
 * are reporting instruments, not ink commands, and nothing gates them.
 */
export const ALWAYS_COMMANDS: readonly PaletteCommand[] = [
	{ id: "inline-tool-pen", name: "Pen on / off" },
	{ id: "inline-tool-highlighter", name: "Highlighter" },
	{ id: "mouse-ink-toggle", name: "Mouse on / off" },
	{ id: "paper-cycle", name: "Paper: none / lines / grid / dots" },
	{ id: "toolbar-zoom-bar-toggle", name: "Toolbar on / off" },
	{ id: "export-ink-svg", name: "Export ink as SVG (drawing only)" },
	{ id: "export-ink-pdf", name: "Export ink as PDF (drawing only)" },
	{ id: "flatten-pdf-ink", name: "Flatten ink into a copy of this PDF" },
	{ id: "snip-pdf-selection", name: "Snip the selection to an image" },
	{ id: "delete-all-ink", name: "Delete all ink on this note" },
	{ id: "delete-all-pdf-ink", name: "Delete all ink on this PDF" },
	{ id: "copy-selected-ink", name: "Lasso: copy selection" },
	{ id: "cut-selected-ink", name: "Lasso: cut selection" },
	{ id: "delete-selected-ink", name: "Lasso: delete selection" },
	{ id: "paste-ink", name: "Lasso: paste" },
];

/**
 * The nine fixed entries behind "Extra commands for hotkeys": the four tool
 * toggles and the five cycles. Every one of them is a button on the pen
 * toolbar, which is why they can leave the palette without leaving the
 * plugin - see `runGatedCommand` for the half of that promise the strip needs.
 *
 * `pen-tools-cycle` is NOT here or in `ALWAYS_COMMANDS`: its palette command
 * was retired with the toolbar auto/show/hide settings row.
 */
export const GATED_FIXED_COMMANDS: readonly PaletteCommand[] = [
	{ id: "inline-tool-eraser", name: "Toggle eraser on / off" },
	{ id: "inline-tool-lasso", name: "Toggle lasso on / off" },
	{ id: "inline-tool-space", name: "Toggle insert space on / off" },
	{ id: "inline-tool-pan", name: "Toggle pan on / off" },
	{ id: "ink-color-cycle", name: "Ink color: next" },
	{ id: "pen-color-cycle", name: "Pen color: next" },
	{ id: "highlighter-color-cycle", name: "Highlighter color: next" },
	{ id: "ink-size-cycle", name: "Ink size: next" },
	{ id: "eraser-size-cycle", name: "Eraser size: next" },
];

/**
 * The per-size and per-colour entries, generated exactly as main.ts generates
 * them: sizes, then ink colours over the union of both palettes (pen order
 * first, the highlighter's own names appended), then the highlighter's five.
 */
export function gatedGeneratedCommands(): PaletteCommand[] {
	const out: PaletteCommand[] = [];
	for (const step of INK_SIZE_STEPS) out.push({ id: `ink-size-${step.name}`, name: `Ink size: ${step.name}` });
	for (const name of inkColorNames()) out.push({ id: `ink-color-${name}`, name: `Ink color: ${name}` });
	for (const c of HIGHLIGHTER_COLORS)
		out.push({ id: `highlighter-color-${c.name}`, name: `Highlighter color: ${c.name}` });
	return out;
}

/** The union main.ts's `ink-color-*` loop walks, in its order. */
export function inkColorNames(): string[] {
	return [...new Set([...PEN_COLORS, ...HIGHLIGHTER_COLORS].map((c) => c.name))];
}

/**
 * Quick pens' sixteen, as palette entries: the id and the name, dropped of the
 * `tool`/`index`/`kind` fields only the registrar's callback cares about.
 *
 * LAST in the gated list, and deliberately: the settings row prints this list
 * in order, and "Pen preset 1" means nothing to a reader who has never starred
 * a pen, while the toggles and the colour names above it are things they can
 * already see on the strip.
 */
export function gatedPresetCommands(): PaletteCommand[] {
	return PRESET_COMMANDS.map((c) => ({ id: c.id, name: c.name }));
}

/**
 * Every command behind the setting: the nine fixed, the generated per-size and
 * per-colour ones, then quick pens' sixteen.
 */
export function gatedCommands(): PaletteCommand[] {
	return [...GATED_FIXED_COMMANDS, ...gatedGeneratedCommands(), ...gatedPresetCommands()];
}

/** What the settings row prints under the switch. */
export function gatedCommandNames(): string[] {
	return gatedCommands().map((c) => c.name);
}

/**
 * THE HALF THE SPLIT WOULD OTHERWISE BREAK.
 *
 * The pen toolbar's eraser, lasso, insert-space and pan buttons do not carry
 * their own logic: they `executeCommandById("handwriting:inline-tool-...")`
 * (MobileTools.ts's `exec`). Un-registering those ids would have left four
 * dead buttons on every default install - the same failure the per-name
 * colour swatches hit in the 2026-08-31 audit ("a fresh install had a palette
 * of dead swatches", InkColor.ts).
 *
 * So registration is what the setting gates, not the ACTION. main.ts files a
 * callback here for exactly the commands it kept OUT of the palette, which
 * makes `runGatedCommand` a decision rather than a guess: it answers true only
 * when the id is one the palette does not have, so the two exec bridges
 * (main.ts's pdf strip, InkOverlay.ts's note strip) can try it FIRST and fall
 * through to `executeCommandById` for everything else. No reading of
 * Obsidian's private registry, and no way to run a command twice.
 *
 * Hotkeys and the palette still see only what is registered, which is what was
 * asked for.
 */
const actions = new Map<string, () => void>();

/**
 * THE OTHER MAP, and the reason it is not this one: ids the palette no longer
 * holds AT ALL.
 *
 * `pen-ink-toggle` left the palette for good in 1.4.12 (`ALWAYS_COMMANDS`
 * above), but the strip's keyboard button still names it - it is the button's
 * identity in `DEFAULT_FOLD_ORDER` and in every fold order already saved to a
 * user's data.json, so the id cannot be renamed without silently dropping
 * their arrangement. So the ACTION is filed, exactly as a gated command's is,
 * and `runGatedCommand` answers for both.
 *
 * SEPARATE FROM `actions` BECAUSE THE SWITCH MUST NEVER SEE IT.
 * `gatedCommandActionIds()` feeds `planGatedCommands` as the `mirrored` half,
 * and that function folds any mirrored id into the set it decides for. A
 * retired id filed in `actions` would therefore be planned for `toUnmirror`
 * the moment "Extra commands for hotkeys" went on - its fallback dropped, and
 * nothing registered in its place, because main.ts holds no definition to
 * register. A dead keyboard button, which is the exact failure this whole file
 * exists to prevent. Kept in its own map, it is invisible to the plan and
 * answers forever.
 */
const retired = new Map<string, () => void>();

/** The bare id, whichever spelling the caller has in hand. */
function bareId(id: string): string {
	return id.startsWith("handwriting:") ? id.slice("handwriting:".length) : id;
}

/** Called by main.ts for each gated command it did NOT register. */
export function setGatedCommandAction(id: string, run: () => void): void {
	actions.set(bareId(id), run);
}

/**
 * File the action for a command the palette has RETIRED - see `retired` above.
 * Takes either spelling of the id for the same reason `runGatedCommand` does:
 * the strip has the prefixed one in hand and should not have to know.
 */
export function setRetiredCommandAction(id: string, run: () => void): void {
	retired.set(bareId(id), run);
}

/**
 * Run a gated or retired command by its bare id or its `handwriting:`-prefixed
 * one. Returns whether anything ran, so a caller can tell "not ours" from
 * "done".
 */
export function runGatedCommand(id: string): boolean {
	const bare = bareId(id);
	const run = actions.get(bare) ?? retired.get(bare);
	if (!run) return false;
	run();
	return true;
}

/**
 * Cleared at the top of every load: module state outlives a plugin reload.
 * Both maps, because both hold closures over the load that filed them.
 */
export function clearGatedCommandActions(): void {
	actions.clear();
	retired.clear();
}

/**
 * Drop ONE command's fallback, because the palette has just taken it back.
 * The complement of `setGatedCommandAction`, and the reason the switch can
 * move without a reload: see `planGatedCommands`.
 */
export function clearGatedCommandAction(id: string): void {
	actions.delete(id);
}

/** The ids holding a fallback right now - the mirrored half, read back. */
export function gatedCommandActionIds(): string[] {
	return [...actions.keys()];
}

/** What one flip of the switch has to do to the command registry. */
export interface GatedCommandPlan {
	/** Hand each of these to `addCommand`. */
	readonly toRegister: readonly string[];
	/** Take each of these out of the command registry. */
	readonly toRemove: readonly string[];
	/** File a strip fallback for each, with `setGatedCommandAction`. */
	readonly toMirror: readonly string[];
	/** Drop each fallback: the palette holds that command now. */
	readonly toUnmirror: readonly string[];
}

/** Where the two halves stand, and where the switch now says they belong. */
export interface GatedCommandState {
	/** Gated ids in the command registry right now. */
	readonly registered: Iterable<string>;
	/** Gated ids holding a strip fallback right now (`gatedCommandActionIds`). */
	readonly mirrored: Iterable<string>;
	/** What "Extra commands for hotkeys" now says. */
	readonly want: boolean;
	/** Whether this Obsidian can un-register a command at all. */
	readonly canRemove: boolean;
	/** The gated ids to decide for. Defaults to the shared table. */
	readonly ids?: Iterable<string>;
}

/**
 * WHICH IDS MOVE WHEN THE SWITCH MOVES (1.4.12).
 *
 * "Extra commands for hotkeys" used to say "Takes effect after the plugin
 * reloads": onload read the setting once and the two halves were settled for
 * the session. A live switch is that same decision taken again at any moment,
 * from wherever the halves currently stand - a pure question, answered here
 * rather than in main.ts so it can be tested without an Obsidian to run.
 *
 * THE INVARIANT, and why the mirror target is written as one expression rather
 * than a second rule: a gated id is registered OR mirrored, never both and
 * never neither. Registered, and it answers the palette, a hotkey, and
 * `executeCommandById` - which is what the strip falls through to. Mirrored,
 * and it answers `runGatedCommand`, which the strip tries FIRST. Both, and the
 * palette holds a command the strip will never reach through it; neither, and
 * the strip button is dead, which is the failure this whole file exists to
 * prevent. `wantMirrored` below is `!wantRegistered` and nothing else, so the
 * two cannot drift apart no matter what the caller passes in.
 *
 * `canRemove` is the honest half. Un-registering needs `Plugin.removeCommand`
 * (obsidian.d.ts, since 1.7.2) or the app's own command registry; where
 * neither exists, turning the switch OFF cannot take anything out of the
 * palette, so those commands stay registered and stay unmirrored - the state
 * that was already true - and the row keeps its reload sentence. Filing
 * mirrors for commands that are still in the palette is the one move that
 * would break the invariant, and this is where it is refused.
 *
 * Idempotent by construction: the plan is the DIFFERENCE between where the two
 * halves are and where they belong, so applying it and asking again returns
 * four empty lists. Toggling on twice registers once.
 */
export function planGatedCommands(state: GatedCommandState): GatedCommandPlan {
	const registered = new Set(state.registered);
	const mirrored = new Set(state.mirrored);
	// The table first, so the plan comes out in the order the settings row
	// prints. Anything already registered or mirrored is folded in after, so an
	// id that has left the table cannot be stranded in the palette with no rule
	// to take it out again.
	const ids = new Set<string>(state.ids ?? gatedCommands().map((c) => c.id));
	for (const id of registered) ids.add(id);
	for (const id of mirrored) ids.add(id);

	const toRegister: string[] = [];
	const toRemove: string[] = [];
	const toMirror: string[] = [];
	const toUnmirror: string[] = [];
	for (const id of ids) {
		const isRegistered = registered.has(id);
		const isMirrored = mirrored.has(id);
		const wantRegistered = state.want || (!state.canRemove && isRegistered);
		const wantMirrored = !wantRegistered;
		if (wantRegistered && !isRegistered) toRegister.push(id);
		if (!wantRegistered && isRegistered) toRemove.push(id);
		if (wantMirrored && !isMirrored) toMirror.push(id);
		if (!wantMirrored && isMirrored) toUnmirror.push(id);
	}
	return { toRegister, toRemove, toMirror, toUnmirror };
}
