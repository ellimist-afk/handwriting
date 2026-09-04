/**
 * Every callback deferred to `onLayoutReady` must check `unloaded` first.
 *
 * `onLayoutReady` is not cancellable and is not a registered event, so
 * Obsidian's teardown does not take these back: a plugin disabled between
 * onload and the layout settling still gets its callbacks, into a vault that
 * no longer has the plugin. `main.ts`'s `unloaded` field exists for exactly
 * that and its own comment says it is "read by every callback deferred to
 * `onLayoutReady`" - which was true of three of the four registrations and
 * not of the fourth, `maybeSwapView`, which swapped a note into a canvas
 * view on behalf of a plugin that had already unloaded.
 *
 * Read as source TEXT rather than by driving the plugin, for the same reason
 * StripPenChrome.test.ts does: what is worth pinning is not what any one
 * callback does, it is that the check is present at every deferral site. A
 * fifth registration added later without the guard is the shape of the bug
 * coming back, and only a source scan sees it. `src/main.ts` is imported by
 * no test file at all (1.4.7-design.md C2), so a scan is also the only thing
 * available here today.
 *
 * `?raw` (raw-imports.d.ts) rather than `node:fs`: this repo has no
 * `@types/node`, so a node import fails `tsc -noEmit` outright.
 *
 * IT COUNTS CODE, NOT THE FILE. `main.ts` read as text is a document, and its
 * prose discusses `onLayoutReady` and the `unloaded` field at length - the
 * field's own doc comment is quoted in the paragraph above. Every number below
 * is now taken from `codeOnly` (src/CodeOnly.ts), the shared stripper that
 * `StripPenChrome.test.ts` and `InkSurfaceRules.test.ts` use, imported rather
 * than copied.
 *
 * WHAT THAT ACTUALLY CLOSES, and it is NOT what it was expected to close.
 * The suspicion put to this file was that a commented-out example of the
 * guarded form could make up the count for a real registration that had lost
 * its guard. Tried, and it does not: every match of the guarded regex CONTAINS
 * a `DEFER` occurrence, so a comment spelling the guarded form adds one to
 * both sides of the second assertion's equality and moves nothing. Run on this
 * branch with the swap-view registration stripped of its guard and a block
 * comment supplying a guarded copy: both assertions went RED (guarded 4,
 * deferrals 5). The equality is self-balancing against comments in that
 * direction, and that is worth stating so nobody re-derives it.
 *
 * The hole that IS real runs the other way, and it was demonstrated green:
 * comment out an entire registration - the `updateStatusBarClass` one, four
 * lines - and every number here is unchanged, because commenting deletes a
 * registration from the plugin without deleting a character from the file.
 * All three counts stayed at 4, this file passed, and so did the whole suite
 * (1835 + 1 expected fail). The pinned `4` then describes a document in which
 * three registrations exist. Counted on code, the same edit takes the count to
 * 3 and this file fails.
 *
 * There is a loud direction too, closed by the same call: a doc comment that
 * spells the deferral form while explaining the rule - the obvious thing to
 * write next to `unloaded` - raises the raw count off 4 and fails a guard that
 * has nothing wrong with it.
 *
 * Nothing here reads raw text. Every assertion asks "how many deferrals does
 * this plugin register", none asks "is this reason documented", so there is no
 * assertion of the second kind to strand. Counting code can only LOWER a
 * count, so no real registration stops being seen; what stops being seen is a
 * registration that was only ever a sentence.
 */

import { describe, expect, it } from "vitest";
import mainSrc from "./main.ts?raw";
import { codeOnly } from "./CodeOnly";

/** The deferral site, verbatim. Every registration in main.ts uses this form. */
const DEFER = "this.app.workspace.onLayoutReady(() => {";

/** `main.ts`'s registrations, without `main.ts`'s prose about them. */
const mainCode = codeOnly(mainSrc);

function occurrences(src: string, needle: string): number {
	return src.split(needle).length - 1;
}

/** The guarded-deferral count, as a pure function so the fixtures can attack it. */
function guardedDeferrals(src: string): number {
	// \r?\n rather than a literal newline: the tree is CRLF.
	return (
		codeOnly(src).match(
			/this\.app\.workspace\.onLayoutReady\(\(\) => \{\r?\n\s*if \(this\.unloaded\) return;/g
		)?.length ?? 0
	);
}

describe("deferred onLayoutReady callbacks check unloaded", () => {
	it("main.ts still registers its callbacks in the one recognised form", () => {
		// The scan below is only as good as this: a registration written some
		// other way (a named function, a multi-line arg list) would slip past
		// it silently, so the count is pinned and a new shape fails here
		// rather than passing unnoticed in the assertion that follows.
		//
		// Counted on code, so that a registration commented out is a
		// registration gone - which is what it is - rather than a registration
		// this guard keeps counting.
		expect(occurrences(mainCode, "onLayoutReady(")).toBe(occurrences(mainCode, DEFER));
		expect(occurrences(mainCode, DEFER)).toBe(4);
	});

	it("every deferred callback opens with the unloaded guard", () => {
		expect(guardedDeferrals(mainSrc)).toBe(occurrences(mainCode, DEFER));
	});
});

/**
 * Fixtures over the counters themselves, so a green run above is evidence
 * rather than a coincidence. They also pin the finding: a comment cannot pad
 * the guarded side, and a comment CAN hide a whole registration until the
 * counting moves onto code.
 */
describe("the counters read registrations, not sentences", () => {
	const SITE = "\t\tthis.app.workspace.onLayoutReady(() => {\r\n\t\t\tif (this.unloaded) return;\r\n\t\t\tdoIt();\r\n\t\t});\r\n";
	const UNGUARDED = "\t\tthis.app.workspace.onLayoutReady(() => {\r\n\t\t\tdoIt();\r\n\t\t});\r\n";

	it("counts a real registration, guarded", () => {
		// Anti-vacuity: a counter that found nothing would pass every negative
		// below while proving the reverse of what they claim.
		expect(occurrences(codeOnly(SITE), DEFER)).toBe(1);
		expect(guardedDeferrals(SITE)).toBe(1);
	});

	it("counts a real registration that lost its guard, and does not count it as guarded", () => {
		expect(occurrences(codeOnly(UNGUARDED), DEFER)).toBe(1);
		expect(guardedDeferrals(UNGUARDED)).toBe(0);
	});

	it("does NOT count a registration that has been commented out", () => {
		// THE DEFEAT, verbatim: this edit left all three counts at 4 and the
		// whole suite green while main.ts registered three callbacks.
		const retired = `\t\t/*\r\n${SITE}\t\t*/\r\n`;
		expect(occurrences(codeOnly(retired), DEFER)).toBe(0);
		expect(guardedDeferrals(retired)).toBe(0);
	});

	it("does NOT let prose that spells the guarded form pad either side", () => {
		// The direction the suspicion was aimed at. It never could pad the
		// guarded side - a guarded match contains a deferral - but it did
		// inflate both counts off the pinned 4, which is a false alarm.
		const explained = `\t\t/*\r\n\t\t * Every deferral takes this shape:\r\n${SITE}\t\t */\r\n${UNGUARDED}`;
		expect(occurrences(codeOnly(explained), DEFER)).toBe(1);
		expect(guardedDeferrals(explained)).toBe(0);
	});
});
