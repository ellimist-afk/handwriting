import { beforeEach, describe, expect, it } from "vitest";
import { computeBBox } from "../ink/Stroke";
import { clearInkClipboard, clipboardSize, copyInk, pasteInk } from "./InkClipboard";

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
