/**
 * Enough PDF syntax to add ink to a file somebody else wrote.
 *
 * Not a PDF library and never to become one. An incremental update has to
 * answer four questions about the original document and nothing more: where
 * its objects are, what its catalog is, which object each page is, and what
 * each page's box, rotation and resources say. Everything here exists to
 * answer one of those.
 *
 * Deliberately narrow, and it REFUSES rather than guesses:
 *
 * - **Both table formats.** A 1.5+ file stores its table as a compressed
 *   stream and its page objects inside object streams. Measured on 61
 *   documents to hand, refusing those cost 19 of them, so both are read; the
 *   decompression is `Flate`, written out for the reasons that file gives.
 * - **A half-understood table is worse than no table.** It produces a file
 *   some readers open and others reject - the worst failure available for a
 *   document being handed to another person - so every path here returns a
 *   reason rather than a guess.
 * - **Never encrypted.** Rewriting one object of an encrypted file without
 *   its cipher corrupts it.
 * - **Generation 0 only.** Higher generations are extinct in practice, and a
 *   rewrite at the wrong generation is invisible until a reader disagrees.
 *
 * Text is handled as one char per byte (`latin1`), so an offset in the
 * cross-reference table is an index into the text, with no decoder in the
 * middle inventing replacement characters or changing lengths. A WINDOW of
 * text at a time, never the file: see `Source`.
 *
 * Pure string work. No DOM, no fs, no pdf.js.
 */

import { inflate, unpredict } from "./Flate";

/** A read that names its reason for failing, because the user is shown it. */
export type PdfRead<T> = { ok: true; value: T } | { ok: false; reason: string };

/** Bytes as chars, one for one. Chunked: spreading megabytes blows the stack. */
export function latin1(bytes: Uint8Array): string {
	const CHUNK = 0x8000;
	let out = "";
	for (let i = 0; i < bytes.length; i += CHUNK) {
		out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return out;
}

/** The inverse. Masked, so a stray high char cannot widen into two bytes. */
export function bytesOf(text: string): Uint8Array {
	const out = new Uint8Array(text.length);
	for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
	return out;
}

/**
 * The file, decoded a window at a time.
 *
 * Turning a whole document into one string costs its size again in memory and
 * seconds of the main thread before anything has been read - measured at 4.5s
 * and a second copy for a 223 MB journal export, on an application that also
 * runs on an iPad. Nothing here ever needs the whole file: the tail, one
 * cross-reference section, one object dictionary. Each is a window, decoded
 * on demand and dropped.
 *
 * A window is latin-1 like the rest of this file, so an index inside it is
 * its start plus that index - which is what lets every parser below stay
 * exactly what it was when it read the whole file at once.
 */
export interface Source {
	bytes: Uint8Array;
	/** Latin-1 text of [from, to), clamped to the file. */
	text: (from: number, to: number) => string;
}

export function sourceOf(input: string | Uint8Array): Source {
	const bytes = typeof input === "string" ? bytesOf(input) : input;
	return {
		bytes,
		text: (from, to) =>
			latin1(bytes.subarray(Math.max(0, Math.min(from, bytes.length)), Math.max(0, Math.min(to, bytes.length)))),
	};
}

/** Where a window starts, before it has to grow. */
const WINDOW = 8192;

/**
 * Read at `from`, widening until what is being read fits.
 *
 * `read` returns null to ask for more room and a wrapped value - which may
 * itself be null - to say it is finished. Widening by eights rather than
 * doubling keeps the number of re-reads down: a cross-reference table for a
 * large document is megabytes, and each attempt starts over.
 */
function windowed<T>(
	src: Source,
	from: number,
	read: (text: string, atEof: boolean) => { value: T } | null
): T | null {
	let size = WINDOW;
	for (;;) {
		const to = Math.min(src.bytes.length, from + size);
		const atEof = to >= src.bytes.length;
		const got = read(src.text(from, to), atEof);
		if (got !== null) return got.value;
		if (atEof) return null;
		size *= 8;
	}
}

/** The first `needle` at or after `from`, searched over the bytes themselves. */
function findBytes(bytes: Uint8Array, needle: string, from: number): number {
	const first = needle.charCodeAt(0);
	const n = needle.length;
	outer: for (let i = Math.max(0, from); i + n <= bytes.length; i++) {
		if (bytes[i] !== first) continue;
		for (let j = 1; j < n; j++) if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
		return i;
	}
	return -1;
}

const WS = " \t\r\n\f\0";
const DELIM = "()<>[]{}/%";

function isWs(c: string): boolean {
	return WS.includes(c);
}

function isRegular(c: string): boolean {
	return !isWs(c) && !DELIM.includes(c);
}

/** Past whitespace and comments, either of which may sit between any tokens. */
export function skipWs(src: string, i: number): number {
	for (;;) {
		while (i < src.length && isWs(src[i]!)) i++;
		if (src[i] !== "%") return i;
		while (i < src.length && src[i] !== "\n" && src[i] !== "\r") i++;
	}
}

/**
 * The end of a literal string, which is the one place a `>>` or a `]` can
 * appear without meaning what it usually means. Backslash escapes are skipped
 * whole, so an escaped paren does not close it, and parentheses nest.
 */
function stringEnd(src: string, i: number): number {
	let depth = 0;
	for (let j = i; j < src.length; j++) {
		const c = src[j]!;
		if (c === "\\") {
			j++;
			continue;
		}
		if (c === "(") depth++;
		else if (c === ")" && --depth === 0) return j + 1;
	}
	return src.length;
}

function bracketEnd(src: string, i: number, open: string, close: string): number {
	let depth = 0;
	let j = i;
	while (j < src.length) {
		if (src.startsWith(open, j)) {
			depth++;
			j += open.length;
		} else if (src.startsWith(close, j)) {
			j += close.length;
			if (--depth === 0) return j;
		} else if (src[j] === "(") {
			j = stringEnd(src, j);
		} else {
			j++;
		}
	}
	return src.length;
}

/**
 * One value's extent, starting at `i`.
 *
 * The case that bites is the indirect reference: `12 0 R` is three tokens
 * meaning one value, and a reader that stops after `12` goes on to read the
 * next key as a number. So a number gets a two-token lookahead.
 */
export function valueEnd(src: string, i: number): number {
	const c = src[i];
	if (c === undefined) return i;
	if (c === "(") return stringEnd(src, i);
	if (c === "<" && src[i + 1] === "<") return bracketEnd(src, i, "<<", ">>");
	if (c === "<") {
		const close = src.indexOf(">", i);
		return close < 0 ? src.length : close + 1;
	}
	if (c === "[") return bracketEnd(src, i, "[", "]");
	let j = c === "/" ? i + 1 : i;
	while (j < src.length && isRegular(src[j]!)) j++;
	if (c === "/" || !/^\d+$/.test(src.slice(i, j))) return j;
	const gen = skipWs(src, j);
	let k = gen;
	while (k < src.length && isRegular(src[k]!)) k++;
	if (!/^\d+$/.test(src.slice(gen, k))) return j;
	const r = skipWs(src, k);
	const after = src[r + 1];
	if (src[r] !== "R" || (after !== undefined && isRegular(after))) return j;
	return r + 1;
}

/** Where one key's value sits inside a dictionary's text. */
export interface DictSpan {
	key: string;
	start: number;
	end: number;
}

/** Top-level keys of a `<< ... >>` span, in the order they were written. */
export function dictSpans(dict: string): DictSpan[] {
	const out: DictSpan[] = [];
	if (!dict.startsWith("<<") || !dict.endsWith(">>")) return out;
	const last = dict.length - 2;
	let i = 2;
	for (;;) {
		i = skipWs(dict, i);
		if (i >= last || dict[i] !== "/") return out;
		const keyEnd = valueEnd(dict, i);
		const start = skipWs(dict, keyEnd);
		const end = valueEnd(dict, start);
		if (end <= start) return out;
		out.push({ key: dict.slice(i, keyEnd), start, end });
		i = end;
	}
}

export function dictEntries(dict: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const s of dictSpans(dict)) if (!out.has(s.key)) out.set(s.key, dict.slice(s.start, s.end));
	return out;
}

/**
 * A dictionary with some keys replaced and every other byte untouched.
 *
 * Preserving the rest verbatim is the point. A page dictionary carries
 * annotations, tab order, thumbnails and private keys this writer does not
 * model, and re-serializing from a parse would drop whatever it failed to
 * understand. Replacements run last-first so the earlier spans keep their
 * offsets.
 */
export function setEntries(dict: string, changes: ReadonlyMap<string, string>): string {
	const spans = dictSpans(dict).filter((s) => changes.has(s.key));
	let out = dict;
	for (const s of [...spans].sort((a, b) => b.start - a.start)) {
		out = out.slice(0, s.start) + changes.get(s.key)! + out.slice(s.end);
	}
	const seen = new Set(spans.map((s) => s.key));
	const added = [...changes].filter(([k]) => !seen.has(k)).map(([k, v]) => `${k} ${v}`);
	if (added.length === 0) return out;
	return `${out.slice(0, out.length - 2).trimEnd()} ${added.join(" ")} >>`;
}

/** The object number of `12 0 R`, or null for anything else. */
export function asRef(value: string | undefined): number | null {
	if (value === undefined) return null;
	const m = /^(\d+)\s+\d+\s+R$/.exec(value.trim());
	return m ? Number(m[1]) : null;
}

/** Every number in an array's text, which is all a box or a matrix is. */
export function numbersIn(value: string): number[] {
	return (value.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
}

/** An object living inside an object stream rather than at a byte offset. */
export interface Packed {
	/** The object stream holding it. */
	stm: number;
	/** Its position within that stream. */
	index: number;
}

/** A document read far enough to be appended to. */
export interface PdfDoc extends Source {
	/** Object number to byte offset, the newest section winning. */
	offsets: ReadonlyMap<number, number>;
	/** Objects with no offset at all, because they were packed into a stream. */
	packed: ReadonlyMap<number, Packed>;
	/** The trailer's `/Size`: the first object number nobody has used. */
	size: number;
	rootNum: number;
	/** The trailer's `/ID` as written, so an update can repeat it. */
	trailerId: string | null;
	/** Where the newest table starts, which becomes our update's `/Prev`. */
	startxref: number;
	/**
	 * True when the NEWEST section was a stream. An update answers in the same
	 * format: the reader that opened this file understands that one, and a
	 * classic table appended to a stream chain is read by most tools and not
	 * by all of them.
	 */
	streamed: boolean;
	/** Unpacked object streams, so a page tree costs one inflate apiece. */
	unpacked: Map<number, Map<number, string>>;
}

interface XrefSection {
	offsets: Map<number, number>;
	packed: Map<number, Packed>;
	trailer: Map<string, string>;
	streamed: boolean;
}

/** A stream object: its dictionary, and its bytes as they sit in the file. */
interface RawStream {
	dict: string;
	data: Uint8Array;
}

/**
 * A stream object read at a byte offset.
 *
 * `/Length` is trusted only when it is a direct number landing on an
 * `endstream`. It is legal for it to be an indirect reference, and resolving
 * one needs the very table this is being used to read, so a length that does
 * not check out falls back to finding the keyword.
 */
function streamAt(src: Source, at: number): RawStream | null {
	const head = windowed<{ dict: string; from: number } | null>(src, at, (text, atEof) => {
		const i = skipWs(text, 0);
		const h = /^(\d+)\s+(\d+)\s+obj/.exec(text.slice(i, i + 48));
		if (h === null) return { value: null };
		const ds = skipWs(text, i + h[0].length);
		const de = valueEnd(text, ds);
		// A dictionary that runs to the edge may simply be bigger than the
		// window, and truncating it would read a different dictionary.
		if (de >= text.length && !atEof) return null;
		const dict = text.slice(ds, de);
		if (!dict.startsWith("<<")) return { value: null };
		let k = skipWs(text, de);
		if (k + 8 > text.length && !atEof) return null;
		if (!text.startsWith("stream", k)) return { value: null };
		k += 6;
		if (text[k] === "\r") k++;
		if (text[k] === "\n") k++;
		return { value: { dict, from: at + k } };
	});
	if (head === null) return null;
	const { dict, from } = head;
	const declared = dictEntries(dict).get("/Length");
	let len = declared !== undefined && /^\d+$/.test(declared) ? Number(declared) : -1;
	if (
		len < 0 ||
		from + len > src.bytes.length ||
		!/^\s*endstream/.test(src.text(from + len, from + len + 20))
	) {
		const end = findBytes(src.bytes, "endstream", from);
		if (end < 0) return null;
		len = end - from;
		while (len > 0 && (src.bytes[from + len - 1] === 0x0a || src.bytes[from + len - 1] === 0x0d)) {
			len--;
		}
	}
	// A view, not a copy: the only consumer inflates it, and a scanned page
	// can carry megabytes nobody needs duplicated.
	return { dict, data: src.bytes.subarray(from, from + len) };
}

/**
 * A stream unfiltered.
 *
 * FlateDecode only, which is what every cross-reference and object stream in
 * the corpus uses. Anything else returns null and becomes a refusal, rather
 * than bytes that are not what they say they are.
 */
function decodeStream(raw: RawStream): Uint8Array | null {
	const d = dictEntries(raw.dict);
	const filter = d.get("/Filter");
	if (filter === undefined) return raw.data;
	const names = filter.match(/\/[A-Za-z0-9]+/g) ?? [];
	if (names.length !== 1 || names[0] !== "/FlateDecode") return null;
	const out = inflate(raw.data);
	if (out === null) return null;
	// A single filter may still be written as a one-element array, and then
	// its parameters are an array too. Missing that reads the predictor as
	// absent and hands back rows that inflated cleanly and mean nothing.
	let parms = d.get("/DecodeParms") ?? d.get("/DecodeParams");
	if (parms !== undefined && parms.startsWith("[")) {
		const inner = parms.indexOf("<<");
		parms = inner < 0 ? undefined : parms.slice(inner, valueEnd(parms, inner));
	}
	if (parms === undefined || !parms.startsWith("<<")) return out;
	const p = dictEntries(parms);
	const predictor = Number(p.get("/Predictor") ?? 1);
	if (predictor <= 1) return out;
	return unpredict(
		out,
		predictor,
		Number(p.get("/Colors") ?? 1),
		Number(p.get("/BitsPerComponent") ?? 8),
		Number(p.get("/Columns") ?? 1)
	);
}

/**
 * A cross-reference STREAM: the same table, written as binary rows.
 *
 * `/W` gives each field its width in bytes, and a zero-width type field means
 * every row is type 1. Type 2 is the one that matters here - it says the
 * object was packed into an object stream and has no offset at all.
 */
function readXrefStream(src: Source, at: number): PdfRead<XrefSection> {
	const raw = streamAt(src, at);
	if (raw === null) return { ok: false, reason: "the cross-reference stream could not be read" };
	const d = dictEntries(raw.dict);
	if (d.get("/Type") !== "/XRef") {
		return { ok: false, reason: "the cross-reference offset points at no table" };
	}
	const data = decodeStream(raw);
	if (data === null) {
		return { ok: false, reason: "the cross-reference stream could not be decompressed" };
	}
	const w = numbersIn(d.get("/W") ?? "");
	if (w.length < 3) return { ok: false, reason: "the cross-reference stream declares no widths" };
	const size = Number(d.get("/Size") ?? 0);
	const index = d.has("/Index") ? numbersIn(d.get("/Index")!) : [0, size];
	const width = w[0]! + w[1]! + w[2]!;
	if (width <= 0) return { ok: false, reason: "the cross-reference stream declares no widths" };
	const offsets = new Map<number, number>();
	const packed = new Map<number, Packed>();
	let p = 0;
	const field = (bytes: number): number => {
		let v = 0;
		for (let b = 0; b < bytes; b++) v = v * 256 + data[p++]!;
		return v;
	};
	for (let sub = 0; sub + 1 < index.length; sub += 2) {
		let n = index[sub]!;
		for (let k = 0; k < index[sub + 1]!; k++, n++) {
			if (p + width > data.length) {
				return { ok: false, reason: "the cross-reference stream ends mid-row" };
			}
			const type = w[0] === 0 ? 1 : field(w[0]!);
			const a = field(w[1]!);
			const b = field(w[2]!);
			if (offsets.has(n) || packed.has(n)) continue;
			if (type === 1) offsets.set(n, a);
			else if (type === 2) packed.set(n, { stm: a, index: b });
		}
	}
	return { ok: true, value: { offsets, packed, trailer: d, streamed: true } };
}

function readXrefSection(src: Source, at: number): PdfRead<XrefSection> {
	const got = windowed<PdfRead<XrefSection> | "stream">(src, at, (text, atEof) => {
		let i = skipWs(text, 0);
		if (!text.startsWith("xref", i)) return { value: "stream" };
		i += 4;
		const offsets = new Map<number, number>();
		const packed = new Map<number, Packed>();
		for (;;) {
			i = skipWs(text, i);
			// Room for the longest thing that can be read next - a subsection
			// header, an entry, the trailer keyword. Short of that, the table
			// may simply continue past the window.
			if (i + 48 > text.length && !atEof) return null;
			if (text.startsWith("trailer", i)) {
				const d = skipWs(text, i + 7);
				const e = valueEnd(text, d);
				if (e >= text.length && !atEof) return null;
				const trailer = dictEntries(text.slice(d, e));
				return { value: { ok: true, value: { offsets, packed, trailer, streamed: false } } };
			}
			const head = /^(\d+)\s+(\d+)/.exec(text.slice(i, i + 48));
			if (!head) {
				return { value: { ok: false, reason: "a cross-reference subsection could not be read" } };
			}
			let n = Number(head[1]);
			const count = Number(head[2]);
			if (count > 1e7) {
				return { value: { ok: false, reason: "a cross-reference subsection is impossibly long" } };
			}
			i = skipWs(text, i + head[0].length);
			for (let k = 0; k < count; k++) {
				if (i + 32 > text.length && !atEof) return null;
				const entry = /^(\d{1,10})\s+(\d{1,5})\s+([nf])/.exec(text.slice(i, i + 32));
				if (!entry) {
					return { value: { ok: false, reason: "a cross-reference entry could not be read" } };
				}
				if (entry[3] === "n" && !offsets.has(n)) offsets.set(n, Number(entry[1]));
				n++;
				i = skipWs(text, i + entry[0].length);
			}
		}
	});
	if (got === null) return { ok: false, reason: "the cross-reference table runs past the end of the file" };
	if (got === "stream") return readXrefStream(src, at);
	return got;
}

/**
 * The cross-reference chain, newest first.
 *
 * Newest wins on every object: that IS the update mechanism, and reading the
 * chain in any other order resurrects the versions this file replaced. The
 * walk is bounded and remembers where it has been, because `/Prev` is a byte
 * offset in a file we did not write and can point at itself.
 */
export function readPdf(input: string | Uint8Array): PdfRead<PdfDoc> {
	const src = sourceOf(input);
	// `startxref` is the last thing a PDF writes, so it is looked for from the
	// end. Widening rather than reading the file: a document with junk
	// appended still has it within reach, and one without it never will.
	let tail = 2048;
	let text = "";
	let key = -1;
	for (;;) {
		const from = Math.max(0, src.bytes.length - tail);
		text = src.text(from, src.bytes.length);
		key = text.lastIndexOf("startxref");
		if (key >= 0 || from === 0 || tail > 1 << 20) break;
		tail *= 8;
	}
	if (key < 0) return { ok: false, reason: "the file ends without a startxref" };
	const m = /startxref\s+(\d+)/.exec(text.slice(key, key + 64));
	if (!m) return { ok: false, reason: "startxref names no offset" };
	const first = Number(m[1]);
	const offsets = new Map<number, number>();
	const packed = new Map<number, Packed>();
	const seen = new Set<number>();
	let size = 0;
	let rootNum = -1;
	let trailerId: string | null = null;
	let streamed = false;
	let at: number | null = first;
	// Newest wins, so an object already placed is never replaced by an older
	// section - including across the two maps, where a rewritten object leaves
	// a stale packed entry behind in the file it was rewritten in.
	const take = (section: XrefSection): void => {
		for (const [n, off] of section.offsets) {
			if (!offsets.has(n) && !packed.has(n)) offsets.set(n, off);
		}
		for (const [n, where] of section.packed) {
			if (!offsets.has(n) && !packed.has(n)) packed.set(n, where);
		}
	};
	while (at !== null) {
		if (seen.has(at)) return { ok: false, reason: "the cross-reference chain points back at itself" };
		if (seen.size > 64) return { ok: false, reason: "the cross-reference chain is too long to follow" };
		seen.add(at);
		const section = readXrefSection(src, at);
		if (!section.ok) return section;
		take(section.value);
		const trailer = section.value.trailer;
		if (trailer.has("/Encrypt")) return { ok: false, reason: "the document is encrypted" };
		if (rootNum < 0) rootNum = asRef(trailer.get("/Root")) ?? -1;
		if (size === 0) size = Number(trailer.get("/Size") ?? 0);
		if (trailerId === null) trailerId = trailer.get("/ID") ?? null;
		if (at === first) streamed = section.value.streamed;
		// A hybrid file keeps its packed objects in a stream beside the table,
		// for the sake of readers that only know the table. We know both, and
		// the table it sits beside has already had its say.
		const also = trailer.get("/XRefStm");
		if (also !== undefined && /^\d+$/.test(also) && !seen.has(Number(also))) {
			seen.add(Number(also));
			const extra = readXrefStream(src, Number(also));
			if (extra.ok) take(extra.value);
		}
		const prev = trailer.get("/Prev");
		at = prev !== undefined && /^\d+$/.test(prev) ? Number(prev) : null;
	}
	if (rootNum < 0) return { ok: false, reason: "the trailer names no catalog" };
	if (!Number.isInteger(size) || size <= 0) return { ok: false, reason: "the trailer declares no size" };
	return {
		ok: true,
		value: {
			bytes: src.bytes,
			text: src.text,
			offsets,
			packed,
			size,
			rootNum,
			trailerId,
			startxref: first,
			streamed,
			unpacked: new Map(),
		},
	};
}

/**
 * One object's value: the dictionary of a stream object, the whole thing
 * otherwise.
 *
 * Stopping at the value rather than hunting for `endobj` is not an
 * optimisation. Compressed stream bytes can contain `endobj`, so a scan for
 * it truncates real objects at a byte that only looked like a keyword.
 */
export function objectBody(doc: PdfDoc, num: number): string | null {
	const off = doc.offsets.get(num);
	if (off !== undefined) {
		if (off <= 0 || off >= doc.bytes.length) return null;
		return windowed<string | null>(doc, off, (text, atEof) => {
			const i = skipWs(text, 0);
			const head = /^(\d+)\s+(\d+)\s+obj/.exec(text.slice(i, i + 48));
			if (!head || Number(head[1]) !== num || head[2] !== "0") return { value: null };
			const start = skipWs(text, i + head[0].length);
			const end = valueEnd(text, start);
			// An object that fills the window may be a page tree node with
			// thousands of kids, so give it more room before believing it.
			if (end >= text.length && !atEof) return null;
			return { value: text.slice(start, end) };
		});
	}
	const where = doc.packed.get(num);
	if (where === undefined) return null;
	return unpack(doc, where.stm)?.get(num) ?? null;
}

/**
 * One object stream, opened.
 *
 * The bundle is a run of `number offset` pairs followed by the objects
 * themselves, all offsets counted from `/First`. Expanded whole and kept: a
 * page tree usually lives in one stream, and inflating it per page would
 * decompress the same kilobytes once for every page in the document.
 */
function unpack(doc: PdfDoc, num: number): Map<number, string> | null {
	const had = doc.unpacked.get(num);
	if (had !== undefined) return had;
	const off = doc.offsets.get(num);
	if (off === undefined) return null;
	const raw = streamAt(doc, off);
	if (raw === null) return null;
	const d = dictEntries(raw.dict);
	if (d.get("/Type") !== "/ObjStm") return null;
	const data = decodeStream(raw);
	if (data === null) return null;
	const text = latin1(data);
	const count = Number(d.get("/N") ?? 0);
	const first = Number(d.get("/First") ?? 0);
	const out = new Map<number, string>();
	const heads = numbersIn(text.slice(0, first));
	for (let i = 0; i < count; i++) {
		const objNum = heads[i * 2];
		const at = heads[i * 2 + 1];
		if (objNum === undefined || at === undefined) break;
		const start = skipWs(text, first + at);
		out.set(objNum, text.slice(start, valueEnd(text, start)));
	}
	doc.unpacked.set(num, out);
	return out;
}

/** A value, or what it points at when it is a reference. */
export function deref(doc: PdfDoc, value: string | undefined): string | null {
	if (value === undefined) return null;
	const ref = asRef(value);
	return ref === null ? value : objectBody(doc, ref);
}

/** A page, as everything an appended stream needs to know about it. */
export interface PdfPageInfo {
	/** Object number, so the dictionary can be restated. */
	num: number;
	/** 1-based, matching the viewer's own page numbering. */
	index: number;
	/**
	 * The box the VIEWER lays out, normalized: CropBox where there is one,
	 * clipped to MediaBox, and MediaBox otherwise.
	 *
	 * Not simply MediaBox. A viewer shows the crop box - pdf.js sizes its
	 * viewport from exactly this intersection - so on a trimmed page, which
	 * is most typeset ones, ink captured against the displayed corner would
	 * be written down against a corner nobody saw.
	 */
	box: { x: number; y: number; w: number; h: number };
	/** 0, 90, 180 or 270. The viewer applies it, so ink is stored under it. */
	rotate: number;
	/** The `/Resources` in force - the page's own, or an ancestor's. */
	resources: string | null;
	/** True when that value was inherited rather than written on the page. */
	inherited: boolean;
}

interface Inherited {
	box: string | null;
	crop: string | null;
	rotate: number;
	resources: string | null;
}

/** A box as written, normalized: either corner may be given first. */
function boxOf(value: string | null): { x: number; y: number; w: number; h: number } | null {
	if (value === null) return null;
	const n = numbersIn(value);
	if (n.length < 4) return null;
	const [x0, y0, x1, y1] = n as [number, number, number, number];
	return {
		x: Math.min(x0, x1),
		y: Math.min(y0, y1),
		w: Math.abs(x1 - x0),
		h: Math.abs(y1 - y0),
	};
}

/** Two boxes overlapped, or null when they do not meet. */
function clip(
	a: { x: number; y: number; w: number; h: number },
	b: { x: number; y: number; w: number; h: number }
): { x: number; y: number; w: number; h: number } | null {
	const x = Math.max(a.x, b.x);
	const y = Math.max(a.y, b.y);
	const w = Math.min(a.x + a.w, b.x + b.w) - x;
	const h = Math.min(a.y + a.h, b.y + b.h) - y;
	return w > 0 && h > 0 ? { x, y, w, h } : null;
}

/**
 * The page tree, flattened into the order the viewer shows.
 *
 * `/MediaBox`, `/Rotate` and `/Resources` are inheritable, so each is carried
 * down and overridden only where a node says otherwise - a page whose box
 * lives on the root node is normal, not a broken file.
 */
export function pdfPages(doc: PdfDoc): PdfRead<PdfPageInfo[]> {
	const catalog = objectBody(doc, doc.rootNum);
	if (catalog === null) return { ok: false, reason: "the catalog is missing" };
	const rootNum = asRef(dictEntries(catalog).get("/Pages"));
	if (rootNum === null) return { ok: false, reason: "the catalog names no page tree" };

	const pages: PdfPageInfo[] = [];
	const seen = new Set<number>();
	let failure: string | null = null;

	const walk = (num: number, from: Inherited, depth: number): void => {
		if (failure !== null) return;
		if (depth > 64) {
			failure = "the page tree is nested too deeply";
			return;
		}
		if (seen.has(num)) {
			failure = "the page tree points back at itself";
			return;
		}
		seen.add(num);
		const body = objectBody(doc, num);
		if (body === null) {
			failure = `page tree object ${num} could not be read`;
			return;
		}
		const d = dictEntries(body);
		const here: Inherited = {
			box: d.get("/MediaBox") ?? from.box,
			crop: d.get("/CropBox") ?? from.crop,
			rotate: d.has("/Rotate") ? (numbersIn(d.get("/Rotate")!)[0] ?? 0) : from.rotate,
			resources: d.get("/Resources") ?? from.resources,
		};
		const kids = d.get("/Kids");
		if (kids !== undefined) {
			for (const ref of kids.match(/\d+\s+\d+\s+R/g) ?? []) walk(asRef(ref)!, here, depth + 1);
			return;
		}
		if (here.box === null) {
			failure = `page ${pages.length + 1} declares no box`;
			return;
		}
		const media = boxOf(here.box);
		if (media === null) {
			failure = `page ${pages.length + 1} has an unreadable box`;
			return;
		}
		// A crop box that misses the page entirely is ignored rather than
		// obeyed: an empty intersection is a broken file, and a viewer falls
		// back to the media box there too.
		const crop = boxOf(here.crop);
		const view = crop === null ? media : (clip(crop, media) ?? media);
		// A negative or over-turned rotation is legal and means the same turn.
		const turn = ((Math.round(here.rotate / 90) * 90) % 360 + 360) % 360;
		pages.push({
			num,
			index: pages.length + 1,
			box: view,
			rotate: turn,
			resources: here.resources,
			inherited: !d.has("/Resources"),
		});
	};

	walk(rootNum, { box: null, crop: null, rotate: 0, resources: null }, 0);
	if (failure !== null) return { ok: false, reason: failure };
	if (pages.length === 0) return { ok: false, reason: "the document has no pages" };
	return { ok: true, value: pages };
}
