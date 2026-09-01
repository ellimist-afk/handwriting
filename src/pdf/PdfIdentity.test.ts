/**
 * The sidecar id, which is the thing everything else keys on. If it is not
 * stable, ink appears to vanish; if it is not distinct, two documents share
 * annotations. Both are silent failures, so the properties are asserted
 * directly rather than inferred from a hash looking hash-shaped.
 */

import { describe, expect, it } from "vitest";
import {
	HEAD_BYTES,
	ID_HEX_CHARS,
	chooseInstance,
	familyOf,
	headOf,
	idFromDigest,
	idInput,
	nextInstanceId,
	pdfInkId,
	toHex,
} from "./PdfIdentity";

const bytes = (...v: number[]) => new Uint8Array(v);

function filled(len: number, seed = 1): Uint8Array {
	const out = new Uint8Array(len);
	for (let i = 0; i < len; i++) out[i] = (i * 31 + seed) & 0xff;
	return out;
}

describe("idInput", () => {
	it("appends the length so truncation cannot forge an identity", () => {
		// Two files sharing a prefix - a template and a filled-in copy - differ
		// in length, and that difference has to reach the hash or they collide.
		const a = idInput(bytes(1, 2, 3), 3);
		const b = idInput(bytes(1, 2, 3), 4);
		expect(a).not.toEqual(b);
		expect(new TextDecoder().decode(a.subarray(3))).toBe(":3");
	});

	it("leaves the head bytes untouched at the front", () => {
		const head = bytes(9, 8, 7);
		expect(idInput(head, 3).subarray(0, 3)).toEqual(head);
	});
});

describe("headOf", () => {
	it("takes only the window from a large file", () => {
		expect(headOf(filled(HEAD_BYTES * 3)).length).toBe(HEAD_BYTES);
	});

	it("takes the whole of a small one", () => {
		expect(headOf(filled(10)).length).toBe(10);
	});

	it("accepts a raw buffer, which is what the vault hands back", () => {
		expect(headOf(filled(20).buffer as ArrayBuffer).length).toBe(20);
	});
});

describe("toHex / idFromDigest", () => {
	it("pads every byte to two characters", () => {
		// A byte below 16 losing its leading zero shortens the whole string and
		// silently changes the id.
		expect(toHex(bytes(0, 1, 15, 16, 255).buffer as ArrayBuffer)).toBe("00010f10ff");
	});

	it("keeps a fixed-length id under a recognizable prefix", () => {
		const id = idFromDigest(filled(32).buffer as ArrayBuffer);
		expect(id.startsWith("pdf-")).toBe(true);
		expect(id.length).toBe(4 + ID_HEX_CHARS);
	});
});

describe("pdfInkId", () => {
	const subtle = globalThis.crypto as Crypto;

	it("is stable: the same bytes always give the same id", async () => {
		const a = await pdfInkId(filled(5000), subtle);
		const b = await pdfInkId(filled(5000), subtle);
		expect(a).toBe(b);
	});

	it("is distinct: different content gives a different id", async () => {
		const a = await pdfInkId(filled(5000, 1), subtle);
		const b = await pdfInkId(filled(5000, 2), subtle);
		expect(a).not.toBe(b);
	});

	it("separates two files that share a head but differ in length", async () => {
		// The case the length suffix exists for. Both have identical first
		// 64 KiB; only the total size tells them apart.
		const big = filled(HEAD_BYTES + 500);
		const bigger = new Uint8Array(HEAD_BYTES + 900);
		bigger.set(big.subarray(0, HEAD_BYTES), 0);
		expect(headOf(big)).toEqual(headOf(bigger));
		expect(await pdfInkId(big, subtle)).not.toBe(await pdfInkId(bigger, subtle));
	});

	it("ignores everything past the head, so a huge file costs one window", async () => {
		// Two files identical for 64 KiB and different afterwards, but the SAME
		// length, are deliberately one document to us. That is the price of not
		// reading a hundred megabytes on every open, and it is stated here so
		// the trade is visible rather than discovered.
		const a = new Uint8Array(HEAD_BYTES + 100);
		a.set(filled(HEAD_BYTES), 0);
		const b = new Uint8Array(HEAD_BYTES + 100);
		b.set(filled(HEAD_BYTES), 0);
		b[HEAD_BYTES + 50] = 0xff;
		expect(await pdfInkId(a, subtle)).toBe(await pdfInkId(b, subtle));
	});

	it("accepts an ArrayBuffer, which is what readBinary returns", async () => {
		const view = filled(1000);
		expect(await pdfInkId(view.buffer as ArrayBuffer, subtle)).toBe(await pdfInkId(view, subtle));
	});
});

describe("instances within a content family", () => {
	const F = "pdf-" + "ab".repeat(16);

	it("familyOf strips the instance suffix and nothing else", () => {
		expect(familyOf(F)).toBe(F);
		expect(familyOf(`${F}-2`)).toBe(F);
		expect(familyOf(`${F}-17`)).toBe(F);
		expect(familyOf("not-a-pdf-id")).toBe("not-a-pdf-id");
	});

	it("nextInstanceId fills the lowest hole and ignores other families", () => {
		expect(nextInstanceId(F, [])).toBe(F);
		expect(nextInstanceId(F, [F])).toBe(`${F}-2`);
		expect(nextInstanceId(F, [F, `${F}-2`])).toBe(`${F}-3`);
		expect(nextInstanceId(F, [`${F}-2`])).toBe(F);
		expect(nextInstanceId(F, ["pdf-" + "cd".repeat(16)])).toBe(F);
	});

	const exists = (live: string[]) => (p: string) => live.includes(p);

	it("no sidecars at all: the first instance takes the bare family id", () => {
		expect(chooseInstance(F, "a.pdf", [], exists([]))).toEqual({ id: F, action: "fresh" });
	});

	it("a sidecar already claiming the path is simply this file", () => {
		const c = [
			{ id: F, paths: ["a.pdf"] },
			{ id: `${F}-2`, paths: ["b.pdf"] },
		];
		expect(chooseInstance(F, "b.pdf", c, exists(["a.pdf", "b.pdf"]))).toEqual({
			id: `${F}-2`,
			action: "use",
		});
	});

	it("a claimless sidecar is pre-instance data: the first opener adopts it", () => {
		const c = [{ id: F, paths: [] }];
		expect(chooseInstance(F, "a.pdf", c, exists(["a.pdf"]))).toEqual({ id: F, action: "adopt" });
	});

	it("a sidecar whose every claimed path vanished follows a rename", () => {
		const c = [{ id: F, paths: ["old.pdf"] }];
		expect(chooseInstance(F, "new.pdf", c, exists(["new.pdf"]))).toEqual({
			id: F,
			action: "adopt",
		});
	});

	it("every instance claimed by a living file means THIS one is a fresh copy", () => {
		const c = [{ id: F, paths: ["original.pdf"] }];
		// The launch-day bug: a byte-identical OneNote re-export arrived
		// wearing the original's ink. A copy starts blank.
		expect(chooseInstance(F, "copy.pdf", c, exists(["original.pdf", "copy.pdf"]))).toEqual({
			id: `${F}-2`,
			action: "fresh",
		});
	});

	it("a sidecar claimed by a still-living file is never adopted for a rename", () => {
		const c = [
			{ id: F, paths: ["alive.pdf"] },
			{ id: `${F}-2`, paths: ["gone.pdf"] },
		];
		expect(chooseInstance(F, "moved.pdf", c, exists(["alive.pdf", "moved.pdf"]))).toEqual({
			id: `${F}-2`,
			action: "adopt",
		});
	});
});
