/**
 * GitHub issue 41: the side button lasso on Linux (Surface Slim Pen 2, KDE Wayland).
 *
 * Linux reports the side button as a real button. Pressed in the air it arrives as a pointerdown with button 2,
 * buttons 2 and pressure 0; the tip landing afterwards is a pointermove with buttons 3, never a second pointerdown.
 * The router used to claim that air press as a side-button contact at pressure 0. The next hover row read as a silent
 * lift and ended it at once, and the real contact then met no claimed pen and was never claimed. No lasso.
 *
 * Windows sends the opposite: hover rows with buttons 2 and no pointerdown, then the contact as the pointerdown with
 * buttons 3. That path must stay as it is.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeEl, installFakeWindow, penEvent, type PenOpts } from "../../test/routerHarness";
import { InlinePenRouter, type InlinePenCallbacks } from "./InlinePenRouter";

interface Down {
	at: number;
	buttons: number;
	pressure: number;
}

function rig() {
	const el = fakeEl();
	const downs: Down[] = [];
	const ups: number[] = [];
	let lastTs = 0;
	const cb: InlinePenCallbacks = {
		onPenDown: (_s, e) => void downs.push({ at: e.timeStamp, buttons: e.buttons, pressure: e.pressure }),
		onPenHover: () => {},
		onPenLeave: () => {},
		onPinch: () => {},
		onPenRaw: () => {},
		onPenMove: () => {},
		onPenUp: () => void ups.push(lastTs),
		onStrokeAbandoned: () => {},
	};
	new InlinePenRouter(el as unknown as HTMLElement, el as unknown as HTMLElement, cb);
	const fire = (type: string, ts: number, opts: PenOpts, button: number) => {
		lastTs = ts;
		const h = el.handlers.get(type);
		if (!h) throw new Error(`router registered no handler for ${type}`);
		h({ ...penEvent(type, ts, opts), button } as unknown as PointerEvent);
	};
	return { downs, ups, fire };
}

let undo: () => void;
beforeEach(() => {
	undo = installFakeWindow();
});
afterEach(() => undo());

describe("issue 41: the side button held, then the tip lands", () => {
	it("Linux: the air press claims nothing; the contact row with buttons 3 is the one pen-down, and the tip lift ends it", () => {
		const r = rig();
		// Hovering, no button.
		r.fire("pointermove", 10, { buttons: 0, pressure: 0 }, -1);
		// The side button pressed in the air: a real pointerdown, button 2, pressure 0.
		r.fire("pointerdown", 20, { buttons: 2, pressure: 0 }, 2);
		// Still in the air with the button held.
		r.fire("pointermove", 30, { buttons: 2, pressure: 0 }, -1);
		r.fire("pointermove", 40, { buttons: 2, pressure: 0 }, -1);
		expect(r.downs, "no pen-down while the pen is in the air").toEqual([]);
		// The tip lands: a pointermove, buttons 3, pressure above 0.
		r.fire("pointermove", 50, { buttons: 3, pressure: 0.5 }, -1);
		r.fire("pointermove", 60, { buttons: 3, pressure: 0.55, x: 110 }, -1);
		r.fire("pointermove", 70, { buttons: 3, pressure: 0.5, x: 120 }, -1);
		expect(r.downs).toEqual([{ at: 50, buttons: 3, pressure: 0.5 }]);
		expect(r.ups, "no end while the tip is down").toEqual([]);
		// The tip lifts with the button still held: the lift ends the gesture.
		r.fire("pointermove", 80, { buttons: 2, pressure: 0 }, -1);
		expect(r.ups).toEqual([80]);
		// The button released in the air: the pointerup ends nothing more.
		r.fire("pointerup", 90, { buttons: 0, pressure: 0 }, 2);
		expect(r.downs).toHaveLength(1);
		expect(r.ups).toEqual([80]);
	});

	it("Linux: a second landing while the button is still held is a second gesture", () => {
		const r = rig();
		r.fire("pointerdown", 20, { buttons: 2, pressure: 0 }, 2);
		r.fire("pointermove", 50, { buttons: 3, pressure: 0.5 }, -1);
		r.fire("pointermove", 60, { buttons: 2, pressure: 0 }, -1);
		r.fire("pointermove", 70, { buttons: 3, pressure: 0.5 }, -1);
		r.fire("pointermove", 80, { buttons: 2, pressure: 0 }, -1);
		r.fire("pointerup", 90, { buttons: 0, pressure: 0 }, 2);
		expect(r.downs.map((d) => [d.at, d.buttons])).toEqual([[50, 3], [70, 3]]);
		expect(r.ups).toEqual([60, 80]);
	});

	it("Linux: after the button is released in the air, a plain hover with buttons 1 and no press claims nothing", () => {
		const r = rig();
		r.fire("pointerdown", 20, { buttons: 2, pressure: 0 }, 2);
		r.fire("pointerup", 30, { buttons: 0, pressure: 0 }, 2);
		// A later move row with bit 1 and pressure, but no air press remembered: not ours to claim from a move.
		r.fire("pointermove", 40, { buttons: 1, pressure: 0.5 }, -1);
		expect(r.downs).toEqual([]);
	});

	it("Linux: after the air press, a move row with bit 1 and pressure 0 claims nothing; the row with pressure does", () => {
		const r = rig();
		r.fire("pointerdown", 20, { buttons: 2, pressure: 0 }, 2);
		// A row that reports the tip bit with no pressure is not the tip on the glass.
		r.fire("pointermove", 30, { buttons: 3, pressure: 0 }, -1);
		expect(r.downs, "a pressure 0 row claimed the contact").toEqual([]);
		r.fire("pointermove", 40, { buttons: 3, pressure: 0.5 }, -1);
		expect(r.downs).toEqual([{ at: 40, buttons: 3, pressure: 0.5 }]);
	});

	it("Linux: after the air press, a landing row from another pointer claims nothing; the pressed pointer's does", () => {
		const r = rig();
		r.fire("pointerdown", 20, { buttons: 2, pressure: 0, pointerId: 7 }, 2);
		r.fire("pointermove", 30, { buttons: 3, pressure: 0.5, pointerId: 8 }, -1);
		expect(r.downs, "another pointer's row claimed the contact").toEqual([]);
		r.fire("pointermove", 40, { buttons: 3, pressure: 0.5, pointerId: 7 }, -1);
		expect(r.downs).toEqual([{ at: 40, buttons: 3, pressure: 0.5 }]);
	});

	it("Windows control: hover rows with buttons 2, then the contact pointerdown with buttons 3, unchanged", () => {
		const r = rig();
		r.fire("pointermove", 10, { buttons: 0, pressure: 0 }, -1);
		r.fire("pointermove", 20, { buttons: 2, pressure: 0 }, -1);
		r.fire("pointermove", 30, { buttons: 2, pressure: 0 }, -1);
		r.fire("pointerdown", 40, { buttons: 3, pressure: 0.5 }, 0);
		r.fire("pointermove", 50, { buttons: 3, pressure: 0.5, x: 110 }, -1);
		expect(r.downs).toEqual([{ at: 40, buttons: 3, pressure: 0.5 }]);
		r.fire("pointerup", 60, { buttons: 2, pressure: 0 }, 0);
		expect(r.ups).toEqual([60]);
		expect(r.downs).toHaveLength(1);
	});

	it("control: a plain tip contact is claimed at its pointerdown as before", () => {
		const r = rig();
		r.fire("pointerdown", 10, { buttons: 1, pressure: 0.4 }, 0);
		r.fire("pointerup", 20, { buttons: 0, pressure: 0 }, 0);
		expect(r.downs).toEqual([{ at: 10, buttons: 1, pressure: 0.4 }]);
		expect(r.ups).toEqual([20]);
	});
});
