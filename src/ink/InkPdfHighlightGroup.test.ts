/**
 * Highlights in a flattened PDF, judged the way a reader meets them.
 *
 * On screen a page's saved highlights are one layer: each stroke opaque on a
 * canvas of its own, and that canvas laid on the page once, multiplied at the
 * highlighter's alpha (PdfInkBand.ts, HighlightLayer). The flattened copy says
 * the same thing in PDF terms: one transparency group per highlighted page,
 * drawn once under a multiply state, with every highlighter stroke its own
 * opaque fill inside it. Nothing here trusts the writer's own bookkeeping:
 * each name is followed from the page's content stream through the page's
 * final /Resources to the object it lands on, as a reader would.
 *
 * Under "Lighten for dark pages" every page takes the same group with no
 * blend mode (InkPdfCrossingCoat.test.ts). Pages with pen ink only are not
 * this path: their bytes are pinned to what the writer produced before the
 * group.
 */

import { describe, expect, it } from "vitest";
import { InkStroke, computeBBox } from "./Stroke";
import { appendInkToPdf } from "./InkPdfAppend";
import { PdfPageAssumption, inkToPdf, pdfColor, pdfNum, pdfPageDestination } from "./InkPdf";
import { HIGHLIGHTER_ALPHA } from "./PenStyle";
import { PdfDoc, asRef, deref, dictEntries, numbersIn, objectBody, pdfPages, readPdf } from "../pdf/PdfSyntax";
import { sha256 } from "../pdf/Sha256";
import { document, streamObject } from "../../test/pdf-fixture";

const YELLOW = "#ffd60a";
const BLUE = "#4bc8ff";

let ids = 0;
function stroke(
	page: number,
	tool: "pen" | "highlighter",
	color: string,
	at: readonly [number, number][] = [
		[100, 200],
		[160, 204],
		[220, 208],
	]
): InkStroke {
	const points = at.map(([x, y], i) => ({ x, y, pressure: 0.5, t: i * 8 }));
	return {
		id: `s-${++ids}`,
		tool,
		color,
		width: tool === "highlighter" ? 18 : 3,
		points,
		bbox: computeBBox(points, tool === "highlighter" ? 18 : 3),
		createdAt: 0,
		page,
	};
}

const hl = (page: number, color = YELLOW, at?: readonly [number, number][]): InkStroke =>
	stroke(page, "highlighter", color, at);
const pen = (page: number): InkStroke => stroke(page, "pen", "#202020");

function bytes(src: string): Uint8Array {
	const out = new Uint8Array(src.length);
	for (let i = 0; i < src.length; i++) out[i] = src.charCodeAt(i) & 0xff;
	return out;
}

function flatten(src: string, strokes: readonly InkStroke[], mode: PdfPageAssumption = "darken"): PdfDoc {
	const r = appendInkToPdf(bytes(src), strokes, mode);
	if (!r.ok) throw new Error(`unexpected refusal: ${r.reason}`);
	const doc = readPdf(r.bytes);
	if (!doc.ok) throw new Error(`the result does not read back: ${doc.reason}`);
	return doc.value;
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

/** The page's own ink: the last stream in its content list. */
function inkStream(doc: PdfDoc, pageNum: number): string {
	const contents = dictEntries(objectBody(doc, pageNum)!).get("/Contents")!;
	const refs = contents.match(/\d+ 0 R/g) ?? [];
	return streamData(doc, asRef(refs[refs.length - 1])!);
}

/** The /Resources a reader uses for page `index`: the page's own or inherited, followed. */
function finalResources(doc: PdfDoc, index: number): Map<string, string> {
	const pages = pdfPages(doc);
	if (!pages.ok) throw new Error(pages.reason);
	const res = deref(doc, pages.value[index - 1]!.resources ?? undefined);
	if (res === null) throw new Error(`page ${index} reaches no resources`);
	return dictEntries(res);
}

/** Names used with an operator in a content stream, in order. */
function named(content: string, op: "gs" | "Do"): string[] {
	return [...content.matchAll(new RegExp(`(/[^\\s/\\[\\]<>()]+)\\s+${op}(?=\\s|$)`, "g"))].map((m) => m[1]!);
}

/** The colour each `f` fills with, in stream order. */
function fillColours(content: string): string[] {
	const tokens = content.split(/\s+/).filter((t) => t !== "");
	const out: string[] = [];
	let colour = "";
	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i] === "rg") colour = tokens.slice(i - 3, i).join(" ");
		if (tokens[i] === "f") out.push(colour);
	}
	return out;
}

/** Every `f` closes a path of its own: the token before it is `h`. */
function bareFills(content: string): number {
	const tokens = content.split(/\s+/).filter((t) => t !== "");
	return tokens.filter((t, i) => t === "f" && tokens[i - 1] !== "h").length;
}

/** What one highlighted page draws its highlights with, followed from its stream. */
function groupOf(doc: PdfDoc, index: number, pageNum: number) {
	const ink = inkStream(doc, pageNum);
	const states = named(ink, "gs");
	const forms = named(ink, "Do");
	const res = finalResources(doc, index);
	const gsDict = deref(doc, res.get("/ExtGState"));
	const xoDict = deref(doc, res.get("/XObject"));
	const stateRef = states.length === 1 && gsDict !== null ? dictEntries(gsDict).get(states[0]!) : undefined;
	const formRef = forms.length === 1 && xoDict !== null ? dictEntries(xoDict).get(forms[0]!) : undefined;
	const formNum = asRef(formRef);
	return {
		ink,
		states,
		forms,
		state: deref(doc, stateRef),
		formNum,
		form: formNum === null ? null : objectBody(doc, formNum),
		formStream: formNum === null ? null : streamData(doc, formNum),
	};
}

const colourOf = (s: InkStroke, mode: PdfPageAssumption = "darken"): string =>
	pdfColor(s.tool, s.color, pdfPageDestination(mode));

describe("a flattened page's highlights are one group, laid on once", () => {
	it("draws the group under a multiply state at the highlighter's alpha, and the group itself names no state", () => {
		const doc = flatten(document(1), [hl(1)]);
		const g = groupOf(doc, 1, 3);
		expect(g.states, "one state named on the page").toHaveLength(1);
		expect(g.forms, "one group drawn on the page").toHaveLength(1);
		const state = dictEntries(g.state ?? "<< >>");
		expect(state.get("/BM")).toBe("/Multiply");
		expect(state.get("/ca")).toBe(pdfNum(HIGHLIGHTER_ALPHA));
		const form = dictEntries(g.form ?? "<< >>");
		expect(form.get("/Subtype")).toBe("/Form");
		const group = dictEntries(form.get("/Group") ?? "<< >>");
		expect(group.get("/S")).toBe("/Transparency");
		expect(group.get("/I")).toBe("true");
		// A group starts from the default state: alpha and blend belong to the
		// one draw of it, never inside, or the wash would be applied twice.
		expect(dictEntries(form.get("/Resources") ?? "missing").size).toBe(0);
		expect(named(g.formStream ?? "", "gs")).toEqual([]);
	});

	it("fills every highlighter stroke on its own, in the order drawn, with no fill left without a path", () => {
		const first = hl(1, YELLOW, [[100, 200], [300, 200]]);
		const crossing = hl(1, YELLOW, [[200, 120], [200, 280]]);
		const blue = hl(1, BLUE, [[120, 240], [280, 240]]);
		const last = hl(1, YELLOW, [[100, 260], [300, 260]]);
		const doc = flatten(document(1), [first, crossing, blue, pen(1), last]);
		const g = groupOf(doc, 1, 3);
		expect(fillColours(g.formStream ?? "")).toEqual([first, crossing, blue, last].map((s) => colourOf(s)));
		expect(bareFills(g.formStream ?? "")).toBe(0);
	});

	it("draws pen ink after the group, on the page, never inside it", () => {
		const doc = flatten(document(1), [pen(1), hl(1)]);
		const g = groupOf(doc, 1, 3);
		const penColour = colourOf(pen(1));
		expect(g.ink.indexOf(" Do")).toBeGreaterThan(-1);
		expect(g.ink.indexOf(`${penColour} rg`)).toBeGreaterThan(g.ink.indexOf(" Do"));
		expect(g.formStream ?? "").not.toContain(`${penColour} rg`);
	});

	it.each<[string, PdfPageAssumption]>([
		["darken", "darken"],
		["keep", "keep"],
	])("takes the group when the pages are said to be %s", (_name, mode) => {
		const doc = flatten(document(1), [hl(1)], mode);
		const g = groupOf(doc, 1, 3);
		expect(g.forms).toHaveLength(1);
		expect(dictEntries(dictEntries(g.form ?? "<< >>").get("/Group") ?? "<< >>").get("/S")).toBe("/Transparency");
		expect(fillColours(g.formStream ?? "")).toEqual([colourOf(hl(1), mode)]);
	});

	it("under Lighten for dark pages, takes the same group with no blend mode", () => {
		const doc = flatten(document(1), [hl(1)], "lighten");
		const g = groupOf(doc, 1, 3);
		expect(g.forms, "one group drawn on the page").toHaveLength(1);
		expect(g.states, "one state named on the page").toHaveLength(1);
		expect(dictEntries(g.state ?? "<< >>").has("/BM"), "no blend mode").toBe(false);
		expect(dictEntries(g.state ?? "<< >>").get("/ca")).toBe(pdfNum(HIGHLIGHTER_ALPHA));
		expect(fillColours(g.formStream ?? "")).toEqual([colourOf(hl(1), "lighten")]);
	});
});

describe("each highlighted page reaches its own group through its own resources", () => {
	// Two pages, different highlights: page 1 one yellow stroke, page 2 two
	// blue ones and a pen line. Whatever the resources look like in the file,
	// each page must draw its own. Object 90 is not in the file: a name that
	// points past every object, so no new object can take its number.
	const strokes = (): InkStroke[] => [hl(1, YELLOW), hl(2, BLUE), hl(2, BLUE, [[90, 300], [300, 320]]), pen(2)];
	const want = (s: readonly InkStroke[], page: number): string[] =>
		s.filter((x) => x.page === page && x.tool === "highlighter").map((x) => colourOf(x));

	it.each<[string, string]>([
		["one resources object shared by both pages", document(2, () => "/Resources 5 0 R ", "", ["<< /Font << /F1 90 0 R >> >>"])],
		[
			"one /XObject dictionary shared by both pages' resources",
			document(2, (i) => `/Resources << /XObject 5 0 R /Font << /F${i} 90 0 R >> >> `, "", ["<< /Im0 90 0 R >>"]),
		],
		["resources inherited from the page tree", document(2, () => "", "/Resources << /Font << /F1 90 0 R >> /ExtGState << /GS0 << /ca 1 >> >> >> ")],
		[
			"an indirect /ExtGState that already uses the writer's name",
			document(2, () => "/Resources << /ExtGState 5 0 R >> ", "", ["<< /HwAlpha << /ca 1 >> >>"]),
		],
		[
			"a shared resources object whose /ExtGState is indirect too",
			document(2, () => "/Resources 5 0 R ", "", ["<< /ExtGState 6 0 R /XObject << /Im0 90 0 R >> >>", "<< /GS0 << /ca 1 >> >>"]),
		],
	])("%s", (_name, src) => {
		const s = strokes();
		const doc = flatten(src, s);
		const one = groupOf(doc, 1, 3);
		const two = groupOf(doc, 2, 4);
		for (const [g, page] of [[one, 1], [two, 2]] as const) {
			expect(g.states, `page ${page}: one state`).toHaveLength(1);
			expect(g.forms, `page ${page}: one group`).toHaveLength(1);
			expect(dictEntries(g.state ?? "<< >>").get("/BM"), `page ${page}: the state it names is the multiply`).toBe("/Multiply");
			expect(fillColours(g.formStream ?? ""), `page ${page}: the group holds this page's highlights`).toEqual(want(s, page));
		}
		expect(one.formNum).not.toBe(two.formNum);
		// The original file's own objects are read, never rewritten: only the
		// two pages change, and each says what it reaches on itself.
		const before = readPdf(bytes(src));
		if (!before.ok) throw new Error(before.reason);
		for (const n of before.value.offsets.keys()) {
			if (n === 3 || n === 4) continue;
			expect(objectBody(doc, n), `object ${n} is unchanged`).toBe(objectBody(before.value, n));
		}
		// Every name the page reached before, it still reaches, to the same value.
		for (const index of [1, 2]) {
			const was = finalResources(before.value, index);
			const now = finalResources(doc, index);
			for (const [key, value] of was) {
				if (key !== "/ExtGState" && key !== "/XObject") {
					expect(now.get(key), `page ${index} ${key}`).toBe(value);
					continue;
				}
				const nowNames = dictEntries(deref(doc, now.get(key)) ?? "<< >>");
				for (const [k, v] of dictEntries(deref(before.value, value) ?? "<< >>")) {
					expect(nowNames.get(k), `page ${index} ${key} ${k}`).toBe(v);
				}
			}
		}
	});

	it("leaves a page with pen ink only exactly as it was, beside a highlighted one", () => {
		const both = flatten(document(2), [pen(1), hl(2)]);
		const penOnly = flatten(document(2), [pen(1)]);
		expect(dictEntries(objectBody(both, 3)!).has("/Resources")).toBe(false);
		expect(inkStream(both, 3)).toBe(inkStream(penOnly, 3));
	});
});

describe("the group sits on the page as the viewer showed it", () => {
	/** The six numbers before each `cm`, in stream order. */
	function matrices(content: string): number[][] {
		return [...content.matchAll(/((?:-?[\d.]+\s+){6})cm(?=\s|$)/g)].map((m) => numbersIn(m[1]!));
	}

	/** A point through a stream's matrices: the last one written is the first it meets. */
	function through(ms: readonly number[][], x: number, y: number): [number, number] {
		let [px, py] = [x, y];
		for (let i = ms.length - 1; i >= 0; i--) {
			const [a, b, c, d, e, f] = ms[i]!;
			[px, py] = [px * a! + py * c! + e!, px * b! + py * d! + f!];
		}
		return [px, py];
	}

	it.each([0, 90, 180, 270])("rotate %s on a box that is not square and not at the origin", (rotate) => {
		const box = { x: 30, y: 40, w: 400, h: 700 };
		const turned = rotate % 180 !== 0;
		const [W, H] = turned ? [box.h, box.w] : [box.w, box.h];
		const corners: [number, number][] = [
			[2, 2],
			[W - 2, 2],
			[W - 2, H - 2],
			[2, H - 2],
		];
		const doc = flatten(
			document(1, () => `/Rotate ${rotate} `, "", [], `[${box.x} ${box.y} ${box.x + box.w} ${box.y + box.h}]`),
			[hl(1, YELLOW, corners)]
		);
		const g = groupOf(doc, 1, 3);
		// The group is drawn in the page's own space: no matrix before it.
		expect(g.ink.slice(0, Math.max(0, g.ink.indexOf(" Do")))).not.toMatch(/\scm(\s|$)/);
		const bbox = numbersIn(dictEntries(g.form ?? "<< >>").get("/BBox") ?? "");
		expect(bbox).toHaveLength(4);
		const [x0, y0, x1, y1] = bbox as [number, number, number, number];
		const ms = matrices(g.formStream ?? "");
		for (const [x, y] of corners) {
			const [px, py] = through(ms, x, y);
			expect(px, `x of ${x},${y} -> ${px},${py} in [${bbox}]`).toBeGreaterThanOrEqual(x0 - 0.01);
			expect(px, `x of ${x},${y} -> ${px},${py} in [${bbox}]`).toBeLessThanOrEqual(x1 + 0.01);
			expect(py, `y of ${x},${y} -> ${px},${py} in [${bbox}]`).toBeGreaterThanOrEqual(y0 - 0.01);
			expect(py, `y of ${x},${y} -> ${px},${py} in [${bbox}]`).toBeLessThanOrEqual(y1 + 0.01);
		}
	});
});

describe("resources this writer cannot read refuse the copy", () => {
	// An /XObject this writer cannot read is not refused: that page keeps the wash (InkPdfCrossingCoat.test.ts).
	it.each<[string, string]>([
		["an /ExtGState that names a missing object", document(1, () => "/Resources << /ExtGState 90 0 R >> ")],
		["/Resources that name a missing object", document(1, () => "/Resources 90 0 R ")],
	])("%s", (_name, src) => {
		const r = appendInkToPdf(bytes(src), [hl(1)]);
		expect(r.ok).toBe(false);
		expect(r.ok || r.reason).toContain("page 1");
	});
});

describe("pages under Lighten for dark pages, and pen-only pages, byte for byte", () => {
	const sha = (src: string, strokes: readonly InkStroke[], mode: PdfPageAssumption): string => {
		const r = appendInkToPdf(bytes(src), strokes, mode);
		if (!r.ok) throw new Error(`unexpected refusal: ${r.reason}`);
		return Array.from(sha256(r.bytes), (b) => b.toString(16).padStart(2, "0")).join("");
	};
	const pinned = (): InkStroke[] => [
		{ ...hl(1, YELLOW), id: "p1" },
		{ ...pen(1), id: "p2" },
		{ ...hl(2, BLUE), id: "p3" },
		{ ...hl(2, YELLOW, [[90, 300], [300, 320]]), id: "p4" },
	];
	const penOnly = (): InkStroke[] => [
		{ ...pen(1), id: "q1" },
		{ ...pen(2), id: "q2" },
	];
	const shared = document(2, () => "/Resources 5 0 R ", "", ["<< /Font << /F1 9 0 R >> >>"]);
	const indirectGs = document(2, () => "/Resources << /ExtGState 5 0 R >> ", "", ["<< /HwAlpha << /ca 1 >> >>"]);
	const inherited = document(2, () => "", "/Resources << /Font << /F1 9 0 R >> >> ");
	const turned = document(2, () => "/Rotate 90 /Contents 5 0 R ", "", [streamObject("BT /F1 12 Tf (hello) Tj ET")], "[30 40 430 740]");

	// Under Lighten every highlighted page is one group with no blend mode,
	// which no earlier writer laid: each file's structure is checked here and
	// its sha256 taken at this writer and pinned.
	it.each<[string, string]>([
		["dark pages, a shared resources object", shared],
		["dark pages, an indirect /ExtGState using the writer's name", indirectGs],
		["dark pages, inherited resources", inherited],
		["dark pages, turned with content", turned],
	])("%s", (name, src) => {
		const doc = flatten(src, pinned(), "lighten");
		for (const [index, num] of [[1, 3], [2, 4]] as const) {
			const g = groupOf(doc, index, num);
			expect(g.forms, `page ${index}: one group`).toHaveLength(1);
			expect(dictEntries(g.state ?? "<< >>").has("/BM"), `page ${index}: no blend mode`).toBe(false);
		}
		const got = sha(src, pinned(), "lighten");
		const want = PLAIN_GROUP[name];
		if (want === undefined) throw new Error(`no pin "${name}": ${got}`);
		expect(got).toBe(want);
	});

	// sha256 of each file as the writer made it before highlights became a
	// group, taken at that writer and pinned.
	it.each<[string, () => string]>([
		["pen only, darken", () => sha(turned, penOnly(), "darken")],
		["pen only, keep", () => sha(shared, penOnly(), "keep")],
		["pen only, lighten", () => sha(indirectGs, penOnly(), "lighten")],
	])("%s", (name, run) => {
		expect(run()).toBe(PINNED[name]);
	});
});

describe("the note export writes what it wrote", () => {
	// A note's own PDF is not a page anyone else drew: it keeps its one
	// wash per colour run, byte for byte. sha256 taken at the writer before
	// flattened highlights became a group, and pinned.
	const note = (): InkStroke[] => [
		{ ...hl(1, YELLOW, [[20, 40], [200, 40]]), id: "n1" },
		{ ...hl(1, BLUE, [[110, 10], [110, 90]]), id: "n2" },
		{ ...hl(1, BLUE, [[60, 20], [160, 80]]), id: "n3" },
		{ ...pen(1), id: "n4" },
	];
	const sha = (pdf: string): string => Array.from(sha256(bytes(pdf)), (b) => b.toString(16).padStart(2, "0")).join("");
	it.each<[string, () => string]>([
		["note export, highlights crossing under pen ink", () => sha(inkToPdf(note()))],
		["note export, dark page colours", () => sha(inkToPdf(note(), pdfPageDestination("lighten")))],
	])("%s", (name, run) => {
		expect(run()).toBe(PINNED[name]);
	});
});

const PINNED: Record<string, string> = {
	"pen only, darken": "58da1e6525e35d6eb495c7f641bd01b9ae38fa9e7c6a970256be742a6bb37267",
	"pen only, keep": "19d11a0805ba878185c4b54e944f90f5ce5a6cfc18357748d8fbe1290c100c67",
	"pen only, lighten": "7703e09cff6020d95a58f0129969063fa916ce092aa31bdf09e732ff2c20e5a0",
	"note export, highlights crossing under pen ink": "f9f8ee4df2a1c8afbebaa3e0f71e811bdf5da56815b44f9cece85b5d8ccd0add",
	"note export, dark page colours": "f99f8f495410d07bcc3d17a15e6d8063f3c9819731caeddac26538d7c7a5bbe0",
};

// sha256 of each file under Lighten as this writer makes it: every page one group with no blend mode.
const PLAIN_GROUP: Record<string, string> = {
	"dark pages, a shared resources object": "96707b7beca747adc3bd1523830a2b6fcdca0b6e11fd2ab74de63ecfc161d888",
	"dark pages, an indirect /ExtGState using the writer's name": "20ccd2c81dac0d2bb678758918727c42fc68ee63bd465e71c128024851c7ac58",
	"dark pages, inherited resources": "ca45b3d82b34f6075e829a1d65e4644a03c6083174bbc63748edc25afe87a22c",
	"dark pages, turned with content": "fc2963e413d615332e586e8571b117d3bc38434d844728fa85d653a40dc79ea2",
};
