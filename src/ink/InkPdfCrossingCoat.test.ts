/**
 * Crossing highlights in a flattened copy of a page that is not read as light: one coat, as the screen lays them.
 *
 * On screen a page's highlights are one layer: each stroke opaque on a canvas of its own, laid on the page once at the
 * highlighter's alpha. On a page the screen reads as light that one draw multiplies; on every other page it blends
 * normal, and under "Lighten for dark pages" every page blends normal. Either way two colours that cross are one coat:
 * the later stroke's colour, at the alpha once.
 *
 * The copy says the same in PDF terms. Every highlighted page writes one transparency group, each highlighter stroke
 * its own opaque fill inside it in the order drawn, drawn once under a state at the highlighter's alpha. The state
 * multiplies only on a page the file's own content reads as light, with the setting not on Lighten
 * (InkPdfDarkPage.test.ts, InkPdfHighlightGroup.test.ts); here, on every other page, it has no blend mode. The wash
 * the copy wrote before (one fill per colour run, each at the alpha, so two colours stack) is written only on a page
 * whose /XObject this writer cannot read, which cannot name a group (the last cells here).
 *
 * Every check follows names from the page's content stream through the resources a reader would use, and into the
 * group's own resources. No cell renders a page: one coat is argued from structure, fills, alpha and blend.
 */

import { describe, expect, it } from "vitest";
import { InkStroke, computeBBox } from "./Stroke";
import { appendInkToPdf } from "./InkPdfAppend";
import { PdfPageAssumption, inkPdfContent, pdfColor, pdfNum, pdfPageDestination, strokePdfOps } from "./InkPdf";
import { HIGHLIGHTER_ALPHA } from "./PenStyle";
import { pageShade } from "./InkPdfPageShade";
import { PdfDoc, asRef, deref, dictEntries, objectBody, pdfPages, readPdf } from "../pdf/PdfSyntax";
import { document, streamObject } from "../../test/pdf-fixture";

const YELLOW = "#ffd60a";
const BLUE = "#4bc8ff";

let ids = 0;
function stroke(page: number, tool: "pen" | "highlighter", color: string, at: readonly [number, number][]): InkStroke {
	const points = at.map(([x, y], i) => ({ x, y, pressure: 0.5, t: i * 8 }));
	const width = tool === "highlighter" ? 18 : 3;
	return { id: `c-${++ids}`, tool, color, width, points, bbox: computeBBox(points, width), createdAt: 0, page };
}

/** Across the page, and down through it: they cross at 200,200. */
const across = (color: string): InkStroke => stroke(1, "highlighter", color, [[100, 200], [200, 200], [300, 200]]);
const down = (color: string): InkStroke => stroke(1, "highlighter", color, [[200, 100], [200, 200], [200, 300]]);
const up = (color: string): InkStroke => stroke(1, "highlighter", color, [[200, 300], [200, 200], [200, 100]]);

function bytes(src: string): Uint8Array {
	const out = new Uint8Array(src.length);
	for (let i = 0; i < src.length; i++) out[i] = src.charCodeAt(i) & 0xff;
	return out;
}

function flatten(src: string, strokes: readonly InkStroke[], mode: PdfPageAssumption): PdfDoc {
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

function finalResources(doc: PdfDoc, index: number): Map<string, string> {
	const pages = pdfPages(doc);
	if (!pages.ok) throw new Error(pages.reason);
	const res = deref(doc, pages.value[index - 1]!.resources ?? undefined);
	return res === null ? new Map() : dictEntries(res);
}

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

/**
 * Every state the page's ink names and every form it draws, followed through the page's final /Resources; and every
 * state a form's own resources hold, where a second alpha or a blend could hide.
 */
function reached(doc: PdfDoc, index: number, pageNum: number) {
	const ink = inkStream(doc, pageNum);
	const res = finalResources(doc, index);
	const gs = dictEntries(deref(doc, res.get("/ExtGState")) ?? "<< >>");
	const xo = dictEntries(deref(doc, res.get("/XObject")) ?? "<< >>");
	const states: { name: string; dict: Map<string, string> }[] = [];
	for (const n of named(ink, "gs")) states.push({ name: n, dict: dictEntries(deref(doc, gs.get(n)) ?? "<< missing >>") });
	const forms: { num: number; dict: Map<string, string>; stream: string }[] = [];
	for (const n of named(ink, "Do")) {
		const num = asRef(xo.get(n));
		if (num === null) continue;
		const dict = dictEntries(objectBody(doc, num) ?? "<< >>");
		forms.push({ num, dict, stream: streamData(doc, num) });
		const formRes = dictEntries(dict.get("/Resources") ?? "<< >>");
		for (const [k, v] of dictEntries(deref(doc, formRes.get("/ExtGState")) ?? "<< >>")) {
			states.push({ name: `form ${num} ${k}`, dict: dictEntries(deref(doc, v) ?? "<< missing >>") });
		}
	}
	return { ink, states, forms };
}

const colourOf = (s: InkStroke, mode: PdfPageAssumption): string => pdfColor(s.tool, s.color, pdfPageDestination(mode));

/**
 * One coat: the page's ink is the one draw (one state, one form, nothing else filled on the page), the state is the
 * highlighter's alpha with no blend mode and no mask, the form is a transparency group with no state of its own, and
 * inside it every highlighter stroke is its own fill, in the order drawn, in the colour that setting writes.
 */
function expectOneCoat(doc: PdfDoc, strokes: readonly InkStroke[], mode: PdfPageAssumption, index = 1, pageNum = 3): void {
	const r = reached(doc, index, pageNum);
	expect(r.forms, "one group drawn on the page").toHaveLength(1);
	expect(r.states, "one state reached: the page's, none inside the group").toHaveLength(1);
	expect(r.ink, "the page draws the group and fills nothing of its own").toMatch(/^q \/\S+ gs \/\S+ Do Q$/);
	const state = r.states[0]!.dict;
	const bm = state.get("/BM");
	expect(bm === undefined || bm === "/Normal", `no blend mode (got ${bm})`).toBe(true);
	expect(state.get("/ca"), "fill alpha").toBe(pdfNum(HIGHLIGHTER_ALPHA));
	expect(state.get("/CA"), "stroke alpha").toBe(pdfNum(HIGHLIGHTER_ALPHA));
	expect(state.has("/SMask"), "no soft mask").toBe(false);
	const form = r.forms[0]!;
	expect(form.dict.get("/Subtype")).toBe("/Form");
	expect(dictEntries(form.dict.get("/Group") ?? "<< >>").get("/S"), "a transparency group").toBe("/Transparency");
	expect(named(form.stream, "gs"), "no state inside the group").toEqual([]);
	const want = strokes.filter((s) => s.page === index && s.tool === "highlighter").map((s) => colourOf(s, mode));
	expect(fillColours(form.stream), "every highlight its own fill, in the order drawn").toEqual(want);
}

const onePage = (content: string, pageExtra = "", after: readonly string[] = []): string =>
	document(1, () => `/Contents 4 0 R ${pageExtra}`, "", [content, ...after]);
const DARK = "0.07 0.07 0.07 rg 0 0 612 792 re f";

/** Every page kind whose crossing was two coats in the copy before. */
const PAGES: [string, string, PdfPageAssumption[]][] = [
	["a page the file draws dark", onePage(streamObject(DARK)), ["darken", "keep", "lighten"]],
	["LZW content (shade unknown)", onePage(`<< /Length 8 /Filter /LZWDecode >>\nstream\n\x80\x0b\x60\x50\x22\x0c\x0c\x85\nendstream`), ["darken", "keep", "lighten"]],
	[
		"a form drawn with Do (shade unknown)",
		onePage(streamObject("q /Fm0 Do Q"), "/Resources << /XObject << /Fm0 5 0 R >> >> ", [
			`<< /Type /XObject /Subtype /Form /BBox [0 0 612 792] /Length ${DARK.length} >>\nstream\n${DARK}\nendstream`,
		]),
		["darken", "keep", "lighten"],
	],
	[
		"a page that is one picture (a scan, shade unknown)",
		onePage(streamObject("q 612 0 0 792 0 0 cm /Im0 Do Q"), "/Resources << /XObject << /Im0 5 0 R >> >> ", [
			"<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n\x00\nendstream",
		]),
		["darken", "keep", "lighten"],
	],
	["a white page under Lighten", document(1), ["lighten"]],
];
const CASES = PAGES.flatMap(([name, src, modes]) => modes.map((mode) => [name, mode, src] as [string, PdfPageAssumption, string]));

describe("two colours crossing on a page not read as light are one coat", () => {
	it.each(CASES)("%s, %s: yellow then blue, the crossing is blue at one coat", (_name, mode, src) => {
		// Defect: the wash, one fill per colour run each under the alpha, so the crossing has two coats; or a group with
		// a multiply, a second alpha inside it, a fill left outside it, or the fills out of order.
		const strokes = [across(YELLOW), down(BLUE)];
		expectOneCoat(flatten(src, strokes, mode), strokes, mode);
	});

	it.each(CASES)("%s, %s: blue then yellow, the crossing is yellow at one coat", (_name, mode, src) => {
		const strokes = [across(BLUE), down(YELLOW)];
		expectOneCoat(flatten(src, strokes, mode), strokes, mode);
	});

	it("pen ink on such a page is drawn after the group, on the page, never inside it", () => {
		const src = onePage(streamObject(DARK));
		const pen = stroke(1, "pen", "#202020", [[90, 210], [160, 214], [310, 218]]);
		const doc = flatten(src, [across(YELLOW), down(BLUE), pen], "darken");
		const r = reached(doc, 1, 3);
		expect(r.forms).toHaveLength(1);
		const penColour = colourOf(pen, "darken");
		expect(r.ink.indexOf(`${penColour} rg`), "pen after the group").toBeGreaterThan(r.ink.indexOf(" Do"));
		expect(r.forms[0]!.stream).not.toContain(`${penColour} rg`);
		expect(fillColours(r.forms[0]!.stream)).toEqual([colourOf(across(YELLOW), "darken"), colourOf(down(BLUE), "darken")]);
	});
});

describe("one band alone keeps the colour and alpha it had", () => {
	it.each<[string, PdfPageAssumption]>([
		["darken", "darken"],
		["keep", "keep"],
		["lighten", "lighten"],
	])("a page the file draws dark, %s: one fill in the colour that setting writes, at the highlighter's alpha", (_n, mode) => {
		const strokes = [across(YELLOW)];
		expectOneCoat(flatten(onePage(streamObject(DARK)), strokes, mode), strokes, mode);
	});
});

describe("colour as written", () => {
	it("two stored colours that write as one are still one group, one colour setting, two fills", () => {
		const a = across("#ffd60a");
		const b = down("#FFD60A");
		expect(colourOf(a, "darken"), "precondition: they write as one").toBe(colourOf(b, "darken"));
		const doc = flatten(onePage(streamObject(DARK)), [a, b], "darken");
		expectOneCoat(doc, [a, b], "darken");
		const form = reached(doc, 1, 3).forms[0]!.stream;
		expect(form.split(/\s+/).filter((t) => t === "rg"), "one colour setting").toHaveLength(1);
	});

	it("yellow, blue, yellow, the two yellows crossing: one group, three fills in that order", () => {
		const strokes = [across(YELLOW), stroke(1, "highlighter", BLUE, [[100, 260], [300, 260]]), down(YELLOW)];
		expectOneCoat(flatten(onePage(streamObject(DARK)), strokes, "darken"), strokes, "darken");
	});
});

/** The state a name reaches through a page's final /ExtGState, and the object it is. */
function stateOf(doc: PdfDoc, index: number, name: string): { num: number | null; dict: Map<string, string> } {
	const gs = dictEntries(deref(doc, finalResources(doc, index).get("/ExtGState")) ?? "<< >>");
	const value = gs.get(name);
	return { num: asRef(value), dict: dictEntries(deref(doc, value) ?? "<< missing >>") };
}

/**
 * The wash, as the copy wrote it before the group: no group drawn on the page, every highlight a fill of the page's
 * own ink in the order drawn, under one state at the highlighter's alpha with no blend mode and no mask; and the
 * page's /XObject entry exactly as the file wrote it. Returns the state's object number.
 */
function expectWash(doc: PdfDoc, before: PdfDoc, strokes: readonly InkStroke[], mode: PdfPageAssumption, index: number, pageNum: number): number | null {
	const ink = inkStream(doc, pageNum);
	expect(named(ink, "Do"), "no group drawn on the page").toEqual([]);
	const names = [...new Set(named(ink, "gs"))];
	expect(names, "one state named").toHaveLength(1);
	const state = stateOf(doc, index, names[0]!);
	expect(state.dict.get("/ca"), "fill alpha").toBe(pdfNum(HIGHLIGHTER_ALPHA));
	expect(state.dict.get("/CA"), "stroke alpha").toBe(pdfNum(HIGHLIGHTER_ALPHA));
	expect(state.dict.has("/BM"), "no blend mode").toBe(false);
	expect(state.dict.has("/SMask"), "no soft mask").toBe(false);
	const want = strokes.filter((s) => s.page === index && s.tool === "highlighter").map((s) => colourOf(s, mode));
	expect(fillColours(ink), "each highlight a fill on the page, in the order drawn").toEqual(want);
	expect(finalResources(doc, index).get("/XObject"), "the /XObject entry as the file wrote it").toBe(finalResources(before, index).get("/XObject"));
	return state.num;
}

function readBack(src: string): PdfDoc {
	const doc = readPdf(bytes(src));
	if (!doc.ok) throw new Error(doc.reason);
	return doc.value;
}

describe("a page whose embedded graphics this writer cannot read keeps the wash", () => {
	// The group is named in the page's /XObject, so a page whose /XObject this writer cannot read cannot take it. That
	// page keeps the wash the copy wrote before, whatever its shade and setting: so there two crossing colours stack,
	// and on a light page the page's words under a highlight are tinted, as they were. The /XObject entry is never
	// read as absent, copied or replaced: a dictionary this writer missed may be one a reader finds, with the pictures.
	const LIGHT = "1 g 0 0 612 792 re f";
	const kinds: [string, (content: string) => string][] = [
		["an /XObject that names a missing object", (c) => onePage(streamObject(c), "/Resources << /XObject 90 0 R >> ")],
		["an /XObject that is not a dictionary", (c) => onePage(streamObject(c), "/Resources << /XObject 5 0 R >> ", ["[1 2 3]"])],
	];
	const modes: PdfPageAssumption[] = ["darken", "keep", "lighten"];
	const cases = kinds.flatMap(([kind, make]) =>
		[["the file draws dark", DARK] as const, ["the file draws light", LIGHT] as const].flatMap(([shade, content]) =>
			modes.map((mode) => [kind, shade, mode, make(content)] as [string, string, PdfPageAssumption, string])
		)
	);

	it.each(cases)("%s, a page %s, %s: written, the wash on that page, its /XObject as it was", (kind, shade, mode, src) => {
		// Defect: the copy refused, a group named into a dictionary the reader may not see, or the entry dropped.
		const before = readBack(src);
		const page = pdfPages(before);
		if (!page.ok) throw new Error(page.reason);
		if (shade === "the file draws light") expect(pageShade(before, page.value[0]!), "precondition: read as light").toBe("light");
		if (kind.includes("not a dictionary")) expect(objectBody(before, 5), "precondition: not a dictionary").toBe("[1 2 3]");
		else expect(objectBody(before, 90), "precondition: missing").toBeNull();
		const strokes = [across(YELLOW), down(BLUE)];
		const doc = flatten(src, strokes, mode);
		expectWash(doc, before, strokes, mode, 1, 3);
		for (const n of before.offsets.keys()) {
			if (n === 3) continue;
			expect(objectBody(doc, n), `object ${n} is unchanged`).toBe(objectBody(before, n));
		}
	});

	// Two pages reaching one /ExtGState object: the wash's state is placed in it, as before; the group page takes a
	// /Resources of its own. Objects 6 and 7 are the pages' content.
	const pair = (wash: 1 | 2, groupContent: string): string =>
		document(
			2,
			(i) => `/Resources << /ExtGState 5 0 R ${i + 1 === wash ? "/XObject 90 0 R " : ""}>> /Contents ${6 + i} 0 R `,
			"",
			["<< /GS0 << /ca 1 >> >>", ...[1, 2].map((p) => streamObject(p === wash ? DARK : groupContent))]
		);
	const mixed = ([1, 2] as const).flatMap((wash) =>
		[["drawn light", LIGHT] as const, ["drawn dark", DARK] as const].map(
			([shade, content]) => [wash, shade, pair(wash, content)] as [1 | 2, string, string]
		)
	);

	it.each(mixed)("one /ExtGState object shared with a group page, the wash on page %s, the group page %s: each reaches its own", (wash, shade, src) => {
		// Defect: the wash page refused, the two pages reaching one state, or the group's state placed in the shared object.
		const before = readBack(src);
		const group = wash === 1 ? 2 : 1;
		const strokes = [1, 2].flatMap((p) => [{ ...across(YELLOW), page: p }, { ...down(BLUE), page: p }]);
		const doc = flatten(src, strokes, "darken");
		const washState = expectWash(doc, before, strokes, "darken", wash, wash + 2);

		const ink = inkStream(doc, group + 2);
		expect(ink, "the group page draws its group").toMatch(/^q \/\S+ gs \/\S+ Do Q$/);
		const g = stateOf(doc, group, named(ink, "gs")[0]!);
		expect(g.dict.get("/BM"), "the group page's own blend").toBe(shade === "drawn light" ? "/Multiply" : undefined);
		expect(g.num, "the two pages reach two different states").not.toBe(washState);
		expect(asRef(finalResources(doc, group).get("/ExtGState")), "the group page's states are its own").toBeNull();

		for (const n of before.offsets.keys()) {
			if (n === 3 || n === 4 || n === 5) continue;
			expect(objectBody(doc, n), `object ${n} is unchanged`).toBe(objectBody(before, n));
		}
		// Every name each page reached before, it still reaches, to the same value.
		for (const index of [1, 2]) {
			const was = finalResources(before, index);
			const now = finalResources(doc, index);
			for (const [key, value] of was) {
				if (key !== "/ExtGState") {
					expect(now.get(key), `page ${index} ${key}`).toBe(value);
					continue;
				}
				const nowNames = dictEntries(deref(doc, now.get(key)) ?? "<< >>");
				for (const [k, v] of dictEntries(deref(before, value) ?? "<< >>")) expect(nowNames.get(k), `page ${index} ${key} ${k}`).toBe(v);
			}
		}
	});
});

// ---------------------------------------------------------------- probe: the shared fill a stroke drawn backwards

/** The sub-paths a viewer would trace, from the operators as written. Beziers sampled; the rest followed literally. */
function subpaths(ops: string): { x: number; y: number }[][] {
	const out: { x: number; y: number }[][] = [];
	let cur: { x: number; y: number }[] = [];
	let at = { x: 0, y: 0 };
	let stack: number[] = [];
	for (const token of ops.trim().split(/\s+/)) {
		if (/^-?[\d.]+$/.test(token)) {
			stack.push(Number(token));
			continue;
		}
		const n = stack.length;
		if (token === "m") {
			if (cur.length > 0) out.push(cur);
			at = { x: stack[n - 2]!, y: stack[n - 1]! };
			cur = [at];
		} else if (token === "l") {
			at = { x: stack[n - 2]!, y: stack[n - 1]! };
			cur.push(at);
		} else if (token === "c") {
			const [x1, y1, x2, y2, x3, y3] = stack.slice(n - 6) as number[];
			for (let i = 1; i <= 8; i++) {
				const t = i / 8;
				const u = 1 - t;
				cur.push({
					x: u * u * u * at.x + 3 * u * u * t * x1! + 3 * u * t * t * x2! + t * t * t * x3!,
					y: u * u * u * at.y + 3 * u * u * t * y1! + 3 * u * t * t * y2! + t * t * t * y3!,
				});
			}
			at = { x: x3!, y: y3! };
		} else if (token === "h" && cur.length > 0) {
			out.push(cur);
			cur = [];
		}
		stack = [];
	}
	if (cur.length > 0) out.push(cur);
	return out;
}

/** The nonzero winding number at a point: what decides whether it is filled. */
function windingAt(ops: string, px: number, py: number): number {
	let w = 0;
	for (const path of subpaths(ops)) {
		for (let i = 0; i < path.length; i++) {
			const a = path[i]!;
			const b = path[(i + 1) % path.length]!;
			const side = (b.x - a.x) * (py - a.y) - (px - a.x) * (b.y - a.y);
			if (a.y <= py) {
				if (b.y > py && side > 0) w++;
			} else if (b.y <= py && side < 0) w--;
		}
	}
	return w;
}

describe("probe: two same-colour highlights crossing, one drawn backwards, in one shared fill", () => {
	// The note export lays a run of one colour as one path and one nonzero fill. If a stroke drawn the other way
	// closed its outline the other way round, the two turns would cancel where they cross: a hole, no coat. By reading
	// the outline's sides are the tangent turned a quarter, so a stroke drawn backwards closes the same way round.
	// These say so for both directions. A red here is its own bug in the shared fill, which the note export uses too.
	it.each<[string, (c: string) => InkStroke]>([
		["drawn down", down],
		["drawn up (backwards)", up],
	])("the second stroke %s: the crossing is covered", (_name, second) => {
		const a = across(YELLOW);
		const b = second(YELLOW);
		const content = inkPdfContent([a, b], 792);
		expect(content.match(/ f /g)?.length ?? 0, "precondition: one shared fill").toBe(1);
		const wa = windingAt(strokePdfOps(a), 200, 200);
		const wb = windingAt(strokePdfOps(b), 200, 200);
		expect(wa, "precondition: the first stroke covers the crossing").not.toBe(0);
		expect(wb, "precondition: the second stroke covers the crossing").not.toBe(0);
		expect(Math.sign(wa), "both outlines turn the same way").toBe(Math.sign(wb));
		expect(windingAt(content, 200, 200), "the shared fill covers the crossing").not.toBe(0);
	});
});
