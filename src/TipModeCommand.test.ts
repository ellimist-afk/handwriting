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
 */
import { beforeEach, describe, expect, it } from "vitest";

import HandwritingPlugin from "./main";
import { mouseInkEnabled, setMouseInk } from "./inline/MouseInk";
import { markPenSeen, penSeenThisSession, resetPenToolsForTest } from "./inline/PenToolsMode";

const proto = HandwritingPlugin.prototype as unknown as {
	enterTipMode(this: unknown, on: boolean): void;
};

/**
 * The plugin, minus everything a command callback does not touch.
 * `Object.create` skips the field initialisers, so the two members
 * `armTipModeInput` reaches are supplied by hand.
 */
function fakePlugin(): { settings: { mouseInk: boolean } } {
	const plugin = Object.create(HandwritingPlugin.prototype) as Record<string, unknown>;
	plugin.settings = { mouseInk: false };
	plugin.persistSettings = () => Promise.resolve();
	return plugin as unknown as { settings: { mouseInk: boolean } };
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
		// Persisted, not just armed for the session: the setting is the thing
		// the router reads on the next launch too.
		expect(plugin.settings.mouseInk).toBe(true);
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
