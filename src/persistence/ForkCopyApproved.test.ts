import { describe, expect, it } from "vitest";
import { codeOnly } from "../CodeOnly";
import { FORK_COPY_DEFAULTS, FORK_COPY_PLACEHOLDER } from "./ForkResolution";
import { INK_FILE_MISSING } from "../inline/InlineInkStore";

/**
 * THE GATE THAT WAS PROMISED IN A COMMENT AND DID NOT EXIST.
 *
 * `FORK_COPY_PLACEHOLDER`'s header used to say the marker existed "so an
 * unapproved string cannot reach a release build unnoticed". NOTHING ENFORCED
 * THAT. No test asserted the marker, the build config did not scan for it, and
 * `ForkResolution.test.ts` pins behaviour and never touches copy. The marker
 * was a convention read by people, not a gate - reported by whoever wrote
 * the docstring, against their own work.
 *
 * The consequence was not hypothetical. Slot 6 was to keep its drafted wording
 * "as-is", and nothing would have stopped the literal text
 * "[COPY" + " TBD] cannot be read" shipping to a user on that reading. Alan
 * ruled it explicitly instead: wording kept, marker stripped like the rest.
 *
 * So this file is that gate, and it guards TWO different things:
 *
 *   1. THE TEN STRINGS ARE ALAN'S, EXACTLY. Pinned verbatim, the way
 *      `CommandPaletteNames.test.ts` pins his palette renames, and for the
 *      same reason: a command's copy is never read by its own callback, so
 *      NOTHING BEHAVIOURAL FAILS if wording drifts or a helpful builder
 *      "improves" it. A red here means someone changed approved copy, and the
 *      fix is to take it back to Alan, not to update this list.
 *
 *   2. NO SHIPPED SOURCE FILE CARRIES THE MARKER AT ALL. Not just this object -
 *      the whole tree, so the next placeholder anywhere is caught by the same
 *      rule rather than needing its own test.
 *
 * THE AUTHORITY FOR EVERY STRING BELOW is the recorded decision, not this
 * file: "2026-09-09
 * 10:04 CDT ... ALL TEN FORK-SCREEN STRINGS ARE APPROVED". He wrote them live
 * from a rendered presentation of the screen.
 *
 * WHY `codeOnly`: it blanks COMMENTS and deliberately leaves STRING LITERALS
 * alone, which is exactly the shape needed here - prose discussing the marker
 * (this docstring included) must not trip the sweep, while a marker inside a
 * shipped string must.
 *
 * WHY THE NEEDLE IS BUILT BY CONCATENATION: written whole it would appear in
 * this file's own source, and a sweep that matches itself is a sweep that can
 * never go green. Test files are excluded from the sweep as well, since they
 * do not ship - belt and braces, because either alone would be enough and
 * neither alone is obvious to the next reader.
 */

/** The marker, assembled so that this file's source never contains it. */
const MARKER = "[COPY" + " TBD]";

const ALL_TS = import.meta.glob("/src/**/*.ts", {
	query: "?raw",
	eager: true,
	import: "default",
}) as Record<string, string>;

/** Everything that reaches a build: `src` minus the test files. */
const SHIPPED = Object.entries(ALL_TS).filter(([path]) => !path.endsWith(".test.ts"));

/**
 * Alan's ten, verbatim, keyed the way the object is.
 *
 * `commandName` carries NO "Handwriting:" prefix: Obsidian prefixes the plugin
 * name itself, so one here would read "Handwriting: Handwriting: ...", and no
 * other command in this plugin carries one. He removed the word "note" himself
 * on learning the screen lists PDF forks too.
 *
 * `mine` and `theirs` are NOT swapped and must not be. It was relayed that
 * they read backwards because the side labelled "The other device" is the one
 * on screen; they do not. "PALADIN IS THE OTHER DEVICE" - he reads this on
 * Orion.
 */
const APPROVED: [key: keyof typeof FORK_COPY_PLACEHOLDER, text: string][] = [
	["commandName", "fix ink de-sync"],
	["empty", "no ink de-sync to fix"],
	// TRAILING PERIOD, restored by Alan on 2026-09-09 ("put a period back at
	// end") after he had removed it earlier the same day. Both entries are on
	// the record; the block below carries the whole arc.
	["headline", "This note was edited on two devices and both versions were kept."],
	["mine", "This device"],
	["theirs", "The other device"],
	["unreadable", "cannot be read"],
	["keepMine", "Keep this device's ink"],
	["takeTheirs", "Take the other"],
	["keepBoth", "Keep both"],
	["refused", "Could not keep this device's ink"],
];

describe("the fork screen ships Alan's approved words and nothing else", () => {
	it.each(APPROVED)("%s is his, verbatim", (key, text) => {
		expect(FORK_COPY_PLACEHOLDER[key]).toBe(text);
	});

	// The list above must cover the object, or a new string could be added
	// without approval and every case here would still pass.
	it("covers every key on the object, so a new string cannot be added unpinned", () => {
		expect(Object.keys(FORK_COPY_PLACEHOLDER).sort()).toEqual(APPROVED.map(([k]) => k).sort());
	});

	it("carries no marker on any of them", () => {
		for (const [key, value] of Object.entries(FORK_COPY_PLACEHOLDER)) {
			expect(value, `${key} still carries the unapproved-copy marker`).not.toContain(MARKER);
		}
	});
});

/**
 * THE SECOND LIST: DEFAULTS, NOT HIS. Words the screen needs where his ten
 * cannot be true or do not fit - a pair this device cannot place, a refused
 * take-the-other, a note whose ink file is missing. He was asked for each on
 * 2026-10-04 and had no words, so these were picked for him, shown to him on
 * screen, and are his to change on sight. Pinned here so a change is still a
 * visible decision, and kept apart from his ten so nobody reads them as his.
 */
const DEFAULTS: [key: keyof typeof FORK_COPY_DEFAULTS, text: string][] = [
	["takeTheirsRefused", "Could not take the other device's ink"],
	["versionA", "Version A"],
	["versionB", "Version B"],
	["keepVersionA", "Keep Version A"],
	["keepVersionB", "Keep Version B"],
	["keepVersionARefused", "Could not keep Version A"],
	["keepVersionBRefused", "Could not keep Version B"],
];

describe("the fork screen's defaults, which are not his words", () => {
	it.each(DEFAULTS)("%s is the default picked for him, verbatim", (key, text) => {
		expect(FORK_COPY_DEFAULTS[key]).toBe(text);
	});

	it("covers every key on the defaults object", () => {
		expect(Object.keys(FORK_COPY_DEFAULTS).sort()).toEqual(DEFAULTS.map(([k]) => k).sort());
	});

	it("the missing-ink-file notice is the default picked for him, verbatim", () => {
		expect(INK_FILE_MISSING).toBe(
			"this note's ink file is missing.\n\nyour ink is still on screen. your next stroke saves it again."
		);
	});

	it("carries no marker on any of them", () => {
		for (const [key, value] of [...Object.entries(FORK_COPY_DEFAULTS), ["INK_FILE_MISSING", INK_FILE_MISSING]]) {
			expect(value, `${key} still carries the unapproved-copy marker`).not.toContain(MARKER);
		}
	});
});

describe("no shipped source file carries the unapproved-copy marker", () => {
	// THE MATCHER PROVES ITSELF FIRST. An empty glob and a clean tree look
	// identical from the assertion below, and "all clear" from a sweep that
	// swept nothing is the failure this control exists to make impossible.
	it("the sweep actually reads the tree", () => {
		expect(SHIPPED.length).toBeGreaterThan(50);
		const paths = SHIPPED.map(([p]) => p);
		expect(paths).toContain("/src/persistence/ForkResolution.ts");
		expect(paths).toContain("/src/main.ts");
		// And it is reading contents, not just filenames.
		const fork = SHIPPED.find(([p]) => p === "/src/persistence/ForkResolution.ts")![1];
		expect(fork).toContain("FORK_COPY_PLACEHOLDER");
	});

	// And that the needle is findable at all: if `MARKER` were mistyped, the
	// sweep below would pass over a tree full of markers.
	it("the needle matches a string that does contain it", () => {
		expect(`${MARKER} something`).toContain(MARKER);
	});

	it("finds it in none of them", () => {
		const offenders = SHIPPED.filter(([, src]) => codeOnly(src).includes(MARKER)).map(([p]) => p);
		expect(offenders, `unapproved copy would ship in: ${offenders.join(", ")}`).toEqual([]);
	});
});

/**
 * THE TRAILING PERIOD, WHICH THE CASES ABOVE CANNOT CATCH.
 *
 * The verbatim pins red if a string is reworded, and the marker sweep reds if a
 * placeholder ships. NEITHER SEES A PERIOD COMING BACK anywhere else in the
 * tree: the marker is still absent, and a second copy of the sentence in some
 * other file is not the object the verbatim pins read.
 *
 * `headline` IS THE ONLY ONE OF THE TEN THAT CARRIES A TRAILING PERIOD, and
 * its history runs in both directions - which is why it is written out rather
 * than left as a state.
 *
 * It shipped with one; that period was never Alan's. He removed it on
 * 2026-09-09 ("get the periods OUT", "GET EM OUT", 17:09 CDT) and RESTORED it
 * the same day ("ehhhhhhhhhhhhhhhh we hsould be consistent, put a period back
 * at end", 17:14 CDT) for consistency with other messages on the same command
 * that always had one. Authority is that 17:14 entry, which supersedes 17:09.
 *
 * THIS FILE MUST NOT CLAIM "EVERY APPROVED STRING ENDS IN A PERIOD". It is
 * false: the ink-trash restore line is ruled BARE, deliberately, because it
 * ends in a file path where a period reads as part of the path (17:21 CDT,
 * "leave that last one bare"). That string does not live in this object and is
 * pinned separately, by name, on the branch that owns it. The punctuated set
 * and the bare one are two rules, not one.
 */
describe("the fork headline carries its trailing period", () => {
	/**
	 * The needle comes from the APPROVED TABLE, not from the live object, and
	 * the difference is not cosmetic in either direction.
	 *
	 * Deriving it from `FORK_COPY_PLACEHOLDER.headline` makes it MOVE WITH THE
	 * DEFECT: when this guard ran the other way, a needle built from the live
	 * constant became the sentence-plus-two-periods the moment the period came
	 * back - which is nowhere - so the sweep stayed green in exactly the state
	 * it existed to catch. Measured; only the red control found it. A literal
	 * table cannot drift, and that holds whichever way the rule points.
	 */
	const PUNCTUATED = APPROVED.find(([key]) => key === "headline")![1];
	const BARE = PUNCTUATED.slice(0, -1);

	it("the table itself is the punctuated form", () => {
		expect(PUNCTUATED.endsWith(".")).toBe(true);
		expect(BARE.endsWith(".")).toBe(false);
	});

	it("the object carries it", () => {
		expect(FORK_COPY_PLACEHOLDER.headline.endsWith(".")).toBe(true);
	});

	// The matcher proves itself before any presence or absence is believed.
	it("the needles match text that contains them", () => {
		expect(`x ${PUNCTUATED} y`).toContain(PUNCTUATED);
		expect(`x ${BARE}" y`).toContain(`${BARE}"`);
	});

	it("ships punctuated, in a real file", () => {
		const carriers = SHIPPED.filter(([, src]) => codeOnly(src).includes(PUNCTUATED)).map(([p]) => p);
		expect(carriers, "the punctuated headline is in no shipped file").not.toEqual([]);
	});

	/**
	 * And the bare form does not ship. Checked as the sentence followed by a
	 * CLOSING QUOTE, not by plain absence: the punctuated string contains the
	 * bare one as a prefix, so `!includes(BARE)` could never pass and would be
	 * a guard that only ever reported failure.
	 */
	it("and the bare form ships nowhere", () => {
		const offenders = SHIPPED.filter(([, src]) => codeOnly(src).includes(`${BARE}"`)).map(([p]) => p);
		expect(offenders, `the trailing period is missing in: ${offenders.join(", ")}`).toEqual([]);
	});
});
