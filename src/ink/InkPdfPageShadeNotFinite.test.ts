/**
 * A page whose drawing math stops being a number: what its shade reads as.
 *
 * Every operand the reader takes is a finite number, but the products are not
 * bound: two `cm` of 10^300 make a matrix of Infinity, and a point of 10^300
 * under a matrix of 10^300 lands at Infinity less Infinity, which is no number.
 * A fill with such a point makes the work count no number, and no number is
 * never past the work cap, so the cap never trips again on that page. A fill
 * whose box lies past the page on one side paints nothing, whatever its other
 * side is. A page box wider than any number makes the sample step Infinity,
 * and a finite point less the box's edge over Infinity is no number. A stroke
 * with such a width makes the page's mean no number, and no number is never
 * under the dark line, so the page reads light.
 *
 * The rule these cells hold: a page whose matrix, a fill's box, the work count
 * or the mean is not a finite number reads unknown. Unknown is the safe side
 * (the copy writes the plain wash), and light is the one answer such a page
 * must never get.
 *
 * Counted, not timed. Each full-page triangle costs the reader one point test
 * per sample per edge: 64 x 64 samples x 3 edges = 12288. The work cap is
 * 4 000 000, so 325 such fills are under it and 326 are past it; the control
 * pair shows the reader counts exactly that.
 */

import { describe, expect, it } from "vitest";
import { pageShade } from "./InkPdfPageShade";
import { PdfDoc, pdfPages, readPdf } from "../pdf/PdfSyntax";
import { document, streamObject } from "../../test/pdf-fixture";

/** 10^300: a finite number the reader takes, whose square is not. */
const BIG = `1${"0".repeat(300)}`;

/** Work one full-page triangle costs: samples per side squared, times its edges. */
const TRIANGLE_WORK = 64 * 64 * 3;
const WORK_CAP = 4_000_000;

/** A black triangle over the whole 612 x 792 page box: its long edge runs past the box's far corner. */
const TRIANGLE = "0 0 m 1224 0 l 0 1584 l f";
const triangles = (n: number): string => Array.from({ length: n }, () => TRIANGLE).join("\n");

/**
 * A fill whose first point is no number: under [B B -B -B 0 0], the point (B, B) lands at B*B - B*B, Infinity less
 * Infinity, on both axes. The matrix itself is finite. Inside q/Q, so what follows is drawn as the page.
 */
const NO_NUMBER_FILL = `q ${BIG} ${BIG} -${BIG} -${BIG} 0 0 cm ${BIG} ${BIG} m 0 0 l 0 ${BIG} l f Q`;

/** Two finite `cm` whose product is Infinity: the matrix in force is not finite. Nothing drawn under it. */
const INFINITE_MATRIX = `q ${BIG} 0 0 ${BIG} 0 0 cm ${BIG} 0 0 ${BIG} 0 0 cm Q`;

/** 10^308: finite, and twice it is not. */
const EDGE = `1${"0".repeat(308)}`;

/**
 * A fill with a point that is no number and no `cm` at all: the rectangle's far corner x + w is Infinity, and under
 * the plain matrix Infinity times 0 is no number.
 */
const NO_NUMBER_RECT = `${EDGE} 0 ${EDGE} 10 re f`;

/** 10^200: its matrix stays finite, but a*d less b*c is 10^400 less 10^400, Infinity less Infinity. */
const HUGE = `1${"0".repeat(200)}`;

/** A black rectangle over the whole page box. */
const BLACK = "0 g 0 0 612 792 re f";

function read(src: string): PdfDoc {
	const doc = readPdf(src);
	if (!doc.ok) throw new Error(`does not read back: ${doc.reason}`);
	return doc.value;
}

/** Page 1 of a one-page document whose one content stream is `content`, under the media box `box`. */
function pageOf(content: string, box = "[0 0 612 792]"): { doc: PdfDoc; page: ReturnType<typeof pageOne> } {
	const doc = read(document(1, () => "/Contents 4 0 R ", "", [streamObject(content)], box));
	return { doc, page: pageOne(doc) };
}

function pageOne(doc: PdfDoc) {
	const pages = pdfPages(doc);
	if (!pages.ok) throw new Error(pages.reason);
	return pages.value[0]!;
}

/** The shade of that page. */
function shadeOf(content: string, box?: string): string {
	const { doc, page } = pageOf(content, box);
	return pageShade(doc, page);
}

describe("page shade: a page whose drawing math is not a finite number", () => {
	it("control: the work cap counts point tests, 325 full-page triangles are under it and read dark, 326 are past it and read unknown", () => {
		expect(TRIANGLE_WORK * 325, "premise: 325 triangles are under the cap").toBeLessThanOrEqual(WORK_CAP);
		expect(TRIANGLE_WORK * 326, "premise: 326 triangles are past the cap").toBeGreaterThan(WORK_CAP);
		expect(shadeOf(`0 g\n${triangles(325)}`)).toBe("dark");
		expect(shadeOf(`0 g\n${triangles(326)}`)).toBe("unknown");
	});

	it("control: a large matrix that stays finite is read as any other, a black page under it reads dark", () => {
		expect(shadeOf(`q ${BIG} 0 0 ${BIG} 0 0 cm 0 g 0 0 1 1 re f Q`)).toBe("dark");
	});

	it("a fill with a point that is no number, then 326 full-page triangles: reads unknown, as the triangles alone read, never dark", () => {
		expect(shadeOf(`0 g\n${triangles(326)}`), "premise: the same page without that fill is past the cap").toBe("unknown");
		expect(shadeOf(`0 g\n${NO_NUMBER_FILL}\n${triangles(326)}`)).toBe("unknown");
	});

	it("a fill with a point that is no number, on a page that is white otherwise: reads unknown, not light", () => {
		expect(shadeOf("1 g 0 0 612 792 re f"), "premise: a white page reads light").toBe("light");
		expect(shadeOf(`0 g\n${NO_NUMBER_FILL}`)).toBe("unknown");
	});

	it("a matrix that is not finite, then a black page: reads unknown", () => {
		expect(shadeOf(BLACK), "premise: the black page alone reads dark").toBe("dark");
		expect(shadeOf(`${INFINITE_MATRIX}\n${BLACK}`)).toBe("unknown");
	});

	it("a stroke whose width is no number, on a white page: the mean is no number, the page reads unknown, not light", () => {
		// Under [B B -B -B 0 0] the area scale a*d - b*c is Infinity less Infinity: the stroke's width is no number.
		expect(shadeOf(`0 G q ${BIG} ${BIG} -${BIG} -${BIG} 0 0 cm 0 0 m 1 0 l S Q`)).toBe("unknown");
	});

	it("a rectangle whose far corner is no number, with no cm, on a page that is white otherwise: reads unknown, not light", () => {
		expect(shadeOf("0 g"), "premise: a page with nothing drawn reads light").toBe("light");
		expect(shadeOf(`0 g\n${NO_NUMBER_RECT}`)).toBe("unknown");
	});

	// Held, not red before the fix: this rectangle lies past the page's right edge, so its fill paints nothing and
	// adds no work, and the triangles still meet the cap.
	it("a rectangle whose far corner is no number, with no cm, then 326 full-page triangles: reads unknown, as the triangles alone read", () => {
		expect(shadeOf(`0 g\n${triangles(326)}`), "premise: the same page without that rectangle is past the cap").toBe("unknown");
		expect(shadeOf(`0 g\n${NO_NUMBER_RECT}\n${triangles(326)}`)).toBe("unknown");
	});

	it("a black page, then a stroke whose width is no number under a finite matrix: reads unknown, never light", () => {
		expect(shadeOf(BLACK), "premise: the black page alone reads dark").toBe("dark");
		expect(shadeOf(`${BLACK}\nq ${HUGE} ${HUGE} ${HUGE} ${HUGE} 0 0 cm 0 0 m 1 0 l S Q`)).toBe("unknown");
	});

	it("a page box wider than any number, a black fill over all of it with finite points: reads unknown, not light", () => {
		// Every point and the fill's box are finite; the box's width is 2 x 10^308, Infinity, so the sample step is too.
		const blackOver = (e: string): [string, string] => [`0 g -${e} 0 m ${e} 0 l ${e} 792 l -${e} 792 l h f`, `[-${e} 0 ${e} 792]`];
		const near = `1${"0".repeat(307)}`;
		expect(pageOf(...blackOver(near)).page.box.w, "premise: at 10^307 the page box's width is finite").toBeLessThan(Infinity);
		expect(shadeOf(...blackOver(near)), "control: the same black fill over a page box of finite width reads dark").toBe("dark");
		expect(pageOf(...blackOver(EDGE)).page.box.w, "premise: at 10^308 the page box's width is not finite").toBe(Infinity);
		expect(shadeOf(...blackOver(EDGE))).toBe("unknown");
	});

	it("a page box wider than any number, a black five-sided fill over all of it with finite points: reads unknown, not light", () => {
		// Not one rectangle, so the fill is counted edge by edge: the other place the work is added.
		const blackOver = (e: string): [string, string] => [`0 g -${e} 0 m ${e} 0 l ${e} 792 l 0 800 l -${e} 792 l h f`, `[-${e} 0 ${e} 792]`];
		const near = `1${"0".repeat(307)}`;
		expect(shadeOf(...blackOver(near)), "control: the same black fill over a page box of finite width reads dark").toBe("dark");
		expect(shadeOf(...blackOver(EDGE))).toBe("unknown");
	});
});
