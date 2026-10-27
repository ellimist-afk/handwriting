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
 * been a no-op that looked landed. The callback goes to `onContentResize`,
 * which re-syncs the camera and schedules a repaint itself.
 *
 * RUN, NOT READ. This file used to read `InkOverlay.ts` as text, because
 * fixturing `mount()` for one `observe()` call looked too heavy. The mount
 * rig (`mountRig.test.util.ts`) now builds a real overlay and runs `mount()`
 * to its last line, so every cell here mounts one with recording observers in
 * place of the browser's, and asks the observers what production did: which
 * element was observed, what the callback runs when it fires, and whether
 * unmount let it go. A split that moves this wiring to another file changes
 * nothing here.
 *
 * SO BE HONEST ABOUT THE TRADE, which has not changed. This file proves the
 * wiring is present, points at the right element, and that its callback goes
 * to the camera. It does NOT prove the browser delivers the callback or that
 * the repaint lands - a real editor is the only thing that shows those, and
 * Alan's hardware is what confirmed them on 2026-09-03. What it buys is the
 * thing that was actually missing: deleting the observer, or pointing it at
 * the wrong element, fails a test instead of silently restoring a
 * three-cycle bug.
 *
 * `PaneWidthGeometry.test.ts` is the other half and its header says so. That
 * suite drives `syncCamera` by hand, so it proves the MATH is right once the
 * camera syncs and is structurally blind to whether anything syncs it. Both
 * files passed green through the entire life of this defect. Neither was
 * wrong; the pair had a seam, and this file is the seam.
 */

import { describe, expect, it, vi } from "vitest";

import { type MountedOverlay, type RecordingObserver, mountOverlay, recordObservers } from "./mountRig.test.util";

interface Watched {
	m: MountedOverlay;
	/** Every ResizeObserver the mount built, in order. */
	resize: RecordingObserver[];
	/** The one watching `contentDOM`. Throws in the cell if there is none. */
	content(): RecordingObserver;
	done(): void;
}

function mountWatched(path: string): Watched {
	const observers = recordObservers();
	let m: MountedOverlay;
	try {
		m = mountOverlay(path);
	} catch (e) {
		observers.restore();
		throw e;
	}
	return {
		m,
		resize: observers.resize,
		content() {
			const on = observers.resize.filter((r) => r.watches(m.contentDOM));
			expect(on, "no ResizeObserver watches contentDOM, the element Readable line length resizes").toHaveLength(1);
			return on[0]!;
		},
		done() {
			try {
				m.destroy();
			} finally {
				observers.restore();
			}
		},
	};
}

/** The overlay's camera sync, repaint and resize entry points, spied on the instance. */
function spyCamera(m: MountedOverlay) {
	const o = m.o as Record<string, unknown> & { syncCamera(): void; scheduleRepaint(via?: string): void };
	const handleResize = vi.fn();
	o.handleResize = handleResize;
	return {
		syncCamera: vi.spyOn(o, "syncCamera"),
		scheduleRepaint: vi.spyOn(o, "scheduleRepaint").mockImplementation(() => {}),
		handleResize,
	};
}

describe("the .cm-content resize observer", () => {
	it("observes contentDOM, the element Readable line length actually resizes", () => {
		// The whole fix in one line. `view.dom` is already observed by the
		// older observer; what was missing is this one. Re-pointing it at the
		// host - the mutation that would restore the bug while leaving every
		// symbol in the file - leaves no observer on contentDOM.
		const w = mountWatched("content-resize-observes.md");
		try {
			const content = w.content();
			expect(content.observed.map((o) => o.target), "the contentDOM observer watches something else as well").toEqual([w.m.contentDOM]);
		} finally {
			w.done();
		}
	});

	it("re-syncs the camera rather than routing through handleResize", () => {
		// The callback must reach syncCamera. Routing this through
		// handleResize instead would hit its `unchanged` early-return on
		// exactly the case this exists for, and land a no-op that reads like
		// a fix.
		const w = mountWatched("content-resize-syncs.md");
		try {
			const content = w.content();
			const spy = spyCamera(w.m);
			content.fire();
			expect(spy.syncCamera, "the contentDOM callback did not re-sync the camera").toHaveBeenCalled();
			expect(spy.scheduleRepaint, "the contentDOM callback scheduled no repaint").toHaveBeenCalled();
			expect(spy.handleResize, "the contentDOM callback went through handleResize").not.toHaveBeenCalled();
		} finally {
			w.done();
		}
	});

	it("holds its own frame guard, so a stroke in flight keeps its coordinates", () => {
		// `syncCamera` already no-ops while `frame.locked`, but the callback
		// checks too: without it a mid-stroke content resize would schedule a
		// repaint against the frozen pen-down camera.
		const w = mountWatched("content-resize-locked.md");
		try {
			const content = w.content();
			const spy = spyCamera(w.m);
			const frame = w.m.o.frame as { begin(): void; end(): void; locked: boolean };
			frame.begin();
			expect(frame.locked, "precondition: a stroke owns the frame").toBe(true);
			content.fire();
			frame.end();
			expect(spy.syncCamera, "a content resize mid-stroke moved the camera").not.toHaveBeenCalled();
			expect(spy.scheduleRepaint, "a content resize mid-stroke scheduled a repaint").not.toHaveBeenCalled();
		} finally {
			w.done();
		}
	});

	it("is disconnected on unmount, like the observer beside it", () => {
		// A leaked observer on a detached contentDOM keeps the overlay
		// reachable. The older observer is torn down beside it; this one has
		// to be, or unmount half-cleans and the leak is the kind that only
		// shows up after a long session of opening panes.
		const w = mountWatched("content-resize-unmount.md");
		let content: RecordingObserver | undefined;
		try {
			content = w.content();
			expect(content.disconnects, "precondition: still connected while mounted").toBe(0);
		} finally {
			w.done();
		}
		expect(content?.disconnects, "unmount left the contentDOM observer connected").toBeGreaterThan(0);
	});
});
