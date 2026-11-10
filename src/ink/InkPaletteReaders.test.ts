import { afterEach, describe, expect, it } from "vitest";
import { gatedGeneratedCommands, inkColorNames } from "../CommandPaletteSplit";
import { MobileTools } from "../inline/MobileTools";
import "../inline/MobileToolsPaint";
import { FakeDoc, FakeEl } from "../testUtils/fakeDom";
import {
	HIGHLIGHTER_COLORS,
	PEN_COLORS,
	colorsFor,
	setInkColorHex,
	setInkPalette,
	setInkPaletteSlot,
} from "./InkColor";
import { colorNameFor } from "./InkPresets";
import { inkColorFor } from "./InkTheme";
import { InkStroke } from "./Stroke";
import { StrokeBuilder } from "./StrokeBuilder";
import { inkToSvg } from "./SvgExport";
import { INK_SIZE_STEPS } from "./InkSize";

// Every reader of a palette slot, with slots edited (1.5.0). Hotkeys keep
// their ids; labels, swatches and names read the live slot; saved ink and its
// exports never change.

afterEach(() => {
	setInkPalette("pen", PEN_COLORS.map((c) => c.hex));
	setInkPalette("highlighter", HIGHLIGHTER_COLORS.map((c) => c.hex));
	setInkColorHex("pen", PEN_COLORS[0]!.hex);
	setInkColorHex("highlighter", HIGHLIGHTER_COLORS[0]!.hex);
});

describe("hotkey commands under an edited slot", () => {
	const defaultIds = (): string[] => [
		...INK_SIZE_STEPS.map((s) => `ink-size-${s.name}`),
		...[...new Set([...PEN_COLORS, ...HIGHLIGHTER_COLORS].map((c) => c.name))].map((n) => `ink-color-${n}`),
		...HIGHLIGHTER_COLORS.map((c) => `highlighter-color-${c.name}`),
	];

	it("every command id stays the default name's id when slots are edited", () => {
		setInkPaletteSlot("pen", 4, "#aa0011");
		setInkPaletteSlot("highlighter", 1, "#0000ff");
		expect(gatedGeneratedCommands().map((c) => c.id)).toEqual(defaultIds());
		expect(inkColorNames()).toEqual([...new Set([...PEN_COLORS, ...HIGHLIGHTER_COLORS].map((c) => c.name))]);
	});

	it("a command's label shows the slot's colour: the name while default, the hex once edited", () => {
		setInkPaletteSlot("pen", 4, "#aa0011");
		setInkPaletteSlot("highlighter", 1, "#0000ff");
		const byId = new Map(gatedGeneratedCommands().map((c) => [c.id, c.name]));
		expect(byId.get("ink-color-red")).toBe("Ink color: #aa0011");
		expect(byId.get("ink-color-blue")).toBe("Ink color: blue");
		expect(byId.get("highlighter-color-green")).toBe("Highlighter color: #0000ff");
		expect(byId.get("highlighter-color-pink")).toBe("Highlighter color: pink");
	});
});

describe("colour names for presets", () => {
	it("a default colour keeps its name; a colour that is no default is named by its hex", () => {
		setInkPaletteSlot("pen", 4, "#aa0011");
		expect(colorNameFor("pen", PEN_COLORS[4]!.hex)).toBe("red");
		expect(colorNameFor("pen", "#aa0011")).toBe("#aa0011");
	});
});

describe("the strip's swatches", () => {
	const paint = (tool: "pen" | "highlighter", current: string): FakeEl[] => {
		const doc = new FakeDoc();
		const row = new FakeEl("div", doc);
		const strip = {
			host: { toolColor: () => current, paletteFor: (t: "pen" | "highlighter") => colorsFor(t), pickColor: () => {} },
			refresh: () => {},
		};
		(MobileTools.prototype as unknown as { paintSwatches: (s: unknown) => void }).paintSwatches.call(strip, {
			colors: row,
			tool,
		});
		return row.children;
	};

	it("paint the live colour of every slot, in slot order", () => {
		setInkPaletteSlot("pen", 2, "#0a0b0c");
		const sw = paint("pen", PEN_COLORS[0]!.hex);
		expect(sw.map((s) => s.style.backgroundColor)).toEqual(colorsFor("pen").map((c) => c.hex));
		expect(sw[2]!.style.backgroundColor).toBe("#0a0b0c");
	});

	it("name an edited slot by its default name with the hex added", () => {
		setInkPaletteSlot("pen", 2, "#0a0b0c");
		const sw = paint("pen", PEN_COLORS[0]!.hex);
		expect(sw[2]!.getAttribute("aria-label")).toBe("graphite #0a0b0c");
		expect(sw[1]!.getAttribute("aria-label")).toBe("black");
	});

	it("mark only the first of two slots holding the current colour", () => {
		setInkPaletteSlot("highlighter", 3, HIGHLIGHTER_COLORS[0]!.hex);
		const sw = paint("highlighter", HIGHLIGHTER_COLORS[0]!.hex);
		expect(sw.map((s) => s.classes.has("is-current"))).toEqual([true, false, false, false, false]);
	});
});

describe("saved ink never changes how it looks", () => {
	const stroke = (color: string): InkStroke => {
		const b = new StrokeBuilder("pen", color, 2.2);
		b.start(0);
		b.add(0, 0, 0.5, 0, 0, 0);
		b.add(50, 0, 0.5, 8, 0, 0);
		return b.finish()!;
	};

	it("a stroke drawn in a slot's colour paints and exports the same after that slot is edited", () => {
		const s = stroke(PEN_COLORS[4]!.hex);
		const paintBefore = inkColorFor(s);
		const svgBefore = inkToSvg([s]);
		setInkPaletteSlot("pen", 4, "#aa0011");
		expect(inkColorFor(s)).toBe(paintBefore);
		expect(inkToSvg([s])).toBe(svgBefore);
	});

	it("a stroke with a broken colour exports in the default slot 0 colour, not the user's edit of slot 0", () => {
		const s = { ...stroke(PEN_COLORS[0]!.hex), color: "tomato" } as InkStroke;
		const svgBefore = inkToSvg([s]);
		setInkPaletteSlot("pen", 0, "#abcdef");
		expect(inkToSvg([s])).toBe(svgBefore);
		expect(svgBefore).not.toContain("#abcdef");
	});
});
