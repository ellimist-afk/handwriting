/**
 * A page clipped by a path that is not one rectangle: what its shade reads as.
 *
 * Chrome and Edge print an underlined link as a black fill one unit high, under
 * a clip of two subpaths: the page box and the link's own small box, even-odd.
 * A reader that took any clip but one rectangle as "unknown" read every such
 * page as unknown, so the flattened copy laid the plain wash over it and the
 * text under a highlight came out dulled, where the screen keeps it dark.
 *
 * The rule these cells hold: a clip that is not one rectangle is a BOUND, the
 * rectangle it sits in. A fill under a bound may only darken what it covers
 * (each sample takes the darker of what it holds and the fill), so the reading
 * can only come out darker than the page: a page read as light is light. A
 * picture, a shading or transparency under such a clip is still unknown.
 *
 * The cells read the shade straight from the reader, and where it matters the
 * flattened copy too, following names from the page's ink stream through its
 * resources. No cell renders a page.
 */

import { describe, expect, it } from "vitest";
import { InkStroke, computeBBox } from "./Stroke";
import { appendInkToPdf } from "./InkPdfAppend";
import { pdfNum } from "./InkPdf";
import { pageShade } from "./InkPdfPageShade";
import { HIGHLIGHTER_ALPHA } from "./PenStyle";
import { PdfDoc, asRef, deref, dictEntries, objectBody, pdfPages, readPdf } from "../pdf/PdfSyntax";
import { document, streamObject } from "../../test/pdf-fixture";

function stroke(id: string, tool: "pen" | "highlighter", color: string, at: readonly [number, number][]): InkStroke {
	const points = at.map(([x, y], i) => ({ x, y, pressure: 0.5, t: i * 8 }));
	const width = tool === "highlighter" ? 18 : 3;
	return { id, tool, color, width, points, bbox: computeBBox(points, width), createdAt: 0, page: 1 };
}

/** A yellow highlight, a blue one crossing it, and a pen line over both. */
const INK: InkStroke[] = [
	stroke("ha", "highlighter", "#ffd60a", [[100, 200], [300, 204]]),
	stroke("hb", "highlighter", "#4bc8ff", [[200, 120], [204, 280]]),
	stroke("p", "pen", "#202020", [[90, 210], [160, 214], [310, 218]]),
];

function bytes(src: string): Uint8Array {
	const out = new Uint8Array(src.length);
	for (let i = 0; i < src.length; i++) out[i] = src.charCodeAt(i) & 0xff;
	return out;
}

function read(b: Uint8Array | string): PdfDoc {
	const doc = readPdf(b);
	if (!doc.ok) throw new Error(`does not read back: ${doc.reason}`);
	return doc.value;
}

/** The shade the copy asks for, of page 1. */
function shadeOf(src: string): string {
	const doc = read(src);
	const pages = pdfPages(doc);
	if (!pages.ok) throw new Error(pages.reason);
	return pageShade(doc, pages.value[0]!);
}

function flatten(src: string): PdfDoc {
	const r = appendInkToPdf(bytes(src), INK, "darken");
	if (!r.ok) throw new Error(`unexpected refusal: ${r.reason}`);
	return read(r.bytes);
}

/** The data of an uncompressed stream object, as written. */
function streamData(doc: PdfDoc, num: number): string {
	const off = doc.offsets.get(num);
	if (off === undefined) throw new Error(`object ${num} has no offset`);
	const from = doc.text(off, doc.bytes.length);
	const start = from.indexOf("stream\n");
	const end = from.indexOf("\nendstream", start);
	if (start < 0 || end < 0) throw new Error(`object ${num} is not a stream`);
	return from.slice(start + "stream\n".length, end);
}

/** Every graphics state page 1's ink names (page object 3), and every form it draws, through the page's final resources. */
function reached(doc: PdfDoc): { states: Map<string, string>[]; forms: number } {
	const contents = dictEntries(objectBody(doc, 3)!).get("/Contents")!;
	const refs = contents.match(/\d+ 0 R/g) ?? [];
	const ink = streamData(doc, asRef(refs[refs.length - 1])!);
	const pages = pdfPages(doc);
	if (!pages.ok) throw new Error(pages.reason);
	const res = dictEntries(deref(doc, pages.value[0]!.resources ?? undefined) ?? "<< >>");
	const gs = dictEntries(deref(doc, res.get("/ExtGState")) ?? "<< >>");
	const names = (op: string): string[] => [...ink.matchAll(new RegExp(`(/[^\\s/\\[\\]<>()]+)\\s+${op}(?=\\s|$)`, "g"))].map((m) => m[1]!);
	const states = names("gs").map((n) => dictEntries(deref(doc, gs.get(n)) ?? "<< missing >>"));
	return { states, forms: names("Do").length };
}

/** The group as the screen lays it on a light page: one form under one state, multiplied, at the highlighter's alpha. */
function expectMultiply(src: string): void {
	const r = reached(flatten(src));
	expect(r.forms, "one group drawn").toBe(1);
	expect(r.states.length, "one state").toBe(1);
	expect(r.states[0]!.get("/BM"), "the state is the multiply").toBe("/Multiply");
	expect(r.states[0]!.get("/ca")).toBe(pdfNum(HIGHLIGHTER_ALPHA));
}

/** No state the highlights reach multiplies. */
function expectNoMultiply(src: string): void {
	const r = reached(flatten(src));
	expect(r.states.length, "the highlights name a state").toBeGreaterThan(0);
	for (const s of r.states) expect(s.get("/BM"), "blend").not.toBe("/Multiply");
}

// ---------------------------------------------------------------- the page as Chrome prints it

const G3 = "/Resources << /ExtGState << /G3 << /ca 1 /BM /Normal >> >> >> ";

/**
 * One page in the shape of a Chrome (Skia) print with an underlined link, its numbers the shape's own: the flip, the
 * white page, a text run inside a one-rectangle clip, then the link's underline under the two-subpath clip `clip`.
 */
const chrome = (clip: string): string =>
	document(1, () => `${G3}/Contents 4 0 R `, "", [
		streamObject(
			[
				".23999999 0 0 -.23999999 0 792 cm",
				"q 3.125 0 0 3.125 268.75 268.75 cm 1 1 1 RG 1 1 1 rg /G3 gs 0 0 643 883 re f Q",
				"q 268.75 268.75 2010.0586 2760.0586 re W* n",
				"q 3.125 0 0 3.125 268.75 268.75 cm 0 0 0 RG 0 0 0 rg /G3 gs",
				"BT /F4 29.33 Tf 1 0 0 -1 0 30 Tm <0057> Tj 11.41 0 Td <0048> Tj ET",
				"Q Q",
				"q 268.75 268.75 2010.0586 2760.0586 re W n",
				clip,
				"q 3.125 0 0 3.125 268.75 268.75 cm 0 0 0 RG 0 0 0 rg /G3 gs 24.046875 108 72.53125 1 re f Q",
				"Q",
			].join("\n")
		),
	]);

const PAGE_AND_LINK =
	"2278.8086 268.75 m 268.75 268.75 l 268.75 3028.8086 l 2278.8086 3028.8086 l 2278.8086 268.75 l h\n" +
	"472.06207 605.85938 m 442.41351 605.85938 l 442.41351 613.56775 l 472.06207 613.56775 l 472.06207 605.85938 l h";

const CHROME: [string, string][] = [
	["W*", chrome(`${PAGE_AND_LINK}\nW* n`)],
	["W n", chrome(`${PAGE_AND_LINK}\nW n`)],
	["re re W*", chrome("268.75 268.75 2010.0586 2760.0586 re 442.41351 605.85938 29.64856 7.70837 re W* n")],
];

describe("CHROME: a page printed from Chrome with an underlined link reads light, and its copy takes the multiply", () => {
	it.each(CHROME)("CHROME %s: reads light", (_name, src) => {
		expect(shadeOf(src)).toBe("light");
	});

	it("CHROME W*: the flattened copy lays the group under the multiply", () => {
		expectMultiply(CHROME[0]![1]);
	});
});

// ---------------------------------------------------------------- fills and strokes under such a clip

const onePage = (content: string, pageExtra = "", after: readonly string[] = []): string =>
	document(1, () => `/Contents 4 0 R ${pageExtra}`, "", [streamObject(content), ...after]);

const BLACK = "0 g 0 0 612 792 re f";
/** The page box and a small box, even-odd: everything but the small box. Two subpaths, so not one rectangle. */
const CLIP2 = "0 0 m 612 0 l 612 792 l 0 792 l h 442 606 m 472 606 l 472 614 l 442 614 l h W* n";
/** One Bezier circle, radius 200, at the page's centre. */
const CIRCLE =
	"506 396 m 506 506.46 416.46 596 306 596 c 195.54 596 106 506.46 106 396 c " +
	"106 285.54 195.54 196 306 196 c 416.46 196 506 285.54 506 396 c h W n";

describe("a fill under a clip that is not one rectangle can only darken", () => {
	it("P1 black page, white rectangle fill under the two-rectangle clip: never light", () => {
		const src = onePage(`${BLACK} q ${CLIP2} 1 g 0 0 612 792 re f Q`);
		expect(shadeOf(src)).not.toBe("light");
		expectNoMultiply(src);
	});

	it("P1b black page, white two-subpath fill under the two-rectangle clip: never light", () => {
		const src = onePage(`${BLACK} q ${CLIP2} 1 g 0 0 612 400 re 0 400 612 392 re f Q`);
		expect(shadeOf(src)).not.toBe("light");
		expectNoMultiply(src);
	});

	it("P2 white page, black fill under the two-rectangle clip: dark", () => {
		expect(shadeOf(onePage(`q ${CLIP2} 0 g 0 0 612 792 re f Q`))).toBe("dark");
	});

	it("P3 white page, wide black stroke under the two-rectangle clip: dark", () => {
		expect(shadeOf(onePage(`q ${CLIP2} 0 G 500 w 0 396 m 612 396 l S Q`))).toBe("dark");
	});

	it("P4 black page, a rectangle clip inside the two-rectangle clip, white fill: never light", () => {
		const src = onePage(`${BLACK} q ${CLIP2} 0 0 612 792 re W n 1 g 0 0 612 792 re f Q`);
		expect(shadeOf(src)).not.toBe("light");
		expectNoMultiply(src);
	});

	it("P5 black page, the two-rectangle clip closed by Q, then a white fill: light", () => {
		expect(shadeOf(onePage(`${BLACK} q ${CLIP2} Q 1 g 0 0 612 792 re f`))).toBe("light");
	});

	it("C1 black page, white fill under a Bezier circle clip: never light", () => {
		const src = onePage(`${BLACK} q ${CIRCLE} 1 g 0 0 612 792 re f Q`);
		expect(shadeOf(src)).not.toBe("light");
		expectNoMultiply(src);
	});
});

describe("what the reader cannot judge stays unknown under such a clip", () => {
	it("G1 a picture drawn with Do: unknown", () => {
		const src = onePage(`q ${CLIP2} q 612 0 0 792 0 0 cm /Im0 Do Q Q`, "/Resources << /XObject << /Im0 5 0 R >> >> ", [
			"<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n\x00\nendstream",
		]);
		expect(shadeOf(src)).toBe("unknown");
	});

	it("G2 a shading painted with sh: unknown", () => {
		const src = onePage(
			`q ${CLIP2} /Sh0 sh Q`,
			"/Resources << /Shading << /Sh0 << /ShadingType 2 /ColorSpace /DeviceGray /Coords [0 0 612 0] /Function << /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [0.1] /N 1 >> >> >> >> "
		);
		expect(shadeOf(src)).toBe("unknown");
	});

	it("G3 a white fill under an alpha of 0.1 over black: unknown, no multiply", () => {
		const src = onePage(`${BLACK} q ${CLIP2} /Gt gs 1 g 0 0 612 792 re f Q`, "/Resources << /ExtGState << /Gt << /ca 0.1 >> >> >> ");
		expect(shadeOf(src)).toBe("unknown");
		expectNoMultiply(src);
	});
});
