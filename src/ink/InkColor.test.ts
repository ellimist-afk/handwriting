import { afterEach, describe, expect, it } from "vitest";
import {
	HIGHLIGHTER_COLORS,
	PEN_COLORS,
	colorsFor,
	getInkColorHex,
	nextInkColor,
	normalizeInkColor,
	setInkColorHex,
} from "./InkColor";
import { DEFAULT_PEN, HIGHLIGHTER_PEN } from "./PenStyle";
import { StrokeBuilder } from "./StrokeBuilder";

describe("ink color palettes", () => {
	it("every entry is a six-digit hex color with a name", () => {
		for (const c of [...PEN_COLORS, ...HIGHLIGHTER_COLORS]) {
			expect(c.hex).toMatch(/^#[0-9a-f]{6}$/i);
			expect(c.name.length).toBeGreaterThan(0);
		}
	});

	it("defaults are the original Handwriting colors — old and new strokes agree", () => {
		expect(PEN_COLORS[0]!.hex).toBe(DEFAULT_PEN.color);
		expect(HIGHLIGHTER_COLORS[0]!.hex).toBe(HIGHLIGHTER_PEN.color);
	});
});

describe("normalizeInkColor — persisted values stay sane", () => {
	it("keeps any valid hex (future-proof for custom colors)", () => {
		expect(normalizeInkColor("pen", "#A1B2C3")).toBe("#a1b2c3");
	});

	it("falls back to the tool default on garbage", () => {
		expect(normalizeInkColor("pen", "tomato")).toBe(PEN_COLORS[0]!.hex);
		expect(normalizeInkColor("highlighter", 42)).toBe(HIGHLIGHTER_COLORS[0]!.hex);
		expect(normalizeInkColor("pen", undefined)).toBe(PEN_COLORS[0]!.hex);
	});
});

describe("nextInkColor — cycling", () => {
	it("cycles the pen palette in order and wraps", () => {
		let hex = PEN_COLORS[0]!.hex;
		const seen: string[] = [];
		for (let i = 0; i < PEN_COLORS.length; i++) {
			const n = nextInkColor("pen", hex);
			seen.push(n.name);
			hex = n.hex;
		}
		expect(seen[seen.length - 1]).toBe(PEN_COLORS[0]!.name); // wrapped home
		expect(new Set(seen).size).toBe(PEN_COLORS.length); // visited every entry
	});

	it("an off-palette current value restarts the cycle", () => {
		expect(nextInkColor("highlighter", "#123456").name).toBe(HIGHLIGHTER_COLORS[0]!.name);
	});
});

describe("per-tool selection state", () => {
	afterEach(() => {
		setInkColorHex("pen", PEN_COLORS[0]!.hex);
		setInkColorHex("highlighter", HIGHLIGHTER_COLORS[0]!.hex);
	});

	it("pen and highlighter remember their colors independently", () => {
		setInkColorHex("pen", "#e5484d");
		setInkColorHex("highlighter", "#ff6b9d");
		expect(getInkColorHex("pen")).toBe("#e5484d");
		expect(getInkColorHex("highlighter")).toBe("#ff6b9d");
	});

	it("a stroke binds the selected color at start; later changes never recolor it", () => {
		setInkColorHex("pen", "#46a758");
		const a = new StrokeBuilder("pen", getInkColorHex("pen"), 2.2);
		a.start(0);
		a.add(0, 0, 0.5, 0, 0, 0);
		a.add(50, 0, 0.5, 8, 0, 0);
		// User switches color mid-session…
		setInkColorHex("pen", "#8e4ec6");
		const strokeA = a.finish()!;
		// …the in-flight/finished stroke keeps the color it was born with.
		expect(strokeA.color).toBe("#46a758");
		const b = new StrokeBuilder("pen", getInkColorHex("pen"), 2.2);
		b.start(10);
		b.add(0, 10, 0.5, 10, 0, 0);
		b.add(50, 10, 0.5, 18, 0, 0);
		expect(b.finish()!.color).toBe("#8e4ec6");
		expect(strokeA.color).toBe("#46a758"); // still untouched
	});

	it("colorsFor routes to the right palette", () => {
		expect(colorsFor("pen")).toBe(PEN_COLORS);
		expect(colorsFor("highlighter")).toBe(HIGHLIGHTER_COLORS);
	});
});
