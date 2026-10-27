/**
 * The S Pen side button pressed and released in the air switches the tip
 * between pen and eraser, on Android only (GitHub issue 45).
 *
 * Android gives a pen contact that begins with the button held to the
 * browser's own text selection and never forwards it, so the in-contact
 * `buttons & 2` read in `penContactIntent` cannot fire there. What the page
 * does see is the hover stream: rows with buttons 0, then 1 while the button
 * is held, then 0 again. That press-and-release with no contact between is
 * the one signal that avoids the selection popup, and it is what this state
 * machine turns into a switch.
 *
 * These cells drive the state machine with the rows the device trace showed
 * (defects/issue-45-s-pen-side-button-20261020/READ-trace-ff7102b5.md item 4).
 * The router feeds are held by SideButtonAirRouter.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Platform } from "obsidian";

import { resetSideButtonAirForTest, sideButtonAirHover, sideButtonAirInterrupt } from "./SideButtonAir";
import { resetTipModeForTest, setTipMode, setTipModeListener, tipMode } from "./TipMode";

/** One hover row, as the router hands it over: pointer type, buttons, pressure. */
type Row = [pointerType: string, buttons: number, pressure: number];
const up: Row = ["pen", 0, 0];
const held: Row = ["pen", 1, 0];

let notified = 0;
let lines: string[] = [];
/** Event clock for rows fed without a stamp: each such row is 10 ms after the last. */
let clock = 0;

function feed(rows: Row[]): void {
	for (const [pointerType, buttons, pressure] of rows) {
		clock += 10;
		const line = sideButtonAirHover(pointerType, buttons, pressure, clock);
		if (line !== null) lines.push(line);
	}
}

/** Rows with their own event stamps, as the device delivered them. */
function feedAt(rows: Array<[buttons: number, timeStamp: number]>): void {
	for (const [buttons, timeStamp] of rows) {
		const line = sideButtonAirHover("pen", buttons, 0, timeStamp);
		if (line !== null) lines.push(line);
	}
}

function interrupt(): void {
	const line = sideButtonAirInterrupt();
	if (line !== null) lines.push(line);
}

describe("side button pressed in the air (Android)", () => {
	const wasAndroid = Platform.isAndroidApp;

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

	it("(a) a press and release in the air switches the pen to the eraser, once", () => {
		feed([up, held, held, up]);
		expect(tipMode()).toBe("eraser");
		expect(notified).toBe(1);
		expect(lines).toEqual(["side button in the air: nib -> eraser"]);
	});

	it("(b) a second press and release switches back to the pen", () => {
		feed([up, held, held, up]);
		feed([held, up]);
		expect(tipMode()).toBe("nib");
		expect(notified).toBe(2);
		expect(lines).toEqual(["side button in the air: nib -> eraser", "side button in the air: eraser -> nib"]);
	});

	it("(b2) a release row delivered twice (pointermove and pointerrawupdate) switches once", () => {
		feed([up, held, held, up, up]);
		expect(tipMode()).toBe("eraser");
		expect(notified).toBe(1);
	});

	it("(c) a press ended by a pointerleave (the held touch Android takes) does not switch", () => {
		feed([up, held]);
		interrupt();
		feed([held, up]);
		expect(tipMode()).toBe("nib");
		expect(notified).toBe(0);
		expect(lines).toEqual(["side button held into a touch: no switch"]);
	});

	it("(d) a press ended by a pointerdown does not switch", () => {
		feed([up, held]);
		interrupt();
		feed([up]);
		expect(tipMode()).toBe("nib");
		expect(notified).toBe(0);
		expect(lines).toEqual(["side button held into a touch: no switch"]);
	});

	it("(d2) an interrupt with no press held writes no line", () => {
		feed([up]);
		interrupt();
		expect(lines).toEqual([]);
	});

	it("(e) not Android: the same rows do nothing", () => {
		Platform.isAndroidApp = false;
		feed([up, held, held, up]);
		expect(tipMode()).toBe("nib");
		expect(notified).toBe(0);
		expect(lines).toEqual([]);
	});

	it("(e2) a mouse or a finger with button 1 in hover does nothing", () => {
		feed([["mouse", 0, 0], ["mouse", 1, 0], ["mouse", 0, 0]]);
		feed([["touch", 0, 0], ["touch", 1, 0], ["touch", 0, 0]]);
		expect(tipMode()).toBe("nib");
		expect(notified).toBe(0);
	});

	it("(g) a pressed row with pressure above 0 is a landing contact, not a press in the air", () => {
		feed([up, ["pen", 1, 0.2], up]);
		expect(tipMode()).toBe("nib");
		expect(notified).toBe(0);
		feed([up, held, ["pen", 1, 0.2], up]);
		expect(tipMode()).toBe("nib");
		expect(notified).toBe(0);
	});

	it("(h) from lasso, a press in the air gives the eraser", () => {
		setTipMode("lasso");
		notified = 0;
		feed([up, held, up]);
		expect(tipMode()).toBe("eraser");
		expect(notified).toBe(1);
		expect(lines).toEqual(["side button in the air: lasso -> eraser"]);
	});

	it("(h2) from insert space and from pan, a press in the air gives the eraser", () => {
		for (const from of ["space", "pan"] as const) {
			setTipMode(from);
			feed([up, held, up]);
			expect(tipMode()).toBe("eraser");
		}
	});
	// Trace ff7102b5 at 24.500 s (Galaxy Tab S9+): the pointerrawupdate release (2:3113, buttons 0, stamp 726235.2)
	// came first, then a pointermove row still pressed but OLDER (2:3114, buttons 1, stamp 726231), then the
	// pointermove copy of the release (2:3115, buttons 0, stamp 726235.2). The two streams do not keep each
	// other's order; the event stamps do.
	it("(j) a clean click with a late press copy between two copies of its release switches once", () => {
		feedAt([[0, 726000], [1, 726100], [1, 726200], [0, 726235.2], [1, 726231], [0, 726235.2]]);
		expect(tipMode()).toBe("eraser");
		expect(notified).toBe(1);
		expect(lines).toEqual(["side button in the air: nib -> eraser"]);
	});

	it("(i) the trace's three rows after a spent press (the held touch) do not switch, null each", () => {
		feedAt([[0, 721000], [1, 721263]]);
		interrupt(); // the pen pointerleave at 721659
		feedAt([[1, 724000], [0, 726235.2], [1, 726231], [0, 726235.2]]);
		expect(tipMode()).toBe("nib");
		expect(notified).toBe(0);
		expect(lines).toEqual(["side button held into a touch: no switch"]);
	});
	it("(k) equal stamps on both streams: one switch", () => {
		feedAt([[0, 100], [1, 200], [1, 200], [0, 300], [0, 300]]);
		expect(tipMode()).toBe("eraser");
		expect(notified).toBe(1);
		expect(lines).toEqual(["side button in the air: nib -> eraser"]);
	});

	it("(l) a dropped row changes no state: the press it arrived inside still clicks on the real release", () => {
		feedAt([[0, 100], [1, 200]]);
		// A release copy older than the press already fed: dropped, null, the press stays armed.
		expect(sideButtonAirHover("pen", 0, 0, 150)).toBeNull();
		expect(tipMode()).toBe("nib");
		expect(sideButtonAirHover("pen", 0, 0, 300)).toBe("side button in the air: nib -> eraser");
		expect(notified).toBe(1);
	});
	it("(k2) a release that shares its press's stamp is a different row and still clicks", () => {
		feedAt([[0, 100], [1, 200], [0, 200]]);
		expect(lines).toEqual(["side button in the air: nib -> eraser"]);
		expect(tipMode()).toBe("eraser");
	});

	it("(l2) a dropped row does not move the clock back, so a second late row is dropped too", () => {
		feedAt([[0, 100], [1, 200], [0, 300], [1, 250], [1, 260], [0, 300]]);
		expect(lines).toEqual(["side button in the air: nib -> eraser"]);
		expect(tipMode()).toBe("eraser");
	});
});
