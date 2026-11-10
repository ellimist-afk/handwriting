/**
 * Linux: the pen button pressed during a stroke and held through the lift; the next landing is a lasso.
 *
 * Linux reports the side button as a real button. The lift with the button still held arrives as a pointermove with
 * pressure 0 and buttons 2, and ends the stroke as a silent lift. The next landing with the button held is a pointermove
 * with buttons 3, never a pointerdown (GitHub issue 41). That row is claimed only for a pointer remembered as holding
 * the button in the air, and only a pointerdown pressed in the air was remembered, so a press that began in contact
 * left the landing unclaimed: the pen drew nothing and lassoed nothing until every button was released.
 *
 * The silent lift that still carries the button bit now remembers the pointer the same way; the pointerup that
 * releases the button forgets it.
 *
 * Chromium sends pointerrawupdate before pointermove for one input, and the raw listener is bound for the whole
 * stroke, so on a Chromium build the lift row reaches the raw stream's silent lift first: the stroke ends there, the
 * raw listener is unbound, and the pointermove copy of the same row is only a hover row. Both silent-lift branches
 * remember the pointer, and the cells below drive each stream alone.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeEl, installFakeWindow, penEvent, type PenOpts } from "../../test/routerHarness";
import { InlinePenRouter, type InlinePenCallbacks } from "./InlinePenRouter";
import { resetSideButtonAirForTest } from "./SideButtonAir";
import { resetTipModeForTest } from "./TipMode";

function rig() {
	const el = fakeEl();
	const downs: Array<[at: number, buttons: number]> = [];
	const ups: number[] = [];
	let lastTs = 0;
	const cb: InlinePenCallbacks = {
		onPenDown: (_s, e) => void downs.push([e.timeStamp, e.buttons]),
		onPenHover: () => {},
		onPenLeave: () => {},
		onPinch: () => {},
		onPenRaw: () => {},
		onPenMove: () => {},
		onPenUp: () => void ups.push(lastTs),
		onStrokeAbandoned: () => {},
	};
	new InlinePenRouter(el as unknown as HTMLElement, el as unknown as HTMLElement, cb);
	const fire = (type: string, ts: number, opts: PenOpts, button = -1) => {
		lastTs = ts;
		const h = el.handlers.get(type);
		if (!h) throw new Error(`router registered no handler for ${type}`);
		h({ ...penEvent(type, ts, opts), button } as unknown as PointerEvent);
	};
	/** The raw listener is bound only from a claim to the stroke's end. */
	const rawBound = () => el.handlers.has("pointerrawupdate");
	/** One input row as Chromium sends it: the raw copy first while a raw listener is bound, then the move copy. */
	const row = (ts: number, opts: PenOpts) => {
		if (rawBound()) fire("pointerrawupdate", ts, opts);
		fire("pointermove", ts, opts);
	};
	return { downs, ups, fire, row, rawBound };
}

let undo: () => void;
beforeEach(() => {
	undo = installFakeWindow();
	resetTipModeForTest();
	resetSideButtonAirForTest();
});
afterEach(() => {
	resetTipModeForTest();
	resetSideButtonAirForTest();
	undo();
});

describe("Linux: the pen button pressed in a stroke and held through the lift", () => {
	it("the next landing with the button held is claimed, with buttons 3, as a lasso", () => {
		const r = rig();
		r.fire("pointerdown", 10, { buttons: 1, pressure: 0.5 }, 0);
		// The button pressed mid-stroke.
		r.fire("pointermove", 20, { buttons: 3, pressure: 0.5, x: 110 });
		// The lift with the button still held: a silent lift.
		r.fire("pointermove", 30, { buttons: 2, pressure: 0 });
		expect(r.ups, "the lift ends the stroke").toEqual([30]);
		// The landing, the button still held.
		r.fire("pointermove", 40, { buttons: 3, pressure: 0.4 });
		expect(r.downs, "the landing after the held lift was not claimed").toEqual([[10, 1], [40, 3]]);
		r.fire("pointermove", 50, { buttons: 2, pressure: 0 });
		expect(r.ups).toEqual([30, 50]);
		r.fire("pointerup", 60, { buttons: 0, pressure: 0 }, 2);
		expect(r.downs).toHaveLength(2);
	});

	it("control: a plain silent lift with no button held changes nothing; a later move row is not claimed", () => {
		const r = rig();
		r.fire("pointerdown", 10, { buttons: 1, pressure: 0.5 }, 0);
		r.fire("pointermove", 20, { buttons: 1, pressure: 0.5, x: 110 });
		r.fire("pointermove", 30, { buttons: 0, pressure: 0 });
		expect(r.ups).toEqual([30]);
		r.fire("pointermove", 40, { buttons: 1, pressure: 0.4 });
		r.fire("pointermove", 50, { buttons: 3, pressure: 0.4 });
		expect(r.downs, "a move row was claimed after a plain lift").toEqual([[10, 1]]);
	});

	it("control: the button let go in the air after the held lift: the next move row is not claimed", () => {
		const r = rig();
		r.fire("pointerdown", 10, { buttons: 1, pressure: 0.5 }, 0);
		r.fire("pointermove", 20, { buttons: 3, pressure: 0.5, x: 110 });
		r.fire("pointermove", 30, { buttons: 2, pressure: 0 });
		r.fire("pointerup", 40, { buttons: 0, pressure: 0 }, 2);
		r.fire("pointermove", 50, { buttons: 1, pressure: 0.5 });
		expect(r.downs).toEqual([[10, 1]]);
	});

	it("control: after the held lift, another pointer's landing row claims nothing; the held pointer's does", () => {
		const r = rig();
		r.fire("pointerdown", 10, { buttons: 1, pressure: 0.5, pointerId: 7 }, 0);
		r.fire("pointermove", 20, { buttons: 3, pressure: 0.5, pointerId: 7, x: 110 });
		r.fire("pointermove", 30, { buttons: 2, pressure: 0, pointerId: 7 });
		r.fire("pointermove", 40, { buttons: 3, pressure: 0.4, pointerId: 8 });
		expect(r.downs).toEqual([[10, 1]]);
		r.fire("pointermove", 50, { buttons: 3, pressure: 0.4, pointerId: 7 });
		expect(r.downs).toEqual([[10, 1], [50, 3]]);
	});

	it("control: the button pressed in the air first still lassos (issue 41)", () => {
		const r = rig();
		r.fire("pointerdown", 20, { buttons: 2, pressure: 0 }, 2);
		r.fire("pointermove", 30, { buttons: 3, pressure: 0.5 });
		expect(r.downs).toEqual([[30, 3]]);
	});
});

describe("Chromium order: the raw copy of each row comes first, and the raw stream sees the lift", () => {
	it("the button held through a lift seen first on the raw stream: the next landing is claimed as a lasso", () => {
		const r = rig();
		r.fire("pointerdown", 10, { buttons: 1, pressure: 0.5 }, 0);
		expect(r.rawBound(), "the claim binds the raw listener").toBe(true);
		// The button pressed mid-stroke.
		r.row(20, { buttons: 3, pressure: 0.5, x: 110 });
		// The lift with the button still held: the raw copy ends the stroke, the move copy is a hover row.
		r.row(30, { buttons: 2, pressure: 0 });
		expect(r.ups, "the raw copy of the lift ends the stroke").toEqual([30]);
		expect(r.rawBound(), "the stroke's end unbinds the raw listener").toBe(false);
		// Hovering with the button held, then the landing with the button still held.
		r.row(35, { buttons: 2, pressure: 0, x: 120 });
		r.row(40, { buttons: 3, pressure: 0.4 });
		expect(r.downs, "the landing after a held lift seen on the raw stream was not claimed").toEqual([[10, 1], [40, 3]]);
		// That stroke ends the same way, and the pointerup that releases the button closes it out.
		r.row(50, { buttons: 2, pressure: 0 });
		expect(r.ups).toEqual([30, 50]);
		r.fire("pointerup", 60, { buttons: 0, pressure: 0 }, 2);
		r.row(70, { buttons: 1, pressure: 0.5 });
		expect(r.downs, "a move row was claimed after the button was let go").toHaveLength(2);
	});

	it("control: a lift with no button seen first on the raw stream (the Surface Slim Pen) remembers nothing", () => {
		const r = rig();
		r.fire("pointerdown", 10, { buttons: 1, pressure: 0.5 }, 0);
		r.row(20, { buttons: 1, pressure: 0.5, x: 110 });
		r.row(30, { buttons: 0, pressure: 0 });
		expect(r.ups).toEqual([30]);
		r.row(35, { buttons: 0, pressure: 0, x: 120 });
		r.row(40, { buttons: 1, pressure: 0.4 });
		r.row(50, { buttons: 3, pressure: 0.4 });
		expect(r.downs, "a move row was claimed after a plain lift").toEqual([[10, 1]]);
	});

	it("control: after a held lift seen first on the raw stream, a hover row at pressure 0 is not claimed, and the pointerup forgets the button", () => {
		const r = rig();
		r.fire("pointerdown", 10, { buttons: 1, pressure: 0.5 }, 0);
		r.row(20, { buttons: 3, pressure: 0.5, x: 110 });
		r.row(30, { buttons: 2, pressure: 0 });
		expect(r.ups).toEqual([30]);
		// Rows in the air with the button held, one of them with the tip bit set: none has pressure, none is a landing.
		r.row(35, { buttons: 2, pressure: 0, x: 120 });
		r.row(38, { buttons: 3, pressure: 0, x: 125 });
		expect(r.downs, "a pressure-0 hover row was claimed").toEqual([[10, 1]]);
		// The button let go in the air: the next row with pressure is an ordinary move, not a landing.
		r.fire("pointerup", 45, { buttons: 0, pressure: 0 }, 2);
		r.row(50, { buttons: 3, pressure: 0.4 });
		expect(r.downs, "a move row was claimed after the pointerup let go of the button").toEqual([[10, 1]]);
	});
});
