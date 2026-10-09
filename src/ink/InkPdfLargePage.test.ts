import { describe, expect, it } from "vitest";
import { InkStroke, computeBBox } from "./Stroke";
import { PX_TO_PT, inkPageBox, inkToPdf } from "./InkPdf";

/**
 * A tall note exported to PDF.
 *
 * Readers that follow the PDF 1.7 implementation limit (the page box at most 14400 units on a side in the default user space)
 * can clip or refuse a larger page. 14400 units is 19200 note pixels at the export's 0.75 scale. A note whose ink runs further
 * down is written as one page whose box is larger than that, with no UserUnit and no page split. Each cell parses the real
 * output: every page's box must stay within 14400 units, or the file must carry a UserUnit that brings the page back inside the
 * limit with the geometry unscaled.
 */

const LIMIT_UNITS = 14400;

function tallStroke(topY: number, bottomY: number): InkStroke {
	const points = [
		{ x: 20, y: topY, pressure: 0.5, t: 0 },
		{ x: 60, y: (topY + bottomY) / 2, pressure: 0.5, t: 8 },
		{ x: 40, y: bottomY, pressure: 0.5, t: 16 },
	];
	return {
		id: `tall-${topY}-${bottomY}`,
		tool: "pen",
		color: "#4b7bec",
		width: 4,
		points,
		bbox: computeBBox(points, 4),
		createdAt: 0,
	};
}

interface Parsed {
	boxes: Array<{ w: number; h: number }>;
	userUnit: number;
	hasUserUnit: boolean;
	pages: number;
	scale: number;
}

/** The page boxes, the UserUnit (default 1) and the page count, read from the output text. */
function parse(pdf: string): Parsed {
	const boxes = [...pdf.matchAll(/\/MediaBox \[\s*0 0 ([\d.]+) ([\d.]+)\s*\]/g)].map((m) => ({ w: Number(m[1]), h: Number(m[2]) }));
	const unit = /\/UserUnit ([\d.]+)/.exec(pdf);
	const count = /\/Type \/Pages [^>]*\/Count (\d+)/.exec(pdf);
	const scale = /q ([\d.]+) 0 0 ([\d.]+) 0 0 cm/.exec(pdf);
	return {
		boxes,
		userUnit: unit ? Number(unit[1]) : 1,
		hasUserUnit: unit !== null,
		pages: count ? Number(count[1]) : boxes.length,
		scale: scale ? Number(scale[1]) : NaN,
	};
}

describe("a tall note's PDF stays inside the page-size limit readers follow", () => {
	it("the harness holds: ink 4000 px tall writes one page at 0.75 scale, inside the limit", () => {
		const parsed = parse(inkToPdf([tallStroke(0, 4000)]));
		expect(parsed.pages).toBe(1);
		expect(parsed.boxes).toHaveLength(1);
		expect(parsed.boxes[0]!.h, "the box is the ink's height at 0.75 plus a margin").toBeGreaterThan(4000 * PX_TO_PT);
		expect(parsed.boxes[0]!.h).toBeLessThan(4100 * PX_TO_PT);
		expect(parsed.boxes[0]!.h).toBeLessThanOrEqual(LIMIT_UNITS);
	});

	it("the limit's edge: ink 19000 px tall still fits on one default-unit page", () => {
		const parsed = parse(inkToPdf([tallStroke(0, 19000)]));
		expect(parsed.boxes).toHaveLength(1);
		expect(parsed.boxes[0]!.h * parsed.userUnit).toBeLessThanOrEqual(LIMIT_UNITS + 100);
	});

	it("ink running 25000 px down is not written as one page taller than 14400 units", () => {
		const parsed = parse(inkToPdf([tallStroke(0, 25000)]));
		expect(parsed.boxes.length, "premise: the output has a parsable page box").toBeGreaterThan(0);
		for (const box of parsed.boxes) {
			expect(box.w, "page width").toBeLessThanOrEqual(LIMIT_UNITS);
			expect(box.h, `page height in default units (UserUnit ${parsed.userUnit}, ${parsed.pages} page)`).toBeLessThanOrEqual(LIMIT_UNITS);
		}
	});
});

function wideStroke(leftX: number, rightX: number): InkStroke {
	const points = [
		{ x: leftX, y: 20, pressure: 0.5, t: 0 },
		{ x: (leftX + rightX) / 2, y: 60, pressure: 0.5, t: 8 },
		{ x: rightX, y: 40, pressure: 0.5, t: 16 },
	];
	return {
		id: `wide-${leftX}-${rightX}`,
		tool: "pen",
		color: "#4b7bec",
		width: 4,
		points,
		bbox: computeBBox(points, 4),
		createdAt: 0,
	};
}

/** A tall stroke whose page, margin included, is exactly `pagePx` note pixels high. */
function strokeForPageHeight(pagePx: number): InkStroke {
	const probe = tallStroke(0, 19000);
	return tallStroke(0, 19000 + pagePx - inkPageBox([probe]).h);
}

describe("a note past the limit is one page with a UserUnit that brings it back inside", () => {
	const tall = [tallStroke(0, 25000)];

	it("writes one page, not a grid", () => {
		const parsed = parse(inkToPdf(tall));
		expect(parsed.pages).toBe(1);
		expect(parsed.boxes).toHaveLength(1);
	});

	it("the page carries a UserUnit of 2 for ink 25000 px tall (18774 units needs 2)", () => {
		const parsed = parse(inkToPdf(tall));
		expect(parsed.hasUserUnit).toBe(true);
		expect(parsed.userUnit).toBe(2);
	});

	it("the page box times the UserUnit is the ink's size", () => {
		const parsed = parse(inkToPdf(tall));
		const ink = inkPageBox(tall);
		expect(parsed.boxes[0]!.h * parsed.userUnit).toBeCloseTo(ink.h * PX_TO_PT, 0);
		expect(parsed.boxes[0]!.w * parsed.userUnit).toBeCloseTo(ink.w * PX_TO_PT, 0);
		expect(parsed.boxes[0]!.h, "inside the limit").toBeLessThanOrEqual(LIMIT_UNITS);
	});

	it("the content scale is the px-to-point scale divided by the UserUnit", () => {
		const parsed = parse(inkToPdf(tall));
		expect(parsed.userUnit, "premise: this note needs a UserUnit").toBe(2);
		expect(parsed.scale).toBeCloseTo(PX_TO_PT / parsed.userUnit, 6);
	});

	it("a wide note gets the same treatment: one page, UserUnit 2, box times 2 is the ink's width", () => {
		const wide = [wideStroke(0, 25000)];
		const parsed = parse(inkToPdf(wide));
		expect(parsed.pages).toBe(1);
		expect(parsed.userUnit).toBe(2);
		expect(parsed.boxes[0]!.w).toBeLessThanOrEqual(LIMIT_UNITS);
		expect(parsed.boxes[0]!.w * parsed.userUnit).toBeCloseTo(inkPageBox(wide).w * PX_TO_PT, 0);
		expect(parsed.scale).toBeCloseTo(PX_TO_PT / 2, 6);
	});

	it("ink 45000 px tall needs a UserUnit of 3 (33759 units; 2 would leave 16879)", () => {
		const parsed = parse(inkToPdf([tallStroke(0, 45000)]));
		expect(parsed.userUnit).toBe(3);
		expect(parsed.boxes[0]!.h).toBeLessThanOrEqual(LIMIT_UNITS);
		expect(parsed.scale).toBeCloseTo(PX_TO_PT / 3, 6);
	});

	it("the longer side decides: a note wide at 25000 and tall at 45000 takes 3", () => {
		const parsed = parse(inkToPdf([wideStroke(0, 25000), tallStroke(0, 45000)]));
		expect(parsed.userUnit).toBe(3);
		expect(parsed.boxes[0]!.w).toBeLessThanOrEqual(LIMIT_UNITS);
		expect(parsed.boxes[0]!.h).toBeLessThanOrEqual(LIMIT_UNITS);
	});

	it("one pixel past the limit already takes a UserUnit of 2", () => {
		const stroke = strokeForPageHeight(19201);
		expect(inkPageBox([stroke]).h, "premise: the page is 19201 px").toBe(19201);
		expect(parse(inkToPdf([stroke])).userUnit).toBe(2);
	});

	it("control: a page of exactly 19200 px (14400 units) has no UserUnit key and the default scale", () => {
		const stroke = strokeForPageHeight(19200);
		expect(inkPageBox([stroke]).h, "premise: the page is 19200 px").toBe(19200);
		const out = inkToPdf([stroke]);
		const parsed = parse(out);
		expect(parsed.hasUserUnit).toBe(false);
		expect(out).not.toContain("UserUnit");
		expect(parsed.boxes[0]!.h).toBe(LIMIT_UNITS);
		expect(parsed.scale).toBe(PX_TO_PT);
	});
});
