/**
 * Is a PDF an earlier version of itself plus this plugin's own Flatten?
 *
 * Flatten (appendInkToPdf, InkPdfAppend.ts) writes a copy that is the PDF's
 * bytes unchanged, then one incremental update holding the ink drawn into the
 * pages and nothing else. Saved over the PDF it came from (copied over it in a
 * file manager, saved from another app, brought back by a sync), the copy's
 * bytes are new, so it opens on a fresh ink id while the old version's ink file
 * still claims the path. Both carry roads (PdfClaims) then laid that ink over
 * the ink already drawn in: each stroke twice, highlights two coats. The carry
 * asks this first, and a copy proven to be the old version plus our own update
 * gets none of the old ink.
 *
 * True only when every check passes:
 * - P0: the bytes are the version the ink would go to. Their head and length
 *   hash to `newFamily`. Asked again of the whole read before true, so a file
 *   that changed between the reads never mixes two versions in one answer.
 * - The ending is our writer's `startxref\n<S>\n%%EOF\n`, and the section at S
 *   is one of the two shapes it writes: a classic table, or an uncompressed
 *   `/W [1 4 2]` stream. The lowest offset it names (the stream's own row
 *   aside) is where our update starts, m. The old version's length L is m, or
 *   m-1 when byte m-1 is the newline our writer adds to a file not ending in
 *   one; P1 decides between them.
 * - P1: the first L bytes are the old version. Their head and L hash to
 *   `oldFamily`. A flattened copy of another PDF fails here.
 * - P2: the bytes after L are exactly what our writer frames around the
 *   update's objects, rebuilt from the old version's own trailer: the leading
 *   newline rule, each object at its offset in ascending number, the section in
 *   the old version's format, and the ending.
 * - P3: every object is one our writer writes. A new one is a stream of ink
 *   operators, one of our transparency states, or our highlight group, and the
 *   new numbers run on from the writer's first free number without a gap. A
 *   rewritten page changed only in /Contents and /Resources, the way the writer
 *   changes them; any other rewritten object is a states or resources
 *   dictionary given only our one alpha name. At least one page is inked.
 *
 * The framing and object rules restate the writer's in a second place, so a
 * change to the writer makes this say false (the carry runs as before, and the
 * ink doubles again). PdfFlattenedCopy.test.ts runs this on the writer's own
 * output for every shape it writes, so such a change reds there first.
 *
 * Any doubt is false: an error, a read that stops short, a file over the cap, a
 * shape our writer does not write. It never throws.
 *
 * Reads: with a ranged route (desktop), the size and the last KiB, the section,
 * the head, and only once P0 and P1 pass, the whole file, all on one handle
 * closed in finally. With none (mobile), or when the handle will not open, one
 * whole read, and the checks run on those bytes.
 */

import type { HeadSource, RangedHandle } from "./PdfHead";
import { HEAD_BYTES, pdfInkIdFromHead } from "./PdfIdentity";
import { asRef, dictEntries, latin1, numbersIn, objectBody, pdfPages, readPdf, setEntries, skipWs, valueEnd } from "./PdfSyntax";
import type { PdfDoc, PdfPageInfo } from "./PdfSyntax";
import { HIGHLIGHTER_ALPHA } from "../ink/PenStyle";
import { pdfNum } from "../ink/InkPdf";

/**
 * Above this the answer is false. The proof reads the whole file and parses the
 * old version; on a phone that is a second copy of a big scan in memory.
 */
export const FLATTEN_PROOF_CAP = 256 * 1024 * 1024;

/** The longest section read: our update's table is a few rows per inked page. */
const SECTION_CAP = 4 * 1024 * 1024;

type Crypto = Parameters<typeof pdfInkIdFromHead>[2];

/** A file's bytes by range: exactly [at, at + len), or a throw. */
interface Bytes {
	size: number;
	read(at: number, len: number): Promise<Uint8Array>;
}

async function readExactly(handle: RangedHandle, at: number, len: number): Promise<Uint8Array> {
	const buf = new Uint8Array(len);
	let got = 0;
	while (got < len) {
		const n = await handle.read(buf.subarray(got), at + got);
		if (n <= 0) break;
		got += n;
	}
	if (got < len) throw new Error(`pdf read stopped at ${got} of ${len} bytes`);
	return buf;
}

function inMemory(bytes: Uint8Array): Bytes {
	return {
		size: bytes.length,
		read: async (at, len) => {
			if (at < 0 || len < 0 || at + len > bytes.length) throw new Error("read past the end of the file");
			return bytes.subarray(at, at + len);
		},
	};
}

/**
 * True when the PDF `src` reads is the version whose content family is
 * `oldFamily` plus one update of this plugin's Flatten, and its own bytes are
 * the family `newFamily`. Never throws; any doubt is false.
 */
export async function isOwnFlattenOf(src: HeadSource, oldFamily: string, newFamily: string, crypto?: Crypto): Promise<boolean> {
	try {
		let handle: RangedHandle | null = null;
		if (src.openRanged) {
			try {
				handle = await src.openRanged();
			} catch {
				handle = null;
			}
		}
		if (handle !== null) {
			const open = handle;
			try {
				const size = await open.size();
				return await prove({ size, read: (at, len) => readExactly(open, at, len) }, oldFamily, newFamily, crypto);
			} finally {
				try {
					await open.close();
				} catch {
					// The answer is already in hand; nothing to tell the user.
				}
			}
		}
		const whole = await src.whole();
		return await prove(inMemory(whole instanceof Uint8Array ? whole : new Uint8Array(whole)), oldFamily, newFamily, crypto);
	} catch {
		return false;
	}
}

/** The offsets one section names, and the section's own object number when it is a stream. */
interface Section {
	offsets: Map<number, number>;
	self: number | null;
}

/** A classic table at the start of `text`, or our uncompressed `/W [1 4 2]` stream; null for anything else. */
function readSection(text: string): Section | null {
	if (text.startsWith("xref")) {
		const offsets = new Map<number, number>();
		let i = 4;
		for (;;) {
			i = skipWs(text, i);
			if (text.startsWith("trailer", i)) return { offsets, self: null };
			const head = /^(\d+)\s+(\d+)/.exec(text.slice(i, i + 48));
			if (!head) return null;
			let n = Number(head[1]);
			const count = Number(head[2]);
			i += head[0].length;
			for (let k = 0; k < count; k++, n++) {
				i = skipWs(text, i);
				const entry = /^(\d{1,10})\s+(\d{1,5})\s+([nf])/.exec(text.slice(i, i + 32));
				if (!entry) return null;
				if (entry[3] === "n") offsets.set(n, Number(entry[1]));
				i += entry[0].length;
			}
		}
	}
	const obj = /^(\d+) 0 obj\n/.exec(text);
	if (!obj || text[obj[0].length] !== "<") return null;
	const dictAt = obj[0].length;
	const dictEnd = valueEnd(text, dictAt);
	const d = dictEntries(text.slice(dictAt, dictEnd));
	if (d.get("/Type") !== "/XRef" || d.has("/Filter") || d.has("/DecodeParms")) return null;
	const w = numbersIn(d.get("/W") ?? "");
	if (w.join(" ") !== "1 4 2") return null;
	const length = Number(d.get("/Length"));
	if (!text.startsWith("\nstream\n", dictEnd) || !Number.isInteger(length) || length % 7 !== 0) return null;
	const data = text.slice(dictEnd + 8, dictEnd + 8 + length);
	if (data.length !== length) return null;
	const index = numbersIn(d.get("/Index") ?? "");
	const offsets = new Map<number, number>();
	let p = 0;
	for (let sub = 0; sub + 1 < index.length; sub += 2) {
		let n = index[sub]!;
		for (let k = 0; k < index[sub + 1]!; k++, n++) {
			if (p + 7 > data.length) return null;
			const at = data.charCodeAt(p + 1) * 0x1000000 + data.charCodeAt(p + 2) * 0x10000 + data.charCodeAt(p + 3) * 0x100 + data.charCodeAt(p + 4);
			if (data.charCodeAt(p) === 1) offsets.set(n, at);
			p += 7;
		}
	}
	return { offsets, self: Number(obj[1]) };
}

async function prove(b: Bytes, oldFamily: string, newFamily: string, crypto?: Crypto): Promise<boolean> {
	const size = b.size;
	if (!Number.isSafeInteger(size) || size <= 0 || size > FLATTEN_PROOF_CAP) return false;

	// The ending, our writer's exact last line, and the section it names.
	const endLen = Math.min(size, 1024);
	const end = latin1(await b.read(size - endLen, endLen));
	const ending = /startxref\n(\d+)\n%%EOF\n$/.exec(end);
	if (!ending) return false;
	const sectionAt = Number(ending[1]);
	const sectionEnd = size - endLen + ending.index;
	if (!Number.isSafeInteger(sectionAt) || sectionAt <= 0 || sectionAt >= sectionEnd || sectionEnd - sectionAt > SECTION_CAP) return false;
	const section = readSection(latin1(await b.read(sectionAt, sectionEnd - sectionAt)));
	if (section === null) return false;
	let start = Infinity;
	for (const [n, at] of section.offsets) if (n !== section.self) start = Math.min(start, at);
	if (!Number.isFinite(start) || start < 2 || start >= sectionAt) return false;

	// P0 and P1 on the head: the new version's family, and the old version's length and family.
	const head = await b.read(0, Math.min(HEAD_BYTES, size));
	if ((await pdfInkIdFromHead(head, size, crypto)) !== newFamily) return false;
	const before = (await b.read(start - 1, 1))[0];
	const lengths = before === 0x0a ? [start, start - 1] : [start];
	let oldLength = -1;
	for (const l of lengths) {
		if ((await pdfInkIdFromHead(head.subarray(0, Math.min(l, HEAD_BYTES)), l, crypto)) === oldFamily) {
			oldLength = l;
			break;
		}
	}
	if (oldLength < 0) return false;

	// The whole file, then P0 and P1 again on it: a file changed between the reads is false.
	const bytes = await b.read(0, size);
	if ((await pdfInkIdFromHead(bytes.subarray(0, Math.min(HEAD_BYTES, size)), size, crypto)) !== newFamily) return false;
	if ((await pdfInkIdFromHead(bytes.subarray(0, Math.min(oldLength, HEAD_BYTES)), oldLength, crypto)) !== oldFamily) return false;
	return ourUpdate(bytes, oldLength, sectionAt, section);
}

/** Consecutive object numbers, which is what a cross-reference subsection is (InkPdfAppend.ts runsOf). */
function runsOf(sorted: readonly number[]): number[][] {
	const runs: number[][] = [];
	for (const n of sorted) {
		const last = runs[runs.length - 1];
		if (last !== undefined && last[last.length - 1] === n - 1) last.push(n);
		else runs.push([n]);
	}
	return runs;
}

/** P2 and P3 on the whole bytes, the old version's length L, and the newest section. */
function ourUpdate(bytes: Uint8Array, oldLength: number, sectionAt: number, section: Section): boolean {
	const read = readPdf(bytes.subarray(0, oldLength));
	if (!read.ok) return false;
	const doc = read.value;
	const pages = pdfPages(doc);
	if (!pages.ok) return false;
	if (doc.streamed !== (section.self !== null)) return false;

	// P2: the objects at their offsets, in ascending number, framed exactly as the writer frames them.
	const text = latin1(bytes.subarray(oldLength));
	const numbers = [...section.offsets.keys()].filter((n) => n !== section.self).sort((a, c) => a - c);
	const objects = new Map<number, string>();
	let tail = bytes[oldLength - 1] === 0x0a ? "" : "\n";
	for (let k = 0; k < numbers.length; k++) {
		const n = numbers[k]!;
		const at = section.offsets.get(n)! - oldLength;
		if (at !== tail.length) return false;
		const open = `${n} 0 obj\n`;
		if (!text.startsWith(open, at)) return false;
		const next = k + 1 < numbers.length ? section.offsets.get(numbers[k + 1]!)! - oldLength : sectionAt - oldLength;
		const close = next - "\nendobj\n".length;
		if (close < at + open.length || text.slice(close, next) !== "\nendobj\n") return false;
		const body = text.slice(at + open.length, close);
		objects.set(n, body);
		tail += `${open}${body}\nendobj\n`;
	}
	const startxref = oldLength + tail.length;
	if (startxref !== sectionAt) return false;
	const index = (rows: readonly number[]): string => runsOf(rows).map((run) => `${run[0]} ${run.length}`).join(" ");
	const id = doc.trailerId === null ? "" : `/ID ${doc.trailerId} `;
	const info = doc.infoRef === null ? "" : `/Info ${doc.infoRef} `;
	if (section.self !== null) {
		const self = section.self;
		const rows = [...numbers, self];
		let table = "";
		for (const n of rows) {
			const at = n === self ? startxref : section.offsets.get(n)!;
			table += String.fromCharCode(1, (at >>> 24) & 0xff, (at >>> 16) & 0xff, (at >>> 8) & 0xff, at & 0xff, 0, 0);
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
			for (const n of run) tail += `${String(section.offsets.get(n)!).padStart(10, "0")} 00000 n \n`;
		}
		tail += `trailer\n<< /Size ${size} /Root ${doc.rootNum} 0 R ${id}${info}/Prev ${doc.startxref} >>\n`;
	}
	tail += `startxref\n${startxref}\n%%EOF\n`;
	if (tail !== text) return false;

	// P3: the numbering, then every object.
	let first = doc.size;
	for (const n of doc.offsets.keys()) first = Math.max(first, n + 1);
	for (const n of doc.packed.keys()) first = Math.max(first, n + 1);
	const fresh = numbers.filter((n) => n >= first);
	if (fresh.length === 0 || fresh.some((n, i) => n !== first + i)) return false;
	if (section.self !== null && section.self !== first + fresh.length) return false;
	const kinds = new Map<number, Kind>();
	for (const n of fresh) {
		const kind = kindOf(objects.get(n)!);
		if (kind === null) return false;
		kinds.set(n, kind);
	}
	const byNum = new Map(pages.value.map((p) => [p.num, p]));
	let inked = 0;
	for (const n of numbers) {
		if (n >= first) continue;
		const was = objectBody(doc, n);
		if (was === null) return false;
		const page = byNum.get(n);
		if (page !== undefined) {
			if (!pageRewrite(doc, page, was, objects.get(n)!, kinds)) return false;
			inked++;
		} else if (!sharedRewrite(was, objects.get(n)!, kinds)) return false;
	}
	return inked > 0;
}

/** What a new object of our writer's is. */
type Kind = { stream: string } | "state" | "multiply" | "group";

const ALPHA = `/ca ${pdfNum(HIGHLIGHTER_ALPHA)} /CA ${pdfNum(HIGHLIGHTER_ALPHA)}`;
const PLAIN_STATE = `<< /Type /ExtGState ${ALPHA} >>`;
const MULTIPLY_STATE = `<< /Type /ExtGState ${ALPHA} /BM /Multiply >>`;
const NUMBER = /^-?\d+(?:\.\d+)?$/;
const NAME = /^\/[A-Za-z0-9]+$/;
/** Every operator the ink writer emits (InkPdf.ts inkPdfContent, highlightFills; InkPdfAppend.ts highlightGroup). */
const OPERATORS = new Set(["q", "Q", "cm", "gs", "Do", "rg", "m", "l", "c", "h", "f"]);

/** Ink content: numbers, names and our operators only, single-space separated. */
function inkOps(data: string): boolean {
	const tokens = data.split(" ");
	if (tokens.length === 0 || data.trim() !== data) return false;
	return tokens.every((t) => NUMBER.test(t) || NAME.test(t) || OPERATORS.has(t));
}

function kindOf(body: string): Kind | null {
	if (body === PLAIN_STATE) return "state";
	if (body === MULTIPLY_STATE) return "multiply";
	const stream = /^<< \/Length (\d+) >>\nstream\n([\s\S]*)\nendstream$/.exec(body);
	if (stream) return stream[2]!.length === Number(stream[1]) && inkOps(stream[2]!) ? { stream: stream[2]! } : null;
	const group =
		/^<< \/Type \/XObject \/Subtype \/Form \/BBox \[-?\d+(?:\.\d+)? -?\d+(?:\.\d+)? -?\d+(?:\.\d+)? -?\d+(?:\.\d+)?\] \/Group << \/S \/Transparency \/I true >> \/Resources << >> \/Length (\d+) >>\nstream\n([\s\S]*)\nendstream$/.exec(
			body
		);
	if (group) return group[2]!.length === Number(group[1]) && inkOps(group[2]!) ? "group" : null;
	return null;
}

const isStream = (kinds: ReadonlyMap<number, Kind>, n: number | null, data?: string): boolean => {
	const kind = n === null ? undefined : kinds.get(n);
	return typeof kind === "object" && (data === undefined || kind.stream === data);
};

/** The writer's free name for a key in a dictionary (InkPdfAppend.ts freeName). */
function freeName(taken: ReadonlySet<string>, base = "HwAlpha"): string {
	if (!taken.has(`/${base}`)) return base;
	for (let i = 1; ; i++) if (!taken.has(`/${base}${i}`)) return `${base}${i}`;
}

/** A dictionary as written or behind its reference; undefined when absent, null when unreadable (InkPdfAppend.ts dictAt). */
function dictAt(doc: PdfDoc, value: string | undefined): string | null | undefined {
	if (value === undefined) return undefined;
	const ref = asRef(value);
	const dict = ref === null ? value : objectBody(doc, ref);
	return dict !== null && dict.startsWith("<<") ? dict : null;
}

/** The object a key of an inline dictionary refers to, or null. */
function refIn(dict: string | undefined, key: string): number | null {
	return dict === undefined ? null : asRef(dictEntries(dict).get(key));
}

/** A page of the old version, rewritten by the writer: only /Contents and /Resources changed, each as the writer changes it. */
function pageRewrite(doc: PdfDoc, page: PdfPageInfo, was: string, body: string, kinds: ReadonlyMap<number, Kind>): boolean {
	const now = dictEntries(body);
	const had = dictEntries(was);
	const contents = now.get("/Contents");
	if (contents === undefined) return false;
	const changes = new Map([["/Contents", contents]]);
	const resources = now.get("/Resources");
	if (resources !== undefined && resources !== had.get("/Resources")) changes.set("/Resources", resources);
	if (setEntries(was, changes) !== body) return false;

	// /Contents: our stream alone, or the old list between our q and Q, then our stream (contentsArray).
	const old = had.get("/Contents");
	if (old === undefined) {
		const ink = /^\[(\d+) 0 R\]$/.exec(contents);
		if (!ink || !isStream(kinds, Number(ink[1]))) return false;
	} else {
		const ref = asRef(old);
		const target = ref === null ? old : (objectBody(doc, ref) ?? old);
		const list = target.startsWith("[") ? target.slice(1, -1).trim() : old;
		const parts = /^\[(\d+) 0 R [\s\S]* (\d+) 0 R (\d+) 0 R\]$/.exec(contents);
		if (!parts || contents !== `[${parts[1]} 0 R ${list} ${parts[2]} 0 R ${parts[3]} 0 R]`) return false;
		if (!isStream(kinds, Number(parts[1]), "q") || !isStream(kinds, Number(parts[2]), "Q") || !isStream(kinds, Number(parts[3]))) return false;
	}
	if (!changes.has("/Resources")) return true;
	return groupResources(doc, page, resources!, kinds) || alphaResources(page, resources!, kinds);
}

/** The page's own /Resources from highlightGroup: the reached dictionary, its states and forms each given one of our names. */
function groupResources(doc: PdfDoc, page: PdfPageInfo, value: string, kinds: ReadonlyMap<number, Kind>): boolean {
	const res = page.resources === null ? "<< >>" : dictAt(doc, page.resources);
	if (res == null) return false;
	const entries = dictEntries(res);
	const states = dictAt(doc, entries.get("/ExtGState"));
	const forms = dictAt(doc, entries.get("/XObject"));
	if (states === null || forms === null) return false;
	const stateName = freeName(new Set(dictEntries(states ?? "<< >>").keys()));
	const groupName = freeName(new Set(dictEntries(forms ?? "<< >>").keys()), "HwHighlights");
	const got = dictEntries(value);
	const state = refIn(got.get("/ExtGState"), `/${stateName}`);
	const group = refIn(got.get("/XObject"), `/${groupName}`);
	if (state === null || group === null) return false;
	const stateKind = kinds.get(state);
	if ((stateKind !== "state" && stateKind !== "multiply") || kinds.get(group) !== "group") return false;
	return (
		value ===
		setEntries(
			res,
			new Map([
				["/ExtGState", setEntries(states ?? "<< >>", new Map([[`/${stateName}`, `${state} 0 R`]]))],
				["/XObject", setEntries(forms ?? "<< >>", new Map([[`/${groupName}`, `${group} 0 R`]]))],
			])
		)
	);
}

/** The page's own /Resources from placeAlpha: none reached, or an inline dictionary whose inline states gain our alpha. */
function alphaResources(page: PdfPageInfo, value: string, kinds: ReadonlyMap<number, Kind>): boolean {
	if (page.resources === null) {
		const state = /^<< \/ExtGState << \/HwAlpha (\d+) 0 R >> >>$/.exec(value);
		return state !== null && kinds.get(Number(state[1])) === "state";
	}
	if (asRef(page.resources) !== null || !page.resources.startsWith("<<")) return false;
	return withAlpha(page.resources, value, kinds);
}

/** `was` with an inline /ExtGState given our alpha name, or one added: the dictionary placeAlpha writes. */
function withAlpha(was: string, value: string, kinds: ReadonlyMap<number, Kind>): boolean {
	const gsEntry = dictEntries(was).get("/ExtGState");
	if (gsEntry !== undefined && (asRef(gsEntry) !== null || !gsEntry.startsWith("<<"))) return false;
	const name = gsEntry === undefined ? "HwAlpha" : freeName(new Set(dictEntries(gsEntry).keys()));
	const state = refIn(dictEntries(value).get("/ExtGState"), `/${name}`);
	if (state === null || kinds.get(state) !== "state") return false;
	const merged = gsEntry === undefined ? `<< /${name} ${state} 0 R >>` : setEntries(gsEntry, new Map([[`/${name}`, `${state} 0 R`]]));
	return value === setEntries(was, new Map([["/ExtGState", merged]]));
}

/** A shared object placeAlpha rewrote: a states dictionary given our alpha, or a resources dictionary whose inline states gain it. */
function sharedRewrite(was: string, body: string, kinds: ReadonlyMap<number, Kind>): boolean {
	if (!was.startsWith("<<")) return false;
	const name = freeName(new Set(dictEntries(was).keys()));
	const state = refIn(body, `/${name}`);
	if (state !== null && kinds.get(state) === "state" && body === setEntries(was, new Map([[`/${name}`, `${state} 0 R`]]))) return true;
	return withAlpha(was, body, kinds);
}
