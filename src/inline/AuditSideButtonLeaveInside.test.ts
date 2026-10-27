/**
 * The one-time "click while hovering" note and a pen pointerleave that does not leave the pane.
 *
 * The pen leave handler cancels a side button press and shows the note before it reads whether the pen moved to an element
 * still inside the scroller. A leave onto a child of the pane is not the held touch Android takes, yet it spends the press
 * and the device's one note, so the first real held touch later shows nothing.
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
import { resetSideButtonAirForTest } from "./SideButtonAir";
import { AIR_HINT_SHOWN_KEY, resetTipModeForTest, restoreSideButtonErases, setSideButtonStore } from "./TipMode";

let local: Map<string, unknown>;

describe("a pen leave onto an element inside the pane, with the side button held in the air", () => {
	const wasAndroid = Platform.isAndroidApp;

	beforeEach(() => {
		resetTipModeForTest();
		resetSideButtonAirForTest();
		Platform.isAndroidApp = true;
		notices.length = 0;
		local = new Map();
		setSideButtonStore({ load: (key) => local.get(key) ?? null, save: (key, value) => void local.set(key, value), defaultErases: true });
		restoreSideButtonErases();
	});
	afterEach(() => {
		Platform.isAndroidApp = wasAndroid;
		resetTipModeForTest();
		resetSideButtonAirForTest();
	});

	it("control: a leave off the pane in the middle of a press shows the note", () => {
		const undo = installFakeWindow();
		try {
			const h = harness();
			h.fire(penEvent("pointermove", 10, { buttons: 0, pressure: 0 }));
			h.fire(penEvent("pointermove", 20, { buttons: 1, pressure: 0 }));
			h.fire({ ...penEvent("pointerleave", 30, { buttons: 1, pressure: 0 }), relatedTarget: null } as unknown as PointerEvent);
			expect(notices.length).toBe(1);
		} finally {
			undo();
		}
	});

	it("shows no note and keeps the device's note for the real held touch", () => {
		const undo = installFakeWindow();
		try {
			const h = harness();
			(h.el as unknown as { nodeType: number }).nodeType = 1;
			h.fire(penEvent("pointermove", 10, { buttons: 0, pressure: 0 }));
			h.fire(penEvent("pointermove", 20, { buttons: 1, pressure: 0 }));
			// The pen moves onto an element the pane holds: still inside.
			h.fire({ ...penEvent("pointerleave", 30, { buttons: 1, pressure: 0 }), relatedTarget: h.el } as unknown as PointerEvent);
			expect(notices, "a leave that stays inside the pane").toEqual([]);
			expect(local.has(AIR_HINT_SHOWN_KEY), "the device's one note is not spent").toBe(false);
		} finally {
			undo();
		}
	});
});
