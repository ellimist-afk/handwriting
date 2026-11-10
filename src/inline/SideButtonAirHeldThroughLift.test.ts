/**
 * Android: the pen button pressed during a stroke, held through the lift and let go in the air, is not a click.
 *
 * The air-click machine (SideButtonAir.ts) is fed only hover rows, so nothing reaches it while a stroke is live. The
 * stroke's own pointerdown found the machine idle, so it cancelled nothing; the first hover row after the lift, with
 * the button still held (buttons 1, pressure 0), then armed a press, and the release row (buttons 0) completed a click
 * and flipped the tip to the eraser. The next stroke erased.
 *
 * After any contact a click arms only from a buttons-0 hover row: a button already down when the pen comes off the
 * glass belongs to the contact, not to a click in the air.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Platform } from "obsidian";

import { harness, installFakeWindow, penEvent } from "../../test/routerHarness";
import { resetSideButtonAirForTest, sideButtonAirHover, sideButtonAirInterrupt } from "./SideButtonAir";
import { resetTipModeForTest, setTipModeListener, tipMode } from "./TipMode";

type Row = [buttons: number, pressure: number];
const up: Row = [0, 0];
const held: Row = [1, 0];

let notified = 0;
let lines: string[] = [];
let clock = 0;

function feed(rows: Row[]): void {
	for (const [buttons, pressure] of rows) {
		clock += 10;
		const line = sideButtonAirHover("pen", buttons, pressure, clock);
		if (line !== null) lines.push(line);
	}
}

function interrupt(leave = false): string | null {
	const line = sideButtonAirInterrupt(leave);
	if (line !== null) lines.push(line);
	return line;
}

describe("the pen button held through a lift (Android)", () => {
	const wasAndroid = Platform.isAndroidApp;
	let undoWindow: () => void;

	beforeAll(() => {
		undoWindow = installFakeWindow();
	});
	afterAll(() => undoWindow());

	beforeEach(() => {
		resetTipModeForTest();
		resetSideButtonAirForTest();
		Platform.isAndroidApp = true;
		notified = 0;
		lines = [];
		clock = 0;
		setTipModeListener(() => void notified++);
	});
	afterEach(() => {
		Platform.isAndroidApp = wasAndroid;
		resetTipModeForTest();
		resetSideButtonAirForTest();
	});

	it("a contact, then the button held after the lift and let go in the air: no switch", () => {
		feed([up]);
		expect(interrupt(), "the contact found no press, so it writes no line").toBeNull();
		feed([held, held, up]);
		expect(tipMode(), "the tip flipped after a lift with the button held").toBe("nib");
		expect(notified).toBe(0);
		expect(lines).toEqual([]);
	});

	it("control: after a contact, a buttons-0 row, then a plain click in the air switches", () => {
		interrupt();
		feed([up, held, up]);
		expect(tipMode()).toBe("eraser");
		expect(notified).toBe(1);
		expect(lines).toEqual(["side button in the air: nib -> eraser"]);
	});

	it("control: the release after the held lift arms nothing, and the next plain click switches", () => {
		interrupt();
		feed([held, up]);
		expect(tipMode()).toBe("nib");
		feed([held, up]);
		expect(tipMode()).toBe("eraser");
		expect(notified).toBe(1);
	});

	it("control: a press ended by a contact stays spent, and only that press writes the line", () => {
		feed([up, held]);
		expect(interrupt()).toBe("side button held into a touch: no switch");
		expect(interrupt(), "a second contact with no press in progress").toBeNull();
		feed([held, up]);
		expect(tipMode()).toBe("nib");
		expect(lines).toEqual(["side button held into a touch: no switch"]);
	});

	it("control: a press ended by a leave stays spent; a leave with no press writes no line", () => {
		feed([up]);
		expect(interrupt(true)).toBeNull();
		feed([up, held]);
		expect(interrupt(true)).toBe("side button held into a touch: no switch");
		feed([held, up]);
		expect(tipMode()).toBe("nib");
		expect(notified).toBe(0);
	});
});

describe("the router: the pen button held through a lift (Android)", () => {
	const wasAndroid = Platform.isAndroidApp;
	let undoWindow: () => void;

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

	const hover = (ts: number, buttons: number) => penEvent("pointermove", ts, { buttons, pressure: 0 });

	it("a stroke, the button pressed in it and held through the lift, let go in the air: the tip stays the pen", () => {
		const h = harness();
		h.fire(hover(10, 0));
		h.fire(penEvent("pointerdown", 20, { buttons: 1, pressure: 0.4 }));
		h.fire(penEvent("pointermove", 30, { buttons: 1, pressure: 0.45, x: 110 }));
		h.fire(penEvent("pointerup", 40, { buttons: 0, pressure: 0 }));
		h.fire(hover(50, 1));
		h.fire(hover(60, 1));
		h.fire(hover(70, 0));
		expect(tipMode(), "the next stroke would erase").toBe("nib");
		// A plain click in the air after it still switches.
		h.fire(hover(80, 1));
		h.fire(hover(90, 0));
		expect(tipMode()).toBe("eraser");
	});
});
