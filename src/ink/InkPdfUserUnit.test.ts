/**
 * A flattened copy of a page that carries /UserUnit.
 *
 * The viewer sizes such a page at its box times the UserUnit, and the ink on
 * it is stored in that frame: the page's own px over the viewer's scale. So a
 * /UserUnit 2 page with a 306 x 396 box is inked in a 612 x 792 frame. The
 * copy has to put each mark back on the box at the same place, which is the
 * stored point over the UserUnit, or the ink lands at twice its place from
 * the top left and mostly off the page. "Export ink as PDF (drawing only)"
 * writes such pages past the page-size limit, and large-format PDFs from
 * other apps carry them too.
 *
 * The viewer reads /UserUnit from the page's own dictionary, through a
 * reference if it is one, and takes anything that is not a number above 0 as
 * 1. A page with no /UserUnit, or one the viewer takes as 1, is copied as it
 * was: the same bytes. The strokes the copy is given are not changed.
 *
 * Each cell runs the real writer and follows the page's last content stream
 * (or the highlight group it draws) through every `q`, `Q` and `cm` to where
 * each path point lands.
 */
import { describe, expect, it } from "vitest";
import { InkStroke, computeBBox } from "./Stroke";
import { appendInkToPdf } from "./InkPdfAppend";
import { PdfDoc, asRef, dictEntries, objectBody, pdfPages, readPdf } from "../pdf/PdfSyntax";
import { document } from "../../test/pdf-fixture";

function stroke(at: readonly [number, number][], tool: "pen" | "highlighter" = "pen", id = "s-1"): InkStroke {
	const points = at.map(([x, y], i) => ({ x, y, pressure: 0.5, t: i * 8 }));
	const width = tool === "highlighter" ? 12 : 3;
	return { id, tool, color: "#202020", width, points, bbox: computeBBox(points, width), createdAt: 0, page: 1 };
}

function bytes(src: string): Uint8Array {
	const out = new Uint8Array(src.length);
	for (let i = 0; i < src.length; i++) out[i] = src.charCodeAt(i) & 0xff;
	return out;
}

function appended(src: string, strokes: readonly InkStroke[]): Uint8Array {
	const r = appendInkToPdf(bytes(src), strokes);
	if (!r.ok) throw new Error(`unexpected refusal: ${r.reason}`);
	return r.bytes;
}

function flatten(src: string, strokes: readonly InkStroke[]): PdfDoc {
	const doc = readPdf(appended(src, strokes));
	if (!doc.ok) throw new Error(`the result does not read back: ${doc.reason}`);
	return doc.value;
}

function streamOf(doc: PdfDoc, num: number): string {
	const from = doc.text(doc.offsets.get(num)!, doc.bytes.length);
	const start = from.indexOf("stream\n");
	return from.slice(start + "stream\n".length, from.indexOf("\nendstream", start));
}

/** The page's own ink: the last stream in its content list, as written. */
function inkStream(doc: PdfDoc, pageNum: number): string {
	const contents = dictEntries(objectBody(doc, pageNum)!).get("/Contents")!;
	const refs = contents.match(/\d+ 0 R/g) ?? [];
	return streamOf(doc, asRef(refs[refs.length - 1]!)!);
}

/** The page's highlight group, the form its ink stream draws. */
function groupStream(doc: PdfDoc, pageNum: number): string {
	const res = dictEntries(objectBody(doc, pageNum)!).get("/Resources")!;
	const forms = dictEntries(res).get("/XObject")!;
	return streamOf(doc, asRef(dictEntries(forms).get("/HwHighlights"))!);
}

type M = [number, number, number, number, number, number];

/** Every path point of a content stream, in page space: the stream's own `cm`s applied in order. */
function placedPoints(content: string): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	const stack: M[] = [];
	let ctm: M = [1, 0, 0, 1, 0, 0];
	let nums: number[] = [];
	const map = (x: number, y: number): [number, number] => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
	for (const t of content.split(/\s+/).filter((s) => s !== "")) {
		const n = Number(t);
		if (/^[-+.\d]/.test(t) && Number.isFinite(n)) {
			nums.push(n);
			continue;
		}
		if (t === "q") stack.push(ctm);
		else if (t === "Q") ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
		else if (t === "cm") {
			const [a, b, c, d, e, f] = nums.slice(-6) as M;
			ctm = [
				a * ctm[0] + b * ctm[2],
				a * ctm[1] + b * ctm[3],
				c * ctm[0] + d * ctm[2],
				c * ctm[1] + d * ctm[3],
				e * ctm[0] + f * ctm[2] + ctm[4],
				e * ctm[1] + f * ctm[3] + ctm[5],
			];
		} else if (t === "m" || t === "l" || t === "c" || t === "v" || t === "y") {
			for (let i = 0; i + 1 < nums.length; i += 2) out.push(map(nums[i]!, nums[i + 1]!));
		}
		nums = [];
	}
	return out;
}

function spread(pts: ReadonlyArray<[number, number]>) {
	const xs = pts.map((p) => p[0]);
	const ys = pts.map((p) => p[1]);
	const r = (v: number) => Math.round(v * 10) / 10;
	return {
		minX: r(Math.min(...xs)),
		maxX: r(Math.max(...xs)),
		minY: r(Math.min(...ys)),
		maxY: r(Math.max(...ys)),
		cx: r((Math.min(...xs) + Math.max(...xs)) / 2),
		cy: r((Math.min(...ys) + Math.max(...ys)) / 2),
	};
}

/** A short stroke centred on (450, 600) of the stored frame: the lower right quarter of a 612 x 792 view. */
const lowerRight = (tool: "pen" | "highlighter" = "pen"): InkStroke =>
	stroke(
		[
			[435, 599],
			[450, 600],
			[465, 601],
		],
		tool
	);

/** A one-page document whose page dictionary carries `extra`, on `box`. */
const onePage = (extra: string, box: string, tree = "", after: readonly string[] = []): string =>
	document(1, () => extra, tree, after, box);

/**
 * Where a page with /UserUnit `u` and box `box` puts the stroke, against where
 * a page with no /UserUnit and the box `u` times as big puts it, over `u`. The
 * viewer shows both at the same size, so the ink sits on the same place of each.
 */
function againstScaled(u: number, box: readonly [number, number, number, number], extra: string, read: (d: PdfDoc) => string, ink: () => InkStroke) {
	const at = (b: readonly number[]) => `[${b.join(" ")}]`;
	const scaled = spread(placedPoints(read(flatten(onePage(extra, at(box.map((v) => v * u))), [ink()]))));
	const got = spread(placedPoints(read(flatten(onePage(`/UserUnit ${u} ${extra}`, at(box)), [ink()]))));
	const want = Object.fromEntries(Object.entries(scaled).map(([k, v]) => [k, v / u])) as typeof scaled;
	return { got, want };
}

const near = (got: Record<string, number>, want: Record<string, number>) =>
	Object.keys(want).filter((k) => Math.abs(got[k]! - want[k]!) > 0.6);

/** The SHA-256 of a copy's bytes, as hex, from the platform's digest. */
async function sha(b: Uint8Array): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest("SHA-256", b.slice().buffer);
	return Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, "0")).join("");
}

describe("a flattened copy of a page with /UserUnit 2", () => {
	it("control: a plain 612 x 792 page puts the stroke where the view showed it", () => {
		const doc = flatten(document(1), [lowerRight()]);
		const s = spread(placedPoints(inkStream(doc, 3)));
		// Stored (450, 600) on a 792-high page is (450, 192) in PDF space.
		expect(Math.abs(s.cx - 450), `control centre x: ${JSON.stringify(s)}`).toBeLessThanOrEqual(3);
		expect(Math.abs(s.cy - 192), `control centre y: ${JSON.stringify(s)}`).toBeLessThanOrEqual(3);
	});

	it("the stroke lands on the box at the place the view showed it, not at twice that", () => {
		const src = document(1, () => "/UserUnit 2 ", "", [], "[0 0 306 396]");
		const read = readPdf(bytes(src));
		if (!read.ok) throw new Error(`premise: the source does not read: ${read.reason}`);
		const pages = pdfPages(read.value);
		expect(pages.ok && pages.value[0]!.box, "premise: the box reads as 306 x 396").toEqual({ x: 0, y: 0, w: 306, h: 396 });
		expect(src, "premise: the page says /UserUnit 2").toContain("/UserUnit 2 ");
		const doc = flatten(src, [lowerRight()]);
		const s = spread(placedPoints(inkStream(doc, 3)));
		// The view is 612 x 792, so (450, 600) stored is (225, 300) on the box from the top left: (225, 96) in PDF space.
		expect.soft(s.maxX, `ink past the right edge of the 306-wide box: ${JSON.stringify(s)}`).toBeLessThanOrEqual(306);
		expect.soft(s.minY, `ink below the bottom edge of the box: ${JSON.stringify(s)}`).toBeGreaterThanOrEqual(0);
		expect.soft(Math.abs(s.cx - 225), `centre x off its place: ${JSON.stringify(s)}`).toBeLessThanOrEqual(3);
		expect.soft(Math.abs(s.cy - 96), `centre y off its place: ${JSON.stringify(s)}`).toBeLessThanOrEqual(3);
	});

	it.each([
		["a quarter-turned page", 2, [0, 0, 306, 396], "/Rotate 90 "],
		["a half-turned page", 2, [0, 0, 306, 396], "/Rotate 180 "],
		["a page whose box does not start at the origin", 2, [10, 20, 316, 416], ""],
		["a page with /UserUnit 1.5", 1.5, [0, 0, 408, 528], ""],
	] as const)("%s puts the stroke where the view showed it", (_name, u, box, extra) => {
		const { got, want } = againstScaled(u, box, extra, (d) => inkStream(d, 3), () => lowerRight());
		expect(near(got, want), `placed ${JSON.stringify(got)}, the view's place ${JSON.stringify(want)}`).toEqual([]);
	});

	it("a highlight lands where the view showed it", () => {
		const { got, want } = againstScaled(2, [0, 0, 306, 396], "", (d) => groupStream(d, 3), () => lowerRight("highlighter"));
		expect(near(got, want), `placed ${JSON.stringify(got)}, the view's place ${JSON.stringify(want)}`).toEqual([]);
	});

	it("a /UserUnit given as a reference is read through it", () => {
		const { want } = againstScaled(2, [0, 0, 306, 396], "", (d) => inkStream(d, 3), () => lowerRight());
		const viaRef = spread(placedPoints(inkStream(flatten(onePage("/UserUnit 4 0 R ", "[0 0 306 396]", "", ["2"]), [lowerRight()]), 3)));
		expect(near(viaRef, want), `placed ${JSON.stringify(viaRef)}, the view's place ${JSON.stringify(want)}`).toEqual([]);
	});
});

describe("pins: a page the viewer shows at its box, as before", () => {
	// The bytes each copy had before /UserUnit was read: sha-256, read with this file at 3219909b, before the fix.
	const BEFORE = {
		plain: "6ad1887e2b9d7bdcb3fc3184d55decd5b665834c21424a3c456f9c2102bf2701",
		turnedOffset: "15eb09e93eb71dadbf2b31198cd78a824d75e961c9db696129b8a62cf76d4646",
		highlight: "843b57684fc8fc311a1d17d6fad2a633b0b145708f4baeb5ed8171c635f0d579",
	};

	it.each([
		["a plain page, pen", "plain", document(1), () => [lowerRight()]],
		["a quarter-turned page whose box does not start at the origin, pen", "turnedOffset", onePage("/Rotate 90 ", "[10 20 622 812]"), () => [lowerRight()]],
		["a plain page, highlight and pen", "highlight", document(1), () => [lowerRight("highlighter"), { ...lowerRight(), id: "s-2" }]],
	] as const)("%s: the copy's bytes are as before", async (_name, key, src, ink) => {
		expect(await sha(appended(src, ink())), "the copy's bytes").toBe(BEFORE[key]);
	});

	it.each([
		["/UserUnit 1", "/UserUnit 1 ", "", []],
		["/UserUnit 0", "/UserUnit 0 ", "", []],
		["/UserUnit -2", "/UserUnit -2 ", "", []],
		["/UserUnit /Two", "/UserUnit /Two ", "", []],
		["a reference to something that is not a number", "/UserUnit 4 0 R ", "", ["(two)"]],
		["/UserUnit 2 on the page tree, not the page", "", "/UserUnit 2 ", []],
	] as const)("a page with %s is copied as a page with none", (_name, extra, tree, after) => {
		const none = inkStream(flatten(onePage("", "[0 0 612 792]", "", after), [lowerRight()]), 3);
		const got = inkStream(flatten(onePage(extra, "[0 0 612 792]", tree, after), [lowerRight()]), 3);
		expect(got, "the page's ink stream").toBe(none);
	});

	it("the strokes the copy is given are not changed", () => {
		const ink = [lowerRight(), lowerRight("highlighter")];
		const before = JSON.parse(JSON.stringify(ink));
		appended(document(1, () => "/UserUnit 2 ", "", [], "[0 0 306 396]"), ink);
		expect(ink, "the strokes after the copy").toEqual(before);
	});
});
