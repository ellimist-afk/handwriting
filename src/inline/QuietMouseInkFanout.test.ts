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
import { armMouseInkQuietly, mouseInkEnabled, setMouseInk } from "./MouseInk";
// The namespace form as well as the names, for the export-list assertion in
// the second describe. Safe here and nowhere else: the raw-source scan in
// MouseInkWriterInvariant.test.ts bans a namespace import of this module
// precisely because it reaches the raw setter, and skips `.test.ts` files.
import * as MouseInk from "./MouseInk";

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

/**
 * QUIET IS FOR THIS SESSION; LOUD IS FOR DISK.
 *
 * ALAN, 2026-09-04: "dont persist a quiet arm". Three paths turned mouse ink
 * on and all three wrote it to data.json: the toggle command, a MOUSE click
 * on a tool button the strip could not otherwise use (`armMouseInkQuietly`,
 * above), and a tool hotkey pressed before any pen had been seen
 * (`armTipModeInput`, main.ts). Only the first is someone asking for the MODE
 * by name; the other two are someone asking for the ERASER and being handed
 * the mouse claim that request needs in order to mean anything. Persisting
 * those is what users reported as mouse ink "keeps turning on by itself" -
 * one tool click in one note, and every launch afterwards came up with the
 * mouse claimed and text selection gone, with nothing on screen to explain
 * why.
 *
 * So the quiet edges now flip the runtime flag and stop. `setMouseInk(
 * this.settings.mouseInk)` at load (main.ts) is deliberately unchanged, and
 * that is the whole mechanism: what the loud writers put on disk is what the
 * next launch gets, and a quiet arm is simply not on disk to be found.
 *
 * WHAT EACH TEST HERE CAN AND CANNOT CATCH (adversarial review, 2026-09-04).
 * The first is the one with teeth: it scans the module's real export list, so
 * a writer reintroduced under `setPersistMouseInk` or under any other name
 * with `persist` in it fails it, and the positive control stops a mistyped
 * specifier from passing by knowing nothing.
 *
 * The two after it own a plain `saved` object that NO production code can
 * reach, so `expect(saved.mouseInk)` cannot fail for the claim in its name -
 * it is a statement about a literal. They are kept, retitled, for what they
 * genuinely do pin: the LOAD semantics the user actually experiences, that
 * `setMouseInk(saved.mouseInk)` replayed over a quietly armed session lands
 * on the saved value in both directions. That the strip's own buttons never
 * reach a writer is pinned where a click can be driven through the real
 * chain - MobileTools.test.ts, whose fake host models the loud command's
 * persist so a re-routed edge writes an object the assertions read.
 */
describe("mouse ink: a quiet arm and a quiet put-down never reach the saved setting", () => {
	beforeEach(() => {
		resetPenToolsForTest();
		setMouseInk(false);
	});

	it("MouseInk has no persistence writer left for a quiet path to call", () => {
		// `setPersistMouseInk` was the eraser slider's pattern: main.ts
		// registered a writer and the two quiet edges called it. It is gone
		// with its last caller, and this is the assertion that keeps it gone.
		expect(Object.keys(MouseInk)).not.toContain("setPersistMouseInk");
		// By NAME above and by SHAPE here: the hook coming back as
		// `registerMouseInkPersister` would pass the line above while being
		// the same defect. Nothing in this module has any business owning a
		// route to data.json under any name.
		expect(Object.keys(MouseInk).filter((k) => /persist/i.test(k))).toEqual([]);
		// A positive control, the P3 lesson from MouseInkWriterInvariant: a
		// mistyped module specifier would give an empty namespace and pass
		// the line above by knowing nothing at all.
		expect(Object.keys(MouseInk)).toContain("armMouseInkQuietly");
	});

	it("the load line puts a quietly armed session back to the saved off", () => {
		// A plain object, reachable by nothing in production - that IS the
		// change. So the `saved.mouseInk` assertions below restate the line
		// above them and cannot fail on their own; what this test pins is the
		// last one, that replaying main.ts's load line over an armed session
		// lands on the stored value.
		const saved = { mouseInk: false };
		setMouseInk(saved.mouseInk); // main.ts onload

		armMouseInkQuietly(); // a mouse clicks a tool button it cannot use yet

		// Armed, because the click has to work: this is the only way in for
		// someone with no pen.
		expect(mouseInkEnabled()).toBe(true);
		expect(saved.mouseInk).toBe(false);

		setMouseInk(saved.mouseInk); // the next launch, same one line

		expect(mouseInkEnabled()).toBe(false);
	});

	it("the load line brings an explicit ON back after a quiet put-down", () => {
		// The mirror, and the half that is easy to get wrong by making the
		// put-down "the off switch": someone who turned the mode on BY NAME
		// still has it on tomorrow. Putting a tool down hands this session's
		// pointer back to text, which is all it was ever asked to do. Same
		// caveat as the test above on which line here is load-bearing: the
		// last one. This one does drive a real production edge
		// (`releaseMouseInkQuietlyEverywhere`), so it pins that that edge
		// leaves the flag off and nothing else in the module resets it.
		const saved = { mouseInk: true }; // the toggle command wrote this
		setMouseInk(saved.mouseInk);

		releaseMouseInkQuietlyEverywhere(); // the strip's put-down, real edge

		expect(mouseInkEnabled()).toBe(false);
		expect(saved.mouseInk).toBe(true);

		setMouseInk(saved.mouseInk);

		expect(mouseInkEnabled()).toBe(true);
	});
});
