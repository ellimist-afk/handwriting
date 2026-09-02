/**
 * Ink onto a PDF somebody else wrote.
 *
 * The second consumer of the writer in `InkPdf`, and the half that makes ink
 * on a PDF a feature rather than a private one: a document annotated inside
 * Obsidian is trapped there until it can be handed to a person who does not
 * have the sidecar. The drawing is identical to the created-page path - same
 * outlines, same discs, same fills. Only the surgery differs.
 *
 * INCREMENTAL, never a rewrite. The original bytes are copied through
 * untouched and the changes are appended: new objects, a cross-reference
 * section naming only them, and a trailer pointing back at the old one with
 * `/Prev`. Three reasons, in the order they matter:
 *
 * - A document we half-understand stays intact. Whatever we did not model -
 *   forms, signatures fields, attachments, tagging - is still there, byte for
 *   byte, because it was never re-serialized.
 * - The result is verifiable: the output must START with the input. A test
 *   can assert that, and a bug that corrupts the original cannot hide.
 * - It is what every other annotator does, so readers are well practised at
 *   opening the result.
 *
 * Two things are worth knowing before reading the code:
 *
 * **Coordinates are already points.** Ink on a PDF is stored in PDF points
 * from the page's top-left (`PDF_COORD_SPACE`, see `PageMap`), NOT in the
 * 96-dpi note pixels the created-page path converts. So nothing here scales;
 * it flips y, and turns the page if the file says the viewer turned it.
 *
 * **The update answers in the file's own table format.** A document whose
 * newest cross-reference section is a stream gets a stream back; one with a
 * classic table gets a table. Mixing them is read by most tools and not by
 * all, and this is the one file in the plugin whose output is opened by
 * software nobody here chose.
 *
 * **The page's own content may leave the graphics state dirty.** An unbalanced
 * `q`, or a clip that was never restored, would take our ink with it. So the
 * existing streams are bracketed by a `q` stream and a `Q` stream of our own
 * before the ink goes last in the array, which restores the page default no
 * matter what the original left behind.
 */

import { InkStroke } from "./Stroke";
import { HIGHLIGHTER_ALPHA } from "./PenStyle";
import { inkPdfContent, pdfNum } from "./InkPdf";
import {
	PdfPageInfo,
	asRef,
	bytesOf,
	dictEntries,
	objectBody,
	pdfPages,
	readPdf,
	setEntries,
} from "../pdf/PdfSyntax";

export type AppendResult = { ok: true; bytes: Uint8Array } | { ok: false; reason: string };

/**
 * What we call our alpha state inside somebody else's resources. Prefixed
 * because the name lands in a dictionary we do not own, and a page whose
 * generator already used `/GS0` must keep meaning its own.
 */
const GS_BASE = "HwAlpha";

/**
 * The transform from what the viewer showed to what the page stores.
 *
 * Ink is captured on the page AS DISPLAYED, so a `/Rotate 90` page - a
 * sideways scan, most often - was inked in the turned frame and the marks
 * have to be turned back. `flipHeight` is the displayed height, which is the
 * page's WIDTH on a quarter turn.
 *
 * Written before the flip in the stream and applied after it: PDF
 * concatenates, so the last `cm` a coordinate meets is the first one written
 * after it.
 */
export function pageMatrix(page: PdfPageInfo): { cm: string | null; flipHeight: number } {
	const { x, y, w, h } = page.box;
	switch (page.rotate) {
		case 90:
			return { cm: `0 1 -1 0 ${pdfNum(w + x)} ${pdfNum(y)}`, flipHeight: w };
		case 180:
			return { cm: `-1 0 0 -1 ${pdfNum(w + x)} ${pdfNum(h + y)}`, flipHeight: h };
		case 270:
			return { cm: `0 -1 1 0 ${pdfNum(x)} ${pdfNum(h + y)}`, flipHeight: w };
		default:
			// A box whose corner is not the origin is rare and legal, and ink
			// placed as though it were would sit off by that corner.
			return {
				cm: x === 0 && y === 0 ? null : `1 0 0 1 ${pdfNum(x)} ${pdfNum(y)}`,
				flipHeight: h,
			};
	}
}

function streamObject(body: string): string {
	return `<< /Length ${body.length} >>\nstream\n${body}\nendstream`;
}

/** Consecutive object numbers, which is what a cross-reference subsection is. */
function runsOf(sorted: readonly number[]): number[][] {
	const runs: number[][] = [];
	for (const n of sorted) {
		const last = runs[runs.length - 1];
		if (last !== undefined && last[last.length - 1] === n - 1) last.push(n);
		else runs.push([n]);
	}
	return runs;
}

/**
 * Where a flattened copy goes: beside the original, under a name that says
 * what it is.
 *
 * BESIDE, and never over the top. Writing into the document is the one thing
 * this feature promises not to do - the ink lives in a sidecar keyed by the
 * file BYTES (see `PdfIdentity`), so a PDF rewritten in place would no longer
 * match the id its own ink is filed under, and the marks would vanish from
 * the document they were drawn on.
 *
 * This is the BASE of a numbered series, not the final path: flattening
 * twice used to replace the earlier copy, and two flattens are two attempts
 * - the second must not eat the first. The caller counts up from this name
 * the way the snip does.
 */
export function flattenedPdfPath(path: string): string {
	// ".flattened" over ".ink": the name is read in a FILE EXPLORER, beside
	// the original, by someone deciding which one to share. "ink" said what
	// is inside; "flattened" says which file this IS.
	return `${path.replace(/\.pdf$/i, "")}.flattened.pdf`;
}

/** Our alpha state placed where a page can reach it, and its name there. */
interface Placed {
	name: string;
	/** A `/Resources` value for the page, or null when a shared object changed. */
	resources: string | null;
}

/**
 * The ink of `strokes` appended to `original`, page by page.
 *
 * Strokes carry the page they belong to (`InkStroke.page`, 1-based, the
 * viewer's own numbering); strokes without one, or with no samples, are not
 * ink on this document and are dropped.
 */
export function appendInkToPdf(original: Uint8Array, strokes: readonly InkStroke[]): AppendResult {
	const read = readPdf(original);
	if (!read.ok) return read;
	const doc = read.value;
	const list = pdfPages(doc);
	if (!list.ok) return list;
	const pages = list.value;

	const byPage = new Map<number, InkStroke[]>();
	for (const s of strokes) {
		if (s.page === undefined || s.points.length === 0) continue;
		const at = byPage.get(s.page);
		if (at === undefined) byPage.set(s.page, [s]);
		else at.push(s);
	}
	// Nothing to flatten. The file already is the answer, and appending an
	// empty update would change its bytes - and so its ink identity - for a
	// document that has not gained a mark.
	if (byPage.size === 0) return { ok: true, bytes: original };
	for (const index of byPage.keys()) {
		// Integer too: a page number that is not one matches no page, and the
		// strokes carrying it would be dropped without a word.
		if (!Number.isInteger(index) || index < 1 || index > pages.length) {
			return {
				ok: false,
				reason: `the ink names page ${index}, and this document has ${pages.length}`,
			};
		}
	}

	// New objects and rewritten ones together: an incremental update writes
	// both the same way, and only the numbering says which is which.
	const objects = new Map<number, string>();
	// Above the trailer's /Size AND above every object actually seen. A file
	// whose /Size undercounts is not rare enough to trust, and numbering a new
	// object over a live one replaces something the document still needs.
	let next = doc.size;
	for (const n of doc.offsets.keys()) next = Math.max(next, n + 1);
	for (const n of doc.packed.keys()) next = Math.max(next, n + 1);
	const add = (body: string): number => {
		const n = next++;
		objects.set(n, body);
		return n;
	};

	let gsNum = 0;
	let openNum = 0;
	let closeNum = 0;
	const placedAt = new Map<string, Placed>();

	const guards = (): void => {
		if (openNum !== 0) return;
		openNum = add(streamObject("q"));
		closeNum = add(streamObject("Q"));
	};

	const freeName = (taken: ReadonlySet<string>): string => {
		if (!taken.has(`/${GS_BASE}`)) return GS_BASE;
		for (let i = 1; ; i++) if (!taken.has(`/${GS_BASE}${i}`)) return `${GS_BASE}${i}`;
	};

	/**
	 * Highlighter needs a transparency state, and a `gs` operator can only
	 * name one the page's resources already reach. Whichever dictionary has to
	 * change is rewritten once and remembered, because pages commonly share
	 * one resources object and adding our name twice would write the key
	 * twice.
	 */
	const placeAlpha = (page: PdfPageInfo): Placed | { reason: string } => {
		if (gsNum === 0) {
			gsNum = add(
				`<< /Type /ExtGState /ca ${pdfNum(HIGHLIGHTER_ALPHA)} /CA ${pdfNum(HIGHLIGHTER_ALPHA)} >>`
			);
		}
		const gsRef = `${gsNum} 0 R`;
		if (page.resources === null) {
			return { name: GS_BASE, resources: `<< /ExtGState << /${GS_BASE} ${gsRef} >> >>` };
		}
		const resRef = asRef(page.resources);
		const resDict = resRef === null ? page.resources : objectBody(doc, resRef);
		if (resDict === null || !resDict.startsWith("<<")) {
			return { reason: `page ${page.index} has resources this writer cannot read` };
		}
		const site = resRef === null ? `page:${page.num}` : `object:${resRef}`;
		const done = placedAt.get(site);
		if (done !== undefined) return done;

		const gsEntry = dictEntries(resDict).get("/ExtGState");
		const gsEntryRef = asRef(gsEntry);
		const gsDict = gsEntry === undefined ? null : gsEntryRef === null ? gsEntry : objectBody(doc, gsEntryRef);
		if (gsEntry !== undefined && (gsDict === null || !gsDict.startsWith("<<"))) {
			return { reason: `page ${page.index} has a graphics state this writer cannot read` };
		}
		const name = gsDict === null ? GS_BASE : freeName(new Set(dictEntries(gsDict).keys()));
		const merged =
			gsDict === null
				? `<< /${name} ${gsRef} >>`
				: setEntries(gsDict, new Map([[`/${name}`, gsRef]]));

		let placed: Placed;
		if (gsEntryRef !== null) {
			// The states live in their own object: change that, and every page
			// reaching it - including this one - reaches ours too.
			objects.set(gsEntryRef, merged);
			placed = { name, resources: null };
		} else {
			const res = setEntries(resDict, new Map([["/ExtGState", merged]]));
			if (resRef === null) {
				// An inline dictionary, the page's own or inherited from an
				// ancestor. Writing the merged copy onto the page says exactly
				// what inheritance already said, plus our one name.
				placed = { name, resources: res };
			} else {
				objects.set(resRef, res);
				placed = { name, resources: null };
			}
		}
		placedAt.set(site, placed);
		return placed;
	};

	const contentsArray = (had: string | undefined, ink: number): string => {
		if (had === undefined) return `[${ink} 0 R]`;
		guards();
		// `/Contents` is a stream or an array of streams, and either may
		// arrive as a reference. A reference to an ARRAY has to be opened:
		// nesting it in ours would leave an element that is not a stream,
		// which is not a legal content list however sensible it looks.
		const ref = asRef(had);
		const target = ref === null ? had : (objectBody(doc, ref) ?? had);
		const list = target.startsWith("[") ? target.slice(1, -1).trim() : had;
		return `[${openNum} 0 R ${list} ${closeNum} 0 R ${ink} 0 R]`;
	};

	for (const page of pages) {
		const on = byPage.get(page.index);
		if (on === undefined) continue;
		let gsName = "GSa";
		let resources: string | null = null;
		if (on.some((s) => s.tool === "highlighter")) {
			const placed = placeAlpha(page);
			if ("reason" in placed) return { ok: false, reason: placed.reason };
			gsName = placed.name;
			resources = placed.resources;
		}
		const { cm, flipHeight } = pageMatrix(page);
		const inner = inkPdfContent(on, flipHeight, gsName);
		const contentNum = add(streamObject(cm === null ? inner : `q ${cm} cm ${inner} Q`));

		const body = objectBody(doc, page.num);
		if (body === null) return { ok: false, reason: `page ${page.index} could not be read back` };
		const changes = new Map<string, string>([
			["/Contents", contentsArray(dictEntries(body).get("/Contents"), contentNum)],
		]);
		if (resources !== null) changes.set("/Resources", resources);
		objects.set(page.num, setEntries(body, changes));
	}

	const numbers = [...objects.keys()].sort((a, b) => a - b);
	// Offsets count from the start of the FILE, so the tail is measured from
	// the original length. A file not ending in a newline gets one first, or
	// its last line and our first object become one line.
	let tail = original[original.length - 1] === 0x0a ? "" : "\n";
	const base = original.length;
	const offsets = new Map<number, number>();
	for (const n of numbers) {
		offsets.set(n, base + tail.length);
		tail += `${n} 0 obj\n${objects.get(n)!}\nendobj\n`;
	}
	const startxref = base + tail.length;
	const index = (rows: readonly number[]): string =>
		runsOf(rows)
			.map((run) => `${run[0]} ${run.length}`)
			.join(" ");
	// The same /ID the document already carried. An update that drops it
	// leaves the file without the one field that says which document this is
	// across its own revisions.
	const id = doc.trailerId === null ? "" : `/ID ${doc.trailerId} `;
	// Same reasoning as /ID: PDF 32000-1 s7.5.6 says an incremental update's
	// trailer carries forward the previous trailer's keys, and /Info is the
	// document's title, author and dates - dropped from every flattened copy
	// until now (audit-fixes-design.md s3 A2, 2026-09-02).
	const info = doc.infoRef === null ? "" : `/Info ${doc.infoRef} `;

	if (doc.streamed) {
		// The table is an object here, so it needs a number and an offset of
		// its own before it can describe itself - and it must appear in its
		// own rows, or the update it belongs to cannot be found.
		const self = next++;
		offsets.set(self, startxref);
		const rows = [...numbers, self];
		let table = "";
		for (const n of rows) {
			const at = offsets.get(n)!;
			// /W [1 4 2]: in use, a four-byte offset, generation zero.
			table += String.fromCharCode(
				1,
				(at >>> 24) & 0xff,
				(at >>> 16) & 0xff,
				(at >>> 8) & 0xff,
				at & 0xff,
				0,
				0
			);
		}
		tail +=
			`${self} 0 obj\n<< /Type /XRef /Size ${self + 1} ` +
			`/Root ${doc.rootNum} 0 R ${id}${info}/Prev ${doc.startxref} /W [1 4 2] ` +
			`/Index [${index(rows)}] /Length ${table.length} >>\n` +
			`stream\n${table}\nendstream\nendobj\n`;
	} else {
		const size = Math.max(doc.size, (numbers[numbers.length - 1] ?? 0) + 1);
		tail += "xref\n";
		for (const run of runsOf(numbers)) {
			tail += `${run[0]} ${run.length}\n`;
			for (const n of run) tail += `${String(offsets.get(n)!).padStart(10, "0")} 00000 n \n`;
		}
		tail +=
			`trailer\n<< /Size ${size} /Root ${doc.rootNum} 0 R ${id}${info}` +
			`/Prev ${doc.startxref} >>\n`;
	}
	tail += `startxref\n${startxref}\n%%EOF\n`;

	const extra = bytesOf(tail);
	const out = new Uint8Array(base + extra.length);
	out.set(original, 0);
	out.set(extra, base);
	return { ok: true, bytes: out };
}
