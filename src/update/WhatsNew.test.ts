import { beforeEach, describe, expect, it } from "vitest";
import { decideWhatsNew, RELEASE_NOTES, whatsNewDurationMs, whatsNewFragment } from "./WhatsNew";

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

	it("groups the shipped notes from 1.3.10: five versions, the repeat kept only in the oldest", () => {
		// Measured against the shipped RELEASE_NOTES in 1.4.6-design.md §5c:
		// 1.3.10 -> 1.4.5 is five versions (1.3.11, 1.4.1, 1.4.2, 1.4.4, 1.4.5)
		// and 23 lines once repeats collapse to their first appearance. "bug
		// fixes" is in every one of those five lists in RELEASE_NOTES; only
		// the oldest should still carry it.
		const d = decideWhatsNew("1.4.5", "1.3.10", false);
		expect(d.show).toBe(true);
		if (!d.show) throw new Error("unreachable, asserted above");
		expect(d.groups.map((g) => g.version)).toEqual(["1.3.11", "1.4.1", "1.4.2", "1.4.4", "1.4.5"]);
		expect(d.notes).toHaveLength(23);
		expect(d.groups[0]?.notes).toContain("bug fixes");
		for (const group of d.groups.slice(1)) expect(group.notes).not.toContain("bug fixes");
	});
});

describe("whatsNewFragment", () => {
	// whatsNewFragment builds its output with Obsidian's injected DOM helpers
	// (the global `createFragment`, and `.createDiv`/`.createEl` on the
	// resulting node) - real methods that exist only inside an actual
	// Obsidian window. This suite runs with no DOM at all (vitest.config.ts
	// has no `environment`, so `document` is undefined here), so a fake with
	// the same call shape stands in; it lets the function under test run
	// completely unmodified, and its output is compared structurally.
	class FakeEl {
		children: FakeEl[] = [];
		constructor(
			public tag: string,
			public cls?: string,
			public text?: string
		) {}
		createDiv(opts: { cls?: string; text?: string } = {}): FakeEl {
			const el = new FakeEl("div", opts.cls, opts.text);
			this.children.push(el);
			return el;
		}
		createEl(tag: string, opts: { cls?: string; text?: string } = {}): FakeEl {
			const el = new FakeEl(tag, opts.cls, opts.text);
			this.children.push(el);
			return el;
		}
	}
	function shape(el: unknown): unknown {
		const e = el as FakeEl;
		return { tag: e.tag, cls: e.cls, text: e.text, children: e.children.map(shape) };
	}

	beforeEach(() => {
		(globalThis as unknown as { createFragment: () => FakeEl }).createFragment = () =>
			new FakeEl("fragment");
	});

	it("one group is node-for-node identical to no groups at all - today's shape, pinned", () => {
		const notes = ["a", "b"];
		const plain = whatsNewFragment("1.4.6", notes);
		const oneGroup = whatsNewFragment("1.4.6", notes, [{ version: "1.4.6", notes }]);
		expect(shape(oneGroup)).toEqual(shape(plain));
		expect(shape(plain)).toEqual({
			tag: "fragment",
			cls: undefined,
			text: undefined,
			children: [
				{
					tag: "div",
					cls: "handwriting-whats-new-title",
					text: "Handwriting 1.4.6",
					children: [],
				},
				{
					tag: "ul",
					cls: "handwriting-whats-new-list",
					text: undefined,
					children: [
						{ tag: "li", cls: undefined, text: "a", children: [] },
						{ tag: "li", cls: undefined, text: "b", children: [] },
					],
				},
			],
		});
	});

	it("more than one group labels every version after the first", () => {
		const groups = [
			{ version: "1.3.11", notes: ["x"] },
			{ version: "1.4.1", notes: ["y", "z"] },
		];
		const frag = whatsNewFragment("1.4.1", ["x", "y", "z"], groups);
		expect(shape(frag)).toEqual({
			tag: "fragment",
			cls: undefined,
			text: undefined,
			children: [
				{
					tag: "div",
					cls: "handwriting-whats-new-title",
					text: "Handwriting 1.4.1",
					children: [],
				},
				{
					tag: "ul",
					cls: "handwriting-whats-new-list",
					text: undefined,
					children: [{ tag: "li", cls: undefined, text: "x", children: [] }],
				},
				{
					tag: "div",
					cls: "handwriting-whats-new-version",
					text: "1.4.1",
					children: [],
				},
				{
					tag: "ul",
					cls: "handwriting-whats-new-list",
					text: undefined,
					children: [
						{ tag: "li", cls: undefined, text: "y", children: [] },
						{ tag: "li", cls: undefined, text: "z", children: [] },
					],
				},
			],
		});
	});
});

describe("whatsNewDurationMs", () => {
	// The duration table §5c specifies: 15000 for <= 4 lines, +1500/line past
	// that, capped at 45000. Measured case: the shipped 1.3.10 -> 1.4.5
	// history is 23 lines (see the grouping test above), landing at 43500 -
	// short of the cap, so the earliest release's lines stay on screen.
	it.each([
		[0, 15000],
		[4, 15000],
		[10, 24000],
		[23, 43500],
		[40, 45000],
	])("%i lines -> %i ms", (lineCount, expectedMs) => {
		expect(whatsNewDurationMs(lineCount)).toBe(expectedMs);
	});
});
