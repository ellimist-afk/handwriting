/**
 * The quick-pen toast has to come down with the plugin too.
 *
 * THE DEFECT. `ownedPresetNotice` (ink/InkPresetHost.ts) owns a Notice for
 * the four quick-pen chips and their hotkeys, and it registered no hider -
 * main.ts's `ownedNoticeHiders` was module-private, so `hideOwnedNotices()`
 * on unload could not reach it. Tap a chip, then disable or reload the plugin
 * inside the toast's timeout, and the toast stays on screen naming the state
 * of a plugin that is no longer running, with nothing left to dismiss it.
 * PenToggleNotice.test.ts pins that unload reaches the SIX TOGGLES; this file
 * pins that the registry it walks is now shared, and that the preset slot
 * joins it.
 *
 * WHY PART OF THIS IS SOURCE TEXT, for the reason PenToggleNotice.test.ts
 * spells out at length: `test/obsidian-stub.ts`'s `Notice` is
 * `export class Notice {}`, an empty class with no `messageEl` and no `hide`,
 * so there is no live Notice in this repo to put down and a hider that ran
 * here would have nothing to probe. What IS executable is the registry
 * itself - a plain array of callbacks with no Obsidian in it at all - and
 * that half is tested by running it, below.
 *
 * `codeOnly` (src/CodeOnly.ts) blanks comments before anything here counts a
 * needle, so the prose above cannot satisfy - or defeat - a count.
 */
import { describe, expect, it } from "vitest";
import mainSrc from "./main.ts?raw";
import hostSrc from "./ink/InkPresetHost.ts?raw";
import { codeOnly } from "./CodeOnly";
import { ownedNoticeHiders } from "./OwnedNotices";

const mainCode = codeOnly(mainSrc);
const hostCode = codeOnly(hostSrc);

function occurrences(src: string, needle: string): number {
	return src.split(needle).length - 1;
}

describe("the owned-notice registry is one array, walked once", () => {
	it("runs every registered hider, in creation order, and survives being walked twice", () => {
		// The registry is real module state shared with the plugin, so this
		// borrows it rather than replacing it: push, walk, and take the two
		// entries back off, leaving whatever production registered untouched.
		const before = ownedNoticeHiders.length;
		const order: string[] = [];
		ownedNoticeHiders.push(() => order.push("first"));
		ownedNoticeHiders.push(() => order.push("second"));
		try {
			for (const hide of ownedNoticeHiders.slice(before)) hide();
			expect(order).toEqual(["first", "second"]);
			// Hiding a slot that is already down is a no-op by construction -
			// each real `clear` probes `messageEl?.isConnected` first - so a
			// second walk must not be a special case anywhere.
			for (const hide of ownedNoticeHiders.slice(before)) hide();
			expect(order).toEqual(["first", "second", "first", "second"]);
		} finally {
			ownedNoticeHiders.length = before;
		}
	});
});

describe("hide-all reaches the quick-pen preset notice, not only the six toggles", () => {
	it("main.ts declares no private hider array of its own any more", () => {
		// The whole of the defect: a second array, or a re-declared one here,
		// is a slot the other file's factory can never join.
		expect(occurrences(mainCode, "const ownedNoticeHiders")).toBe(0);
		expect(occurrences(mainCode, 'from "./OwnedNotices"')).toBe(1);
	});

	it("the preset factory registers its clear into that same shared array", () => {
		expect(occurrences(hostCode, 'from "../OwnedNotices"')).toBe(1);
		expect(occurrences(hostCode, "ownedNoticeHiders.push(")).toBe(1);
	});

	it("the preset slot's rewrite and its unload hide are the same act, written once", () => {
		// Two copies of the hide-if-showing rule are two things that can
		// drift apart - the same reason main.ts's factory has one `clear`.
		expect(occurrences(hostCode, "notice?.messageEl?.isConnected")).toBe(1);
		expect(occurrences(hostCode, "clear();")).toBe(1);
	});

	it("and does not spend one of the six toggle slots to do it", () => {
		// PenToggleNotice.test.ts owns this count; it is re-asserted here
		// because the fix above is exactly the kind of change that would be
		// tempted to add a seventh.
		expect(occurrences(mainCode, "= ownedNotice();")).toBe(6);
		expect(occurrences(hostCode, "= ownedNotice();")).toBe(0);
	});
});
