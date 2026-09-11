/**
 * Alan, hardware report: "when spamming the toast for keyboard doesnt have
 * the current state last". The pen-off toggle (the `keyboard` strip button,
 * MobileTools.ts, and the palette command beside it - `pen-ink-toggle` then,
 * `Pen on / off` since 1.4.12 folded the two into one) showed a fresh Notice on
 * every press. Obsidian Notices queue and each runs its own timeout, so
 * pressing the toggle five times quickly left five toasts on screen that
 * expire in the order they were created - the OLDEST one is the last still
 * standing, naming a state the pen has not been in for four presses. The
 * same defect shape lives in `mouse-ink-toggle` too - a hotkey, not a strip
 * button, but one a hotkey spams faster than a finger can.
 *
 * The fix (main.ts) is `ownedNotice()`: a toggle owns exactly one Notice and
 * rewrites it - hides the still-showing one and constructs a fresh one with
 * the current message - rather than stacking a new one per press. Applied to
 * the pen-input switch and, same shape, to five other rapid-fire toggles whose
 * Notice names an on/off state: the strip's eraser, lasso, insert space and
 * pan, and the hotkey-only `mouse-ink-toggle`. Each gets its OWN slot -
 * pressing Mouse and then Pen must read as two different pieces of news, not
 * one toggle's stale repeat of the other.
 *
 * WHY THIS IS A SOURCE-TEXT TEST, not one that presses the toggle and reads
 * the DOM. Every one of these is an `addCommand` callback, which needs a
 * real plugin `this` (settings, live editor state) to run at all -
 * DeferredUnloadGuard.test.ts and TipModeCommand.test.ts hit the same wall
 * before this file did. On top of that, `test/obsidian-stub.ts` - the only
 * `Notice` this repo's test run can construct - is `export class Notice {}`,
 * an empty class with no `messageEl`, no `setMessage`, no `hide`, so even a
 * callback that could run would be probing properties the stub does not
 * have (exactly the case `ownedNotice`'s optional chaining is now written to
 * survive rather than throw on - see its doc comment in main.ts). So this
 * pins the two things that do not need any of that: `penToggleNoticeText`, a
 * pure state -> message function with no Notice and no DOM in it at all,
 * called directly; and, as source text (the same technique
 * StripPenChrome.test.ts and DeferredUnloadGuard.test.ts use, for the same
 * reason - what is worth pinning is WHERE the Notice gets built, not
 * behaviour this repo cannot execute), that every toggle's path holds to
 * `ownedNotice()`'s one rewrite-or-recreate rule instead of a `new Notice(`
 * of its own.
 *
 * `codeOnly` (src/CodeOnly.ts) blanks comments before anything here counts a
 * needle, so a comment mentioning `new Notice(` while explaining this file
 * cannot itself satisfy - or fail - a count.
 */
import { describe, expect, it } from "vitest";
import { penToggleNoticeText } from "./main";
import mainSrc from "./main.ts?raw";
import { codeOnly } from "./CodeOnly";

/** main.ts's registrations, without main.ts's prose about them. */
const mainCode = codeOnly(mainSrc);

function occurrences(src: string, needle: string): number {
	return src.split(needle).length - 1;
}

/**
 * One registration, from its `id` to the start of the next one (or end of
 * file). main.ts lays every command out this way, one after another and never
 * nested, so this needs no brace-matching to isolate one callback's body.
 *
 * TWO spellings since the 1.4.12 palette split: `this.addCommand({` for the
 * always-registered commands and `addGatedCommand({` for the ones behind
 * "Extra commands for hotkeys". Matching only the first walked the window
 * past four whole registrations - the eraser, lasso, insert-space and pan
 * toggles are all gated - and swept in the `new Notice(` calls of commands
 * this file was not asking about, which is how it failed.
 */
const NEXT_REGISTRATION = /(?:this\.)?add(?:Gated)?Command\(\{/;

function commandBlock(src: string, id: string): string {
	const marker = `id: "${id}"`;
	const start = src.indexOf(marker);
	if (start === -1) throw new Error(`command not in main.ts: ${id}`);
	const after = start + marker.length;
	const next = src.slice(after).search(NEXT_REGISTRATION);
	return next === -1 ? src.slice(start) : src.slice(start, after + next);
}

/**
 * One function body from `main.ts`, from its signature to the closing brace
 * at its own indent - every brace inside one of these is deeper, so this
 * needs no brace matching.
 *
 * The slice is taken from an LF copy: the tree is CRLF and `?raw` hands the
 * file over with its line endings intact, so a closer written with a bare
 * newline would never be found. BOTH ends are asserted, because a slice whose
 * end is missed silently becomes "the rest of the file" - which would satisfy
 * every count below for the wrong reason.
 */
function bodyOf(src: string, signature: string, indent: string): string {
	const lf = src.split("\r\n").join("\n");
	const start = lf.indexOf(signature);
	if (start === -1) throw new Error(`main.ts has no ${signature}`);
	const end = lf.indexOf(`\n${indent}}`, start);
	if (end === -1) throw new Error(`no closing brace found for ${signature}`);
	return lf.slice(start, end);
}

describe("penToggleNoticeText: state -> message, nothing else", () => {
	it("on", () => {
		expect(penToggleNoticeText(true)).toBe("Handwriting: pen ink active");
	});

	it("off", () => {
		expect(penToggleNoticeText(false)).toBe(
			"Handwriting: keyboard mode - pen ink paused, tap to type"
		);
	});
});

describe("Pen on / off: one owned Notice, never a direct construction", () => {
	// THE SAME TOGGLE, UNDER THE ONE COMMAND IT HAS SINCE 1.4.12. This block
	// used to read `pen-ink-toggle`; that command left the palette when alan
	// ruled "there should only be one", and `inline-tool-pen` - which used to
	// be the plain nib pick, and toasted with a bare `new Notice("Handwriting:
	// pen")` - is now the pen-input toggle and inherits its owned slot. The
	// defect this file is about did not move: a spammed `Pen on / off` stacks
	// exactly the way a spammed keyboard button did.
	const block = commandBlock(mainCode, "inline-tool-pen");

	it("never constructs a Notice itself", () => {
		expect(occurrences(block, "new Notice(")).toBe(0);
	});

	it("shows it through showPenToggleNotice exactly once", () => {
		expect(occurrences(block, "showPenToggleNotice(")).toBe(1);
	});

	it("builds the message with the pure helper, not an inline string", () => {
		expect(occurrences(block, "penToggleNoticeText(")).toBe(1);
	});
});

describe("the strip's keyboard button shares that one slot", () => {
	/**
	 * The button is no longer a command, so there is no `addCommand` block to
	 * slice: main.ts files its action with `setRetiredCommandAction`
	 * (CommandPaletteSplit.ts) because saved fold orders still name the id.
	 * The rule it has to keep is the same one - the pen-input switch owns ONE
	 * Notice between its two callers, so pressing the button and then the
	 * command reads as one toggle's news rather than two stacked toasts.
	 */
	const at = mainCode.indexOf("setRetiredCommandAction(");
	const filed = mainCode.slice(at, mainCode.indexOf("});", at));

	it("main.ts files an action for it at all - a dead button is the failure", () => {
		expect(at, "main.ts no longer files the keyboard button's action").toBeGreaterThan(-1);
	});

	it("routes through the same shower, and constructs no Notice of its own", () => {
		expect(occurrences(filed, "new Notice(")).toBe(0);
		expect(occurrences(filed, "showPenToggleNotice(")).toBe(1);
		expect(occurrences(filed, "penToggleNoticeText(")).toBe(1);
	});
});

describe("the same rewrite-or-recreate rule, applied to the strip's other rapid-fire toggles", () => {
	// Same shape as pen-ink-toggle: a strip button whose own repeated press
	// flips a boolean and shows a Notice named after the RESULT, so a
	// stacked, stale Notice reads exactly as wrong. Eraser, lasso, insert
	// space and pan already share `tipModeOffNotice` for the OFF half of
	// that message (TipModeCommand.test.ts); this pins that all four also
	// share `ownedNotice`'s rewrite instead of stacking a fresh Notice per
	// press, same as the keyboard button.
	const cases: ReadonlyArray<readonly [id: string, shower: string]> = [
		["inline-tool-eraser", "showEraserToggleNotice"],
		["inline-tool-lasso", "showLassoToggleNotice"],
		["inline-tool-space", "showSpaceToggleNotice"],
		["inline-tool-pan", "showPanToggleNotice"],
	];

	for (const [id, shower] of cases) {
		it(`${id} routes through ${shower}, never a direct new Notice(`, () => {
			const block = commandBlock(mainCode, id);
			expect(occurrences(block, "new Notice(")).toBe(0);
			expect(occurrences(block, `${shower}(`)).toBe(1);
		});
	}
});

describe("mouse-ink-toggle: same defect shape as the pen toggle, its own owned Notice slot", () => {
	// Not a strip button - a hotkey/palette-only toggle - but Alan's report
	// describes this one just as well: `on ? "Handwriting: ink" :
	// "Handwriting: cursor"` is the same "message names the resulting boolean
	// state" shape as pen-ink-toggle, and a hotkey is spammed at least as
	// easily as a button.
	const block = commandBlock(mainCode, "mouse-ink-toggle");

	it("never constructs a Notice itself", () => {
		expect(occurrences(block, "new Notice(")).toBe(0);
	});

	it("shows it through showMouseInkToggleNotice exactly once", () => {
		expect(occurrences(block, "showMouseInkToggleNotice(")).toBe(1);
	});

	it("keeps its own slot rather than reusing the pen toggle's", () => {
		// The two are different commands with different meanings; sharing a
		// slot would make pressing one read as the other repeating itself.
		expect(occurrences(block, "showPenToggleNotice(")).toBe(0);
	});

	// THE WORDS THEMSELVES, pinned because they are a ruling rather than a
	// detail (alan, 2026-09-05). The ON toast names the STATE: after the
	// switch, anything that touches the glass inks, so a device or a nib in
	// the message is wrong the moment a pen arrives - "what if we are
	// Handwriting: mouse drawing on and then the dude touches with a pen?".
	// Both ends asserted: the words that must be there, and the tool
	// derivation that must not come back.
	it("says the state on the way in and the way out", () => {
		expect(block).toContain('"Handwriting: ink"');
		expect(block).toContain('"Handwriting: cursor"');
	});

	it("names no device and no tool: nothing in the message is interpolated", () => {
		expect(block).not.toContain("${tip}");
		expect(block).not.toContain("Handwriting: ${");
	});
});

describe("ownedNotice: the only place any of the six toggles constructs a Notice", () => {
	/** From the factory's own declaration to the first slot that calls it. */
	const factory = mainCode.slice(
		mainCode.indexOf("function ownedNotice("),
		mainCode.indexOf("const showPenToggleNotice = ownedNotice();")
	);

	it("constructs a Notice exactly once in its whole body", () => {
		expect(occurrences(factory, "new Notice(")).toBe(1);
	});

	it("checks messageEl.isConnected before reusing one - a dead Notice is never rewritten", () => {
		expect(occurrences(factory, "notice?.messageEl?.isConnected")).toBe(1);
	});

	it("the isConnected probe is optional-chained - a missing messageEl must not throw inside a command callback", () => {
		// The exact guard this describe block's sibling test pins is the safe
		// form; this pins that the unsafe form (which would throw on
		// test/obsidian-stub.ts's Notice, and on any future Obsidian that
		// provides no message element) is not what shipped.
		expect(occurrences(factory, "notice && notice.messageEl.isConnected")).toBe(0);
	});

	it("does not call setMessage - not verifiable against this repo's Notice surfaces (see the doc comment above ownedNotice)", () => {
		expect(occurrences(factory, "setMessage")).toBe(0);
	});

	it("is instantiated exactly once per toggle - no slot shared between two toggles", () => {
		const names = [
			"showPenToggleNotice",
			"showEraserToggleNotice",
			"showLassoToggleNotice",
			"showSpaceToggleNotice",
			"showPanToggleNotice",
			"showMouseInkToggleNotice",
		];
		for (const name of names) {
			expect(occurrences(mainCode, `const ${name} = ownedNotice();`)).toBe(1);
		}
		// And no seventh slot anywhere - six toggles, six calls to the factory.
		expect(occurrences(mainCode, "= ownedNotice();")).toBe(names.length);
	});
});

describe("the owned Notices come down with the plugin", () => {
	/**
	 * A Notice is Obsidian's DOM on Obsidian's own timeout, so it outlives the
	 * plugin that made it: disabling or reloading between the last toggle and
	 * that timeout left the final toast standing, naming the state of a plugin
	 * that is no longer running. The six slots are module scope and closed
	 * over, so `onunload` cannot reach them one at a time.
	 *
	 * Source text again, for this file's own reason: `test/obsidian-stub.ts`'s
	 * `Notice` is an empty class, so a hider that ran here would find no
	 * `messageEl` to probe and no `hide` to call - there is no live Notice in
	 * this repo to put down. What is pinnable is that every slot registers a
	 * hider and that unload calls them all.
	 */
	const factory = mainCode.slice(
		mainCode.indexOf("function ownedNotice("),
		mainCode.indexOf("const showPenToggleNotice = ownedNotice();")
	);

	it("every slot registers its hider as it is created", () => {
		expect(occurrences(factory, "ownedNoticeHiders.push(")).toBe(1);
	});

	it("the rewrite and the unload hide are the same act, written once", () => {
		// `clear()` is both what the shower calls before constructing a fresh
		// Notice and what unload calls on its own; two copies of the
		// hide-if-showing rule are two things that can drift apart.
		expect(occurrences(factory, "notice?.messageEl?.isConnected")).toBe(1);
		expect(occurrences(factory, "clear();")).toBe(1);
	});

	it("hideOwnedNotices puts down every registered slot, not one named toggle", () => {
		const body = bodyOf(mainCode, "function hideOwnedNotices(): void {", "");
		expect(occurrences(body, "for (const hide of ownedNoticeHiders) hide();")).toBe(1);
		for (const name of ["showPenToggleNotice", "showMouseInkToggleNotice"]) {
			expect(occurrences(body, name)).toBe(0);
		}
	});

	it("onunload calls it, so a disabled plugin leaves no toast behind", () => {
		const body = bodyOf(mainCode, "onunload(): void {", "\t");
		expect(occurrences(body, "hideOwnedNotices();")).toBe(1);
	});
});
