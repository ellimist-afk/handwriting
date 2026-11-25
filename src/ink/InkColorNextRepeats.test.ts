/**
 * "Ink color: next" steps through every palette slot in order, repeats included.
 *
 * A slot may be set to a colour another slot already has. The cycle used to find the current slot by colour and take
 * the first match, so with two copies it went round only the slots up to the second copy and then jumped back to the
 * slot after the first; slots after the second copy were never reached, and two copies side by side stopped it for
 * good. The commands feed the colour `next` gave back in, as here.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	HIGHLIGHTER_COLORS,
	PEN_COLORS,
	colorsFor,
	nextInkColor,
	setInkColorHex,
	setInkPalette,
	setInkPaletteSlot,
} from "./InkColor";

const penDefaults = PEN_COLORS.map((c) => c.hex);
const highlighterDefaults = HIGHLIGHTER_COLORS.map((c) => c.hex);

afterEach(() => {
	setInkPalette("pen", penDefaults);
	setInkPalette("highlighter", highlighterDefaults);
	setInkColorHex("pen", PEN_COLORS[0]!.hex);
	setInkColorHex("highlighter", HIGHLIGHTER_COLORS[0]!.hex);
});

/** `count` presses of next from `from`, each fed the colour the last one gave, as the commands do. */
function presses(tool: "pen" | "highlighter", from: string, count: number): string[] {
	const seen: string[] = [];
	let hex = from;
	for (let i = 0; i < count; i++) {
		hex = nextInkColor(tool, hex).hex;
		seen.push(hex);
	}
	return seen;
}

describe("Ink color: next with a colour in two slots", () => {
	it("reaches every slot in order when a later slot repeats an earlier one", () => {
		setInkPaletteSlot("pen", 5, PEN_COLORS[1]!.hex); // orange set to black, slot 1's colour
		const palette = colorsFor("pen").map((c) => c.hex);
		expect(palette[5], "premise: slot 5 repeats slot 1").toBe(palette[1]);
		expect(presses("pen", palette[0]!, 8)).toEqual([...palette.slice(1), palette[0]]);
	});

	it("does not stop on a colour held by two neighbouring slots", () => {
		setInkPalette("highlighter", ["#111111", "#222222", "#222222", "#333333", "#444444"]);
		expect(presses("highlighter", "#111111", 5)).toEqual(["#222222", "#222222", "#333333", "#444444", "#111111"]);
	});

	// Guards, green before and after: the cycle follows the colour in hand, not a slot it stepped to before.
	it("goes on from the colour chosen by hand after landing on a repeat", () => {
		setInkPaletteSlot("pen", 5, PEN_COLORS[1]!.hex);
		const palette = colorsFor("pen").map((c) => c.hex);
		expect(nextInkColor("pen", palette[4]!).hex).toBe(palette[5]);
		expect(nextInkColor("pen", palette[3]!).hex, "white, chosen by hand, goes on to red").toBe(palette[4]);
	});

	it("goes on from the colour's first slot once the palette no longer repeats it", () => {
		setInkPaletteSlot("pen", 5, PEN_COLORS[1]!.hex);
		const palette = colorsFor("pen").map((c) => c.hex);
		expect(nextInkColor("pen", palette[4]!).hex).toBe(palette[5]);
		setInkPalette("pen", penDefaults);
		expect(nextInkColor("pen", PEN_COLORS[1]!.hex).hex).toBe(PEN_COLORS[2]!.hex);
	});

	// Not a guard: the pen's place on its second black is lost today, as in the first case.
	it("keeps each tool's place apart", () => {
		setInkPaletteSlot("pen", 5, PEN_COLORS[1]!.hex);
		const palette = colorsFor("pen").map((c) => c.hex);
		expect(nextInkColor("pen", palette[4]!).hex).toBe(palette[5]);
		setInkPalette("highlighter", ["#111111", PEN_COLORS[1]!.hex, "#333333", "#444444", "#555555"]);
		expect(nextInkColor("highlighter", PEN_COLORS[1]!.hex).hex).toBe("#333333");
		expect(nextInkColor("pen", palette[5]!).hex, "the pen still goes on from its slot 5").toBe(palette[6]);
	});
});
