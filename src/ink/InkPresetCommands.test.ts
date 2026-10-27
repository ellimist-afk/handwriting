import { describe, expect, it } from "vitest";
import mainSrc from "../main.ts?raw";
import commandsSrc from "../commands/RegisterCommands.ts?raw";
import {
	PRESET_COMMANDS,
	type PresetCommand,
	registerInkPresetCommands,
} from "./InkPresetCommands";
import { MAX_PRESETS_PER_TOOL } from "./InkPresets";

/** Everything `addCommand` was handed, in registration order. */
const registered = (): Array<{ id: string; name: string; callback: () => void }> => {
	const out: Array<{ id: string; name: string; callback: () => void }> = [];
	registerInkPresetCommands({ addCommand: (c) => void out.push(c) });
	return out;
};

describe("PRESET_COMMANDS — the table registration and the settings list share", () => {
	it("is two groups per tool: one to wear a slot, one to save into it", () => {
		expect(PRESET_COMMANDS).toHaveLength(MAX_PRESETS_PER_TOOL * 4);
		const count = (kind: PresetCommand["kind"], tool: string): number =>
			PRESET_COMMANDS.filter((c) => c.kind === kind && c.tool === tool).length;
		expect(count("apply", "pen")).toBe(MAX_PRESETS_PER_TOOL);
		expect(count("save", "pen")).toBe(MAX_PRESETS_PER_TOOL);
		expect(count("apply", "highlighter")).toBe(MAX_PRESETS_PER_TOOL);
		expect(count("save", "highlighter")).toBe(MAX_PRESETS_PER_TOOL);
	});

	it("names them the way design §10 wrote them", () => {
		const names = PRESET_COMMANDS.map((c) => c.name);
		expect(names).toContain("Pen preset 1");
		expect(names).toContain("Pen preset 4");
		expect(names).toContain("Highlighter preset 1");
		expect(names).toContain("Highlighter preset 4");
		expect(names).toContain("Save current pen as preset 1");
		expect(names).toContain("Save current highlighter as preset 4");
		// Counted from ONE, the way a user counts slots - there is no
		// "Pen preset 0" for the first chip in the row.
		expect(names).not.toContain("Pen preset 0");
	});

	it("has unique ids, and names nobody else in the palette has taken", () => {
		const ids = PRESET_COMMANDS.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
		const names = PRESET_COMMANDS.map((c) => c.name);
		expect(new Set(names).size).toBe(names.length);
		// An id is what a user's hotkey is bound to: a collision with an
		// existing command would silently steal or lose a binding.
		for (const id of ids) expect(mainSrc.includes(`id: "${id}"`)).toBe(false);
	});

	it("indexes from zero into the slot its name counts from one", () => {
		const first = PRESET_COMMANDS.find((c) => c.name === "Pen preset 1");
		const last = PRESET_COMMANDS.find((c) => c.name === "Pen preset 4");
		expect(first?.index).toBe(0);
		expect(last?.index).toBe(MAX_PRESETS_PER_TOOL - 1);
	});
});

describe("registerInkPresetCommands", () => {
	it("registers every table entry, once, id and name intact", () => {
		const cmds = registered();
		expect(cmds.map((c) => c.id)).toEqual(PRESET_COMMANDS.map((c) => c.id));
		expect(cmds.map((c) => c.name)).toEqual(PRESET_COMMANDS.map((c) => c.name));
	});

	it("gives every entry a callback that does not throw with no actions registered", () => {
		// The hook is null until main installs it (InkPresets.ts's
		// `applyInkPreset` is optional-chained). A hotkey pressed during
		// load must be a no-op, never an exception inside a command.
		for (const cmd of registered()) expect(() => cmd.callback()).not.toThrow();
	});
});

/**
 * The gate, read out of main.ts's own source: these sixteen are per-value
 * commands, and per-value commands live behind "Extra commands for hotkeys"
 * (`colorSizeCommands`) with the per-colour and per-size ones. The CHIPS are
 * not gated - they go through the action hook - and that half is pinned in
 * MobileTools.test.ts.
 */
describe("main.ts registers them behind the extra-commands switch", () => {
	// CRLF is what a Windows checkout hands `?raw`; every slice probe here
	// normalises before it looks for a line, or it finds nothing and passes.
	// The command registrations live in commands/RegisterCommands.ts, read here with main.ts.
	const code = [mainSrc, commandsSrc].join("\n").replace(/\r\n/g, "\n");

	// THE GATE MOVED, the guarantee did not. This slice was written against
	// `if (this.settings.colorSizeCommands) registerInkPresetCommands(this)`,
	// which is how quick pens spelled it before the palette split landed. The
	// split put every gated registration behind one `addGatedCommand` helper,
	// so the preset table registers through that helper instead - the setting
	// is read once in main.ts rather than once per feature. What must still
	// hold is what these two tests always meant: the registrar is called
	// exactly once, that call cannot register while the switch is off, and no
	// second ungated call exists.
	const GATE = "const addGatedCommand = (cmd: Command): void => {";
	const CALL = "registerInkPresetCommands({ addCommand: addGatedCommand })";

	it("calls the registrar exactly once, through the gated adder", () => {
		expect(code).toContain(CALL);
		expect(code.split(CALL).length - 1).toBe(1);
		// The ungated form this file used to assert must not come back: it
		// would hand the plugin's own `addCommand` to the table and register
		// all sixteen with the switch off.
		expect(code).not.toContain("registerInkPresetCommands(this)");
	});

	it("the adder it registers through is the one the switch gates", () => {
		// Both ends of the slice asserted, so a moved anchor fails loudly
		// rather than searching the whole file and finding nothing.
		const imported = code.indexOf('from "../ink/InkPresetCommands"');
		expect(imported, "main no longer imports the registrar").toBeGreaterThan(-1);
		const from = code.indexOf(GATE);
		expect(from, "main no longer defines addGatedCommand").toBeGreaterThan(-1);
		const end = code.indexOf("};", from);
		expect(end, "addGatedCommand's body has no end").toBeGreaterThan(from);
		const body = code.slice(from + GATE.length, end);
		// The whole gate: registration happens only on the switch, and the
		// off branch files an action rather than registering anything.
		expect(body).toContain("if (this.settings.colorSizeCommands) this.addCommand(cmd);");
		expect(body).not.toMatch(/^\s*this\.addCommand\(cmd\);/m);
		// And the preset call really is inside the same method as that helper,
		// after it, so the shim it passes is this helper and not a namesake.
		const call = code.indexOf(CALL);
		expect(call, "the registrar is not called from main").toBeGreaterThan(from);
	});
});
