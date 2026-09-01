/**
 * FlateDecode, because a PDF that hides its cross-reference table hides it
 * behind exactly this.
 *
 * Written out rather than reached for, and the reasons are specific:
 *
 * - **The platform decompressor is async and gated.** `DecompressionStream`
 *   arrived in iOS 16.4. An iPad older than that is the machine this plugin
 *   exists for, and a reader that cannot open a document on it is not a
 *   reader. This one is synchronous, so nothing above it becomes a promise.
 * - **Nothing being decoded here is large.** Only cross-reference streams and
 *   object streams pass through, which are kilobytes. Page content is never
 *   inflated - the ink is appended after it, never merged into it - so the
 *   bit-at-a-time decoder below is honest about its speed and still finishes
 *   in microseconds.
 * - **It is the only alternative to a dependency.** The plugin has no runtime
 *   dependencies at all, and a PDF library would be the first, at a bundle
 *   cost several times this file.
 *
 * The decoder is the canonical-Huffman shape from zlib's own `puff`: counts
 * and symbols per code length, decoded one bit at a time. Slower than a
 * lookup table and far easier to read, which is the trade this file wants -
 * a wrong table produces plausible bytes, and plausible bytes in a
 * cross-reference table point ink at the wrong page.
 *
 * Every failure returns null. A stream that will not decode must not become
 * a half-decoded one.
 */

const MAX_BITS = 15;

/**
 * The most any one stream may decompress to.
 *
 * Only structural streams reach this file - a cross-reference table or an
 * object stream - and the largest plausible one is a cross-reference table
 * for a million objects, around 11 MB. A corrupt or hostile document can
 * declare otherwise: 214 KB of deflated zeros expands to 220 MB in 379ms
 * (measured), and this runs on the main thread of an application that also
 * runs on an iPad. A refusal costs a document nobody could have opened
 * anyway; the allocation costs the session.
 */
export const MAX_INFLATE = 64 * 1024 * 1024;

/** Length codes 257-285: what each adds, and how many extra bits it reads. */
const LEN_BASE = [
	3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
	163, 195, 227, 258,
];
const LEN_EXTRA = [
	0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DIST_BASE = [
	1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
	3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [
	0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];
/** The order dynamic blocks write their code lengths in. */
const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

interface Reader {
	data: Uint8Array;
	/** Position in BITS. DEFLATE packs low bit first, across byte boundaries. */
	at: number;
}

function bit(r: Reader): number {
	const byte = r.data[r.at >> 3];
	if (byte === undefined) return -1;
	const b = (byte >> (r.at & 7)) & 1;
	r.at++;
	return b;
}

function take(r: Reader, n: number): number {
	let v = 0;
	for (let i = 0; i < n; i++) {
		const b = bit(r);
		if (b < 0) return -1;
		v |= b << i;
	}
	return v;
}

interface Huff {
	/** How many codes of each length. */
	count: Int32Array;
	/** Symbols, ordered by code length then by symbol. */
	symbol: Int32Array;
}

function build(lengths: ArrayLike<number>, n: number): Huff | null {
	const count = new Int32Array(MAX_BITS + 1);
	for (let i = 0; i < n; i++) {
		const len = lengths[i]!;
		if (len > MAX_BITS) return null;
		count[len] = count[len]! + 1;
	}
	// An over-subscribed set has more codes than the length allows and cannot
	// be decoded; an incomplete one is legal only when it holds nothing.
	let left = 1;
	for (let len = 1; len <= MAX_BITS; len++) {
		left = (left << 1) - count[len]!;
		if (left < 0) return null;
	}
	const offs = new Int32Array(MAX_BITS + 2);
	for (let len = 1; len <= MAX_BITS; len++) offs[len + 1] = offs[len]! + count[len]!;
	const symbol = new Int32Array(n);
	for (let i = 0; i < n; i++) {
		const len = lengths[i]!;
		if (len !== 0) {
			symbol[offs[len]!] = i;
			offs[len] = offs[len]! + 1;
		}
	}
	return { count, symbol };
}

function decode(r: Reader, h: Huff): number {
	let code = 0;
	let first = 0;
	let index = 0;
	for (let len = 1; len <= MAX_BITS; len++) {
		const b = bit(r);
		if (b < 0) return -1;
		code |= b;
		const count = h.count[len]!;
		if (code - first < count) return h.symbol[index + (code - first)]!;
		index += count;
		first = (first + count) << 1;
		code <<= 1;
	}
	return -1;
}

let fixedLit: Huff | null = null;
let fixedDist: Huff | null = null;

function fixed(): { lit: Huff; dist: Huff } | null {
	if (fixedLit === null || fixedDist === null) {
		const lengths = new Uint8Array(288);
		lengths.fill(8, 0, 144);
		lengths.fill(9, 144, 256);
		lengths.fill(7, 256, 280);
		lengths.fill(8, 280, 288);
		fixedLit = build(lengths, 288);
		fixedDist = build(new Uint8Array(30).fill(5), 30);
	}
	return fixedLit === null || fixedDist === null ? null : { lit: fixedLit, dist: fixedDist };
}

function dynamic(r: Reader): { lit: Huff; dist: Huff } | null {
	const nlen = take(r, 5) + 257;
	const ndist = take(r, 5) + 1;
	const ncode = take(r, 4) + 4;
	if (nlen < 257 || nlen > 286 || ndist < 1 || ndist > 30) return null;
	const lengths = new Uint8Array(320);
	for (let i = 0; i < ncode; i++) {
		const v = take(r, 3);
		if (v < 0) return null;
		lengths[ORDER[i]!] = v;
	}
	const codes = build(lengths, 19);
	if (codes === null) return null;
	lengths.fill(0);
	let i = 0;
	while (i < nlen + ndist) {
		const sym = decode(r, codes);
		if (sym < 0) return null;
		if (sym < 16) {
			lengths[i++] = sym;
			continue;
		}
		// 16 repeats the previous length, 17 and 18 run zeros.
		let repeat: number;
		let value = 0;
		if (sym === 16) {
			if (i === 0) return null;
			value = lengths[i - 1]!;
			repeat = 3 + take(r, 2);
		} else if (sym === 17) {
			repeat = 3 + take(r, 3);
		} else {
			repeat = 11 + take(r, 7);
		}
		if (repeat < 0 || i + repeat > nlen + ndist) return null;
		while (repeat-- > 0) lengths[i++] = value;
	}
	if (lengths[256] === 0) return null;
	const lit = build(lengths.subarray(0, nlen), nlen);
	const dist = build(lengths.subarray(nlen, nlen + ndist), ndist);
	return lit === null || dist === null ? null : { lit, dist };
}

/**
 * A zlib or raw DEFLATE stream, decompressed. Null when it will not decode.
 *
 * PDF writes FlateDecode with the zlib wrapper, but files exist with the
 * wrapper missing, so the two-byte header is detected rather than demanded.
 */
export function inflate(data: Uint8Array, limit = MAX_INFLATE): Uint8Array | null {
	const r: Reader = { data, at: 0 };
	const b0 = data[0];
	const b1 = data[1];
	if (b0 !== undefined && b1 !== undefined && (b0 & 0x0f) === 8 && ((b0 << 8) | b1) % 31 === 0) {
		// FDICT would need a dictionary we were never given.
		if ((b1 & 0x20) !== 0) return null;
		r.at = 16;
	}

	let out = new Uint8Array(Math.max(1024, data.length * 5));
	let len = 0;
	const ensure = (need: number): boolean => {
		if (len + need > limit) return false;
		if (len + need <= out.length) return true;
		let size = out.length * 2;
		while (size < len + need) size *= 2;
		const bigger = new Uint8Array(size);
		bigger.set(out.subarray(0, len));
		out = bigger;
		return true;
	};

	for (;;) {
		const last = bit(r);
		const type = take(r, 2);
		if (last < 0 || type < 0) return null;
		if (type === 0) {
			// Stored: byte-aligned, with a length and its complement.
			r.at = (r.at + 7) & ~7;
			const at = r.at >> 3;
			const stored = data[at]! | (data[at + 1]! << 8);
			const check = data[at + 2]! | (data[at + 3]! << 8);
			if (at + 4 + stored > data.length || (stored ^ 0xffff) !== check) return null;
			if (!ensure(stored)) return null;
			out.set(data.subarray(at + 4, at + 4 + stored), len);
			len += stored;
			r.at = (at + 4 + stored) << 3;
		} else if (type === 1 || type === 2) {
			const tables = type === 1 ? fixed() : dynamic(r);
			if (tables === null) return null;
			for (;;) {
				const sym = decode(r, tables.lit);
				if (sym < 0) return null;
				if (sym === 256) break;
				if (sym < 256) {
					if (!ensure(1)) return null;
					out[len++] = sym;
					continue;
				}
				const l = sym - 257;
				if (l >= LEN_BASE.length) return null;
				const extra = take(r, LEN_EXTRA[l]!);
				if (extra < 0) return null;
				const count = LEN_BASE[l]! + extra;
				const dsym = decode(r, tables.dist);
				if (dsym < 0 || dsym >= DIST_BASE.length) return null;
				const dextra = take(r, DIST_EXTRA[dsym]!);
				if (dextra < 0) return null;
				const dist = DIST_BASE[dsym]! + dextra;
				if (dist > len) return null;
				if (!ensure(count)) return null;
				// Byte at a time on purpose: a match may overlap its own
				// output, which is how a run of one byte is encoded.
				for (let i = 0; i < count; i++) out[len + i] = out[len - dist + i]!;
				len += count;
			}
		} else {
			return null;
		}
		if (last === 1) return out.slice(0, len);
	}
}

/**
 * The row filters undone, for a stream that was predicted before it was
 * compressed.
 *
 * A cross-reference stream is a table of small integers in columns, so its
 * writers almost always PNG-predict it first - four of the documents to hand
 * do. Each row arrives with the filter that made it as its first byte.
 */
export function unpredict(
	data: Uint8Array,
	predictor: number,
	colors: number,
	bits: number,
	columns: number
): Uint8Array | null {
	if (predictor <= 1) return data;
	// TIFF prediction (2) is legal and, on cross-reference streams, unheard of.
	if (predictor < 10) return null;
	const pixel = Math.max(1, Math.ceil((colors * bits) / 8));
	const row = Math.ceil((colors * bits * columns) / 8);
	if (row <= 0) return null;
	const rows = Math.floor(data.length / (row + 1));
	const out = new Uint8Array(rows * row);
	let src = 0;
	for (let y = 0; y < rows; y++) {
		const filter = data[src++]!;
		const at = y * row;
		const above = at - row;
		for (let i = 0; i < row; i++) {
			const raw = data[src + i]!;
			const left = i >= pixel ? out[at + i - pixel]! : 0;
			const up = y > 0 ? out[above + i]! : 0;
			const upLeft = y > 0 && i >= pixel ? out[above + i - pixel]! : 0;
			let value: number;
			switch (filter) {
				case 0:
					value = raw;
					break;
				case 1:
					value = raw + left;
					break;
				case 2:
					value = raw + up;
					break;
				case 3:
					value = raw + ((left + up) >> 1);
					break;
				case 4: {
					const p = left + up - upLeft;
					const pa = Math.abs(p - left);
					const pb = Math.abs(p - up);
					const pc = Math.abs(p - upLeft);
					value = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
					break;
				}
				default:
					return null;
			}
			out[at + i] = value & 0xff;
		}
		src += row;
	}
	return out;
}
