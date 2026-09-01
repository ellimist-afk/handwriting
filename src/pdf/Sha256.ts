/**
 * SHA-256, written out, for exactly one caller: pdf identity on platforms
 * where `crypto.subtle` is missing.
 *
 * WKWebView contexts do not reliably expose SubtleCrypto, and the failure
 * mode was the worst kind: `pdfInkId` threw, `runDetached` logged it where
 * nobody looks, and every pen contact on every PDF said "still identifying"
 * forever - which read as erase, colours and ink all being broken at once
 * (alan's mother, ipad, 2026-08-30, release eve).
 *
 * The SAME algorithm as the subtle path on purpose, not a cheaper hash: the
 * id derived on an iPad must equal the id derived on the desktop, or the two
 * devices file the same document's ink under different names and sync
 * silently splits. The test suite pins this implementation against the
 * platform digest byte for byte.
 *
 * Sync, which the caller prefers anyway; the input is at most 64 KiB.
 */

const K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

export function sha256(bytes: Uint8Array): Uint8Array {
	const len = bytes.length;
	// Padded message: original, 0x80, zeros to 56 mod 64, then the bit length
	// as a 64-bit big-endian integer.
	const padded = new Uint8Array((((len + 8) >> 6) + 1) << 6);
	padded.set(bytes);
	padded[len] = 0x80;
	const view = new DataView(padded.buffer);
	view.setUint32(padded.length - 8, (len / 0x20000000) | 0);
	view.setUint32(padded.length - 4, (len << 3) >>> 0);

	const h = new Uint32Array([
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
	]);
	const w = new Uint32Array(64);

	for (let off = 0; off < padded.length; off += 64) {
		for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
		for (let i = 16; i < 64; i++) {
			const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
			const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
			w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
		}
		let [a, b, c, d, e, f, g, hh] = h as unknown as number[];
		for (let i = 0; i < 64; i++) {
			const S1 = rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25);
			const ch = (e! & f!) ^ (~e! & g!);
			const t1 = (hh! + S1 + ch + K[i]! + w[i]!) >>> 0;
			const S0 = rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22);
			const maj = (a! & b!) ^ (a! & c!) ^ (b! & c!);
			const t2 = (S0 + maj) >>> 0;
			hh = g!;
			g = f!;
			f = e!;
			e = (d! + t1) >>> 0;
			d = c!;
			c = b!;
			b = a!;
			a = (t1 + t2) >>> 0;
		}
		h[0] = (h[0]! + a!) >>> 0;
		h[1] = (h[1]! + b!) >>> 0;
		h[2] = (h[2]! + c!) >>> 0;
		h[3] = (h[3]! + d!) >>> 0;
		h[4] = (h[4]! + e!) >>> 0;
		h[5] = (h[5]! + f!) >>> 0;
		h[6] = (h[6]! + g!) >>> 0;
		h[7] = (h[7]! + hh!) >>> 0;
	}

	const out = new Uint8Array(32);
	const ov = new DataView(out.buffer);
	for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i]!);
	return out;
}
