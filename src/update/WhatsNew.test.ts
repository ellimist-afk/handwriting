import { describe, expect, it } from "vitest";
import { decideWhatsNew, RELEASE_NOTES } from "./WhatsNew";

const NOTES = { "1.3.10": ["undo works"], "1.3.11": ["more"] };

describe("decideWhatsNew", () => {
	it("the case the feature exists for: updating from a build that never stored a version", () => {
		// 1.3.9 wrote no seen-version, so seen is null - but the vault HAS
		// settings, so this is an update and the notes are for them.
		const d = decideWhatsNew("1.3.10", null, false, NOTES);
		expect(d.show).toBe(true);
		expect(d).toMatchObject({ version: "1.3.10", notes: ["undo works"] });
	});

	it("a brand new install is left alone, and still remembers the version", () => {
		// Same null seen-version as the case above. Only `fresh` separates them.
		expect(decideWhatsNew("1.3.10", null, true, NOTES)).toEqual({
			show: false,
			record: "1.3.10",
		});
	});

	it("shows once, not on every launch", () => {
		expect(decideWhatsNew("1.3.10", "1.3.10", false, NOTES).show).toBe(false);
	});

	it("an older seen-version still pops for the newer one", () => {
		expect(decideWhatsNew("1.3.11", "1.3.10", false, NOTES).show).toBe(true);
	});

	it("a version with no notes stays quiet but records, so the NEXT one is not late", () => {
		const d = decideWhatsNew("1.3.99", "1.3.10", false, NOTES);
		expect(d).toEqual({ show: false, record: "1.3.99" });
	});

	it("empty notes count as no notes", () => {
		expect(decideWhatsNew("1.4.0", "1.3.10", false, { "1.4.0": [] }).show).toBe(false);
	});

	it("the shipped notes are the ones the release went out with", () => {
		expect(RELEASE_NOTES["1.3.10"]).toEqual([
			"undo works",
			"ink prediction v2",
			"toolbar ui fixes",
			"bug fixes",
		]);
	});
});
