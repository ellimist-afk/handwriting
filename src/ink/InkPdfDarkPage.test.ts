/**
 * Highlights in a flattened copy of a page the file itself draws dark.
 *
 * Every highlighted page's highlights are one group, drawn once at the
 * highlighter's alpha, as the screen lays them. A light page's group is drawn
 * under a multiply (InkPdfHighlightGroup.test.ts). A multiply over a page the
 * file draws black is a multiply over black, and the band is gone. So the copy
 * reads each highlighted page's own content: a page it reads as light takes
 * the multiply, and every other page - one it reads as dark, and one whose
 * shade the content does not say - takes the same group with no blend mode,
 * which stays readable on any shade and keeps a crossing one coat
 * (InkPdfCrossingCoat.test.ts).
 *
 * Three kinds of pin, each a sha256 of the whole flattened file:
 * - PUBLISHED: taken at the published 1.5.1 writer (53b1bd7f). A pen-only
 *   page must write exactly that.
 * - GROUP: taken at the 1.5.2 writer before the dark page change (cef861e0),
 *   which grouped every page under "darken" and "keep". A page read as light
 *   must write exactly that.
 * - PLAIN_GROUP: taken at this writer, the first to lay a group with no blend
 *   mode; each cell that checks one also checks its structure.
 *
 * Every check follows names from the page's content stream through the
 * resources a reader would use; nothing trusts the writer's own bookkeeping.
 * No cell renders a page: what a reader's eye sees is argued from blend,
 * alpha and colour, never looked at.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as FlateModule from "../pdf/Flate";
import { InkStroke, computeBBox } from "./Stroke";
import { appendInkToPdf } from "./InkPdfAppend";
import { PdfPageAssumption, pdfNum } from "./InkPdf";
import { HIGHLIGHTER_ALPHA } from "./PenStyle";
import { PdfDoc, asRef, deref, dictEntries, objectBody, pdfPages, readPdf } from "../pdf/PdfSyntax";
import { sha256 } from "../pdf/Sha256";
import { document, streamObject } from "../../test/pdf-fixture";

// Every inflate the copy runs, counted, so a cell can say which streams it
// opened. The real decoder does the work.
const inflates = vi.hoisted(() => ({ n: 0 }));
vi.mock("../pdf/Flate", async (importOriginal) => {
	const real = await importOriginal<typeof FlateModule>();
	return {
		...real,
		inflate: (data: Uint8Array, limit?: number): Uint8Array | null => {
			inflates.n++;
			return real.inflate(data, limit);
		},
	};
});
beforeEach(() => {
	inflates.n = 0;
});

const YELLOW = "#ffd60a";
const BLUE = "#4bc8ff";

function stroke(page: number, tool: "pen" | "highlighter", color: string, id: string, at: readonly [number, number][]): InkStroke {
	const points = at.map(([x, y], i) => ({ x, y, pressure: 0.5, t: i * 8 }));
	const width = tool === "highlighter" ? 18 : 3;
	return { id, tool, color, width, points, bbox: computeBBox(points, width), createdAt: 0, page };
}

/** One page's ink: a yellow highlight, a blue one crossing it, and a pen line over both. */
const inkOn = (page: number): InkStroke[] => [
	stroke(page, "highlighter", YELLOW, `h${page}a`, [[100, 200], [300, 204]]),
	stroke(page, "highlighter", BLUE, `h${page}b`, [[200, 120], [204, 280]]),
	stroke(page, "pen", "#202020", `p${page}`, [[90, 210], [160, 214], [310, 218]]),
];
const penOn = (page: number): InkStroke[] => [stroke(page, "pen", "#202020", `q${page}`, [[90, 210], [160, 214], [310, 218]])];

function bytes(src: string): Uint8Array {
	const out = new Uint8Array(src.length);
	for (let i = 0; i < src.length; i++) out[i] = src.charCodeAt(i) & 0xff;
	return out;
}

function hex(b: Uint8Array): string {
	return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function write(src: string, strokes: readonly InkStroke[], mode: PdfPageAssumption): Uint8Array {
	const r = appendInkToPdf(bytes(src), strokes, mode);
	if (!r.ok) throw new Error(`unexpected refusal: ${r.reason}`);
	return r.bytes;
}

function flatten(src: string, strokes: readonly InkStroke[], mode: PdfPageAssumption): PdfDoc {
	const doc = readPdf(write(src, strokes, mode));
	if (!doc.ok) throw new Error(`the result does not read back: ${doc.reason}`);
	return doc.value;
}

/** A zlib stream of stored blocks: real FlateDecode data, with no encoder needed. */
function zlibStored(text: string): string {
	let out = "\x78\x01";
	let a = 1;
	let b = 0;
	for (let i = 0; i < text.length; i++) {
		a = (a + (text.charCodeAt(i) & 0xff)) % 65521;
		b = (b + a) % 65521;
	}
	for (let at = 0; at === 0 || at < text.length; at += 65535) {
		const part = text.slice(at, at + 65535);
		const last = at + 65535 >= text.length;
		const n = part.length;
		out += String.fromCharCode(last ? 1 : 0, n & 0xff, n >> 8, ~n & 0xff, (~n >> 8) & 0xff) + part;
	}
	const adler = ((b << 16) | a) >>> 0;
	return out + String.fromCharCode((adler >>> 24) & 0xff, (adler >>> 16) & 0xff, (adler >>> 8) & 0xff, adler & 0xff);
}

const flateObject = (body: string): string => {
	const data = zlibStored(body);
	return `<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n${data}\nendstream`;
};

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

/** The page's own ink: the last stream in its content list. */
function inkStream(doc: PdfDoc, pageNum: number): string {
	const contents = dictEntries(objectBody(doc, pageNum)!).get("/Contents")!;
	const refs = contents.match(/\d+ 0 R/g) ?? [];
	return streamData(doc, asRef(refs[refs.length - 1])!);
}

function finalResources(doc: PdfDoc, index: number): Map<string, string> {
	const pages = pdfPages(doc);
	if (!pages.ok) throw new Error(pages.reason);
	const res = deref(doc, pages.value[index - 1]!.resources ?? undefined);
	return res === null ? new Map() : dictEntries(res);
}

function named(content: string, op: "gs" | "Do"): string[] {
	return [...content.matchAll(new RegExp(`(/[^\\s/\\[\\]<>()]+)\\s+${op}(?=\\s|$)`, "g"))].map((m) => m[1]!);
}

/**
 * Every graphics state a highlighted page's ink reaches, and every form it
 * draws: from the ink stream through the page's final /Resources, and from
 * each form through the form's own /Resources, where a blend could also hide.
 */
function reached(doc: PdfDoc, index: number, pageNum: number) {
	const ink = inkStream(doc, pageNum);
	const res = finalResources(doc, index);
	const gs = dictEntries(deref(doc, res.get("/ExtGState")) ?? "<< >>");
	const xo = dictEntries(deref(doc, res.get("/XObject")) ?? "<< >>");
	const states: { name: string; num: number | null; dict: Map<string, string> }[] = [];
	for (const n of named(ink, "gs")) {
		const v = gs.get(n);
		states.push({ name: n, num: asRef(v), dict: dictEntries(deref(doc, v) ?? "<< missing >>") });
	}
	const forms: number[] = [];
	for (const n of named(ink, "Do")) {
		const num = asRef(xo.get(n));
		if (num === null) continue;
		forms.push(num);
		const formRes = dictEntries(dictEntries(objectBody(doc, num) ?? "<< >>").get("/Resources") ?? "<< >>");
		for (const [k, v] of dictEntries(deref(doc, formRes.get("/ExtGState")) ?? "<< >>")) {
			states.push({ name: `form ${num} ${k}`, num: asRef(v), dict: dictEntries(deref(doc, v) ?? "<< missing >>") });
		}
	}
	return { ink, states, forms };
}

/**
 * The group with no blend mode: one form drawn once under one state at the highlighter's alpha, normal blend, no mask,
 * and no state inside the form, so the alpha is laid once and nothing multiplies.
 */
function expectPlainGroup(doc: PdfDoc, index: number, pageNum: number): { state: number | null; form: number } {
	const r = reached(doc, index, pageNum);
	expect(r.forms, `page ${index}: one group drawn`).toHaveLength(1);
	expect(r.states.length, `page ${index}: one state, the group's own has none`).toBe(1);
	const s = r.states[0]!;
	const bm = s.dict.get("/BM");
	expect(bm === undefined || bm === "/Normal", `page ${index} ${s.name}: blend ${bm}`).toBe(true);
	const mask = s.dict.get("/SMask");
	expect(mask === undefined || mask === "/None", `page ${index} ${s.name}: soft mask ${mask}`).toBe(true);
	expect(s.dict.get("/ca"), `page ${index} ${s.name}: alpha`).toBe(pdfNum(HIGHLIGHTER_ALPHA));
	return { state: s.num, form: r.forms[0]! };
}

/** The group, as the screen lays it on a light page. */
function expectGroup(doc: PdfDoc, index: number, pageNum: number): { state: number | null; form: number } {
	const r = reached(doc, index, pageNum);
	expect(r.forms, `page ${index}: one group drawn`).toHaveLength(1);
	expect(r.states.length, `page ${index}: one state, the group's own has none`).toBe(1);
	expect(r.states[0]!.dict.get("/BM"), `page ${index}: the state is the multiply`).toBe("/Multiply");
	expect(r.states[0]!.dict.get("/ca")).toBe(pdfNum(HIGHLIGHTER_ALPHA));
	return { state: r.states[0]!.num, form: r.forms[0]! };
}

const sha = (src: string, strokes: readonly InkStroke[], mode: PdfPageAssumption): string => hex(sha256(write(src, strokes, mode)));

/** A hash against its pin; a missing pin says so, with the whole hash, so it can be taken at the writer it names. */
function pinned(table: Record<string, string>, name: string, got: string): void {
	const want = table[name];
	if (want === undefined) throw new Error(`no pin "${name}": ${got}`);
	expect(got, name).toBe(want);
}

// ---------------------------------------------------------------- fixtures: one page, its content in object 4

const onePage = (content: string, pageExtra = "", after: readonly string[] = []): string =>
	document(1, () => `/Contents 4 0 R ${pageExtra}`, "", [content, ...after]);

const DARK = "0.07 0.07 0.07 rg 0 0 612 792 re f";
const fileDark = onePage(streamObject(DARK));
const fileDarkFlate = onePage(flateObject(DARK));

// Unknown: a content this reader cannot judge, each a page that may well be dark.
const UNKNOWN: [string, string][] = [
	["LZW content", onePage(`<< /Length 8 /Filter /LZWDecode >>\nstream\n\x80\x0b\x60\x50\x22\x0c\x0c\x85\nendstream`)],
	["content that will not inflate", onePage(`<< /Length 12 /Filter /FlateDecode >>\nstream\n\x78\x9c\xff\xff\xff\xff\x00\x01\x02\x03\x04\x05\nendstream`)],
	[
		"a form drawn with Do",
		onePage(streamObject("q /Fm0 Do Q"), "/Resources << /XObject << /Fm0 5 0 R >> >> ", [
			`<< /Type /XObject /Subtype /Form /BBox [0 0 612 792] /Length ${DARK.length} >>\nstream\n${DARK}\nendstream`,
		]),
	],
	[
		"a shading painted with sh",
		onePage(streamObject("/Sh0 sh"), "/Resources << /Shading << /Sh0 << /ShadingType 2 /ColorSpace /DeviceGray /Coords [0 0 612 0] /Function << /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [0.1] /N 1 >> >> >> >> "),
	],
	[
		"an image drawn with Do (a scan)",
		onePage(streamObject("q 612 0 0 792 0 0 cm /Im0 Do Q"), "/Resources << /XObject << /Im0 5 0 R >> >> ", [
			"<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n\xff\nendstream",
		]),
	],
];

// Light by the file's own content, under resources of every shape the group copies from.
const TEXT = "BT /F1 12 Tf 72 720 Td (hello) Tj ET";
const LIGHT: [string, string][] = [
	["an empty page", document(1)],
	["a text page", onePage(streamObject(TEXT))],
	["a shared resources object", document(1, () => "/Resources 5 0 R /Contents 4 0 R ", "", [streamObject(TEXT), "<< /Font << /F1 9 0 R >> >>"])],
	[
		"an indirect /ExtGState using the writer's name",
		document(1, () => "/Resources << /ExtGState 5 0 R >> /Contents 4 0 R ", "", [streamObject(TEXT), "<< /HwAlpha << /ca 1 >> >>"]),
	],
	["inherited resources", document(1, () => "/Contents 4 0 R ", "/Resources << /Font << /F1 9 0 R >> >> ", [streamObject(TEXT)])],
	["turned with content", document(1, () => "/Rotate 90 /Contents 4 0 R ", "", [streamObject(TEXT)], "[30 40 430 740]")],
];

const MODES: PdfPageAssumption[] = ["darken", "keep", "lighten"];

describe("a page the file draws dark takes the group with no blend mode", () => {
	it.each<PdfPageAssumption>(MODES)("%s: one group, no multiply, byte for byte", (mode) => {
		expectPlainGroup(flatten(fileDark, inkOn(1), mode), 1, 3);
		pinned(PLAIN_GROUP, `file-dark page, ${mode}`, sha(fileDark, inkOn(1), mode));
	});

	it("darken, content compressed: one group, no multiply, byte for byte", () => {
		expectPlainGroup(flatten(fileDarkFlate, inkOn(1), "darken"), 1, 3);
		pinned(PLAIN_GROUP, "file-dark page, compressed, darken", sha(fileDarkFlate, inkOn(1), "darken"));
	});

	it("pen ink on it is the same pen ink, drawn last", () => {
		const penOnly = inkStream(flatten(fileDark, penOn(1), "darken"), 3);
		const prefix = "q 1 0 0 -1 0 792 cm ";
		expect(penOnly.startsWith(prefix) && penOnly.endsWith("Q")).toBe(true);
		const penRun = penOnly.slice(prefix.length, -1);
		const ink = inkStream(flatten(fileDark, inkOn(1), "darken"), 3);
		expect(ink.split(penRun).length - 1, "the pen run is there once, token for token").toBe(1);
		expect(ink.endsWith(`${penRun}Q`), "and closes the stream").toBe(true);
	});

	it("a pen-only page writes what it always wrote", () => {
		pinned(PUBLISHED, "pen only, file-dark page, darken", sha(fileDark, penOn(1), "darken"));
	});
});

describe("the dark line is the screen's: the mean under one half", () => {
	it("a full page at #7F7F7F is dark: no multiply, byte for byte", () => {
		const src = onePage(streamObject("0.498 0.498 0.498 rg 0 0 612 792 re f"));
		expectPlainGroup(flatten(src, inkOn(1), "darken"), 1, 3);
		pinned(PLAIN_GROUP, "#7F7F7F page, darken", sha(src, inkOn(1), "darken"));
	});

	it("a full page at #808080 is light: the group, byte for byte", () => {
		const src = onePage(streamObject("0.502 0.502 0.502 rg 0 0 612 792 re f"));
		expectGroup(flatten(src, inkOn(1), "darken"), 1, 3);
		pinned(GROUP, "#808080 page, darken", sha(src, inkOn(1), "darken"));
	});

	it("a half-page #111111 band on white is light by the mean: the group", () => {
		const src = onePage(streamObject("0.067 0.067 0.067 rg 0 396 612 396 re f"));
		expectGroup(flatten(src, inkOn(1), "darken"), 1, 3);
		pinned(GROUP, "half-page #111111 band, darken", sha(src, inkOn(1), "darken"));
	});

	it("the same fill in grey, a full-page path of curves and lines, reads as the rectangle does", () => {
		const dark = "0.3 g 0 0 m 612 0 l 612 792 l 0 792 l h f";
		const light = "0.7 g 0 0 m 306 0 306 0 612 0 c 612 792 l 0 792 l h f";
		expectPlainGroup(flatten(onePage(streamObject(dark)), inkOn(1), "darken"), 1, 3);
		expectGroup(flatten(onePage(streamObject(light)), inkOn(1), "darken"), 1, 3);
	});

	// Coverage is over the box the viewer shows, the crop box here: the
	// lower half of the paper.
	it("a black fill over the whole crop box is dark: no multiply", () => {
		const inside = onePage(streamObject("0 g 0 0 612 396 re f"), "/CropBox [0 0 612 396] ");
		expectPlainGroup(flatten(inside, inkOn(1), "darken"), 1, 3);
		pinned(PLAIN_GROUP, "dark inside the crop box, darken", sha(inside, inkOn(1), "darken"));
	});

	it("a black fill outside the crop box does not count: the group", () => {
		const outside = onePage(streamObject("0 g 0 396 612 396 re f"), "/CropBox [0 0 612 396] ");
		expectGroup(flatten(outside, inkOn(1), "darken"), 1, 3);
		pinned(GROUP, "dark outside the crop box, darken", sha(outside, inkOn(1), "darken"));
	});
});

describe("a page whose shade its content does not say takes the group with no blend mode", () => {
	const cases = UNKNOWN.flatMap(([name, src]) => MODES.map((mode) => [name, mode, src] as [string, PdfPageAssumption, string]));

	it.each(cases)("%s, %s: no multiply", (_name, mode, src) => {
		expectPlainGroup(flatten(src, inkOn(1), mode), 1, 3);
	});

	it.each(cases)("%s, %s: byte for byte", (name, mode, src) => {
		pinned(PLAIN_GROUP, `${name}, ${mode}`, sha(src, inkOn(1), mode));
	});

	it("content over the size cap is not opened, and takes no multiply", () => {
		const src = onePage(`<< /Length 5000000 /Filter /FlateDecode >>\nstream\n${zlibStored(DARK)}\nendstream`);
		const doc = flatten(src, inkOn(1), "darken");
		expect(inflates.n, "nothing inflated").toBe(0);
		expectPlainGroup(doc, 1, 3);
	});
});

describe("a page drawn black under each condition the reader cannot judge is never read as light", () => {
	// Each page below is dark to a reader's eye, and each would read as light to a reader that judged it without the
	// guard named: the condition is what makes it dark. So each must take no multiply. Defect: a guard lost, the page
	// read as light, the multiply laid over black and the band gone.
	const BLACK = "0 g 0 0 612 792 re f";
	const GUARDS: [string, string][] = [
		[
			"a white fill under an alpha of 0.1 over black (transparency)",
			onePage(streamObject(`${BLACK} /Gt gs 1 g 0 0 612 792 re f`), "/Resources << /ExtGState << /Gt << /ca 0.1 >> >> >> "),
		],
		[
			"a white fill under a difference blend over white (a blend)",
			onePage(streamObject(`1 g 0 0 612 792 re f /Gd gs 1 g 0 0 612 792 re f`), "/Resources << /ExtGState << /Gd << /BM /Difference >> >> >> "),
		],
		[
			"a white fill under a soft mask over black (a soft mask)",
			onePage(streamObject(`${BLACK} /Gm gs 1 g 0 0 612 792 re f`), "/Resources << /ExtGState << /Gm << /SMask << /S /Luminosity /G 5 0 R >> >> >> >> ", [
				`<< /Type /XObject /Subtype /Form /BBox [0 0 612 792] /Group << /S /Transparency /CS /DeviceGray >> /Length ${BLACK.length} >>\nstream\n${BLACK}\nendstream`,
			]),
		],
		["a white fill clipped to a small triangle over black (a clip that is not a rectangle)", onePage(streamObject(`${BLACK} q 10 10 m 30 10 l 20 30 l h W n 1 g 0 0 612 792 re f Q`))],
		["a white fill clipped to one glyph over black (a text clip)", onePage(streamObject(`${BLACK} q BT 7 Tr /F1 12 Tf 72 720 Td (a) Tj ET 1 g 0 0 612 792 re f Q`))],
		["a CMYK black fill", onePage(streamObject("0 0 0 1 k 0 0 612 792 re f"))],
		["a black fill painted by an operator the reader does not know", onePage(streamObject("0 g 0 0 612 792 re Fz"))],
	];

	it.each(GUARDS)("%s: no multiply", (_name, src) => {
		const r = reached(flatten(src, inkOn(1), "darken"), 1, 3);
		expect(r.states.length, "the highlights name a state").toBeGreaterThan(0);
		for (const s of r.states) expect(s.dict.get("/BM"), `${s.name}: blend`).not.toBe("/Multiply");
	});
});

describe("a page the file draws light keeps the group, byte for byte", () => {
	const cases = LIGHT.flatMap(([name, src]) => (["darken", "keep"] as PdfPageAssumption[]).map((mode) => [name, mode, src] as [string, PdfPageAssumption, string]));

	it.each(cases)("%s, %s", (name, mode, src) => {
		expectGroup(flatten(src, inkOn(1), mode), 1, 3);
		pinned(GROUP, `${name}, ${mode}`, sha(src, inkOn(1), mode));
	});
});

describe("a file with a light page and a dark one: each page reaches its own", () => {
	// Page 3 and page 4 share their resources the way real files do; one is
	// drawn dark (object 6) and the other light (object 7). Object 9 is not in
	// the file. Each page's group goes in a /Resources of the page's own, so no
	// object the file had is rewritten.
	const pair = (dark: 1 | 2, res: (i: number) => string, tree: string, shared: readonly string[]): string =>
		document(2, (i) => `${res(i)}/Contents ${i + 1 === dark ? 6 : 7} 0 R `, tree, [
			...(shared.length > 0 ? [shared[0]!] : ["<< >>"]),
			streamObject(DARK),
			streamObject(TEXT),
			...shared.slice(1),
		]);
	const shapes: [string, (dark: 1 | 2) => string][] = [
		["one resources object shared by both pages", (d) => pair(d, () => "/Resources 5 0 R ", "", ["<< /Font << /F1 9 0 R >> >>"])],
		[
			"an indirect /ExtGState shared by both pages",
			(d) => pair(d, (i) => `/Resources << /ExtGState 5 0 R /Font << /F${i} 9 0 R >> >> `, "", ["<< /GS0 << /ca 1 >> >>"]),
		],
		[
			"an indirect /ExtGState that already uses the writer's name",
			(d) => pair(d, () => "/Resources << /ExtGState 5 0 R >> ", "", ["<< /HwAlpha << /ca 1 >> >>"]),
		],
		["resources inherited from the page tree", (d) => pair(d, () => "", "/Resources << /Font << /F1 9 0 R >> >> ", [])],
		[
			"a shared resources object whose /ExtGState is indirect too",
			(d) => pair(d, () => "/Resources 5 0 R ", "", ["<< /ExtGState 8 0 R /XObject << /Im0 9 0 R >> >>", "<< /GS0 << /ca 1 >> >>"]),
		],
	];
	const cases = shapes.flatMap(([name, make]) => ([1, 2] as const).map((dark) => [name, dark, make(dark)] as [string, 1 | 2, string]));

	it.each(cases)("%s, dark page %s", (_name, dark, src) => {
		// Defect: one state shared by the two kinds of group, so whichever page comes first sets the blend for both.
		const strokes = [...inkOn(1), ...inkOn(2)];
		const doc = flatten(src, strokes, "darken");
		const light = dark === 1 ? 2 : 1;
		const plain = expectPlainGroup(doc, dark, dark + 2);
		const g = expectGroup(doc, light, light + 2);
		expect(plain.state, "the two pages reach two different states").not.toBe(g.state);
		expect(plain.form, "the two pages reach two different groups").not.toBe(g.form);
		const before = readPdf(bytes(src));
		if (!before.ok) throw new Error(before.reason);
		for (const n of before.value.offsets.keys()) {
			if (n === 3 || n === 4) continue;
			expect(objectBody(doc, n), `object ${n} is unchanged`).toBe(objectBody(before.value, n));
		}
		// Every name each page reached before, it still reaches, to the same value.
		for (const index of [1, 2]) {
			const was = finalResources(before.value, index);
			const now = finalResources(doc, index);
			for (const [key, value] of was) {
				if (key !== "/ExtGState" && key !== "/XObject") {
					expect(now.get(key), `page ${index} ${key}`).toBe(value);
					continue;
				}
				const nowNames = dictEntries(deref(doc, now.get(key)) ?? "<< >>");
				for (const [k, v] of dictEntries(deref(before.value, value) ?? "<< >>")) expect(nowNames.get(k), `page ${index} ${key} ${k}`).toBe(v);
			}
		}
	});
});

describe("the copy opens only the streams it has to", () => {
	it("lighten opens nothing", () => {
		write(fileDarkFlate, inkOn(1), "lighten");
		expect(inflates.n).toBe(0);
	});

	it("a pen-only page opens nothing", () => {
		write(fileDarkFlate, penOn(1), "darken");
		expect(inflates.n).toBe(0);
	});

	it("one inflate per content stream of each highlighted page, none for the others", () => {
		// Pages 3 and 4 highlighted, page 5 pen only, each with its own compressed content.
		const src = document(3, (i) => `/Contents ${6 + i} 0 R `, "", [flateObject(DARK), flateObject(TEXT), flateObject(DARK)]);
		const doc = flatten(src, [...inkOn(1), ...inkOn(2), ...penOn(3)], "darken");
		expect(inflates.n).toBe(2);
		expectPlainGroup(doc, 1, 3);
		expectGroup(doc, 2, 4);
	});

	it("two content streams are two inflates; a picture's stream is never opened", () => {
		const src = document(
			1,
			() => "/Contents [4 0 R 5 0 R] /Resources << /XObject << /Im0 6 0 R >> >> ",
			"",
			[
				flateObject("1 g 0 0 612 792 re f"),
				flateObject("q 612 0 0 792 0 0 cm /Im0 Do Q"),
				`<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${zlibStored("\x00").length} >>\nstream\n${zlibStored("\x00")}\nendstream`,
			]
		);
		const doc = flatten(src, inkOn(1), "darken");
		expect(inflates.n).toBe(2);
		expectPlainGroup(doc, 1, 3);
	});
});

// sha256 of each file as the published 1.5.1 writer (53b1bd7f) made it.
const PUBLISHED: Record<string, string> = {
	"pen only, file-dark page, darken": "c3090ca1f134bcd79cca2d15d536394931e536b61f95970997fa92f830ced9ff",
};

// sha256 of each file as this writer makes it: the group with no blend mode, which no earlier writer laid.
const PLAIN_GROUP: Record<string, string> = {
	"#7F7F7F page, darken": "e649663dfd5ee65dabe5b554618a708d30aa45389d755b093b1cb5967be2b438",
	"LZW content, darken": "1fc69d4fae947f9d9464cc02a1f41dedd376bf56a135d8f1dcbd4471416e25a3",
	"LZW content, keep": "1fc69d4fae947f9d9464cc02a1f41dedd376bf56a135d8f1dcbd4471416e25a3",
	"LZW content, lighten": "38b3dd04e21cfae189aa2746feb495bde4e7ee529c41e0ac8f8e634ac93ee29d",
	"a form drawn with Do, darken": "fe54698b49cb5f4fe58da938a754196adf57a49c90310bd2c5c0b5bac29f32f4",
	"a form drawn with Do, keep": "fe54698b49cb5f4fe58da938a754196adf57a49c90310bd2c5c0b5bac29f32f4",
	"a form drawn with Do, lighten": "99b629de4067daccb07b232c593bc231da6bcaa78fa7f9860e6ac9534641a112",
	"a shading painted with sh, darken": "58ff5307c01ab6e10af8d27192ca487a4bd27ad511133a16f02e06cfdeed4d06",
	"a shading painted with sh, keep": "58ff5307c01ab6e10af8d27192ca487a4bd27ad511133a16f02e06cfdeed4d06",
	"a shading painted with sh, lighten": "e60ce0323c802b3adb0430e3da7eba67ca57cc6a3481a1b3e61c72ee2cb450e0",
	"an image drawn with Do (a scan), darken": "6c851d3233cd3409e98aca6bedf56f2c18ad6f40ec40c486660ea8cf5de6b19b",
	"an image drawn with Do (a scan), keep": "6c851d3233cd3409e98aca6bedf56f2c18ad6f40ec40c486660ea8cf5de6b19b",
	"an image drawn with Do (a scan), lighten": "24f84f509e94a35a43ee4a1ef27d426a6f418c4129da93754fe5c276233fe03e",
	"content that will not inflate, darken": "5845160fa776fa07585bae6ac08658ab953705701540aa361ca0ceae3731ff06",
	"content that will not inflate, keep": "5845160fa776fa07585bae6ac08658ab953705701540aa361ca0ceae3731ff06",
	"content that will not inflate, lighten": "fa8c3ca3f83ed1e43788dd608b2665c200b5baa56eda51e4b32154fc26c6e204",
	"dark inside the crop box, darken": "091bb9fd8ec35c8c40e5975222c91673a2f6683c668cf6ba221b02a7adfd580b",
	"file-dark page, compressed, darken": "6722d20b27315326533e670e5f8d9c6d663cdd52549beb46c22daa21913e2a0c",
	"file-dark page, darken": "982a3ad1fe275ebe25ecefcb198d036614a791441dc651528c08ccd0a789dd37",
	"file-dark page, keep": "982a3ad1fe275ebe25ecefcb198d036614a791441dc651528c08ccd0a789dd37",
	"file-dark page, lighten": "df38fcf65e231040fcff11c98776fb145dbae6dadabd1c7bc899dd9d9ac9debf",
};

// sha256 of each file as the 1.5.2 writer before this change (cef861e0) made it: every page grouped.
const GROUP: Record<string, string> = {
	"#808080 page, darken": "41d30927b5ed86e8a4165fd29b6380293452f8cfbc739b396a8660f94cdbbc20",
	"a shared resources object, darken": "6cf154c9b57e183f73261aa7f6e984b9483174be68a030bb97b9b294cc14b101",
	"a shared resources object, keep": "6cf154c9b57e183f73261aa7f6e984b9483174be68a030bb97b9b294cc14b101",
	"a text page, darken": "699e3adae2a5124cb3b786f84a036b5a2dc54fdbc20b3d2a9254c90cd70c5156",
	"a text page, keep": "699e3adae2a5124cb3b786f84a036b5a2dc54fdbc20b3d2a9254c90cd70c5156",
	"an empty page, darken": "d5c1ea5d9ba87c83be7cdf802bcdfbf75cf32b8120853825a7e8a5b170ec2aec",
	"an empty page, keep": "d5c1ea5d9ba87c83be7cdf802bcdfbf75cf32b8120853825a7e8a5b170ec2aec",
	"an indirect /ExtGState using the writer's name, darken": "b88f482a2fdf69f757989ccc4ccdb5fce4c26f136b8e2fc6b5163fb485487b06",
	"an indirect /ExtGState using the writer's name, keep": "b88f482a2fdf69f757989ccc4ccdb5fce4c26f136b8e2fc6b5163fb485487b06",
	"dark outside the crop box, darken": "e426bb82bd14e9fbc8ca4d4e514049555bb41ad766455313000b0a3be76f1401",
	"half-page #111111 band, darken": "7418c3b692776a76c26c3b6861fb80dd04f84305b60642dbd44ef445b632f2cb",
	"inherited resources, darken": "973035fe234977b2b10e0b38b7dc33f1f5309744aefed47eb10fbdda24b00f36",
	"inherited resources, keep": "973035fe234977b2b10e0b38b7dc33f1f5309744aefed47eb10fbdda24b00f36",
	"turned with content, darken": "7e882e8ee04bef03ad09b9f2df52195ef19024d2bcf70713d9842f29a77781c8",
	"turned with content, keep": "7e882e8ee04bef03ad09b9f2df52195ef19024d2bcf70713d9842f29a77781c8",
};
