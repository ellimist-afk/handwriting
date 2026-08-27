import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	releaseTipMode,
	resetTipModeForTest,
	setTipMode,
	setTipModeListener,
	tipMode,
	tipModeHeld,
	toggleTipMode,
} from "./TipMode";

describe("TipMode", () => {
	beforeEach(() => resetTipModeForTest());

	it("starts on the nib", () => {
		expect(tipMode()).toBe("nib");
		expect(tipModeHeld()).toBe(false);
	});

	it("only one mode can hold the tip", () => {
		// The invariant four hand-synchronised booleans existed to maintain.
		toggleTipMode("lasso", true);
		expect(tipMode()).toBe("lasso");
		toggleTipMode("pan", true);
		expect(tipMode()).toBe("pan");
		toggleTipMode("eraser", true);
		expect(tipMode()).toBe("eraser");
		expect(tipModeHeld()).toBe(true);
	});

	it("turning a mode off returns the tip to the nib", () => {
		toggleTipMode("space", true);
		toggleTipMode("space", false);
		expect(tipMode()).toBe("nib");
	});

	it("turning OFF a mode that is not holding the tip changes nothing", () => {
		// setEraser(false) while lassoing must not cancel the lasso.
		toggleTipMode("lasso", true);
		toggleTipMode("eraser", false);
		expect(tipMode()).toBe("lasso");
	});

	it("releasing hands the tip back from whichever mode held it", () => {
		for (const kind of ["eraser", "lasso", "space", "pan"] as const) {
			toggleTipMode(kind, true);
			releaseTipMode();
			expect(tipMode()).toBe("nib");
		}
	});

	it("announces every change, so other panes' strips can catch up", () => {
		// Modes are global: pressing escape in one pane left another pane's
		// toolbar lighting a tool that no longer had the tip.
		const seen = vi.fn();
		setTipModeListener(seen);
		toggleTipMode("pan", true);
		expect(seen).toHaveBeenCalledTimes(1);
		releaseTipMode();
		expect(seen).toHaveBeenCalledTimes(2);
	});

	it("says nothing when the mode did not actually change", () => {
		const seen = vi.fn();
		toggleTipMode("pan", true);
		setTipModeListener(seen);
		setTipMode("pan");
		toggleTipMode("pan", true);
		expect(seen).not.toHaveBeenCalled();
	});
});
