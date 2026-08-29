import { describe, expect, it } from "vitest";
import { embedInkExtent, embedInkMarker, embedInkNeedsPaint, embedInkScale } from "./EmbedInk";
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

	it("never clips, however far down the page the ink goes", () => {
		// The 2048-per-side cap this replaces did not bound cost - two capped
		// sides still buy 4.2M pixels - and it silently dropped every stroke
		// below the line on a long note, in reading view and in anything
		// printed from it.
		const { w, h } = embedInkExtent([strokeWithBBox(0, 0, 900, 9000)]);
		expect(w).toBe(900);
		expect(h).toBe(9000);
	});

	it("empty input has zero extent", () => {
		expect(embedInkExtent([])).toEqual({ w: 0, h: 0 });
	});
});

describe("embedInkScale", () => {
	it("renders at the display's resolution when it fits", () => {
		expect(embedInkScale(800, 1000, 2)).toBe(2);
		expect(embedInkScale(800, 1000, 1)).toBe(1);
	});

	it("never renders below the css size", () => {
		expect(embedInkScale(800, 1000, 0.5)).toBe(1);
	});

	it("spends resolution, not strokes, when the page is enormous", () => {
		// Never clips. A page can hold as much ink as someone wants to draw;
		// what gives way under an enormous one is sharpness, not content.
		const scale = embedInkScale(2000, 20000, 3);
		expect(scale).toBeLessThan(1);
		expect(2000 * 20000 * scale * scale).toBeLessThanOrEqual(4_000_000 + 1);
	});

	it("has nothing to say about an empty layer", () => {
		expect(embedInkScale(0, 0, 2)).toBe(1);
	});
});

describe("embedInkMarker", () => {
	it("a moved revision changes the marker; a stable one does not", () => {
		expect(embedInkMarker("a.md", 0)).toBe(embedInkMarker("a.md", 0));
		expect(embedInkMarker("a.md", 1)).not.toBe(embedInkMarker("a.md", 0));
		expect(embedInkMarker("b.md", 0)).not.toBe(embedInkMarker("a.md", 0));
	});
});

describe("embedInkNeedsPaint (reading view drops the canvas, keeps the marker)", () => {
	const marker = embedInkMarker("note.md", 3);

	it("repaints when the canvas is gone even though the marker matches", () => {
		// The reported bug: reading view re-renders sections while keeping
		// the sizer, so the canvas disappears and the attribute survives. A
		// marker-only check called that up to date and drew nothing.
		expect(embedInkNeedsPaint(marker, marker, false)).toBe(true);
	});

	it("stands down when the marker matches and the canvas is still there", () => {
		expect(embedInkNeedsPaint(marker, marker, true)).toBe(false);
	});

	it("repaints when the revision moved", () => {
		expect(embedInkNeedsPaint(embedInkMarker("note.md", 2), marker, true)).toBe(true);
	});

	it("paints a root that has never been marked", () => {
		expect(embedInkNeedsPaint(null, marker, false)).toBe(true);
	});
});
