import { afterEach, describe, expect, it, vi } from "vitest";
import { HandwritingSettingTab } from "../main";
import { HIGHLIGHTER_COLORS, PEN_COLORS, colorsFor, getInkColorHex, setInkColorHex, setInkPalette } from "../ink/InkColor";
import { DEFAULT_SETTINGS, paletteSlots } from "./SettingsModel";

// The settings rows that edit the palette (1.5.0): one colour picker per slot,
// a reset per slot, a reset of every slot per tool. Driven through the tab's
// own edit methods, which the pickers and buttons call.

const penDefaults = PEN_COLORS.map((c) => c.hex);
const highlighterDefaults = HIGHLIGHTER_COLORS.map((c) => c.hex);

type Tab = {
	plugin: unknown;
	setPaletteSlot(tool: "pen" | "highlighter", index: number, hex: string | null): void;
	resetPalette(tool: "pen" | "highlighter"): void;
};

function tab(): {
	t: Tab;
	settings: { penPalette: Record<string, string>; highlighterPalette: Record<string, string>; inkColors: Record<string, string> };
	saves: ReturnType<typeof vi.fn>;
	refreshes: ReturnType<typeof vi.fn>;
} {
	const settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
	const saves = vi.fn();
	const refreshes = vi.fn();
	const t = Object.create(HandwritingSettingTab.prototype) as Tab;
	t.plugin = { settings, saveSettingsNow: saves, refreshSettingSurfaces: refreshes, refreshColourCommandNames: vi.fn() };
	return { t, settings, saves, refreshes };
}

afterEach(() => {
	setInkPalette("pen", penDefaults);
	setInkPalette("highlighter", highlighterDefaults);
	setInkColorHex("pen", penDefaults[0]);
	setInkColorHex("highlighter", highlighterDefaults[0]);
});

describe("editing a palette slot from settings", () => {
	it("writes the slot to its setting and the live palette, saves, and refreshes the strip and commands", () => {
		const { t, settings, saves, refreshes } = tab();
		t.setPaletteSlot("pen", 3, "#0A0B0C");
		const want = [...penDefaults];
		want[3] = "#0a0b0c";
		expect(settings.penPalette).toEqual(paletteSlots(want));
		expect(colorsFor("pen").map((c) => c.hex)).toEqual(want);
		expect(settings.highlighterPalette).toEqual(paletteSlots(highlighterDefaults));
		expect(saves).toHaveBeenCalled();
		expect(refreshes).toHaveBeenCalled();
	});

	it("an edit to the slot holding the selected colour moves the selected colour and saves it", () => {
		const { t, settings } = tab();
		setInkColorHex("highlighter", highlighterDefaults[2]);
		settings.inkColors.highlighter = highlighterDefaults[2]!;
		t.setPaletteSlot("highlighter", 2, "#aa0011");
		expect(getInkColorHex("highlighter")).toBe("#aa0011");
		expect(settings.inkColors.highlighter).toBe("#aa0011");
	});

	it("reset of one slot puts back that slot's default and leaves the others", () => {
		const { t, settings } = tab();
		t.setPaletteSlot("pen", 1, "#111111");
		t.setPaletteSlot("pen", 6, "#666666");
		t.setPaletteSlot("pen", 1, null);
		const want = [...penDefaults];
		want[6] = "#666666";
		expect(settings.penPalette).toEqual(paletteSlots(want));
		expect(colorsFor("pen").map((c) => c.hex)).toEqual(want);
	});

	it("reset of a tool puts back all of its slots and leaves the other tool's", () => {
		const { t, settings } = tab();
		t.setPaletteSlot("pen", 0, "#101010");
		t.setPaletteSlot("pen", 7, "#171717");
		t.setPaletteSlot("highlighter", 4, "#141414");
		t.resetPalette("pen");
		expect(settings.penPalette).toEqual(paletteSlots(penDefaults));
		expect(colorsFor("pen").map((c) => c.hex)).toEqual(penDefaults);
		expect(settings.highlighterPalette["4"]).toBe("#141414");
	});

	it("reset of a tool moves the selected colour only with the slot that held it, even when a later slot held the same colour", () => {
		const { t, settings } = tab();
		// Slot 0 holds the shipped blue and is selected; slot 3 is set to the same blue.
		setInkColorHex("pen", penDefaults[0]);
		settings.inkColors.pen = penDefaults[0]!;
		t.setPaletteSlot("pen", 3, penDefaults[0]!);
		t.resetPalette("pen");
		expect(getInkColorHex("pen")).toBe(penDefaults[0]);
		expect(settings.inkColors.pen).toBe(penDefaults[0]);
	});

	it("reset of a tool moves an edited selected colour to its own slot's default", () => {
		const { t, settings } = tab();
		t.setPaletteSlot("pen", 2, "#222222");
		setInkColorHex("pen", "#222222");
		settings.inkColors.pen = "#222222";
		// Slot 5 already holds slot 2's default, so a chained follow would carry the colour on to slot 5's default.
		t.setPaletteSlot("pen", 5, penDefaults[2]!);
		t.resetPalette("pen");
		expect(getInkColorHex("pen")).toBe(penDefaults[2]);
	});
});
