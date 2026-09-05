/**
 * A tip-mode command reaches a mouse-only user's tip.
 *
 * Eraser, lasso, insert space and pan all say what the TIP does. On a machine
 * with no pen the mouse is not a tip until mouse ink is on -
 * `InlinePenRouter.mouseActsAsPen` is `pointerType === "mouse" &&
 * mouseInkEnabled()`, and nothing else lets a mouse contact become a pen
 * sample. So the command set a mode nothing could read and looked broken
 * rather than unavailable: ctrl+shift+E did nothing until the mouse-ink
 * toggle had been pressed first (user report with video, c1bd3c8).
 *
 * `armTipModeInput` fixed that in 1.4.4 and was disabled two days later by
 * `a4f996f`, which inserted `markPenSeen()` immediately above the call for an
 * unrelated reason (the strip has to appear for someone who has not held a
 * pen). `armTipModeInput`'s first line is
 * `if (mouseInkEnabled() || penSeenThisSession()) return false;`, so the line
 * above it made its own guard true and it returned false at all four sites
 * from then on.
 *
 * `enterTipMode` is the two halves in one place, in the order the order
 * matters in. This is the first test in the repo to import `src/main.ts`.
 *
 * WHAT THE ARM IS WORTH ON DISK: nothing (alan, 2026-09-04, "dont persist a
 * quiet arm"). It used to write `settings.mouseInk = true` and save, so one
 * press of ctrl+shift+E was the reason mouse ink came up armed at every
 * launch from then on - the user report that mouse ink "keeps turning on by
 * itself". Nobody asked for the MODE here; they asked for the eraser, and
 * arming the mouse is only what that request needs to mean anything. The two
 * LOUD writers - the mouse-ink toggle command and the settings switch, where
 * the mode is asked for by name - are the only ones that write it down.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import HandwritingPlugin from "./main";
import { consumeMousePutDown, markMousePutDown, mouseInkEnabled, setMouseInk } from "./inline/MouseInk";
import {
	clearPenHardwareSeen,
	markPenHardwareSeen,
	markPenSeen,
	penHardwareSeen,
	penSeenThisSession,
	resetPenToolsForTest,
} from "./inline/PenToolsMode";
import { addStripSurface, getInlineTool, setInlineTool } from "./inline/InkOverlay";

const proto = HandwritingPlugin.prototype as unknown as {
	enterTipMode(this: unknown, on: boolean): void;
	applyMouseInkUiFanout(this: unknown, on: boolean): void;
	tipModeOffNotice(this: unknown): string;
};

/**
 * The plugin, minus everything a command callback does not touch.
 * `Object.create` skips the field initialisers, so the two members
 * `armTipModeInput` reaches are supplied by hand.
 */
function fakePlugin(): { settings: { mouseInk: boolean }; saves: number } {
	const plugin = Object.create(HandwritingPlugin.prototype) as Record<string, unknown>;
	plugin.settings = { mouseInk: false };
	// A COUNT, not just the end value. `settings.mouseInk` could stay false
	// while a save still ran, and a save that writes the same value is still
	// a write to data.json - the thing the session-only rule forbids. Both
	// are asserted, so a half-reverted change cannot pass.
	plugin.saves = 0;
	plugin.persistSettings = (): Promise<void> => {
		plugin.saves = (plugin.saves as number) + 1;
		return Promise.resolve();
	};
	return plugin as unknown as { settings: { mouseInk: boolean }; saves: number };
}

describe("entering a tip mode from a command", () => {
	beforeEach(() => {
		resetPenToolsForTest();
		setMouseInk(false);
	});

	it("turns the mouse into a tip for a user who has not held a pen", () => {
		const plugin = fakePlugin();

		proto.enterTipMode.call(plugin, true);

		expect(mouseInkEnabled()).toBe(true);
		// ARMED FOR THIS SESSION AND NOT PERSISTED (alan, 2026-09-04: "dont
		// persist a quiet arm"). The inverse of this assertion is what shipped
		// through 1.4.9 and is what "mouse ink keeps turning on by itself"
		// was: the tool hotkey wrote the mode to disk, and every launch after
		// it started with the mouse claimed by a mode nobody named.
		expect(plugin.settings.mouseInk).toBe(false);
		expect(plugin.saves).toBe(0);
	});

	it("is gone at the next launch - the arm was only for this session", () => {
		const plugin = fakePlugin();

		proto.enterTipMode.call(plugin, true);
		expect(mouseInkEnabled()).toBe(true);

		// main.ts's onload in one line: the mode at startup is the SAVED
		// setting and nothing else (`setMouseInk(this.settings.mouseInk)`,
		// unchanged by this rule - it is what still brings an explicit ON
		// back). Replayed here because the whole point of the change is what
		// this line finds waiting for it.
		setMouseInk(plugin.settings.mouseInk);

		expect(mouseInkEnabled()).toBe(false);
	});

	it("leaves a pen user's mouse alone", () => {
		// They never asked for it, and claiming the mouse costs them text
		// selection. This is the guard that made the bug: it is true by the
		// time the arm runs if markPenSeen goes first.
		markPenSeen();
		const plugin = fakePlugin();

		proto.enterTipMode.call(plugin, true);

		expect(mouseInkEnabled()).toBe(false);
		expect(plugin.settings.mouseInk).toBe(false);
	});

	it("claims nothing when the command is switching a mode OFF", () => {
		const plugin = fakePlugin();

		proto.enterTipMode.call(plugin, false);

		expect(mouseInkEnabled()).toBe(false);
	});

	it("shows the pen UI either way, on or off", () => {
		// The other half, and the reason the two collided. Moving the arm in
		// front of markPenSeen must not cost the strip its appearance - on
		// the OFF branch especially, where the arm does not run at all.
		proto.enterTipMode.call(fakePlugin(), false);
		expect(penSeenThisSession()).toBe(true);

		resetPenToolsForTest();
		setMouseInk(false);
		proto.enterTipMode.call(fakePlugin(), true);
		expect(penSeenThisSession()).toBe(true);
	});
});

/**
 * Bug 1 (this session's hardware report, 2026-09-03): "you have to tap a
 * couple times for pen to light as well as turn mouse ink off's light on
 * even though the toast works properly immediately."
 *
 * The STATE changed instantly - `penHardwareSeen()`/`mouseInkEnabled()` flip
 * the moment the command runs, which is why the toast (built from the same
 * state) was always right. Only the STRIP's paint lagged, because
 * `refreshPenToolsAll` (`ensurePenTools` per editor) is a no-op once a strip
 * already exists - the common case - and it never walks the PDF surface at
 * all regardless (that lives in a different map; see InkOverlay.ts's own
 * comment on `stripSurfaces`). `refreshAllStrips` is the one call that both
 * repaints an existing strip and reaches every surface registered via
 * `addStripSurface` - the PDF's, in production.
 *
 * These tests register a fake strip surface the same way main.ts registers
 * the PDF's, and assert THAT REGISTERED CALLBACK fires. Asserting only that
 * `refreshPenToolsAll` ran (the pre-fix code path) would still pass if the
 * fix were reverted, since that call reaches the editors and nothing else -
 * exactly the bug.
 */
describe("applyMouseInkUiFanout: the light repaints on every open strip, not just the editors", () => {
	beforeEach(() => {
		resetPenToolsForTest();
		setMouseInk(false);
	});

	it("turning mouse ink OFF reaches a registered (PDF-like) strip surface immediately", () => {
		markPenHardwareSeen();
		const refresh = vi.fn();
		const undo = addStripSurface(refresh);
		try {
			refresh.mockClear();

			proto.applyMouseInkUiFanout.call(fakePlugin(), false);

			// Not "at least once" - the fan-out must reach it, and reaching
			// it twice would mean a redundant second sweep.
			expect(refresh).toHaveBeenCalledTimes(1);
			// And the state half, so a failure here is unambiguously about
			// the repaint reaching the surface, not about the underlying
			// flag never having moved at all.
			expect(penHardwareSeen()).toBe(false);
		} finally {
			undo();
		}
	});

	it("turning mouse ink ON reaches a registered (PDF-like) strip surface immediately too", () => {
		const refresh = vi.fn();
		const undo = addStripSurface(refresh);
		try {
			proto.applyMouseInkUiFanout.call(fakePlugin(), true);

			expect(refresh).toHaveBeenCalledTimes(1);
		} finally {
			undo();
		}
	});

	it("OFF does not take the strip away - penSeen (visibility) is untouched", () => {
		markPenSeen();
		const plugin = fakePlugin();

		proto.applyMouseInkUiFanout.call(plugin, false);

		expect(penSeenThisSession()).toBe(true);
	});
});

/**
 * Bug 2 (this session's hardware report, 2026-09-03): "toast is incorrect
 * but this works on all tools but it says highlighter after doing it."
 *
 * `tipModeOffNotice` is what the eraser/lasso/insert-space/pan commands call
 * to build their OFF-toggle Notice (main.ts). Ordinarily it names the nib the
 * tip fell back to, which is correct for a pen or touch tap that really did
 * just pick that nib up. `markMousePutDown` (MouseInk.ts) is set by
 * MobileTools.ts immediately before it runs one of these commands as part of
 * a MOUSE put-down, where nothing was picked - the mouse only got its cursor
 * back - and these tests pin that the wrong wording gets replaced with the
 * loud mouse-ink-toggle command's own OFF text, matched verbatim rather than
 * invented, and consumed so it cannot leak into the next ordinary toggle.
 */
describe("tipModeOffNotice: what the OFF toast says", () => {
	beforeEach(() => {
		resetPenToolsForTest();
		setMouseInk(false);
		consumeMousePutDown();
		clearPenHardwareSeen();
	});

	it("ordinarily names the nib the tip fell back to", () => {
		setInlineTool("highlighter");
		const plugin = fakePlugin();

		const text = proto.tipModeOffNotice.call(plugin);

		expect(text).toBe(`Handwriting: ${getInlineTool()}`);
		expect(text).toBe("Handwriting: highlighter");
	});

	it("says cursor for a mouse put-down, not the nib's name", () => {
		setInlineTool("highlighter");
		markMousePutDown();
		const plugin = fakePlugin();

		const text = proto.tipModeOffNotice.call(plugin);

		// Matched to the loud mouse-ink-toggle command's own OFF string
		// (main.ts), not invented wording - and specifically NOT the nib
		// name, which is the exact defect reported ("it says highlighter").
		expect(text).toBe("Handwriting: cursor");
		expect(text).not.toBe("Handwriting: highlighter");
	});

	it("consumes the flag - a second OFF toggle right after gets the ordinary wording", () => {
		setInlineTool("pen");
		markMousePutDown();
		const plugin = fakePlugin();

		const first = proto.tipModeOffNotice.call(plugin);
		const second = proto.tipModeOffNotice.call(plugin);

		expect(first).toBe("Handwriting: cursor");
		expect(second).toBe("Handwriting: pen");
	});
});
