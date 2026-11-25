/**
 * A page whose /Resources are split across levels of the page tree, flattened.
 *
 * The PDF format says a page's /Resources replaces any an ancestor carries.
 * Obsidian's viewer does not stop there: its pdf.js collects /Resources from
 * the page and from every /Parent above it and merges them by top-level key,
 * the first level that has a key winning, sub-dictionaries never merged
 * (pdf.js `_getInheritableProperty` then `Dict.merge` without
 * `mergeSubDicts`). So a file can keep a page's fonts on
 * the page and its pictures on a /Pages node above it, and the viewer shows
 * both.
 *
 * A highlighted page takes a /Resources of its own in the copy, holding our
 * group and our state. Here that own dictionary must still let the viewer
 * reach every picture and every drawing state it reached before: an /XObject
 * or /ExtGState the nearest level lacks is the one the first level above
 * holds, plus our name. Nothing the original wrote is rewritten, and a page
 * whose nearest level holds both keys is written byte for byte as before.
 *
 * Two readers. `viewerResources` models the viewer's merge and walks /Parent
 * itself, so it shares nothing with the writer's page walk. `nearestResources`
 * is the older cells' reader (InkPdfHighlightGroup.test.ts, finalResources):
 * the nearest level only, through the writer's own page walk.
 */

import { describe, expect, it } from "vitest";
import { InkStroke, computeBBox } from "./Stroke";
import { appendInkToPdf } from "./InkPdfAppend";
import { PdfPageAssumption, pdfNum } from "./InkPdf";
import { HIGHLIGHTER_ALPHA } from "./PenStyle";
import { PdfDoc, asRef, deref, dictEntries, objectBody, pdfPages, readPdf } from "../pdf/PdfSyntax";
import { sha256 } from "../pdf/Sha256";
import { assemble, streamObject } from "../../test/pdf-fixture";

let ids = 0;
function stroke(page: number, tool: "pen" | "highlighter", color: string, at: readonly [number, number][]): InkStroke {
	const points = at.map(([x, y], i) => ({ x, y, pressure: 0.5, t: i * 8 }));
	const width = tool === "highlighter" ? 18 : 3;
	return { id: `t-${++ids}`, tool, color, width, points, bbox: computeBBox(points, width), createdAt: 0, page };
}
const LINE: readonly [number, number][] = [
	[100, 200],
	[160, 204],
	[220, 208],
];
const hl = (page: number, color = "#ffd60a", at = LINE): InkStroke => stroke(page, "highlighter", color, at);
const pen = (page: number): InkStroke => stroke(page, "pen", "#202020", LINE);

function bytes(src: string): Uint8Array {
	const out = new Uint8Array(src.length);
	for (let i = 0; i < src.length; i++) out[i] = src.charCodeAt(i) & 0xff;
	return out;
}

function read(src: string | Uint8Array): PdfDoc {
	const doc = readPdf(typeof src === "string" ? bytes(src) : src);
	if (!doc.ok) throw new Error(`does not read: ${doc.reason}`);
	return doc.value;
}

function flatten(src: string, strokes: readonly InkStroke[], mode: PdfPageAssumption = "darken"): PdfDoc {
	const r = appendInkToPdf(bytes(src), strokes, mode);
	if (!r.ok) throw new Error(`unexpected refusal: ${r.reason}`);
	return read(r.bytes);
}

function shaOf(src: string, strokes: readonly InkStroke[], mode: PdfPageAssumption): string {
	const r = appendInkToPdf(bytes(src), strokes, mode);
	if (!r.ok) throw new Error(`unexpected refusal: ${r.reason}`);
	return Array.from(sha256(r.bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The /Resources the viewer draws the page at object `pageNum` with, as
 * Obsidian 1.15.1's pdf.js worker builds them (`_getInheritableProperty`,
 * `getInheritableProperty`, `Dict.merge`):
 * 1. walk up /Parent from the page, stopping at a node that is not a
 *    dictionary or one already seen;
 * 2. take each level's /Resources through one reference hop, any value that
 *    is there, `null` included;
 * 3. when the nearest such value is not a dictionary, the page has none;
 * 4. otherwise merge, passing over every value that is not a dictionary;
 * 5. each top-level key whole from the first level that has it, whatever its
 *    value, sub-dictionaries never merged.
 * Follows /Parent itself and never calls the writer's page walk.
 */
function viewerResources(doc: PdfDoc, pageNum: number): Map<string, string> {
	const levels: (string | null)[] = [];
	const seen = new Set<number>();
	let num: number | null = pageNum;
	while (num !== null && !seen.has(num)) {
		seen.add(num);
		const body = objectBody(doc, num);
		if (body === null || !body.startsWith("<<")) break;
		const node = dictEntries(body);
		if (node.has("/Resources")) levels.push(deref(doc, node.get("/Resources")));
		num = asRef(node.get("/Parent"));
	}
	const out = new Map<string, string>();
	const isDict = (v: string | null): v is string => v !== null && v.startsWith("<<");
	if (levels.length === 0 || !isDict(levels[0]!)) return out;
	for (const res of levels) if (isDict(res)) for (const [k, v] of dictEntries(res)) if (!out.has(k)) out.set(k, v);
	return out;
}

/** The older cells' reader: the nearest level's /Resources, through the writer's page walk. */
function nearestResources(doc: PdfDoc, index: number): Map<string, string> {
	const pages = pdfPages(doc);
	if (!pages.ok) throw new Error(pages.reason);
	return dictEntries(deref(doc, pages.value[index - 1]!.resources ?? undefined) ?? "<< >>");
}

/** The names in one sub-dictionary of a resources map, followed. */
function namesIn(doc: PdfDoc, res: ReadonlyMap<string, string>, key: "/XObject" | "/ExtGState"): Map<string, string> {
	return dictEntries(deref(doc, res.get(key)) ?? "<< >>");
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

// Objects: 1 catalog, 2 the root /Pages, 3 a /Pages node under it, 4 and 5 the
// two pages under that, 6 their shared content, 7 a picture, 8 a font, 9 a
// drawing state of the file's own, 10 and 11 free for a dictionary a level
// reaches by reference. Object 90 is in no file.
const CONTENT = streamObject("q /GS1 gs 200 0 0 200 100 300 cm /Im0 Do Q BT /F1 12 Tf 72 720 Td (hello) Tj ET");
const PICTURE =
	"<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\nA\nendstream";
const FONT = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
const STATE = "<< /Type /ExtGState /CA 0.5 /LW 3 >>";
const PAGES = [4, 5] as const;

interface Split {
	root?: string;
	mid?: string;
	page?: string;
	ten?: string;
	eleven?: string;
}

function split(s: Split): string {
	const leaf = `<< /Type /Page /Parent 3 0 R /MediaBox [0 0 612 792] /Contents 6 0 R ${s.page ?? ""}>>`;
	return assemble([
		"<< /Type /Catalog /Pages 2 0 R >>",
		`<< /Type /Pages /Kids [3 0 R] /Count 2 ${s.root ?? ""}>>`,
		`<< /Type /Pages /Parent 2 0 R /Kids [4 0 R 5 0 R] /Count 2 ${s.mid ?? ""}>>`,
		leaf,
		leaf,
		CONTENT,
		PICTURE,
		FONT,
		STATE,
		s.ten ?? "<< /Spare 10 >>",
		s.eleven ?? "<< /Spare 11 >>",
	]);
}

const FONT_ON = "/Resources << /Font << /F1 8 0 R >> >> ";
const PICTURES = "/XObject << /Im0 7 0 R >>";
const STATES = "/ExtGState << /GS1 9 0 R >>";

// Each file splits a page's /Resources across levels; the viewer reads /Im0,
// /GS1 or both from a level above the nearest. Page 1 has one highlight, page
// 2 two and a pen line.
const SPLITS: [string, Split][] = [
	// The sweep's cell (bound 1): the pictures on the tree, the page's font on the page.
	["pictures on the tree, the font on the page", { root: `/Resources << ${PICTURES} >> `, page: FONT_ON }],
	// Bound 2: a drawing state named only higher up, on the group road (the page's /XObject reads).
	[
		"a drawing state on the tree, the pictures on the page",
		{ root: `/Resources << ${STATES} >> `, page: `/Resources << ${PICTURES} /Font << /F1 8 0 R >> >> ` },
	],
	["pictures two levels up, the page inheriting the level between", { root: `/Resources << ${PICTURES} >> `, mid: FONT_ON }],
	[
		"pictures, states and the font each on a level of their own",
		{ root: `/Resources << ${PICTURES} >> `, mid: `/Resources << ${STATES} >> `, page: FONT_ON },
	],
	[
		"the nearer of two levels above wins a key both hold",
		{
			root: "/Resources << /XObject << /Im9 7 0 R >> /ExtGState << /GS9 9 0 R >> >> ",
			mid: `/Resources << ${PICTURES} ${STATES} >> `,
			page: FONT_ON,
		},
	],
	// Bound 7: a level reached by reference.
	["the tree's resources reached by reference", { root: "/Resources 10 0 R ", ten: `<< ${PICTURES} ${STATES} >>`, page: FONT_ON }],
	[
		"the tree's /XObject and /ExtGState each reached by reference",
		{ root: "/Resources << /XObject 10 0 R /ExtGState 11 0 R >> ", ten: "<< /Im0 7 0 R >>", eleven: "<< /GS1 9 0 R >>", page: FONT_ON },
	],
	[
		"the page's own resources one object both pages share, the tree's inline",
		{ root: `/Resources << ${PICTURES} ${STATES} >> `, page: "/Resources 10 0 R ", ten: "<< /Font << /F1 8 0 R >> >>" },
	],
	// Our names are free in the dictionary as filled, not in the nearest level's.
	[
		"a level above already using the writer's names",
		{
			root: "/Resources << /XObject << /Im0 7 0 R /HwHighlights 7 0 R >> /ExtGState << /GS1 9 0 R /HwAlpha 9 0 R >> >> ",
			page: FONT_ON,
		},
	],
	// A level whose /Resources is not a dictionary is passed over, by the viewer and by the fill.
	["a level between whose /Resources is null", { root: `/Resources << ${PICTURES} >> `, mid: "/Resources null ", page: FONT_ON }],
	[
		"a level between whose /Resources names an object the file does not have",
		{ root: `/Resources << ${PICTURES} >> `, mid: "/Resources 90 0 R ", page: FONT_ON },
	],
	[
		"a level between whose /Resources is a reference to a reference",
		{ root: `/Resources << ${PICTURES} >> `, mid: "/Resources 10 0 R ", ten: "11 0 R", eleven: "<< /Font << /F2 8 0 R >> >>", page: FONT_ON },
	],
];

const strokes = (): InkStroke[] => [hl(1), hl(2, "#4bc8ff"), hl(2, "#4bc8ff", [[90, 300], [300, 320]]), pen(2)];

describe("the viewer reads every picture and drawing state a split page reached before", () => {
	it("the instrument: before the copy, the viewer's merge reaches /Im0 and the nearest-level reader does not", () => {
		const before = read(split(SPLITS[0]![1]));
		expect(namesIn(before, viewerResources(before, 4), "/XObject").get("/Im0")).toBe("7 0 R");
		expect(namesIn(before, nearestResources(before, 1), "/XObject").has("/Im0")).toBe(false);
	});

	it.each(SPLITS)("%s", (_name, shape) => {
		const src = split(shape);
		const before = read(src);
		const doc = flatten(src, strokes());
		for (const [index, num] of PAGES.map((n, i) => [i + 1, n] as const)) {
			const was = viewerResources(before, num);
			const now = viewerResources(doc, num);
			// Every top-level key the viewer reached, it still reaches; the two
			// we add to keep every name they held, to the same object.
			for (const [key, value] of was) {
				if (key !== "/XObject" && key !== "/ExtGState") {
					expect(now.get(key), `page ${index} ${key}`).toBe(value);
					continue;
				}
				const nowNames = namesIn(doc, now, key);
				for (const [name, target] of namesIn(before, was, key)) {
					expect(nowNames.get(name), `page ${index}: the viewer still reaches ${key} ${name}`).toBe(target);
				}
			}
			// And the page's own group and state, through the same merge.
			const ink = inkStream(doc, num);
			const [state] = named(ink, "gs");
			const [form] = named(ink, "Do");
			const stateBody = deref(doc, namesIn(doc, now, "/ExtGState").get(state ?? ""));
			const formBody = deref(doc, namesIn(doc, now, "/XObject").get(form ?? ""));
			expect(dictEntries(stateBody ?? "<< >>").get("/ca"), `page ${index}: its state`).toBe(pdfNum(HIGHLIGHTER_ALPHA));
			expect(dictEntries(formBody ?? "<< >>").get("/Subtype"), `page ${index}: its group`).toBe("/Form");
		}
	});
});

describe("nothing the original wrote is rewritten, and no dictionary above takes our names", () => {
	it.each(SPLITS)("%s", (_name, shape) => {
		const src = split(shape);
		const before = read(src);
		const doc = flatten(src, strokes());
		for (const n of before.offsets.keys()) {
			if (n === 4 || n === 5) continue;
			expect(objectBody(doc, n), `object ${n} is unchanged`).toBe(objectBody(before, n));
		}
		// Each page reaches its own group, never the other page's.
		const formOf = (num: number): string | undefined => {
			const [form] = named(inkStream(doc, num), "Do");
			return namesIn(doc, viewerResources(doc, num), "/XObject").get(form ?? "");
		};
		expect(formOf(4)).toBeDefined();
		expect(formOf(4)).not.toBe(formOf(5));
	});
});

describe("the older reader still meets what it met", () => {
	// The nearest-level reader, as a strict reader is, keeps every name its own
	// level held: the old cells' property, on the split shapes.
	it.each(SPLITS)("%s", (_name, shape) => {
		const src = split(shape);
		const before = read(src);
		const doc = flatten(src, strokes());
		for (const index of [1, 2]) {
			const was = nearestResources(before, index);
			const now = nearestResources(doc, index);
			for (const key of ["/XObject", "/ExtGState"] as const) {
				for (const [name, target] of namesIn(before, was, key)) {
					expect(namesIn(doc, now, key).get(name), `page ${index} ${key} ${name}`).toBe(target);
				}
			}
		}
	});
});

describe("a page whose nearest level holds both keys, or no level above holds one it lacks, is written as before", () => {
	// sha256 of each copy at 163c8779, the writer before this change, pinned.
	const BOTH: [string, Split, PdfPageAssumption][] = [
		[
			"the page holds both, the tree both with other names, darken",
			{
				root: "/Resources << /XObject << /Im9 7 0 R >> /ExtGState << /GS9 9 0 R >> >> ",
				page: `/Resources << ${PICTURES} ${STATES} /Font << /F1 8 0 R >> >> `,
			},
			"darken",
		],
		[
			"the page holds both, the tree both with other names, lighten",
			{
				root: "/Resources << /XObject << /Im9 7 0 R >> /ExtGState << /GS9 9 0 R >> >> ",
				page: `/Resources << ${PICTURES} ${STATES} /Font << /F1 8 0 R >> >> `,
			},
			"lighten",
		],
		[
			"the page inherits a level with both, the root both with other names",
			{
				root: "/Resources << /XObject << /Im9 7 0 R >> /ExtGState << /GS9 9 0 R >> >> ",
				mid: `/Resources << ${PICTURES} ${STATES} /Font << /F1 8 0 R >> >> `,
			},
			"darken",
		],
		[
			"the page's both by reference, the root both inline",
			{
				root: "/Resources << /XObject << /Im9 7 0 R >> /ExtGState << /GS9 9 0 R >> >> ",
				page: "/Resources 10 0 R ",
				ten: `<< /XObject 11 0 R ${STATES} >>`,
				eleven: "<< /Im0 7 0 R >>",
			},
			"darken",
		],
		["no level above holds either key", { mid: FONT_ON }, "darken"],
		// The walk goes up for the keys the page lacks and comes back with nothing.
		["the page and the level above hold fonts only", { mid: "/Resources << /Font << /F2 8 0 R >> >> ", page: FONT_ON }, "darken"],
	];
	it.each(BOTH)("%s", (name, shape, mode) => {
		const got = shaOf(split(shape), strokes(), mode);
		const want = SAME_AS_BASE[name];
		if (want === undefined) throw new Error(`no pin "${name}": ${got}`);
		expect(got).toBe(want);
	});
});

describe("the first level above holding a key wins, even an empty one", () => {
	// The viewer takes /XObject whole from the first level
	// that has it, so a picture behind an empty /XObject was never drawn, and
	// the copy must not start drawing it.
	it("an empty /XObject between the page and a level naming /Im0", () => {
		const src = split({ root: `/Resources << ${PICTURES} >> `, mid: "/Resources << /XObject << >> >> ", page: FONT_ON });
		const before = read(src);
		const doc = flatten(src, [hl(1)]);
		expect(namesIn(before, viewerResources(before, 4), "/XObject").has("/Im0"), "the viewer never drew it").toBe(false);
		const now = namesIn(doc, viewerResources(doc, 4), "/XObject");
		expect(now.has("/Im0"), "nor does it in the copy").toBe(false);
		const [form] = named(inkStream(doc, 4), "Do");
		expect(dictEntries(deref(doc, now.get(form ?? "")) ?? "<< >>").get("/Subtype"), "our group").toBe("/Form");
	});
});

describe("a level above that this writer cannot read", () => {
	// A level above that the file has and this writer cannot read refuses the
	// copy, as an unreadable nearest level does: the viewer may read it, and a
	// copy of the page's own would hide what it holds. Its /XObject unreadable:
	// the page keeps the wash and its /XObject entry is never written, since a
	// dictionary this writer missed may be one the viewer finds, with the
	// page's pictures (InkPdfCrossingCoat.test.ts).
	it("a level above whose object is there and does not read refuses the copy", () => {
		const src = split({ root: "/Resources 10 0 R ", ten: `<< ${PICTURES} >>`, page: FONT_ON });
		// Same length, so every offset still points at its object; object 10's head now says generation 1.
		expect(src.split("\n10 0 obj\n").length - 1, "one object 10 head").toBe(1);
		const broken = src.replace("\n10 0 obj\n", "\n10 1 obj\n");
		expect(objectBody(read(broken), 10), "this writer cannot read object 10").toBeNull();
		const r = appendInkToPdf(bytes(broken), [hl(1)]);
		expect(r.ok).toBe(false);
		expect(r.ok || r.reason).toContain("page 1");
	});

	it("an /XObject above that names a missing object keeps the wash, and the page writes no /XObject", () => {
		const src = split({ root: "/Resources << /XObject 90 0 R >> ", page: FONT_ON });
		const doc = flatten(src, [hl(1)]);
		expect(named(inkStream(doc, 4), "Do"), "no group drawn").toEqual([]);
		const own = dictEntries(deref(doc, dictEntries(objectBody(doc, 4)!).get("/Resources")) ?? "<< >>");
		expect(own.has("/XObject"), "no /XObject on the page to hide the tree's").toBe(false);
		expect(viewerResources(doc, 4).get("/XObject")).toBe("90 0 R");
	});
});

describe("the wash road, as before", () => {
	// A page whose own /XObject this writer cannot read keeps the wash, which
	// places its state in the nearest level's /ExtGState, or writes a new one
	// there when that level has none, as 1.5.1 does. This change does not
	// touch that road: its bytes are pinned at 163c8779.
	it("an unreadable /XObject on the page, a drawing state on the tree", () => {
		const shape = { root: `/Resources << ${STATES} >> `, page: "/Resources << /XObject 90 0 R /Font << /F1 8 0 R >> >> " };
		const got = shaOf(split(shape), strokes(), "darken");
		const want = SAME_AS_BASE["wash road"];
		if (want === undefined) throw new Error(`no pin "wash road": ${got}`);
		expect(got).toBe(want);
	});
});

// sha256 of each copy as the writer at 163c8779 made it, taken there and pinned.
const SAME_AS_BASE: Record<string, string> = {
	"the page holds both, the tree both with other names, darken": "81db4d2d6005833b854df34dde74927a847a23e63bdf11ed00fa32df39c73713",
	"the page holds both, the tree both with other names, lighten": "e23911a6cb1a9aba50639f5c084b0a0c84ce26e92ce0c9392091a149b2bd43f9",
	"the page inherits a level with both, the root both with other names": "9f1cfd7a560bae99d30a2694ebb6ca8eddcff4a0c833c3042db7bd2097f7e4ca",
	"the page's both by reference, the root both inline": "6bc87670b8521f08f14376f77675b678cdeaeb6b7033ad2eb34ea3045b433f6e",
	"no level above holds either key": "81beefc2028d59ee20db77cc187dcf1b7730ab2d7be17e5f176d34b90f91cbfa",
	"the page and the level above hold fonts only": "fe4cf492835395b4415bac6bee143f3deac05a2f55ad8a6297a3076a25830098",
	"wash road": "2d4dd034b9756faaee0c739b0a82b4583b3f7c09194cf43b1b2674c8393b1cb7",
};
