import { describe, expect, it } from "vitest";
import { emptyPage, migratePageData, parsePage, serializePage, SCHEMA_VERSION } from "./PageData";

function roundTrip(fontRefPx: unknown) {
	const raw = JSON.parse(serializePage(emptyPage("p1")));
	raw.fontRefPx = fontRefPx;
	return parsePage(JSON.stringify(raw), "p1").data;
}

describe("PageData.fontRefPx (audit 46)", () => {
	it("round-trips a stored reference", () => {
		const page = emptyPage("p1");
		page.fontRefPx = 16;
		expect(parsePage(serializePage(page), "p1").data.fontRefPx).toBe(16);
	});

	it("is written as a top-level number with the schema version unchanged (the shape an older build carries as an unknown field)", () => {
		const page = emptyPage("p1");
		page.fontRefPx = 20;
		const json = JSON.parse(serializePage(page));
		// Shape only. That a real 1.4.20 / 1.4.21 codec keeps the field through an
		// edit and save is not tested here; it was measured with the exact
		// historical codecs in the independent review of this change.
		expect(json.fontRefPx).toBe(20);
		expect(json.schemaVersion).toBe(SCHEMA_VERSION);
		expect(SCHEMA_VERSION).toBe(1);
	});

	it("is not written when unset, so every existing sidecar stays byte-identical", () => {
		expect(serializePage(emptyPage("p1"))).not.toContain("fontRefPx");
	});

	it.each([0, -3, NaN, Infinity, "16", null, {}, [16]])("drops a bad stored value %s", (bad) => {
		const data = roundTrip(bad);
		expect(data.fontRefPx).toBeUndefined();
		expect(data.unknownTop.fontRefPx).toBeUndefined();
	});

	it("does not write a bad in-memory value either", () => {
		const page = emptyPage("p1");
		page.fontRefPx = -1;
		expect(serializePage(page)).not.toContain("fontRefPx");
	});

	it("migratePageData reads it too", () => {
		expect(migratePageData({ pageId: "p1", surface: "inline", fontRefPx: 18 }, "p1").fontRefPx).toBe(18);
	});
});
