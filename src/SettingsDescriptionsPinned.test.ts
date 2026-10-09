import { describe, expect, it } from "vitest";
import HandwritingPlugin, { HandwritingSettingTab } from "./main";

// Independent literal contract for the settings descriptions at the approved base.
// Read the real definitions; no painter, plugin load, or persistence is needed.
const contract = [
	{"name": "Infinite canvas", "key": "extendCanvasWhileScrolling", "descriptions": ["Let the page grow as you write and scroll. Also turns on the zoom bar. Global setting. A note can override it with handwriting-canvas: true or false in its frontmatter. Default off."]},
	{"name": "Hide status bar on handwriting notes", "key": "hideStatusBarOnInkedNotes", "descriptions": ["Hide Obsidian's status bar on notes with handwriting. Global setting. Default off."]},
	{"name": "Paper background", "key": "paperStyle", "descriptions": ["Lined, grid, or dotted paper. Global setting. A note can override it with handwriting-paper in its frontmatter. Default none."]},
	{"name": "Toolbar visibility", "key": "penTools", "descriptions": ["Show or hide the pen toolbar. Auto shows it on phones and tablets, on desktop once a pen is used, and moves it aside while you write. Global setting. Default auto."]},
	{"name": "Zoom bar", "key": "noteZoomControls", "descriptions": ["Buttons to zoom the page in and out. Needs Infinite canvas on for the note. Auto moves it aside while you write. Global setting. Default auto."]},
	{"name": "Toolbar placement", "key": "toolbarCorner", "descriptions": ["Where the toolbar sits. Global setting. Default top right."]},
	{"name": "Ink color on PDFs", "key": "inkPdfColorMode", "descriptions": ["Darken, lighten, or leave it alone. Global setting. Default darken."]},
	{"name": "Ink color when exporting", "key": "inkReadableInExports", "descriptions": ["Keep pen ink readable in exports, prints, and snips. Global setting. Default automatic readability."]},
	{"name": "Ink prediction", "key": "strokePrediction", "descriptions": ["Reduce visible pen lag. Global setting. Default on."]},
	{"name": "Pressure sensitivity", "key": "pressureSensitivity", "descriptions": ["Adjust line width with pen pressure. Global setting. Default on."]},
	{"name": "Ink smoothing", "key": "inkSmoothing", "descriptions": ["Smooth and taper strokes. Global setting. Default on."]},
	{"name": "Pen reticle", "key": "penReticle", "descriptions": ["Show a dot at the pen tip. Global setting. Default on."]},
	{"name": "Shape snap", "key": "shapeSnap", "descriptions": ["Hold at the end of a stroke to snap it into a shape. Global setting. Default on."]},
	{"name": "Extra commands for hotkeys", "key": "colorSizeCommands", "descriptions": ["Add tool, color, size, and quick pen commands for hotkeys. Global setting. Default off.", "Add tool, color, size, and quick pen commands for hotkeys. Global setting. Default off. Turning it off takes effect after the plugin reloads."]},
	{"name": "Developer diagnostics", "key": "devDiagnostics", "descriptions": ["Show diagnostic commands after reloading the plugin. Global setting. Default off."]},
	{"name": "Boox mode", "key": "booxMode", "descriptions": ["Adjust pen input and animations for e-ink screens. Global setting. Default off."]},
	{"name": "Recalibrate pen pressure", "key": null, "descriptions": ["Forget the pressure range learned on this device and relearn it from your next strokes. This device only."]},
];

type Row = {
	name?: string;
	desc?: string;
	items?: Row[];
	control?: { type: string; key: string };
};

function definitions(canRemove: boolean): { rows: Row[]; available: boolean } {
	const plugin = Object.create(HandwritingPlugin.prototype) as Record<string, unknown>;
	plugin.manifest = { version: "1.4.23" };
	plugin.settings = { booxMode: false, extendCanvasWhileScrolling: false };
	// Shadow any inherited API so the false case has neither removal route.
	plugin.removeCommand = undefined;
	plugin.app = { commands: canRemove ? { removeCommand: () => {} } : {} };
	const available = HandwritingPlugin.prototype.gatedCommandRemovalAvailable.call(
		plugin as unknown as HandwritingPlugin,
	);
	const tab = Object.create(HandwritingSettingTab.prototype) as {
		plugin: unknown;
		getSettingDefinitions(): Row[];
	};
	tab.plugin = plugin;
	const flatten = (rows: Row[]): Row[] =>
		rows.flatMap((row) => row.items ? flatten(row.items) : [row]);
	return { rows: flatten(tab.getSettingDefinitions()), available };
}

function targets(rows: Row[]): Row[] {
	return rows.filter((row) =>
		row.control?.type === "toggle" || row.control?.type === "dropdown" ||
		row.name === "Recalibrate pen pressure",
	);
}

function uniqueRow(rows: Row[], name: string): Row {
	const matches = rows.filter((row) => row.name === name);
	expect(matches, `exactly one ${name} row`).toHaveLength(1);
	return matches[0]!;
}

describe.each([true, false])("settings descriptions with command removal %s", (canRemove) => {
	it("exercises the real command-removal capability", () => {
		expect(definitions(canRemove).available).toBe(canRemove);
	});

	it("has exactly 16 unique controls and the device recalibration action", () => {
		const rows = targets(definitions(canRemove).rows);
		expect(rows).toHaveLength(17);
		expect(new Set(rows.map((row) => row.name)).size).toBe(17);
		expect(rows.map((row) => row.name).sort()).toEqual(contract.map((row) => row.name).sort());
		const controls = rows.filter((row) => row.control);
		expect(controls).toHaveLength(16);
		expect(new Set(controls.map((row) => row.control!.key)).size).toBe(16);
		for (const expected of contract) {
			const actual = uniqueRow(rows, expected.name);
			expect(actual.control?.key ?? null, expected.name).toBe(expected.key);
		}
	});

	it.each(contract)("pins the complete $name description", (expected) => {
		const actual = uniqueRow(targets(definitions(canRemove).rows), expected.name);
		const description = !canRemove && expected.descriptions.length === 2
			? expected.descriptions[1] : expected.descriptions[0];
		expect(actual.desc).toBe(description);
	});

	it.each(contract.filter((row) => row.key !== null))(
		"$name explains its effect, global scope and lowercase default",
		(expected) => {
			const actual = uniqueRow(targets(definitions(canRemove).rows), expected.name);
			expect(actual.desc).toMatch(/^.+\S Global setting\.[\s\S]*\bDefault [a-z][a-z ]*\./);
		},
	);
});
