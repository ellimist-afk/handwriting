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
 */

import { describe, expect, it } from "vitest";
import mainSrc from "./main.ts?raw";

/** The deferral site, verbatim. Every registration in main.ts uses this form. */
const DEFER = "this.app.workspace.onLayoutReady(() => {";

function occurrences(src: string, needle: string): number {
	return src.split(needle).length - 1;
}

describe("deferred onLayoutReady callbacks check unloaded", () => {
	it("main.ts still registers its callbacks in the one recognised form", () => {
		// The scan below is only as good as this: a registration written some
		// other way (a named function, a multi-line arg list) would slip past
		// it silently, so the count is pinned and a new shape fails here
		// rather than passing unnoticed in the assertion that follows.
		expect(occurrences(mainSrc, "onLayoutReady(")).toBe(occurrences(mainSrc, DEFER));
		expect(occurrences(mainSrc, DEFER)).toBe(4);
	});

	it("every deferred callback opens with the unloaded guard", () => {
		// \r?\n rather than a literal newline: the tree is CRLF.
		const guarded =
			mainSrc.match(
				/this\.app\.workspace\.onLayoutReady\(\(\) => \{\r?\n\s*if \(this\.unloaded\) return;/g
			)?.length ?? 0;
		expect(guarded).toBe(occurrences(mainSrc, DEFER));
	});
});
