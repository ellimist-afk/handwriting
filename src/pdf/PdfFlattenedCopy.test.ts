// isOwnFlattenOf on the writer's own output: true for every shape appendInkToPdf writes (a classic or streamed table,
// a file not ending in a newline or ending in a bare CR, pen only, highlights only, a contents list or none, resources
// inherited or behind a reference, the alpha placed on the page or in a shared object), on the whole read and on the
// ranged one. False for each check broken alone: the new family, the old family, our framing (a trailer key order),
// our objects (a page that gains /Annots in our exact framing), a compressed section, a truncated file, and a file
// that changed between the ranged reads and the whole read. If the writer changes shape, the true cases here red.
import { expect, it } from "vitest";
import { appendInkToPdf } from "../ink/InkPdfAppend";
import type { InkStroke } from "../ink/Stroke";
import { document, streamObject, streamedDocument } from "../../test/pdf-fixture";
import { FLATTEN_PROOF_CAP, isOwnFlattenOf } from "./PdfFlattenedCopy";
import type { HeadSource, RangedHandle } from "./PdfHead";
import { pdfInkId } from "./PdfIdentity";
import { bytesOf, latin1, readPdf } from "./PdfSyntax";

function stroke(id: string, page = 1): InkStroke {
	return {
		id, page, tool: "pen", color: "#111111", width: 2, createdAt: 0,
		points: [{ x: 10, y: 10, pressure: 0.5, t: 0 }, { x: 20, y: 20, pressure: 0.5, t: 8 }],
		bbox: { x: 10, y: 10, width: 10, height: 10 },
	};
}
const pen = stroke("p");
const highlight: InkStroke = { ...stroke("h"), tool: "highlighter", color: "#ffd60a", width: 12 };
const both = [pen, highlight];

const TEXT = streamObject("BT /F1 12 Tf (hello) Tj ET");
const PAD = streamObject("%" + "h".repeat(70_000));

/** The fixture's one-page document with the text on its page; over 64 KiB unless `small`. */
const base = (small = false) => bytesOf(document(1, () => "/Contents 4 0 R ", "", small ? [TEXT] : [TEXT, PAD]));

function copyOf(original: Uint8Array, strokes: readonly InkStroke[]): Uint8Array {
	const r = appendInkToPdf(original, strokes);
	if (!r.ok) throw new Error(`precondition: Flatten refused: ${r.reason}`);
	expect(r.bytes.length, "precondition: Flatten wrote an update").toBeGreaterThan(original.length);
	return r.bytes;
}

/** Mobile: no ranged route, the whole read only. */
const wholeOnly = (bytes: Uint8Array): HeadSource => ({ whole: async () => bytes.slice() });

/** Desktop: a handle over `bytes`; a read of the whole file gets `wholeRead` instead when given. Counts reads. */
function handleOver(bytes: Uint8Array, wholeRead?: Uint8Array, size = bytes.length) {
	const h = {
		closed: false,
		reads: 0,
		size: async () => size,
		read: async (into: Uint8Array, at: number) => {
			h.reads++;
			const from = wholeRead !== undefined && at === 0 && into.length === bytes.length ? wholeRead : bytes;
			const part = from.subarray(at, at + into.length);
			into.set(part);
			return part.length;
		},
		close: async () => {
			h.closed = true;
		},
	};
	return h;
}
const rangedOver = (h: RangedHandle, bytes: Uint8Array): HeadSource => ({ openRanged: async () => h, whole: async () => bytes.slice() });

async function proves(original: Uint8Array, copy: Uint8Array, src: HeadSource = wholeOnly(copy)): Promise<boolean> {
	return isOwnFlattenOf(src, await pdfInkId(original), await pdfInkId(copy));
}

// ---- true on the writer's own output

it("true: classic table, pen and highlight on one page, the whole read", async () => {
	const a = base();
	expect(await proves(a, copyOf(a, both))).toBe(true);
});

it("true: the same copy on the ranged read, the handle closed after", async () => {
	const a = base();
	const copy = copyOf(a, both);
	const h = handleOver(copy);
	expect(await proves(a, copy, rangedOver(h, copy))).toBe(true);
	expect(h.closed, "the handle is closed").toBe(true);
});

it("true: a small PDF, under 64 KiB, so the copy's head reaches into the update", async () => {
	const a = base(true);
	expect(a.length, "precondition: under 64 KiB").toBeLessThan(64 * 1024);
	expect(await proves(a, copyOf(a, both))).toBe(true);
});

it("true: the old version's newest table is a stream, so the update's is too", async () => {
	const a = bytesOf(streamedDocument(1, () => "/Contents 4 0 R ", [TEXT, PAD]));
	const copy = copyOf(a, both);
	expect(latin1(copy.subarray(a.length)), "precondition: the update's table is a stream").toContain("/Type /XRef");
	expect(await proves(a, copy)).toBe(true);
	expect(await proves(a, copy, rangedOver(handleOver(copy), copy))).toBe(true);
});

it("true: the old version does not end in a newline, so the writer adds one", async () => {
	const a = bytesOf(document(1, () => "/Contents 4 0 R ", "", [TEXT, PAD]).slice(0, -1));
	expect(a[a.length - 1], "precondition: no final newline").not.toBe(0x0a);
	expect(await proves(a, copyOf(a, both))).toBe(true);
});

it("true: the old version ends in a bare CR, so the writer adds a newline after it", async () => {
	const a = bytesOf(document(1, () => "/Contents 4 0 R ", "", [TEXT, PAD]).slice(0, -1) + "\r");
	expect(await proves(a, copyOf(a, both))).toBe(true);
});

it("true: pen only, and highlights only", async () => {
	const a = base();
	expect(await proves(a, copyOf(a, [pen]))).toBe(true);
	expect(await proves(a, copyOf(a, [highlight]))).toBe(true);
});

it("true: a page with no contents, a page with a contents list, and a contents reference to a list", async () => {
	const none = bytesOf(document(1, () => "", "", [PAD]));
	expect(await proves(none, copyOf(none, both))).toBe(true);
	const list = bytesOf(document(1, () => "/Contents [4 0 R 5 0 R] ", "", [TEXT, streamObject("BT ET"), PAD]));
	expect(await proves(list, copyOf(list, both))).toBe(true);
	const ref = bytesOf(document(1, () => "/Contents 4 0 R ", "", ["[5 0 R 6 0 R]", TEXT, streamObject("BT ET"), PAD]));
	expect(await proves(ref, copyOf(ref, both))).toBe(true);
});

it("true: two pages, only the second inked", async () => {
	const a = bytesOf(document(2, (i) => `/Contents ${5 + i} 0 R `, "", [TEXT, TEXT, PAD]));
	expect(await proves(a, copyOf(a, [stroke("p2", 2), { ...highlight, page: 2 }]))).toBe(true);
});

it("true: resources inherited from the page tree", async () => {
	const a = bytesOf(document(1, () => "/Contents 4 0 R ", "/Resources << /Font << /F1 5 0 R >> /ExtGState << /G0 6 0 R >> >> ",
		[TEXT, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", "<< /Type /ExtGState /ca 1 >>", PAD]));
	expect(await proves(a, copyOf(a, both))).toBe(true);
});

it("true: resources behind a reference, with states and forms of their own", async () => {
	const a = bytesOf(document(1, () => "/Contents 4 0 R /Resources 5 0 R ", "",
		[TEXT, "<< /ExtGState << /G0 6 0 R >> /XObject << /Im0 7 0 R >> >>", "<< /Type /ExtGState /ca 1 >>", streamObject("x"), PAD]));
	expect(await proves(a, copyOf(a, both))).toBe(true);
});

it("true: the highlight wash, its alpha placed on the page, in a shared states object, and in a shared resources object", async () => {
	// A /XObject this writer cannot read (no object 9) keeps the wash, which places our alpha where the page reaches it.
	const onPage = bytesOf(document(1, () => "/Contents 4 0 R /Resources << /XObject 9 0 R >> ", "", [TEXT, PAD]));
	expect(await proves(onPage, copyOf(onPage, both))).toBe(true);
	const states = bytesOf(document(1, () => "/Contents 4 0 R /Resources << /XObject 9 0 R /ExtGState 5 0 R >> ", "",
		[TEXT, "<< /G0 6 0 R >>", "<< /Type /ExtGState /ca 1 >>", PAD]));
	expect(await proves(states, copyOf(states, both))).toBe(true);
	const resources = bytesOf(document(1, () => "/Contents 4 0 R /Resources 5 0 R ", "", [TEXT, "<< /XObject 9 0 R >>", PAD]));
	expect(await proves(resources, copyOf(resources, both))).toBe(true);
});

it("true: a flattened copy of a flattened copy, asked against the copy it was made from; false against the first original", async () => {
	const a = base();
	const once = copyOf(a, [pen]);
	const twice = copyOf(once, [highlight]);
	expect(await proves(once, twice)).toBe(true);
	expect(await proves(a, twice)).toBe(false);
});

// ---- false for each check broken alone

/** Our framing around `objects` over `original`, classic table: the writer's tail, restated (InkPdfAppend.ts:526-589). */
function framed(original: Uint8Array, objects: ReadonlyMap<number, string>): Uint8Array {
	const read = readPdf(original);
	if (!read.ok) throw new Error(read.reason);
	const doc = read.value;
	const numbers = [...objects.keys()].sort((a, b) => a - b);
	let tail = original[original.length - 1] === 0x0a ? "" : "\n";
	const offsets = new Map<number, number>();
	for (const n of numbers) {
		offsets.set(n, original.length + tail.length);
		tail += `${n} 0 obj\n${objects.get(n)!}\nendobj\n`;
	}
	const startxref = original.length + tail.length;
	tail += "xref\n";
	let run: number[] = [];
	const runs: number[][] = [];
	for (const n of numbers) {
		if (run.length > 0 && run[run.length - 1] === n - 1) run.push(n);
		else runs.push((run = [n]));
	}
	for (const r of runs) {
		tail += `${r[0]} ${r.length}\n`;
		for (const n of r) tail += `${String(offsets.get(n)!).padStart(10, "0")} 00000 n \n`;
	}
	const size = Math.max(doc.size, numbers[numbers.length - 1]! + 1);
	const id = doc.trailerId === null ? "" : `/ID ${doc.trailerId} `;
	const info = doc.infoRef === null ? "" : `/Info ${doc.infoRef} `;
	tail += `trailer\n<< /Size ${size} /Root ${doc.rootNum} 0 R ${id}${info}/Prev ${doc.startxref} >>\n`;
	tail += `startxref\n${startxref}\n%%EOF\n`;
	const out = new Uint8Array(original.length + tail.length);
	out.set(original, 0);
	out.set(bytesOf(tail), original.length);
	return out;
}

/** The update's objects as the writer wrote them. */
function updateObjects(original: Uint8Array, copy: Uint8Array): Map<number, string> {
	const out = new Map<number, string>();
	for (const m of latin1(copy.subarray(original.length)).matchAll(/(\d+) 0 obj\n([\s\S]*?)\nendobj\n/g)) out.set(Number(m[1]), m[2]!);
	return out;
}

it("false: P0, the bytes are not the version the ink would go to", async () => {
	const a = base();
	const copy = copyOf(a, both);
	expect(await isOwnFlattenOf(wholeOnly(copy), await pdfInkId(a), await pdfInkId(a))).toBe(false);
});

it("false: P1, a flattened copy of another PDF", async () => {
	const a = base();
	const other = bytesOf(document(1, () => "/Contents 4 0 R ", "", [streamObject("BT /F1 12 Tf (other) Tj ET"), PAD]));
	const copy = copyOf(other, both);
	expect(await isOwnFlattenOf(wholeOnly(copy), await pdfInkId(a), await pdfInkId(copy))).toBe(false);
});

it("false: P2, our update with two trailer keys swapped", async () => {
	const a = base();
	const copy = latin1(copyOf(a, both));
	// The update's trailer, the last one; the first is the old version's own.
	const at = copy.lastIndexOf("trailer\n<< ");
	expect(at, "precondition: the update's trailer is past the old version").toBeGreaterThan(a.length);
	const swapped = copy.slice(0, at) + copy.slice(at).replace(/^trailer\n<< (\/Size \d+) (\/Root 1 0 R) /, "trailer\n<< $2 $1 ");
	expect(swapped, "precondition: the trailer changed").not.toBe(copy);
	expect(swapped.length, "precondition: no offset moved").toBe(copy.length);
	expect(await proves(a, bytesOf(swapped))).toBe(false);
});

it("false: P3, a page that gains /Annots, in our exact framing", async () => {
	const a = base();
	const copy = copyOf(a, both);
	const objects = updateObjects(a, copy);
	expect(framed(a, objects), "precondition: this test's framing is the writer's").toEqual(copy);
	expect(await proves(a, framed(a, objects)), "precondition: the reframed copy is proven").toBe(true);
	const page = objects.get(3)!;
	objects.set(3, page.replace(/ >>$/, " /Annots [4 0 R] >>"));
	expect(objects.get(3), "precondition: the page changed").not.toBe(page);
	expect(await proves(a, framed(a, objects))).toBe(false);
});

it("false: P3, a new object that is not one the writer writes, in our exact framing", async () => {
	const a = base();
	const objects = updateObjects(a, copyOf(a, both));
	const last = Math.max(...objects.keys());
	objects.set(last + 1, "<< /Type /Annot /Subtype /Text /Rect [10 10 30 30] >>");
	expect(await proves(a, framed(a, objects))).toBe(false);
});

it("false: a compressed section", async () => {
	const a = bytesOf(streamedDocument(1, () => "/Contents 4 0 R ", [TEXT, PAD]));
	const copy = latin1(copyOf(a, both));
	const compressed = copy.replace("/W [1 4 2] ", "/W [1 4 2] /Filter /FlateDecode ");
	expect(compressed, "precondition: the section changed").not.toBe(copy);
	expect(await proves(a, bytesOf(compressed))).toBe(false);
});

it("false: a truncated file", async () => {
	const a = base();
	const copy = copyOf(a, both);
	expect(await proves(a, copy.subarray(0, copy.length - 1))).toBe(false);
});

it("false: the file changed between the ranged reads and the whole read", async () => {
	const a = base();
	const copy = copyOf(a, both);
	const changed = copy.slice();
	changed[5000] = 0x67;
	expect(await proves(a, copy, rangedOver(handleOver(copy, copy.slice()), copy)), "precondition: the same bytes are proven").toBe(true);
	const h = handleOver(copy, changed);
	expect(await proves(a, copy, rangedOver(h, copy))).toBe(false);
	expect(h.closed, "the handle is closed").toBe(true);
});

it("false: over the cap, before anything past the size is read", async () => {
	const a = base();
	const copy = copyOf(a, both);
	const h = handleOver(copy, undefined, FLATTEN_PROOF_CAP + 1);
	expect(await proves(a, copy, rangedOver(h, copy))).toBe(false);
	expect(h.reads, "nothing read").toBe(0);
	expect(h.closed, "the handle is closed").toBe(true);
});

it("false: a read that stops short; the handle is closed", async () => {
	const a = base();
	const copy = copyOf(a, both);
	const h = handleOver(copy);
	h.read = async () => 0;
	expect(await proves(a, copy, rangedOver(h, copy))).toBe(false);
	expect(h.closed, "the handle is closed").toBe(true);
});

it("false, never a throw: a handle that will not open falls to the whole read; a whole read that throws is false", async () => {
	const a = base();
	const copy = copyOf(a, both);
	const refused: HeadSource = { openRanged: async () => { throw new Error("no"); }, whole: async () => copy.slice() };
	expect(await proves(a, copy, refused)).toBe(true);
	const broken: HeadSource = { whole: async () => { throw new Error("gone"); } };
	expect(await proves(a, copy, broken)).toBe(false);
});
