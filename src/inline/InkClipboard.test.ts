import { beforeEach, describe, expect, it } from "vitest";
import { computeBBox } from "../ink/Stroke";
import {
	clearInkClipboard,
	clipboardSize,
	copyInk,
	inkClipboardMarker,
	markerIsCurrent,
	markerToken,
	pasteInk,
} from "./InkClipboard";

function stroke(id: string, x: number) {
	const points = [
		{ x, y: 10, pressure: 0.5, t: 0 },
		{ x: x + 20, y: 30, pressure: 0.5, t: 8 },
	];
	return {
		id,
		tool: "pen" as const,
		color: "#4b7bec",
		width: 4,
		points,
		bbox: computeBBox(points, 2),
		createdAt: 0,
	};
}

describe("ink clipboard", () => {
	beforeEach(clearInkClipboard);

	it("copies deep and pastes fresh individuals", () => {
		const src = stroke("a", 100);
		expect(copyInk([src], "one.md")).toBe(1);
		const out = pasteInk("two.md");
		expect(out.length).toBe(1);
		expect(out[0]!.id).not.toBe("a");
		// Deep: mutating the paste never reaches the held copy.
		out[0]!.points[0]!.x = 999;
		expect(pasteInk("two.md")[0]!.points[0]!.x).toBe(100);
	});

	it("cross-note pastes keep their coordinates (fixed grid)", () => {
		copyInk([stroke("a", 100)], "one.md");
		expect(pasteInk("two.md")[0]!.points[0]!.x).toBe(100);
	});

	it("pastes into the source note stagger, and keep staggering", () => {
		copyInk([stroke("a", 100)], "one.md");
		expect(pasteInk("one.md")[0]!.points[0]!.x).toBe(116);
		expect(pasteInk("one.md")[0]!.points[0]!.x).toBe(132);
		expect(pasteInk("one.md")[0]!.bbox.x).toBeGreaterThan(100);
	});

	it("two pastes are two distinct individuals", () => {
		copyInk([stroke("a", 100)], "one.md");
		expect(pasteInk("two.md")[0]!.id).not.toBe(pasteInk("two.md")[0]!.id);
	});

	it("empty clipboard pastes nothing", () => {
		expect(pasteInk("one.md")).toEqual([]);
		expect(clipboardSize()).toBe(0);
	});
});

describe("clipboard marker", () => {
	beforeEach(() => clearInkClipboard());

	it("no marker while the clipboard is empty", () => {
		expect(inkClipboardMarker()).toBeNull();
	});

	it("a copy mints a marker that names its own ink", () => {
		copyInk([stroke("s1", 0), stroke("s2", 40)], "a.md");
		const marker = inkClipboardMarker()!;
		expect(marker.startsWith("handwriting-ink/v1 ")).toBe(true);
		expect(marker).toContain("(2 strokes)");
		expect(markerToken(marker)).not.toBeNull();
		expect(markerIsCurrent(marker)).toBe(true);
	});

	it("one stroke reads as one stroke", () => {
		copyInk([stroke("s1", 0)], "a.md");
		expect(inkClipboardMarker()).toContain("(1 stroke)");
	});

	it("ordinary text is never mistaken for a marker", () => {
		copyInk([stroke("s1", 0)], "a.md");
		for (const text of ["", "hello", "handwriting ink", "  notes about handwriting-ink/v1  "]) {
			expect(markerToken(text)).toBeNull();
			expect(markerIsCurrent(text)).toBe(false);
		}
	});

	it("surrounding whitespace survives a clipboard round trip", () => {
		copyInk([stroke("s1", 0)], "a.md");
		const marker = inkClipboardMarker()!;
		expect(markerIsCurrent(`
${marker}
`)).toBe(true);
	});

	it("a marker from a previous copy stops being current", () => {
		copyInk([stroke("s1", 0)], "a.md");
		const stale = inkClipboardMarker()!;
		copyInk([stroke("s2", 40)], "b.md");
		expect(markerToken(stale)).not.toBeNull(); // still recognized as ours
		expect(markerIsCurrent(stale)).toBe(false); // but not what we hold
		expect(markerIsCurrent(inkClipboardMarker()!)).toBe(true);
	});

	it("a marker outliving its ink is recognized and refused", () => {
		copyInk([stroke("s1", 0)], "a.md");
		const marker = inkClipboardMarker()!;
		clearInkClipboard(); // app restart: module state gone, marker still in a clipboard manager
		expect(markerToken(marker)).not.toBeNull();
		expect(markerIsCurrent(marker)).toBe(false);
	});
});
