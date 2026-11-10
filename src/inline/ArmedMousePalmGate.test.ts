/**
 * THE PALM GATE IS WARMED BY A PEN, NOT BY A POINTER THAT IS MERELY ACCEPTED.
 *
 * THE SYMPTOM. Mouse ink armed, no pen anywhere near the machine: the mouse
 * moves, and the next finger to land is swallowed as if a palm had settled
 * beside a working pen - or is held back from scrolling the note. A desktop
 * with a touchscreen and mouse ink armed decides a pen is near because a
 * mouse moved.
 *
 * THE MECHANISM. `InlinePenRouter`'s hover branch (pointermove and
 * pointerrawupdate alike) is entered by every pointer it accepts, and with
 * mouse ink armed a MOUSE is accepted through `mouseActsAsPen`. That branch
 * called `gate.penHoverSeen(now)` for every accepted pointer, so a mouse
 * warmed the palm gate's "a pen is near" window - the state `blocksNewTouch`
 * reads at touch pointerdown before it swallows the contact. The same branch
 * already made this exact distinction one line up, for `penHoverAt` (the
 * reticle's "hand on glass" stamp, written only under `pointerType === "pen"`);
 * the gate call now sits under the same test.
 *
 * THE RIG. The real router on the shared element fake (`test/routerHarness.ts`)
 * with the recorder callbacks, so a touch pointerdown here runs the router's
 * own touch branch and its own palm gate. `palmsBlocked` is the counter that
 * swallow path increments and nothing else does, so it is the assertion. The
 * negative controls are the important half: the gate exists for a real defect
 * (a palm planted just before the pen lands), and a real pen hovering or
 * writing must still swallow the palm exactly as before.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { setMouseInk } from "./MouseInk";
import { InlinePenRouter } from "./InlinePenRouter";
import { harness, installFakeWindow } from "../../test/routerHarness";

/**
 * One pointer event with its own id. Distinct ids per pointer on purpose: the
 * router's touch bookkeeping is keyed by id, and a finger sharing the mouse's
 * id would make it delete the wrong contact.
 */
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

/** A finger landing at rest - the shape of a palm heel or a scroll finger's first contact. */
const finger = (id: number): PointerEvent => ptr("pointerdown", "touch", id, 120, 300, 1);
const fingerUp = (id: number): PointerEvent => ptr("pointerup", "touch", id, 120, 300, 0);

let undoWindow: () => void;
let h: ReturnType<typeof harness>;
let router: InlinePenRouter;

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

describe("mouse ink armed, no pen has ever been seen: a moving mouse does not warm the palm gate", () => {
	beforeEach(() => {
		setMouseInk(true);
	});

	it("a finger landing after a mouse hover is not swallowed", () => {
		// The mouse hovers - the ordinary desk state, with mouse ink on.
		h.fire(ptr("pointermove", "mouse", 1, 500, 500));
		// A finger lands somewhere else. No pen exists.
		h.fire(finger(2));

		expect(
			router.palmsBlocked,
			"a mouse moving with mouse ink armed warmed the palm gate, and the next finger was swallowed as a palm with no pen in the room"
		).toBe(0);
	});

	it("the raw stream's half: a finger landing after a mouse pointerrawupdate is not swallowed", () => {
		h.fire(ptr("pointerrawupdate", "mouse", 1, 500, 500));
		h.fire(finger(2));

		expect(
			router.palmsBlocked,
			"a mouse pointerrawupdate with mouse ink armed warmed the palm gate, and the next finger was swallowed"
		).toBe(0);
	});

	it("and it behaves exactly as it does with mouse ink off", () => {
		// The control: the same two events with the switch off. A mouse with
		// ink off never enters the hover branch at all, so this is what "no
		// pen in the room" is supposed to look like.
		setMouseInk(false);
		h.fire(ptr("pointermove", "mouse", 1, 500, 500));
		h.fire(finger(2));
		const off = router.palmsBlocked;
		h.fire(fingerUp(2));
		router.dispose();

		setMouseInk(true);
		h = harness();
		router = h.router;
		h.fire(ptr("pointermove", "mouse", 1, 500, 500));
		h.fire(finger(3));

		expect(off).toBe(0);
		expect(router.palmsBlocked, "mouse ink armed swallowed a finger that mouse ink off let through").toBe(off);
	});

	it("a mouse that draws still draws - this takes nothing away from mouse ink", () => {
		h.fire(ptr("pointerdown", "mouse", 1, 500, 500, 1));
		h.fire(ptr("pointermove", "mouse", 1, 520, 510, 1));
		h.fire(ptr("pointerup", "mouse", 1, 520, 510, 0));

		expect(h.rec.downs, "the armed mouse's stroke was not claimed").toBe(1);
		expect(h.rec.ups).toBe(1);
	});
});

describe("negative control: a real pen still warms the gate, and the palm is still swallowed", () => {
	it("a pen hovering, then a palm landing: the palm is swallowed", () => {
		// Pen in hover range, nib off the glass - "palm placed before pen".
		h.fire(ptr("pointermove", "pen", 7, 300, 300, 0));
		h.fire(finger(2));

		expect(
			router.palmsBlocked,
			"PALM REJECTION BROKEN: a palm landing beside a hovering pen was let through"
		).toBe(1);
	});

	it("the raw stream's half: a pen pointerrawupdate, then a palm landing: swallowed", () => {
		// The raw listener is bound only during a stroke now, so no hover raw
		// reaches the router in use; the raw hover path still exists for a raw
		// that lands between a claim and the take, and this binds it by hand.
		h.router.bindRawListener();
		h.fire(ptr("pointerrawupdate", "pen", 7, 300, 300, 0));
		h.fire(finger(2));

		expect(
			router.palmsBlocked,
			"PALM REJECTION BROKEN: a palm landing beside a pen seen on the raw stream was let through"
		).toBe(1);
	});

	it("a pen hovering with mouse ink ALSO armed: still swallowed - the switch does not disarm the gate", () => {
		setMouseInk(true);
		h.fire(ptr("pointermove", "mouse", 1, 500, 500));
		h.fire(ptr("pointermove", "pen", 7, 300, 300, 0));
		h.fire(finger(2));

		expect(router.palmsBlocked, "PALM REJECTION BROKEN with mouse ink armed").toBe(1);
	});

	it("a pen DOWN with a palm landing beside it: swallowed, as today", () => {
		h.fire(ptr("pointerdown", "pen", 7, 300, 300, 1));
		expect(h.rec.downs, "the pen's contact was not claimed").toBe(1);

		h.fire(finger(2));

		expect(
			router.palmsBlocked,
			"PALM REJECTION BROKEN: a palm landing mid-stroke was let through"
		).toBe(1);

		h.fire(ptr("pointerup", "pen", 7, 300, 300, 0));
		expect(h.rec.ups).toBe(1);
	});
});
