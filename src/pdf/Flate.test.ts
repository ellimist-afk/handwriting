/**
 * The decompressor, against streams a real deflater produced.
 *
 * Fixtures are zlib output, generated once and pasted in as base64 rather
 * than compressed at test time: the test has to prove this file can read what
 * the world writes, and a round trip through our own code would only prove it
 * agrees with itself. The inputs are formulas so what came out can be
 * rebuilt without checking in the plaintext too.
 *
 * The cases are chosen for the four shapes a DEFLATE stream comes in: a
 * dynamic block, one whose data resists compression, a long match that
 * overlaps its own output, and a stored block with no Huffman coding at all.
 */

import { describe, expect, it } from "vitest";
import { MAX_INFLATE, inflate, unpredict } from "./Flate";

function from64(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

function ascii(text: string): Uint8Array {
	const out = new Uint8Array(text.length);
	for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
	return out;
}

const FOX = "the quick brown fox ".repeat(40);

describe("inflate", () => {
	it("reads a dynamic block", () => {
		const got = inflate(from64("eNoryUhVKCzNTM5WSCrKL89TSMuvUCgZFRsVGxUDiwEAv/YlCA=="));
		expect(got && [...got]).toEqual([...ascii(FOX)]);
	});

	it("reads data that would not compress", () => {
		const got = inflate(
			from64(
				"eNpjUPXKn7LzHoduUPmcg88ETKPql5x8J2Gb1L7m4jcF16z+LTeZNXyLpu95yG0QWjX/yEthi9im5Wc+Sjukdq2/8lPZI3fS9jts2gGls/Y/4TOOqF10/I2YdULrqvNf5JwzejddZ1TzLpi66z6nXnDF3EPPBc2iG5aeei9pl9yx9tJ3RbfsCVtvsWj6Fc/Y+4jHMKx6wdFXIpZxzSvOfpJxTOvecPWXimfe5B132XUCy2YfeMpvElm3+MRbcZvEttUXvsq7ZPZtvsGk7lM4bfcDLv2QynmHXwiZxzQuO/1Byj6lc93lH0ruORO33WbV8i+Zue8xr1F4zcJjr0Wt4ltWnvss65Tes/EaA6leBwAyDpF2"
			)
		);
		const want = Array.from({ length: 300 }, (_, i) => (i * 37) % 251);
		expect(got && [...got]).toEqual(want);
	});

	it("reads a match that overlaps its own output", () => {
		// A thousand identical bytes is one short match copied over itself. A
		// decoder that copies with set() instead of byte at a time gets this
		// wrong and only ever notices on a run.
		const got = inflate(from64("eNpLTBwFo2AUDHcAAPnYevg="));
		expect(got?.length).toBe(1000);
		expect(got && [...new Set(got)]).toEqual([0x61]);
	});

	it("reads a stored block, which carries no codes at all", () => {
		const got = inflate(
			from64(
				"eAEBIAPf/HRoZSBxdWljayBicm93biBmb3ggdGhlIHF1aWNrIGJyb3duIGZveCB0aGUgcXVpY2sgYnJvd24gZm94IHRoZSBxdWljayBicm93biBmb3ggdGhlIHF1aWNrIGJyb3duIGZveCB0aGUgcXVpY2sgYnJvd24gZm94IHRoZSBxdWljayBicm93biBmb3ggdGhlIHF1aWNrIGJyb3duIGZveCB0aGUgcXVpY2sgYnJvd24gZm94IHRoZSBxdWljayBicm93biBmb3ggdGhlIHF1aWNrIGJyb3duIGZveCB0aGUgcXVpY2sgYnJvd24gZm94IHRoZSBxdWljayBicm93biBmb3ggdGhlIHF1aWNrIGJyb3duIGZveCB0aGUgcXVpY2sgYnJvd24gZm94IHRoZSBxdWljayBicm93biBmb3ggdGhlIHF1aWNrIGJyb3duIGZveCB0aGUgcXVpY2sgYnJvd24gZm94IHRoZSBxdWljayBicm93biBmb3ggdGhlIHF1aWNrIGJyb3duIGZveCB0aGUgcXVpY2sgYnJvd24gZm94IHRoZSBxdWljayBicm93biBmb3ggdGhlIHF1aWNrIGJyb3duIGZveCB0aGUgcXVpY2sgYnJvd24gZm94IHRoZSBxdWljayBicm93biBmb3ggdGhlIHF1aWNrIGJyb3duIGZveCB0aGUgcXVpY2sgYnJvd24gZm94IHRoZSBxdWljayBicm93biBmb3ggdGhlIHF1aWNrIGJyb3duIGZveCB0aGUgcXVpY2sgYnJvd24gZm94IHRoZSBxdWljayBicm93biBmb3ggdGhlIHF1aWNrIGJyb3duIGZveCB0aGUgcXVpY2sgYnJvd24gZm94IHRoZSBxdWljayBicm93biBmb3ggdGhlIHF1aWNrIGJyb3duIGZveCB0aGUgcXVpY2sgYnJvd24gZm94IHRoZSBxdWljayBicm93biBmb3ggdGhlIHF1aWNrIGJyb3duIGZveCB0aGUgcXVpY2sgYnJvd24gZm94IHRoZSBxdWljayBicm93biBmb3ggv/YlCA=="
			)
		);
		expect(got && [...got]).toEqual([...ascii(FOX)]);
	});

	it("reads an empty stream without inventing a byte", () => {
		expect(inflate(from64("eNoDAAAAAAE="))?.length).toBe(0);
	});

	it("reads a stream carrying every byte value", () => {
		const got = inflate(
			from64(
				"eJzLSE1MSS3iYmBkYmZhZWPn4OTi5uHl4xcQFBIWERUTl5CUkpaRlZNXUFRSVlFVU9fQ1NLW0dXTNzA0MjYxNTO3sLSytrG1s3dwdHJ2cXVz9/D08vbx9fMPCAwKDgkNC4+IjIqOiY2LT0hMSk5JTUvPyMzKzsnNyy8oLCouKS0rr6isqq6pratvaGxqbmlta+/o7Oru6e3rnzBx0uQpU6dNnzFz1uw5c+fNX7Bw0eIlS5ctX7Fy1eo1a9et37Bx0+YtW7dt37Fz1+49e/ftP3Dw0OEjR48dP3Hy1OkzZ8+dv3Dx0uUrV69dv3Hz1u07d+/df/Dw0eMnT589f/Hy1es3b9+9//Dx0+cvX799//Hz1+8/f//9z4AEw6CgANNksvA="
			)
		);
		const want = [...ascii("header\n"), ...Array.from({ length: 256 }, (_, i) => i), ...ascii("header\n".repeat(20))];
		expect(got && [...got]).toEqual(want);
	});

	it("stops rather than spending the heap on a stream that lied", () => {
		// 214 KB of deflated zeros expands to 220 MB. Structural streams are
		// kilobytes, and this runs on the main thread of an iPad.
		const thousandRuns = from64("eNpLTBwFo2AUDHcAAPnYevg=");
		expect(inflate(thousandRuns, 500)).toBe(null);
		expect(inflate(thousandRuns, 1000)?.length).toBe(1000);
		expect(MAX_INFLATE).toBeGreaterThan(11 * 1024 * 1024);
	});

	it("returns null rather than half a stream", () => {
		expect(inflate(from64("eNoryUhVKCzNTM5WSCrKL89TSMuvUCgZFRsVGxUDiwEAv/YlCA==").subarray(0, 12))).toBe(
			null
		);
		expect(inflate(new Uint8Array([1, 2, 3, 4]))).toBe(null);
		expect(inflate(new Uint8Array(0))).toBe(null);
	});
});

describe("the row filters", () => {
	it("undoes Up, which is what a cross-reference stream uses", () => {
		// Two rows of three columns: the second says "add the row above".
		const data = new Uint8Array([2, 1, 2, 3, 2, 10, 20, 30]);
		expect([...unpredict(data, 12, 1, 8, 3)!]).toEqual([1, 2, 3, 11, 22, 33]);
	});

	it("undoes Sub, Average and Paeth", () => {
		const sub = new Uint8Array([1, 5, 3, 2]);
		expect([...unpredict(sub, 12, 1, 8, 3)!]).toEqual([5, 8, 10]);
		const avg = new Uint8Array([0, 8, 8, 8, 3, 0, 0, 0]);
		expect([...unpredict(avg, 12, 1, 8, 3)!]).toEqual([8, 8, 8, 4, 6, 7]);
		const paeth = new Uint8Array([0, 4, 4, 4, 4, 1, 1, 1]);
		expect([...unpredict(paeth, 12, 1, 8, 3)!]).toEqual([4, 4, 4, 5, 6, 7]);
	});

	it("passes a stream that was never predicted straight through", () => {
		const data = new Uint8Array([9, 9, 9]);
		expect(unpredict(data, 1, 1, 8, 3)).toBe(data);
	});

	it("refuses TIFF prediction rather than mangling it", () => {
		expect(unpredict(new Uint8Array([1, 2, 3]), 2, 1, 8, 3)).toBe(null);
	});

	it("carries multiple columns of bytes per pixel", () => {
		// Four columns of a three-byte pixel, filtered Up: the row above is
		// added component by component.
		const row = 12;
		const data = new Uint8Array(2 + 2 * row);
		data[0] = 0;
		for (let i = 0; i < row; i++) data[1 + i] = i;
		data[1 + row] = 2;
		for (let i = 0; i < row; i++) data[2 + row + i] = 1;
		const got = unpredict(data, 15, 3, 8, 4)!;
		expect([...got.subarray(row)]).toEqual(Array.from({ length: row }, (_, i) => i + 1));
	});
});
