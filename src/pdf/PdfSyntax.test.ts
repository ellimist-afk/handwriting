/**
 * The reader, judged on the two jobs it has: finding an object where the
 * cross-reference table says it is, and reading a dictionary without being
 * fooled by the bytes inside it.
 *
 * Fixtures are built (see test/pdf-fixture.ts) rather than checked in as
 * bytes: a PDF whose offsets are computed by the test is one whose offsets are
 * known to be right, and a binary fixture would hide the thing under test
 * inside itself.
 */

import { describe, expect, it } from "vitest";
import {
	MAX_XREF_ROWS,
	asRef,
	bytesOf,
	dictEntries,
	latin1,
	numbersIn,
	objectBody,
	pdfPages,
	readPdf,
	setEntries,
	valueEnd,
} from "./PdfSyntax";
import {
	assemble,
	document,
	packedDocument,
	streamObject,
	streamedDocument,
} from "../../test/pdf-fixture";

function read(src: string) {
	const doc = readPdf(src);
	if (!doc.ok) throw new Error(`unexpected refusal: ${doc.reason}`);
	return doc.value;
}

describe("bytes and chars", () => {
	it("round-trips every byte value", () => {
		const bytes = new Uint8Array(256);
		for (let i = 0; i < 256; i++) bytes[i] = i;
		expect([...bytesOf(latin1(bytes))]).toEqual([...bytes]);
	});

	it("keeps one char per byte, so an offset is an index", () => {
		const bytes = new Uint8Array([0xc3, 0xa9, 0x0a, 0xff]);
		expect(latin1(bytes)).toHaveLength(4);
	});
});

describe("reading a value", () => {
	it("takes an indirect reference whole", () => {
		const d = dictEntries("<< /Root 12 0 R /Size 40 >>");
		expect(d.get("/Root")).toBe("12 0 R");
		expect(d.get("/Size")).toBe("40");
	});

	it("is not closed by a bracket inside a string", () => {
		const d = dictEntries("<< /Title (a >> and a \\) too) /Next 1 >>");
		expect(d.get("/Title")).toBe("(a >> and a \\) too)");
		expect(d.get("/Next")).toBe("1");
	});

	it("keeps a nested dictionary and array intact", () => {
		const d = dictEntries("<< /Resources << /Font << /F1 5 0 R >> >> /Kids [3 0 R 4 0 R] >>");
		expect(d.get("/Resources")).toBe("<< /Font << /F1 5 0 R >> >>");
		expect(d.get("/Kids")).toBe("[3 0 R 4 0 R]");
	});

	it("skips comments between tokens", () => {
		expect(dictEntries("<< /A % a name follows\n1 >>").get("/A")).toBe("1");
	});

	it("does not read a number as a reference when no R follows", () => {
		expect(valueEnd("12 0 Rx", 0)).toBe(2);
		expect(asRef("12 0 Rx")).toBe(null);
	});
});

describe("editing a dictionary", () => {
	it("replaces one value and leaves every other byte alone", () => {
		const before = "<< /Type /Page /Contents 6 0 R /Annots [9 0 R] /Odd (kept) >>";
		const after = setEntries(before, new Map([["/Contents", "[7 0 R]"]]));
		expect(after).toBe("<< /Type /Page /Contents [7 0 R] /Annots [9 0 R] /Odd (kept) >>");
	});

	it("adds a key that was not there", () => {
		expect(setEntries("<< /Type /Page >>", new Map([["/Resources", "<< >>"]]))).toBe(
			"<< /Type /Page /Resources << >> >>"
		);
	});

	it("adds to an empty dictionary", () => {
		expect(setEntries("<<>>", new Map([["/A", "1"]]))).toBe("<< /A 1 >>");
	});

	it("replaces two keys at once without disturbing the offsets of either", () => {
		const before = "<< /A 1 /B 2 /C 3 >>";
		const after = setEntries(
			before,
			new Map([
				["/A", "(one)"],
				["/C", "(three)"],
			])
		);
		expect(after).toBe("<< /A (one) /B 2 /C (three) >>");
	});
});

describe("the cross-reference table", () => {
	it("finds every object where the table says it is", () => {
		const doc = read(document(2));
		expect(objectBody(doc, 1)).toBe("<< /Type /Catalog /Pages 2 0 R >>");
		expect(objectBody(doc, 3)).toContain("/Type /Page");
		expect(doc.size).toBe(5);
		expect(doc.rootNum).toBe(1);
	});

	it("stops at a stream object dictionary, not at a byte spelling endobj", () => {
		// A compressed stream can contain the keyword. A reader that scans for
		// it truncates the object at a coincidence.
		const body = "BT (endobj) Tj ET";
		const doc = read(assemble(["<< /Type /Catalog >>", `<< /Length ${body.length} >>\nstream\n${body}\nendstream`]));
		expect(objectBody(doc, 2)).toBe(`<< /Length ${body.length} >>`);
	});

	it("refuses a cross-reference stream rather than guessing at it", () => {
		const src = assemble(["<< /Type /Catalog /Pages 2 0 R >>"]);
		const broken = src.replace(/startxref\n\d+/, "startxref\n9");
		const r = readPdf(broken);
		expect(r.ok).toBe(false);
		expect(r.ok || r.reason).toContain("stream");
	});

	it("reads a hybrid file through the classic table beside the stream", () => {
		// Five of sixty-one real documents are this shape. The stream only adds
		// compressed objects; everything the table lists is still current.
		const doc = readPdf(assemble(["<< /Type /Catalog >>"], "/XRefStm 9 "));
		expect(doc.ok).toBe(true);
	});

	it("refuses an encrypted document", () => {
		const r = readPdf(assemble(["<< /Type /Catalog >>"], "/Encrypt 9 0 R "));
		expect(r.ok).toBe(false);
		expect(r.ok || r.reason).toContain("encrypted");
	});

	it("refuses a chain that points back at itself", () => {
		const src = assemble(["<< /Type /Catalog >>"]);
		const at = /startxref\n(\d+)/.exec(src)![1]!;
		const r = readPdf(src.replace("/Root 1 0 R ", `/Root 1 0 R /Prev ${at} `));
		expect(r.ok).toBe(false);
		expect(r.ok || r.reason).toContain("itself");
	});
});

/**
 * A cross-reference STREAM with `/W [1 0 0]` - a one-byte-per-row table,
 * type 1 throughout - so its data is exactly `n` bytes and a two-million-row
 * fixture is a couple of megabytes rather than the tens the real widths
 * (`/W [1 4 2]`) would need.
 */
function bigStreamXref(n: number): string {
	const data = "\x01".repeat(n);
	let out = "%PDF-1.5\n";
	const startxref = out.length;
	out +=
		`1 0 obj\n<< /Type /XRef /Size ${n} /Root 1 0 R /W [1 0 0] ` +
		`/Index [0 ${n}] /Length ${data.length} >>\nstream\n${data}\nendstream\nendobj\n`;
	return out + `startxref\n${startxref}\n%%EOF\n`;
}

/** A classic table declaring `0 <n>`, every entry the same 20-byte shape. */
function bigClassicXref(n: number): string {
	let out = "%PDF-1.7\n";
	out += "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n";
	const startxref = out.length;
	out += `xref\n0 ${n}\n` + "0000000000 00000 n \n".repeat(n);
	out += `trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
	return out;
}

describe("the cross-reference row cap", () => {
	// audit-fixes-design.md s3 A1: neither reader capped rows before this -
	// grep for MAX/cap/limit in this file found only WINDOW. A /W [1 0 0]
	// stream turns a small compressed input into millions of Map entries.
	// Building the two-million-row fixture is the point of the test (~2.9s
	// here); vitest's 5s default flaked once on a loaded machine, so it must
	// not fail for being slow (audit-fixes-design.md s5m M2).
	it(
		"refuses a cross-reference stream one row past the cap, fast",
		() => {
			const start = Date.now();
			const r = readPdf(bigStreamXref(MAX_XREF_ROWS + 1));
			expect(r.ok).toBe(false);
			expect(r.ok || r.reason).toContain(`more than ${MAX_XREF_ROWS} rows`);
			expect(Date.now() - start).toBeLessThan(1000);
		},
		20_000,
	);

	it(
		"reads a cross-reference stream exactly at the cap",
		() => {
			const r = readPdf(bigStreamXref(MAX_XREF_ROWS));
			expect(r.ok).toBe(true);
		},
		20_000,
	);

	it("refuses a classic table one row past the cap", () => {
		const r = readPdf(bigClassicXref(MAX_XREF_ROWS + 1));
		expect(r.ok).toBe(false);
		expect(r.ok || r.reason).toContain(`more than ${MAX_XREF_ROWS} rows`);
	});
});

describe("a table written as a stream", () => {
	it("finds the same objects a classic table would", () => {
		const doc = read(streamedDocument(2));
		expect(doc.streamed).toBe(true);
		expect(objectBody(doc, 1)).toBe("<< /Type /Catalog /Pages 2 0 R >>");
		const pages = pdfPages(doc);
		expect(pages.ok && pages.value.map((page) => page.num)).toEqual([3, 4]);
	});

	it("opens a page that has no offset because it was packed away", () => {
		const doc = read(packedDocument(2));
		// Nothing in the tree has an offset of its own.
		expect(doc.offsets.has(3)).toBe(false);
		expect(doc.packed.get(3)?.index).toBe(2);
		expect(objectBody(doc, 3)).toContain("/MediaBox [0 0 612 792]");
		const pages = pdfPages(doc);
		expect(pages.ok && pages.value.map((page) => page.index)).toEqual([1, 2]);
	});

	it("opens the bundle once, however many objects are asked for", () => {
		const doc = read(packedDocument(3));
		pdfPages(doc);
		expect(doc.unpacked.size).toBe(1);
	});

	it("finds the predictor when the filter was written as a one-item array", () => {
		// /Filter [/FlateDecode] with /DecodeParms [<< ... >>] is the same
		// stream written the long way. Reading the parameters as absent gives
		// rows that inflate cleanly and mean nothing.
		const parms = "<< /Predictor 12 /Columns 7 >>";
		expect(dictEntries(`<< /DecodeParms [${parms}] >>`).get("/DecodeParms")).toBe(`[${parms}]`);
		const src = streamedDocument(1).replace("/W [1 4 2]", "/DecodeParms [<< /Predictor 1 >>] /W [1 4 2]");
		expect(readPdf(src).ok).toBe(true);
	});

	it("refuses a stream it cannot decompress rather than reading nothing", () => {
		const src = streamedDocument(1).replace("/W [1 4 2]", "/Filter /LZWDecode /W [1 4 2]");
		const r = readPdf(src);
		expect(r.ok).toBe(false);
		expect(r.ok || r.reason).toContain("decompress");
	});
});

describe("the page tree", () => {
	it("numbers pages in the order the viewer shows them", () => {
		const pages = pdfPages(read(document(3)));
		expect(pages.ok && pages.value.map((p) => [p.index, p.num])).toEqual([
			[1, 3],
			[2, 4],
			[3, 5],
		]);
	});

	it("inherits a box and a rotation from the tree", () => {
		const src = document(1, () => "", "/MediaBox [0 0 200 400] /Rotate 90 ", [], null);
		const pages = pdfPages(read(src));
		expect(pages.ok && pages.value[0]!.box).toEqual({ x: 0, y: 0, w: 200, h: 400 });
		expect(pages.ok && pages.value[0]!.rotate).toBe(90);
		expect(pages.ok && pages.value[0]!.inherited).toBe(true);
	});

	it("reports the crop box, which is what the viewer lays out", () => {
		// pdf.js sizes its viewport from CropBox clipped to MediaBox. Ink is
		// captured against that corner, so this has to agree with it or every
		// mark on a trimmed page is written down displaced.
		const pages = pdfPages(read(document(1, () => "/CropBox [10 20 310 420] ")));
		expect(pages.ok && pages.value[0]!.box).toEqual({ x: 10, y: 20, w: 300, h: 400 });
	});

	it("inherits a crop box from the tree", () => {
		const pages = pdfPages(read(document(1, () => "", "/CropBox [10 20 310 420] ")));
		expect(pages.ok && pages.value[0]!.box).toEqual({ x: 10, y: 20, w: 300, h: 400 });
	});

	it("clips a crop box that hangs off the page", () => {
		const pages = pdfPages(read(document(1, () => "/CropBox [-50 -50 300 400] ")));
		expect(pages.ok && pages.value[0]!.box).toEqual({ x: 0, y: 0, w: 300, h: 400 });
	});

	it("ignores a crop box that misses the page altogether", () => {
		// An empty intersection is a broken file, and a viewer falls back to
		// the media box rather than showing nothing.
		const pages = pdfPages(read(document(1, () => "/CropBox [700 900 800 1000] ")));
		expect(pages.ok && pages.value[0]!.box).toEqual({ x: 0, y: 0, w: 612, h: 792 });
	});

	it("normalizes a box written from the far corner", () => {
		const pages = pdfPages(read(document(1, () => "", "", [], "[612 792 0 0]")));
		expect(pages.ok && pages.value[0]!.box).toEqual({ x: 0, y: 0, w: 612, h: 792 });
	});

	it("normalizes a rotation written the long way round", () => {
		const turn = (r: number): number => {
			const pages = pdfPages(read(document(1, () => `/Rotate ${r} `)));
			return pages.ok ? pages.value[0]!.rotate : -1;
		};
		expect([turn(-90), turn(450), turn(360), turn(180)]).toEqual([270, 90, 0, 180]);
	});

	it("refuses a tree that points back at itself", () => {
		const src = assemble([
			"<< /Type /Catalog /Pages 2 0 R >>",
			"<< /Type /Pages /Kids [2 0 R] /Count 1 >>",
		]);
		const r = pdfPages(read(src));
		expect(r.ok).toBe(false);
		expect(r.ok || r.reason).toContain("itself");
	});

	it("reads numbers out of a box that spells them with decimals", () => {
		expect(numbersIn("[0 0 595.28 841.89]")).toEqual([0, 0, 595.28, 841.89]);
	});
});
