import { afterEach, describe, expect, it } from "vitest";
import {
	HIGHLIGHTER_COLORS,
	PEN_COLORS,
	colorsFor,
	getInkColorHex,
	inkColorLabel,
	inkColorTitle,
	nextInkColor,
	normalizeInkColor,
	normalizeInkPalette,
	setInkColorHex,
	setInkPalette,
	setInkPaletteSlot,
} from "./InkColor";

// Every pen and highlighter slot is the user's to change (1.5.0). The defaults
// stay as constants; the live palette is pushed in from settings the way the
// selected colour is, and every reader of a slot reads the live one.

const penDefaults = PEN_COLORS.map((c) => c.hex);
const highlighterDefaults = HIGHLIGHTER_COLORS.map((c) => c.hex);

afterEach(() => {
	setInkPalette("pen", penDefaults);
	setInkPalette("highlighter", highlighterDefaults);
	setInkColorHex("pen", PEN_COLORS[0]!.hex);
	setInkColorHex("highlighter", HIGHLIGHTER_COLORS[0]!.hex);
});

describe("normalizeInkPalette: a stored palette is read slot by slot", () => {
	it("a bad slot loads that slot's default and the other slots keep theirs", () => {
		const stored = [...penDefaults];
		stored[1] = "#123456";
		stored[2] = 42 as unknown as string;
		stored[4] = "#12";
		stored[6] = "red";
		const got = normalizeInkPalette("pen", stored);
		expect(got).toEqual([
			penDefaults[0],
			"#123456",
			penDefaults[2],
			penDefaults[3],
			penDefaults[4],
			penDefaults[5],
			penDefaults[6],
			penDefaults[7],
		]);
	});

	it("reads the slot map form the same way, keyed by slot number", () => {
		expect(normalizeInkPalette("highlighter", { "0": "#ABCDEF", "3": "nope", "9": "#000000" })).toEqual([
			"#abcdef",
			highlighterDefaults[1],
			highlighterDefaults[2],
			highlighterDefaults[3],
			highlighterDefaults[4],
		]);
	});

	it("a palette of the wrong length comes back with 8 pen slots and 5 highlighter slots", () => {
		expect(normalizeInkPalette("pen", penDefaults.slice(0, 7))).toEqual(penDefaults);
		expect(normalizeInkPalette("pen", [...penDefaults, "#111111"])).toEqual(penDefaults);
		expect(normalizeInkPalette("highlighter", highlighterDefaults.slice(0, 4))).toEqual(highlighterDefaults);
		expect(normalizeInkPalette("highlighter", [...highlighterDefaults, "#111111"])).toEqual(highlighterDefaults);
	});

	it("anything that is not a palette at all gives the defaults", () => {
		for (const junk of [undefined, null, "#123456", 7, true]) {
			expect(normalizeInkPalette("pen", junk)).toEqual(penDefaults);
		}
	});
});

describe("the live palette", () => {
	it("colorsFor returns the stored hex in slot order and each slot keeps its default name", () => {
		setInkPaletteSlot("pen", 3, "#0a0b0c");
		const live = colorsFor("pen");
		expect(live.map((c) => c.hex)).toEqual([...penDefaults.slice(0, 3), "#0a0b0c", ...penDefaults.slice(4)]);
		expect(live.map((c) => c.name)).toEqual(PEN_COLORS.map((c) => c.name));
	});

	it("an edit to one tool's palette leaves the other tool's alone", () => {
		setInkPaletteSlot("pen", 0, "#010203");
		expect(colorsFor("highlighter").map((c) => c.hex)).toEqual(highlighterDefaults);
	});

	it("the cycle walks a customised palette in slot order and wraps", () => {
		setInkPalette("pen", ["#000001", "#000002", "#000003", "#000004", "#000005", "#000006", "#000007", "#000008"]);
		let hex = "#000001";
		const seen: string[] = [];
		for (let i = 0; i < 8; i++) {
			hex = nextInkColor("pen", hex).hex;
			seen.push(hex);
		}
		expect(seen).toEqual(["#000002", "#000003", "#000004", "#000005", "#000006", "#000007", "#000008", "#000001"]);
	});

	it("an off-palette current colour restarts the cycle at the live slot 0", () => {
		setInkPaletteSlot("highlighter", 0, "#fafafa");
		expect(nextInkColor("highlighter", "#123456").hex).toBe("#fafafa");
	});

	it("two slots may hold the same colour; the cycle steps on from the first of them and still ends", () => {
		const dup = ["#111111", "#222222", "#111111", "#333333", "#444444"];
		setInkPalette("highlighter", dup);
		expect(nextInkColor("highlighter", "#111111").hex).toBe("#222222");
		let hex = "#222222";
		const seen = new Set<string>();
		for (let i = 0; i < 10; i++) {
			hex = nextInkColor("highlighter", hex).hex;
			seen.add(hex);
		}
		expect(seen).toEqual(new Set(["#111111", "#222222"]));
	});
});

describe("the fallback colour", () => {
	it("a bad saved stroke colour falls back to the DEFAULT slot 0, never the user's edit of it", () => {
		setInkPaletteSlot("pen", 0, "#abcdef");
		setInkPaletteSlot("highlighter", 0, "#fedcba");
		expect(normalizeInkColor("pen", "tomato")).toBe(PEN_COLORS[0]!.hex);
		expect(normalizeInkColor("highlighter", undefined)).toBe(HIGHLIGHTER_COLORS[0]!.hex);
	});

	it("a bad selected colour falls back to the live slot 0", () => {
		setInkPaletteSlot("pen", 0, "#abcdef");
		expect(setInkColorHex("pen", "tomato")).toBe("#abcdef");
		expect(getInkColorHex("pen")).toBe("#abcdef");
	});
});

describe("the selected colour and a slot edit", () => {
	it("the selected colour follows its slot when that slot is edited", () => {
		setInkColorHex("pen", PEN_COLORS[4]!.hex);
		setInkPaletteSlot("pen", 4, "#aa0011");
		expect(getInkColorHex("pen")).toBe("#aa0011");
	});

	it("the selected colour stays put when another slot is edited", () => {
		setInkColorHex("pen", PEN_COLORS[4]!.hex);
		setInkPaletteSlot("pen", 5, "#aa0011");
		expect(getInkColorHex("pen")).toBe(PEN_COLORS[4]!.hex);
	});

	it("an off-palette selected colour stays put through any slot edit", () => {
		setInkColorHex("highlighter", "#123456");
		setInkPaletteSlot("highlighter", 0, "#aa0011");
		expect(getInkColorHex("highlighter")).toBe("#123456");
	});
});

describe("slot names", () => {
	it("a slot shows its default name while it holds its default colour, else its hex", () => {
		expect(inkColorLabel("pen", 4)).toBe("red");
		setInkPaletteSlot("pen", 4, "#aa0011");
		expect(inkColorLabel("pen", 4)).toBe("#aa0011");
		setInkPaletteSlot("pen", 4, PEN_COLORS[4]!.hex);
		expect(inkColorLabel("pen", 4)).toBe("red");
	});

	it("a slot's tooltip keeps its default name and adds the hex when the colour is custom", () => {
		expect(inkColorTitle("highlighter", 2)).toBe("pink");
		setInkPaletteSlot("highlighter", 2, "#aa0011");
		expect(inkColorTitle("highlighter", 2)).toBe("pink #aa0011");
	});
});
