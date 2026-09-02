/**
 * A page id is a path component (audit item 2, 2026-09-01).
 *
 * `handwriting-page-id` in a note's frontmatter, and `pageId` inside a
 * sidecar, are both interpolated straight into vault paths - the sidecar,
 * its .tmp, its trash generations, its damaged and conflict copies. Both
 * are text a person can type and sync can carry in from another machine.
 * A note declaring `../../x` read, and on the first stroke wrote, a `.json`
 * outside the ink folder.
 *
 * These pin the shape rather than a blocklist: anything that is not plainly
 * a name is refused, and every id the plugin has ever minted is a name.
 */

import { describe, expect, it } from "vitest";

import { isSafePageId, migratePageData, newId, newPageId, parsePage } from "./PageData";

describe("isSafePageId", () => {
	it("accepts every id this plugin mints", () => {
		// The real generators, not transcriptions of them.
		for (let i = 0; i < 50; i++) expect(isSafePageId(newPageId())).toBe(true);
		for (const prefix of ["s", "img", "box"]) expect(isSafePageId(newId(prefix))).toBe(true);
		// The randomUUID-less fallbacks and the pdf instance names, which are
		// minted elsewhere and never pass through newPageId.
		for (const id of [
			"page-1756789012345-k3f9zq",
			"pdf-9f86d081884c7d65",
			"pdf-9f86d081884c7d65-2",
		]) {
			expect(isSafePageId(id)).toBe(true);
		}
	});

	it("refuses anything that could leave the ink folder", () => {
		for (const id of [
			"../../x",
			"..",
			"../secret",
			"a/../b",
			"sub/dir",
			"sub\\dir",
			"/abs",
			"C:\\abs",
			".hidden",
			"a..b",
		]) {
			expect(isSafePageId(id)).toBe(false);
		}
	});

	it("refuses ids that are not names at all", () => {
		for (const id of ["", " ", "a b", "a\nb", "a\u0000b", "page:1", "page?1", "page*1", "café"]) {
			expect(isSafePageId(id)).toBe(false);
		}
		for (const id of [undefined, null, 42, {}, ["ok"]]) expect(isSafePageId(id)).toBe(false);
	});

	it("bounds the length a filesystem has to take", () => {
		expect(isSafePageId("a".repeat(128))).toBe(true);
		expect(isSafePageId("a".repeat(129))).toBe(false);
	});
});

describe("a sidecar's own pageId", () => {
	it("is kept when it is a usable name", () => {
		const page = migratePageData({ schemaVersion: 1, pageId: "pdf-9f86d081-2" }, "fallback");
		expect(page.pageId).toBe("pdf-9f86d081-2");
	});

	it("falls back to the id the page was opened under when it is not", () => {
		// The fallback is the caller's id, which has already been checked at
		// the frontmatter ingress; the file does not get to rename itself
		// into somewhere else.
		for (const declared of ["../../evil", "a/b", ".hidden", ""]) {
			const page = migratePageData({ schemaVersion: 1, pageId: declared }, "safe-id");
			expect(page.pageId).toBe("safe-id");
		}
	});

	it("survives the whole parse, not just the migration", () => {
		const r = parsePage(JSON.stringify({ schemaVersion: 1, pageId: "../../evil", strokes: [] }), "safe-id");
		expect(r.damaged).toBeUndefined();
		expect(r.data.pageId).toBe("safe-id");
	});
});
