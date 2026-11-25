/**
 * Flatten a flattened copy again: the new highlights multiply, as the first
 * copy's did.
 *
 * The copy lays a page's highlights under multiply only when the page's own
 * content reads light (`pageShade`). A flattened copy carries the plugin's
 * own output on the page: this version's highlight group drawn with `Do`, or
 * the plain wash 1.5.1 wrote under a transparency state, with pen ink beside
 * either. Read as content, that output is something the reader cannot judge,
 * so the second flatten fell back to the plain wash over the text.
 *
 * A page this reader cannot judge is judged as it was before that output.
 * What counts as ours is proven from the objects themselves, never from their
 * names, and the page must still read light without it: a picture, a form of
 * somebody else's, or a stream in a place the copy never writes keeps the
 * wash. A page it already judges, light or dark, keeps that answer, whatever
 * shape its content has, and so does every copy flattened from it.
 */

import { describe, expect, it } from "vitest";
import { InkStroke, computeBBox } from "../ink/Stroke";
import { appendInkToPdf } from "../ink/InkPdfAppend";
import { pageShade } from "../ink/InkPdfPageShade";
import { PdfDoc, asRef, deref, dictEntries, objectBody, pdfPages, readPdf } from "./PdfSyntax";
import { sha256 } from "./Sha256";
import { document, streamObject } from "../../test/pdf-fixture";

const YELLOW = "#ffd60a";
const BLUE = "#4bc8ff";

let ids = 0;
function stroke(tool: "pen" | "highlighter", color: string, at: readonly [number, number][]): InkStroke {
	const width = tool === "highlighter" ? 18 : 3;
	const points = at.map(([x, y], i) => ({ x, y, pressure: 0.5, t: i * 8 }));
	return { id: `s-${++ids}`, tool, color, width, points, bbox: computeBBox(points, width), createdAt: 0, page: 1 };
}

const hl = (color = YELLOW): InkStroke =>
	stroke("highlighter", color, [
		[100, 200],
		[160, 204],
		[220, 208],
	]);
const pen = (): InkStroke =>
	stroke("pen", "#202020", [
		[100, 300],
		[200, 310],
		[300, 305],
	]);

function bytes(src: string): Uint8Array {
	const out = new Uint8Array(src.length);
	for (let i = 0; i < src.length; i++) out[i] = src.charCodeAt(i) & 0xff;
	return out;
}

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/**
 * The copy, checked against the file as it was before the call: the reader is
 * handed the caller's own array, so a check taken after it could not see a
 * change made to that array in place.
 */
function flattenBytes(src: Uint8Array, strokes: readonly InkStroke[]): Uint8Array {
	const before = hex(sha256(src));
	const r = appendInkToPdf(src, strokes, "darken");
	if (!r.ok) throw new Error(`unexpected refusal: ${r.reason}`);
	expect(hex(sha256(src)), "the file the copy was made from is unchanged").toBe(before);
	expect(hex(sha256(r.bytes.subarray(0, src.length))), "the copy starts with the file it was made from").toBe(before);
	return r.bytes;
}

function read(b: Uint8Array | string): PdfDoc {
	const doc = readPdf(b);
	if (!doc.ok) throw new Error(`does not read back: ${doc.reason}`);
	return doc.value;
}

/** The shade the copy asks for, of page 1. */
function shadeOf(b: Uint8Array | string): string {
	const doc = read(b);
	const pages = pdfPages(doc);
	if (!pages.ok) throw new Error(pages.reason);
	return pageShade(doc, pages.value[0]!);
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

/** Names used with an operator in a content stream, in order. */
function named(content: string, op: "gs" | "Do"): string[] {
	return [...content.matchAll(new RegExp(`(/[^\\s/\\[\\]<>()]+)\\s+${op}(?=\\s|$)`, "g"))].map((m) => m[1]!);
}

/**
 * What page 1 (object 3) draws its newest highlights with: the last stream in
 * its content list, its state and its form, each followed through the page's
 * final /Resources to the object a reader lands on.
 */
function newest(doc: PdfDoc) {
	const contents = dictEntries(objectBody(doc, 3)!).get("/Contents")!;
	const refs = contents.match(/\d+ 0 R/g) ?? [];
	const ink = streamData(doc, asRef(refs[refs.length - 1])!);
	const states = named(ink, "gs");
	const forms = named(ink, "Do");
	const pages = pdfPages(doc);
	if (!pages.ok) throw new Error(pages.reason);
	const res = dictEntries(deref(doc, pages.value[0]!.resources ?? undefined) ?? "<< >>");
	const gsDict = deref(doc, res.get("/ExtGState"));
	const xoDict = deref(doc, res.get("/XObject"));
	const stateRef = states.length === 1 && gsDict !== null ? dictEntries(gsDict).get(states[0]!) : undefined;
	const formNum = asRef(forms.length === 1 && xoDict !== null ? dictEntries(xoDict).get(forms[0]!) : undefined);
	return {
		ink,
		states,
		forms,
		state: deref(doc, stateRef),
		form: formNum === null ? null : objectBody(doc, formNum),
		formData: formNum === null ? null : streamData(doc, formNum),
	};
}

/** The blend the newest highlights are drawn with; undefined is the plain wash. */
function blendOf(b: Uint8Array): string | undefined {
	const g = newest(read(b));
	expect(g.forms.length, `premise: one group drawn, ink ${g.ink}`).toBe(1);
	return dictEntries(g.state ?? "<< >>").get("/BM");
}

/** The page's own light content: a line of text and a pale grey bar. */
const OWN = "BT /F1 12 Tf 72 720 Td (Hello) Tj ET 0.9 g 72 600 200 20 re f";
/** A black page drawn by somebody else. */
const DARK = "0 0 0 rg 0 0 612 792 re f";
/** One black pixel. */
const IMAGE =
	"<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\n" +
	`stream\n${String.fromCharCode(0)}\nendstream`;

const bare = (): string => document(1);
const own = (): string => document(1, () => "/Contents 4 0 R ", "", [streamObject(OWN)]);

describe("a copy this version flattened, flattened again", () => {
	it("control: the first flatten of a light page lays its highlight under multiply", () => {
		expect(shadeOf(bare()), "precondition: the page reads light").toBe("light");
		expect(blendOf(flattenBytes(bytes(bare()), [hl()]))).toBe("/Multiply");
	});

	it.each([
		["a bare page with one highlight", bare, (): InkStroke[] => [hl()]],
		["a page with its own content, a highlight and pen ink", own, (): InkStroke[] => [hl(), pen()]],
	])("%s: the copy reads as the page it was made from", (_, src, ink) => {
		expect(shadeOf(src()), "precondition: the page reads light").toBe("light");
		const once = flattenBytes(bytes(src()), ink());
		expect(shadeOf(once), "shade of the once-flattened page").toBe("light");
	});

	it("a new highlight on that copy is laid under multiply again", () => {
		const once = flattenBytes(bytes(own()), [hl(), pen()]);
		const twice = flattenBytes(once, [hl(BLUE)]);
		expect(blendOf(twice), "the second flatten's highlight").toBe("/Multiply");
	});

	it("flattened three times, the newest highlight still multiplies", () => {
		const once = flattenBytes(bytes(own()), [hl()]);
		const twice = flattenBytes(once, [hl(BLUE)]);
		expect(shadeOf(twice), "shade of the twice-flattened page").toBe("light");
		const thrice = flattenBytes(twice, [hl()]);
		expect(blendOf(thrice), "the third flatten's highlight").toBe("/Multiply");
	});
});

/*
 * Bytes the shipped 1.5.1 writer appended, made by running that release's
 * own source on the fixture pages here (one highlight, and one highlight with
 * pen ink on a page with its own content), the plain wash under a 0.35 state.
 * Two more are pages the way most real files write them: resources reached by
 * reference, and graphics states in one object two pages share. 1.5.1 put its
 * state into that object, not onto the page. Pinned by hash of the whole copy.
 * Each cross-reference row ends in a space, written `\x20` so it cannot be
 * trimmed away unseen.
 */
const TAIL_BARE = `3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents [5 0 R] /Resources << /ExtGState << /HwAlpha 4 0 R >> >> >>
endobj
4 0 obj
<< /Type /ExtGState /ca 0.35 /CA 0.35 >>
endobj
5 0 obj
<< /Length 536 >>
stream
q 1 0 0 -1 0 792 cm q /HwAlpha gs 1 0.84 0.04 rg 99.43 208.53 m 129.43 210.53 l 189.43 214.53 l 219.43 216.53 l 220.57 199.47 l 190.57 197.47 l 130.57 193.47 l 100.57 191.47 l h 108.55 200 m 108.55 195.28 104.72 191.45 100 191.45 c 95.28 191.45 91.45 195.28 91.45 200 c 91.45 204.72 95.28 208.55 100 208.55 c 104.72 208.55 108.55 204.72 108.55 200 c h 228.55 208 m 228.55 203.28 224.72 199.45 220 199.45 c 215.28 199.45 211.45 203.28 211.45 208 c 211.45 212.72 215.28 216.55 220 216.55 c 224.72 216.55 228.55 212.72 228.55 208 c h f Q Q
endstream
endobj
xref
3 3
0000000329 00000 n\x20
0000000467 00000 n\x20
0000000523 00000 n\x20
trailer
<< /Size 6 /Root 1 0 R /Prev 186 >>
startxref
1110
%%EOF
`;

const TAIL_OWN = `3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents [7 0 R 4 0 R 8 0 R 6 0 R] /Resources << /ExtGState << /HwAlpha 5 0 R >> >> >>
endobj
5 0 obj
<< /Type /ExtGState /ca 0.35 /CA 0.35 >>
endobj
6 0 obj
<< /Length 1128 >>
stream
q 1 0 0 -1 0 792 cm q /HwAlpha gs 1 0.84 0.04 rg 99.43 208.53 m 129.43 210.53 l 189.43 214.53 l 219.43 216.53 l 220.57 199.47 l 190.57 197.47 l 130.57 193.47 l 100.57 191.47 l h 108.55 200 m 108.55 195.28 104.72 191.45 100 191.45 c 95.28 191.45 91.45 195.28 91.45 200 c 91.45 204.72 95.28 208.55 100 208.55 c 104.72 208.55 108.55 204.72 108.55 200 c h 228.55 208 m 228.55 203.28 224.72 199.45 220 199.45 c 215.28 199.45 211.45 203.28 211.45 208 c 211.45 212.72 215.28 216.55 220 216.55 c 224.72 216.55 228.55 212.72 228.55 208 c h f Q 0.13 0.13 0.13 rg 99.99 300.13 m 149.91 305.91 l 174.95 307.89 l 199.98 308.94 l 225.01 309.05 l 250.03 308.22 l 300 305.09 l 300 304.91 l 249.97 306.78 l 224.99 307.51 l 200.02 307.31 l 175.05 306.17 l 150.09 304.09 l 100.01 299.87 l h 100.13 300 m 100.13 299.93 100.07 299.87 100 299.87 c 99.93 299.87 99.87 299.93 99.87 300 c 99.87 300.07 99.93 300.13 100 300.13 c 100.07 300.13 100.13 300.07 100.13 300 c h 300.13 305 m 300.13 304.93 300.07 304.88 300 304.88 c 299.93 304.88 299.88 304.93 299.88 305 c 299.88 305.07 299.93 305.13 300 305.13 c 300.07 305.13 300.13 305.07 300.13 305 c h f Q
endstream
endobj
7 0 obj
<< /Length 1 >>
stream
q
endstream
endobj
8 0 obj
<< /Length 1 >>
stream
Q
endstream
endobj
xref
3 1
0000000476 00000 n\x20
5 4
0000000632 00000 n\x20
0000000688 00000 n\x20
0000001868 00000 n\x20
0000001918 00000 n\x20
trailer
<< /Size 9 /Root 1 0 R /Prev 313 >>
startxref
1968
%%EOF
`;

const TAIL_RES_REF = `3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents [8 0 R 5 0 R 9 0 R 7 0 R] /Resources 4 0 R >>
endobj
4 0 obj
<< /ProcSet [/PDF /Text] /ExtGState << /HwAlpha 6 0 R >> >>
endobj
6 0 obj
<< /Type /ExtGState /ca 0.35 /CA 0.35 >>
endobj
7 0 obj
<< /Length 536 >>
stream
q 1 0 0 -1 0 792 cm q /HwAlpha gs 1 0.84 0.04 rg 99.43 208.53 m 129.43 210.53 l 189.43 214.53 l 219.43 216.53 l 220.57 199.47 l 190.57 197.47 l 130.57 193.47 l 100.57 191.47 l h 108.55 200 m 108.55 195.28 104.72 191.45 100 191.45 c 95.28 191.45 91.45 195.28 91.45 200 c 91.45 204.72 95.28 208.55 100 208.55 c 104.72 208.55 108.55 204.72 108.55 200 c h 228.55 208 m 228.55 203.28 224.72 199.45 220 199.45 c 215.28 199.45 211.45 203.28 211.45 208 c 211.45 212.72 215.28 216.55 220 216.55 c 224.72 216.55 228.55 212.72 228.55 208 c h f Q Q
endstream
endobj
8 0 obj
<< /Length 1 >>
stream
q
endstream
endobj
9 0 obj
<< /Length 1 >>
stream
Q
endstream
endobj
xref
3 2
0000000556 00000 n\x20
0000000680 00000 n\x20
6 4
0000000755 00000 n\x20
0000000811 00000 n\x20
0000001398 00000 n\x20
0000001448 00000 n\x20
trailer
<< /Size 10 /Root 1 0 R /Prev 373 >>
startxref
1498
%%EOF
`;

const TAIL_GS_SHARED = `3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents [10 0 R 7 0 R 11 0 R 9 0 R] /Resources << /ExtGState 5 0 R >> >>
endobj
5 0 obj
<< /GS0 6 0 R /HwAlpha 8 0 R >>
endobj
8 0 obj
<< /Type /ExtGState /ca 0.35 /CA 0.35 >>
endobj
9 0 obj
<< /Length 536 >>
stream
q 1 0 0 -1 0 792 cm q /HwAlpha gs 1 0.84 0.04 rg 99.43 208.53 m 129.43 210.53 l 189.43 214.53 l 219.43 216.53 l 220.57 199.47 l 190.57 197.47 l 130.57 193.47 l 100.57 191.47 l h 108.55 200 m 108.55 195.28 104.72 191.45 100 191.45 c 95.28 191.45 91.45 195.28 91.45 200 c 91.45 204.72 95.28 208.55 100 208.55 c 104.72 208.55 108.55 204.72 108.55 200 c h 228.55 208 m 228.55 203.28 224.72 199.45 220 199.45 c 215.28 199.45 211.45 203.28 211.45 208 c 211.45 212.72 215.28 216.55 220 216.55 c 224.72 216.55 228.55 212.72 228.55 208 c h f Q Q
endstream
endobj
10 0 obj
<< /Length 1 >>
stream
q
endstream
endobj
11 0 obj
<< /Length 1 >>
stream
Q
endstream
endobj
xref
3 1
0000000785 00000 n\x20
5 1
0000000928 00000 n\x20
8 4
0000000975 00000 n\x20
0000001031 00000 n\x20
0000001618 00000 n\x20
0000001669 00000 n\x20
trailer
<< /Size 12 /Root 1 0 R /Prev 562 >>
startxref
1720
%%EOF
`;

/** A page reaching its resources by reference, with its own content. */
const resRef = (): string =>
	document(1, () => "/Contents 5 0 R /Resources 4 0 R ", "", ["<< /ProcSet [/PDF /Text] >>", streamObject(OWN)]);
/** Two pages whose graphics states are one object they share; page 1 is inked. */
const gsShared = (): string =>
	document(2, () => "/Contents 7 0 R /Resources << /ExtGState 5 0 R >> ", "", [
		"<< /GS0 6 0 R >>",
		"<< /Type /ExtGState /LW 1 >>",
		streamObject(`q /GS0 gs ${OWN} Q`),
	]);

const COPIES_151: readonly [string, () => string, string, string][] = [
	["a bare page with one highlight", bare, TAIL_BARE, "4f348818daee9f0cefd61b3468eabc9918ce9c5473401a2d65527fb76abec20a"],
	[
		"a page with its own content, a highlight and pen ink",
		own,
		TAIL_OWN,
		"e67ef568de2ba992eaac568592818e477b16a2b46b2fb012fc27a5da51cba1ca",
	],
	[
		"a page reaching its resources by reference, one highlight",
		resRef,
		TAIL_RES_REF,
		"885f7b6dc743b470af6b39afbe72c81ab4ead96ef40948ce18ffb6cef4bcf273",
	],
	[
		"a page whose graphics states are a shared object, one highlight",
		gsShared,
		TAIL_GS_SHARED,
		"5c1508c54ea3109a26ac8bbfaef436bee4b360d2a945e0eb3c3c6576a3fa18ea",
	],
];

describe("a copy 1.5.1 flattened counts as ours", () => {
	it.each(COPIES_151)("%s: the copy reads as the page it was made from", (_, src, tail, sha) => {
		const copy = bytes(src() + tail);
		expect(hex(sha256(copy)), "premise: the bytes 1.5.1 wrote").toBe(sha);
		expect(newest(read(copy)).states, "premise: the plain wash, under one state").toEqual(["/HwAlpha"]);
		expect(shadeOf(src()), "precondition: the page reads light").toBe("light");
		expect(shadeOf(copy), "shade of the 1.5.1 copy").toBe("light");
	});

	it.each(COPIES_151)("%s: a new highlight on it is laid under multiply", (_, src, tail) => {
		const twice = flattenBytes(bytes(src() + tail), [hl(BLUE)]);
		expect(blendOf(twice), "the second flatten's highlight").toBe("/Multiply");
	});

	it("a 1.5.1 copy flattened by this version, then flattened again: the newest highlight still multiplies", () => {
		const copy = bytes(own() + TAIL_OWN);
		expect(hex(sha256(copy)), "premise: the bytes 1.5.1 wrote").toBe(COPIES_151[1]![3]);
		const twice = flattenBytes(copy, [hl(BLUE)]);
		expect(shadeOf(twice), "shade of the 1.5.1 copy flattened by this version").toBe("light");
		const thrice = flattenBytes(twice, [hl()]);
		expect(blendOf(thrice), "the third flatten's highlight").toBe("/Multiply");
	});
});

describe("whatever else is on the page keeps the wash", () => {
	const foreign: [string, () => string][] = [
		[
			"a picture",
			() => document(1, () => "/Contents 5 0 R /Resources << /XObject << /Im1 4 0 R >> >> ", "", [IMAGE, streamObject("q 612 0 0 792 0 0 cm /Im1 Do Q")]),
		],
		[
			"a form of its own",
			() =>
				document(1, () => "/Contents 5 0 R /Resources << /XObject << /Fm1 4 0 R >> >> ", "", [
					formObject("<< /Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << >> /Length 0 >>", "0.9 g 0 0 10 10 re f"),
					streamObject("/Fm1 Do"),
				]),
		],
	];

	it.each(foreign)("a page drawing %s beside our output", (_, src) => {
		expect(shadeOf(src()), "precondition: unknown before any flatten").toBe("unknown");
		const once = flattenBytes(bytes(src()), [hl()]);
		expect(shadeOf(once), "shade of the once-flattened page").toBe("unknown");
		const twice = flattenBytes(once, [hl(BLUE)]);
		expect(blendOf(twice), "the second flatten's highlight").toBeUndefined();
	});
});

/** What this version writes for one highlight on a bare light page: the draw, its state and its group, as read back. */
function ours(): { draw: string; state: string; form: string; formData: string } {
	const g = newest(read(flattenBytes(bytes(bare()), [hl()])));
	expect(g.ink, "premise: the draw this version writes").toBe("q /HwAlpha gs /HwHighlights Do Q");
	return { draw: g.ink, state: g.state!, form: g.form!, formData: g.formData! };
}

/** A form object: `dict` with its /Length set to `data`. */
const formObject = (dict: string, data: string): string =>
	`${dict.replace(/\/Length \d+/, `/Length ${data.length}`)}\nstream\n${data}\nendstream`;

/**
 * Page 1 with these content streams and resources. `first` objects take the
 * numbers from 4 up, so the rest can point at them.
 */
function page(
	contents: readonly string[],
	states: Readonly<Record<string, string>>,
	forms: Readonly<Record<string, string>>,
	first: readonly string[] = []
): string {
	const after = [...first];
	const num = (obj: string): number => {
		after.push(obj);
		return 3 + after.length;
	};
	const refs = contents.map((c) => `${num(streamObject(c))} 0 R`).join(" ");
	const gs = Object.entries(states).map(([n, o]) => `/${n} ${num(o)} 0 R`).join(" ");
	const xo = Object.entries(forms).map(([n, o]) => `/${n} ${num(o)} 0 R`).join(" ");
	return document(1, () => `/Contents [${refs}] /Resources << /ExtGState << ${gs} >> /XObject << ${xo} >> >> `, "", after);
}

describe("ours is proven from the objects, never their names", () => {
	it("control: a page built of this version's own parts reads as the page", () => {
		const o = ours();
		const src = page(["q", OWN, "Q", o.draw], { HwAlpha: o.state }, { HwHighlights: formObject(o.form, o.formData) });
		expect(shadeOf(src)).toBe("light");
	});

	it("the same parts under other names count", () => {
		const o = ours();
		const draw = o.draw.replace("/HwAlpha", "/GS0").replace("/HwHighlights", "/Fm0");
		const src = page(["q", OWN, "Q", draw], { GS0: o.state }, { Fm0: formObject(o.form, o.formData) });
		expect(shadeOf(src)).toBe("light");
	});

	const imposters: [string, (o: ReturnType<typeof ours>) => string][] = [
		[
			"a form named like ours that paints a black page",
			(o) => page(["q", OWN, "Q", o.draw], { HwAlpha: o.state }, { HwHighlights: formObject(o.form, DARK) }),
		],
		[
			"a form named like ours that draws a picture",
			(o) =>
				page(
					["q", OWN, "Q", o.draw],
					{ HwAlpha: o.state },
					{
						HwHighlights: formObject(
							o.form.replace("/Resources << >>", "/Resources << /XObject << /Im1 4 0 R >> >>"),
							"q 612 0 0 792 0 0 cm /Im1 Do Q"
						),
					},
					[IMAGE]
				),
		],
		[
			"a state named like ours that is not our alpha",
			(o) =>
				page(["q", OWN, "Q", o.draw], { HwAlpha: "<< /Type /ExtGState /BM /Difference >>" }, { HwHighlights: formObject(o.form, o.formData) }),
		],
		[
			"our draw after a black page in the place the copy writes its opening q",
			(o) => page([DARK, OWN, "Q", o.draw], { HwAlpha: o.state }, { HwHighlights: formObject(o.form, o.formData) }),
		],
		[
			"our draw after a black page in the place the copy writes its closing Q",
			(o) => page(["q", OWN, DARK, o.draw], { HwAlpha: o.state }, { HwHighlights: formObject(o.form, o.formData) }),
		],
		[
			"our draw with a black page drawn after it",
			(o) => page(["q", OWN, "Q", o.draw, DARK], { HwAlpha: o.state }, { HwHighlights: formObject(o.form, o.formData) }),
		],
		[
			"our draw with a black page after it in the same stream, flipped as our pen ink is",
			(o) =>
				page(["q", OWN, "Q", `${o.draw} q 1 0 0 -1 0 792 cm 0 0 0 rg 0 0 612 792 re f Q`], { HwAlpha: o.state }, {
					HwHighlights: formObject(o.form, o.formData),
				}),
		],
		[
			"a state with our alpha and another blend",
			(o) =>
				page(["q", OWN, "Q", o.draw], { HwAlpha: "<< /Type /ExtGState /ca 0.35 /CA 0.35 /BM /Difference >>" }, {
					HwHighlights: formObject(o.form, o.formData),
				}),
		],
	];

	it.each(imposters)("%s keeps the wash", (_, build) => {
		const src = build(ours());
		expect(shadeOf(src), "shade of the page").toBe("unknown");
		const again = flattenBytes(bytes(src), [hl(BLUE)]);
		expect(blendOf(again), "the next flatten's highlight").toBeUndefined();
	});
});

/** A black page written in the shape of our own pen ink: the flip, one colour, one closed path, one fill. */
const BLACK_LIKE_PEN = "q 1 0 0 -1 0 792 cm 0 0 0 rg 0 0 m 612 0 l 612 792 l 0 792 l h f Q";

describe("a page this reader already judges keeps its answer", () => {
	const shaped: [string, () => string][] = [
		["alone", () => page([BLACK_LIKE_PEN], {}, {})],
		["after the page's own content, in the copy's brackets", () => page(["q", OWN, "Q", BLACK_LIKE_PEN], {}, {})],
	];

	it.each(shaped)("a black page in the shape of our pen ink, %s, reads dark and keeps the wash", (_, src) => {
		expect(shadeOf(src()), "shade of the page").toBe("dark");
		const once = flattenBytes(bytes(src()), [hl()]);
		expect(blendOf(once), "the highlight").toBeUndefined();
	});

	it.each(shaped)("a black page in the shape of our pen ink, %s, flattened once: the copy still reads dark and the next flatten keeps the wash", (_, src) => {
		const once = flattenBytes(bytes(src()), [hl()]);
		expect(blendOf(once), "premise: the first flatten keeps the wash").toBeUndefined();
		expect.soft(shadeOf(once), "shade of the once-flattened dark page").toBe("dark");
		const twice = flattenBytes(once, [hl(BLUE)]);
		expect(blendOf(twice), "the second flatten's highlight").toBeUndefined();
	});

	it("a black page in the shape of our wash with nothing under it, then our pen ink, reads dark and keeps the wash", () => {
		const src = handPage([`q 1 0 0 -1 0 792 cm q /A gs Q 0 0 0 rg ${BLACK_PATH} Q`], PLAIN_STATE, null);
		expect(shadeOf(src), "shade of the page").toBe("dark");
		expect(blendOf(flattenBytes(bytes(src), [hl()])), "the highlight").toBeUndefined();
	});
});

/** Page 1 with the page's own light content, these extra page keys, and this media box. */
const ownWith = (keys: string, box?: string): string => document(1, () => `${keys}/Contents 4 0 R `, "", [streamObject(OWN)], box);

describe("a copy of a turned, cornered or scaled page, and of a dark page, flattened again", () => {
	it.each([
		["turned 90", "/Rotate 90 ", undefined],
		["turned 180", "/Rotate 180 ", undefined],
		["turned 270", "/Rotate 270 ", undefined],
		["with its box corner off the origin", "", "[10 20 622 812]"],
		["with /UserUnit 2", "/UserUnit 2 ", undefined],
		["turned 90 with /UserUnit 2", "/Rotate 90 /UserUnit 2 ", undefined],
	])("a light page %s: its copy reads light and the next highlight multiplies", (_, keys, box) => {
		const src = ownWith(keys, box);
		expect(shadeOf(src), "precondition: the page reads light").toBe("light");
		const once = flattenBytes(bytes(src), [hl(), pen()]);
		expect(blendOf(once), "the first flatten's highlight").toBe("/Multiply");
		expect(shadeOf(once), "shade of the once-flattened page").toBe("light");
		expect(blendOf(flattenBytes(once, [hl(BLUE)])), "the second flatten's highlight").toBe("/Multiply");
	});

	it("a dark page with a highlight and pen ink: its copy reads dark and the next flatten keeps the wash", () => {
		const src = document(1, () => "/Contents 4 0 R ", "", [streamObject(DARK)]);
		expect(shadeOf(src), "precondition: the page reads dark").toBe("dark");
		const once = flattenBytes(bytes(src), [hl(), pen()]);
		expect(blendOf(once), "the first flatten's highlight").toBeUndefined();
		expect(shadeOf(once), "shade of the once-flattened page").toBe("dark");
		expect(blendOf(flattenBytes(once, [hl(BLUE)])), "the second flatten's highlight").toBeUndefined();
	});
});

/** Parts written by hand in the writer's shape: a multiply state, a plain one, a group's fills, the draw and a wash. */
const MULTIPLY_STATE = "<< /Type /ExtGState /ca 0.35 /CA 0.35 /BM /Multiply >>";
const PLAIN_STATE = "<< /Type /ExtGState /ca 0.35 /CA 0.35 >>";
const FILLS = "q 1 0 0 -1 0 792 cm 1 0.84 0.04 rg 100 200 m 200 200 l 200 220 l 100 220 l h f Q";
const groupForm = (data: string, keys = ""): string =>
	`<< /Type /XObject /Subtype /Form /BBox [0 0 612 792] ${keys}/Group << /S /Transparency /I true >> /Resources << >> /Length ${data.length} >>\nstream\n${data}\nendstream`;
const HAND_DRAW = "q /A gs /G Do Q";
const BLACK_PATH = "0 0 m 612 0 l 612 792 l 0 792 l h f";
const HAND_WASH = "q 1 0 0 -1 0 792 cm q /A gs 1 0.84 0.04 rg 100 200 m 200 200 l 200 220 l 100 220 l h f Q";

/** Page 1 with these content streams, state /A, and group /G holding `fills` (none when null). */
function handPage(contents: readonly string[], state: string, fills: string | null, groupKeys = ""): string {
	const objs: string[] = [];
	const num = (o: string): number => {
		objs.push(o);
		return 3 + objs.length;
	};
	const refs = contents.map((c) => `${num(streamObject(c))} 0 R`).join(" ");
	const a = num(state);
	const xo = fills === null ? "" : `/XObject << /G ${num(groupForm(fills, groupKeys))} 0 R >> `;
	return document(1, () => `/Contents [${refs}] /Resources << /ExtGState << /A ${a} 0 R >> ${xo}>> `, "", objs);
}

describe("ours is exactly the writer's shape, to the last token", () => {
	it("control: a hand-built draw over the page's own content reads light", () => {
		expect(shadeOf(handPage(["q", OWN, "Q", HAND_DRAW], MULTIPLY_STATE, FILLS))).toBe("light");
	});

	it("control: a hand-built wash over the page's own content reads light", () => {
		expect(shadeOf(handPage(["q", OWN, "Q", `${HAND_WASH} Q`], PLAIN_STATE, null))).toBe("light");
	});

	it.each([
		["a draw, an empty wrap, then a black page in the same stream", () => handPage(["q", OWN, "Q", `${HAND_DRAW} q 1 0 0 -1 0 792 cm Q 0 0 0 rg ${BLACK_PATH}`], MULTIPLY_STATE, FILLS)],
		["a wash, closed, then a black page in the same stream", () => handPage(["q", OWN, "Q", `${HAND_WASH} Q 0 0 0 rg ${BLACK_PATH}`], PLAIN_STATE, null)],
		["a group whose stream paints a black page after its wrap", () => handPage(["q", OWN, "Q", HAND_DRAW], MULTIPLY_STATE, `${FILLS} 0 0 0 rg ${BLACK_PATH}`)],
		["an opening guard that also paints a black page", () => handPage(["q 0 0 0 rg 0 0 612 792 re f", OWN, "Q", HAND_DRAW], MULTIPLY_STATE, FILLS)],
		["a closing guard that also paints a black page", () => handPage(["q", OWN, "Q 0 0 0 rg 0 0 612 792 re f", HAND_DRAW], MULTIPLY_STATE, FILLS)],
		["a black path with no colour of its own after the wash", () => handPage(["q", OWN, "Q", `${HAND_WASH} ${BLACK_PATH} Q`], PLAIN_STATE, null)],
		["a wash state with a soft mask", () => handPage(["q", OWN, "Q", `${HAND_WASH} Q`], "<< /Type /ExtGState /ca 0.35 /CA 0.35 /SMask 9 0 R >>", null)],
		["a group with a /Matrix", () => handPage(["q", OWN, "Q", HAND_DRAW], MULTIPLY_STATE, FILLS, "/Matrix [9 0 0 9 0 0] ")],
	])("%s keeps the page unknown", (_, src) => {
		expect(shadeOf(src())).toBe("unknown");
	});
});
