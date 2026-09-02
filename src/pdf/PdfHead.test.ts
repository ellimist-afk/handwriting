/**
 * The ranged head read. The property that matters is not speed but that the
 * cheap path and the old whole-file path produce the SAME head and length -
 * a desktop and a phone disagreeing here file one document's ink under two
 * ids and the sync split is silent.
 */

import { describe, expect, it, vi } from "vitest";
import { HEAD_BYTES, headOf, pdfInkIdFromHead } from "./PdfIdentity";
import { HeadSource, RangedHandle, readPdfHead } from "./PdfHead";

function filled(len: number, seed = 1): Uint8Array {
	const out = new Uint8Array(len);
	for (let i = 0; i < len; i++) out[i] = (i * 31 + seed) & 0xff;
	return out;
}

/** A handle over an in-memory file, counting what it was asked to do. */
function fakeHandle(bytes: Uint8Array, opts: { chunk?: number; size?: number } = {}) {
	const state = { closed: 0, reads: 0, maxEnd: 0 };
	const handle: RangedHandle = {
		async read(into, at) {
			state.reads++;
			const n = Math.min(into.length, opts.chunk ?? into.length, Math.max(0, bytes.length - at));
			into.set(bytes.subarray(at, at + n), 0);
			state.maxEnd = Math.max(state.maxEnd, at + n);
			return n;
		},
		async size() {
			return opts.size ?? bytes.length;
		},
		async close() {
			state.closed++;
		},
	};
	return { handle, state };
}

function source(bytes: Uint8Array, opts: { chunk?: number; size?: number } = {}) {
	const { handle, state } = fakeHandle(bytes, opts);
	const whole = vi.fn(async () => bytes);
	const src: HeadSource = { openRanged: async () => handle, whole };
	return { src, state, whole };
}

describe("readPdfHead, ranged path", () => {
	it("returns head and size without ever reading the whole file", async () => {
		// The entire point: a 200 MB scan must not enter memory to be hashed.
		const bytes = filled(HEAD_BYTES * 3);
		const { src, state, whole } = source(bytes);
		const got = await readPdfHead(src);
		expect(whole).not.toHaveBeenCalled();
		expect(got.byteLength).toBe(bytes.length);
		expect(got.head).toEqual(headOf(bytes));
		expect(state.maxEnd).toBe(HEAD_BYTES);
	});

	it("reads at most HEAD_BYTES and never past it", async () => {
		const { src, state } = source(filled(HEAD_BYTES * 10));
		const got = await readPdfHead(src);
		expect(got.head.length).toBe(HEAD_BYTES);
		expect(state.maxEnd).toBe(HEAD_BYTES);
	});

	it("gives a short file exactly its own bytes, not a padded buffer", async () => {
		// A zero-padded head would hash differently from the whole-file read
		// of the same file. Small PDFs are the common case on a phone.
		const bytes = filled(900);
		const { src } = source(bytes);
		const got = await readPdfHead(src);
		expect(got.head).toEqual(bytes);
		expect(got.byteLength).toBe(900);
	});

	it("handles an empty file", async () => {
		const { src } = source(new Uint8Array(0));
		expect(await readPdfHead(src)).toEqual({ head: new Uint8Array(0), byteLength: 0 });
	});

	it("keeps reading when the handle returns short counts", async () => {
		// Nothing promises one read fills the buffer.
		const bytes = filled(HEAD_BYTES + 10);
		const { src, state } = source(bytes, { chunk: 1000 });
		const got = await readPdfHead(src);
		expect(got.head).toEqual(headOf(bytes));
		expect(state.reads).toBeGreaterThan(1);
	});

	it("stops instead of spinning when the handle stops making progress", async () => {
		// And falls back rather than hashing what it got. The old assertion
		// here was head.length 0 with the full stat length - a real id, made
		// of no bytes, that no whole-file read of the same file can ever
		// produce (audit doc §5k/AD5).
		const handle: RangedHandle = {
			read: async () => 0,
			size: async () => HEAD_BYTES,
			close: async () => {},
		};
		const whole = filled(4);
		const got = await readPdfHead({ openRanged: async () => handle, whole: async () => whole });
		expect(got.head).toEqual(whole);
		expect(got.byteLength).toBe(4);
	});

	it("a read that stops before want falls back to the whole file", async () => {
		// Audit doc §5k/AD5. The handle's own stat promised HEAD_BYTES, so the
		// bytes are there; a driver that hands back half of them and then zero
		// - a network share, a FUSE mount, a OneDrive placeholder mid-hydrate
		// - used to mint an id from the half. A different id is a different
		// sidecar, so the document's ink is on disk and invisible.
		const bytes = filled(HEAD_BYTES * 2);
		let served = 0;
		const handle: RangedHandle = {
			read: async (into) => {
				if (served > 0) return 0;
				const n = Math.min(into.length, HEAD_BYTES / 2);
				into.set(bytes.subarray(served, served + n));
				served += n;
				return n;
			},
			size: async () => bytes.length,
			close: async () => {},
		};
		const whole = vi.fn(async () => bytes);
		const got = await readPdfHead({ openRanged: async () => handle, whole });
		expect(whole).toHaveBeenCalledOnce();
		expect(got.head).toEqual(headOf(bytes));
		expect(got.byteLength).toBe(bytes.length);
	});

	it("still closes the handle when a short read sends it to the whole file", async () => {
		let closed = 0;
		const handle: RangedHandle = {
			read: async () => 0,
			size: async () => HEAD_BYTES,
			close: async () => {
				closed++;
			},
		};
		await readPdfHead({ openRanged: async () => handle, whole: async () => filled(8) });
		expect(closed).toBe(1);
	});

	it("takes the length from the handle, not from the bytes it read", async () => {
		// TFile.stat.size can lag an external write; the handle's own stat is
		// the only size that describes the bytes actually being hashed.
		const { src } = source(filled(HEAD_BYTES + 5), { size: 987_654_321 });
		expect((await readPdfHead(src)).byteLength).toBe(987_654_321);
	});

	it("closes the handle on success", async () => {
		const { src, state } = source(filled(100));
		await readPdfHead(src);
		expect(state.closed).toBe(1);
	});
});

describe("readPdfHead, falling back", () => {
	const whole = filled(HEAD_BYTES + 321, 7);

	it("uses the whole read when there is no ranged source at all", async () => {
		// Mobile, and any desktop build without `require`.
		const got = await readPdfHead({ whole: async () => whole });
		expect(got.head).toEqual(headOf(whole));
		expect(got.byteLength).toBe(whole.length);
	});

	it("accepts the ArrayBuffer readBinary actually returns", async () => {
		const got = await readPdfHead({ whole: async () => whole.buffer as ArrayBuffer });
		expect(got.head).toEqual(headOf(whole));
		expect(got.byteLength).toBe(whole.length);
	});

	it("falls back when opening throws, where there is no handle to close", async () => {
		const got = await readPdfHead({
			openRanged: async () => {
				throw new Error("EACCES");
			},
			whole: async () => whole,
		});
		expect(got.head).toEqual(headOf(whole));
		expect(got.byteLength).toBe(whole.length);
	});

	it("falls back when the read throws, and still closes the handle", async () => {
		let closed = 0;
		const handle: RangedHandle = {
			read: async () => {
				throw new Error("EIO");
			},
			size: async () => whole.length,
			close: async () => {
				closed++;
			},
		};
		const got = await readPdfHead({ openRanged: async () => handle, whole: async () => whole });
		expect(closed).toBe(1);
		expect(got.head).toEqual(headOf(whole));
	});

	it("falls back when the stat throws, and still closes the handle", async () => {
		let closed = 0;
		const handle: RangedHandle = {
			read: async () => 0,
			size: async () => {
				throw new Error("ENOENT");
			},
			close: async () => {
				closed++;
			},
		};
		const got = await readPdfHead({ openRanged: async () => handle, whole: async () => whole });
		expect(closed).toBe(1);
		expect(got.byteLength).toBe(whole.length);
	});

	it("keeps a good head when only the close fails", async () => {
		// Throwing away a read that worked would spend the whole-file read
		// this whole file exists to avoid.
		const wholeFn = vi.fn(async () => whole);
		const handle: RangedHandle = {
			read: async (into, at) => {
				into.set(whole.subarray(at, at + into.length), 0);
				return into.length;
			},
			size: async () => whole.length,
			close: async () => {
				throw new Error("EBADF");
			},
		};
		const got = await readPdfHead({ openRanged: async () => handle, whole: wholeFn });
		expect(wholeFn).not.toHaveBeenCalled();
		expect(got.head).toEqual(headOf(whole));
	});

	it("lets a failing whole read reject, as it did before", async () => {
		// runDetached turns this into the "could not identify" Notice; that
		// path is unchanged.
		await expect(
			readPdfHead({
				whole: async () => {
					throw new Error("gone");
				},
			})
		).rejects.toThrow("gone");
	});
});

describe("the two paths agree", () => {
	// The device check: a PDF opened on desktop after 1.4.6 must land in the
	// sidecar it already had - for every HANDLE BEHAVIOUR a real filesystem
	// can hand back, not only a cooperative one (1.4.6-design.md 5m/AF4: the
	// old version of this property swept lengths against a well-behaved
	// handle only, so a chunked read, a stall or a lying stat were each
	// asserted in isolation against `headOf(bytes)`, one behaviour at a
	// time, rather than through the route a real open does - readPdfHead
	// itself, compared against the whole-file read of the SAME bytes.
	const subtle = globalThis.crypto as Crypto;
	const LENGTHS = [0, 10, HEAD_BYTES - 1, HEAD_BYTES, HEAD_BYTES + 1, HEAD_BYTES * 4];

	async function idOf(h: { head: Uint8Array; byteLength: number }): Promise<string> {
		return pdfInkIdFromHead(h.head, h.byteLength, subtle);
	}

	// One real, short read, then nothing: the shape of a network share, a
	// FUSE mount, or a OneDrive placeholder mid-hydrate that answers the
	// open and the stat but stops delivering bytes (audit doc §5k/AD5).
	// Always short by at least one byte of whatever is asked, so it stalls
	// however large the window is - it never happens to fully satisfy it.
	function stallingSource(bytes: Uint8Array): { src: HeadSource; whole: ReturnType<typeof vi.fn> } {
		let served = false;
		const handle: RangedHandle = {
			async read(into, at) {
				if (served) return 0;
				served = true;
				const avail = Math.max(0, bytes.length - at);
				const n = Math.max(0, Math.min(into.length, avail) - 1);
				into.set(bytes.subarray(at, at + n), 0);
				return n;
			},
			async size() {
				return bytes.length;
			},
			async close() {},
		};
		const whole = vi.fn(async () => bytes);
		const src: HeadSource = { openRanged: async () => handle, whole };
		return { src, whole };
	}

	// Four behaviours a real `openRanged` can produce. Each is checked at
	// every length in LENGTHS except "lying stat", which is checked only
	// where the invariant below can hold - see its own comment.
	const behaviours: Record<
		string,
		{ lengths: number[]; build: (bytes: Uint8Array) => { src: HeadSource; whole: ReturnType<typeof vi.fn> } }
	> = {
		"well-behaved": {
			lengths: LENGTHS,
			build: (bytes) => {
				const { src, whole } = source(bytes);
				return { src, whole };
			},
		},
		chunked: {
			lengths: LENGTHS,
			build: (bytes) => {
				const { src, whole } = source(bytes, { chunk: 997 });
				return { src, whole };
			},
		},
		stalling: {
			lengths: LENGTHS,
			build: (bytes) => stallingSource(bytes),
		},
		// The handle's own stat is trusted as ground truth (PdfHead.ts's
		// header: never TFile.stat.size), so a stat that lies LARGER than
		// the real file is undetectable once the file is at least as long
		// as the window it implies - the read simply succeeds, full of
		// correct head bytes, under the wrong length. That is finding 5 /
		// AF4's ":144 pins a stat of 987,654,321 ... ranged and whole
		// produce DIFFERENT ids - pre-existing" case, and the dedicated
		// "takes the length from the handle" test above pins it on its own.
		// Below HEAD_BYTES the lie still forces a real shortfall - the
		// window it implies cannot be filled from a file that short - so
		// the invariant holds there via the same fallback every other
		// short read takes. Only those lengths are swept here; the ones
		// that cannot agree are the ones already fenced above, not
		// re-asserted (and not silently passed) here.
		"lying stat": {
			lengths: LENGTHS.filter((n) => n < HEAD_BYTES),
			build: (bytes) => {
				const { src, whole } = source(bytes, { size: 987_654_321 });
				return { src, whole };
			},
		},
	};

	for (const [name, behaviour] of Object.entries(behaviours)) {
		it(`${name}: ranged agrees with whole - directly, or by falling back to it`, async () => {
			for (const len of behaviour.lengths) {
				const bytes = filled(len, 3);
				const { src, whole } = behaviour.build(bytes);
				const ranged = await readPdfHead(src);
				const all = await readPdfHead({ whole: async () => bytes });
				expect(ranged).toEqual(all);
				expect(await idOf(ranged)).toBe(await idOf(all));
				// "Agreement or fallback" is the actual invariant, not just
				// equal output: a well-behaved or chunked read must reach
				// that answer WITHOUT ever touching whole() - that is the
				// entire point of the ranged path - while stalling and a
				// short-of-window lying stat may only agree BECAUSE
				// readPdfHead fell back to whole() itself. Checking which
				// one happened is what tells the two apart; equal output
				// alone would not.
				if (name === "well-behaved" || name === "chunked") {
					expect(whole).not.toHaveBeenCalled();
				} else if (len > 0) {
					// At len 0, `want` is 0 and no read is ever attempted -
					// stalling and lying-stat both agree directly there too,
					// with nothing to fall back FROM.
					expect(whole).toHaveBeenCalledOnce();
				}
			}
		});
	}
});
