import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	NOTE_ZOOM_CONTROLS_MODES,
	getNoteZoomControlsMode,
	nextNoteZoomControlsMode,
	noteZoomControlsListenerCountForTest,
	noteZoomControlsVisible,
	noteZoomControlsVisibleWithCanvas,
	getZoomBarCanvasEnabled,
	setZoomBarCanvasEnabled,
	normalizeNoteZoomControlsMode,
	onNoteZoomControlsChanged,
	resetNoteZoomControlsForTest,
	setNoteZoomControlsMode,
} from "./NoteZoomControlsMode";

// Module unit cells, mirroring PenToolsMode.test.ts's own "pen tools
// visibility" / "pen tools change notifications" describes, minus everything
// about pen-hardware discoverability - this module has none of that.
describe("note zoom controls visibility", () => {
	beforeEach(resetNoteZoomControlsForTest);

	it("auto is unconditionally visible - no isMobile/seen clause", () => {
		expect(noteZoomControlsVisible("auto")).toBe(true);
	});

	it("show and hide override auto in both directions", () => {
		expect(noteZoomControlsVisible("show")).toBe(true);
		expect(noteZoomControlsVisible("hide")).toBe(false);
	});

	it("list order is auto, show, hide", () => {
		expect(NOTE_ZOOM_CONTROLS_MODES).toEqual(["auto", "show", "hide"]);
	});

	it("cycles auto -> show -> hide -> auto", () => {
		expect(nextNoteZoomControlsMode("auto")).toBe("show");
		expect(nextNoteZoomControlsMode("show")).toBe("hide");
		expect(nextNoteZoomControlsMode("hide")).toBe("auto");
	});

	it("normalizes junk to auto", () => {
		expect(normalizeNoteZoomControlsMode("hide")).toBe("hide");
		expect(normalizeNoteZoomControlsMode("banana")).toBe("auto");
		expect(normalizeNoteZoomControlsMode(undefined)).toBe("auto");
	});

	it("defaults to auto and the getter/setter round-trip", () => {
		expect(getNoteZoomControlsMode()).toBe("auto");
		setNoteZoomControlsMode("hide");
		expect(getNoteZoomControlsMode()).toBe("hide");
	});

	it("the reset seam actually resets", () => {
		setNoteZoomControlsMode("show");
		resetNoteZoomControlsForTest();
		expect(getNoteZoomControlsMode()).toBe("auto");
	});
});

describe("note zoom controls change notifications", () => {
	beforeEach(resetNoteZoomControlsForTest);

	it("announces a mode change, and only a real one", () => {
		const heard = vi.fn();
		onNoteZoomControlsChanged(heard);
		setNoteZoomControlsMode("hide");
		expect(heard).toHaveBeenCalledTimes(1);
		// Re-applying the same mode is what a settings save does. Nothing
		// changed, so nothing is told.
		setNoteZoomControlsMode("hide");
		expect(heard).toHaveBeenCalledTimes(1);
		setNoteZoomControlsMode("auto");
		expect(heard).toHaveBeenCalledTimes(2);
	});

	it("the unsubscribe actually unsubscribes", () => {
		const heard = vi.fn();
		const off = onNoteZoomControlsChanged(heard);
		expect(noteZoomControlsListenerCountForTest()).toBe(1);
		off();
		expect(noteZoomControlsListenerCountForTest()).toBe(0);
		setNoteZoomControlsMode("show");
		expect(heard).not.toHaveBeenCalled();
	});

	it("one listener throwing does not stop the next being told", () => {
		const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
		const heard = vi.fn();
		onNoteZoomControlsChanged(() => {
			throw new Error("chrome failed");
		});
		onNoteZoomControlsChanged(heard);
		setNoteZoomControlsMode("hide");
		expect(heard).toHaveBeenCalledTimes(1);
		quiet.mockRestore();
	});

	it("a listener may unsubscribe from inside the announcement", () => {
		const heard = vi.fn();
		const off = onNoteZoomControlsChanged(() => off());
		onNoteZoomControlsChanged(heard);
		setNoteZoomControlsMode("hide");
		expect(heard).toHaveBeenCalledTimes(1);
		expect(noteZoomControlsListenerCountForTest()).toBe(1);
	});
});

/**
 * The canvas gate is a SECOND condition over the user's mode,
 * not a fourth mode: with the canvas off the note cannot zoom at all, so the
 * bar has no job, and turning the canvas back on must return the user to the
 * mode they chose rather than to a default.
 */
describe("the zoom bar's Infinite Canvas gate", () => {
	beforeEach(resetNoteZoomControlsForTest);

	it("canvas off hides the bar in every mode, Show included", () => {
		expect(noteZoomControlsVisibleWithCanvas("show", false)).toBe(false);
		expect(noteZoomControlsVisibleWithCanvas("auto", false)).toBe(false);
		expect(noteZoomControlsVisibleWithCanvas("hide", false)).toBe(false);
	});

	it("canvas on leaves the mode in charge, both ways", () => {
		expect(noteZoomControlsVisibleWithCanvas("show", true)).toBe(true);
		expect(noteZoomControlsVisibleWithCanvas("auto", true)).toBe(true);
		// The user's own Hide is still theirs: the canvas does not override it.
		expect(noteZoomControlsVisibleWithCanvas("hide", true)).toBe(false);
	});

	it("a user on Show who turns the canvas off and on again is still on Show", () => {
		setNoteZoomControlsMode("show");
		expect(noteZoomControlsVisibleWithCanvas(getNoteZoomControlsMode(), false)).toBe(false);
		expect(noteZoomControlsVisibleWithCanvas(getNoteZoomControlsMode(), true)).toBe(true);
		expect(getNoteZoomControlsMode()).toBe("show");
	});

	it("defaults to true - no opinion before main.ts speaks must not hide a bar", () => {
		expect(getZoomBarCanvasEnabled()).toBe(true);
	});

	it("the global setter round-trips and the reset seam restores the default", () => {
		setZoomBarCanvasEnabled(false);
		expect(getZoomBarCanvasEnabled()).toBe(false);
		resetNoteZoomControlsForTest();
		expect(getZoomBarCanvasEnabled()).toBe(true);
	});

	it("announces a real canvas change to the mode's own listeners, and only a real one", () => {
		const heard = vi.fn();
		onNoteZoomControlsChanged(heard);
		setZoomBarCanvasEnabled(false);
		expect(heard).toHaveBeenCalledTimes(1);
		setZoomBarCanvasEnabled(false);
		expect(heard).toHaveBeenCalledTimes(1);
		setZoomBarCanvasEnabled(true);
		expect(heard).toHaveBeenCalledTimes(2);
	});
});
