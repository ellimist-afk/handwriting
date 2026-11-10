/**
 * THE STANDING GUARD IS RE-ARMED BY A PEN, NOT BY A POINTER THAT IS MERELY
 * ACCEPTED.
 *
 * THE SYMPTOM. Mouse ink armed, no pen anywhere near the machine. A finger
 * pans the note and lifts, and the standing guard opens its native touch
 * window: touch-action restored on the scroller, the one-shot re-arm timer
 * running, so the next finger gesture is fully native, inertia included.
 * Then the mouse moves - the ordinary desk state - and the window slams
 * shut: touch-action: none is back, the re-arm timer is cancelled, and the
 * next finger is carried by the assist pan instead. With the mouse moving
 * DURING the pan, the lift finds the guard already reset and the window
 * never opens at all.
 *
 * THE MECHANISM. `InlinePenRouter`'s hover branch (pointermove and
 * pointerrawupdate alike) is entered by every pointer it accepts, and with
 * mouse ink armed a MOUSE is accepted through `mouseActsAsPen`. That branch
 * fed `manip.penSignal()` to the standing guard for every accepted pointer.
 * The guard's touch-action: none exists so a cold PEN contact meets a
 * committed opt-out and inks instead of panning; a mouse is not subject to
 * touch-action at all, so its hover buys the mouse nothing and costs the
 * finger its window. The signal now sits under the same
 * `pointerType === "pen"` test the `penHoverAt` stamp and the palm-gate warm
 * beside it already use.
 *
 * THE RIG. The real router on the shared element fake
 * (`test/routerHarness.ts`). The guard's style half writes the scroller's
 * inline touch-action and the subtree class, and those are the assertions:
 * "" with no class means the window is open, "none" with the class means
 * armed. A finger pan here is a touch down, one move past the assist slop
 * (so the assist engages and the lift reports "panned"), and a lift.
 *
 * The negative controls are the important half: a real PEN hovering after
 * the window opens must still re-arm the guard instantly, and a palm landing
 * beside that pen must still be swallowed. An armed mouse STROKE is left
 * exactly as it was: a claimed stroke owns the surface whatever pointer
 * holds it, and the last block pins that.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { GUARD_SUBTREE_CLASS } from "./GuardStyle";
import { setMouseInk } from "./MouseInk";
import { InlinePenRouter } from "./InlinePenRouter";
import { harness, installFakeWindow } from "../../test/routerHarness";

/** One pointer event with its own id; the router's touch bookkeeping is keyed by id. */
function ptr(
	type: string,
	pointerType: string,
	pointerId: number,
	x: number,
	y: number,
	buttons = 0
): PointerEvent {
	return {
		type,
		pointerType,
		pointerId,
		isPrimary: true,
		clientX: x,
		clientY: y,
		pressure: buttons === 0 ? 0 : 0.5,
		buttons,
		button: 0,
		timeStamp: 0,
		tiltX: 0,
		tiltY: 0,
		width: 0,
		height: 0,
		preventDefault: () => {},
		stopPropagation: () => {},
	} as unknown as PointerEvent;
}

const finger = (id: number): PointerEvent => ptr("pointerdown", "touch", id, 120, 300, 1);
/** 40 px of travel: past the assist slop, so the gesture counts as a pan. */
const fingerMove = (id: number): PointerEvent => ptr("pointermove", "touch", id, 120, 340, 1);
const fingerUp = (id: number): PointerEvent => ptr("pointerup", "touch", id, 120, 340, 0);

let undoWindow: () => void;
let h: ReturnType<typeof harness>;
let router: InlinePenRouter;

/** What the guard's style half has written to the scroller right now. */
function guard(): { touchAction: string; classed: boolean } {
	return {
		touchAction: h.el.style.touchAction,
		classed: h.el.classList.contains(GUARD_SUBTREE_CLASS),
	};
}

/** A finger pans and lifts; the touch window must be open afterwards. */
function panAndLift(id: number): void {
	h.fire(finger(id));
	h.fire(fingerMove(id));
	h.fire(fingerUp(id));
	expect(guard(), "precondition: the finger pan did not open the touch window").toEqual({
		touchAction: "",
		classed: false,
	});
}

beforeAll(() => {
	undoWindow = installFakeWindow();
});

afterAll(() => {
	undoWindow();
});

beforeEach(() => {
	h = harness();
	router = h.router;
});

afterEach(() => {
	router.dispose();
	setMouseInk(false);
});

describe("mouse ink armed, no pen has ever been seen: a moving mouse does not re-arm the standing guard", () => {
	beforeEach(() => {
		setMouseInk(true);
	});

	it("a finger pan opens the touch window, and a mouse hover leaves it open", () => {
		panAndLift(2);
		h.fire(ptr("pointermove", "mouse", 1, 500, 500));

		expect(
			guard(),
			"a mouse moving with mouse ink armed re-armed the standing guard: the finger's native touch window was shut with no pen in the room"
		).toEqual({ touchAction: "", classed: false });
	});

	it("the raw stream's half: a mouse pointerrawupdate leaves the window open", () => {
		panAndLift(2);
		h.fire(ptr("pointerrawupdate", "mouse", 1, 500, 500));

		expect(
			guard(),
			"a mouse pointerrawupdate with mouse ink armed re-armed the standing guard and shut the touch window"
		).toEqual({ touchAction: "", classed: false });
	});

	it("a mouse moving DURING the pan does not stop the window opening at the lift", () => {
		h.fire(finger(2));
		h.fire(fingerMove(2));
		h.fire(ptr("pointermove", "mouse", 1, 500, 500));
		h.fire(fingerUp(2));

		expect(
			guard(),
			"a mouse moving during a finger pan reset the standing guard, so the lift never opened the touch window"
		).toEqual({ touchAction: "", classed: false });
	});

	it("and it behaves exactly as it does with mouse ink off", () => {
		// The control: the same events with the switch off. A mouse with ink
		// off never enters the hover branch at all, so this is what "no pen
		// in the room" is supposed to look like.
		setMouseInk(false);
		panAndLift(2);
		h.fire(ptr("pointermove", "mouse", 1, 500, 500));
		const off = guard();
		router.dispose();

		setMouseInk(true);
		h = harness();
		router = h.router;
		panAndLift(3);
		h.fire(ptr("pointermove", "mouse", 1, 500, 500));

		expect(off).toEqual({ touchAction: "", classed: false });
		expect(guard(), "mouse ink armed shut a touch window that mouse ink off left open").toEqual(off);
	});
});

describe("negative control: a real pen still re-arms the guard, and the palm is still swallowed", () => {
	it("a pen hovering after the window opened re-arms the guard instantly", () => {
		panAndLift(2);
		h.fire(ptr("pointermove", "pen", 7, 300, 300, 0));

		expect(guard(), "COLD-CONTACT GUARD BROKEN: a hovering pen did not re-arm the standing guard").toEqual({
			touchAction: "none",
			classed: true,
		});
	});

	it("the raw stream's half: a pen pointerrawupdate re-arms the guard", () => {
		panAndLift(2);
		// The raw listener is bound only during a stroke now, so no hover raw
		// reaches the router in use; the raw hover path still exists for a raw
		// that lands between a claim and the take, and this binds it by hand.
		h.router.bindRawListener();
		h.fire(ptr("pointerrawupdate", "pen", 7, 300, 300, 0));

		expect(guard(), "COLD-CONTACT GUARD BROKEN: a pen seen on the raw stream did not re-arm the guard").toEqual({
			touchAction: "none",
			classed: true,
		});
	});

	it("a pen hovering with mouse ink ALSO armed: re-armed, and a palm landing beside it is swallowed", () => {
		setMouseInk(true);
		panAndLift(2);
		h.fire(ptr("pointermove", "mouse", 1, 500, 500));
		h.fire(ptr("pointermove", "pen", 7, 300, 300, 0));

		expect(guard(), "COLD-CONTACT GUARD BROKEN with mouse ink armed").toEqual({
			touchAction: "none",
			classed: true,
		});

		h.fire(finger(3));
		expect(router.palmsBlocked, "PALM REJECTION BROKEN with mouse ink armed").toBe(1);
	});
});

describe("found, not changed: an armed mouse STROKE still owns the surface", () => {
	it("a finger landing while the armed mouse is drawing is swallowed, exactly as beside a pen", () => {
		setMouseInk(true);
		h.fire(ptr("pointerdown", "mouse", 1, 500, 500, 1));
		expect(h.rec.downs, "the armed mouse's stroke was not claimed").toBe(1);

		h.fire(finger(2));
		expect(
			router.palmsBlocked,
			"a finger landing mid mouse-stroke was let through; a claimed stroke owns the surface whatever pointer holds it"
		).toBe(1);

		h.fire(ptr("pointerup", "mouse", 1, 520, 510, 0));
		expect(h.rec.ups).toBe(1);
	});
});
