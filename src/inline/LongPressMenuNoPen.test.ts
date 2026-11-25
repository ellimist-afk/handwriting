/**
 * The finger long-press menu on the writing surface, on a device with no pen.
 *
 * The scroller's contextmenu handler blocks a touch long-press as a
 * "stabilizing hand" once a pen is about. It used to read only the strip's
 * flag, `penSeenThisSession()`, which every tool pick sets with no pen at all
 * (the Highlighter command, a colour, a preset chip, Pen on, mouse ink). So on
 * a touch device that had never held a pen, one tool pick ended the finger's
 * long-press menu in every note and PDF until restart.
 *
 * The rule now: the strip's flag AND the device latch `penHardwareEverSeen()`.
 * A device that has never seen a pen keeps its menu whatever is picked. A
 * device that has seen a pen does exactly what it did before. The live-stroke,
 * ownership-tail and pen-near terms are untouched, for every pointer type.
 *
 * Driven through the router's real registered handler, as
 * InkFeedRouting.test.ts does; no jsdom.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	clearPenHardwareSeen,
	markPenHardwareSeen,
	markPenSeen,
	penHardwareEverSeen,
	penHardwareSeen,
	penSeenThisSession,
	resetPenToolsForTest,
	restorePenHardwareEverSeen,
} from "./PenToolsMode";
import { harness, installFakeWindow } from "../../test/routerHarness";

let uninstallWindow: () => void = () => {};
beforeAll(() => {
	uninstallWindow = installFakeWindow();
});
afterAll(() => {
	uninstallWindow();
});

let h: ReturnType<typeof harness>;
beforeEach(() => {
	resetPenToolsForTest();
	h = harness();
});
afterEach(() => {
	h.router.activePenId = null;
	h.router.ownershipTailUntil = 0;
	h.router.dispose();
	resetPenToolsForTest();
});

/** Fire one contextmenu at the scroller; return how many times it was prevented. */
function menu(pointerType: string): number {
	let prevented = 0;
	const ev = {
		type: "contextmenu",
		pointerType,
		preventDefault: () => void prevented++,
		stopPropagation: () => {},
	} as unknown as PointerEvent;
	h.fire(ev);
	return prevented;
}

/** A tool pick on a device with no pen: what every no-pen setter of the strip flag does. */
function pickTool(): void {
	markPenSeen();
}

describe("touch long-press menu, device that has never seen a pen", () => {
	it("a tool pick (Highlighter) does not block the finger's menu", () => {
		pickTool();
		// The premise, so a green here cannot come from a setup that never set the flag.
		expect(penSeenThisSession(), "strip flag set by the pick").toBe(true);
		expect(penHardwareEverSeen(), "no pen ever on this device").toBe(false);
		expect(menu("touch"), "touch long-press menu blocked after a tool pick on a pen-less device").toBe(0);
	});

	it("nothing picked: the menu stays", () => {
		expect(menu("touch")).toBe(0);
	});

	it("several picks in a row still leave the menu", () => {
		pickTool();
		pickTool();
		expect(menu("touch")).toBe(0);
		expect(menu("touch")).toBe(0);
	});
});

describe("touch long-press menu, device that has seen a pen (as before)", () => {
	it("latch restored at load + strip flag: blocked", () => {
		restorePenHardwareEverSeen();
		pickTool();
		expect(penHardwareSeen(), "no pen contact this session").toBe(false);
		expect(menu("touch")).toBe(1);
	});

	it("pen contact, then mouse ink off: still blocked (the latch, not the present-tense flag)", () => {
		markPenHardwareSeen();
		pickTool();
		clearPenHardwareSeen();
		expect(penHardwareSeen(), "present-tense flag cleared").toBe(false);
		expect(penHardwareEverSeen(), "latch kept").toBe(true);
		expect(menu("touch")).toBe(1);
	});

	it("latch true, strip flag false: the menu stays", () => {
		restorePenHardwareEverSeen();
		expect(penSeenThisSession()).toBe(false);
		expect(menu("touch")).toBe(0);
	});
});

describe("stroke, tail and pen-near terms are untouched", () => {
	type Cond = "stroke" | "tail" | "near";
	const arm: Record<Cond, () => void> = {
		stroke: () => {
			h.router.activePenId = 7;
		},
		tail: () => {
			h.router.ownershipTailUntil = performance.now() + 60_000;
		},
		near: () => {
			h.router.gate.penHoverSeen(performance.now());
		},
	};
	const rows: [Cond, string, boolean, boolean][] = [];
	for (const cond of ["stroke", "tail", "near"] as Cond[])
		for (const pt of ["touch", "pen", "mouse"])
			for (const latch of [false, true])
				for (const strip of [false, true]) rows.push([cond, pt, latch, strip]);

	it.each(rows)("%s, %s, latch %s, strip flag %s: blocked", (cond, pt, latch, strip) => {
		if (latch) restorePenHardwareEverSeen();
		if (strip) pickTool();
		arm[cond]();
		expect(menu(pt)).toBe(1);
	});

	it("with none of them armed, a mouse keeps its menu and a pen does not", () => {
		pickTool();
		expect(menu("mouse")).toBe(0);
		expect(menu("pen")).toBe(1);
	});
});
