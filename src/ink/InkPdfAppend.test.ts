/**
 * The append writer, judged on what makes a flattened PDF safe to hand to
 * somebody: the original survives byte for byte, the table we add points at
 * what it says, and the ink lands where the viewer showed it.
 *
 * Ink geometry is not re-tested. It is the same content stream `InkPdf`
 * already covers; what is new here is the surgery around it.
 */

import { describe, expect, it } from "vitest";
import { InkStroke, computeBBox } from "./Stroke";
import { appendInkToPdf, flattenedPdfPath, pageMatrix } from "./InkPdfAppend";
import { PdfPageInfo, dictEntries, latin1, objectBody, pdfPages, readPdf } from "../pdf/PdfSyntax";
import { document, packedDocument, streamObject, streamedDocument } from "../../test/pdf-fixture";

function stroke(page: number, tool: "pen" | "highlighter" = "pen"): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: 100 + i * 10, y: 200 + i, pressure: 0.5, t: i * 8 }));
	return {
		id: `s-${page}-${tool}`,
		tool,
		color: tool === "pen" ? "#4b7bec" : "#ffd60a",
		width: 3,
		points,
		bbox: computeBBox(points, 3),
		createdAt: 0,
		page,
	};
}

function bytes(src: string): Uint8Array {
	const out = new Uint8Array(src.length);
	for (let i = 0; i < src.length; i++) out[i] = src.charCodeAt(i) & 0xff;
	return out;
}

function appended(src: string, strokes: readonly InkStroke[]): Uint8Array {
	const r = appendInkToPdf(bytes(src), strokes);
	if (!r.ok) throw new Error(`unexpected refusal: ${r.reason}`);
	return r.bytes;
}

/** The finished file, read back through the reader the way a viewer would. */
function reread(out: Uint8Array) {
	const doc = readPdf(out);
	if (!doc.ok) throw new Error(`the result does not read back: ${doc.reason}`);
	return doc.value;
}

/** One page with a content stream of its own, which most real pages have. */
const withContent = (): string =>
	document(1, () => "/Contents 4 0 R ", "", [streamObject("BT /F1 12 Tf (hello) Tj ET")]);

describe("the file around the ink", () => {
	it("copies the original through, byte for byte", () => {
		const src = withContent();
		const out = appended(src, [stroke(1)]);
		expect(out.length).toBeGreaterThan(src.length);
		expect(latin1(out.subarray(0, src.length))).toBe(src);
	});

	it("adds a table whose offsets land on the objects they name", () => {
		// The same check the created-page writer gets, run against a file that
		// now has two tables: reading it back exercises the /Prev chain too.
		const doc = reread(appended(withContent(), [stroke(1)]));
		for (const [num, off] of doc.offsets) {
			expect(doc.text(off, off + 24)).toMatch(new RegExp(`^${num} 0 obj`));
		}
	});

	it("points the new trailer back at the old table", () => {
		const src = withContent();
		const was = Number(/startxref\s+(\d+)/.exec(src)![1]);
		const out = latin1(appended(src, [stroke(1)]));
		expect(out.slice(src.length)).toContain(`/Prev ${was}`);
		expect(out.endsWith("%%EOF\n")).toBe(true);
	});

	it("hands back the same bytes when there is no ink to add", () => {
		const src = bytes(withContent());
		const r = appendInkToPdf(src, []);
		expect(r.ok && r.bytes).toBe(src);
	});

	it("numbers new objects above every object in the file", () => {
		// A trailer that undercounts /Size is not rare enough to trust, and a
		// new object landing on a live number replaces something the document
		// still needs. Same digit count, so the fixture offsets still hold.
		const src = document(1).replace("/Size 4 ", "/Size 2 ");
		const doc = reread(appended(src, [stroke(1)]));
		const contents = dictEntries(objectBody(doc, 3)!).get("/Contents")!;
		const ink = Number(contents.match(/(\d+) 0 R/)![1]);
		expect(ink).toBeGreaterThan(3);
		// The catalog and the page tree are still themselves.
		expect(objectBody(doc, 1)).toContain("/Type /Catalog");
		expect(objectBody(doc, 2)).toContain("/Type /Pages");
	});

	it("repeats the /ID the document already carried", () => {
		const src = document(1).replace("/Root 1 0 R ", "/Root 1 0 R /ID [<0123> <4567>] ");
		const out = latin1(appended(src, [stroke(1)]));
		expect(out.slice(src.length)).toContain("/ID [<0123> <4567>]");
	});

	it("carries the /ID into a stream table too", () => {
		const src = streamedDocument(1).replace("/Root 1 0 R ", "/Root 1 0 R /ID [<89ab> <cdef>] ");
		const out = latin1(appended(src, [stroke(1)]));
		expect(out.slice(src.length)).toContain("/ID [<89ab> <cdef>]");
	});

	it("refuses ink for a page the document does not have", () => {
		const r = appendInkToPdf(bytes(document(2)), [stroke(3)]);
		expect(r.ok).toBe(false);
		expect(r.ok || r.reason).toContain("page 3");
	});

	it("refuses a page number that is not a page number", () => {
		const half = { ...stroke(1), page: 1.5 };
		const r = appendInkToPdf(bytes(document(2)), [half]);
		expect(r.ok).toBe(false);
		expect(r.ok || r.reason).toContain("1.5");
	});

	it("passes the reader's refusal through rather than writing a broken file", () => {
		const r = appendInkToPdf(bytes(document(1).replace("/Root 1 0 R ", "/Root 1 0 R /Encrypt 9 0 R ")), [
			stroke(1),
		]);
		expect(r.ok).toBe(false);
		expect(r.ok || r.reason).toContain("encrypted");
	});
});

describe("the page", () => {
	it("keeps its own content, bracketed, with the ink last", () => {
		const doc = reread(appended(withContent(), [stroke(1)]));
		const contents = dictEntries(objectBody(doc, 3)!).get("/Contents")!;
		const refs = (contents.match(/\d+ 0 R/g) ?? []).map((r) => Number(r.split(" ")[0]));
		expect(refs).toHaveLength(4);
		// guard, the page's own stream, guard, ink.
		expect(refs[1]).toBe(4);
		expect(objectBody(doc, refs[0]!)).toContain("/Length 1");
		const from = (n: number): string => doc.text(doc.offsets.get(n)!, doc.bytes.length);
		expect(from(refs[0]!)).toContain("stream\nq\nendstream");
		expect(from(refs[2]!)).toContain("stream\nQ\nendstream");
		expect(from(refs[3]!)).toContain(" rg ");
	});

	it("opens a content list that arrived as a reference to an array", () => {
		// Legal, and the trap is that it looks like a stream reference. Nested
		// as one, the page ends up with a content element that is an array.
		const src = document(1, () => "/Contents 4 0 R ", "", ["[5 0 R]", streamObject("q Q")]);
		const doc = reread(appended(src, [stroke(1)]));
		const contents = dictEntries(objectBody(doc, 3)!).get("/Contents")!;
		const refs = (contents.match(/\d+ 0 R/g) ?? []).map((r) => Number(r.split(" ")[0]));
		expect(refs).toContain(5);
		expect(refs).not.toContain(4);
		expect(refs).toHaveLength(4);
	});

	it("gets an array even when it had no content at all", () => {
		const doc = reread(appended(document(1), [stroke(1)]));
		const contents = dictEntries(objectBody(doc, 3)!).get("/Contents")!;
		expect((contents.match(/\d+ 0 R/g) ?? [])).toHaveLength(1);
	});

	it("keeps every key it already had", () => {
		const src = document(1, () => "/Annots [9 0 R] /Tabs /S /Contents 4 0 R ", "", [streamObject("q Q")]);
		const doc = reread(appended(src, [stroke(1)]));
		const page = dictEntries(objectBody(doc, 3)!);
		expect(page.get("/Annots")).toBe("[9 0 R]");
		expect(page.get("/Tabs")).toBe("/S");
		expect(page.get("/Type")).toBe("/Page");
	});

	it("is left alone about resources when the ink is pen only", () => {
		const doc = reread(appended(document(1), [stroke(1)]));
		expect(dictEntries(objectBody(doc, 3)!).has("/Resources")).toBe(false);
	});
});

describe("highlighter, which needs a transparency state", () => {
	it("reaches one through the page that had no resources", () => {
		const doc = reread(appended(document(1), [stroke(1, "highlighter")]));
		const res = dictEntries(objectBody(doc, 3)!).get("/Resources")!;
		const gs = dictEntries(dictEntries(res).get("/ExtGState")!);
		const num = Number([...gs.values()][0]!.split(" ")[0]);
		expect(objectBody(doc, num)).toContain("/ca ");
		expect(doc.text(doc.offsets.get(3)!, doc.bytes.length)).toContain("/HwAlpha");
	});

	it("does not take a name the page was already using", () => {
		const src = document(1, () => "/Resources << /ExtGState << /HwAlpha 9 0 R >> >> ");
		const doc = reread(appended(src, [stroke(1, "highlighter")]));
		const res = dictEntries(objectBody(doc, 3)!).get("/Resources")!;
		const gs = dictEntries(dictEntries(res).get("/ExtGState")!);
		expect(gs.get("/HwAlpha")).toBe("9 0 R");
		expect(gs.has("/HwAlpha1")).toBe(true);
	});

	it("writes into a shared resources object once, however many pages use it", () => {
		const src = document(2, () => "/Resources 5 0 R ", "", ["<< /Font << /F1 9 0 R >> >>"]);
		const doc = reread(appended(src, [stroke(1, "highlighter"), stroke(2, "highlighter")]));
		const res = objectBody(doc, 5)!;
		expect((res.match(/HwAlpha/g) ?? [])).toHaveLength(1);
		expect(res).toContain("/Font << /F1 9 0 R >>");
		// The pages reach it as they always did.
		expect(dictEntries(objectBody(doc, 3)!).get("/Resources")).toBe("5 0 R");
	});
});

describe("a document whose table is a stream", () => {
	it("gets a stream back, not a table", () => {
		const out = latin1(appended(streamedDocument(1), [stroke(1)]));
		const added = out.slice(streamedDocument(1).length);
		expect(added).toContain("/Type /XRef");
		expect(added).not.toContain("\ntrailer\n");
		expect(added).toContain("/Prev ");
	});

	it("reads back through the chain it wrote", () => {
		const doc = reread(appended(streamedDocument(1), [stroke(1)]));
		expect(doc.streamed).toBe(true);
		const contents = dictEntries(objectBody(doc, 3)!).get("/Contents")!;
		expect(contents).toMatch(/^\[\d+ 0 R\]$/);
	});

	it("puts the new table in its own rows, or the update cannot be found", () => {
		// The cross-reference stream is an object like any other. Leaving
		// itself out of the table it writes is the classic way to produce a
		// file that opens everywhere except where it matters.
		const doc = reread(appended(streamedDocument(1), [stroke(1)]));
		const table = [...doc.offsets].find(([, off]) => off === doc.startxref);
		expect(table).toBeDefined();
		expect(objectBody(doc, table![0])).toContain("/Type /XRef");
	});

	it("rewrites a packed page as an object with an offset of its own", () => {
		const doc = reread(appended(packedDocument(2), [stroke(2)]));
		// Page 2 was inside the bundle; the update lifts it out.
		expect(doc.offsets.has(4)).toBe(true);
		expect(dictEntries(objectBody(doc, 4)!).get("/Contents")).toMatch(/^\[\d+ 0 R\]$/);
		// The page nobody drew on is still where it was.
		expect(doc.packed.has(3)).toBe(true);
		expect(objectBody(doc, 3)).toContain("/MediaBox");
	});
});

describe("where the copy goes", () => {
	it("lands beside the original under a name that says what it is", () => {
		expect(flattenedPdfPath("Reading/paper.pdf")).toBe("Reading/paper.flattened.pdf");
	});

	it("does not care how the extension was spelled", () => {
		expect(flattenedPdfPath("scan.PDF")).toBe("scan.flattened.pdf");
	});

	it("replaces an earlier copy instead of stacking suffixes", () => {
		expect(flattenedPdfPath("paper.flattened.pdf")).toBe("paper.flattened.flattened.pdf");
		expect(flattenedPdfPath(flattenedPdfPath("paper.pdf"))).toBe("paper.flattened.flattened.pdf");
	});

	it("never returns the path it was given", () => {
		// The original is the one file this must not write.
		for (const path of ["a.pdf", "a.PDF", "a", "dir.pdf/b.pdf"]) {
			expect(flattenedPdfPath(path)).not.toBe(path);
		}
	});
});

describe("where the ink lands", () => {
	/** A displayed point, pushed through the stream the writer emits. */
	function place(page: PdfPageInfo, x: number, y: number): [number, number] {
		const { cm, flipHeight } = pageMatrix(page);
		const [a, b] = [x, flipHeight - y];
		if (cm === null) return [a, b];
		const [m11, m12, m21, m22, e, f] = cm.split(" ").map(Number) as number[] & { length: 6 };
		return [a * m11! + b * m21! + e!, a * m12! + b * m22! + f!];
	}

	function page(rotate: number, box = { x: 0, y: 0, w: 612, h: 792 }): PdfPageInfo {
		return { num: 3, index: 1, box, rotate, resources: null, inherited: true };
	}

	it("puts the top-left of an upright page at the top-left of its box", () => {
		expect(place(page(0), 0, 0)).toEqual([0, 792]);
	});

	it("follows the box when it does not start at the origin", () => {
		expect(place(page(0, { x: 20, y: 30, w: 612, h: 792 }), 0, 0)).toEqual([20, 822]);
	});

	it("turns the ink back on a page the viewer turned", () => {
		// Displayed top-left, on each quarter turn, is a different corner of
		// the page as stored - which is exactly the bug this prevents.
		expect(place(page(90), 0, 0)).toEqual([0, 0]);
		expect(place(page(180), 0, 0)).toEqual([612, 0]);
		expect(place(page(270), 0, 0)).toEqual([612, 792]);
	});

	it("measures a quarter-turned page across its own width", () => {
		// The displayed page is 792 wide and 612 tall; its far corner has to
		// land on the far corner of the stored page.
		expect(place(page(90), 792, 612)).toEqual([612, 792]);
	});

	it("flips a stored page height into the stream for a real document", () => {
		const doc = reread(appended(document(1, () => "/Rotate 90 "), [stroke(1)]));
		const pages = pdfPages(doc);
		expect(pages.ok && pages.value[0]!.rotate).toBe(90);
		const contents = dictEntries(objectBody(doc, 3)!).get("/Contents")!;
		const ink = Number(contents.match(/(\d+) 0 R\]/)![1]);
		const body = doc.text(doc.offsets.get(ink)!, doc.bytes.length);
		expect(body).toContain("0 1 -1 0 612 0 cm");
		expect(body).toContain("1 0 0 -1 0 612 cm");
	});
});
