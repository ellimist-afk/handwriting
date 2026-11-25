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
import { highlightFills, inkPdfContent, PdfPageAssumption, pdfPageDestination, pdfNum } from "./InkPdf";
import { pageShade } from "./InkPdfPageShade";
import {
	PdfDoc,
	PdfPageInfo,
	asRef,
	bytesOf,
	dictEntries,
	objectBody,
	pdfPages,
	readPdf,
	setEntries,
} from "../pdf/PdfSyntax";

/**
 * `leftOut` counts the strokes on pages past the end of the document - ink
 * drawn before another app cut pages off it. They are not in the copy, and the
 * caller says how many.
 */
export type AppendResult =
	| { ok: true; bytes: Uint8Array; leftOut: number }
	| { ok: false; reason: string };

/**
 * What we call our alpha state inside somebody else's resources. Prefixed
 * because the name lands in a dictionary we do not own, and a page whose
 * generator already used `/GS0` must keep meaning its own.
 */
const GS_BASE = "HwAlpha";

/** What we call a page's highlight group among its XObjects, for the same reason. */
const GROUP_BASE = "HwHighlights";

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
 *
 * A page with a /UserUnit other than 1 is shown at its box times that unit,
 * and its ink was stored in that larger frame. So the flip is the shown
 * height, and the marks are brought back onto the box by the unit before the
 * turn and the box's corner. A unit of 1 writes what it always wrote.
 */
export function pageMatrix(page: PdfPageInfo, userUnit = 1): { cm: string | null; flipHeight: number } {
	const upright = turnOf(page);
	if (userUnit === 1) return upright;
	const k = unitNum(1 / userUnit);
	const scale = `${k} 0 0 ${k} 0 0`;
	return { cm: upright.cm === null ? scale : `${upright.cm} cm ${scale}`, flipHeight: upright.flipHeight * userUnit };
}

/**
 * The scale a /UserUnit asks for, to nine places: `pdfNum` keeps two, and a
 * unit of 1.5 written as 0.67 would move a mark at the far edge of a large
 * page by a point or more. Never exponent notation, as `pdfNum`.
 */
function unitNum(v: number): string {
	const s = v.toFixed(9).replace(/0+$/, "").replace(/\.$/, "");
	return s === "-0" || s === "" ? "0" : s;
}

/**
 * The page's /UserUnit as the viewer takes it: from the page's own dictionary
 * (it is not inherited), through a reference if it is one, and 1 for anything
 * that is not a number above 0.
 */
function userUnitOf(doc: PdfDoc, page: PdfPageInfo): number {
	const body = objectBody(doc, page.num);
	if (body === null) return 1;
	let v = dictEntries(body).get("/UserUnit");
	const ref = asRef(v);
	if (ref !== null) v = objectBody(doc, ref) ?? undefined;
	const t = v?.trim() ?? "";
	if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) return 1;
	const u = Number(t);
	return Number.isFinite(u) && u > 0 ? u : 1;
}

function turnOf(page: PdfPageInfo): { cm: string | null; flipHeight: number } {
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
 *
 * `assumption` is the settings dropdown, and it DEFAULTS TO `"darken"` so that
 * every existing caller and every geometry test keeps the shipped behaviour
 * without naming it. See the destination comment at the content call below for
 * what each answer costs. Alan ruled the default ("ink readable on white
 * pages"), then the control ("pdf ink three way dropdown") after finding that
 * neither position of a boolean helped black ink on a dark page.
 */
export function appendInkToPdf(
	original: Uint8Array,
	strokes: readonly InkStroke[],
	assumption: PdfPageAssumption = "darken"
): AppendResult {
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
	let leftOut = 0;
	for (const [index, on] of byPage) {
		// Integer too: a page number that is not one matches no page, and the
		// strokes carrying it would be dropped without a word.
		if (!Number.isInteger(index) || index < 1) {
			return {
				ok: false,
				reason: `the ink names page ${index}, and this document has ${pages.length}`,
			};
		}
		// A whole page number past the end: another app cut pages off after
		// the ink was drawn. That ink shows nowhere and nothing can select it,
		// so refusing would leave the user stuck. The copy goes without it and
		// the count goes back to be said.
		if (index > pages.length) {
			leftOut += on.length;
			byPage.delete(index);
		}
	}
	// Nothing to flatten. The file already is the answer, and appending an
	// empty update would change its bytes - and so its ink identity - for a
	// document that has not gained a mark.
	if (byPage.size === 0) return { ok: true, bytes: original, leftOut };

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

	const freeName = (taken: ReadonlySet<string>, base = GS_BASE): string => {
		if (!taken.has(`/${base}`)) return base;
		for (let i = 1; ; i++) if (!taken.has(`/${base}${i}`)) return `${base}${i}`;
	};

	/**
	 * A dictionary value as written or behind its reference. `undefined` when
	 * the key is absent, `null` when it is there and this writer cannot read
	 * it: a missing object, or something that is not a dictionary.
	 */
	const dictAt = (value: string | undefined): string | null | undefined => {
		if (value === undefined) return undefined;
		const ref = asRef(value);
		const dict = ref === null ? value : objectBody(doc, ref);
		return dict !== null && dict.startsWith("<<") ? dict : null;
	};

	/**
	 * A level above the page's nearest /Resources, as the viewer merges it:
	 * its dictionary; `undefined` for one the viewer passes over, a value that
	 * is not a dictionary or a reference to an object the file does not have;
	 * null for an object the file has and this writer cannot read, which the
	 * viewer may.
	 */
	const levelAt = (value: string): string | null | undefined => {
		const ref = asRef(value);
		if (ref === null) return value.startsWith("<<") ? value : undefined;
		if (!doc.offsets.has(ref) && !doc.packed.has(ref)) return undefined;
		const body = objectBody(doc, ref);
		if (body === null) return null;
		return body.startsWith("<<") ? body : undefined;
	};

	// One state per kind, each written once per file: a page reaches the one its own shade asks for.
	let multiplyNum = 0;
	let plainNum = 0;

	/**
	 * A page's highlights laid on the way the screen lays them: one
	 * transparency group, each stroke an opaque fill inside it in the order
	 * drawn, the group drawn once under the highlighter's alpha. So two
	 * crossing highlights are one coat, the later colour, never two
	 * (PdfInkBand.ts, HighlightLayer). `multiply` (a page the file draws
	 * light) draws it multiplied, so the page's own text stays dark under a
	 * highlight; every other page draws it with no blend mode, which stays
	 * readable on any shade.
	 *
	 * The page gets a /Resources of its OWN, copied from the one it reaches,
	 * with its /ExtGState and /XObject copied in beside it and one free name
	 * added to each. Nothing the original wrote is rewritten. Pages commonly
	 * share resources, and a name placed in a shared dictionary is one name
	 * for every page: each page's group would answer to the first page's, and
	 * a dictionary reached two ways would be written twice, the second write
	 * replacing the first.
	 *
	 * An /ExtGState or /XObject the nearest level lacks is copied from the
	 * first level above that holds one (`PdfPageInfo.above`). Obsidian's
	 * viewer merges a page's levels by key, so a file may keep a page's fonts
	 * on the page and its pictures on a node above it, and the viewer shows
	 * both; a copy of its own naming only ours would hide them, the page's own
	 * key reached first. A level above is read only for a key the nearest
	 * lacks. One the viewer passes over (`levelAt`) is passed over here; one
	 * the file has and this writer cannot read refuses the copy, as an
	 * unreadable nearest level does. The key found is read as the nearest
	 * level's would be.
	 *
	 * The group draws in the page's own space, so its box is the page box and
	 * the turn and flip sit inside its stream; it names no state, since a
	 * group starts from the default one and the alpha and blend belong to the
	 * one draw of it.
	 *
	 * `{ wash: true }` for a page whose /XObject is there and this writer
	 * cannot read, on its nearest level or the level above it is taken from,
	 * or behind a level above that this writer cannot read: the group has
	 * nowhere to be named, and that page keeps the wash (`placeAlpha`). Its
	 * /XObject is never read as absent: a dictionary this writer missed may be
	 * one a reader finds, with the page's pictures. Behind a level above that
	 * this writer cannot read, the wash needs the nearest level's own
	 * /ExtGState, where it places its state; without one it would write an
	 * /ExtGState on the page and hide the level above's, so that page is refused.
	 */
	const highlightGroup = (
		page: PdfPageInfo,
		fills: string,
		cm: string | null,
		flipHeight: number,
		multiply: boolean
	): { draw: string; resources: string } | { reason: string } | { wash: true } => {
		const res = page.resources === null ? "<< >>" : dictAt(page.resources);
		if (res == null) return { reason: `page ${page.index} has resources this writer cannot read` };
		const entries = dictEntries(res);
		const own = (key: string): string | null | undefined => dictAt(entries.get(key));
		let states = own("/ExtGState");
		if (states === null) return { reason: `page ${page.index} has a graphics state this writer cannot read` };
		// The wash places its state in the nearest level's own /ExtGState: with one there, it hides nothing above.
		const washFits = states !== undefined;
		let forms = own("/XObject");
		if (forms === null) return { wash: true };
		const fromAbove = (key: string): string | null | undefined | false => {
			for (const level of page.above ?? []) {
				const dict = levelAt(level);
				if (dict === null) return false;
				if (dict === undefined) continue;
				const value = dictEntries(dict).get(key);
				if (value !== undefined) return dictAt(value);
			}
			return undefined;
		};
		if (states === undefined) {
			const up = fromAbove("/ExtGState");
			if (up === false) return { reason: `page ${page.index} has resources this writer cannot read` };
			if (up === null) return { reason: `page ${page.index} has a graphics state this writer cannot read` };
			states = up;
		}
		if (forms === undefined) {
			const up = fromAbove("/XObject");
			if (up === false) return washFits ? { wash: true } : { reason: `page ${page.index} has resources this writer cannot read` };
			if (up === null) return { wash: true };
			forms = up;
		}

		const alpha = `/ca ${pdfNum(HIGHLIGHTER_ALPHA)} /CA ${pdfNum(HIGHLIGHTER_ALPHA)}`;
		if (multiply && multiplyNum === 0) multiplyNum = add(`<< /Type /ExtGState ${alpha} /BM /Multiply >>`);
		if (!multiply && plainNum === 0) plainNum = add(`<< /Type /ExtGState ${alpha} >>`);
		const stateNum = multiply ? multiplyNum : plainNum;
		const { x, y, w, h } = page.box;
		// Outward to the hundredth, so rounding never trims the page edge.
		const down = (v: number): string => pdfNum(Math.floor(v * 100) / 100);
		const up = (v: number): string => pdfNum(Math.ceil(v * 100) / 100);
		const inner = `q 1 0 0 -1 0 ${pdfNum(flipHeight)} cm ${fills}Q`;
		const body = cm === null ? inner : `q ${cm} cm ${inner} Q`;
		const groupNum = add(
			`<< /Type /XObject /Subtype /Form /BBox [${down(x)} ${down(y)} ${up(x + w)} ${up(y + h)}] ` +
				`/Group << /S /Transparency /I true >> /Resources << >> /Length ${body.length} >>\n` +
				`stream\n${body}\nendstream`
		);

		const stateName = freeName(new Set(dictEntries(states ?? "<< >>").keys()));
		const groupName = freeName(new Set(dictEntries(forms ?? "<< >>").keys()), GROUP_BASE);
		const resources = setEntries(
			res,
			new Map([
				["/ExtGState", setEntries(states ?? "<< >>", new Map([[`/${stateName}`, `${stateNum} 0 R`]]))],
				["/XObject", setEntries(forms ?? "<< >>", new Map([[`/${groupName}`, `${groupNum} 0 R`]]))],
			])
		);
		return { draw: `q /${stateName} gs /${groupName} Do Q`, resources };
	};

	/**
	 * Highlighter on a page whose /XObject this writer cannot read (see
	 * `highlightGroup`) keeps the plain wash, which needs a transparency
	 * state, and a `gs` operator
	 * can only name one the page's resources already reach. Whichever dictionary has to
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
		// A comment runs to the end of its line: when the old list's last line
		// holds one, ours start a line of their own, or they and the `]` would
		// be part of it. A content list holds references only, so a `%` in it
		// is a comment.
		const gap = /%[^\r\n]*$/.test(list) ? "\n" : " ";
		return `[${openNum} 0 R ${list}${gap}${closeNum} 0 R ${ink} 0 R]`;
	};

	for (const page of pages) {
		const on = byPage.get(page.index);
		if (on === undefined) continue;
		const { cm, flipHeight } = pageMatrix(page, userUnitOf(doc, page));
		// A DESTINATION THIS MODULE CANNOT SEE, so the user answers it. The
		// page already exists and we read its dictionary, never its pixels.
		//
		// "darken" (the default): assume white and keep light ink readable
		// there. Right for the overwhelmingly common page, and the complaint
		// the export slice was built for.
		//
		// "lighten": assume a dark page. Without it, black ink on a dark PDF
		// measured 1.06:1 and NOTHING in the product helped - the rule leaves
		// it alone because it already passes against white, so the failure was
		// an omission rather than an over-correction.
		//
		// "keep": write the stored colour, exactly as 1.4.12 did. This is the
		// only correct answer for a MID-TONE page, because both guesses fail
		// there and they fail symmetrically: adapting for white parks ink near
		// luminance 0.29 and loses five sampled grey pages, adapting for dark
		// parks it low and loses six.
		//
		// WHY A CHOICE RATHER THAN A CLEVERER RULE. No single colour serves a
		// white and a black page at once: matching the stored ink on black
		// needs luminance >= 0.9045, reaching 3.08:1 on white needs <= 0.2909.
		// That is luminance-only, so it holds for every strategy, and
		// InkPdfFlattenDestination.test.ts pins it. It does NOT forbid this
		// dropdown - a declared destination is one page at a time, which is
		// exactly the "at once" the proof rules out.
		//
		// `inkToPdf` is deliberately NOT given this control: it CREATES its
		// page and paints no background, and a PDF page with none is white in
		// every reader, so there the destination is a fact, not a guess.
		const destination = pdfPageDestination(assumption);
		// Every page lays its highlights on as one group, as the screen does, and
		// a page the FILE draws light multiplies it. Every other page draws it
		// with no blend mode: a page "lighten" says is dark, a page the file
		// itself draws dark, and a page whose shade its content does not say (a
		// scan is one picture). The setting cannot tell these apart: "darken" is
		// the default, and a multiply over a page the file draws black is a
		// multiply over black - the band vanishes. See `pageShade`, which is
		// asked only here, under a light-page setting, for a page with
		// highlights, so pen-only pages and "lighten" never open a stream. The
		// one page with no group is a page whose /XObject this writer cannot
		// read (`highlightGroup`).
		const highlighted = on.some((s) => s.tool === "highlighter");
		const lightPage = assumption !== "lighten" && highlighted && pageShade(doc, page) === "light";
		const fills = highlighted ? highlightFills(on, destination) : "";
		const pen = on.filter((s) => s.tool !== "highlighter");
		const group = fills === "" ? null : highlightGroup(page, fills, cm, flipHeight, lightPage);
		if (group !== null && "reason" in group) return { ok: false, reason: group.reason };
		let resources: string | null = null;
		let stream: string;
		if (group !== null && "draw" in group) {
			resources = group.resources;
			const ink = pen.length === 0 ? "" : inkPdfContent(pen, flipHeight, "GSa", destination);
			stream = ink === "" ? group.draw : `${group.draw} ${cm === null ? ink : `q ${cm} cm ${ink} Q`}`;
		} else {
			// No group. Pen ink only, or highlights whose outlines draw nothing:
			// no state to place. Or a page whose /XObject this writer cannot
			// read, which keeps the wash the copy wrote before the group, pen and
			// highlights in the order drawn, whatever the page's shade.
			let gsName = "GSa";
			if (group !== null) {
				const placed = placeAlpha(page);
				if ("reason" in placed) return { ok: false, reason: placed.reason };
				gsName = placed.name;
				resources = placed.resources;
			}
			const inner = inkPdfContent(group === null ? pen : on, flipHeight, gsName, destination);
			stream = cm === null ? inner : `q ${cm} cm ${inner} Q`;
		}
		const contentNum = add(streamObject(stream));

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
	return { ok: true, bytes: out, leftOut };
}
