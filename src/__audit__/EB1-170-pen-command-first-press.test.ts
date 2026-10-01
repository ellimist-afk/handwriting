/**
 * Probe for audit item 170 (finding id PenTools-1): on a pen device, the first
 * "Pen on / off" does not turn the pen off.
 *
 * Claim: penIsLit asks toolIsLit, which needs the session flag toolPicked.
 * A pen contact marks the pen hardware seen and the strip lights the Pen
 * button from that (nibIsLit's penDrawsHere: hardware seen and pen ink on),
 * but nothing sets toolPicked. So the first "Pen on / off" after launch takes
 * the pick-up branch, turns on a pen that is already on, and the user has to
 * press it again.
 *
 * Production code driven: the real penOnOff and penIsLit, the real pen-ink
 * switch (PenInk), the real toolPicked flag (MouseInk) and the real pen
 * hardware latch (PenToolsMode). The host is the stand-in
 * src/PenCommandIsOne.test.ts uses: tool "pen", no tip mode, pickPen marks the
 * tool picked.
 *
 * Asserts the CORRECT behaviour: with the pen seen and inking, the first press
 * turns pen input off. The control keeps a device that has never seen a pen
 * on the pick-up branch, as it always was, and a pen device in keyboard mode
 * (pen ink off) still picks the pen up: a seen pen is lit only while it inks.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { type PenCommandHost, penOnOff } from "../inline/PenCommand";
import { penInkEnabled, resetPenInkForTest, setPenInk } from "../inline/PenInk";
import { clearToolPicked, markToolPicked } from "../inline/MouseInk";
import { markPenHardwareSeen, resetPenToolsForTest } from "../inline/PenToolsMode";

function host(): PenCommandHost & { picks: number; flips: boolean[] } {
	const h = {
		picks: 0,
		flips: [] as boolean[],
		tool: () => "pen",
		tipMode: () => false,
		pickPen: () => {
			h.picks++;
			markToolPicked();
		},
		afterFlip: (on: boolean) => void h.flips.push(on),
	};
	return h;
}

beforeEach(() => {
	resetPenInkForTest();
	resetPenToolsForTest();
	clearToolPicked();
});

describe("audit 170 controls: the pick-up branch where the pen is not inking", () => {
	it("a device that has never seen a pen: the first press picks the pen up, as before", () => {
		const h = host();
		expect(penInkEnabled()).toBe(true);
		expect(penOnOff(h)).toBe(true);
		expect([penInkEnabled(), h.picks, h.flips]).toEqual([true, 1, [true]]);
	});

	it("a pen device in keyboard mode: the press turns the pen back on", () => {
		markPenHardwareSeen();
		setPenInk(false);
		const h = host();
		expect(penOnOff(h)).toBe(true);
		expect([penInkEnabled(), h.picks, h.flips]).toEqual([true, 1, [true]]);
	});
});

describe("audit 170 probe: the pen has written, so it is lit", () => {
	it("the first 'Pen on / off' after a pen contact turns pen input off", () => {
		markPenHardwareSeen();
		const h = host();
		const after = penOnOff(h);
		expect({ after, penInk: penInkEnabled(), picks: h.picks, flips: h.flips }).toEqual({
			after: false,
			penInk: false,
			picks: 0,
			flips: [false],
		});
	});
});
