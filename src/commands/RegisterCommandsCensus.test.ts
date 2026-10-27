/**
 * The command ids registerCommands registers, in order, pinned literally for each pair of the two settings
 * that change the list: colorSizeCommands (the size and colour commands) and devDiagnostics (the diagnostics
 * commands). The registrations are written in phases, and a phase can live in its own file and be called from
 * registerCommands. A test that reads the source text cannot see a call that is missing or made in the wrong
 * place once the text is in another file; this one runs the real registerCommands on a bare plugin and reads
 * what it registered. The lists were taken from the commands file before any phase moved out of it.
 *
 * Without devDiagnostics the diagnostics phase still registers three commands, so a dropped call shows in all
 * four pairs. The same ids at a different place in the list fail too: the order is what the palette shows.
 */
import { describe, expect, it } from "vitest";

import { HandwritingPlugin } from "../main";

type Deps = Parameters<HandwritingPlugin["registerCommands"]>[0];

/** The plugin surface the registrations read while they register, on a plugin built without its constructor. */
type BarePlugin = {
	addCommand(command: { id: string }): unknown;
	settings: { colorSizeCommands: boolean; devDiagnostics: boolean };
	gatedCommandDefs: Map<string, unknown>;
	registerCommands(deps: Deps): void;
};

function registeredIds(colorSizeCommands: boolean, devDiagnostics: boolean): string[] {
	const plugin = Object.create(HandwritingPlugin.prototype) as BarePlugin;
	const ids: string[] = [];
	plugin.addCommand = (command) => {
		ids.push(command.id);
		return command;
	};
	plugin.settings = { colorSizeCommands, devDiagnostics };
	plugin.gatedCommandDefs = new Map();
	const quiet = (): void => {};
	plugin.registerCommands({
		TRACE_UPLOAD_URL: "",
		loadedBuild: (version) => ({ version, sourceCommit: "", sourceTree: "", dirtyStatus: "", verified: false }),
		penInkCommandHost: {} as Deps["penInkCommandHost"],
		penToggleNoticeText: (on) => String(on),
		platformOs: () => "",
		showPenToggleNotice: quiet,
		showEraserToggleNotice: quiet,
		showLassoToggleNotice: quiet,
		showSpaceToggleNotice: quiet,
		showPanToggleNotice: quiet,
		showMouseInkToggleNotice: quiet,
	});
	return ids;
}

const IDS_COLOR_OFF_DEV_OFF = [
	"inline-tool-pen",
	"mouse-ink-toggle",
	"resolve-ink-fork",
	"slides-undo",
	"slides-redo",
	"slides-clear-current",
	"slides-clear-all",
	"slides-ink-toggle",
	"paper-cycle",
	"canvas-note-override-cycle",
	"toolbar-zoom-bar-toggle",
	"export-ink-svg",
	"export-ink-pdf",
	"flatten-pdf-ink",
	"snip-pdf-selection",
	"delete-all-pdf-ink",
	"delete-selected-ink",
	"copy-selected-ink",
	"cut-selected-ink",
	"paste-ink",
	"delete-all-ink",
	"check-split-ink",
	"inline-tool-highlighter",
	"copy-inline-pen-trace",
	"copy-inline-pen-trace-json",
	"toggle-diagnostics",
];

const IDS_COLOR_OFF_DEV_ON = [
	"inline-tool-pen",
	"mouse-ink-toggle",
	"resolve-ink-fork",
	"slides-undo",
	"slides-redo",
	"slides-clear-current",
	"slides-clear-all",
	"slides-ink-toggle",
	"paper-cycle",
	"canvas-note-override-cycle",
	"toolbar-zoom-bar-toggle",
	"export-ink-svg",
	"export-ink-pdf",
	"flatten-pdf-ink",
	"snip-pdf-selection",
	"delete-all-pdf-ink",
	"delete-selected-ink",
	"copy-selected-ink",
	"cut-selected-ink",
	"paste-ink",
	"delete-all-ink",
	"check-split-ink",
	"inline-tool-highlighter",
	"copy-inline-pen-trace",
	"copy-inline-pen-trace-json",
	"toggle-pdf-ink-calibration",
	"show-pdf-view-report",
	"show-ink-metrics",
	"start-ink-trace",
	"stop-ink-trace",
	"clear-inline-pen-trace",
	"copy-inline-zoom-report",
	"toggle-inline-hit-probe",
	"copy-inline-hit-report",
	"clear-inline-hit-probe",
	"copy-region-census",
	"copy-presentation-capture",
	"toggle-diagnostics",
	"copy-inline-scroll-trace",
	"clear-inline-scroll-trace",
	"copy-pdf-pan-trace",
	"clear-pdf-pan-trace",
	"open-pen-diagnostics",
];

const IDS_COLOR_ON_DEV_OFF = [
	"inline-tool-pen",
	"mouse-ink-toggle",
	"resolve-ink-fork",
	"slides-undo",
	"slides-redo",
	"slides-clear-current",
	"slides-clear-all",
	"slides-ink-toggle",
	"paper-cycle",
	"canvas-note-override-cycle",
	"toolbar-zoom-bar-toggle",
	"inline-tool-eraser",
	"inline-tool-lasso",
	"inline-tool-space",
	"inline-tool-pan",
	"eraser-size-cycle",
	"ink-preset-pen-1",
	"ink-preset-pen-2",
	"ink-preset-pen-3",
	"ink-preset-pen-4",
	"ink-preset-save-pen-1",
	"ink-preset-save-pen-2",
	"ink-preset-save-pen-3",
	"ink-preset-save-pen-4",
	"ink-preset-highlighter-1",
	"ink-preset-highlighter-2",
	"ink-preset-highlighter-3",
	"ink-preset-highlighter-4",
	"ink-preset-save-highlighter-1",
	"ink-preset-save-highlighter-2",
	"ink-preset-save-highlighter-3",
	"ink-preset-save-highlighter-4",
	"ink-size-fine",
	"ink-size-medium",
	"ink-size-bold",
	"ink-size-cycle",
	"ink-color-blue",
	"ink-color-black",
	"ink-color-graphite",
	"ink-color-white",
	"ink-color-red",
	"ink-color-orange",
	"ink-color-green",
	"ink-color-purple",
	"ink-color-yellow",
	"ink-color-pink",
	"highlighter-color-yellow",
	"highlighter-color-green",
	"highlighter-color-pink",
	"highlighter-color-blue",
	"highlighter-color-orange",
	"export-ink-svg",
	"export-ink-pdf",
	"flatten-pdf-ink",
	"snip-pdf-selection",
	"delete-all-pdf-ink",
	"delete-selected-ink",
	"copy-selected-ink",
	"cut-selected-ink",
	"paste-ink",
	"delete-all-ink",
	"check-split-ink",
	"ink-color-cycle",
	"highlighter-color-cycle",
	"pen-color-cycle",
	"inline-tool-highlighter",
	"copy-inline-pen-trace",
	"copy-inline-pen-trace-json",
	"toggle-diagnostics",
];

const IDS_COLOR_ON_DEV_ON = [
	"inline-tool-pen",
	"mouse-ink-toggle",
	"resolve-ink-fork",
	"slides-undo",
	"slides-redo",
	"slides-clear-current",
	"slides-clear-all",
	"slides-ink-toggle",
	"paper-cycle",
	"canvas-note-override-cycle",
	"toolbar-zoom-bar-toggle",
	"inline-tool-eraser",
	"inline-tool-lasso",
	"inline-tool-space",
	"inline-tool-pan",
	"eraser-size-cycle",
	"ink-preset-pen-1",
	"ink-preset-pen-2",
	"ink-preset-pen-3",
	"ink-preset-pen-4",
	"ink-preset-save-pen-1",
	"ink-preset-save-pen-2",
	"ink-preset-save-pen-3",
	"ink-preset-save-pen-4",
	"ink-preset-highlighter-1",
	"ink-preset-highlighter-2",
	"ink-preset-highlighter-3",
	"ink-preset-highlighter-4",
	"ink-preset-save-highlighter-1",
	"ink-preset-save-highlighter-2",
	"ink-preset-save-highlighter-3",
	"ink-preset-save-highlighter-4",
	"ink-size-fine",
	"ink-size-medium",
	"ink-size-bold",
	"ink-size-cycle",
	"ink-color-blue",
	"ink-color-black",
	"ink-color-graphite",
	"ink-color-white",
	"ink-color-red",
	"ink-color-orange",
	"ink-color-green",
	"ink-color-purple",
	"ink-color-yellow",
	"ink-color-pink",
	"highlighter-color-yellow",
	"highlighter-color-green",
	"highlighter-color-pink",
	"highlighter-color-blue",
	"highlighter-color-orange",
	"export-ink-svg",
	"export-ink-pdf",
	"flatten-pdf-ink",
	"snip-pdf-selection",
	"delete-all-pdf-ink",
	"delete-selected-ink",
	"copy-selected-ink",
	"cut-selected-ink",
	"paste-ink",
	"delete-all-ink",
	"check-split-ink",
	"ink-color-cycle",
	"highlighter-color-cycle",
	"pen-color-cycle",
	"inline-tool-highlighter",
	"copy-inline-pen-trace",
	"copy-inline-pen-trace-json",
	"toggle-pdf-ink-calibration",
	"show-pdf-view-report",
	"show-ink-metrics",
	"start-ink-trace",
	"stop-ink-trace",
	"clear-inline-pen-trace",
	"copy-inline-zoom-report",
	"toggle-inline-hit-probe",
	"copy-inline-hit-report",
	"clear-inline-hit-probe",
	"copy-region-census",
	"copy-presentation-capture",
	"toggle-diagnostics",
	"copy-inline-scroll-trace",
	"clear-inline-scroll-trace",
	"copy-pdf-pan-trace",
	"clear-pdf-pan-trace",
	"open-pen-diagnostics",
];

describe("the command ids registerCommands registers, in order", () => {
	it("colorSizeCommands off, devDiagnostics off: 26 ids", () => {
		expect(registeredIds(false, false)).toEqual(IDS_COLOR_OFF_DEV_OFF);
	});

	it("colorSizeCommands off, devDiagnostics on: 43 ids", () => {
		expect(registeredIds(false, true)).toEqual(IDS_COLOR_OFF_DEV_ON);
	});

	it("colorSizeCommands on, devDiagnostics off: 69 ids", () => {
		expect(registeredIds(true, false)).toEqual(IDS_COLOR_ON_DEV_OFF);
	});

	it("colorSizeCommands on, devDiagnostics on: 86 ids", () => {
		expect(registeredIds(true, true)).toEqual(IDS_COLOR_ON_DEV_ON);
	});
});
