/**
 * The QUIET put-down path's repaint reaches every open strip too, not just
 * the one the pointer clicked.
 *
 * Second half of this session's Bug 1 (hardware finding, 2026-09-03: "you
 * have to tap a couple times for pen to light"). `releaseMouseInkQuietly`
 * (PenToolsMode.ts) is called from the strip's own put-down
 * (`host.disarmMouseInkQuietly`, MobileTools.ts's "PUTTING IT DOWN" branch,
 * b93edd1) and does no fan-out of its own by design - it changes no
 * surface's existence, only how a strip draws, and leaves the repaint to its
 * callers (its own doc comment says so). Before this file's fix, both hosts'
 * `disarmMouseInkQuietly` called it directly and then relied on
 * `MobileTools`'s post-click `this.refresh()`, which repaints only the ONE
 * strip the pointer is on - a second open pane (another note, or the PDF)
 * kept showing its stale light until something unrelated repainted it.
 *
 * `releaseMouseInkQuietlyEverywhere` (InkOverlay.ts) is the fix: it pairs
 * `releaseMouseInkQuietly` with `refreshAllStrips`, which is what actually
 * reaches a surface registered via `addStripSurface` (the PDF's, in
 * production). This test registers a fake one the same way and asserts THAT
 * CALLBACK fires - the weaker assertion, "some refresh ran", would still
 * pass against the pre-fix code, since `this.refresh()` on the clicked strip
 * always ran regardless.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { addStripSurface, releaseMouseInkQuietlyEverywhere } from "./InkOverlay";
import { markPenHardwareSeen, penHardwareSeen, resetPenToolsForTest } from "./PenToolsMode";
import { armMouseInkQuietly, mouseInkEnabled } from "./MouseInk";

describe("releaseMouseInkQuietlyEverywhere: a mouse put-down repaints every open strip", () => {
	beforeEach(() => resetPenToolsForTest());

	it("reaches a registered (PDF-like) strip surface, not just the caller's own strip", () => {
		markPenHardwareSeen();
		armMouseInkQuietly();
		const refresh = vi.fn();
		const undo = addStripSurface(refresh);
		try {
			refresh.mockClear();

			releaseMouseInkQuietlyEverywhere();

			expect(refresh).toHaveBeenCalledTimes(1);
		} finally {
			undo();
		}
	});

	it("still does the release itself - mouse ink off and the hardware light cleared", () => {
		markPenHardwareSeen();
		armMouseInkQuietly();
		expect(mouseInkEnabled()).toBe(true);
		expect(penHardwareSeen()).toBe(true);

		releaseMouseInkQuietlyEverywhere();

		expect(mouseInkEnabled()).toBe(false);
		expect(penHardwareSeen()).toBe(false);
	});

	it("reaches the registered surface even with nothing to release (idempotent, not a crash)", () => {
		const refresh = vi.fn();
		const undo = addStripSurface(refresh);
		try {
			refresh.mockClear();

			releaseMouseInkQuietlyEverywhere();

			// `releaseMouseInkQuietly`'s own state writes are no-ops when
			// already off, but the repaint fan-out is unconditional -
			// callers of this wrapper never skip it, so neither does this
			// assertion.
			expect(refresh).toHaveBeenCalledTimes(1);
		} finally {
			undo();
		}
	});
});
