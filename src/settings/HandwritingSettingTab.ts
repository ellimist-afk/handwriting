/**
 * The plugin's settings page: HandwritingSettingTab with its row definitions and the legacy painter for
 * Obsidian 1.12, the grouping of the "Extra commands for hotkeys" lines (gatedCommandGroups), and the
 * Obsidian Sync hint (SYNC_ALL_TYPES_HINT). Moved unchanged from main.ts, which imports the class and the hint
 * back and re-exports HandwritingSettingTab, gatedCommandGroups, GatedCommandGroup and SYNC_ALL_TYPES_HINT, so
 * every import from main still resolves. This file imports only types from main, so there is no runtime cycle.
 */
import { App, Notice, Platform, PluginSettingTab, Setting, SettingDefinitionItem, type SettingGroup } from "obsidian";
import { gatedCommands, type PaletteCommand } from "../CommandPaletteSplit";
import { applyToolbarPlacement, refreshPenToolsAll, refreshAllStrips, repaintAllInkOverlays, setShapeSnap } from "../inline/InkOverlay";
import { setPressureSensitivity } from "../ink/PenStyle";
import { refreshInkTheme, setInkExportReadability, setInkThemeAdaptation } from "../ink/InkTheme";
import { colorsFor, getInkColorHex } from "../ink/InkColor";
import { diagnosticsEnabled } from "../diag/DiagSwitch";
import { normalizePaperStyle } from "../inline/Paper";
import { setScrollExpansionEnabled } from "../inline/InkOverlay";
import { InkTool } from "../ink/Stroke";
import { normalizePdfPageAssumption } from "../ink/InkPdf";
import { embedInkRepaintAll } from "../inline/EmbedInk";
import { normalizePenToolsMode, setPenToolsMode } from "../inline/PenToolsMode";
import { normalizeNoteZoomControlsMode, setNoteZoomControlsMode, setZoomBarCanvasEnabled } from "../inline/NoteZoomControlsMode";
import { refreshNoteZoomControlsAll } from "../inline/MobileTools";
import { FoldOrderControl, previewStripHost } from "../inline/FoldOrderControl";
import { runDetached } from "../util/Detached";
import { DEFAULT_INK_FOLDER, inkFolderSyncs, SYNCED_INK_FOLDER } from "../persistence/InkFolder";
import { TOOLBAR_CORNER_LABELS, normalizeToolbarCorner } from "../inline/ToolbarCorner";
import { resetPressureCalibration } from "../ink/PressureGain";
import type HandwritingPlugin from "../main";
import type { HandwritingSettings } from "../main";

/**
 * Ink is stored as .json files, and Obsidian Sync leaves .json out unless "Sync all other types" is on, so
 * moving the ink folder out of hiding is not enough there on its own. Said in the settings row and the move notice.
 */
export const SYNC_ALL_TYPES_HINT =
	`Obsidian Sync users: also turn on "Sync all other types" in Obsidian Sync's settings, or it leaves the ink files out.`;

type SettingKey = keyof HandwritingSettings;

/** The legacy painter reads our own definition data, not newer host API objects. */
type LegacySettingControl =
	| { type: "toggle"; key: SettingKey; disabled?: boolean | (() => boolean) }
	| { type: "dropdown"; key: SettingKey; options: Readonly<Record<string, string>>; disabled?: boolean | (() => boolean) }
	| { type: "text" | "textarea" | "number" | "file" | "folder" | "slider" | "color" };

type LegacySettingItem =
	| { type: "page" }
	| { type: "group" | "list"; heading?: string; items?: readonly LegacySettingItem[] }
	| {
		name: string;
		desc?: string | DocumentFragment;
		render?: (setting: Setting, group: SettingGroup) => void | (() => void);
		control?: LegacySettingControl;
	};

const SUPPORT_LINE = "Handwriting is free. i'm still working on it almost every night.";

/** One line under "Extra commands for hotkeys": a label and its names. */
export interface GatedCommandGroup {
	/** The quiet label the line opens with. */
	readonly label: string;
	/** The ids on it, in table order. Every gated id is on exactly one line. */
	readonly ids: readonly string[];
	/** What the line prints, with the wording the label already carries taken off. */
	readonly names: readonly string[];
}

/**
 * WHICH LINE A GATED COMMAND GOES ON, from its id.
 *
 * "this is hilariously dense" (alan, 2026-09-06). The row under the switch
 * printed all forty-three names as one comma run. The list itself stays - it is
 * how anyone knows what there is to bind, and hiding it behind a disclosure
 * would leave the switch asking "which commands?" with no answer - but it reads
 * as a few short lines now, one per kind.
 *
 * FROM THE IDS, not from a second list of names. `PaletteCommand` has no kind
 * field, and adding membership by hand here would be exactly the drift
 * CommandPaletteSplit.ts exists to prevent: a colour added to `PEN_COLORS`
 * reaches this list through `gatedCommands()` and lands on the "Ink color" line
 * because its id starts that way, with nothing to update here. An id that
 * matches no rule still appears, under "Other" - a command may never fall out
 * of the list silently - and the test pins that bucket empty, so an id shape
 * nobody wrote a rule for is a red test rather than a shrug in the UI.
 *
 * ORDER MATTERS IN ONE PLACE: `ink-size-cycle` and `ink-color-cycle` both start
 * the way the per-value ids do, so the cycles are claimed first.
 */
const GATED_GROUPS: ReadonlyArray<{ label: string; holds: (id: string) => boolean }> = [
	{ label: "Tool toggles", holds: (id) => id.startsWith("inline-tool-") },
	{ label: "Cycles", holds: (id) => id.endsWith("-cycle") },
	{ label: "Ink size", holds: (id) => id.startsWith("ink-size-") },
	{ label: "Ink color", holds: (id) => id.startsWith("ink-color-") },
	{ label: "Highlighter color", holds: (id) => id.startsWith("highlighter-color-") },
	{ label: "Pen preset", holds: (id) => id.startsWith("ink-preset-pen-") },
	{ label: "Save current pen as preset", holds: (id) => id.startsWith("ink-preset-save-pen-") },
	{ label: "Highlighter preset", holds: (id) => id.startsWith("ink-preset-highlighter-") },
	{
		label: "Save current highlighter as preset",
		holds: (id) => id.startsWith("ink-preset-save-highlighter-"),
	},
];

/** Where every rule has failed. Empty in this build; see `GATED_GROUPS`. */
const GATED_OTHER = "Other";

/**
 * How many leading characters every one of these names shares, cut back so the
 * cut never lands inside a word.
 *
 * The boundary rule is the whole of it: a common prefix of "Ink color: bl"
 * across two blues is real and useless, so the count walks back to the last
 * character that is not a letter or a digit. One name shares nothing with
 * itself, so a group of one keeps its whole name.
 */
function sharedHead(names: readonly string[]): number {
	if (names.length < 2) return 0;
	const first = names[0] ?? "";
	let n = first.length;
	for (const name of names) {
		let i = 0;
		while (i < n && i < name.length && name[i] === first[i]) i++;
		n = i;
	}
	while (n > 0 && /[A-Za-z0-9]/.test(first[n - 1] ?? "")) n--;
	return n;
}

/** The same from the other end: " on / off", ": next". */
function sharedTail(names: readonly string[]): number {
	if (names.length < 2) return 0;
	const first = names[0] ?? "";
	let n = first.length;
	for (const name of names) {
		let i = 0;
		while (i < n && i < name.length && name[name.length - 1 - i] === first[first.length - 1 - i]) i++;
		n = i;
	}
	while (n > 0 && /[A-Za-z0-9]/.test(first[first.length - n] ?? "")) n--;
	return n;
}

/**
 * The names a line prints: each one with the wording the whole group shares
 * taken off, so "Ink color: blue, Ink color: black, ..." becomes a label and
 * "blue, black, ...".
 *
 * ALL OR NOTHING. If any name would come back empty - a group whose members are
 * one word apart, or one whose head and tail overlap - the full names are kept.
 * A line that is longer than it needs to be is a nuisance; a line with a blank
 * in it is a lie about what the palette holds.
 */
function trimmedNames(names: readonly string[]): string[] {
	const head = sharedHead(names);
	const tail = sharedTail(names);
	if (head + tail === 0) return [...names];
	const short = names.map((name) => name.slice(head, name.length - tail).trim());
	return short.every((name) => name.length > 0) ? short : [...names];
}

/**
 * The gated commands as lines. Pure: it takes the table, so a test can hand it
 * an id nobody has written a rule for and see where that lands.
 */
export function gatedCommandGroups(commands: readonly PaletteCommand[] = gatedCommands()): GatedCommandGroup[] {
	const buckets = new Map<string, PaletteCommand[]>();
	for (const command of commands) {
		const rule = GATED_GROUPS.find((g) => g.holds(command.id));
		const label = rule?.label ?? GATED_OTHER;
		const bucket = buckets.get(label);
		if (bucket) bucket.push(command);
		else buckets.set(label, [command]);
	}
	// The rules' order, then whatever "Other" caught, rather than the order the
	// ids happened to arrive in: the lines read tool toggles first and quick
	// pens last, which is the order the palette registers them in.
	const labels = [...GATED_GROUPS.map((g) => g.label), GATED_OTHER];
	const out: GatedCommandGroup[] = [];
	for (const label of labels) {
		const bucket = buckets.get(label);
		if (!bucket || bucket.length === 0) continue;
		out.push({
			label,
			ids: bucket.map((c) => c.id),
			names: trimmedNames(bucket.map((c) => c.name)),
		});
	}
	return out;
}

/**
 * The device-level knobs, most of which already existed as commands. The
 * strip's sliders stay the source of truth for sizes and colors, so those
 * are not duplicated here.
 *
 * One list of definitions, two painters. Obsidian 1.13 renders the list
 * itself and indexes it for settings search (getSettingDefinitions); 1.12
 * has no such renderer and calls display(), which paints the same list by
 * hand. Neither path has a row the other lacks.
 */
export class HandwritingSettingTab extends PluginSettingTab {
	/**
	 * The fold-order control, while the tab is open.
	 *
	 * Held so it can be given back. It owns a real `MobileTools` - five
	 * capturing document listeners, a resize observer and an entry in the
	 * strip registry - and a forgotten one would be re-folded forever on behalf
	 * of a settings pane that had closed.
	 */
	private foldOrder: FoldOrderControl | null = null;

	constructor(
		app: App,
		private plugin: HandwritingPlugin
	) {
		super(app, plugin);
	}

	/**
	 * The tab closed, or Obsidian moved to another one.
	 *
	 * Belt and braces with the `destroy()` at the top of `renderFoldOrder`:
	 * this is the hook that fires on the classic painter's own lifecycle, and
	 * the destroy-before-build there is what covers a renderer that draws the
	 * row again without ever calling this.
	 */
	hide(): void {
		this.foldOrder?.destroy();
		this.foldOrder = null;
	}

	getSettingDefinitions(): SettingDefinitionItem<SettingKey>[] {
		return [
			{
				name: `Version ${this.plugin.manifest.version}`,
			},
			{
				type: "group",
				heading: "Appearance",
				items: [
					{
						name: "Infinite canvas",
						desc: "Let the page grow as you write and scroll. Also turns on the zoom bar. Global setting. A note can override it with handwriting-canvas: true or false in its frontmatter. Default off.",
						control: { type: "toggle", key: "extendCanvasWhileScrolling" },
					},
					{
						name: "Hide status bar on handwriting notes",
						desc: "Hide Obsidian's status bar on notes with handwriting. Global setting. Default off.",
						control: { type: "toggle", key: "hideStatusBarOnInkedNotes" },
					},
					{
						name: "Paper background",
						desc: "Lined, grid, or dotted paper. Global setting. A note can override it with handwriting-paper in its frontmatter. Default none.",
						control: {
							type: "dropdown",
							key: "paperStyle",
							options: { none: "None", lines: "Lines", grid: "Grid", dots: "Dots" },
						},
					},
				],
			},
			{
				type: "group",
				heading: "Toolbar",
				items: [
					{
						name: "Toolbar visibility",
						desc: "Show or hide the pen toolbar. Auto shows it on phones and tablets, on desktop once a pen is used, and moves it aside while you write. Global setting. Default auto.",
						control: {
							type: "dropdown",
							key: "penTools",
							options: { hide: "Off", show: "On", auto: "Auto" },
						},
					},
					{
						// Option labels match the Toolbar visibility row's above
						// verbatim - the two settings behave identically.
						name: "Zoom bar",
						desc: "Buttons to zoom the page in and out. Needs Infinite canvas on for the note. Auto moves it aside while you write. Global setting. Default auto.",
						control: {
							type: "dropdown",
							key: "noteZoomControls",
							options: { hide: "Off", show: "On", auto: "Auto" },
						},
					},
					{
						name: "Toolbar placement",
						desc: "Where the toolbar sits. Global setting. Default top right.",
						// "Corner" is what this row was called for two releases and
						// what the setting is still named in data.json, so it stays
						// searchable: the settings search indexes name, desc and
						// aliases and nothing else, and a rename with no alias makes
						// the old wording stop matching the row it belongs to. It is
						// also no longer strictly true - two of the six placements
						// are not corners - which is the whole reason for the rename.
						aliases: ["toolbar corner", "corner", "middle", "anchor", "position"],
						control: {
							type: "dropdown",
							key: "toolbarCorner",
							options: Object.fromEntries(TOOLBAR_CORNER_LABELS.map(({ value, label }) => [value, label])),
						},
					},
					// Android never forwards a pen touch made with the button held, so
					// the contact choice below does nothing there; its row becomes the
					// on/off switch for the click in the air (SideButtonAir.ts).
					Platform.isAndroidApp ? {
						name: "Pen side button",
						desc:
							"Click while hovering over the screen switches pen and eraser. Android takes a pen touch made with the button held for text " +
							"selection, so the button only works while the pen hovers. Click it once in the air to switch pen and " +
							"eraser; click again to switch back. Needs a pen that hovers (S Pen, Wacom EMR). Remembered on this device.",
						render: async (setting) => {
							const { airSwitchEnabled, saveAirSwitch } = await import("../inline/TipMode");
							setting.addToggle((toggle) => {
								toggle.setValue(airSwitchEnabled())
									.setTooltip("Click while hovering over the screen switches pen and eraser")
									.onChange((value) => saveAirSwitch(value));
							});
						},
					} : {
						name: "Pen side button",
						desc: "Choose what a held pen side button does on contact. The mouse right button follows this choice. Remembered on this device; lasso stays on the toolbar.",
						render: async (setting) => {
							const { sideButtonErasesEnabled, saveSideButtonErases } = await import("../inline/TipMode");
							setting.addDropdown((dropdown) => {
								dropdown.addOption("lasso", "Lasso select").addOption("erase", "Hold to erase")
									.setValue(sideButtonErasesEnabled() ? "erase" : "lasso")
									.onChange((value) => saveSideButtonErases(value === "erase"));
							});
						},
					},
					{
						name: "Toolbar buttons",
						desc:
							"Drag to order which buttons are shown. " +
							"The bottom of the list disappears first.",
						// `render` rather than a `control`: there is no toggle or
						// dropdown shape for a reorderable list, and the two are
						// mutually exclusive on one row (obsidian.d.ts's
						// `SettingDefinitionRender`), which is the same reason
						// `renderSupport` is written this way.
						render: (setting) => this.renderFoldOrder(setting),
					},
				],
			},
			{
				type: "group",
				heading: "PDFs",
				items: [
					{
						// APPROVED BY ALAN AS WRITTEN, 2026-09-08 - "that
						// works", then "color btw american" / "not british".
						// AMERICAN SPELLING HERE ONLY: he ruled on this row,
						// not on the five other strings that still say
						// "colour", including the row directly above. Two
						// adjacent rows therefore disagree, deliberately, and
						// tidying them is a separate copy question that has
						// not been asked.
						//
						// FIVE earlier drafts died, and the first four failed
						// the same way: they explained. Two were named "Keep
						// flattened ink readable" - "wtf is this copy", then
						// "not clear, why is flattened ink unreadable,
						// question makes more questions then it answers". The
						// NAME was the fault, not the length: it asked the
						// reader a question it never answered, and "flattened"
						// is our word, not theirs.
						//
						// This one is shaped on the "Paper background" row
						// rather than invented - topic name, then a
						// description that lists the options and names the
						// default. Do not lengthen it; the option labels carry
						// the rest, and the mechanism lives in InkPdfAppend.ts
						// where it belongs.
						name: "Ink color on PDFs",
						desc: "Darken, lighten, or leave it alone. Global setting. Default darken.",
						// Shipped in 1.4.18 as "Ink color when flattening PDFs".
						// Search indexes name, desc and aliases only, so the old
						// title stays findable here; see "Toolbar placement".
						aliases: ["Ink color when flattening PDFs", "flatten"],
						control: {
							type: "dropdown",
							key: "inkPdfColorMode",
							options: {
								darken: "Darken for light pages",
								lighten: "Lighten for dark pages",
								keep: "Keep original colors",
							},
						},
					},
				],
			},
			{
				type: "group",
				heading: "Export",
				items: [
					{
						name: "Ink color when exporting",
						desc: "Keep pen ink readable in exports, prints, and snips. Global setting. Default automatic readability.",
						aliases: ["print", "snip", "highlighter"],
						control: {
							type: "dropdown", key: "inkReadableInExports",
							options: { auto: "Automatic readability", keep: "Keep original colors" },
						},
					},
				],
			},
			{
				type: "group",
				heading: "Latency",
				items: [
					{
						name: "Ink prediction",
						desc: "Reduce visible pen lag. Global setting. Default on.",
						aliases: ["latency", "nib", "sharp corners"],
						control: {
							type: "toggle",
							key: "strokePrediction",
							disabled: () => this.plugin.settings.booxMode,
						},
					},
				],
			},
			{
				type: "group",
				heading: "Pen",
				items: [
					{
						name: "Pressure sensitivity",
						desc: "Adjust line width with pen pressure. Global setting. Default on.",
						// The ordinary control path, not 1.4.19's `render` one. That
						// row carried a Recalibrate button beside the toggle, and a
						// button can only reach a row through `render`; Recalibrate
						// has had its own Developer row since 1.4.20, so this row is
						// the toggle and nothing else.
						control: { type: "toggle", key: "pressureSensitivity" },
					},
					{
						// The smoothing users can actually feel. setInkShaping has been
						// honoured by the renderers all along but nothing ever called it: the
						// toggle that drove it was renamed into "pressure sensitivity" and the
						// shaping half lost its wiring, so the line has been permanently
						// shaped with no way to say otherwise. Two people asked for exactly
						// this on the same day (boox thread, 2026-08-30) and were told to turn
						// prediction off, which is a different feature and did nothing.
						name: "Ink smoothing",
						desc: "Smooth and taper strokes. Global setting. Default on.",
						aliases: ["shaping", "speed"],
						control: {
							type: "toggle",
							key: "inkSmoothing",
							disabled: () => this.plugin.settings.booxMode,
						},
					},
					{
						name: "Pen reticle",
						desc: "Show a dot at the pen tip. Global setting. Default on.",
						aliases: ["cursor"],
						control: {
							type: "toggle",
							key: "penReticle",
							disabled: () => this.plugin.settings.booxMode,
						},
					},
					{
						name: "Shape snap",
						desc: "Hold at the end of a stroke to snap it into a shape. Global setting. Default on.",
						control: { type: "toggle", key: "shapeSnap" },
					},
				],
			},
			{
				type: "group",
				heading: "Commands",
				items: [
					{
						name: "Extra commands for hotkeys",
						// Every name this row has carried. Settings search
						// indexes name, desc and aliases and nothing else, so a
						// rename with no alias makes the old wording match
						// nothing - and someone who updates, types what they
						// remember and finds an empty list concludes the toggle
						// was removed rather than renamed. The sync row below
						// carries six aliases for the same reason. 1.4.6's name
						// is the first entry; 1.4.11's is the last.
						aliases: [
							"A command per color and size",
							"command per color",
							"per color command",
							"Hotkeys for colors and sizes",
							"command palette",
						],
						desc:
							"Add tool, color, size, and quick pen commands for hotkeys. Global setting. Default off." +
							(this.plugin.gatedCommandRemovalAvailable()
								? ""
								: " Turning it off takes effect after the plugin reloads."),
						control: { type: "toggle", key: "colorSizeCommands" },
					},
					{
						// Directly under the switch, ON OR OFF, because the
						// question the switch raises is "which commands?" and
						// a list you can only see by turning something on and
						// reloading is no answer. Rendered from the same table
						// registration reads (CommandPaletteSplit.ts), so it
						// cannot drift from what the palette actually gets.
						//
						// Its own row rather than more text on the one above:
						// `control` and `render` are mutually exclusive on a
						// single definition (obsidian.d.ts's
						// SettingDefinitionRender), and both renderers - 1.13's
						// declarative one and this file's `paint()` fallback -
						// draw a bare name+desc row the same way.
						name: "The commands it adds",
						// Out of search deliberately: the switch above owns the
						// terms, and two hits for one control reads as two
						// controls.
						searchable: false,
						// A few short labelled lines rather than one comma run
						// of forty-three names ("this is hilariously dense",
						// alan, 2026-09-06). `render` rather than `desc` for the
						// same reason the fold-order row uses it: a desc is one
						// string, and these are lines. The grouping is
						// `gatedCommandGroups`, above the class, and it still
						// reads the shared table.
						render: (setting) => this.renderGatedCommands(setting),
					},
				],
			},
			{
				type: "group",
				heading: "Storage",
				items: [
					{
						name: "Compatibility with Obsidian Sync, iCloud and Dropbox",
						desc: SYNC_ALL_TYPES_HINT,
						aliases: ["ink folder", "hidden folder", "sync", "obsidian sync", "icloud", "dropbox"],
						render: (setting) => this.renderSyncButton(setting),
					},
				],
			},
			{
				type: "group",
				heading: "Developer",
				items: [
					{
						name: "Developer diagnostics",
						desc:
							"Show diagnostic commands after reloading the plugin. Global setting. Default off.",
						control: { type: "toggle", key: "devDiagnostics" },
					},
					{
						// Moved here from Latency, unchanged (1.4.20, Alan's settings
						// simplification). The rows it overrides keep their
						// `disabled` read of it wherever they sit.
						name: "Boox mode",
						desc: "Adjust pen input and animations for e-ink screens. Global setting. Default off.",
						control: { type: "toggle", key: "booxMode" },
					},
					{
						// What is left of the Pen group's "Pressure sensitivity" row
						// (1.4.20, Alan: A3). The switch is gone - pressure is always
						// on, see `loadSettings` - but the button is a different
						// feature and still the only road to it: the palette's
						// "Pen pressure: recalibrate" was ruled out on 2026-09-05 in
						// favour of this button. The old row's name stays an alias
						// so settings search still lands somewhere.
						name: "Recalibrate pen pressure",
						desc: "Forget the pressure range learned on this device and relearn it from your next strokes. This device only.",
						aliases: ["pressure sensitivity", "recalibrate", "calibration"],
						render: (setting) => this.renderPressureRecalibrate(setting),
					},
				],
			},
		];
	}

	/**
	 * Boox mode overrides three rows at runtime, without writing any of the
	 * stored settings: ink smoothing and the pen reticle are forced OFF
	 * (`applyBooxMode`'s `&& !on`), while prediction is forced ON
	 * (`applyBooxMode`'s `on || settings.strokePrediction` - Boox EXTENDS
	 * prediction rather than pausing it, see applyBooxMode). `applyBooxMode`
	 * restores the stored preference the moment the mode goes off. The rows
	 * were still reporting the STORED value, not the forced
	 * one, so a Boox user saw toggles that disagreed with what was actually
	 * happening, with no way to tell.
	 *
	 * So each row shows the value actually in force (this map, not an
	 * assumed false), and the control beside it is disabled while something
	 * else is deciding. The preference itself is untouched: turn Boox mode
	 * off and every row reports the choice the user made, because that
	 * choice was never overwritten (alan, 2026-09-02, on being asked whether
	 * "toggle off" meant rewriting them: the reversible one).
	 */
	private readonly BOOX_OVERRIDES: Readonly<Partial<Record<SettingKey, boolean>>> = {
		inkSmoothing: false,
		penReticle: false,
		strokePrediction: true,
	};

	private overriddenByBoox(key: string): boolean {
		return this.plugin.settings.booxMode && key in this.BOOX_OVERRIDES;
	}

	getControlValue(key: string): unknown {
		if (key === "inkReadableInExports") return this.plugin.settings.inkReadableInExports ? "auto" : "keep";
		if (this.overriddenByBoox(key)) return this.BOOX_OVERRIDES[key as SettingKey];
		return key in this.plugin.settings ? this.plugin.settings[key as SettingKey] : undefined;
	}

	/**
	 * Draw the tab again after a change that alters OTHER rows.
	 *
	 * 1.13 keeps the definitions and re-evaluates them on `update()`. 1.12 has
	 * no such hook, so the fallback redraws the list - cheap at this size, and
	 * the same work `display()` already does every time the tab opens. Both
	 * paths read `disabled` and `getControlValue` fresh, so both end up correct.
	 */
	private rerender(): void {
		const self = this as unknown as { update?: () => void };
		if (typeof self.update === "function") self.update();
		else this.renderLegacySettings();
	}

	/**
	 * Every toggle and dropdown lands here. The value is applied live - the
	 * same call the command for that knob makes - and then saved. Unknown
	 * keys are ignored rather than written: the settings file is the
	 * plugin's, not the form's.
	 */
	setControlValue(key: string, value: unknown): void {
		const s = this.plugin.settings;
		const on = value === true;
		const str = typeof value === "string" ? value : "";
		switch (key) {
			case "extendCanvasWhileScrolling":
				s.extendCanvasWhileScrolling = on;
				setScrollExpansionEnabled(on);
				// The zoom bar's other half. The setter announces
				// to strips listening for a mode change; the push covers the
				// ones built before anyone subscribed, exactly as the fold
				// order is pushed.
				setZoomBarCanvasEnabled(on);
				refreshNoteZoomControlsAll();
				this.plugin.refreshHeaderActions();
				// No row's `disabled` predicate reads this value today. The rerender
				// stays so that a row which does read it is redrawn at once, not
				// when the tab is closed and opened again.
				this.rerender();
				break;
			case "pressureSensitivity":
				s.pressureSensitivity = on;
				s.pressureChoice = on;
				setPressureSensitivity(on);
				// Saved strokes are shaped at render time from their stored
				// samples, so the width law changes under ink already on the
				// page: every overlay has to draw again to show it.
				repaintAllInkOverlays();
				embedInkRepaintAll(); // reading view, embeds and hovers (audit 25)
				break;
			case "hideStatusBarOnInkedNotes":
				s.hideStatusBarOnInkedNotes = on;
				// Live, both ways. Turning it ON hides the bar if the note under
				// the cursor qualifies; turning it OFF hands the bar back now
				// rather than at the next leaf change, which is the half a user
				// is actually watching for when they undo a setting.
				this.plugin.applyStatusBarVisibility();
				break;
			case "strokePrediction":
				s.strokePrediction = on;
				this.plugin.applyBooxMode();
				break;
			case "inkSmoothing":
				s.inkSmoothing = on;
				this.plugin.applyBooxMode();
				repaintAllInkOverlays();
				embedInkRepaintAll();
				break;
			case "booxMode":
				s.booxMode = on;
				this.plugin.applyBooxMode();
				// Boox mode overrides Ink smoothing at runtime, and since §5i that
				// setting decides committed GEOMETRY, not just the width law. The
				// inkSmoothing case has always repainted; this one changes the same
				// value and did not, so toggling the mode left ink on screen in its
				// old shape until an unrelated repaint (§5l/AE6).
				repaintAllInkOverlays();
				embedInkRepaintAll();
				// Two OTHER rows change what they report when this one moves.
				// `disabled` and getControlValue are both read at render time,
				// so nothing repaints them unless the tab is asked to render
				// again - and a Boox user flipping this would otherwise watch
				// two toggles keep insisting they were on.
				this.rerender();
				break;
			case "inkAdaptsToTheme":
				s.inkAdaptsToTheme = on;
				setInkThemeAdaptation(on);
				// Compatibility call retained from the former cached-theme path;
				// `refreshInkTheme` is now a no-op and the repaint reads live state.
				refreshInkTheme(document);
				repaintAllInkOverlays();
				refreshAllStrips();
				break;
			case "inkPdfColorMode":
				// Read at flatten time from `this.settings`, so there is no
				// renderer to notify and nothing to repaint: the next flatten
				// asks and gets the new answer. Normalised on the way in as
				// well as on load, so a control that somehow yields an unknown
				// string cannot store one.
				s.inkPdfColorMode = normalizePdfPageAssumption(str);
				break;
			case "inkReadableInExports":
				// Keep the persisted boolean and its existing renderer semantics.
				// Boolean callers remain compatible with the former toggle.
				s.inkReadableInExports = value === true || str === "auto";
				setInkExportReadability(s.inkReadableInExports);
				// No repaint: this setting cannot change a pixel on screen. It is
				// read only inside an export, a print swap or a snip, and every
				// one of those paints from scratch when it runs.
				break;
			case "shapeSnap":
				s.shapeSnap = on;
				setShapeSnap(on);
				break;
			case "colorSizeCommands":
				s.colorSizeCommands = on;
				// Live, not "after the plugin reloads": the gated commands go into
				// the palette or out of it now, and their strip fallbacks move the
				// other way in the same call, so the toolbar keeps working in both
				// states. The decision is `planGatedCommands` (pure, tested); this
				// is the same shape as every other case here - apply live, then
				// save. Turning it OFF is the half that needs `removeCommand`, and
				// the row's own description keeps the reload sentence where that is
				// missing.
				this.plugin.applyGatedCommandRegistration();
				break;
			case "devDiagnostics":
				s.devDiagnostics = on;
				break;
			case "paperStyle": {
				const style = normalizePaperStyle(str);
				s.paperStyle = style;
				this.plugin.applyPaper(style);
				break;
			}
			case "penTools": {
				const m = normalizePenToolsMode(str);
				s.penTools = m;
				setPenToolsMode(m);
				refreshPenToolsAll();
				break;
			}
			case "noteZoomControls": {
				// No refreshPenToolsAll equivalent needed: unlike penTools, the
				// zoom bar's existence never changes with its mode - only its
				// in-place visibility, which each live MobileTools instance
				// re-applies itself via onNoteZoomControlsChanged (MobileTools.ts).
				const m = normalizeNoteZoomControlsMode(str);
				s.noteZoomControls = m;
				setNoteZoomControlsMode(m);
				break;
			}
			case "toolbarCorner": {
				// ONE ROAD with drag-to-anchor (1.4.12). This case used to do
				// the two halves itself - write `s.toolbarCorner`, call
				// `setToolbarCorner` - and a strip dragged to a new anchor
				// owes exactly the same two. `applyToolbarPlacement`
				// (InkOverlay.ts) is that pair, and both strip hosts call it,
				// so the dropdown and the drag cannot end up doing different
				// things to the same setting.
				//
				// RETURNS rather than breaks: the persist hook registered in
				// `loadSettings` has already written data.json, and falling
				// through to the tail's `saveSettingsNow` would write the
				// same object a second time - see `persistSettings` on why
				// this plugin has exactly one road to that file.
				applyToolbarPlacement(normalizeToolbarCorner(str));
				return;
			}
			case "penReticle":
				s.penReticle = on;
				this.plugin.applyBooxMode();
				break;
			default:
				return;
		}
		this.plugin.saveSettingsNow();
	}

	/**
	 * Obsidian 1.12 fallback. Newer versions never call this: they render
	 * the definitions themselves.
	 */
	display(): void {
		this.renderLegacySettings();
	}

	private renderLegacySettings(): void {
		const { containerEl } = this;
		containerEl.empty();
		this.paint(containerEl, this.getSettingDefinitions());
	}

	/** Draw definitions with the classic Setting builder, one row each. */
	private paint(el: HTMLElement, items: readonly LegacySettingItem[]): void {
		for (const item of items) {
			if ("type" in item) {
				if (item.type === "page") continue;
				if (item.heading !== undefined) new Setting(el).setName(item.heading).setHeading();
				this.paint(el, item.items ?? []);
				continue;
			}
			const setting = new Setting(el).setName(item.name);
			if (item.desc !== undefined) setting.setDesc(item.desc);
			if (item.render) {
				// The rows rendered here never read the second argument the
				// newer renderer passes, so calling them with the Setting alone
				// is safe. Not a version gap: SettingGroup has existed since
				// 1.11.0. What differs is only who does the painting.
				(item.render as (setting: Setting) => void)(setting);
			} else if (item.control?.type === "toggle") {
				const { key, disabled } = item.control;
				// `disabled` is honoured here too. The newer renderer applies it
				// itself; this painter would otherwise leave a live toggle on a
				// row whose value is being decided elsewhere - a control that
				// looks available, moves when pressed, and changes nothing,
				// which is worse than one that plainly cannot be pressed.
				const off = typeof disabled === "function" ? disabled() : disabled === true;
				setting.addToggle((t) => {
					t.setValue(this.getControlValue(key) === true).onChange((v) => {
						this.setControlValue(key, v);
					});
					if (off) t.setDisabled(true);
				});
			} else if (item.control?.type === "dropdown") {
				const { key, options, disabled } = item.control;
				// Same reason as the toggle above: a row the definitions mark
				// unusable must not paint as a live control here. No row is a
				// disabled dropdown today; SettingsCanvasRows.test.ts pins this
				// branch on a synthetic row.
				const off = typeof disabled === "function" ? disabled() : disabled === true;
				setting.addDropdown((d) => {
					for (const [value, label] of Object.entries(options)) d.addOption(value, label);
					const current = this.getControlValue(key);
					d.setValue(typeof current === "string" ? current : "").onChange((v) => {
						this.setControlValue(key, v);
					});
					if (off) d.setDisabled(true);
				});
			}
		}
	}

	/**
	 * The Recalibrate button, on its own row in Developer since 1.4.20 took
	 * the pressure switch it used to sit beside out of the tab.
	 *
	 * It runs exactly what the removed `pressure-recalibrate` command ran,
	 * notice included: `resetPressureCalibration()` then the same "relearns
	 * from your next strokes" text, word for word.
	 */
	private renderPressureRecalibrate(setting: Setting): void {
		setting.addButton((btn) =>
			btn.setButtonText("Recalibrate").onClick(() => {
				resetPressureCalibration();
				new Notice("Handwriting: pressure relearns from your next strokes");
			})
		);
	}

	// One button, not a path field. "Where should the ink live" is not a
	// question anyone wants asked - the only reason to move it is that
	// Obsidian Sync skips hidden folders, so the control offers exactly
	// that and nothing else. No free text also means no path to validate,
	// no nested folder to create, and no way to typo your ink somewhere
	// strange.
	//
	// No description. The name is the description - Alan's rule, and
	// three attempts at wording proved it: a status line, a paragraph
	// of mechanics, and a one-line effect were all worse than the
	// name plus a button that says Turn on. The explanation lives in
	// the README, where someone goes when they want the reason. One line is
	// the exception: the Obsidian Sync file-type hint, which the row carries
	// as its description because nothing on screen would tell anyone else.
	private renderSyncButton(setting: Setting): void {
		const label = (): string => (inkFolderSyncs(this.plugin.settings.inkFolder) ? "Turn off" : "Turn on");
		let button: { setButtonText(text: string): unknown; setDisabled(off: boolean): unknown } | null = null;
		setting.setName("Compatibility with Obsidian Sync, iCloud and Dropbox").addButton((btn) =>
			(button = btn)
				.setButtonText(label())
				.setCta()
				// Read on every render: a row rebuilt while a move runs must not
				// hand out a fresh enabled button for a second move.
				.setDisabled(this.plugin.inkFolderMoving())
				.onClick(() => {
					if (this.plugin.inkFolderMoving()) return;
					btn.setDisabled(true);
					const target = inkFolderSyncs(this.plugin.settings.inkFolder) ? DEFAULT_INK_FOLDER : SYNCED_INK_FOLDER;
					runDetached(
						this.plugin.changeInkFolder(target).then(() => {
							// The button names the next move, which depends on
							// where the ink actually is now.
							btn.setButtonText(label()).setDisabled(false);
						}),
						"move the ink folder",
						() => {
							btn.setDisabled(false);
							new Notice("Handwriting: the ink folder could not be changed");
						}
					);
				})
		);
		// A row drawn mid-move has a button the move's own `.then` never sees,
		// so it is released here, when the move ends or the row goes away.
		if (this.plugin.inkFolderMoving()) {
			const timer = window.setInterval(() => {
				if (this.plugin.inkFolderMoving() && setting.settingEl.isConnected) return;
				window.clearInterval(timer);
				button?.setButtonText(label());
				button?.setDisabled(false);
			}, 500);
			this.plugin.registerInterval(timer);
		}
	}

	/**
	 * The fold-order list, drawn full-width BELOW the row's name.
	 *
	 * A reorderable list does not fit the narrow control column a settings row
	 * gives its widget, so the row itself is turned into a block and the control
	 * appended under the name - the same escape hatch `renderSupport` takes for
	 * a different reason. The control caps its own width; the row does not
	 * stretch it (alan, on the third mock: "it's too wide").
	 */
	private renderFoldOrder(setting: Setting): void {
		setting.settingEl.addClass("handwriting-fold-order-row");
		// A second render of the same row would otherwise leave the first
		// control's preview strip alive in the registry.
		this.foldOrder?.destroy();
		this.foldOrder = new FoldOrderControl(setting.settingEl, {
			order: () => this.plugin.settings.stripFoldOrder,
			apply: (order) => this.plugin.applyStripFoldOrder(order),
			corner: () => this.plugin.settings.toolbarCorner,
			previewHost: previewStripHost({
				toolColor: (tool) => getInkColorHex(tool as InkTool),
				paletteFor: (tool) => colorsFor(tool as InkTool),
				recordingOn: () => diagnosticsEnabled(),
			}),
		});
	}

	/**
	 * The commands behind the switch, one short line per kind.
	 *
	 * Under the row's name rather than in the narrow control column, the same
	 * escape hatch `renderFoldOrder` takes: there is no widget on this row, and
	 * a block of lines does not belong in a column sized for a toggle.
	 *
	 * The lines come from `gatedCommandGroups()`, which reads the same table
	 * registration reads - the property that makes this list worth printing at
	 * all - so nothing here knows a command name.
	 *
	 * Idempotent: 1.13 re-evaluates the definitions on `update()` and can call
	 * this again on a row it has already drawn, and a second pass must not
	 * leave two lists.
	 */
	private renderGatedCommands(setting: Setting): void {
		setting.settingEl.addClass("handwriting-gated-row");
		setting.settingEl.querySelector(".handwriting-gated-list")?.remove();
		const list = setting.settingEl.createDiv({ cls: "handwriting-gated-list" });
		for (const group of gatedCommandGroups()) {
			const line = list.createDiv({ cls: "handwriting-gated-group" });
			line.createSpan({ cls: "handwriting-gated-label", text: `${group.label}: ` });
			line.createSpan({ cls: "handwriting-gated-names", text: group.names.join(", ") });
		}
	}

	private renderSupport(setting: Setting): void {
		setting.settingEl.addClass("handwriting-support");
		setting.setName(
			createFragment((f) => {
				f.appendText(`${SUPPORT_LINE} `);
				f.createEl("a", {
					text: "Buy me a coffee :)",
					href: "https://ko-fi.com/ellimistafk",
				});
			})
		);
	}
}
