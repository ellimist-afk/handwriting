import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { decideWhatsNew, RELEASE_NOTES, whatsNewDurationMs, whatsNewFragment } from "./WhatsNew";

const NOTES = { "1.3.10": ["undo works"], "1.3.11": ["more"] };

/** Alan's 1.5.0 list as he typed it, one entry per line of his text. */
const ALAN_1_5_0 = [
	"new feature release 1.5.0 :)",
	"attach ink to text",
	"lasso resize and rotate ink",
	"custom colors!",
	"shape snap resize and rotate + 5 more shapes (arrow, pentagon, hexagon, octagon, star)",
	"zoom v2.0",
	"",
	"fixes:",
	"more performance fixes",
	"pressure sens toggle now changes how new ink looks (no longer global toggle, pls message me if you want old behavior back)",
	"zoom with image embeds fix (ty woominKO)",
	"ink + typing fixes",
	"palm rejection small fix",
	"pdf dead input fix (linux users)",
	"side button setting works",
	"zoombar+toolbar polish and compatibility fix",
	"ui fixes",
];

describe("the 1.5.0 update shows Alan's one list", () => {
	const versionKeys = () =>
		Object.keys(JSON.parse(readFileSync(fileURLToPath(new URL("../../versions.json", import.meta.url)), "utf8")) as Record<string, string>);
	const below = (v: string) => {
		const [a, b] = v.split(".").map(Number);
		return a! < 1 || (a === 1 && b! < 5);
	};

	it("from 1.4.24: one group, 1.5.0, his list", () => {
		const d = decideWhatsNew("1.5.0", "1.4.24", false);
		expect(d.show).toBe(true);
		if (!d.show) return;
		expect(d.groups?.map((g) => g.version)).toEqual(["1.5.0"]);
		expect(d.groups?.[0]?.notes).toEqual(ALAN_1_5_0);
	});

	it("from no stored version, and from every release before 1.5.0: the 1.5.0 group is his list as typed", () => {
		// A line of his that an older list also holds ("ui fixes") stays in his list.
		const seens: (string | null)[] = [null, ...versionKeys().filter(below)];
		expect(seens.length).toBeGreaterThan(10);
		for (const seen of seens) {
			const d = decideWhatsNew("1.5.0", seen, false);
			expect(d.show, `seen ${seen}`).toBe(true);
			if (!d.show) return;
			const g = d.groups?.find((x) => x.version === "1.5.0");
			expect(g?.notes, `seen ${seen}`).toEqual(ALAN_1_5_0);
		}
	});

	it("from 1.4.23: the 1.4.24 list, then his 1.5.0 list", () => {
		const d = decideWhatsNew("1.5.0", "1.4.23", false);
		expect(d.show).toBe(true);
		if (!d.show) return;
		expect(d.groups?.map((g) => g.version)).toEqual(["1.4.24", "1.5.0"]);
		expect(d.groups?.[0]?.notes).toEqual(RELEASE_NOTES["1.4.24"]);
		expect(d.groups?.[1]?.notes).toEqual(ALAN_1_5_0);
	});
});

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

	it("an older build does not roll the recorded version back, so the newer notes are not shown again", () => {
		// The vault last showed 1.4.22; an older 1.4.21 build starts on it.
		const d = decideWhatsNew("1.4.21", "1.4.22", false, { "1.4.21": ["a"], "1.4.22": ["b"] });
		expect(d).toEqual({ show: false, record: "1.4.22" });
		// ... and when 1.4.22 comes back, it is the version already seen: quiet.
		expect(decideWhatsNew("1.4.22", d.record, false, { "1.4.22": ["b"] }).show).toBe(false);
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

	it("the landed release's list shows as written, even a line an older release also carried", () => {
		// The copy-forward workaround is still in the shipped notes: the pdf
		// headline appears under 1.4.0 and again under 1.4.2. Alan's list for
		// the version landed on is the contract, so 1.4.2 keeps its copy; only
		// older groups drop a line an earlier group already showed.
		const dupes = { "1.4.0": ["write on pdfs", "a"], "1.4.2": ["write on pdfs", "b"] };
		const d = decideWhatsNew("1.4.2", "1.3.11", false, dupes);
		expect(d).toMatchObject({ notes: ["write on pdfs", "a", "write on pdfs", "b"] });
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

	it("1.4.24 notes are Alan's nine lines, character for character", () => {
		// Alan wrote this text himself; the capitals, the smiley and the lower
		// case are his and are pinned as typed. Nine lines, in this order.
		expect(RELEASE_NOTES["1.4.24"]).toEqual([
			"BIG BIG latency and performance patch. hope you guys enjoy -alan :)",
			"many reading view ink fixes",
			"slides fixes",
			"pdf scroll fix",
			"keyboard popup fix",
			"export to pdf works",
			"faster touchpad zoom + fixes",
			"sync fixes",
			"android click to erase setting added",
		]);
		expect(RELEASE_NOTES["1.4.24"]).toHaveLength(9);
	});

	it("1.5.0 notes are Alan's one list, character for character, and 1.4.25 has no list of its own", () => {
		// Alan typed this list himself: his case, his spelling, his blank line, nothing added.
		expect(RELEASE_NOTES["1.5.0"]).toEqual(ALAN_1_5_0);
		expect(Object.keys(RELEASE_NOTES)).not.toContain("1.4.25");
	});

	it("1.5.1 notes are Alan's five lines, character for character", () => {
		// Alan typed these five lines himself: his case, his punctuation, nothing added.
		expect(RELEASE_NOTES["1.5.1"]).toEqual([
			"performance fix",
			"ink attach fix, attach range increased to two lines",
			"ink fixes",
			"save sync fix",
			"pdf highlight fix + pdf fixes",
		]);
	});

	it("1.3.10 -> 1.4.5 is five versions, but only the newest two show in full - this test used to pin all five (23 lines) at once, which is exactly the spam this feature exists to stop", () => {
		// Measured against the shipped RELEASE_NOTES: 1.3.10 -> 1.4.5 is five
		// versions (1.3.11, 1.4.1, 1.4.2, 1.4.4, 1.4.5). This test formerly
		// asserted all five rendered as separate groups totalling 23 lines;
		// that was the un-collapsed behaviour Alan flagged ("100 lines is
		// crazy wtf"). Now the three oldest fold into one summary line and
		// only 1.4.4 and 1.4.5 - the two most recent - render in full.
		const d = decideWhatsNew("1.4.5", "1.3.10", false);
		expect(d.show).toBe(true);
		if (!d.show) throw new Error("unreachable, asserted above");
		expect(d.groups.map((g) => g.version)).toEqual(["", "1.4.4", "1.4.5"]);
		expect(d.groups[0]?.collapsedCount).toBe(3);
		expect(d.groups[0]?.notes).toEqual(["and 3 earlier updates"]);
		// "bug fixes" was first seen in the now-collapsed 1.3.11, so the older
		// 1.4.4 group drops it. 1.4.5 is the version landed on, and its list
		// shows as written, "bug fixes" and "ui fixes" included.
		expect(d.groups[1]?.notes).not.toContain("bug fixes");
		expect(d.groups[2]?.notes).toEqual(RELEASE_NOTES["1.4.5"]);
		// 1 collapsed line + 1.4.4's 4 kept lines + 1.4.5's 6 lines as written.
		// Dedup against the whole 1.3.11..1.4.4 span (not just what's kept
		// visible) has already run on the older groups.
		expect(d.notes).toHaveLength(11);
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

	it("notes of an older release are labelled with their own version, not left under the current heading", () => {
		// 1.4.22 has no notes of its own; the newest notes at or below it are 1.4.20's.
		const d = decideWhatsNew("1.4.22", null, false, { "1.4.20": ["old"] });
		expect(d.show).toBe(true);
		if (!d.show) return;
		const frag = whatsNewFragment(d.version, d.notes, d.groups);
		expect(shape(frag)).toEqual({
			tag: "fragment",
			cls: undefined,
			text: undefined,
			children: [
				{ tag: "div", cls: "handwriting-whats-new-title", text: "Handwriting 1.4.22", children: [] },
				{ tag: "div", cls: "handwriting-whats-new-version", text: "1.4.20", children: [] },
				{
					tag: "ul",
					cls: "handwriting-whats-new-list",
					text: undefined,
					children: [{ tag: "li", cls: undefined, text: "old", children: [] }],
				},
			],
		});
	});

	it("the first of several groups is labelled too when it is not the heading's version", () => {
		const groups = [
			{ version: "1.4.19", notes: ["x"] },
			{ version: "1.4.21", notes: ["y"] },
		];
		const frag = shape(whatsNewFragment("1.4.22", ["x", "y"], groups)) as { children: { cls?: string; text?: string }[] };
		const labels = frag.children.filter((c) => c.cls === "handwriting-whats-new-version").map((c) => c.text);
		expect(labels).toEqual(["1.4.19", "1.4.21"]);
	});

	it("more than one group labels every version that is not the heading's own", () => {
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
					tag: "div",
					cls: "handwriting-whats-new-version",
					text: "1.3.11",
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

	it("his 1.5.0 list renders his blank line as one bullet-less gap row at his index, every other line a normal row", () => {
		// His seventh line (index 6) is blank: it renders as an empty row with the gap class (no bullet, no text).
		const GAP = 6;
		expect(ALAN_1_5_0[GAP]).toBe("");
		const expected = ALAN_1_5_0.map((line, i) =>
			i === GAP
				? { tag: "li", cls: "handwriting-whats-new-gap", text: undefined, children: [] }
				: { tag: "li", cls: undefined, text: line, children: [] }
		);
		const lastList = (frag: unknown) => {
			const lists = (shape(frag) as { children: { tag: string; children: unknown[] }[] }).children.filter((c) => c.tag === "ul");
			return lists[lists.length - 1]?.children;
		};
		// From 1.4.24 the toast is one list under the 1.5.0 heading; from 1.4.23 his list is the second group.
		for (const seen of ["1.4.24", "1.4.23"]) {
			const d = decideWhatsNew("1.5.0", seen, false);
			expect(d.show, `seen ${seen}`).toBe(true);
			if (!d.show) return;
			expect(lastList(whatsNewFragment(d.version, d.notes, d.groups)), `seen ${seen}`).toEqual(expected);
		}
	});
});

describe("whatsNewDurationMs", () => {
	// The duration table §5c specifies: 15000 for <= 4 lines, +1500/line past
	// that, capped at 45000. 23 and 40 are arbitrary sample line counts
	// exercising the middle and the cap, not tied to any one release's notes.
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

describe("collapsing groups older than the two most recent", () => {
	// Same DOM stand-in as the whatsNewFragment suite above: whatsNewFragment
	// runs unmodified against a fake with the same call shape, since this
	// suite has no real `document` (vitest.config.ts sets no `environment`).
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

	beforeEach(() => {
		(globalThis as unknown as { createFragment: () => FakeEl }).createFragment = () =>
			new FakeEl("fragment");
	});

	/** Every rendered <li>, wherever it sits in the tree. */
	function listItems(el: FakeEl): FakeEl[] {
		return el.children.flatMap((c) => (c.tag === "li" ? [c] : listItems(c)));
	}

	/** Every rendered collapsed-notice div, wherever it sits in the tree. */
	function collapsedDivs(el: FakeEl): FakeEl[] {
		return el.children.flatMap((c) =>
			c.tag === "div" && c.cls === "handwriting-whats-new-collapsed" ? [c] : collapsedDivs(c)
		);
	}

	it("from 1.3.11 to 1.4.12: two groups render in full, the collapsed line appears exactly once, and the rendered total is far below the 57 lines this same scenario shows with collapsing turned off", () => {
		const d = decideWhatsNew("1.4.12", "1.3.11", false);
		expect(d.show).toBe(true);
		if (!d.show) throw new Error("unreachable, asserted above");
		expect(d.groups.map((g) => g.version)).toEqual(["", "1.4.11", "1.4.12"]);
		const frag = whatsNewFragment(d.version, d.notes, d.groups) as unknown as FakeEl;
		const collapsed = collapsedDivs(frag);
		expect(collapsed).toHaveLength(1);
		const renderedLineCount = listItems(frag).length + collapsed.length;
		// DERIVED FROM THE NOTES, NOT TYPED IN. This asserted a hardcoded 21 -
		// one collapsed line plus the two kept groups as they read that day -
		// and it went red the moment the owner rewrote the 1.4.12 entry in his
		// own words. That is not a defect and must never be answered by padding
		// his text back to length. The subject of this file is the COLLAPSE, so
		// what it asserts is the collapse: the two newest groups render in full
		// (their own lines, however many he writes) and EVERYTHING OLDER is one
		// line between them. A changelog edit moves this number; a broken
		// collapse moves it by a group.
		// From the GROUPS, not from RELEASE_NOTES: `notesSince` deduplicates
		// across the whole set, so a line the owner repeats from an older
		// version keeps its oldest occurrence and drops out of the newer group.
		// Summing the arrays instead would count those twice and go red for a
		// changelog that is perfectly correct.
		const kept = d.groups.filter((g) => g.version !== "").reduce((n, g) => n + g.notes.length, 0);
		expect(renderedLineCount).toBe(kept + 1);
	});

	it("from 1.4.11 to 1.4.12 (one group): no collapsed line anywhere in the output", () => {
		const d = decideWhatsNew("1.4.12", "1.4.11", false);
		expect(d.show).toBe(true);
		if (!d.show) throw new Error("unreachable, asserted above");
		expect(d.groups).toHaveLength(1);
		const frag = whatsNewFragment(d.version, d.notes, d.groups) as unknown as FakeEl;
		expect(collapsedDivs(frag)).toHaveLength(0);
	});

	it("renders the 1.4.14 hotfix note verbatim", () => {
		const d = decideWhatsNew("1.4.14", "1.4.13", false);
		expect(d.show).toBe(true);
		if (!d.show) throw new Error("unreachable, asserted above");
		const frag = whatsNewFragment(d.version, d.notes, d.groups) as unknown as FakeEl;
		expect(listItems(frag).map((item) => item.text)).toEqual(["ink thickness hotfix"]);
	});

	it("renders the two 1.4.15 release-note lines verbatim and in order", () => {
		const d = decideWhatsNew("1.4.15", "1.4.14", false);
		expect(d.show).toBe(true);
		if (!d.show) throw new Error("unreachable, asserted above");
		const frag = whatsNewFragment(d.version, d.notes, d.groups) as unknown as FakeEl;
		expect(listItems(frag).map((item) => item.text)).toEqual([
			"properly done ink pressure sens patch",
			"bug fixes",
		]);
	});

	it("renders the six 1.4.16 release-note lines verbatim and in order", () => {
		const d = decideWhatsNew("1.4.16", "1.4.15", false);
		expect(d.show).toBe(true);
		if (!d.show) throw new Error("unreachable, asserted above");
		const frag = whatsNewFragment(d.version, d.notes, d.groups) as unknown as FakeEl;
		expect(listItems(frag).map((item) => item.text)).toEqual([
			"per note lined/dotted/grid paper (hint: the ... button in the top right corner of the note -alan)",
			"ghost shape snapping",
			"toolbar settings changes",
			"reading mode ink bug fix",
			"notification bug fix",
		"zoom and fit to ink",
		]);
	});

	it("renders the thirteen 1.4.13 release-note lines verbatim and in order", () => {
		const d = decideWhatsNew("1.4.13", "1.4.12", false);
		expect(d.show).toBe(true);
		if (!d.show) throw new Error("unreachable, asserted above");
		const frag = whatsNewFragment(d.version, d.notes, d.groups) as unknown as FakeEl;
		// VERBATIM MATTERS MOST ON THE THIRD LINE. It is Alan's own signed
		// message, and its lowercase, its missing trailing period and the
		// spacing of `-alan` are all his. This assertion is what stops a later
		// tidy-up "correcting" any of them.
		expect(listItems(frag).map((item) => item.text)).toEqual([
			"slides added!!",
			"data safety 2.0",
			"ink pressure changes (let me know how it feels -alan)",
			"pdf ink color setting added",
			"cursor fixes",
			"lasso fixes",
			"undo fix",
			"toolbar fixes",
			"new toolbar anchors (drag toolbar to new locations!)",
			"notification spam fix",
			"dev mode",
			"boox/ipad hints",
			"bug fixes",
		]);
	});

	it("from 1.4.10 to 1.4.12 (two groups): no collapsed line, both groups render in full", () => {
		const d = decideWhatsNew("1.4.12", "1.4.10", false);
		expect(d.show).toBe(true);
		if (!d.show) throw new Error("unreachable, asserted above");
		expect(d.groups.map((g) => g.version)).toEqual(["1.4.11", "1.4.12"]);
		const frag = whatsNewFragment(d.version, d.notes, d.groups) as unknown as FakeEl;
		expect(collapsedDivs(frag)).toHaveLength(0);
		expect(listItems(frag)).toHaveLength(d.notes.length);
	});

	it("the collapsed line names the exact number of older groups, no more and no less", () => {
		// Five made-up versions, one note each, none of them repeating - a
		// fixture immune to Alan's in-flight rewrite of 1.4.12's real notes.
		const notes = {
			"2.0.0": ["a"],
			"2.0.1": ["b"],
			"2.0.2": ["c"],
			"2.0.3": ["d"],
			"2.0.4": ["e"],
		};
		const d = decideWhatsNew("2.0.4", "1.9.9", false, notes);
		expect(d.show).toBe(true);
		if (!d.show) throw new Error("unreachable, asserted above");
		// Five groups -> newest two (2.0.3, 2.0.4) in full, three collapsed.
		expect(d.groups.map((g) => g.version)).toEqual(["", "2.0.3", "2.0.4"]);
		const frag = whatsNewFragment(d.version, d.notes, d.groups) as unknown as FakeEl;
		const collapsed = collapsedDivs(frag);
		expect(collapsed).toHaveLength(1);
		expect(collapsed[0]?.text).toBe("and 3 earlier updates");
	});

	it("whatsNewDurationMs is fed the reduced, post-collapse count - not the 78 lines every version between 1.3.11 and 1.4.12 would total uncollapsed", () => {
		const d = decideWhatsNew("1.4.12", "1.3.11", false);
		expect(d.show).toBe(true);
		if (!d.show) throw new Error("unreachable, asserted above");
		const reducedDuration = whatsNewDurationMs(d.notes.length);
		// The PROPERTY, not a frozen millisecond count: the duration is fed the
		// post-collapse total, so it is what that count asks for and less than
		// the uncollapsed set would ask for. The literal 40500 here was the
		// answer for one particular changelog and went red the moment the owner
		// rewrote his own entry - which is not a defect, and must not be
		// answered by editing his text.
		// `d.notes` is the POST-COLLAPSE set, so the only real claim here is
		// that it is shorter than the uncollapsed one and buys a shorter read.
		// (Comparing the duration with itself would assert nothing at all.)
		const rawTotal = Object.values(RELEASE_NOTES).reduce((n, v) => n + v.length, 0);
		expect(d.notes.length, "the collapse kept every line").toBeLessThan(rawTotal);
		expect(reducedDuration).toBeLessThan(whatsNewDurationMs(rawTotal));
	});
});

describe("release version files", () => {
	// The release is 1.5.1 only when every file Obsidian and npm read says so.
	// The store reads manifest.json and versions.json; versions.json maps each
	// release to the oldest Obsidian it runs on, and 1.5.1 asks for no newer
	// Obsidian than 1.5.0 did.
	const json = (path: string) =>
		JSON.parse(readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), "utf8")) as Record<string, unknown>;

	it("manifest.json, package.json and package-lock.json all say 1.5.1", () => {
		expect(json("manifest.json").version, "manifest.json").toBe("1.5.1");
		expect(json("package.json").version, "package.json").toBe("1.5.1");
		const lock = json("package-lock.json") as { version: string; packages: Record<string, { version?: string }> };
		expect(lock.version, "package-lock.json top").toBe("1.5.1");
		expect(lock.packages[""]?.version, "package-lock.json root package").toBe("1.5.1");
	});

	it("versions.json lists 1.5.1 with the same oldest Obsidian as 1.5.0, and the manifest agrees", () => {
		const versions = json("versions.json");
		expect(versions["1.5.1"], "versions.json 1.5.1").toBe(versions["1.5.0"]);
		expect(versions["1.5.1"], "versions.json 1.5.1 value").toBe("1.12.3");
		expect(json("manifest.json").minAppVersion, "manifest.json minAppVersion").toBe(versions["1.5.1"]);
	});
});
