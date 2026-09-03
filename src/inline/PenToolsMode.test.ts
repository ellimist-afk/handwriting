import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	markPenSeen,
	nextPenToolsMode,
	normalizePenToolsMode,
	onPenToolsChanged,
	penSeenThisSession,
	penToolsListenerCountForTest,
	penToolsVisible,
	resetPenToolsForTest,
	setPenToolsMode,
} from "./PenToolsMode";

describe("pen tools visibility", () => {
	beforeEach(resetPenToolsForTest);

	it("auto: mobile always, desktop only once a pen was seen", () => {
		expect(penToolsVisible("auto", true, false)).toBe(true);
		expect(penToolsVisible("auto", false, false)).toBe(false);
		expect(penToolsVisible("auto", false, true)).toBe(true);
	});

	it("show and hide override auto in both directions", () => {
		expect(penToolsVisible("show", false, false)).toBe(true);
		expect(penToolsVisible("hide", true, true)).toBe(false);
	});

	it("cycles auto -> show -> hide -> auto", () => {
		expect(nextPenToolsMode("auto")).toBe("show");
		expect(nextPenToolsMode("show")).toBe("hide");
		expect(nextPenToolsMode("hide")).toBe("auto");
	});

	it("normalizes junk to auto", () => {
		expect(normalizePenToolsMode("hide")).toBe("hide");
		expect(normalizePenToolsMode("banana")).toBe("auto");
	});

	it("pen sightings latch for the session", () => {
		expect(penSeenThisSession()).toBe(false);
		markPenSeen();
		expect(penSeenThisSession()).toBe(true);
	});
});

/**
 * The registry a surface with no fan-out of its own subscribes to.
 *
 * `refreshPenToolsAll` (InkOverlay.ts) is the note surface's fan-out and it
 * walks only note overlays, so the PDF controller had no way to hear that the
 * setting changed - the whole reason "Pen toolbar → Hide" left the strip on
 * screen over a PDF. Announcing from the two setters here is what makes a
 * surface's subscription enough on its own.
 */
describe("pen tools change notifications", () => {
	beforeEach(resetPenToolsForTest);

	it("announces a mode change, and only a real one", () => {
		const heard = vi.fn();
		onPenToolsChanged(heard);
		setPenToolsMode("hide");
		expect(heard).toHaveBeenCalledTimes(1);
		// Re-applying the same mode is what a settings save does. Nothing
		// changed, so nothing is told.
		setPenToolsMode("hide");
		expect(heard).toHaveBeenCalledTimes(1);
		setPenToolsMode("auto");
		expect(heard).toHaveBeenCalledTimes(2);
	});

	it("announces the first pen sighting and no later one", () => {
		const heard = vi.fn();
		onPenToolsChanged(heard);
		markPenSeen();
		expect(heard).toHaveBeenCalledTimes(1);
		// Every pen-down calls this. Only the edge changes the answer, and the
		// first sample of every stroke is the last place to spend a fan-out.
		markPenSeen();
		markPenSeen();
		expect(heard).toHaveBeenCalledTimes(1);
	});

	it("the unsubscribe actually unsubscribes", () => {
		const heard = vi.fn();
		const off = onPenToolsChanged(heard);
		expect(penToolsListenerCountForTest()).toBe(1);
		off();
		expect(penToolsListenerCountForTest()).toBe(0);
		setPenToolsMode("show");
		expect(heard).not.toHaveBeenCalled();
	});

	it("one listener throwing does not stop the next being told", () => {
		// Both ink surfaces subscribe. A strip that cannot mount on one pane
		// must not leave the other pane's strip stale - the same bulkhead
		// every ensure-tools path in this plugin already carries.
		const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
		const heard = vi.fn();
		onPenToolsChanged(() => {
			throw new Error("chrome failed");
		});
		onPenToolsChanged(heard);
		setPenToolsMode("hide");
		expect(heard).toHaveBeenCalledTimes(1);
		quiet.mockRestore();
	});

	it("a listener may unsubscribe from inside the announcement", () => {
		// A mode change can tear a surface down, and the teardown drops its
		// subscription - so the set is being mutated while it is walked.
		const heard = vi.fn();
		const off = onPenToolsChanged(() => off());
		onPenToolsChanged(heard);
		setPenToolsMode("hide");
		expect(heard).toHaveBeenCalledTimes(1);
		expect(penToolsListenerCountForTest()).toBe(1);
	});
});
