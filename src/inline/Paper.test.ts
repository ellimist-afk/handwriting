import { describe, expect, it } from "vitest";
import { nextPaperStyle, normalizePaperStyle, paperClass } from "./Paper";

describe("paper style", () => {
	it("cycles none -> lines -> grid -> dots -> none", () => {
		expect(nextPaperStyle("none")).toBe("lines");
		expect(nextPaperStyle("lines")).toBe("grid");
		expect(nextPaperStyle("grid")).toBe("dots");
		expect(nextPaperStyle("dots")).toBe("none");
	});
	it("classes: one per ruled style, none for none", () => {
		expect(paperClass("none")).toBeNull();
		expect(paperClass("lines")).toBe("handwriting-paper-lines");
		expect(paperClass("grid")).toBe("handwriting-paper-grid");
		expect(paperClass("dots")).toBe("handwriting-paper-dots");
	});
	it("normalizes junk to none", () => {
		expect(normalizePaperStyle("grid")).toBe("grid");
		expect(normalizePaperStyle("dots")).toBe("dots");
		expect(normalizePaperStyle("sepia")).toBe("none");
		expect(normalizePaperStyle(undefined)).toBe("none");
	});
});
