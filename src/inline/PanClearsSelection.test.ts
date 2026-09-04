/**
 * Entering pan mode puts a live selection away, on every surface that HAS a
 * pan mode (alan, 2026-09-02: "clear the selection when yu enter pan mode",
 * then "put that on all surfaces").
 *
 * Why the ruling exists: 1.4.8-pdf-rulings gave the pdf and canvas surfaces
 * the note surface's OneNote grammar, where a bare tip landing inside a live
 * selection drags it. That branch sits ABOVE the pan branch in both
 * `InkOverlayPlugin.penDown` and `PdfInkController.penDown` - deliberately,
 * and both say so in a comment - so with the strip in pan mode a tip inside a
 * selection dragged the selection instead of panning the page. The reference
 * apps have no such ambiguity because choosing the hand tool clears the
 * selection; selecting and panning are exclusive. Alan took that over a
 * setting.
 *
 * The mode change itself was already covered: §5o (2026-09-02) dissolves the
 * selection on ANY tip-mode change away from lasso, and pan is not lasso, so
 * `setInlinePanMode(true)` already reached both surfaces' selections. What it
 * did not reach was the note surface's STRIP. The §5o listener refreshes the
 * strip BEFORE it dissolves, and the note's `dissolveSelection` - unlike the
 * pdf's, which ends in `refreshStrip()` - only redraws the tail canvas. So
 * picking up Pan with ink selected cleared the selection and left Delete and
 * Copy lit on the strip, gated as they are on `hasInkSelection()`. A control
 * that looks alive and does nothing is the exact thing Alan ruled against on
 * 2026-08-30.
 *
 * `pasteInkHere` is the symmetric witness: it selects what it pasted and then
 * calls `this.mobileTools?.refresh()` on the next line, precisely so the two
 * buttons light UP. Nothing did the same on the way back down.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	InkOverlayPlugin,
	addStripSurface,
	getInlinePanMode,
	releaseTipModes,
	setInlineLassoMode,
	setInlinePanMode,
} from "./InkOverlay";
import { SelectionModel } from "../objects/SelectionModel";
import { tipMode } from "./TipMode";

/**
 * The note surface's `dissolveSelection`, on the real prototype.
 *
 * Object.create skips field initialisers, so the selection model is the real
 * class built here rather than a stand-in for `isEmpty` - the same idiom
 * InlineEraserSelection.test.ts uses. `redrawSelectionUI` is stubbed because
 * it reaches the tail canvas and is not the subject; the strip is.
 */
function makeNoteRig() {
	const view = Object.create(InkOverlayPlugin.prototype) as Record<string, unknown>;
	const refresh = vi.fn();
	const selection = new SelectionModel();
	selection.selectExactly(["s1"]);
	view.selection = selection;
	view.mobileTools = { refresh };
	view.redrawSelectionUI = () => undefined;

	const proto = InkOverlayPlugin.prototype as unknown as {
		dissolveSelection(this: unknown): void;
	};
	return {
		selection,
		refresh,
		dissolve: () => proto.dissolveSelection.call(view),
	};
}

describe("entering pan mode and the live selection", () => {
	// NOT resetTipModeForTest: that nulls the ONE listener singleton
	// InkOverlay installs at module-import time, which is the production
	// wiring these tests are here to exercise (the same trap
	// PdfInkController.test.ts documents at length). releaseTipModes puts the
	// mode back to "nib" through the real seam and leaves the listener alone.
	beforeEach(() => releaseTipModes());

	it("the note surface's dissolve leaves the strip agreeing with the selection", () => {
		const rig = makeNoteRig();
		// Preconditions, so this cannot pass because nothing ran.
		expect(rig.selection.isEmpty).toBe(false);
		expect(rig.refresh).not.toHaveBeenCalled();

		rig.dissolve();

		expect(rig.selection.isEmpty).toBe(true);
		// The strip is gated on hasInkSelection(); without this, Delete and
		// Copy stay lit over a selection that is gone.
		expect(rig.refresh).toHaveBeenCalledTimes(1);
	});

	it("dissolving nothing does not churn the strip", () => {
		const rig = makeNoteRig();
		rig.selection.clear();
		expect(rig.selection.isEmpty).toBe(true);

		rig.dissolve();

		// The §5o listener already refreshed every strip before it dissolved.
		// A second unconditional refresh on every tool change would be waste.
		expect(rig.refresh).not.toHaveBeenCalled();
	});

	it("entering pan from lasso notifies every REGISTERED tip-mode listener", () => {
		// NAMED FOR WHAT IT PROVES. This registers its own listener and
		// asserts that listener fires, so it pins the `addStripSurface`
		// dispatch - not which surfaces production hands it.
		//
		// Production's DISSOLVE callback walks PDFs only (main.ts, the second
		// of addStripSurface's callbacks:
		// `for (const c of this.pdfInk.values()) c.dissolveSelection()`).
		// The canvas is NOT absent from the registration - the render-settings
		// callback below it walks HandwritingPageView too - it is absent from
		// the DISSOLVE branch specifically. So a canvas selection survives into
		// pan mode and the tip drags instead of panning: the open half of
		// Alan's own ruling, filed at 1.4.9-design.md §15.11 and deliberately
		// NOT authorised. The fix is one line in that branch, not a new
		// registration - which is exactly the overcorrection this note prevents.
		//
		// The earlier name said "every registered surface", which reads as
		// coverage of all of them and put a green test over a known gap. A
		// test may prove a mechanism rather than its callers; it may not be
		// named as though it proved both.
		const onTipMode = vi.fn();
		const undo = addStripSurface(() => undefined, onTipMode);
		try {
			setInlineLassoMode(true);
			// The transition really happened, and from a mode that HOLDS a
			// selection.
			expect(tipMode()).toBe("lasso");
			onTipMode.mockClear();

			setInlinePanMode(true);

			expect(getInlinePanMode()).toBe(true);
			expect(onTipMode).toHaveBeenCalledTimes(1);
		} finally {
			undo();
		}
	});

	it("pan to pan does not dissolve again", () => {
		// Alan's edge: only ENTERING pan clears. Already-pan must not, or a
		// selection made with the side button while panning - the one route
		// into a selection that needs no tool change - would be taken away by
		// a redundant tap on a tool already held.
		const onTipMode = vi.fn();
		const undo = addStripSurface(() => undefined, onTipMode);
		try {
			setInlinePanMode(true);
			expect(tipMode()).toBe("pan");
			onTipMode.mockClear();

			setInlinePanMode(true);

			expect(tipMode()).toBe("pan");
			expect(onTipMode).not.toHaveBeenCalled();
		} finally {
			undo();
		}
	});
});
