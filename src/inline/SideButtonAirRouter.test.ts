/**
 * The pen router feeds the side-button-in-the-air state machine
 * (SideButtonAir.ts) from both hover streams, and a contact or a leave in the
 * middle of a press cancels it. Driven through the real router's capture
 * handlers on the shared harness element, so a feed that is wired in one
 * stream and not the other, or a reset that never runs, shows here.
 *
 * The state machine's own rules are held by SideButtonAir.test.ts. The
 * machine is module state, so every cell starts from its reset: a press or a
 * newer event stamp left by one cell must not decide the next.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Platform } from "obsidian";

import { harness, installFakeWindow, penEvent } from "../../test/routerHarness";
import { resetSideButtonAirForTest } from "./SideButtonAir";
import { resetTipModeForTest, tipMode } from "./TipMode";

/** The held touch's leave: button 1 still down, pressure 0, leaving the pane (no related target). */
function leave(ts: number): PointerEvent {
	return { ...penEvent("pointerleave", ts, { buttons: 1, pressure: 0 }), relatedTarget: null } as unknown as PointerEvent;
}

/** A hover row: no contact, pressure 0, the given buttons. */
function hover(type: "pointermove" | "pointerrawupdate", ts: number, buttons: number): PointerEvent {
	return penEvent(type, ts, { buttons, pressure: 0 });
}

describe("router feeds the side button in the air (Android)", () => {
	let undoWindow: () => void;
	const wasAndroid = Platform.isAndroidApp;

	beforeAll(() => {
		undoWindow = installFakeWindow();
	});
	afterAll(() => undoWindow());

	beforeEach(() => {
		resetTipModeForTest();
		resetSideButtonAirForTest();
		Platform.isAndroidApp = true;
	});
	afterEach(() => {
		Platform.isAndroidApp = wasAndroid;
		resetTipModeForTest();
		resetSideButtonAirForTest();
	});

	it("pointermove hover rows switch to the eraser and pointerrawupdate rows switch back", () => {
		const h = harness();
		h.fire(hover("pointermove", 10, 0));
		h.fire(hover("pointermove", 20, 1));
		h.fire(hover("pointermove", 30, 0));
		expect(tipMode()).toBe("eraser");
		h.fire(hover("pointerrawupdate", 40, 1));
		h.fire(hover("pointerrawupdate", 50, 0));
		expect(tipMode()).toBe("nib");
	});

	it("both streams delivering the same release switch once", () => {
		const h = harness();
		h.fire(hover("pointerrawupdate", 10, 1));
		h.fire(hover("pointermove", 10, 1));
		h.fire(hover("pointerrawupdate", 20, 0));
		h.fire(hover("pointermove", 20, 0));
		expect(tipMode()).toBe("eraser");
	});

	it("an older pressed pointermove row after the pointerrawupdate release does not switch again (trace 24.500 s)", () => {
		const h = harness();
		h.fire(hover("pointermove", 726000, 0));
		h.fire(hover("pointermove", 726100, 1));
		h.fire(hover("pointerrawupdate", 726235.2, 0));
		h.fire(hover("pointermove", 726231, 1));
		h.fire(hover("pointermove", 726235.2, 0));
		expect(tipMode()).toBe("eraser");
	});

	it("a pointerdown in the middle of a press cancels it", () => {
		const h = harness();
		h.fire(hover("pointermove", 10, 0));
		h.fire(hover("pointermove", 20, 1));
		h.fire(penEvent("pointerdown", 30, { buttons: 1, pressure: 0.4 }));
		h.fire(penEvent("pointerup", 40, { buttons: 0, pressure: 0 }));
		h.fire(hover("pointermove", 50, 0));
		expect(tipMode()).toBe("nib");
		expect(h.rec.downs).toBe(1);
	});

	it("a pointerleave in the middle of a press cancels it (the held touch)", () => {
		const h = harness();
		h.fire(hover("pointermove", 10, 0));
		h.fire(hover("pointermove", 20, 1));
		h.fire(leave(30));
		h.fire(hover("pointermove", 40, 1));
		h.fire(hover("pointermove", 50, 0));
		expect(tipMode()).toBe("nib");
	});

	it("(f) pen ink off: hover rows do nothing", () => {
		const h = harness();
		h.rec.cb.penOff = () => true;
		h.fire(hover("pointermove", 10, 0));
		h.fire(hover("pointermove", 20, 1));
		h.fire(hover("pointermove", 30, 0));
		h.fire(hover("pointerrawupdate", 40, 1));
		h.fire(hover("pointerrawupdate", 50, 0));
		expect(tipMode()).toBe("nib");
	});

	it("not Android: hover rows do nothing", () => {
		Platform.isAndroidApp = false;
		const h = harness();
		h.fire(hover("pointermove", 10, 0));
		h.fire(hover("pointermove", 20, 1));
		h.fire(hover("pointermove", 30, 0));
		expect(tipMode()).toBe("nib");
	});
});
