/**
 * The `.cm-content` observer, pinned - a WIRING guard, not a behaviour one.
 *
 * WHAT BROKE. Until a8209dc the overlay's only `ResizeObserver` watched
 * `view.dom`, the `.cm-editor`. Obsidian's "Readable line length" is a pure
 * CSS cap on `.cm-content`'s max-width: the editor keeps filling the leaf,
 * the scroller keeps its size, and the overlay container's own box - written
 * by `syncBand` from scroller dimensions - does not move either. So toggling
 * it resized the TEXT COLUMN and nothing else. No observer fired,
 * `handleResize` never ran, `syncCamera` never re-read `contentDOM`'s left
 * edge, `cam.x` kept its pre-toggle value, and every committed stroke painted
 * against a stale content origin. That is the ink drift users reported for
 * three release cycles: samuelbits by screenshot, then Alan first-hand on
 * 2026-09-03 once the toggle rather than the sidebar was the variable moved.
 *
 * `handleResize` could not be reused as the callback. Its `unchanged` guard
 * early-returns when the canvas box has not moved, which is exactly this
 * case - it would have returned without repainting and the fix would have
 * been a no-op that looked landed. The callback goes straight to
 * `syncCamera` + `scheduleRepaint`.
 *
 * WHY THIS GUARD READS SOURCE INSTEAD OF RUNNING THE CODE. The wiring lives
 * in `mount()`, and two files reached the same conclusion independently
 * before this one: `PenToolsEscapeHatch.test.ts` calls `mount()` "far too
 * heavy for a fixture" and deliberately steers its rig into mount's own
 * not-a-file-backed-editor exit; `PenContactRouting.test.ts` stubs
 * `ResizeObserver` to a no-op for the same reason. Fixturing `createDiv`,
 * five canvas contexts, `WetInkRenderer`, the router and the tool strip to
 * assert one `observe()` call would buy a fixture that breaks every time
 * mount changes, and it would still be a fixture rather than an editor.
 *
 * SO BE HONEST ABOUT THE TRADE. This file proves the wiring is PRESENT and
 * points at the right element. It does NOT prove the observer fires, that
 * the browser delivers the callback, or that the repaint lands - a real
 * editor is the only thing that shows those, and Alan's hardware is what
 * confirmed them on 2026-09-03. What it does buy is the thing that was
 * actually missing: deleting the observer, or pointing it at the wrong
 * element, now fails a test instead of silently restoring a three-cycle bug.
 *
 * `PaneWidthGeometry.test.ts` is the other half and its header says so. That
 * suite drives `syncCamera` by hand, so it proves the MATH is right once the
 * camera syncs and is structurally blind to whether anything syncs it. Both
 * files passed green through the entire life of this defect. Neither was
 * wrong; the pair had a seam, and this file is the seam.
 *
 * COMMENTS ARE BLANKED before every assertion. The markers below are call
 * shapes, and a doc comment quoting one would otherwise satisfy the guard -
 * the exact failure `CodeOnly.ts` was extracted to prevent, which has already
 * cost this project a silently-deleted tap floor.
 */

import { describe, expect, it } from "vitest";

import { codeOnly } from "../CodeOnly";

const ALL_TS = import.meta.glob("/src/**/*.ts", {
	query: "?raw",
	eager: true,
	import: "default",
}) as Record<string, string>;

const OVERLAY = "/src/inline/InkOverlay.ts";

/** InkOverlay's source with comments blanked. Throws on a rename rather than passing vacuously. */
function overlayCode(): string {
	const text = ALL_TS[OVERLAY];
	if (text === undefined) throw new Error(`not in the source scan: ${OVERLAY}`);
	return codeOnly(text);
}

describe("the .cm-content resize observer", () => {
	it("observes contentDOM, the element Readable line length actually resizes", () => {
		// The whole fix in one line. `view.dom` is already observed by the
		// older observer; what was missing is this one. Matched with the
		// receiver spelled out, so re-pointing it at `host` - the mutation
		// that would restore the bug while leaving every symbol in the file -
		// fails here.
		expect(overlayCode()).toContain("observe(this.view.contentDOM)");
	});

	it("re-syncs the camera rather than routing through handleResize", () => {
		const code = overlayCode();
		// The callback must reach syncCamera. Routing this through
		// handleResize instead would hit its `unchanged` early-return on
		// exactly the case this exists for, and land a no-op that reads like
		// a fix.
		const wiring = code.slice(code.indexOf("contentResizeObserver = new ResizeObserver"));
		expect(wiring).not.toBe("");
		const body = wiring.slice(0, wiring.indexOf("});"));
		expect(body).toContain("this.syncCamera()");
		expect(body).toContain("this.scheduleRepaint(");
		expect(body).not.toContain("this.handleResize()");
	});

	it("holds its own frame guard, so a stroke in flight keeps its coordinates", () => {
		// `syncCamera` already no-ops while `frame.locked`, but the callback
		// checks too: without it a mid-stroke content resize would schedule a
		// repaint against the frozen pen-down camera. Cheap, and it states
		// the invariant at the call site where it can be read.
		const code = overlayCode();
		const wiring = code.slice(code.indexOf("contentResizeObserver = new ResizeObserver"));
		const body = wiring.slice(0, wiring.indexOf("});"));
		expect(body).toContain("frame.locked");
	});

	it("is disconnected on unmount, like the observer beside it", () => {
		// A leaked observer on a detached contentDOM keeps the overlay
		// reachable. The older observer is torn down two lines above; this
		// one has to be, or unmount half-cleans and the leak is the kind
		// that only shows up after a long session of opening panes.
		expect(overlayCode()).toContain("this.contentResizeObserver?.disconnect()");
	});

	it("blanks comments before asserting, so a doc comment cannot satisfy it", () => {
		// The fixture that keeps this guard honest. If `codeOnly` ever
		// returned its input unchanged, every assertion above would still
		// pass while the wiring was gone and a comment quoting it remained -
		// which is precisely how the canvas tap floor was deleted green.
		const withComment = `
			// observe(this.view.contentDOM)
			/* this.contentResizeObserver?.disconnect() */
			const unrelated = 1;
		`;
		const stripped = codeOnly(withComment);
		expect(stripped).not.toContain("observe(this.view.contentDOM)");
		expect(stripped).not.toContain("this.contentResizeObserver?.disconnect()");
		expect(stripped).toContain("const unrelated = 1;");
	});
});
