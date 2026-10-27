/**
 * The side button in the air, as the device settings shape it: the on/off
 * switch (Android, on by default, kept on this device) and the one-time note
 * shown the first time Android takes a touch made with the button held.
 *
 * The note's moment is the held touch: the pen hovered with the button down
 * and then left the page without a contact arriving (a pen pointerleave in the
 * middle of a press). A pointerdown in the middle of a press is a real contact
 * and shows nothing. The note is shown once per device, and never while the
 * switch is off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const notices = vi.hoisted(() => [] as string[]);
vi.mock("obsidian", async (importOriginal) => {
	const real = await importOriginal<Record<string, unknown>>();
	return {
		...real,
		Notice: class {
			constructor(text: string) {
				notices.push(text);
			}
		},
	};
});

import { Platform } from "obsidian";
import { harness, installFakeWindow, penEvent } from "../../test/routerHarness";
import { resetSideButtonAirForTest, sideButtonAirHover, sideButtonAirInterrupt } from "./SideButtonAir";
import {
	AIR_HINT_SHOWN_KEY, resetTipModeForTest, restoreSideButtonErases, saveAirSwitch, setSideButtonStore, tipMode,
} from "./TipMode";

const HINT = "Click the pen button while hovering over the screen to switch pen and eraser.";

let local: Map<string, unknown>;
let clock = 0;

function device(stored: Array<[string, unknown]> = []): void {
	local = new Map(stored);
	setSideButtonStore({
		load: (key) => local.get(key) ?? null,
		save: (key, value) => void local.set(key, value),
		defaultErases: true,
	});
	restoreSideButtonErases();
}

function rows(...buttons: number[]): void {
	for (const b of buttons) sideButtonAirHover("pen", b, 0, (clock += 10));
}

/** Press in the air, then the held touch: the pen leaves with the button still down. */
function heldTouch(): void {
	rows(0, 1);
	sideButtonAirInterrupt(true);
	rows(0);
}

describe("side button in the air: device switch and one-time note", () => {
	const wasAndroid = Platform.isAndroidApp;

	beforeEach(() => {
		resetTipModeForTest();
		resetSideButtonAirForTest();
		Platform.isAndroidApp = true;
		notices.length = 0;
		clock = 0;
		device();
	});
	afterEach(() => {
		Platform.isAndroidApp = wasAndroid;
		resetTipModeForTest();
		resetSideButtonAirForTest();
	});

	it("switch off: a click in the air does nothing", () => {
		saveAirSwitch(false);
		rows(0, 1, 0);
		expect(tipMode()).toBe("nib");
	});

	it("switch off: a press in the air arms nothing: rows null, the interrupt null, tip unchanged", () => {
		saveAirSwitch(false);
		expect([sideButtonAirHover("pen", 0, 0, 10), sideButtonAirHover("pen", 1, 0, 20)]).toEqual([null, null]);
		expect(sideButtonAirInterrupt(true), "an off switch arms no press").toBeNull();
		expect(sideButtonAirHover("pen", 0, 0, 30)).toBeNull();
		expect(tipMode()).toBe("nib");
	});

	it("switch back on: a click in the air switches again", () => {
		saveAirSwitch(false);
		saveAirSwitch(true);
		rows(0, 1, 0);
		expect(tipMode()).toBe("eraser");
	});

	it("the first held touch shows the note once, and records it on this device", () => {
		heldTouch();
		expect(notices).toEqual([HINT]);
		expect(local.get(AIR_HINT_SHOWN_KEY)).toBe("true");
		heldTouch();
		expect(notices, "never again").toEqual([HINT]);
	});

	it("a device that has shown the note never shows it again after a reload", () => {
		resetTipModeForTest();
		device([[AIR_HINT_SHOWN_KEY, "true"]]);
		heldTouch();
		expect(notices).toEqual([]);
	});

	it("once per session even when the device store cannot save", () => {
		setSideButtonStore({
			load: () => null,
			save: () => {
				throw new Error("denied");
			},
			defaultErases: true,
		});
		heldTouch();
		heldTouch();
		expect(notices).toEqual([HINT]);
	});

	it("a pointerdown in the middle of a press is a contact, not the held touch: no note", () => {
		rows(0, 1);
		sideButtonAirInterrupt();
		rows(0);
		expect(notices).toEqual([]);
		expect(local.has(AIR_HINT_SHOWN_KEY)).toBe(false);
	});

	it("switch off: the held touch shows no note", () => {
		saveAirSwitch(false);
		heldTouch();
		expect(notices).toEqual([]);
	});

	it("a click in the air shows no note", () => {
		rows(0, 1, 0);
		expect(tipMode()).toBe("eraser");
		expect(notices).toEqual([]);
	});

	it("not Android: no note", () => {
		Platform.isAndroidApp = false;
		heldTouch();
		expect(notices).toEqual([]);
	});

	it("through the router: a pen leave in the middle of a press shows the note, a pointerdown does not", () => {
		const undo = installFakeWindow();
		try {
			const hover = (type: string, ts: number, buttons: number) => penEvent(type, ts, { buttons, pressure: 0 });
			const h = harness();
			h.fire(hover("pointermove", 10, 0));
			h.fire(hover("pointermove", 20, 1));
			h.fire(penEvent("pointerdown", 30, { buttons: 1, pressure: 0.4 }));
			h.fire(penEvent("pointerup", 40, { buttons: 0, pressure: 0 }));
			h.fire(hover("pointermove", 50, 0));
			expect(notices, "pointerdown: no note").toEqual([]);
			h.fire(hover("pointermove", 60, 1));
			h.fire({ ...penEvent("pointerleave", 70, { buttons: 1, pressure: 0 }), relatedTarget: null } as unknown as PointerEvent);
			h.fire(hover("pointermove", 80, 0));
			expect(notices).toEqual([HINT]);
			expect(tipMode()).toBe("nib");
		} finally {
			undo();
		}
	});
});
