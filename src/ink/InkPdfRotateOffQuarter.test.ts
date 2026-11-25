/**
 * A page whose /Rotate is not a multiple of 90.
 *
 * The spec allows only multiples of 90, but such files are found in the wild.
 * The viewer shows the page upright, as if the key said 0, and the ink is
 * stored upright. So the reader has to take the turn as 0, and the flattened
 * copy has to put the ink where an upright page puts it. Rounding 45 to 90 or
 * 135 to 180 turns the copied ink a quarter or a half turn off its place.
 *
 * The flatten cells run the real writer and follow the page's last content
 * stream through every `q`, `Q` and `cm` to where each path point lands.
 */
import { describe, expect, it } from "vitest";
import { InkStroke, computeBBox } from "./Stroke";
import { appendInkToPdf } from "./InkPdfAppend";
import { PdfDoc, asRef, dictEntries, objectBody, pdfPages, readPdf } from "../pdf/PdfSyntax";
import { document } from "../../test/pdf-fixture";

function stroke(at: readonly [number, number][]): InkStroke {
	const points = at.map(([x, y], i) => ({ x, y, pressure: 0.5, t: i * 8 }));
	return { id: "s-1", tool: "pen", color: "#202020", width: 3, points, bbox: computeBBox(points, 3), createdAt: 0, page: 1 };
}

function bytes(src: string): Uint8Array {
	const out = new Uint8Array(src.length);
	for (let i = 0; i < src.length; i++) out[i] = src.charCodeAt(i) & 0xff;
	return out;
}

function read(src: string): PdfDoc {
	const doc = readPdf(bytes(src));
	if (!doc.ok) throw new Error(`premise: the source does not read: ${doc.reason}`);
	return doc.value;
}

function flatten(src: string, strokes: readonly InkStroke[]): PdfDoc {
	const r = appendInkToPdf(bytes(src), strokes);
	if (!r.ok) throw new Error(`unexpected refusal: ${r.reason}`);
	const doc = readPdf(r.bytes);
	if (!doc.ok) throw new Error(`the result does not read back: ${doc.reason}`);
	return doc.value;
}

/** The page's own ink: the last stream in its content list, as written. */
function inkStream(doc: PdfDoc, pageNum: number): string {
	const contents = dictEntries(objectBody(doc, pageNum)!).get("/Contents")!;
	const refs = contents.match(/\d+ 0 R/g) ?? [];
	const num = asRef(refs[refs.length - 1]!)!;
	const from = doc.text(doc.offsets.get(num)!, doc.bytes.length);
	const start = from.indexOf("stream\n");
	return from.slice(start + "stream\n".length, from.indexOf("\nendstream", start));
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

/** The centre of the placed ink, to a tenth. */
function centre(pts: ReadonlyArray<[number, number]>): [number, number] {
	const xs = pts.map((p) => p[0]);
	const ys = pts.map((p) => p[1]);
	const r = (v: number) => Math.round(v * 10) / 10;
	return [r((Math.min(...xs) + Math.max(...xs)) / 2), r((Math.min(...ys) + Math.max(...ys)) / 2)];
}

/** A short stroke centred on (115, 201.5) of the stored, upright frame of a 612 x 792 page. */
const upperLeft = (): InkStroke =>
	stroke([
		[100, 200],
		[115, 201.5],
		[130, 203],
	]);

const turnOf = (r: number): number => {
	const pages = pdfPages(read(document(1, () => `/Rotate ${r} `)));
	return pages.ok ? pages.value[0]!.rotate : -1;
};

const near = (got: [number, number], want: [number, number]): boolean =>
	Math.abs(got[0] - want[0]) <= 3 && Math.abs(got[1] - want[1]) <= 3;

describe("a page whose /Rotate is not a multiple of 90", () => {
	it("control: the quarter turns still read as themselves", () => {
		expect([turnOf(0), turnOf(90), turnOf(180), turnOf(270)]).toEqual([0, 90, 180, 270]);
	});

	it("reads a turn the viewer shows upright as 0", () => {
		for (const r of [45, 135, 100]) expect.soft(turnOf(r), `/Rotate ${r} read as`).toBe(0);
	});

	it("control: an upright page and a quarter-turned page place the stroke as before", () => {
		const upright = centre(placedPoints(inkStream(flatten(document(1), [upperLeft()]), 3)));
		// Stored (115, 201.5) on a 792-high page is (115, 590.5) in PDF space.
		expect(near(upright, [115, 590.5]), `upright centre ${JSON.stringify(upright)}`).toBe(true);
		const quarter = centre(placedPoints(inkStream(flatten(document(1, () => "/Rotate 90 "), [upperLeft()]), 3)));
		// The same stored point on a page the file turns 90 is turned back to (201.5, 115).
		expect(near(quarter, [201.5, 115]), `quarter-turn centre ${JSON.stringify(quarter)}`).toBe(true);
	});

	it("the copy puts the ink of a page the viewer shows upright where an upright page puts it", () => {
		for (const r of [45, 135]) {
			const got = centre(placedPoints(inkStream(flatten(document(1, () => `/Rotate ${r} `), [upperLeft()]), 3)));
			expect.soft(near(got, [115, 590.5]), `/Rotate ${r}: ink centre ${JSON.stringify(got)}, upright is [115,590.5]`).toBe(true);
		}
	});
});
