/**
 * A highlighted page whose nearest /Resources holds /ExtGState and no /XObject, under a level above that this writer
 * cannot read. The group road (highlightGroup) asks the levels above for the /XObject the page lacks, meets the
 * unreadable level, and refuses the whole Flatten copy. The comment on highlightGroup says that page keeps the wash.
 * The wash places our state in the nearest level's own /ExtGState and writes no /XObject, so it hides nothing a
 * reader of the level above could find; 1.5.1, which had no group, flattened this file.
 *
 * Want (one of two ways to settle it; the other makes the comment say refused): the copy is written with the wash.
 * Measured at 4fd41365 (test only). Controls: the wash road with the same unreadable level above (the page's own /XObject
 * unreadable) is written; the page lacking both keys under it is refused, as pinned in InkPdfSplitResources.test.ts;
 * the same page under a level above that reads is written on the group road. Pin: a page with its own /XObject and no
 * /ExtGState under the same level is refused at the /ExtGState look, since the wash would write an /ExtGState on the
 * page and hide the level above's; and the page lacking both keys, its drawing states on a level between, is refused
 * at the /XObject look for the same reason.
 * The rig's file shape is InkPdfSplitResources.test.ts's (`split`), copied: its helpers are not exported.
 */
import { expect, it } from "vitest";
import { InkStroke, computeBBox } from "./Stroke";
import { appendInkToPdf } from "./InkPdfAppend";
import { PdfDoc, asRef, deref, dictEntries, objectBody, readPdf } from "../pdf/PdfSyntax";
import { assemble, streamObject } from "../../test/pdf-fixture";

function hl(page: number): InkStroke {
	const points = [
		[100, 200],
		[160, 204],
		[220, 208],
	].map(([x, y], i) => ({ x: x!, y: y!, pressure: 0.5, t: i * 8 }));
	return { id: `h-${page}`, tool: "highlighter", color: "#ffd60a", width: 18, points, bbox: computeBBox(points, 18), createdAt: 0, page };
}

function bytes(src: string): Uint8Array {
	const out = new Uint8Array(src.length);
	for (let i = 0; i < src.length; i++) out[i] = src.charCodeAt(i) & 0xff;
	return out;
}

function read(src: Uint8Array): PdfDoc {
	const doc = readPdf(src);
	if (!doc.ok) throw new Error(`does not read: ${doc.reason}`);
	return doc.value;
}

/** The Flatten copy, or the refusal's reason. */
function flatten(src: string): { doc: PdfDoc } | { refused: string } {
	const r = appendInkToPdf(bytes(src), [hl(1)]);
	return r.ok ? { doc: read(r.bytes) } : { refused: r.reason };
}

/** The page object's own /Resources, followed one hop. */
function ownResources(doc: PdfDoc, pageNum: number): Map<string, string> {
	return dictEntries(deref(doc, dictEntries(objectBody(doc, pageNum)!).get("/Resources")) ?? "<< >>");
}

/** The page's own ink: the last stream in its content list. */
function inkStream(doc: PdfDoc, pageNum: number): string {
	const refs = dictEntries(objectBody(doc, pageNum)!).get("/Contents")!.match(/\d+ 0 R/g) ?? [];
	const num = asRef(refs[refs.length - 1])!;
	const from = doc.text(doc.offsets.get(num)!, doc.bytes.length);
	const start = from.indexOf("stream\n") + "stream\n".length;
	return from.slice(start, from.indexOf("\nendstream", start));
}

/** Names used with an operator in a content stream, in order. */
function named(content: string, op: "gs" | "Do"): string[] {
	return [...content.matchAll(new RegExp(`(/[^\\s/\\[\\]<>()]+)\\s+${op}(?=\\s|$)`, "g"))].map((m) => m[1]!);
}

// Objects: 1 catalog, 2 the root /Pages, 3 a /Pages node under it, 4 and 5 the two pages, 6 their content, 7 a
// picture, 8 a font, 9 a drawing state of the file's own, 10 a dictionary the root's /Resources names. Object 90 is in
// no file. As InkPdfSplitResources.test.ts's `split`.
const CONTENT = streamObject("q /GS1 gs 200 0 0 200 100 300 cm /Im0 Do Q BT /F1 12 Tf 72 720 Td (hello) Tj ET");
const PICTURE =
	"<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\nA\nendstream";
const FONT = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
const STATE = "<< /Type /ExtGState /CA 0.5 /LW 3 >>";

function split(page: string, root: string, ten: string, mid = ""): string {
	const leaf = `<< /Type /Page /Parent 3 0 R /MediaBox [0 0 612 792] /Contents 6 0 R ${page}>>`;
	return assemble([
		"<< /Type /Catalog /Pages 2 0 R >>",
		`<< /Type /Pages /Kids [3 0 R] /Count 2 ${root}>>`,
		`<< /Type /Pages /Parent 2 0 R /Kids [4 0 R 5 0 R] /Count 2 ${mid}>>`,
		leaf,
		leaf,
		CONTENT,
		PICTURE,
		FONT,
		STATE,
		ten,
		"<< /Spare 11 >>",
	]);
}

const PICTURES = "/XObject << /Im0 7 0 R >>";
/** The level above: the root's /Resources is object 10, holding the pictures. */
const ROOT = "/Resources 10 0 R ";
const TEN = `<< ${PICTURES} >>`;

/** Object 10's head says generation 1, so this writer cannot read it; the same length, so every offset holds. */
function unreadableTen(src: string): string {
	expect(src.split("\n10 0 obj\n").length - 1, "precondition: one object 10 head").toBe(1);
	const broken = src.replace("\n10 0 obj\n", "\n10 1 obj\n");
	expect(objectBody(read(bytes(broken)), 10), "precondition: this writer cannot read object 10").toBeNull();
	return broken;
}

const STATES_AND_FONT = "/Resources << /ExtGState << /GS1 9 0 R >> /Font << /F1 8 0 R >> >> ";

it("control: the wash road under the unreadable level above (the page's own /XObject unreadable) writes the copy", () => {
	const src = unreadableTen(split("/Resources << /ExtGState << /GS1 9 0 R >> /XObject 90 0 R /Font << /F1 8 0 R >> >> ", ROOT, TEN));
	const got = flatten(src);
	expect("refused" in got ? got.refused : "written", "the wash road").toBe("written");
	if (!("doc" in got)) return;
	const own = ownResources(got.doc, 4);
	expect(own.get("/XObject"), "the page's /XObject as written").toBe("90 0 R");
	const states = dictEntries(own.get("/ExtGState") ?? "<< >>");
	const [state] = named(inkStream(got.doc, 4), "gs");
	expect(states.has("/GS1") && state !== undefined && states.has(state), "our state beside the file's, named by the ink").toBe(true);
	expect(named(inkStream(got.doc, 4), "Do"), "no group drawn").toEqual([]);
});

it("control: the page lacking both keys under the unreadable level above is refused, as pinned", () => {
	const src = unreadableTen(split("/Resources << /Font << /F1 8 0 R >> >> ", ROOT, TEN));
	const got = flatten(src);
	expect("refused" in got ? got.refused : "written", "refused at page 1").toContain("page 1");
});

it("pin: the page's own /XObject, no /ExtGState, the level above unreadable: refused at the /ExtGState look", () => {
	const src = unreadableTen(split("/Resources << /XObject << /Im0 7 0 R >> /Font << /F1 8 0 R >> >> ", ROOT, TEN));
	const got = flatten(src);
	expect("refused" in got ? got.refused : "written", "a state written on the page would hide the level above's").toBe("page 1 has resources this writer cannot read");
});

it("pin: the page lacking both keys, its drawing states on a level between, the level above that unreadable: refused at the /XObject look", () => {
	const src = unreadableTen(split("/Resources << /Font << /F1 8 0 R >> >> ", ROOT, TEN, "/Resources << /ExtGState << /GS1 9 0 R >> >> "));
	const got = flatten(src);
	expect("refused" in got ? got.refused : "written", "a state written on the page would hide the level between's").toBe("page 1 has resources this writer cannot read");
});

it("control: the same page under a level above that reads is written on the group road", () => {
	const got = flatten(split(STATES_AND_FONT, ROOT, TEN));
	expect("refused" in got ? got.refused : "written").toBe("written");
	if (!("doc" in got)) return;
	expect(named(inkStream(got.doc, 4), "Do").length, "one group drawn").toBe(1);
});

it("nearest /ExtGState, no /XObject, the level above unreadable: the copy is written with the wash, hiding nothing", () => {
	const src = unreadableTen(split(STATES_AND_FONT, ROOT, TEN));
	const got = flatten(src);
	expect("refused" in got ? got.refused : "written", "the whole Flatten copy refused where the wash is safe").toBe("written");
	if (!("doc" in got)) return;
	const own = ownResources(got.doc, 4);
	expect(own.has("/XObject"), "no /XObject on the page to hide the level above's").toBe(false);
	const states = dictEntries(own.get("/ExtGState") ?? "<< >>");
	const [state] = named(inkStream(got.doc, 4), "gs");
	expect(states.has("/GS1") && state !== undefined && states.has(state), "our state beside the file's, named by the ink").toBe(true);
	expect(named(inkStream(got.doc, 4), "Do"), "no group drawn").toEqual([]);
});
