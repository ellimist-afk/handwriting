import { describe, expect, it } from "vitest";
import { InkStroke, computeBBox } from "./Stroke";
import { appendInkToPdf, pageMatrix } from "./InkPdfAppend";
import { PdfPageInfo, pdfPages, readPdf } from "../pdf/PdfSyntax";
import { assemble } from "../../test/pdf-fixture";

/**
 * Page values written as indirect references.
 *
 * PDF lets a page tree write /Kids, /CropBox and /Rotate as a reference to a separate object holding the array or number. The
 * reader takes the raw entry text. A reference it does not follow reads as: a /Kids that lists nothing walkable, a /CropBox
 * that is no box (so the media box shows), a /Rotate that reads as the object number. Each variant here is built next to its
 * direct-value twin, and the reader and the flatten path must give the same page, box, rotation and ink placement for both.
 * The three variants are separate describe blocks, so one passing cannot cover another.
 */

const CONTENT = "BT /F1 12 Tf (hello) Tj ET";

function stroke(): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: 100 + i * 10, y: 200 + i, pressure: 0.5, t: i * 8 }));
	return { id: "s-1", tool: "pen", color: "#4b7bec", width: 3, points, bbox: computeBBox(points, 3), createdAt: 0, page: 1 };
}

const stream = `<< /Length ${CONTENT.length} >>\nstream\n${CONTENT}\nendstream`;

/** A one-page document. `pageExtra` goes in the page dictionary, `treeKids` replaces the /Kids value, `more` adds objects 5 on. */
function pdf(opts: { pageExtra?: string; treeKids?: string; mediaBox?: string; more?: string[] }): string {
	return assemble([
		"<< /Type /Catalog /Pages 2 0 R >>",
		`<< /Type /Pages /Kids ${opts.treeKids ?? "[3 0 R]"} /Count 1 >>`,
		`<< /Type /Page /Parent 2 0 R /MediaBox ${opts.mediaBox ?? "[0 0 612 792]"} /Contents 4 0 R ${opts.pageExtra ?? ""}>>`,
		stream,
		...(opts.more ?? []),
	]);
}

function pagesOf(src: string): PdfPageInfo[] {
	const doc = readPdf(src);
	if (!doc.ok) throw new Error(`unexpected refusal: ${doc.reason}`);
	const pages = pdfPages(doc.value);
	return pages.ok ? pages.value : [];
}

function bytes(src: string): Uint8Array {
	const out = new Uint8Array(src.length);
	for (let i = 0; i < src.length; i++) out[i] = src.charCodeAt(i) & 0xff;
	return out;
}

/** The facts a viewer and the flatten path both rest on, for one page. */
function facts(page: PdfPageInfo): { box: PdfPageInfo["box"]; rotate: number; matrix: ReturnType<typeof pageMatrix> } {
	return { box: page.box, rotate: page.rotate, matrix: pageMatrix(page) };
}

describe("the direct-value twins hold the expected page", () => {
	it("one page, its crop box, its rotation", () => {
		const base = pagesOf(pdf({}));
		expect(base).toHaveLength(1);
		const crop = pagesOf(pdf({ pageExtra: "/CropBox [10 20 310 420] " }));
		expect(crop[0]!.box).toEqual({ x: 10, y: 20, w: 300, h: 400 });
		const turned = pagesOf(pdf({ pageExtra: "/Rotate 90 " }));
		expect(turned[0]!.rotate).toBe(90);
	});
});

describe("an indirect /Kids array", () => {
	const indirect = pdf({ treeKids: "5 0 R", more: ["[3 0 R]"] });
	it("lists the one page the direct twin lists", () => {
		expect(pagesOf(indirect).map((p) => p.num), "page object numbers").toEqual(pagesOf(pdf({})).map((p) => p.num));
	});
	it("flattens the ink onto that page", () => {
		const r = appendInkToPdf(bytes(indirect), [stroke()]);
		expect(r.ok, r.ok ? "" : r.reason).toBe(true);
	});
});

describe("an indirect /CropBox", () => {
	const indirect = pdf({ pageExtra: "/CropBox 5 0 R ", more: ["[10 20 310 420]"] });
	const direct = pdf({ pageExtra: "/CropBox [10 20 310 420] " });
	it("gives the page the crop box the direct twin gets", () => {
		expect(pagesOf(indirect)[0]!.box).toEqual(pagesOf(direct)[0]!.box);
	});
	it("places the ink against that box", () => {
		expect(facts(pagesOf(indirect)[0]!)).toEqual(facts(pagesOf(direct)[0]!));
	});
});

describe("an indirect /Rotate", () => {
	const indirect = pdf({ pageExtra: "/Rotate 5 0 R ", more: ["90"] });
	const direct = pdf({ pageExtra: "/Rotate 90 " });
	it("turns the page the way the direct twin turns", () => {
		expect(pagesOf(indirect)[0]!.rotate).toBe(pagesOf(direct)[0]!.rotate);
	});
	it("places the ink on the turned page", () => {
		expect(facts(pagesOf(indirect)[0]!)).toEqual(facts(pagesOf(direct)[0]!));
	});
});

describe("an indirect /MediaBox", () => {
	const indirect = pdf({ mediaBox: "5 0 R", more: ["[0 0 300 400]"] });
	const direct = pdf({ mediaBox: "[0 0 300 400]" });
	it("gives the page the box the direct twin gets", () => {
		expect(pagesOf(indirect)[0]!.box).toEqual({ x: 0, y: 0, w: 300, h: 400 });
		expect(facts(pagesOf(indirect)[0]!)).toEqual(facts(pagesOf(direct)[0]!));
	});
});

describe("a reference that leads nowhere", () => {
	it("a /CropBox pointing at no object leaves the media box showing, as if it were absent", () => {
		const page = pagesOf(pdf({ pageExtra: "/CropBox 99 0 R " }))[0]!;
		expect(page.box).toEqual({ x: 0, y: 0, w: 612, h: 792 });
	});
	it("a /Rotate pointing at no object leaves the page unturned", () => {
		expect(pagesOf(pdf({ pageExtra: "/Rotate 99 0 R " }))[0]!.rotate).toBe(0);
	});
	it("a /Kids pointing at no object invents no page and does not throw", () => {
		const doc = readPdf(pdf({ treeKids: "99 0 R" }));
		expect(doc.ok).toBe(true);
		if (!doc.ok) return;
		const pages = pdfPages(doc.value);
		expect(pages.ok ? pages.value : []).toEqual([]);
	});
	it("a reference that points at itself ends, and reads as no value", () => {
		const page = pagesOf(pdf({ pageExtra: "/Rotate 5 0 R ", more: ["5 0 R"] }))[0]!;
		expect(page.rotate).toBe(0);
	});
});

describe("a chain of references", () => {
	it("a /Rotate that points at an object holding a reference to the number is followed to the number", () => {
		const page = pagesOf(pdf({ pageExtra: "/Rotate 5 0 R ", more: ["6 0 R", "90"] }))[0]!;
		expect(page.rotate).toBe(90);
	});
	it("a /CropBox reached through two references is the crop box", () => {
		const page = pagesOf(pdf({ pageExtra: "/CropBox 5 0 R ", more: ["6 0 R", "[10 20 310 420]"] }))[0]!;
		expect(page.box).toEqual({ x: 10, y: 20, w: 300, h: 400 });
	});
});
