/**
 * The shipped SHA-256, pinned two ways: against the published test vectors,
 * and against the platform digest on arbitrary inputs - because its whole
 * reason to exist is producing THE SAME id a subtle-equipped device would.
 */

import { describe, expect, it } from "vitest";
import { sha256 } from "./Sha256";
import { pdfInkId } from "./PdfIdentity";

// Node 18+ exposes webcrypto as the global `crypto`, same shape the DOM
// types describe - so the platform half of the comparison needs no import
// (and no @types/node, which this repo deliberately lacks).
const platformCrypto = globalThis.crypto;

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

describe("the shipped sha-256", () => {
	it("matches the published vectors", () => {
		expect(hex(sha256(new Uint8Array(0)))).toBe(
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
		);
		expect(hex(sha256(new TextEncoder().encode("abc")))).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
		);
	});

	it("agrees with the platform digest on arbitrary inputs", async () => {
		for (const n of [1, 55, 56, 63, 64, 65, 1000, 65536]) {
			const data = new Uint8Array(n);
			for (let i = 0; i < n; i++) data[i] = (i * 37 + n) & 0xff;
			const platform = new Uint8Array(await platformCrypto.subtle.digest("SHA-256", data.slice().buffer));
			expect(hex(sha256(data))).toBe(hex(platform));
		}
	});

	it("gives a subtle-less device the same pdf id a desktop derives", async () => {
		const doc = new Uint8Array(80000);
		for (let i = 0; i < doc.length; i++) doc[i] = (i * 13) & 0xff;
		const withSubtle = await pdfInkId(doc, platformCrypto);
		const without = await pdfInkId(doc, undefined);
		expect(without).toBe(withSubtle);
		expect(without.startsWith("pdf-")).toBe(true);
	});
});
