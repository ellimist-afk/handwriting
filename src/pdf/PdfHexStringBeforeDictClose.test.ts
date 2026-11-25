/**
 * A hex string written right before a nested dictionary's close.
 *
 * PDF needs no space between delimiters, so `/JS<00>>>` is a hex string and
 * then a `>>`. A reader that knows only `<<`, `>>` and `(` inside a nested
 * dictionary takes the hex string's `>` and the next `>` as that close, ends
 * the dictionary one byte early, and then meets a stray `>` where the next key
 * should be: every key written after it is lost. On a page that is the page's
 * own box and its content, and the flattened copy then carries a second
 * /Contents holding the ink alone, which a viewer takes as the page.
 *
 * Each case is built twice, compact and with a space before the close. The
 * spaced twin is what the reader always read, so it is the control that says
 * the fixture and the checks are sound. The pins at the end are dictionaries
 * the reader already read right and must go on reading right.
 *
 * A comment runs to the end of its line and can hold anything: a `<` and hex
 * digits that are no hex string, or a `(` that opens no literal string. Read
 * as either, it swallows the dictionary's close.
 *
 * A lone carriage return ends a comment as a line feed does: PDF allows CR, LF or CR LF as a line end. And a comment
 * inside an array can hold a `]` that closes nothing.
 */

import { describe, expect, it } from "vitest";
import { appendInkToPdf } from "../ink/InkPdfAppend";
import { InkStroke, computeBBox } from "../ink/Stroke";
import { PdfDoc, bytesOf, dictEntries, latin1, objectBody, pdfPages, readPdf, valueEnd } from "./PdfSyntax";
import { assemble } from "../../test/pdf-fixture";

const OWN_BOX = { x: 0, y: 0, w: 300, h: 400 };
const CONTENT = "BT /F1 12 Tf (hello) Tj ET";

/** A page's open action whose last value is the given hex string, written with no space before either close. */
function compactAction(hex: string): string {
	return `<</O<</S/JavaScript/JS${hex}>>>>`;
}

/** The same action with a space before each close: the form the reader has always read. */
function spacedAction(hex: string): string {
	return `<</O<</S/JavaScript/JS${hex} >> >>`;
}

/** A page dictionary with the action first and the page's own content and box after it. */
function pageDict(action: string): string {
	return `<</Type/Page/Parent 2 0 R/AA${action}/Contents 4 0 R/MediaBox[0 0 300 400]>>`;
}

/** A one-page document whose page tree carries a different box, so a page that loses its own shows the parent's. */
function pdf(action: string): string {
	return assemble([
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>",
		pageDict(action),
		`<< /Length ${CONTENT.length} >>\nstream\n${CONTENT}\nendstream`,
	]);
}

function read(src: string): PdfDoc {
	const doc = readPdf(src);
	if (!doc.ok) throw new Error(`unexpected refusal: ${doc.reason}`);
	return doc.value;
}

function firstPage(doc: PdfDoc) {
	const pages = pdfPages(doc);
	if (!pages.ok) throw new Error(`unexpected refusal: ${pages.reason}`);
	expect(pages.value, "page count").toHaveLength(1);
	return pages.value[0]!;
}

function stroke(): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: 100 + i * 10, y: 200 + i, pressure: 0.5, t: i * 8 }));
	return { id: "s-1", tool: "pen", color: "#4b7bec", width: 3, points, bbox: computeBBox(points, 3), createdAt: 0, page: 1 };
}

/** The flattened copy of a document, read back. */
function flattened(src: string): PdfDoc {
	const r = appendInkToPdf(bytesOf(src), [stroke()]);
	expect(r.ok, r.ok ? "" : r.reason).toBe(true);
	if (!r.ok) throw new Error(r.reason);
	return read(latin1(r.bytes));
}

/** How many times the page dictionary's raw text names /Contents, counted without the reader under test. */
function contentsKeys(body: string): number {
	return (body.match(/\/Contents(?![A-Za-z0-9])/g) ?? []).length;
}

const FORMS: ReadonlyArray<[string, string]> = [
	["a hex string", "<00>"],
	["an empty hex string", "<>"],
];

describe.each(FORMS)("a page action whose last value is %s, written compactly", (_name, hex) => {
	const action = compactAction(hex);
	const page = pageDict(action);

	it("ends at its own close, not one byte before it", () => {
		const at = page.indexOf(action);
		expect(at, "the action sits in the page dictionary").toBeGreaterThan(0);
		expect(valueEnd(page, at)).toBe(at + action.length);
	});

	it("leaves every key written after it readable", () => {
		const d = dictEntries(page);
		expect([...d.keys()]).toEqual(["/Type", "/Parent", "/AA", "/Contents", "/MediaBox"]);
		expect(d.get("/AA")).toBe(action);
		expect(d.get("/Contents")).toBe("4 0 R");
		expect(d.get("/MediaBox")).toBe("[0 0 300 400]");
	});

	it("gives the page its own box, not the page tree's", () => {
		expect(firstPage(read(pdf(action))).box).toEqual(OWN_BOX);
	});

	it("flattens to a copy whose page has one /Contents, still holding the page's own content, and its own box", () => {
		const copy = flattened(pdf(action));
		const body = objectBody(copy, 3);
		expect(body, "the copy's page dictionary").not.toBeNull();
		expect(contentsKeys(body!), "/Contents keys in the copy's page dictionary").toBe(1);
		expect(dictEntries(body!).get("/Contents")).toMatch(/(^|[\s[])4 0 R(?=[\s\]]|$)/);
		expect(firstPage(copy).box).toEqual(OWN_BOX);
	});
});

describe("the spaced twin, the control", () => {
	const action = spacedAction("<00>");

	it("gives the page its own box", () => {
		expect(firstPage(read(pdf(action))).box).toEqual(OWN_BOX);
	});

	it("flattens to a copy whose page has one /Contents holding the page's own content", () => {
		const body = objectBody(flattened(pdf(action)), 3);
		expect(body, "the copy's page dictionary").not.toBeNull();
		expect(contentsKeys(body!), "/Contents keys in the copy's page dictionary").toBe(1);
		expect(dictEntries(body!).get("/Contents")).toMatch(/(^|[\s[])4 0 R(?=[\s\]]|$)/);
	});
});

describe("dictionaries the reader already read right", () => {
	it("a hex string in a nested dictionary with a key after it", () => {
		const d = dictEntries("<< /A << /B <00> /C 1 >> /D 2 >>");
		expect(d.get("/A")).toBe("<< /B <00> /C 1 >>");
		expect(d.get("/D")).toBe("2");
	});

	it("a hex string right before the outer dictionary's close", () => {
		const d = dictEntries("<< /A 1 /ID <0a1b>>>");
		expect(d.get("/A")).toBe("1");
		expect(d.get("/ID")).toBe("<0a1b>");
	});

	it("hex strings in an array inside a nested dictionary", () => {
		const d = dictEntries("<< /A << /ID [<00><ff>] >> /B 1 >>");
		expect(d.get("/A")).toBe("<< /ID [<00><ff>] >>");
		expect(d.get("/B")).toBe("1");
	});

	it("brackets inside a literal string inside a nested dictionary", () => {
		const d = dictEntries("<< /A << /T (a >> b < c) >> /B 1 >>");
		expect(d.get("/A")).toBe("<< /T (a >> b < c) >>");
		expect(d.get("/B")).toBe("1");
	});

	it("a `<` that starts no hex string, in a comment inside a nested dictionary", () => {
		const d = dictEntries("<< /A << /B 1 % see <x\n>> /C 2 >>");
		expect(d.get("/A")).toBe("<< /B 1 % see <x\n>>");
		expect(d.get("/C")).toBe("2");
	});

	it("a `<` and hex digits in a comment, with the nested close on the next line", () => {
		const d = dictEntries("<< /A << /B 1 % see <a\n>> /C 2 >>");
		expect(d.get("/A")).toBe("<< /B 1 % see <a\n>>");
		expect(d.get("/C")).toBe("2");
	});
});

describe("a whole object read from the file", () => {
	it("ends at its own close when a hex string sits right before it", () => {
		const doc = read(assemble(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [] /Count 0 >>", "<</A<00>>>"]));
		expect(objectBody(doc, 3)).toBe("<</A<00>>>");
	});
});

describe("a comment holding `(` inside a page dictionary", () => {
	const page = "<</Type/Page/Parent 2 0 R % p (1\n/Contents 4 0 R/MediaBox[0 0 300 400]>>";
	const src = assemble([
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>",
		page,
		`<< /Length ${CONTENT.length} >>\nstream\n${CONTENT}\nendstream`,
	]);

	it("is read from the file as the page dictionary and nothing after it", () => {
		expect(objectBody(read(src), 3)).toBe(page);
	});

	it("gives the page its own box, not the page tree's", () => {
		expect(firstPage(read(src)).box).toEqual(OWN_BOX);
	});

	it("keeps the key after the comment when the dictionary's text is read alone", () => {
		expect(dictEntries("<</Type/Page % p (1\n/MediaBox[0 0 612 792]>>").get("/MediaBox")).toBe("[0 0 612 792]");
	});
});

describe("a comment ended by a lone carriage return, and a comment inside an array", () => {
	/** A one-page document whose page dictionary is `page`, the page tree carrying a different box. */
	function withPage(page: string): string {
		return assemble([
			"<< /Type /Catalog /Pages 2 0 R >>",
			"<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>",
			page,
			`<< /Length ${CONTENT.length} >>\nstream\n${CONTENT}\nendstream`,
		]);
	}

	it("a comment holding `(` and ended by a lone carriage return, in a page dictionary: read from the file as the page dictionary and nothing after it, and the page keeps its own box", () => {
		const page = "<</Type/Page/Parent 2 0 R % p (1\r/Contents 4 0 R/MediaBox[0 0 300 400]>>";
		const doc = read(withPage(page));
		expect(objectBody(doc, 3), "the page dictionary read from the file").toBe(page);
		expect(firstPage(doc).box).toEqual(OWN_BOX);
	});

	it("a comment holding `]` inside the page's box: the box ends at its own close, the key after it is kept, and the page keeps its own box", () => {
		const page = "<</Type/Page/Parent 2 0 R/MediaBox[0 0 % w ]\n300 400]/Contents 4 0 R>>";
		const d = dictEntries(page);
		expect(d.get("/MediaBox")).toBe("[0 0 % w ]\n300 400]");
		expect(d.get("/Contents")).toBe("4 0 R");
		expect(firstPage(read(withPage(page))).box).toEqual(OWN_BOX);
	});
});
