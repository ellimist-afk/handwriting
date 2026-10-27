/**
 * ONE PEN COMMAND (1.4.12). Alan, 2026-09-05: "there are two of these
 * Handwriting: Pen and Handwriting: toggle pen input on/off - i think that's
 * stupid there should only be one", then "Pen on / off like Mouse on / off".
 *
 * Two halves, both pinned here.
 *
 * THE REMOVAL is a source-and-table guard. `pen-ink-toggle` is gone from the
 * palette - no `addCommand` block, no entry in either `CommandPaletteSplit`
 * table - while its MECHANISM is untouched: `setPenInk` still exists, the
 * strip still has its keyboard button, and that button still reaches the
 * switch by the same id, because `DEFAULT_FOLD_ORDER` and every fold order
 * already saved to a user's data.json are written in it. So the id survives in
 * exactly one place and the guard below says which one; a second spelling
 * anywhere in `src` is the failure mode this catches - the dangling exec that
 * would leave the keyboard button pressing nothing.
 *
 * THE SEMANTICS are behavioural, against the real `PenInk` and `MouseInk`
 * module state. `penOnOff` (PenCommand.ts) is the whole of the rule and needs
 * no Obsidian: what it cannot reach - the nib, the tip modes, the toolbars -
 * comes in through `PenCommandHost`, and the fake below is main.ts's own host
 * with the chrome counted instead of drawn. Its `pickPen` calls
 * `markToolPicked` because that is precisely what `setInlineTool` does
 * (MouseInk.ts names it as one of the two writers of the pick), and a source
 * probe further down pins that main.ts's real `pickPen` is still that call, so
 * this fake cannot quietly stop describing it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import MANUAL from "../docs/manual.md?raw";
import { codeOnly } from "./CodeOnly";
import { RELEASE_NOTES } from "./update/WhatsNew";
import { ALWAYS_COMMANDS, gatedCommands } from "./CommandPaletteSplit";
import {
	clearGatedCommandActions,
	runGatedCommand,
	setRetiredCommandAction,
} from "./CommandPaletteSplit";
import { PEN_INK_TOGGLE } from "./inline/MobileTools";
import { PenCommandHost, penIsLit, penOnOff, togglePenInput } from "./inline/PenCommand";
import { penInkEnabled, resetPenInkForTest, setPenInk } from "./inline/PenInk";
import {
	clearToolPicked,
	markToolPicked,
	mouseActsAsPen,
	setMouseInk,
	toolIsLit,
	toolPickedHere,
} from "./inline/MouseInk";

const ALL_TS = import.meta.glob("/src/**/*.ts", {
	query: "?raw",
	eager: true,
	import: "default",
}) as Record<string, string>;

/** Every shipped source file - the tests that talk ABOUT the id are not it. */
const SHIPPED = Object.entries(ALL_TS).filter(([path]) => !path.endsWith(".test.ts"));

// The command registrations live in commands/RegisterCommands.ts and RegisterExportCommands.ts, read here with main.ts.
const MAIN = codeOnly([ALL_TS["/src/main.ts"] ?? "", ALL_TS["/src/commands/RegisterCommands.ts"] ?? "", ALL_TS["/src/commands/RegisterExportCommands.ts"] ?? ""].join("\n"));

function occurrences(src: string, needle: string): number {
	return src.split(needle).length - 1;
}

/**
 * main.ts's host, with the chrome counted rather than drawn.
 *
 * `tool` and `tipMode` are the real reads main.ts wires (`getInlineTool`, and
 * the OR of the four tip-mode getters); `pickPen` is `setInlineTool("pen")`'s
 * one observable effect on the state this file can see.
 */
function fakeHost(start: { tool?: string; tipMode?: boolean } = {}): PenCommandHost & {
	flips: boolean[];
	picks: number;
} {
	const state = { tool: start.tool ?? "pen", tipMode: start.tipMode ?? false };
	const h = {
		flips: [] as boolean[],
		picks: 0,
		tool: () => state.tool,
		tipMode: () => state.tipMode,
		pickPen: () => {
			h.picks++;
			state.tool = "pen";
			state.tipMode = false;
			markToolPicked();
		},
		afterFlip: (on: boolean) => {
			h.flips.push(on);
		},
	};
	return h;
}

/**
 * Does the mouse draw right now? `InlinePenRouter.mouseActsAsPen`'s own
 * expression, restated once here and pinned against the router's source
 * below so the two cannot drift.
 */
function mouseDrawsHere(neverSeenAPen: boolean): boolean {
	return mouseActsAsPen("mouse", toolIsLit(penInkEnabled()), neverSeenAPen);
}

/** Launch state: pen input on, nothing picked, mouse ink off. */
beforeEach(() => {
	resetPenInkForTest();
	clearToolPicked();
	setMouseInk(false);
	clearGatedCommandActions();
});

describe("the palette carries one pen command, named for what it does", () => {
	it("`inline-tool-pen` is `Pen on / off`, beside `Mouse on / off`", () => {
		const byId = new Map(ALWAYS_COMMANDS.map((c) => [c.id, c.name]));
		expect(byId.get("inline-tool-pen")).toBe("Pen on / off");
		expect(byId.get("mouse-ink-toggle")).toBe("Mouse on / off");
		// And main.ts registers it under that name - the table is what the
		// settings row prints, not what Obsidian shows.
		expect(MAIN).toContain('id: "inline-tool-pen"');
		expect(MAIN).toContain('name: "Pen on / off"');
	});

	it("keeps the id, so a hotkey bound to the old `Pen` still resolves", () => {
		expect(ALWAYS_COMMANDS.map((c) => c.id)).toContain("inline-tool-pen");
	});
});

describe("`pen-ink-toggle` is out of the palette, and out of src", () => {
	it("has no addCommand block in main.ts", () => {
		expect(MAIN).not.toContain('id: "pen-ink-toggle"');
	});

	it("is in neither palette table", () => {
		const ids = [...ALWAYS_COMMANDS.map((c) => c.id), ...gatedCommands().map((c) => c.id)];
		expect(ids).not.toContain("pen-ink-toggle");
	});

	it("no shipped file spells the bare id as a string - a second one is a dangling exec", () => {
		// The failure this is for: a command id executed by a strip button, a
		// bridge or a settings row after nothing registers it any more. The
		// only spelling left is the strip's own, asserted below; anything
		// matching `"pen-ink-toggle"` here is a NEW one.
		for (const [path, src] of SHIPPED) {
			expect(occurrences(codeOnly(src), '"pen-ink-toggle"'), path).toBe(0);
		}
	});

	it("survives in exactly one place: the strip button's own id", () => {
		// MobileToolsButtons.ts owns the button, `DEFAULT_FOLD_ORDER` and the saved
		// fold orders written in that id, which is why the id outlived the
		// command. Named once, exported once, and nothing else in `src`
		// spells it.
		const spelt = SHIPPED.filter(([, src]) =>
			codeOnly(src).includes('"handwriting:pen-ink-toggle"')
		);
		expect(spelt.map(([path]) => path)).toEqual(["/src/inline/MobileToolsButtons.ts"]);
		expect(occurrences(codeOnly(spelt[0]?.[1] ?? ""), '"handwriting:pen-ink-toggle"')).toBe(1);
		expect(PEN_INK_TOGGLE).toBe("handwriting:pen-ink-toggle");
	});

	it("the mechanism it used to name is all still here", () => {
		// The command left; `setPenInk`, the strip's keyboard button and the
		// toast did not. Alan asked for one COMMAND, not for keyboard mode to
		// go away.
		setPenInk(false);
		expect(penInkEnabled()).toBe(false);
		expect(codeOnly(ALL_TS["/src/inline/MobileToolsButtons.ts"] ?? "")).toContain(
			"commandId: PEN_INK_TOGGLE"
		);
	});
});

describe("the strip's keyboard button still reaches the switch by that id", () => {
	it("main.ts files a retired action for it, and both spellings run", () => {
		// A retired id is one the palette will never hold again, so
		// `runGatedCommand` - which both exec bridges try FIRST - is the only
		// road left. Filing it is what stops the button being dead.
		let ran = 0;
		setRetiredCommandAction(PEN_INK_TOGGLE, () => ran++);
		expect(runGatedCommand(PEN_INK_TOGGLE)).toBe(true);
		expect(runGatedCommand("pen-ink-toggle")).toBe(true);
		expect(ran).toBe(2);
		expect(MAIN).toContain("setRetiredCommandAction(PEN_INK_TOGGLE,");
	});

	it("still means flip the switch and nothing else", () => {
		// The button is only built where a pen has been seen, and a pen user
		// coming back from typing is not asking to have the highlighter taken
		// out of their hand. It writes the same one flag the command does.
		const h = fakeHost({ tool: "highlighter" });
		expect(togglePenInput(h)).toBe(false);
		expect(penInkEnabled()).toBe(false);
		expect(togglePenInput(h)).toBe(true);
		expect(penInkEnabled()).toBe(true);
		expect(h.picks).toBe(0);
		expect(h.tool()).toBe("highlighter");
	});
});

/**
 * THE HOTKEY 1.4.11 LEAVES BEHIND, and why the answer is a sentence.
 *
 * 1.4.11 shipped `pen-ink-toggle` as `Pen: on / off` (main.ts at refs/tags/1.4.11).
 * 1.4.12 has one pen command and does not register that id, so Obsidian - which
 * dispatches every hotkey through the command registry - resolves the user's key
 * to nothing. It is worse than a no-op: with no command registered there is no
 * row in the Hotkeys tab either, so the binding is invisible as well as dead.
 *
 * NEITHER CODE FIX EXISTS in `obsidian.d.ts` (1.13.1, node_modules):
 *
 *  - NO HIDDEN COMMAND. `Command` (the interface `addCommand` takes) is
 *    id/name/icon/mobileOnly/repeatable/hotkeys plus the four callbacks; there
 *    is no flag that keeps an entry out of the palette. The one thing that
 *    does hide a command is `checkCallback` - "Returning false or undefined
 *    causes the command to be hidden from the command palette" - and that is
 *    the SAME gate execution runs through ("If checking is false, then this
 *    function should perform the action"), so a command hidden that way cannot
 *    be fired by a hotkey either. Registering it visibly is the thing Alan's
 *    ruling forbids.
 *  - NO MIGRATION. The only `Hotkey` on the plugin surface is `Command.hotkeys`,
 *    "Sets the default hotkey" - write-once, at registration, for a command
 *    that will exist. `App` exposes keymap, scope, workspace, vault,
 *    metadataCache, fileManager, lastEvent, renderContext and secretStorage;
 *    there is no hotkey manager, no `customKeys`, and nothing that reads or
 *    writes what the user bound. `Plugin` has `addCommand` and `removeCommand`
 *    and no third door. Nothing in `src` reads a hotkey today, so there is not
 *    even a house precedent to follow.
 *
 * So the fix is option (c): SAY SO, in the two places a user meets an upgrade -
 * the what's-new popup and the manual - and keep the mechanism reachable, which
 * the retired-action tests above already pin. Pinned here because a sentence
 * nobody asserts is a sentence a later docs pass silently drops, and then the
 * defect is back with no trace that it was ever answered.
 */
describe("the hotkey that cannot be migrated is documented instead", () => {
	/**
	 * Whitespace-flattened and de-ticked. `docs/manual.md` is hand-wrapped, so
	 * the sentence spans lines and would never match as written; it also marks
	 * command names with backticks, which the release note - one plain line in
	 * a popup - does not. Both differences are formatting, and neither is what
	 * this is asserting.
	 */
	function flat(s: string): string {
		return s.replace(/`/g, "").replace(/\s+/g, " ").trim();
	}

	/** What is dead. */
	const DEAD = "a hotkey bound to the old Pen: on / off does nothing";
	/** What to do about it - the only move left, and it is the user's. */
	const REBIND = "bind that key again to Pen on / off";

	// THE MANUAL ONLY, since 2026-09-06. This used to pin the sentence in
	// the release notes as well, and the 1.4.12 entry is now Alan's own
	// seven lines - he wrote them himself and ruled the keybind out of
	// them: "i dont care about the keybind, it's a brand new app they'll
	// just figure it reset on update". So the release-notes half is
	// RETIRED rather than satisfied by padding his text, and the manual
	// keeps the sentence, because that is where someone hunting a dead
	// hotkey will actually look.

	// PORTED FROM THE BOX LINE with the detector (d58daa2 pinned it in
	// src/DocsTruth.test.ts, a file 1.4.12 does not have). It lands here
	// rather than being dropped: this is the one file on this line that
	// already reads the manual flattened, and the assertion is worth more
	// than the file it came from. A rename that misses the manual leaves a
	// documented command nobody can find in the palette, on exactly the day
	// someone is hunting for lost ink.
	it("the split-ink check is named the same in main.ts and the manual", () => {
		const NAME = "Check for ink split across folders";
		expect(MAIN, "the command name must be code, not a comment").toContain(
			'"' + NAME + '"'
		);
		expect(flat(MANUAL), "the manual tells people to run it by this name").toContain(NAME);
	});

	it("the manual says it, where it lists the palette", () => {
		expect(flat(MANUAL)).toContain(DEAD);
		expect(flat(MANUAL)).toContain(REBIND);
	});

	it("and the mechanism the sentence promises is still wired", () => {
		// The sentence only tells the truth while keyboard mode itself is
		// reachable without that command: the strip's button, through the
		// retired action, into `togglePenInput`.
		expect(MAIN).toContain("setRetiredCommandAction(PEN_INK_TOGGLE, () => {");
		expect(MAIN).toContain("togglePenInput(penInkCommandHost)");
		let flipped: boolean | null = null;
		setRetiredCommandAction(PEN_INK_TOGGLE, () => {
			flipped = togglePenInput(fakeHost());
		});
		expect(runGatedCommand(PEN_INK_TOGGLE)).toBe(true);
		expect(flipped).toBe(false);
		expect(penInkEnabled()).toBe(false);
	});
});

/**
 * THE FOUR STATES the command can be pressed in. Pen input on or off, crossed
 * with the pen being the lit tool or not: only the one corner where the pen is
 * genuinely in hand puts it down, and every other press picks it up. Pen input
 * OFF unpicks (PenInk.ts's `setPenInk(false)` calls `clearToolPicked`), so the
 * two off rows can only be reached by picking after the switch moved.
 */
describe("Pen on / off across the four states", () => {
	/** The four things a press can move, read back off the host and the module. */
	interface State {
		readonly tool: string;
		readonly tipMode: boolean;
		readonly picked: boolean;
		readonly penInk: boolean;
	}

	interface Case {
		readonly what: string;
		readonly penInk: boolean;
		readonly picked: boolean;
		readonly tool: string;
		readonly tipMode: boolean;
		readonly lit: boolean;
		/**
		 * Where TWO presses actually leave it, written out rather than derived:
		 * four of these six do not come back to where they started, and a rule
		 * computing this column would hide exactly the rows worth reading.
		 */
		readonly after: State;
	}

	/** Two presses end at the pen, no tip mode, and lit only if it started lit. */
	const OFF_AND_UNPICKED: State = { tool: "pen", tipMode: false, picked: false, penInk: false };

	const CASES: readonly Case[] = [
		// ROUND TRIP. The pen was lit, so press one puts it down and press two
		// picks it back up - the only row where the pair is a no-op.
		{ what: "on, pen lit", penInk: true, picked: true, tool: "pen", tipMode: false, lit: true,
			after: { tool: "pen", tipMode: false, picked: true, penInk: true } },
		// Pen input was ON and comes back OFF: the pair began with the pick, so
		// it has to end with the put-down.
		{ what: "on, nothing picked", penInk: true, picked: false, tool: "pen", tipMode: false, lit: false,
			after: OFF_AND_UNPICKED },
		// The highlighter does not come back. Press one takes the pen out.
		{ what: "on, highlighter lit", penInk: true, picked: true, tool: "highlighter", tipMode: false, lit: false,
			after: OFF_AND_UNPICKED },
		// Nor does the eraser: `pickPen` leaves every tip mode.
		{ what: "on, eraser holding the tip", penInk: true, picked: true, tool: "pen", tipMode: true, lit: false,
			after: OFF_AND_UNPICKED },
		// ROUND TRIP, the other one: off and unpicked is where the pair lands.
		{ what: "off, nothing picked", penInk: false, picked: false, tool: "pen", tipMode: false, lit: false,
			after: OFF_AND_UNPICKED },
		// The nominal pick does not survive: press two's `setPenInk(false)`
		// clears it, and nothing was going to re-mark it.
		{ what: "off, pen nominally in hand", penInk: false, picked: true, tool: "pen", tipMode: false, lit: false,
			after: OFF_AND_UNPICKED },
	];

	for (const c of CASES) {
		it(`${c.what}: ${c.lit ? "puts the pen down" : "picks it up"}`, () => {
			setPenInk(c.penInk);
			if (c.picked) markToolPicked();
			else clearToolPicked();
			const h = fakeHost({ tool: c.tool, tipMode: c.tipMode });

			expect(penIsLit(h)).toBe(c.lit);
			expect(penOnOff(h)).toBe(!c.lit);
			expect(penInkEnabled()).toBe(!c.lit);
			// The pick happens on the way UP and never on the way down.
			expect(h.picks).toBe(c.lit ? 0 : 1);
			expect(h.flips).toEqual([!c.lit]);
			if (!c.lit) {
				expect(h.tool()).toBe("pen");
				expect(h.tipMode()).toBe(false);
				expect(toolPickedHere()).toBe(true);
			} else {
				// Off unpicks: keyboard mode is the user saying the tip does
				// nothing here, and coming back through it must not come up
				// still drawing with a tool nobody re-picked.
				expect(toolPickedHere()).toBe(false);
			}
		});
	}

	/**
	 * TWO PRESSES, AND WHAT THEY ARE NOT.
	 *
	 * This used to be called "run twice from any of them and you are back where
	 * you started", and asserted the return value and `penInkEnabled` - both
	 * already forced by the per-case test above, so it checked nothing new, and
	 * its title was false for FOUR of these six rows. From "on, highlighter
	 * lit" two presses end with the PEN as the nib and pen input off; from
	 * "on, eraser holding the tip" they end with the tip mode gone and pen
	 * input off. The first press is a PICK as well as a switch (`penOnOff`), and
	 * a pick is not something a second press undoes.
	 *
	 * What is actually true, and what the quadruple below pins: two presses
	 * always leave the pen as the nib with no tip mode holding it, and leave it
	 * inking only where it was inking to start with - the one row where the pen
	 * was genuinely lit. Everywhere else the pair ends in keyboard mode with
	 * nothing picked, because the second press is the one that puts down what
	 * the first press picked up.
	 */
	it("twice over: the nib ends as the pen, and inks again only where it was lit", () => {
		const roundTripped: string[] = [];
		for (const c of CASES) {
			setPenInk(c.penInk);
			if (c.picked) markToolPicked();
			else clearToolPicked();
			const h = fakeHost({ tool: c.tool, tipMode: c.tipMode });

			const first = penOnOff(h);
			// The second press always answers the first - that much the old
			// name got right, and it is all it got right.
			expect(penOnOff(h), c.what).toBe(!first);

			const end = {
				tool: h.tool(),
				tipMode: h.tipMode(),
				picked: toolPickedHere(),
				penInk: penInkEnabled(),
			};
			expect(end, c.what).toEqual(c.after);
			// The pen is the nib either way: the "up" press of the pair picks
			// it, whether that press is the first or the second.
			expect(end.tool, c.what).toBe("pen");
			expect(end.tipMode, c.what).toBe(false);
			// And the pick tracks the switch, because `setPenInk(false)` is
			// what clears it.
			expect(end.picked, c.what).toBe(end.penInk);
			// Lit at the start is exactly the condition for ending lit.
			expect(end.penInk, c.what).toBe(c.lit);

			const start = { tool: c.tool, tipMode: c.tipMode, picked: c.picked, penInk: c.penInk };
			if (JSON.stringify(end) === JSON.stringify(start)) roundTripped.push(c.what);
		}
		// The two that DO come back, named, so a row quietly joining or leaving
		// them has to be written down here.
		expect(roundTripped).toEqual(["on, pen lit", "off, nothing picked"]);
	});
});

/**
 * ALAN'S WALKTHROUGH, on the machine he was describing: a mouse-only device,
 * fresh state. Run it - the pen lights and a drag inks. Run it again - the pen
 * goes dark and a drag selects text. Run it a third time and the pen is back,
 * lit AND drawing.
 *
 * The third press is the whole reason the command picks as well as switches.
 * `setPenInk(false)` unpicks, so a keyboard-mode round trip that only flipped
 * the flag would come up with nothing lit - and on a pen-less device the lit
 * tool IS the mouse's only claim on the glass (`mouseDrawsFromLitTool`).
 */
describe("the mouse-only round trip", () => {
	const NEVER_SEEN_A_PEN = true;

	it("dark, lit and drawing, dark again, lit and drawing again", () => {
		const h = fakeHost();
		// Fresh: pen input defaults on, but nothing is picked, so the mouse
		// selects text - `docs/manual.md`'s "By default, only the pen draws".
		expect(mouseDrawsHere(NEVER_SEEN_A_PEN)).toBe(false);

		expect(penOnOff(h)).toBe(true);
		expect(penInkEnabled()).toBe(true);
		expect(toolPickedHere()).toBe(true);
		expect(mouseDrawsHere(NEVER_SEEN_A_PEN)).toBe(true);

		expect(penOnOff(h)).toBe(false);
		expect(penInkEnabled()).toBe(false);
		expect(toolPickedHere()).toBe(false);
		expect(mouseDrawsHere(NEVER_SEEN_A_PEN)).toBe(false);

		expect(penOnOff(h)).toBe(true);
		expect(penInkEnabled()).toBe(true);
		expect(toolPickedHere()).toBe(true);
		expect(mouseDrawsHere(NEVER_SEEN_A_PEN)).toBe(true);
	});

	it("without touching the mouse switch, either way", () => {
		// The derived grant carries the mouse here; `mouseInkEnabled` - the
		// "Mouse on / off" command and the settings switch - is the explicit
		// override and stays exactly where the user left it.
		const h = fakeHost();
		const src = codeOnly(ALL_TS["/src/inline/PenCommand.ts"] ?? "");
		penOnOff(h);
		penOnOff(h);
		expect(src).not.toContain("setMouseInk");
		expect(src).not.toContain("armMouseInkQuietly");
		expect(src).not.toContain("disarmMouseInkQuietly");
	});
});

describe("on a device that has seen a pen, the command leaves the mouse alone", () => {
	const HAS_SEEN_A_PEN = false;

	it("the mouse setting alone decides, before and after", () => {
		const h = fakeHost();
		// Mouse ink off: lighting the pen is about the PEN. The mouse still
		// selects text, because `mouseDrawsFromLitTool` answers false the
		// moment a pen has been seen.
		penOnOff(h);
		expect(mouseDrawsHere(HAS_SEEN_A_PEN)).toBe(false);
		penOnOff(h);
		expect(mouseDrawsHere(HAS_SEEN_A_PEN)).toBe(false);

		// Mouse ink on: it draws, and putting the pen down does not take it
		// away - two switches, two questions.
		setMouseInk(true);
		penOnOff(h);
		expect(mouseDrawsHere(HAS_SEEN_A_PEN)).toBe(true);
		penOnOff(h);
		expect(mouseDrawsHere(HAS_SEEN_A_PEN)).toBe(true);
	});
});

describe("the composed pieces are the ones already in the tree", () => {
	it("the router's grant is the expression this file restates", () => {
		// `mouseDrawsHere` above is a copy of one line, and a copy is only
		// safe while it is pinned to its original.
		expect(codeOnly(ALL_TS["/src/inline/InlinePenRouter.ts"] ?? "")).toContain(
			"mouseActsAsPen(e.pointerType, toolIsLit(!this.penOff()), deviceHasNeverSeenAPen())"
		);
	});

	it("main.ts's pickPen is still setInlineTool, which is what marks the pick", () => {
		// The fake host's `pickPen` calls `markToolPicked` because that is
		// `setInlineTool`'s own effect (MouseInk.ts). If main.ts ever picked
		// the pen some other way, this fake would be describing nothing.
		const host = MAIN.slice(MAIN.indexOf("const penInkCommandHost"), MAIN.indexOf("afterFlip:"));
		expect(host).toContain('setInlineTool("pen")');
		expect(host).toContain("setInlineEraserMode(false)");
		expect(host).toContain("setInlineLassoMode(false)");
		expect(host).toContain("setInlineSpaceMode(false)");
		expect(host).toContain("setInlinePanMode(false)");
	});

	it("PenCommand.ts adds no state of its own: one flag, read and written", () => {
		const src = codeOnly(ALL_TS["/src/inline/PenCommand.ts"] ?? "");
		// No module-level `let`, which is the shape every state module in this
		// tree uses - so its absence is the claim that this one holds none.
		expect(src).not.toMatch(/^let /m);
		expect(occurrences(src, "setPenInk(")).toBe(3);
		expect(src).toContain("toolIsLit(penInkEnabled())");
	});
});
