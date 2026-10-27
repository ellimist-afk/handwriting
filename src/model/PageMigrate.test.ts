import { describe, expect, it } from "vitest";
import { migratePageData as viaPageData } from "./PageData";
import { migratePageData as viaPageMigrate } from "./PageMigrate";
import pageDataRaw from "./PageData.ts?raw";
import pageMigrateRaw from "./PageMigrate.ts?raw";

/**
 * The decode half of the sidecar (what a migration had to discard, and the tolerant migration itself) lives in
 * PageMigrate.ts; PageData.ts re-exports it so every importer keeps its path. Two cells hold that shape.
 */
describe("PageMigrate.ts", () => {
	it("is the one migration: PageData.ts hands out the same function", () => {
		expect(viaPageData).toBe(viaPageMigrate);
	});

	it("holds the whole migration, and PageData.ts declares none of it", () => {
		const declares = (text: string, name: string) =>
			new RegExp(`^(export )?(async )?(function|interface) ${name}\\b`, "m").test(text);
		for (const name of [
			"DecodeLoss",
			"emptyDecodeLoss",
			"wasLossy",
			"onlyUnknownPointKeys",
			"describeDecodeLoss",
			"unreadableList",
			"migratePageData",
			"fileObjectIds",
			"canonicalJson",
			"unpackObjectPoints",
		]) {
			expect(declares(pageMigrateRaw, name), `${name} is declared in PageMigrate.ts`).toBe(true);
			expect(declares(pageDataRaw, name), `${name} is still declared in PageData.ts`).toBe(false);
		}
		expect(pageDataRaw).toContain('export { migratePageData, type DecodeLoss } from "./PageMigrate";');
	});
});
