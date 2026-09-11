/**
 * The plugin's half of quick pens (1.4.12 design §4/§10): the three actions
 * `InkPresets.ts` declares, given bodies that reach the same setters every
 * other route to a colour or a size already reaches.
 *
 * WHY A FILE OF ITS OWN. `InkPresets.ts` is pure by design - it holds the
 * list and the hook, and knows nothing about Obsidian - while main.ts is
 * 4000 lines that no slice should add a fourth screen to. So the bodies live
 * here and main.ts gains one call: `installInkPresetActions(store)`, with the
 * store being the only thing main.ts genuinely owns (its settings object and
 * its save).
 *
 * APPLY REUSES, IT DOES NOT REIMPLEMENT. A preset is a colour and a size, and
 * both already have exactly one honest way to be set:
 *   - `applyInkColor` (InkColor.ts) - session state plus the persistence hook
 *     main registers, the same call the strip's swatch tap makes through
 *     `pickStripColor`.
 *   - `applyInkSize` (InkOverlay.ts) - the same pair the nib slider commits
 *     on release, lifted into a named twin of `applyInkColor` so a caller
 *     outside that module can make it.
 * Nothing here writes `settings.inkColors` or `settings.inkSizes` directly:
 * if it did, a preset would persist by a different road than a swatch and the
 * two would drift the first time either road changed.
 *
 * AND IT PICKS UP THE NIB, for the reason the per-colour commands give in
 * main.ts: choosing an ink from lasso or eraser mode used to pick NOTHING up
 * (glass, 2026-08-31). A preset is a stronger version of that choice - it
 * names the tool - so "Highlighter preset 2" fired while the pen is in hand
 * puts the highlighter in hand, rather than silently restyling a nib that is
 * not writing.
 *
 * ONE NOTICE, REWRITTEN IN PLACE. Presets are exactly the spammable shape the
 * keyboard toggle's stacked toast was (Alan, 2026-09-05: "when spamming the
 * toast for keyboard doesnt have the current state last") - four chips a
 * thumb's width apart, and four hotkeys beside them. So the presets own one
 * Notice and rewrite it, the rule `ownedNotice` gave the six toggles.
 *
 * The factory is repeated here rather than imported because main.ts's is
 * module-private, and PenToggleNotice.test.ts pins main.ts to exactly six
 * `= ownedNotice();` slots - that count is the toggles' own contract, and a
 * seventh slot for a feature that is not a toggle would spend it. Importing
 * main.ts from here would also close an import cycle, since main.ts imports
 * this file.
 *
 * WHAT IS NOT REPEATED is the UNLOAD REGISTRY. Repeating the factory left
 * this slot out of reach of `hideOwnedNotices`, so a chip tapped just before
 * a reload left its toast standing with nothing to put it down. The registry
 * is now a leaf module both files import (`../OwnedNotices`) - no cycle,
 * because it imports nothing itself.
 */

import { Notice } from "obsidian";
import { routineNoticesVisible } from "../diag/RoutineNotices";
import { InkTool } from "./Stroke";
import {
	InkPreset,
	addPreset,
	colorNameFor,
	inkPresetsFor,
	presetLabel,
	removePreset,
	setInkPresetActions,
	setInkPresets,
} from "./InkPresets";
import { applyInkColor, getInkColorHex } from "./InkColor";
import {
	applyInkSize,
	getInkSizeMult,
	refreshAllStrips,
	refreshPenToolsAll,
	setInlineEraserMode,
	setInlineLassoMode,
	setInlinePanMode,
	setInlineSpaceMode,
	setInlineTool,
} from "../inline/InkOverlay";
import { markPenSeen } from "../inline/PenToolsMode";
import { ownedNoticeHiders } from "../OwnedNotices";

/**
 * What the plugin lends this module: the persisted list and a way to write
 * it. Deliberately not the plugin object - a store this small is what a test
 * can stand in for, and it is all the actions actually need.
 */
export interface InkPresetStore {
	/** The settings copy, as loaded and normalised. */
	list(): ReadonlyArray<InkPreset>;
	/** Replace it and save. The caller owns the debounce and the error path. */
	save(next: ReadonlyArray<InkPreset>): void;
}

/**
 * One Notice for every preset action, rewritten rather than stacked.
 *
 * AND REGISTERED FOR UNLOAD, the half this slot was missing: a Notice is
 * Obsidian's DOM on Obsidian's own timeout, so tapping a chip and then
 * disabling or reloading the plugin inside that timeout left the toast on
 * screen with nothing left to put it down. The slot is module scope and
 * closed over, so `onunload` cannot reach it by name; pushing `clear` into
 * the shared registry (`OwnedNotices.ts`) is what main.ts's
 * `hideOwnedNotices` walks.
 *
 * The rewrite half and the unload half are ONE function, exactly as
 * main.ts's `ownedNotice` writes it - put down whatever this slot is still
 * showing - because two copies of the hide-if-showing rule are two things
 * that can drift apart.
 */
function ownedPresetNotice(): (message: string, routine?: boolean) => void {
	let notice: Notice | null = null;
	const clear = (): void => {
		// The same dead-Notice probe main.ts documents at length: a hidden or
		// timed-out Notice has had its element detached, and hiding it again
		// is what would throw.
		if (notice?.messageEl?.isConnected) notice.hide();
		notice = null;
	};
	ownedNoticeHiders.push(clear);
	return (message: string, routine = false) => {
		// CLEAR FIRST, ALWAYS - including when the message itself stays silent.
		// This slot is SHARED by all four preset sentences, and two of them are
		// retained ("... is empty.", "removed ..."). Without this, a retained
		// toast left on screen would outlive the action it described: pick a
		// preset up successfully while "preset 2 is empty." is showing, and the
		// stale sentence would sit there describing the previous attempt.
		// `showPenToggleNotice` needs no equivalent - each toggle owns its own
		// slot, so with the switch off nothing ever writes to it.
		clear();
		if (routine && !routineNoticesVisible()) return;
		notice = new Notice(message);
	};
}

const sayPreset = ownedPresetNotice();

/** Everything a chip tap and a "Pen preset 2" hotkey both have to do. */
function pickUpNibFor(tool: InkTool): void {
	markPenSeen();
	refreshPenToolsAll();
	setInlineTool(tool);
	setInlineEraserMode(false);
	setInlineLassoMode(false);
	setInlineSpaceMode(false);
	setInlinePanMode(false);
}

/**
 * The pair in hand right now, as a preset of the given tool. Read from the
 * live session state rather than the settings copy: the slider commits to
 * the session first, and a star pressed mid-adjustment must save what the
 * nib is actually wearing.
 */
export function livePreset(tool: InkTool): InkPreset {
	const hex = getInkColorHex(tool);
	// The palette's word for it AT STAR TIME, which is what the persisted
	// shape asks for; `presetLabel` re-derives a live one for display, so
	// this field is the fallback for a hex the palette later stops knowing.
	return { tool, hex, name: colorNameFor(tool, hex), size: getInkSizeMult(tool) };
}

/**
 * Wire the three actions to a store. Called once, from `onload`, after
 * `setInkPresets` has been given the loaded list.
 */
export function installInkPresetActions(store: InkPresetStore): void {
	const write = (next: ReadonlyArray<InkPreset>): void => {
		// Session state first, so the row a `refreshAllStrips` is about to
		// repaint reads the new list rather than the old one.
		setInkPresets(next);
		store.save(next);
		refreshAllStrips();
	};
	setInkPresetActions({
		apply: (tool, index) => {
			const preset = inkPresetsFor(tool)[index];
			if (!preset) {
				// A command for an empty slot reports rather than guessing at
				// a neighbouring preset - the same rule the per-colour
				// commands follow for a name the active tool's palette lacks.
				sayPreset(`Handwriting: ${tool} preset ${index + 1} is empty.`);
				return;
			}
			pickUpNibFor(tool);
			applyInkColor(tool, preset.hex);
			applyInkSize(tool, preset.size);
			// Every strip, not just the one that was tapped: the nib tint and
			// the chip's ring are per-pane drawings of one global choice.
			refreshAllStrips();
			sayPreset(`Handwriting: ${presetLabel(preset)}`, true);
		},
		star: (tool) => {
			const preset = livePreset(tool);
			write(addPreset(store.list(), preset));
			sayPreset(`Handwriting: starred ${presetLabel(preset)}`, true);
		},
		remove: (tool, index) => {
			const gone = inkPresetsFor(tool)[index];
			write(removePreset(store.list(), tool, index));
			// Silent when the slot was already empty: a long-press that
			// landed on nothing has no news in it.
			if (gone) sayPreset(`Handwriting: removed ${presetLabel(gone)}`);
		},
	});
}
