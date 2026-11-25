/**
 * Flatten of a dynamic XFA form, and the words its refusals are shown in.
 *
 * Obsidian's viewer has XFA on. pdf.js then takes a document's pages from its
 * XFA form, not its page tree, when the catalog says `/NeedsRendering true`,
 * the form's `/XFA` holds data and the form has no fields of its own. The page
 * tree of such a file holds only a stand-in page the viewer never shows. Ink
 * flattened into it is ink nobody sees in the copy, and ink on the form's later
 * pages is left out with a reason that is not true ("pages this PDF no longer
 * has"). So Flatten refuses the file, as it refuses an encrypted one.
 *
 * A form with fields of its own is shown from its page tree, and still
 * flattens. So does an XFA form that does not ask to be rendered from XFA.
 *
 * The notices: an encrypted file and an XFA form are each refused with a line
 * that reads "because"; every other reason keeps the dash it has always had.
 *
 * Real code: appendInkToPdf and the reader under it, and the real flattenPdf on
 * a plugin built without its constructor. Fakes: the PDF's bytes (built by
 * test/pdf-fixture.ts), the vault's readBinary and createBinary, the notices.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const seen = vi.hoisted(() => ({ notices: [] as string[] }));

vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	Notice: class {
		constructor(message: string) {
			seen.notices.push(message);
		}
	},
}));

import HandwritingPlugin from "../main";
import { TFile } from "obsidian";
import { appendInkToPdf } from "../ink/InkPdfAppend";
import { type InkStroke, computeBBox } from "../ink/Stroke";
import { assemble, document, streamObject } from "../../test/pdf-fixture";

function stroke(page: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: 100 + i * 10, y: 200 + i, pressure: 0.5, t: i * 8 }));
	return { id: `s-${page}`, tool: "pen", color: "#4b7bec", width: 3, points, bbox: computeBBox(points, 3), createdAt: 0, page };
}

const bytesOf = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);

const XDP = '<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"><template/></xdp:xdp>';
const WAIT = "BT /F1 12 Tf 72 720 Td (Please wait...) Tj ET";

/**
 * A one-page file: the catalog, its page tree, the one stand-in page, the
 * form. `catalog` adds to the catalog, `form` is the form dictionary as
 * written, `fields` the objects its /Fields can point at (numbered from 7).
 */
function xfaFile(catalog: string, form: string, page = "", fields: readonly string[] = []): string {
	return assemble([
		`<< /Type /Catalog /Pages 2 0 R ${catalog}/AcroForm 4 0 R >>`,
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R ${page}>>`,
		form,
		streamObject(XDP),
		streamObject(WAIT),
		...fields,
	]);
}

/** A dynamic form: rendered from XFA, no fields of its own. */
const dynamicForm = () => xfaFile("/NeedsRendering true ", "<< /Fields [] /XFA 5 0 R >>");

const INK = [stroke(1), stroke(2)];

describe("Flatten of a dynamic XFA form", () => {
	it("refuses the file, as it refuses an encrypted one: no copy whose ink nobody sees", () => {
		const r = appendInkToPdf(bytesOf(dynamicForm()), INK);
		expect(r.ok, "a dynamic XFA form was flattened into its stand-in page").toBe(false);
		expect((r as { reason: string }).reason).toBe("it's an XFA document");
	});

	it("refuses it with the form's data written as a list of parts, the form written in the catalog itself", () => {
		const src = assemble([
			`<< /Type /Catalog /Pages 2 0 R /NeedsRendering true /AcroForm << /XFA [(template) 4 0 R (datasets) 5 0 R] >> >>`,
			"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
			"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
			streamObject(XDP),
			streamObject("<xfa:datasets/>"),
		]);
		const r = appendInkToPdf(bytesOf(src), INK);
		expect(r.ok, "a dynamic XFA form, its parts in a list, was flattened into its stand-in page").toBe(false);
		expect((r as { reason: string }).reason).toBe("it's an XFA document");
	});

	it("still flattens a form with a real field: its page tree is what the viewer shows", () => {
		const widget = "<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /Rect [100 100 300 120] /P 3 0 R >>";
		const src = xfaFile("/NeedsRendering true ", "<< /Fields [7 0 R] /XFA 5 0 R >>", "/Annots [7 0 R] ", [widget]);
		const r = appendInkToPdf(bytesOf(src), INK);
		expect(r.ok, `a form with a real field was refused: ${(r as { reason?: string }).reason}`).toBe(true);
		const out = r as { bytes: Uint8Array; leftOut: number };
		expect(out.bytes.length, "the copy gained no ink").toBeGreaterThan(src.length);
		expect(out.leftOut, "the ink past the one page was not counted").toBe(1);
	});

	it("still flattens an XFA form that does not ask to be rendered from XFA", () => {
		const src = xfaFile("", "<< /Fields [] /XFA 5 0 R >>");
		const r = appendInkToPdf(bytesOf(src), [stroke(1)]);
		expect(r.ok, `a form shown from its page tree was refused: ${(r as { reason?: string }).reason}`).toBe(true);
	});
});

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	seen.notices.length = 0;
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

/** The real flattenPdf on a plugin built without its constructor, over a vault holding one PDF. */
async function flatten(text: string): Promise<{ notices: string[]; writes: string[] }> {
	const writes: string[] = [];
	const exists = new Set<string>();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const plugin = Object.create(HandwritingPlugin.prototype) as any;
	plugin.settings = { inkPdfColorMode: "darken" };
	plugin.pdfStore = { strokes: () => INK };
	plugin.app = {
		vault: {
			adapter: { exists: async (path: string) => exists.has(path) },
			readBinary: async () => bytesOf(text).buffer,
			createBinary: async (path: string) => {
				writes.push(path);
				exists.add(path);
				return new TFile();
			},
		},
	};
	const file = Object.assign(new TFile(), { path: "Forms/tax.pdf", extension: "pdf", name: "tax.pdf", basename: "tax" });
	await plugin.flattenPdf(file, "id-1");
	return { notices: [...seen.notices], writes };
}

describe("Flatten's refusal notices", () => {
	it("an XFA form: the line that says why, and nothing written", async () => {
		const got = await flatten(dynamicForm());
		expect(got.notices).toEqual(["Handwriting: this PDF cannot be flattened because it's an XFA document"]);
		expect(got.writes, "a copy was written").toEqual([]);
	});

	it("an encrypted file: the line that says why, and nothing written", async () => {
		const got = await flatten(document(1).replace("/Root 1 0 R ", "/Root 1 0 R /Encrypt 9 0 R "));
		expect(got.notices).toEqual(["Handwriting: this PDF cannot be flattened because the document is encrypted"]);
		expect(got.writes, "a copy was written").toEqual([]);
	});

	it("any other reason keeps its dash", async () => {
		const src = document(1);
		const got = await flatten(src.slice(0, src.lastIndexOf("startxref")));
		expect(got.notices).toEqual(["Handwriting: this PDF cannot be flattened - the file ends without a startxref"]);
		expect(got.writes, "a copy was written").toEqual([]);
	});

	it("a form with a real field: the copy, under the usual notice", async () => {
		const widget = "<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /Rect [100 100 300 120] /P 3 0 R >>";
		const got = await flatten(xfaFile("/NeedsRendering true ", "<< /Fields [7 0 R] /XFA 5 0 R >>", "/Annots [7 0 R] ", [widget]));
		expect(got.writes).toEqual(["Forms/tax.flattened.pdf"]);
		expect(got.notices).toEqual(["Handwriting: exported Forms/tax.flattened.pdf. 1 stroke on a page this PDF no longer has was left out."]);
	});
});

