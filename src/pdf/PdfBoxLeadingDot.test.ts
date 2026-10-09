// A page box written with PDF's leading-dot reals (".5", "-.5") was misread,
// so flattened ink landed offset from where it was drawn. The same number
// reader serves four integer slots as well; the second block shows each one
// reads the integer forms a writer may use exactly as before.
import { describe, expect, it } from "vitest";
import { document, packedDocument, streamedDocument } from "../../test/pdf-fixture";
import { bytesOf, latin1, numbersIn, objectBody, pdfPages, readPdf } from "../pdf/PdfSyntax";
import { appendInkToPdf } from "../ink/InkPdfAppend";
import { InkStroke, computeBBox } from "../ink/Stroke";

function pagesOf(pdf: string) {
	const read = readPdf(bytesOf(pdf));
	if (!read.ok) throw new Error(read.reason);
	const pages = pdfPages(read.value);
	if (!pages.ok) throw new Error(pages.reason);
	return pages.value;
}

describe("page boxes with leading-dot numbers", () => {
	it("reads a CropBox of [.5 .5 611.5 791.5] as starting at 0.5, not 5", () => {
		const pdf = document(1, () => "/CropBox [.5 .5 611.5 791.5] ");
		expect(pagesOf(pdf)[0]!.box).toEqual({ x: 0.5, y: 0.5, w: 611, h: 791 });
	});

	it("reads a MediaBox of [-.5 -.5 611.5 791.5] as starting at -0.5", () => {
		const pdf = document(1, () => "", "", [], "[-.5 -.5 611.5 791.5]");
		expect(pagesOf(pdf)[0]!.box).toEqual({ x: -0.5, y: -0.5, w: 612, h: 792 });
	});

	it("flattened ink is translated by the real crop corner", () => {
		const pdf = document(1, () => "/CropBox [.5 .5 611.5 791.5] ");
		const points = [{ x: 10, y: 10, pressure: 0.5, t: 0 }, { x: 20, y: 20, pressure: 0.5, t: 8 }];
		const ink: InkStroke = { id: "s", tool: "pen", color: "#000000", width: 2, points, bbox: computeBBox(points, 2), createdAt: 0, page: 1 };
		const out = appendInkToPdf(bytesOf(pdf), [ink]);
		if (!out.ok) throw new Error(out.reason);
		const tail = latin1(out.bytes).slice(pdf.length);
		expect(tail).toContain("q 1 0 0 1 0.5 0.5 cm");
	});
});

/**
 * Every swap is checked to have happened, or the cell would pass on the
 * original text. Swaps inside an object the cross-reference table points past
 * keep their length, so no offset moves.
 */
function swap(src: string, from: string, to: string): string {
	expect(src.split(from), `exactly one "${from}" to swap`).toHaveLength(2);
	return src.replace(from, to);
}

function readOrThrow(src: string) {
	const read = readPdf(bytesOf(src));
	if (!read.ok) throw new Error(read.reason);
	return read.value;
}

describe("the integer slots the same number reader serves", () => {
	it("the reader itself: only a leading-dot real changes its reading", () => {
		expect(numbersIn("[.5 -.5 +.5]")).toEqual([0.5, -0.5, 0.5]);
		expect(numbersIn("[1 4 2] 0 7 +90 -90 4. 12 0 R")).toEqual([1, 4, 2, 0, 7, 90, -90, 4, 12, 0]);
	});

	it("a cross-reference stream's /W written with explicit signs reads the same", () => {
		const plain = streamedDocument(2);
		const signed = swap(plain, "/W [1 4 2] ", "/W [+1 +4 2]");
		const a = readOrThrow(plain);
		const b = readOrThrow(signed);
		expect(objectBody(b, 1)).toBe(objectBody(a, 1));
		expect([...b.offsets.entries()]).toEqual([...a.offsets.entries()]);
	});

	it("a cross-reference stream's /Index written with an explicit sign reads the same", () => {
		const plain = streamedDocument(2);
		const at = /\/Index \[0 (\d+)\] /.exec(plain)!;
		const signed = swap(plain, at[0], `/Index [+0 ${at[1]}]`);
		const a = readOrThrow(plain);
		const b = readOrThrow(signed);
		expect([...b.offsets.entries()]).toEqual([...a.offsets.entries()]);
	});

	it("an object stream's offset heads written with an explicit sign read the same", () => {
		const plain = packedDocument(2);
		const first = Number(/\/First (\d+)/.exec(plain)![1]);
		const start = plain.indexOf("stream\n") + "stream\n".length;
		const heads = plain.slice(start, start + first);
		const last = / (\d+) $/.exec(heads)!;
		const signedHeads = heads.slice(0, last.index) + ` +${last[1]}`;
		expect(signedHeads).toHaveLength(heads.length);
		const signed = plain.slice(0, start) + signedHeads + plain.slice(start + first);
		const a = readOrThrow(plain);
		const b = readOrThrow(signed);
		for (const num of [1, 2, 3, 4]) expect(objectBody(b, num)).toBe(objectBody(a, num));
	});

	it("a /Rotate written with an explicit sign, or negative, reads as before", () => {
		const plain = document(1, () => "", "/MediaBox [0 0 200 400] /Rotate 90 ", [], null);
		const rotateOf = (src: string) => {
			const pages = pdfPages(readOrThrow(src));
			if (!pages.ok) throw new Error(pages.reason);
			return pages.value[0]!.rotate;
		};
		expect(rotateOf(plain)).toBe(90);
		expect(rotateOf(swap(plain, "/Rotate 90 ", "/Rotate +90"))).toBe(90);
		// The page tree turns a negative quarter turn into its positive equal.
		expect(rotateOf(swap(plain, "/Rotate 90 ", "/Rotate -90"))).toBe(270);
	});
});
