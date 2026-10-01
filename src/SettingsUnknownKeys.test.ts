/**
 * A key this build does not know survives a load and a save.
 *
 * `persistSettings` writes the settings object WHOLE - `saveData(this.settings)`,
 * never a merge - and `loadSettings` used to rebuild that object as a literal
 * naming only the keys this build knows. Together those two facts made an
 * older build a settings ERASER: open a vault whose data.json was written by a
 * newer build (or a parallel branch), let anything at all save once, and every
 * key the older build had no line for was gone from the file. The keys are not
 * hypothetical - `inkShaping` is one this repo has already renamed past, and
 * every 1.5.x/1.6.x key in flight is another.
 *
 * The fix is one spread: `loadSettings` spreads the raw file FIRST, then writes
 * the known keys over it. The order is the guarantee, and both halves of it are
 * pinned here - the unknown key rides through, and a known key with a rotten
 * value is still normalised rather than being let through by the spread.
 *
 * HOW IT DRIVES THE REAL METHOD. `loadSettings` and `persistSettings` are both
 * private, and main.ts is a plugin, so this uses the pattern TipModeCommand.ts
 * established: `Object.create(HandwritingPlugin.prototype)` for an instance with
 * no field initialisers, the handful of members the two methods actually touch
 * supplied by hand, and the two DOM-reaching methods (`applyPaperTo`,
 * `applyBooxMode`) shadowed with own properties. Nothing about the settings
 * literal is copied into this file: the object under test is the one main.ts
 * builds, and the assertions re-derive every normalised value by calling the
 * same normaliser main.ts calls rather than restating a number.
 */
import { beforeEach, describe, expect, it } from "vitest";

import HandwritingPlugin, { HandwritingSettingTab } from "./main";
import { exportInkColor, inkExportReadabilityEnabled } from "./ink/InkTheme";
import { clampInkSize } from "./ink/InkSize";
import { clampEraserRadius } from "./ink/EraserSize";
import { normalizePenToolsMode, resetPenToolsForTest } from "./inline/PenToolsMode";
import { normalizeNoteZoomControlsMode, resetNoteZoomControlsForTest } from "./inline/NoteZoomControlsMode";

const proto = HandwritingPlugin.prototype as unknown as {
	loadSettings(this: unknown): Promise<void>;
	persistSettings(this: unknown): Promise<void>;
};

/**
 * `loadSettings` ends with `this.applyPaperTo(document, ...)`, and the argument
 * is evaluated even when the method itself is shadowed. Vitest runs in node
 * here (no jsdom anywhere in this suite), so the global has to exist.
 */
function ensureDocument(): void {
	const g = globalThis as unknown as { document?: unknown };
	// `contains` is here for the merge-up: loadSettings also calls
	// refreshInkTheme, whose isDarkTheme reads
	// body.classList.contains("theme-dark"). The stub predates that call, and
	// a fixture missing a member the code under test needs would fail whatever
	// the settings did. False is the honest answer for a node run with no
	// theme class on the body.
	g.document ??= {
		body: { classList: { add: () => {}, toggle: () => {}, contains: () => false } },
	};
}

interface Harness {
	settings: Record<string, unknown>;
	/** What `saveData` was last handed, i.e. what data.json would now hold. */
	saved: Record<string, unknown> | null;
}

function fakePlugin(raw: unknown): Harness {
	const plugin = Object.create(HandwritingPlugin.prototype) as Record<string, unknown>;
	plugin.loadData = (): Promise<unknown> => Promise.resolve(raw);
	plugin.saved = null;
	plugin.saveData = (data: Record<string, unknown>): Promise<void> => {
		plugin.saved = data;
		return Promise.resolve();
	};
	// persistSettings' own fields. `Object.create` skips the initialisers, and
	// `settingsTimer` undefined would take the `!== null` branch into
	// `window.clearTimeout` - a crash, not a test.
	plugin.settingsTimer = null;
	plugin.settingsDirty = false;
	plugin.settingsWriting = null;
	plugin.settingsWriteAgain = false;
	// The seams loadSettings fills in passing.
	plugin.store = { useInkFolder: () => {}, load: () => null, schedule: () => {} };
	plugin.pdfStore = { attachHost: () => {} };
	plugin.app = { workspace: { onLayoutReady: () => {} } };
	// Own properties, so they shadow the prototype's DOM-reaching versions.
	plugin.applyPaperTo = (): void => {};
	plugin.applyBooxMode = (): void => {};
	return plugin as unknown as Harness;
}

async function loadThenSave(raw: unknown): Promise<Harness> {
	ensureDocument();
	const plugin = fakePlugin(raw);
	await proto.loadSettings.call(plugin);
	await proto.persistSettings.call(plugin);
	return plugin;
}

describe("settings control consistency preserves saved behavior", () => {
	it("presents both color controls as dropdowns and identifies global paper scope", async () => {
		const plugin = await loadThenSave({});
		(plugin as unknown as Record<string, unknown>).manifest = { version: "1.5.0" };
		const tab = Object.create(HandwritingSettingTab.prototype);
		tab.plugin = plugin;
		type Row = { name?: string; desc?: string; aliases?: string[]; items?: Row[]; control?: { type: string; key: string; options?: Record<string, string> } };
		const flatten = (items: Row[]): Row[] => items.flatMap(item => item.items ? flatten(item.items) : [item]);
		const rows = flatten(tab.getSettingDefinitions());
		const exported = rows.find(row => row.name === "Ink color when exporting")!;
		expect(exported, 'no settings row named "Ink color when exporting"').toBeDefined();
		const pdf = rows.find(row => row.name === "Ink color on PDFs")!;
		expect(pdf, 'no settings row named "Ink color on PDFs"').toBeDefined();
		// The renamed row keeps its shipped title as a search term.
		expect(pdf.aliases ?? [], 'the "Ink color on PDFs" row lost its old-title search alias').toContain("Ink color when flattening PDFs");
		expect(exported.control).toEqual({ type: "dropdown", key: "inkReadableInExports", options: { auto: "Automatic readability", keep: "Keep original colors" } });
		expect(pdf.control?.type).toBe("dropdown");
		expect(pdf.control?.options).toEqual({ darken: "Darken for light pages", lighten: "Lighten for dark pages", keep: "Keep original colors" });
		expect(rows.find(row => row.name === "Paper background")?.desc).toBe("Lined, grid, or dotted paper. Global setting. Default none.");
		// The zoom bar's option labels are copied verbatim from the Toolbar
		// visibility row beside it - the two settings behave identically.
		const toolbarVisibility = rows.find(row => row.name === "Toolbar visibility")!;
		const zoomBar = rows.find(row => row.name === "Zoom bar")!;
		// The row also carries a `disabled` predicate (SettingsCanvasRows.test.ts
		// owns what it says); the shape asserted here is the dropdown itself.
		expect(zoomBar.control?.type).toBe("dropdown");
		expect(zoomBar.control?.key).toBe("noteZoomControls");
		expect(zoomBar.control?.options).toEqual({ hide: "Off", show: "On", auto: "Auto" });
		expect(zoomBar.control?.options).toEqual(toolbarVisibility.control?.options);
	});
	it.each([undefined, true, false])("maps legacy export %s to dropdown without changing color policy", async value => {
		const plugin = await loadThenSave(value === undefined ? {} : { inkReadableInExports: value });
		const tab = Object.create(HandwritingSettingTab.prototype);
		tab.plugin = plugin;
		expect(tab.getControlValue("inkReadableInExports")).toBe(value === false ? "keep" : "auto");
		const before = [exportInkColor("#ffffff", "#ffffff", "pen"), exportInkColor("#000000", "#000000", "pen")];
		(plugin as unknown as Record<string, unknown>).saveSettingsNow = () => undefined;
		tab.setControlValue("inkReadableInExports", "keep");
		expect(plugin.settings.inkReadableInExports).toBe(false);
		expect(exportInkColor("#ffffff", "#ffffff", "pen")).toBe("#ffffff");
		tab.setControlValue("inkReadableInExports", "auto");
		expect(plugin.settings.inkReadableInExports).toBe(true);
		expect(inkExportReadabilityEnabled()).toBe(true);
		expect(exportInkColor("#ffffff", null, "pen")).toBe("#ffffff");
		expect(exportInkColor("#ffffff", "#ffffff", "highlighter")).toBe("#ffffff");
		if(value !== false) expect([exportInkColor("#ffffff", "#ffffff", "pen"), exportInkColor("#000000", "#000000", "pen")]).toEqual(before);
		await proto.persistSettings.call(plugin);
		expect(plugin.saved?.inkReadableInExports).toBe(true);
	});
	it.each([undefined, "auto", "show", "hide"])("preserves toolbar visibility %s", async mode => {
		const plugin = await loadThenSave(mode === undefined ? {} : { penTools: mode });
		expect(plugin.settings.penTools).toBe(mode ?? "auto");
		expect(plugin.saved?.penTools).toBe(mode ?? "auto");
	});
	// The zoom bar's mode round-trips exactly like the pen toolbar's, key for
	// key.
	it.each([undefined, "auto", "show", "hide"])("preserves zoom bar visibility %s", async mode => {
		const plugin = await loadThenSave(mode === undefined ? {} : { noteZoomControls: mode });
		expect(plugin.settings.noteZoomControls).toBe(mode ?? "auto");
		expect(plugin.saved?.noteZoomControls).toBe(mode ?? "auto");
	});
	// Two sites decide the default, and they must agree - a cell that cannot
	// fail is a defect, so this is re-derived from the real normaliser and
	// the real load path rather than two literal "auto"s.
	it("agrees with itself on the default: normalizeNoteZoomControlsMode(undefined) and a fresh load", async () => {
		expect(normalizeNoteZoomControlsMode(undefined)).toBe("auto");
		const plugin = await loadThenSave({});
		expect(plugin.settings.noteZoomControls).toBe(normalizeNoteZoomControlsMode(undefined));
	});
});

describe("loadSettings carries keys this build does not know", () => {
	beforeEach(() => {
		resetPenToolsForTest();
		resetNoteZoomControlsForTest();
	});

	// The EDIT half of this case went with the canvas page: the view
	// that wrote saved views, and the `editCanvasSavedViews` path that renamed
	// them, are both deleted. What still matters - and is what this case was
	// really guarding - is that a vault which HAS these records keeps them
	// byte for byte through reopen cycles of a build that can no longer make
	// any of them. A build that dropped them would erase a canvas page user's
	// saved views the first time this one saved anything.
	it("persists saved views and their opaque records through two plugin reopen cycles", async () => {
		const view = { schema: 1, id: "view-a", name: "A", pageId: "page-a", surface: "canvas",
			location: { kind: "canvas-world", x: -40000, y: 900000, zoom: .035, zoomPolicy: "fit-derived" } };
		const opaque = [{ schema: 99, id: "future", surface: "future", extension: [1, 2] },
			{ ...view, id: "policy", location: { ...view.location, zoomPolicy: "future-policy" } }];
		let plugin: any = await loadThenSave({ savedViews: [view, ...opaque], unrelatedSetting: { untouched: true } });
		for (let cycle = 0; cycle < 2; cycle++) {
			plugin = await loadThenSave(JSON.parse(JSON.stringify(plugin.saved)));
			expect(plugin.settings.savedViews).toEqual([view, ...opaque]);
			expect(plugin.saved.savedViews).toEqual(plugin.settings.savedViews);
			expect(plugin.settings.unrelatedSetting).toEqual({ untouched: true });
		}
	});


	it("round-trips an unknown key through the load and the write", async () => {
		const plugin = await loadThenSave({ futureKey: 1, mouseInk: true });

		expect(plugin.settings.futureKey, "the key was dropped rebuilding the object").toBe(1);
		// The write is what actually costs the other build its setting, so it
		// is asserted separately: a key held in memory and left out of
		// `saveData` would be erased from data.json just the same.
		expect(plugin.saved?.futureKey, "the key was held but not written back").toBe(1);
		// And the load still did its job on the key it does know.
		expect(plugin.settings.mouseInk).toBe(true);
	});

	it("normalises a known key with a bad value, spread or not", async () => {
		const plugin = await loadThenSave({
			futureKey: 1,
			inkSizes: { pen: 999, highlighter: 999 },
			eraserRadiusPx: -40,
			penTools: "nonsense",
			noteZoomControls: "nonsense",
		});

		// Re-derived by calling the same normaliser main.ts calls, never a
		// number typed in here: an assertion pinned to a recorded constant
		// would keep passing if the clamp itself changed.
		expect(plugin.settings.inkSizes).toEqual({
			pen: clampInkSize(999),
			highlighter: clampInkSize(999),
		});
		expect(plugin.settings.eraserRadiusPx).toBe(clampEraserRadius(-40));
		expect(plugin.settings.penTools).toBe(normalizePenToolsMode("nonsense"));
		expect(plugin.settings.noteZoomControls).toBe(normalizeNoteZoomControlsMode("nonsense"));
		// The spread put the rotten values in first; the known keys are
		// written over it. This is the assertion that fails if the two are
		// ever swapped.
		expect(plugin.settings.inkSizes).not.toEqual({ pen: 999, highlighter: 999 });
		expect(plugin.saved?.penTools).toBe(normalizePenToolsMode("nonsense"));
		expect(plugin.saved?.noteZoomControls).toBe(normalizeNoteZoomControlsMode("nonsense"));
		expect(plugin.saved?.futureKey).toBe(1);
	});

	it("carries an old data.json's penHardwareEverSeen rather than deleting it", async () => {
		// The latch left data.json on 2026-09-05 and is IGNORED at load - it
		// may be another machine's. Ignored is not deleted: a machine still
		// running a build that reads the key must not have its latch dropped
		// by this one's next save.
		const plugin = await loadThenSave({ penHardwareEverSeen: true });

		expect(plugin.saved?.penHardwareEverSeen).toBe(true);
	});

	it("carries nothing forward when the file is not an object", async () => {
		// `loadData` returns whatever the file parsed to. A string spread into
		// an object literal spills its characters in under numeric keys, and
		// an array spreads its elements the same way; neither is a settings
		// file, so neither contributes anything.
		const fromString = await loadThenSave("not a settings object");
		expect(fromString.settings[0], "a string was spread character by character").toBeUndefined();
		expect(Object.keys(fromString.settings)).not.toContain("0");

		const fromArray = await loadThenSave([{ mouseInk: true }]);
		expect(fromArray.settings[0], "an array was spread index by index").toBeUndefined();
		// Still a complete, usable settings object either way - the known keys
		// are written unconditionally, so nothing here is left undefined.
		expect(fromArray.settings.mouseInk).toBe(false);
		expect(fromArray.settings.penTools).toBe(normalizePenToolsMode(undefined));
		expect(fromArray.settings.noteZoomControls).toBe(normalizeNoteZoomControlsMode(undefined));
	});
});

/**
 * THE ADAPTATION IS OPT-IN, AND THIS IS WHAT KEEPS IT THAT WAY.
 *
 * `inkAdaptsToTheme` draws near-black ink light on a dark theme so an
 * imported page of black annotations is not invisible. It arrived ON by
 * default with the slides port, which would have changed how every
 * dark-theme user's existing ink looked the moment they updated. The owner
 * ruled it off (2026-09-07): "leave it off default, because expected
 * behaviour should be default and then the option if they need it".
 *
 * TWO PLACES DECIDE THIS AND THEY MUST AGREE. The literal in
 * DEFAULT_SETTINGS is the obvious one; the load coercion is the one that
 * actually decides for a real vault, because an existing vault has no stored
 * value and is therefore decided THERE. It read `raw?.inkAdaptsToTheme !==
 * false` - absence meaning ON - so flipping only the literal would have left
 * the default on for every user who had never touched the toggle, while the
 * source read as though it were off.
 *
 * These cases drive the real `loadSettings`, so they fail if either place
 * moves. A source-text assertion would not: it would pin the spelling of one
 * of the two and say nothing about what a vault actually loads.
 */
describe("ink theme adaptation is off unless a vault asks for it", () => {
	it("defaults off for a vault that has never stored the key", async () => {
		ensureDocument();
		const plugin = fakePlugin({});
		await proto.loadSettings.call(plugin);

		expect(
			plugin.settings.inkAdaptsToTheme,
			"an existing vault must not have its ink redrawn by an update"
		).toBe(false);
	});

	it("defaults off for a vault with other settings but not this one", async () => {
		ensureDocument();
		const plugin = fakePlugin({ mouseInk: true, inkSmoothing: false });
		await proto.loadSettings.call(plugin);

		expect(plugin.settings.inkAdaptsToTheme).toBe(false);
		expect(plugin.settings.mouseInk, "the rest of the file still loads").toBe(true);
	});

	it("stays on for a vault that turned it on", async () => {
		ensureDocument();
		const plugin = fakePlugin({ inkAdaptsToTheme: true });
		await proto.loadSettings.call(plugin);

		expect(
			plugin.settings.inkAdaptsToTheme,
			"off by default must not mean unavailable"
		).toBe(true);
	});

	it("stays off for a vault that turned it off", async () => {
		ensureDocument();
		const plugin = fakePlugin({ inkAdaptsToTheme: false });
		await proto.loadSettings.call(plugin);

		expect(plugin.settings.inkAdaptsToTheme).toBe(false);
	});
});

/**
 * THE SAME TRAP, WITH THE SIGN REVERSED - AND THIS IS THE HALF THAT SHIPS ON.
 *
 * `inkReadableInExports` guarantees that ink you export can be read where it
 * lands: white ink on a white PDF page is darkened until it passes 3:1. Alan
 * ruled it ON by default ("export toggle should default on"), the opposite
 * answer to the toggle directly above it in the settings tab, because the two
 * questions are different - on screen you are looking at your own canvas and
 * expect the colour you picked, in an export you are making something for
 * elsewhere and expect to be able to read it.
 *
 * TWO PLACES DECIDE IT AND ONLY ONE DECIDES FOR A REAL VAULT. The literal in
 * DEFAULT_SETTINGS is the obvious one; the load coercion is the one that
 * actually answers for a vault that has never stored the key, which is every
 * existing user. For default-ON the coercion has to be `!== false` - absence
 * counting as ON. `=== true` there would leave the literal decorative and
 * ship the whole fix switched off for everyone who already has a vault, which
 * is exactly how `inkAdaptsToTheme` went wrong once, pointing the other way.
 *
 * These cases drive the real `loadSettings`. A `?raw` source match would pin
 * the spelling of one of the two places and say nothing about what a vault
 * actually loads - which is the failure this comment exists to prevent.
 */
describe("exported ink is kept readable unless a vault says otherwise", () => {
	it("defaults ON for a vault that has never stored the key", async () => {
		ensureDocument();
		const plugin = fakePlugin({});
		await proto.loadSettings.call(plugin);

		expect(
			plugin.settings.inkReadableInExports,
			"an existing vault must get the fix without having to find a toggle"
		).toBe(true);
	});

	it("defaults ON for a vault with other settings but not this one", async () => {
		ensureDocument();
		const plugin = fakePlugin({ mouseInk: true, inkAdaptsToTheme: true });
		await proto.loadSettings.call(plugin);

		expect(plugin.settings.inkReadableInExports).toBe(true);
		expect(plugin.settings.mouseInk, "the rest of the file still loads").toBe(true);
	});

	it("stays off for a vault that turned it off", async () => {
		ensureDocument();
		const plugin = fakePlugin({ inkReadableInExports: false });
		await proto.loadSettings.call(plugin);

		expect(
			plugin.settings.inkReadableInExports,
			"on by default must not mean compulsory"
		).toBe(false);
	});

	it("stays on for a vault that turned it on", async () => {
		ensureDocument();
		const plugin = fakePlugin({ inkReadableInExports: true });
		await proto.loadSettings.call(plugin);

		expect(plugin.settings.inkReadableInExports).toBe(true);
	});

	it("the two ink-colour toggles load with OPPOSITE defaults, on purpose", async () => {
		// The pair is the point. If a future edit makes them agree, one of the
		// two rulings has been lost, and this is where that shows up.
		ensureDocument();
		const plugin = fakePlugin({});
		await proto.loadSettings.call(plugin);

		expect(plugin.settings.inkAdaptsToTheme).toBe(false);
		expect(plugin.settings.inkReadableInExports).toBe(true);
	});
});

/**
 * THE SAME TRAP, THIRD TIME - BUT NOT THE SAME CHECK, and that is the point.
 *
 * `inkPdfColorMode` decides what the flatten writer assumes about pages it
 * cannot see: darken for light stock, lighten for dark, or leave the stored
 * colour alone. Alan asked for the third state himself after finding black
 * ink invisible on a dark page - a boolean could only offer "guess white" or
 * "guess nothing", and neither is "the page is dark".
 *
 * THE BOOLEAN'S `!== false` DOES NOT PORT. An enum's failure is a value it
 * does not recognise, which is a different question from a value that is
 * absent, and both have to land on the shipped default. `=== "darken"` would
 * be the mirror mistake of `=== true`: it would answer "darken" for a vault
 * that had chosen "lighten" only if the spelling drifted, and silently throw
 * away a real choice. `normalizePdfPageAssumption` owns the single answer so
 * the type and the coercion cannot disagree.
 *
 * Driven through the real `loadSettings` for the reason the blocks above
 * give: a `?raw` source match pins a spelling and says nothing about what a
 * vault actually loads.
 */
describe("the pdf ink colour mode falls back to darken unless a vault says otherwise", () => {
	it("defaults to darken for a vault that has never stored the key", async () => {
		ensureDocument();
		const plugin = fakePlugin({});
		await proto.loadSettings.call(plugin);

		expect(
			plugin.settings.inkPdfColorMode,
			"an existing vault must get the guarantee without having to find a setting"
		).toBe("darken");
	});

	it("defaults to darken for a vault with other settings but not this one", async () => {
		ensureDocument();
		const plugin = fakePlugin({ mouseInk: true, inkReadableInExports: false });
		await proto.loadSettings.call(plugin);

		expect(plugin.settings.inkPdfColorMode).toBe("darken");
		expect(plugin.settings.mouseInk, "the rest of the file still loads").toBe(true);
		expect(
			plugin.settings.inkReadableInExports,
			"and the neighbouring toggle is still its own decision"
		).toBe(false);
	});

	it("keeps a vault's real choice, both of the non-default ones", async () => {
		ensureDocument();
		for (const mode of ["lighten", "keep"] as const) {
			const plugin = fakePlugin({ inkPdfColorMode: mode });
			await proto.loadSettings.call(plugin);
			expect(
				plugin.settings.inkPdfColorMode,
				"a default must not mean compulsory"
			).toBe(mode);
		}
	});

	it("falls back to darken for a value it does not recognise", async () => {
		ensureDocument();
		// A newer version's value, a hand-edited config, and a wrong type.
		for (const bad of ["invert", "DARKEN", "", true, 0, null]) {
			const plugin = fakePlugin({ inkPdfColorMode: bad });
			await proto.loadSettings.call(plugin);
			expect(
				plugin.settings.inkPdfColorMode,
				`an unrecognised ${JSON.stringify(bad)} must not become a mode`
			).toBe("darken");
		}
	});
});
