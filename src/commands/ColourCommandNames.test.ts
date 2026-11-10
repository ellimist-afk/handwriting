import { afterEach, describe, expect, it, vi } from "vitest";
import HandwritingPlugin, { HandwritingSettingTab } from "../main";
import { clearGatedCommandActions, setGatedCommandAction } from "../CommandPaletteSplit";
import { HIGHLIGHTER_COLORS, PEN_COLORS, setInkColorHex, setInkPalette } from "../ink/InkColor";
import { DEFAULT_SETTINGS } from "../settings/SettingsModel";

// The command palette names of the per-colour hotkey commands follow a slot
// edit made in settings (1.5.0): the stored definition is renamed, and a
// command registered with the app is handed again under the same id, so the
// palette shows the slot's colour without a reload. Ids and callbacks stay.

type Cmd = { id: string; name: string; callback?: () => void };
type Rig = {
	tab: { setPaletteSlot(tool: "pen" | "highlighter", i: number, hex: string | null): void; resetPalette(tool: "pen" | "highlighter"): void };
	defs: Map<string, Cmd>;
	added: Cmd[];
};

const COLOUR_IDS = ["ink-color-red", "ink-color-pink", "highlighter-color-green"];

/** A plugin with three colour commands, registered with the app (switch on) or mirrored (switch off). */
function rig(switchOn: boolean): Rig {
	clearGatedCommandActions();
	const settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
	settings.colorSizeCommands = switchOn;
	const added: Cmd[] = [];
	const p = Object.create(HandwritingPlugin.prototype) as Record<string, unknown>;
	const defs = new Map<string, Cmd>([
		["ink-color-red", { id: "ink-color-red", name: "Ink color: red", callback: () => {} }],
		["ink-color-pink", { id: "ink-color-pink", name: "Ink color: pink", callback: () => {} }],
		["highlighter-color-green", { id: "highlighter-color-green", name: "Highlighter color: green", callback: () => {} }],
		["ink-color-cycle", { id: "ink-color-cycle", name: "Ink color: next", callback: () => {} }],
	]);
	p.settings = settings;
	p.gatedCommandDefs = defs;
	p.addCommand = (c: Cmd) => { added.push({ ...c }); return c; };
	p.saveSettingsNow = vi.fn();
	p.refreshSettingSurfaces = vi.fn();
	if (!switchOn) for (const [id, c] of defs) setGatedCommandAction(id, c.callback!);
	const tab = Object.create(HandwritingSettingTab.prototype) as Rig["tab"] & { plugin: unknown };
	tab.plugin = p;
	return { tab, defs, added };
}

afterEach(() => {
	clearGatedCommandActions();
	setInkPalette("pen", PEN_COLORS.map((c) => c.hex));
	setInkPalette("highlighter", HIGHLIGHTER_COLORS.map((c) => c.hex));
	setInkColorHex("pen", PEN_COLORS[0]!.hex);
	setInkColorHex("highlighter", HIGHLIGHTER_COLORS[0]!.hex);
});

describe("colour command names follow a slot edit", () => {
	it("an edited slot renames its stored command and hands it to the app again under the same id", () => {
		const { tab, defs, added } = rig(true);
		tab.setPaletteSlot("pen", 4, "#aa0011");
		expect(defs.get("ink-color-red")!.name).toBe("Ink color: #aa0011");
		const last = new Map(added.map((c) => [c.id, c]));
		expect(last.get("ink-color-red")?.name, `re-added: ${JSON.stringify(added)}`).toBe("Ink color: #aa0011");
		expect(typeof last.get("ink-color-red")?.callback).toBe("function");
		expect(defs.get("ink-color-cycle")!.name, "the cycle keeps its name").toBe("Ink color: next");
	});

	it("a highlighter slot edit renames the highlighter command; the pen command of the same colour name follows the pen slot", () => {
		const { tab, defs } = rig(true);
		tab.setPaletteSlot("highlighter", 1, "#0000ff");
		expect(defs.get("highlighter-color-green")!.name).toBe("Highlighter color: #0000ff");
		expect(defs.get("ink-color-pink")!.name).toBe("Ink color: pink");
	});

	it("a reset puts the default name back", () => {
		const { tab, defs, added } = rig(true);
		tab.setPaletteSlot("pen", 4, "#aa0011");
		tab.resetPalette("pen");
		expect(defs.get("ink-color-red")!.name).toBe("Ink color: red");
		expect(added.filter((c) => c.id === "ink-color-red").pop()?.name).toBe("Ink color: red");
	});

	it("with the hotkey commands switched off the stored name changes and nothing is handed to the app", () => {
		const { tab, defs, added } = rig(false);
		tab.setPaletteSlot("pen", 4, "#aa0011");
		expect(defs.get("ink-color-red")!.name).toBe("Ink color: #aa0011");
		expect(added).toEqual([]);
	});

	it("ids are never renamed", () => {
		const { tab, defs, added } = rig(true);
		tab.setPaletteSlot("pen", 4, "#aa0011");
		expect([...defs.keys()].sort()).toEqual([...COLOUR_IDS, "ink-color-cycle"].sort());
		for (const c of added) expect([...COLOUR_IDS, "ink-color-cycle"]).toContain(c.id);
	});
});
