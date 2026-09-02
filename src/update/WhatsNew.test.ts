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

	it("a version with no notes of its own still reports what was skipped", () => {
		// This assertion is the opposite of what it was, deliberately. Notes
		// used to be looked up under the landed version and nowhere else, so
		// a release with no entry said nothing at all - and 1.4.3 has no
		// entry, which is why everyone arriving there from 1.3.x heard
		// nothing about the PDF release they had just installed. The standing
		// workaround was copying a headline forward into the next version's
		// list by hand, every time.
		const d = decideWhatsNew("1.3.99", "1.3.10", false, NOTES);
		expect(d.show).toBe(true);
		expect(d).toMatchObject({ record: "1.3.99", notes: ["more"] });
	});

	it("stays quiet when there is genuinely nothing since the seen version", () => {
		expect(decideWhatsNew("1.3.99", "1.3.11", false, NOTES)).toEqual({
			show: false,
			record: "1.3.99",
		});
	});

	it("gathers every version skipped, oldest first", () => {
		const d = decideWhatsNew("1.3.11", "1.3.9", false, NOTES);
		expect(d).toMatchObject({ notes: ["undo works", "more"] });
	});

	it("does not repeat a line two releases both carry", () => {
		// The copy-forward workaround is still in the shipped notes: the pdf
		// headline appears under 1.4.0 and again under 1.4.2. Nobody wants to
		// read it twice.
		const dupes = { "1.4.0": ["write on pdfs", "a"], "1.4.2": ["write on pdfs", "b"] };
		const d = decideWhatsNew("1.4.2", "1.3.11", false, dupes);
		expect(d).toMatchObject({ notes: ["write on pdfs", "a", "b"] });
	});

	it("a build older than the key itself hears about one release, not all of them", () => {
		// seen === null means a build from before the seen-version key
		// existed. Every note ever written would be a wall of text at someone
		// who has been away one release.
		const d = decideWhatsNew("1.3.11", null, false, NOTES);
		expect(d).toMatchObject({ notes: ["more"] });
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
