import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	penContactIntent,
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

	it("fires on a change to the nib, same as any other mode", () => {
		// §5o: InkOverlay's listener has to see a switch BACK to the plain
		// pen too, since that is the tool change that must dissolve a
		// selection - not just a switch into eraser/pan/space.
		toggleTipMode("lasso", true);
		const seen = vi.fn();
		setTipModeListener(seen);
		setTipMode("nib");
		expect(seen).toHaveBeenCalledTimes(1);
		expect(tipMode()).toBe("nib");
	});
});

/**
 * The arbitration both ink surfaces used to implement for themselves. These
 * cases are written from the two hand-written copies this replaced - the note
 * surface's `eraserEnd`/`eraser`/`side` triple and the pdf surface's
 * `eraserEnd`/`this.erasing`/`sideHeld` triple - so a change that broke either
 * one's old answer fails here rather than on hardware.
 */
describe("penContactIntent - one arbitration for both ink surfaces", () => {
	it("a bare tip in nib mode inks", () => {
		expect(penContactIntent(0, -1, "nib")).toBe("ink");
		expect(penContactIntent(1, 0, "nib")).toBe("ink");
	});

	it("the eraser end erases whatever the strip is set to", () => {
		// `buttons & 32` is the eraser held; `button === 5` is the transition
		// that reports it. Both were in both surfaces' copies.
		for (const m of ["nib", "lasso", "pan", "space"] as const) {
			expect(penContactIntent(32, -1, m)).toBe("erase");
			expect(penContactIntent(0, 5, m)).toBe("erase");
		}
	});

	it("eraser mode erases a bare tip, for hardware with no eraser end", () => {
		expect(penContactIntent(0, -1, "eraser")).toBe("erase");
		expect(penContactIntent(1, 0, "eraser")).toBe("erase");
	});

	it("the side button lassos, and eraser still beats it", () => {
		expect(penContactIntent(2, -1, "nib")).toBe("lasso");
		// The note surface wrote this as `!eraser && (button2 || lasso mode)`
		// and the pdf as `!this.erasing && (sideHeld || lasso mode)`. Same
		// precedence, and this is the case that proves it survived.
		expect(penContactIntent(34, -1, "nib")).toBe("erase");
		expect(penContactIntent(2, 5, "nib")).toBe("erase");
		expect(penContactIntent(2, -1, "eraser")).toBe("erase");
	});

	it("lasso mode lassos a bare tip - the apple pencil path", () => {
		expect(penContactIntent(0, -1, "lasso")).toBe("lasso");
		expect(penContactIntent(1, 0, "lasso")).toBe("lasso");
	});

	it("pan and space only reach a tip no button has spoken for", () => {
		expect(penContactIntent(0, -1, "pan")).toBe("pan");
		expect(penContactIntent(0, -1, "space")).toBe("space");
		expect(penContactIntent(32, -1, "pan")).toBe("erase");
		expect(penContactIntent(2, -1, "pan")).toBe("lasso");
		expect(penContactIntent(32, -1, "space")).toBe("erase");
		expect(penContactIntent(2, -1, "space")).toBe("lasso");
	});

	it("the pdf's no-event call gives the mode the tip, alone", () => {
		// `penDown(sample)` with no PointerEvent happens on that surface's own
		// teardown paths. Its old ternaries computed false for both button
		// tests; `?? 0` and `?? -1` have to reproduce exactly that. -1 in
		// particular: `button === 5` must not fire, and 0 would be the primary
		// button, which is a different claim.
		expect(penContactIntent(0, -1, "nib")).toBe("ink");
		expect(penContactIntent(0, -1, "eraser")).toBe("erase");
		expect(penContactIntent(0, -1, "lasso")).toBe("lasso");
	});
});
