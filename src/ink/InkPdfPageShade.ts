/**
 * Whether a page of somebody else's PDF is drawn dark, read from the page's
 * own content stream.
 *
 * The flattened copy lays a light page's highlights on as one multiplied
 * group (`InkPdfAppend`), and a multiply over a dark page is a multiply over
 * black: the band is gone. So the copy has to know the page, and it has to
 * know it from the FILE. The screen's answer is no use here: it is a reading
 * of pixels the app may have turned dark itself (a page the app made dark is
 * light in the file, and the multiply is right there), and it exists only for
 * pages somebody scrolled past.
 *
 * Three answers, and only one of them takes the group:
 *
 * - "light": every mark that covers area was read, and over white they
 *   average light by the screen's own rule (PdfViewerProbe's
 *   `readCanvasDark`: the mean of 0.2126 R + 0.7152 G + 0.0722 B on 0-255,
 *   under one half is dark), across the page box the viewer shows.
 * - "dark": the same reading, averaging dark.
 * - "unknown": anything this reader cannot judge. A picture (`Do`, an inline
 *   image), a shading, a colour that is not a plain device colour, a
 *   transparency or blend state, a clip made of glyphs (text render modes
 *   4-7), a filter other than Flate, a stream that will not open, one past the
 *   size cap, an operator it does not know, math that stops being a finite
 *   number (a matrix, a fill's box, the fills' work, the mean). A scanned page
 *   is one picture, so a scan is unknown, whichever way it looks.
 *
 * Unknown is never light: the caller treats it as dark, which writes the
 * plain wash the copy wrote before the group existed. That is the safe side
 * on purpose. A light page called unknown loses the group and keeps the old
 * look; a dark page called light loses its band.
 *
 * WHAT IS COUNTED. Fills, on a grid of sample points over the page box, each
 * fill painting the samples it covers with its colour, later fills over
 * earlier ones, white where nothing painted: the page as a painter would
 * lay it, sampled. A clip that is one rectangle cuts fills to it. A clip that
 * is not (two subpaths, as Chrome prints an underlined link; a triangle; a
 * curve) is read as a BOUND: the rectangle in force, which the true clip lies
 * inside. A fill under a bound may cover less than the samples it reaches, so
 * each of them takes the darker of what it holds and the fill: a fill can
 * only make such a page read darker than it is, so a page read as light is
 * light. Strokes by their area (length times width) at their colour, laid
 * over white with overlaps not taken off and no clip applied, under a
 * rectangle or a bound alike. Caps and joins are not read: a round-capped dot
 * counts nothing, and a short wide capped stroke less than it paints. Text is
 * not counted: glyphs are a small share of a page, the share the screen's
 * averaging reads as "fine print does not read as its glyphs". Annotations
 * are not read.
 *
 * OUR OWN OUTPUT. A flattened copy carries this plugin's ink at the end of
 * the page's content list: the highlight group drawn under a transparency
 * state, or the plain wash, which is a fill under one. Read as content, that
 * is unknown, so a copy flattened again lost the multiply its first flatten
 * had. When the page as it stands is unknown, our output is peeled off the
 * end of the list (`peeled`) and the page is read as it was before it. Ours
 * is proven by shape: each stream exactly as the writer emits it, each name
 * it uses followed to an object that is exactly ours. A page this reader
 * judges light or dark as it stands keeps that answer, whatever its shape.
 *
 * Read only, synchronous, and bounded: one inflate per content stream, a cap
 * on the bytes before and after it, and a cap on the work the fills cost.
 * Nothing here throws on a file it does not understand; that file is unknown.
 */

import { inflate } from "../pdf/Flate";
import { PdfDoc, PdfPageInfo, asRef, deref, dictEntries, dictSpans, latin1, objectBody } from "../pdf/PdfSyntax";
import { pdfNum } from "./InkPdf";
import { HIGHLIGHTER_ALPHA } from "./PenStyle";

export type PageShade = "light" | "dark" | "unknown";

/** Sample points per side over the page box. */
const GRID = 64;
/** A content stream's bytes as stored, past which it is not opened. */
const MAX_STORED = 4 * 1024 * 1024;
/** A page's content once opened, all its streams together. */
const MAX_CONTENT = 4 * 1024 * 1024;
/** Point-in-path tests over all fills of a page, past which the page is unknown. */
const MAX_WORK = 4_000_000;
/** `q` nesting past this is not a page anybody wrote by hand or by tool. */
const MAX_DEPTH = 256;
/** Line segments a curve is read as. */
const CURVE_STEPS = 8;
/** The screen's line: a mean under this, on 0-255, is dark. */
const DARK_BELOW = 127.5;

/** Why a reading stopped: the page is unknown. */
class Unknown extends Error {}

function stop(why: string): never {
	throw new Unknown(why);
}

type Matrix = [number, number, number, number, number, number];

interface Rect {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

/** The parts of the graphics state that decide what a fill covers and how dark. */
interface State {
	ctm: Matrix;
	/** Luminance 0-255 of the fill colour, null when it is not one this reader can say. */
	fill: number | null;
	stroke: number | null;
	/** Components the fill colour space takes in `sc`, 0 when it is not a plain device space. */
	fillSpace: number;
	strokeSpace: number;
	lineWidth: number;
	/** The clip as a rectangle in page space, or the rectangle it lies inside (see `clipExact`); null after a glyph clip. */
	clip: Rect | null;
	/**
	 * True while `clip` is the clip itself. False once a clip that is not one rectangle was set: `clip` is then a
	 * bound, the rectangle the true clip lies inside, and a fill may only darken what it covers.
	 */
	clipExact: boolean;
	/** No transparency, blend or soft mask in force. */
	plain: boolean;
	textMode: number;
}

/** A 0-1 component as the canvas stores it. */
const byte = (v: number): number => Math.min(255, Math.max(0, Math.round(v * 255)));

const luminance = (r: number, g: number, b: number): number =>
	0.2126 * byte(r) + 0.7152 * byte(g) + 0.0722 * byte(b);

/**
 * A colour's luminance from its components in a device space of `n`
 * components. CMYK has no one conversion every reader shares, so only its
 * white is said; any other CMYK colour is not one this reader can judge.
 */
function colourOf(n: number, c: readonly number[]): number | null {
	if (c.length !== n || c.some((v) => !Number.isFinite(v))) return null;
	if (n === 1) return luminance(c[0]!, c[0]!, c[0]!);
	if (n === 3) return luminance(c[0]!, c[1]!, c[2]!);
	if (n === 4) return c.every((v) => v <= 0) ? 255 : null;
	return null;
}

/** The colour a space starts at: black in every device space. */
const initialColour = (n: number): number | null => (n === 1 || n === 3 ? 0 : null);

/** `[x y 1] x m x ctm`: the matrix a `cm` leaves in force. */
function concat(m: Matrix, ctm: Matrix): Matrix {
	const [a, b, c, d, e, f] = m;
	const [A, B, C, D, E, F] = ctm;
	return [a * A + b * C, a * B + b * D, c * A + d * C, c * B + d * D, e * A + f * C + E, e * B + f * D + F];
}

function apply(m: Matrix, x: number, y: number): [number, number] {
	return [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
}

/** One content stream object's bytes as stored, and its dictionary. */
function storedStream(doc: PdfDoc, num: number): { dict: string; data: Uint8Array } {
	const off = doc.offsets.get(num);
	if (off === undefined) stop("content is not a stream at an offset");
	const dict = objectBody(doc, num);
	if (dict === null || !dict.startsWith("<<")) stop("content is not a stream");
	const head = doc.text(off, off + dict.length + 4096);
	const at = head.indexOf(dict);
	if (at < 0) stop("content dictionary not found where it was read");
	let k = at + dict.length;
	while (k < head.length && " \t\r\n\f\0".includes(head[k]!)) k++;
	if (!head.startsWith("stream", k)) stop("content has no stream keyword");
	k += 6;
	if (head[k] === "\r") k++;
	if (head[k] === "\n") k++;
	const from = off + k;
	const d = dictEntries(dict);
	if (d.has("/F")) stop("content stream lives in another file");
	const declared = d.get("/Length");
	const resolved = declared === undefined ? undefined : asRef(declared) === null ? declared : deref(doc, declared) ?? undefined;
	let len = resolved !== undefined && /^\s*\d+\s*$/.test(resolved) ? Number(resolved) : -1;
	if (len > MAX_STORED) stop("content stream is over the size cap");
	if (len < 0 || from + len > doc.bytes.length || !/^\s*endstream/.test(doc.text(from + len, from + len + 20))) {
		len = endstreamAt(doc.bytes, from) - from;
		if (len < 0) stop("content stream has no end");
		while (len > 0 && (doc.bytes[from + len - 1] === 0x0a || doc.bytes[from + len - 1] === 0x0d)) len--;
	}
	if (len > MAX_STORED) stop("content stream is over the size cap");
	return { dict, data: doc.bytes.subarray(from, from + len) };
}

/** Where `endstream` starts at or after `from`, within the size cap; -1 when it does not. */
function endstreamAt(bytes: Uint8Array, from: number): number {
	const word = [0x65, 0x6e, 0x64, 0x73, 0x74, 0x72, 0x65, 0x61, 0x6d];
	const last = Math.min(bytes.length - word.length, from + MAX_STORED + 2);
	outer: for (let i = from; i <= last; i++) {
		for (let j = 0; j < word.length; j++) if (bytes[i + j] !== word[j]) continue outer;
		return i;
	}
	return -1;
}

/** A content stream opened: Flate or nothing, no parameters. */
function opened(doc: PdfDoc, num: number, budget: number): Uint8Array {
	const { dict, data } = storedStream(doc, num);
	const d = dictEntries(dict);
	const filter = d.get("/Filter");
	if (filter === undefined) {
		if (data.length > budget) stop("content is over the size cap");
		return data;
	}
	const names = filter.match(/\/[A-Za-z0-9]+/g) ?? [];
	const rest = filter.replace(/\/[A-Za-z0-9]+/g, "").replace(/[[\]\s]/g, "");
	if (names.length !== 1 || names[0] !== "/FlateDecode" || rest !== "") stop(`content filter ${filter}`);
	if (d.has("/DecodeParms") || d.has("/DecodeParams")) stop("content filter has parameters");
	const out = inflate(data, budget);
	if (out === null) stop("content does not inflate within the cap");
	return out;
}

/** The object numbers of a page's content streams, in order; empty when it has none. */
function contentNumbers(doc: PdfDoc, page: PdfPageInfo): number[] {
	const body = objectBody(doc, page.num);
	if (body === null) stop("page could not be read");
	const contents = dictEntries(body).get("/Contents");
	if (contents === undefined) return [];
	const ref = asRef(contents);
	const list = ref === null ? contents : objectBody(doc, ref);
	if (list === null) stop("contents name a missing object");
	if (ref !== null && list.startsWith("<<")) return [ref];
	if (!list.startsWith("[") || !list.endsWith("]")) stop("contents are not a stream or an array");
	const inner = list.slice(1, -1);
	const refs = [...inner.matchAll(/(\d+)\s+(\d+)\s+R/g)];
	if (inner.replace(/(\d+)\s+(\d+)\s+R/g, "").trim() !== "") stop("contents array holds something that is not a reference");
	return refs.map((m) => Number(m[1]));
}

// ---------------------------------------------------------------- tokens

type Token =
	| { k: "num"; v: number }
	| { k: "name"; v: string }
	| { k: "op"; v: string }
	| { k: "other" };

const WS = " \t\r\n\f\0";
const DELIM = "()<>[]{}/%";
const regular = (c: string): boolean => !WS.includes(c) && !DELIM.includes(c);

/**
 * A content stream's tokens, one at a time. Strings, arrays and dictionaries
 * are operands this reader never needs the value of, so each is one "other";
 * a `]` or `>>` closes nothing it was not inside.
 */
function* tokens(src: string): Generator<Token> {
	let i = 0;
	const n = src.length;
	while (i < n) {
		const c = src[i]!;
		if (WS.includes(c)) {
			i++;
			continue;
		}
		if (c === "%") {
			while (i < n && src[i] !== "\n" && src[i] !== "\r") i++;
			continue;
		}
		if (c === "(") {
			let depth = 0;
			for (; i < n; i++) {
				const s = src[i]!;
				if (s === "\\") i++;
				else if (s === "(") depth++;
				else if (s === ")" && --depth === 0) break;
			}
			if (i >= n) stop("a string runs off the end");
			i++;
			yield { k: "other" };
			continue;
		}
		if (c === "<" && src[i + 1] === "<") {
			i = closing(src, i, "<<", ">>");
			yield { k: "other" };
			continue;
		}
		if (c === "<") {
			const end = src.indexOf(">", i);
			if (end < 0) stop("a hex string runs off the end");
			i = end + 1;
			yield { k: "other" };
			continue;
		}
		if (c === "[") {
			i = closing(src, i, "[", "]");
			yield { k: "other" };
			continue;
		}
		if (c === "]" || c === ">" || c === "{" || c === "}" || c === ")") stop(`a stray ${c}`);
		if (c === "/") {
			let j = i + 1;
			while (j < n && regular(src[j]!)) j++;
			yield { k: "name", v: src.slice(i, j) };
			i = j;
			continue;
		}
		let j = i;
		while (j < n && regular(src[j]!)) j++;
		const word = src.slice(i, j);
		i = j;
		if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(word)) yield { k: "num", v: Number(word) };
		else yield { k: "op", v: word };
	}
}

/** Past a bracketed value whose brackets nest, strings inside skipped whole. */
function closing(src: string, i: number, open: string, close: string): number {
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
			let d = 0;
			for (; j < src.length; j++) {
				const s = src[j]!;
				if (s === "\\") j++;
				else if (s === "(") d++;
				else if (s === ")" && --d === 0) break;
			}
			j++;
		} else {
			j++;
		}
	}
	stop(`a ${open} runs off the end`);
}

// ---------------------------------------------------------------- the page as painted

/** Operators that change nothing this reader counts: line style, text state and position, marked content. */
const IGNORED = new Set([
	"J", "j", "M", "d", "ri", "i",
	"BT", "Tc", "Tw", "Tz", "TL", "Tf", "Ts", "Td", "TD", "Tm", "T*",
	"MP", "DP", "BMC", "BDC", "EMC",
]);

/** Operators that mean the page holds something this reader cannot judge. */
const OPAQUE_TO_US: Record<string, string> = {
	Do: "a picture or form is drawn",
	sh: "a shading is painted",
	BI: "an inline image is drawn",
	d0: "a glyph procedure operator",
	d1: "a glyph procedure operator",
};

/** The components of a colour space named in `cs`, or 0 when it is not a plain device space. */
function spaceComponents(doc: PdfDoc, resources: Map<string, string>, name: string): number {
	if (name === "/DeviceGray") return 1;
	if (name === "/DeviceRGB") return 3;
	if (name === "/DeviceCMYK") return 4;
	const spaces = deref(doc, resources.get("/ColorSpace"));
	if (spaces === null || !spaces.startsWith("<<")) return 0;
	const value = deref(doc, dictEntries(spaces).get(name));
	if (value === null) return 0;
	if (value === "/DeviceGray") return 1;
	if (value === "/DeviceRGB") return 3;
	if (value === "/DeviceCMYK") return 4;
	if (!value.startsWith("[")) return 0;
	const family = /^\[\s*(\/[A-Za-z]+)/.exec(value)?.[1];
	if (family === "/CalGray") return 1;
	if (family === "/CalRGB") return 3;
	if (family === "/ICCBased") {
		const stream = asRef(/^\[\s*\/ICCBased\s+(\d+\s+\d+\s+R)\s*\]$/.exec(value)?.[1]);
		const dict = stream === null ? null : objectBody(doc, stream);
		const n = dict === null ? NaN : Number(dictEntries(dict).get("/N"));
		return n === 1 || n === 3 || n === 4 ? n : 0;
	}
	return 0;
}

/** True when a graphics state dictionary leaves fills as plain paint. */
function plainState(doc: PdfDoc, resources: Map<string, string>, name: string): { plain: boolean; lineWidth?: number } {
	const states = deref(doc, resources.get("/ExtGState"));
	if (states === null || !states.startsWith("<<")) return { plain: false };
	const state = deref(doc, dictEntries(states).get(name));
	if (state === null || !state.startsWith("<<")) return { plain: false };
	const d = dictEntries(state);
	const one = (key: string): boolean => {
		const v = d.get(key);
		return v === undefined || Number(v) >= 1;
	};
	const bm = d.get("/BM");
	const blendOk = bm === undefined || /^\[?\s*\/(Normal|Compatible)\b/.test(bm);
	const mask = d.get("/SMask");
	const maskOk = mask === undefined || mask === "/None";
	const transferOk = !d.has("/TR") && !d.has("/TR2");
	const lw = d.get("/LW");
	return {
		plain: one("/ca") && one("/CA") && blendOk && maskOk && transferOk,
		lineWidth: lw !== undefined && Number.isFinite(Number(lw)) ? Number(lw) : undefined,
	};
}

/** A closed polygon in page space. */
type Poly = number[];

function isAxisRect(poly: Poly): Rect | null {
	const pts: [number, number][] = [];
	for (let i = 0; i < poly.length; i += 2) {
		const p: [number, number] = [poly[i]!, poly[i + 1]!];
		const last = pts[pts.length - 1];
		if (last === undefined || Math.abs(last[0] - p[0]) > 1e-6 || Math.abs(last[1] - p[1]) > 1e-6) pts.push(p);
	}
	if (pts.length === 5 && Math.abs(pts[0]![0] - pts[4]![0]) < 1e-6 && Math.abs(pts[0]![1] - pts[4]![1]) < 1e-6) pts.pop();
	if (pts.length !== 4) return null;
	for (let i = 0; i < 4; i++) {
		const a = pts[i]!;
		const b = pts[(i + 1) % 4]!;
		if (Math.abs(a[0] - b[0]) > 1e-6 && Math.abs(a[1] - b[1]) > 1e-6) return null;
	}
	const xs = pts.map((p) => p[0]);
	const ys = pts.map((p) => p[1]);
	const r = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
	return r.x1 - r.x0 > 0 && r.y1 - r.y0 > 0 ? r : null;
}

/**
 * The page's shade, judged from its content.
 *
 * Only ever called for a page the copy is about to lay highlights on under a
 * light-page setting; see `appendInkToPdf`.
 */
export function pageShade(doc: PdfDoc, page: PdfPageInfo): PageShade {
	try {
		return read(doc, page);
	} catch {
		// `Unknown` says why; anything else thrown here is a file this reader
		// did not foresee, which is the same answer.
		return "unknown";
	}
}

/** What is left of the size cap, shared by every stream a page's reading opens. */
interface Budget {
	left: number;
}

/** One content stream's text, opened within what is left of the cap. */
function contentText(doc: PdfDoc, num: number, budget: Budget): string {
	const bytes = opened(doc, num, budget.left);
	budget.left -= bytes.length;
	if (budget.left < 0) stop("content is over the size cap");
	return latin1(bytes);
}

function read(doc: PdfDoc, page: PdfPageInfo): PageShade {
	const { w: bw, h: bh } = page.box;
	if (!(bw > 0 && bh > 0)) stop("the page box is empty");
	const streams = contentNumbers(doc, page);
	// No content: the page is the paper.
	if (streams.length === 0) return "light";

	const budget: Budget = { left: MAX_CONTENT };
	const texts = streams.map((n) => contentText(doc, n, budget));

	const res = page.resources === null ? null : deref(doc, page.resources);
	if (page.resources !== null && (res === null || !res.startsWith("<<"))) stop("resources could not be read");
	const resources = res === null ? new Map<string, string>() : dictEntries(res);

	// The page as it stands. Light or dark, that is the answer: a page this
	// reader judges is never judged again without some of its content.
	const whole = judged(() => painted(doc, page, resources, texts));
	if (whole !== "unknown") return whole;
	const before = peeled(doc, resources, texts, budget);
	if (before === null) return "unknown";
	// Nothing left: the page had no content before its first copy.
	return before.length === 0 ? "light" : painted(doc, page, resources, before);
}

/** A reading's answer, with a reading that stopped as "unknown". */
function judged(reading: () => PageShade): PageShade {
	try {
		return reading();
	} catch (e) {
		if (e instanceof Unknown) return "unknown";
		throw e;
	}
}

/** The shade of the page these content streams paint, in order. */
function painted(doc: PdfDoc, page: PdfPageInfo, resources: Map<string, string>, texts: readonly string[]): PageShade {
	const { x: bx, y: by, w: bw, h: bh } = page.box;
	const text = texts.map((t) => `${t}\n`).join("");

	// White, then every fill over it in the order painted.
	const grid = new Float64Array(GRID * GRID).fill(255);
	const cw = bw / GRID;
	const ch = bh / GRID;
	let work = 0;
	let strokeDark = 0;

	let st: State = {
		ctm: [1, 0, 0, 1, 0, 0],
		fill: 0,
		stroke: 0,
		fillSpace: 1,
		strokeSpace: 1,
		lineWidth: 1,
		clip: { x0: bx, y0: by, x1: bx + bw, y1: by + bh },
		clipExact: true,
		plain: true,
		textMode: 0,
	};
	const saved: State[] = [];
	let polys: Poly[] = [];
	let current: Poly | null = null;
	let start: [number, number] | null = null;
	let at: [number, number] | null = null;
	let clipNext = false;
	let textClip = false;
	let compat = 0;
	const operands: Token[] = [];

	const numbers = (count: number, op: string): number[] => {
		if (operands.length < count) stop(`${op} has too few operands`);
		const out = operands.slice(operands.length - count).map((t) => (t.k === "num" ? t.v : NaN));
		if (out.some((v) => !Number.isFinite(v))) stop(`${op} has an operand that is not a number`);
		return out;
	};
	const lastName = (op: string): string => {
		const t = operands[operands.length - 1];
		if (t === undefined || t.k !== "name") stop(`${op} names nothing`);
		return t.v;
	};

	const moveTo = (x: number, y: number): void => {
		const p = apply(st.ctm, x, y);
		current = [p[0], p[1]];
		polys.push(current);
		start = p;
		at = p;
	};
	const lineTo = (x: number, y: number): void => {
		if (current === null || at === null) stop("a line with no current point");
		const p = apply(st.ctm, x, y);
		current.push(p[0], p[1]);
		at = p;
	};
	/** A cubic from the current point, its control points already in page space. */
	const curveTo = (p1: [number, number], p2: [number, number], p3: [number, number]): void => {
		if (current === null || at === null) stop("a curve with no current point");
		const p0 = at;
		for (let s = 1; s <= CURVE_STEPS; s++) {
			const t = s / CURVE_STEPS;
			const u = 1 - t;
			const a = u * u * u;
			const b = 3 * u * u * t;
			const c = 3 * u * t * t;
			const d = t * t * t;
			current.push(a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]);
		}
		at = p3;
	};
	const closePath = (): void => {
		if (current !== null && start !== null) {
			current.push(start[0], start[1]);
			at = start;
		}
	};
	const endPath = (): void => {
		if (clipNext) {
			const only = polys.filter((p) => p.length >= 6);
			const rect = only.length === 1 ? isAxisRect(only[0]!) : null;
			if (st.clip === null) {
				// A glyph clip came first: it stays unknown.
			} else if (rect === null) {
				// Not one rectangle (two subpaths, a triangle, a curve, no area): the true clip lies inside the
				// rectangle in force, which is kept as a bound. A rectangle clip later narrows it and keeps it a bound.
				st.clipExact = false;
			} else {
				const c = st.clip;
				st.clip = { x0: Math.max(c.x0, rect.x0), y0: Math.max(c.y0, rect.y0), x1: Math.min(c.x1, rect.x1), y1: Math.min(c.y1, rect.y1) };
			}
			clipNext = false;
		}
		polys = [];
		current = null;
		start = null;
		at = null;
	};

	const fill = (evenOdd: boolean): void => {
		if (!st.plain) stop("a fill under transparency, a blend or a soft mask");
		if (st.fill === null) stop("a fill in a colour this reader cannot say");
		if (st.clip === null) stop("a fill under a glyph clip");
		const shapes = polys.filter((p) => p.length >= 6);
		if (shapes.length === 0) return;
		let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
		for (const p of shapes) {
			for (let i = 0; i < p.length; i += 2) {
				x0 = Math.min(x0, p[i]!);
				x1 = Math.max(x1, p[i]!);
				y0 = Math.min(y0, p[i + 1]!);
				y1 = Math.max(y1, p[i + 1]!);
			}
		}
		// A point the math made no number, or past any number: where it lands is not known, so neither is the page.
		if (!(Number.isFinite(x0) && Number.isFinite(y0) && Number.isFinite(x1) && Number.isFinite(y1))) {
			stop("a fill with a point that is not a finite number");
		}
		const c = st.clip;
		x0 = Math.max(x0, c.x0);
		y0 = Math.max(y0, c.y0);
		x1 = Math.min(x1, c.x1);
		y1 = Math.min(y1, c.y1);
		// Sample (i, j) sits at the centre of its cell.
		const i0 = Math.max(0, Math.ceil((x0 - bx) / cw - 0.5));
		const i1 = Math.min(GRID - 1, Math.floor((x1 - bx) / cw - 0.5));
		const j0 = Math.max(0, Math.ceil((y0 - by) / ch - 0.5));
		const j1 = Math.min(GRID - 1, Math.floor((y1 - by) / ch - 0.5));
		if (i0 > i1 || j0 > j1) return;
		const lum = st.fill;
		// Under a bound the fill may cover less than the samples it reaches here, so each takes the darker of what
		// it holds and the fill: the reading can only come out darker than the page.
		const bound = !st.clipExact;
		const rect = shapes.length === 1 ? isAxisRect(shapes[0]!) : null;
		if (rect !== null) {
			work += (i1 - i0 + 1) * (j1 - j0 + 1);
			// Written so that work that is no number stops too: no number is never past the cap.
			if (!(work <= MAX_WORK)) stop("the fills are past the work cap, or their work is not a number");
			for (let j = j0; j <= j1; j++) {
				for (let i = i0; i <= i1; i++) grid[j * GRID + i] = bound ? Math.min(grid[j * GRID + i]!, lum) : lum;
			}
			return;
		}
		let edges = 0;
		for (const p of shapes) edges += p.length / 2;
		work += (i1 - i0 + 1) * (j1 - j0 + 1) * edges;
		if (!(work <= MAX_WORK)) stop("the fills are past the work cap, or their work is not a number");
		for (let j = j0; j <= j1; j++) {
			const py = by + (j + 0.5) * ch;
			for (let i = i0; i <= i1; i++) {
				const px = bx + (i + 0.5) * cw;
				let wind = 0;
				let cross = 0;
				for (const p of shapes) {
					const m = p.length;
					for (let k = 0; k < m; k += 2) {
						const ax = p[k]!, ay = p[k + 1]!;
						const bxx = p[(k + 2) % m]!, byy = p[(k + 3) % m]!;
						if ((ay <= py) !== (byy <= py)) {
							const xc = ax + ((py - ay) * (bxx - ax)) / (byy - ay);
							if (xc > px) {
								cross++;
								wind += byy > ay ? 1 : -1;
							}
						}
					}
				}
				if (evenOdd ? cross % 2 === 1 : wind !== 0) grid[j * GRID + i] = bound ? Math.min(grid[j * GRID + i]!, lum) : lum;
			}
		}
	};

	const stroke = (): void => {
		if (!st.plain) stop("a stroke under transparency, a blend or a soft mask");
		if (st.stroke === null) stop("a stroke in a colour this reader cannot say");
		// Under a rectangle clip or a bound alike, a stroke is counted whole: the clip is not applied to strokes.
		if (st.clip === null) stop("a stroke under a glyph clip");
		const [a, b, c, d] = st.ctm;
		const width = Math.max(st.lineWidth, 0) * Math.sqrt(Math.abs(a * d - b * c));
		let length = 0;
		for (const p of polys) {
			for (let i = 2; i < p.length; i += 2) length += Math.hypot(p[i]! - p[i - 2]!, p[i + 1]! - p[i - 1]!);
		}
		// A zero-width line is the thinnest the device draws: one pixel's worth.
		strokeDark += length * Math.max(width, 0.25) * Math.max(0, 255 - st.stroke);
	};

	for (const t of tokens(text)) {
		if (t.k !== "op") {
			operands.push(t);
			if (operands.length > 64) stop("an operator with more operands than any takes");
			continue;
		}
		const op = t.v;
		switch (op) {
			case "q":
				if (saved.length >= MAX_DEPTH) stop("q nests too deep");
				saved.push({ ...st, clip: st.clip === null ? null : { ...st.clip } });
				break;
			case "Q":
				// An unbalanced Q is ignored, as viewers do.
				if (saved.length > 0) st = saved.pop()!;
				break;
			case "cm": {
				const [a, b, c, d, e, f] = numbers(6, op) as Matrix;
				st.ctm = concat([a, b, c, d, e, f], st.ctm);
				if (!st.ctm.every(Number.isFinite)) stop("a matrix that is not a finite number");
				break;
			}
			case "w":
				st.lineWidth = numbers(1, op)[0]!;
				break;
			case "gs": {
				const g = plainState(doc, resources, lastName(op));
				st.plain = st.plain && g.plain;
				if (g.lineWidth !== undefined) st.lineWidth = g.lineWidth;
				break;
			}
			case "m": {
				const [x, y] = numbers(2, op);
				moveTo(x!, y!);
				break;
			}
			case "l": {
				const [x, y] = numbers(2, op);
				lineTo(x!, y!);
				break;
			}
			case "c": {
				const [x1, y1, x2, y2, x3, y3] = numbers(6, op) as [number, number, number, number, number, number];
				curveTo(apply(st.ctm, x1, y1), apply(st.ctm, x2, y2), apply(st.ctm, x3, y3));
				break;
			}
			case "v": {
				// The first control point is the current point.
				const [x2, y2, x3, y3] = numbers(4, op) as [number, number, number, number];
				if (at === null) stop("a curve with no current point");
				curveTo(at, apply(st.ctm, x2, y2), apply(st.ctm, x3, y3));
				break;
			}
			case "y": {
				// The second control point is the end point.
				const [x1, y1, x3, y3] = numbers(4, op) as [number, number, number, number];
				const end = apply(st.ctm, x3, y3);
				curveTo(apply(st.ctm, x1, y1), end, end);
				break;
			}
			case "h":
				closePath();
				break;
			case "re": {
				const [x, y, w, h] = numbers(4, op);
				moveTo(x!, y!);
				lineTo(x! + w!, y!);
				lineTo(x! + w!, y! + h!);
				lineTo(x!, y! + h!);
				closePath();
				break;
			}
			case "f":
			case "F":
				fill(false);
				endPath();
				break;
			case "f*":
				fill(true);
				endPath();
				break;
			case "B":
			case "B*":
				fill(op === "B*");
				stroke();
				endPath();
				break;
			case "b":
			case "b*":
				closePath();
				fill(op === "b*");
				stroke();
				endPath();
				break;
			case "S":
				stroke();
				endPath();
				break;
			case "s":
				closePath();
				stroke();
				endPath();
				break;
			case "n":
				endPath();
				break;
			case "W":
			case "W*":
				clipNext = true;
				break;
			case "g":
				st.fill = colourOf(1, numbers(1, op));
				st.fillSpace = 1;
				break;
			case "G":
				st.stroke = colourOf(1, numbers(1, op));
				st.strokeSpace = 1;
				break;
			case "rg":
				st.fill = colourOf(3, numbers(3, op));
				st.fillSpace = 3;
				break;
			case "RG":
				st.stroke = colourOf(3, numbers(3, op));
				st.strokeSpace = 3;
				break;
			case "k":
				st.fill = colourOf(4, numbers(4, op));
				st.fillSpace = 4;
				break;
			case "K":
				st.stroke = colourOf(4, numbers(4, op));
				st.strokeSpace = 4;
				break;
			case "cs":
				st.fillSpace = spaceComponents(doc, resources, lastName(op));
				st.fill = initialColour(st.fillSpace);
				break;
			case "CS":
				st.strokeSpace = spaceComponents(doc, resources, lastName(op));
				st.stroke = initialColour(st.strokeSpace);
				break;
			case "sc":
			case "scn":
				st.fill = scColour(st.fillSpace, operands);
				break;
			case "SC":
			case "SCN":
				st.stroke = scColour(st.strokeSpace, operands);
				break;
			case "Tr":
				st.textMode = numbers(1, op)[0]!;
				break;
			case "Tj":
			case "TJ":
			case "'":
			case "\"":
				// Glyphs are not counted (see the top), but a glyph that clips
				// makes the clip something other than a rectangle.
				if (st.textMode >= 4) textClip = true;
				break;
			case "ET":
				if (textClip) st.clip = null;
				textClip = false;
				break;
			case "BX":
				compat++;
				break;
			case "EX":
				if (compat > 0) compat--;
				break;
			default:
				if (op in OPAQUE_TO_US) stop(OPAQUE_TO_US[op]!);
				if (!IGNORED.has(op) && compat === 0) stop(`operator ${op}`);
		}
		operands.length = 0;
	}

	let sum = 0;
	for (let i = 0; i < grid.length; i++) sum += grid[i]!;
	const mean = sum / grid.length - strokeDark / (bw * bh);
	// No number is never under the dark line: without this a page the math lost would read light.
	if (!Number.isFinite(mean)) stop("a mean that is not a finite number");
	return mean < DARK_BELOW ? "dark" : "light";
}

/** `sc`/`scn` in a space of `n` components: its colour, or null when it is a pattern or not a device space. */
function scColour(n: number, operands: readonly Token[]): number | null {
	if (n === 0) return null;
	if (operands.some((t) => t.k !== "num")) return null;
	return colourOf(n, operands.map((t) => (t as { v: number }).v));
}

// ---------------------------------------------------------------- our own output

/** Why a stream is not our output exactly as the writer emits it: the peel stops there. */
class NotOurs extends Error {}

function notOurs(): never {
	throw new NotOurs();
}

/** The alpha the writer draws highlights under, as it writes it. 1.5.0 and 1.5.1 wrote the same. */
const OUR_ALPHA = pdfNum(HIGHLIGHTER_ALPHA);

/**
 * The page's content as it was before the copies this plugin made of it, or
 * null when the end of its list is not our output.
 *
 * Each flatten leaves the list `[ink]` on a page that had no content, or
 * `[q, ...had, Q, ink]` (InkPdfAppend's `contentsArray`), so the peel goes
 * once per flatten: the last stream ours, and with more than one, the first
 * and next-to-last exactly the `q` and `Q` guards. Anything else stops it
 * where it is, and what is left is read as any page is: a picture, a form of
 * somebody else's, or a stream after ours keeps the page unknown.
 */
function peeled(doc: PdfDoc, resources: Map<string, string>, texts: readonly string[], budget: Budget): string[] | null {
	let list = [...texts];
	let peels = 0;
	for (;;) {
		const n = list.length;
		if (n === 0) break;
		const guarded = n >= 3 && onlyOp(list[0]!, "q") && onlyOp(list[n - 2]!, "Q");
		if (!(n === 1 || guarded) || !ourInk(doc, resources, list[n - 1]!, budget)) break;
		list = n === 1 ? [] : list.slice(1, n - 2);
		peels++;
	}
	return peels === 0 ? null : list;
}

/** True when a stream is one operator and nothing else. */
function onlyOp(text: string, op: string): boolean {
	let count = 0;
	for (const t of tokens(text)) if (++count > 1 || t.k !== "op" || t.v !== op) return false;
	return count === 1;
}

/**
 * Whether one content stream is exactly the writer's ink for a page, each
 * name it uses followed through the page's resources to an object that is
 * exactly ours. No name is compared:
 *
 *     INK     := DRAW [WRAP(FLIP(RUNS))] | WRAP(FLIP(WASH RUNS))
 *     DRAW    := q /a gs /b Do Q     a our alpha, with or without /BM /Multiply; b our group
 *     WASH    := q /a gs RUNS Q      a our alpha, no blend: 1.5.1's copy, and a page with no group
 *     WRAP(X) := X | q TURN cm [SCALE cm] X Q | q SCALE cm X Q
 *     FLIP(X) := q 1 0 0 -1 0 h cm X Q, with h > 0
 *     RUNS    := (r g b rg | SUBPATH+ f)*, each component 0 to 1
 *     SUBPATH := x y m (x y l | x1 y1 x2 y2 x3 y3 c)* h
 *
 * RUNS starts with a colour and never sets one, or ends, with a path open.
 * It may be empty: 1.5.1 wrote `q /a gs Q` for highlights whose outlines
 * draw nothing. Pen ink after a group has no wash: the writer puts every
 * highlight in the group (InkPdf's `inkPdfContent`, InkPdfAppend's page loop).
 * A stream with neither a group nor a wash is pen ink only: plain opaque
 * paint this reader can judge, and a page's own content can have the same
 * shape, so it is not peeled but read as content.
 */
function ourInk(doc: PdfDoc, resources: Map<string, string>, text: string, budget: Budget): boolean {
	try {
		const c = new Cursor(text);
		const draw = c.draw();
		if (draw !== null) {
			ourState(doc, resources, draw[0], true);
			ourGroup(doc, resources, draw[1], budget);
			if (!c.done) wrapped(c, () => c.runs());
		} else {
			wrapped(c, () => {
				const wash = c.wash();
				if (wash === null) notOurs();
				ourState(doc, resources, wash, false);
				c.runs();
				c.op("Q");
				c.runs();
			});
		}
		return c.done;
	} catch (e) {
		if (e instanceof NotOurs) return false;
		throw e;
	}
}

/** WRAP(FLIP(X)), with `inner` reading X. */
function wrapped(c: Cursor, inner: () => void): void {
	const first = c.bracketCm();
	if (first === null) notOurs();
	if (isFlip(first)) {
		inner();
		c.op("Q");
		return;
	}
	if (isTurn(first)) {
		const scale = c.cm();
		if (scale !== null && !isScale(scale)) notOurs();
	} else if (!isScale(first)) notOurs();
	const flip = c.bracketCm();
	if (flip === null || !isFlip(flip)) notOurs();
	inner();
	c.op("Q");
	c.op("Q");
}

/** The flip the writer starts its ink with: y down from the top, `h` the shown height. */
const isFlip = (m: Matrix): boolean => m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === -1 && m[4] === 0 && m[5] > 0;

/** A quarter turn or none, then the box's corner (InkPdfAppend's `turnOf`). */
const isTurn = (m: Matrix): boolean =>
	[
		[1, 0, 0, 1],
		[0, 1, -1, 0],
		[-1, 0, 0, -1],
		[0, -1, 1, 0],
	].some((t) => t.every((v, k) => m[k] === v));

/** A /UserUnit brought back onto the box (InkPdfAppend's `pageMatrix`). */
const isScale = (m: Matrix): boolean => m[0] > 0 && m[1] === 0 && m[2] === 0 && m[3] === m[0] && m[4] === 0 && m[5] === 0;

/**
 * A dictionary's entries when it is exactly a dictionary: every key once and
 * nothing the parser skipped. Null for anything else.
 */
function exactEntries(dict: string): Map<string, string> | null {
	if (!dict.startsWith("<<") || !dict.endsWith(">>")) return null;
	const spans = dictSpans(dict);
	const end = spans.length === 0 ? 2 : spans[spans.length - 1]!.end;
	if (!/^[ \t\r\n\f\0]*$/.test(dict.slice(end, dict.length - 2))) return null;
	const d = dictEntries(dict);
	return d.size === spans.length ? d : null;
}

/**
 * The state `name` lands on is exactly one the writer writes: our alpha, and
 * with `blend` a multiply or none (the group's two), without it none (the
 * wash's).
 */
function ourState(doc: PdfDoc, resources: Map<string, string>, name: string, blend: boolean): void {
	const states = deref(doc, resources.get("/ExtGState"));
	const state = states === null || !states.startsWith("<<") ? null : deref(doc, dictEntries(states).get(name));
	const d = state === null ? null : exactEntries(state);
	if (d === null) notOurs();
	const keys = blend && d.has("/BM") ? 4 : 3;
	if (d.size !== keys || d.get("/Type") !== "/ExtGState" || d.get("/ca") !== OUR_ALPHA || d.get("/CA") !== OUR_ALPHA) notOurs();
	if (keys === 4 && d.get("/BM") !== "/Multiply") notOurs();
}

/** Every key the writer's group carries, and a /Filter, which a tool that recompresses streams adds. */
const GROUP_KEYS = new Set(["/Type", "/Subtype", "/BBox", "/Group", "/Resources", "/Length", "/Filter"]);

const NUMBER = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)`;
const BOX = new RegExp(String.raw`^\[\s*(?:${NUMBER}\s+){3}${NUMBER}\s*\]$`);

/**
 * The form `name` lands on is exactly the writer's highlight group: its
 * dictionary (InkPdfAppend's `highlightGroup`), no resources of its own, and
 * a stream of WRAP(FLIP(RUNS)).
 */
function ourGroup(doc: PdfDoc, resources: Map<string, string>, name: string, budget: Budget): void {
	const forms = deref(doc, resources.get("/XObject"));
	const num = forms === null || !forms.startsWith("<<") ? null : asRef(dictEntries(forms).get(name));
	const dict = num === null ? null : objectBody(doc, num);
	const d = dict === null ? null : exactEntries(dict);
	if (num === null || d === null) notOurs();
	for (const k of d.keys()) if (!GROUP_KEYS.has(k)) notOurs();
	const group = exactEntries(d.get("/Group") ?? "");
	const own = exactEntries(d.get("/Resources") ?? "");
	if (
		d.get("/Type") !== "/XObject" ||
		d.get("/Subtype") !== "/Form" ||
		!BOX.test(d.get("/BBox") ?? "") ||
		!d.has("/Length") ||
		group === null ||
		group.size !== 2 ||
		group.get("/S") !== "/Transparency" ||
		group.get("/I") !== "true" ||
		own === null ||
		own.size !== 0
	) {
		notOurs();
	}
	const c = new Cursor(contentText(doc, num, budget));
	wrapped(c, () => c.runs());
	if (!c.done) notOurs();
}

/** A content stream's tokens, read in order against the writer's grammar. */
class Cursor {
	private readonly t: Token[];
	private i = 0;

	constructor(text: string) {
		this.t = [...tokens(text)];
	}

	get done(): boolean {
		return this.i === this.t.length;
	}

	private isOp(k: number, v: string): boolean {
		const x = this.t[this.i + k];
		return x !== undefined && x.k === "op" && x.v === v;
	}

	/** `count` numbers from `from` on. */
	private nums(count: number, from = 0): number[] | null {
		const out: number[] = [];
		for (let k = from; k < from + count; k++) {
			const x = this.t[this.i + k];
			if (x === undefined || x.k !== "num") return null;
			out.push(x.v);
		}
		return out;
	}

	private name(k: number): string | null {
		const x = this.t[this.i + k];
		return x !== undefined && x.k === "name" ? x.v : null;
	}

	/** The operator `v`, or the stream is not ours. */
	op(v: string): void {
		if (!this.isOp(0, v)) notOurs();
		this.i++;
	}

	/** `q /a gs /b Do Q` next: its two names, read. Null, and nothing read, otherwise. */
	draw(): [string, string] | null {
		const a = this.name(1);
		const b = this.name(3);
		if (!this.isOp(0, "q") || a === null || !this.isOp(2, "gs") || b === null || !this.isOp(4, "Do") || !this.isOp(5, "Q")) {
			return null;
		}
		this.i += 6;
		return [a, b];
	}

	/** `q /a gs` next: its name, read. Null, and nothing read, otherwise. */
	wash(): string | null {
		const a = this.name(1);
		if (!this.isOp(0, "q") || a === null || !this.isOp(2, "gs")) return null;
		this.i += 3;
		return a;
	}

	/** `q a b c d e f cm` next: the matrix, read. Null, and nothing read, otherwise. */
	bracketCm(): Matrix | null {
		const m = this.nums(6, 1);
		if (!this.isOp(0, "q") || m === null || !this.isOp(7, "cm")) return null;
		this.i += 8;
		return m as Matrix;
	}

	/** `a b c d e f cm` next: the matrix, read. Null, and nothing read, otherwise. */
	cm(): Matrix | null {
		const m = this.nums(6);
		if (m === null || !this.isOp(6, "cm")) return null;
		this.i += 7;
		return m as Matrix;
	}

	/** RUNS, up to the `Q` that closes it, which is left unread. */
	runs(): void {
		let colour = false;
		let open = false;
		for (;;) {
			if (this.isOp(0, "Q")) {
				if (open) notOurs();
				return;
			}
			if (this.isOp(0, "f")) {
				if (!open) notOurs();
				open = false;
				this.i++;
				continue;
			}
			const rgb = this.nums(3);
			if (rgb !== null && this.isOp(3, "rg")) {
				if (open || rgb.some((v) => !(v >= 0 && v <= 1))) notOurs();
				colour = true;
				this.i += 4;
				continue;
			}
			if (this.nums(2) !== null && this.isOp(2, "m")) {
				if (!colour) notOurs();
				this.i += 3;
				for (;;) {
					if (this.nums(2) !== null && this.isOp(2, "l")) this.i += 3;
					else if (this.nums(6) !== null && this.isOp(6, "c")) this.i += 7;
					else break;
				}
				this.op("h");
				open = true;
				continue;
			}
			notOurs();
		}
	}
}
