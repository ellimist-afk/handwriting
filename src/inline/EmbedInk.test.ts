import { describe, expect, it } from "vitest";
import { embedInkExtent, embedInkMarker } from "./EmbedInk";
import { InkStroke } from "../ink/Stroke";

function strokeWithBBox(x: number, y: number, width: number, height: number): InkStroke {
	return {
		id: "s",
		tool: "pen",
		color: "#000000",
		width: 2,
		points: [],
		bbox: { x, y, width, height },
	} as unknown as InkStroke;
}

describe("embedInkExtent", () => {
	it("covers the farthest stroke corner, rounded up", () => {
		const { w, h } = embedInkExtent([
			strokeWithBBox(10, 20, 30.2, 5),
			strokeWithBBox(0, 90.5, 5, 5.4),
		]);
		expect(w).toBe(41);
		expect(h).toBe(96);
	});

	it("caps at 2048 on a side", () => {
		const { w, h } = embedInkExtent([strokeWithBBox(0, 0, 90000, 90000)]);
		expect(w).toBe(2048);
		expect(h).toBe(2048);
	});

	it("empty input has zero extent", () => {
		expect(embedInkExtent([])).toEqual({ w: 0, h: 0 });
	});
});

describe("embedInkMarker", () => {
	it("a moved revision changes the marker; a stable one does not", () => {
		expect(embedInkMarker("a.md", 0)).toBe(embedInkMarker("a.md", 0));
		expect(embedInkMarker("a.md", 1)).not.toBe(embedInkMarker("a.md", 0));
		expect(embedInkMarker("b.md", 0)).not.toBe(embedInkMarker("a.md", 0));
	});
});
