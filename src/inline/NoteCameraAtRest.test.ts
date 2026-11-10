/**
 * A NOTE'S CAMERA IS SAVED WHEN THE PAGE COMES TO REST, NOT ONLY WHEN THE NOTE LEAVES (discussion 42).
 *
 * A quit does not reliably unmount the editor, so a camera saved only on leave is lost to a quit. The overlay's scroll
 * listener and its camera commit (the one funnel for every zoom change) arm a save that runs once the camera has
 * been quiet; the store then writes the key 500 ms later. The same funnel runs on a pane resize and on the restore, so a
 * camera equal to the one kept writes nothing. Nothing on the pen path saves or writes.
 *
 * Runs a real overlay, mounted all the way (mountRig.test.util.ts), with its window's timers on vitest's fake clock and
 * the module's store a spy, driven through its own scroll listener, its own commitCameraScale and restoreNoteCamera, and
 * its own penDown, penRaw and penUp. For the commit, the layout sinks are stubbed as on the rig PaperSpacingCommit.test.ts
 * uses; the commit itself is the real one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountOverlay, type MountedOverlay } from "./mountRig.test.util";
import { noteCameras, setNoteCameraStore } from "./NoteCamera";
import { resetTipModeForTest } from "./TipMode";

const KEY = "handwriting:note-cameras";

interface Stored {
	v: number;
	cameras: Record<string, { zoom: number; left: number; top: number; at: number }>;
}

function store() {
	const values = new Map<string, unknown>();
	const save = vi.fn((key: string, value: unknown) => void values.set(key, value));
	return { load: (key: string) => values.get(key) ?? null, save, read: () => values.get(KEY) as Stored | undefined };
}

/** A mounted overlay whose window's timers run on the fake clock. */
function mounted(path: string): MountedOverlay {
	const m = mountOverlay(path);
	Object.assign(m.doc.defaultView, {
		setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
		clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
	});
	return m;
}

/** Stub the commit's layout sinks on a mounted overlay, so the real commitCameraScale runs through to its success return. */
function commitReady(m: MountedOverlay, zoom = 1): (next: number, scroll?: { left: number; top: number }) => boolean {
	const o = m.o;
	const scroller = m.scrollDOM as unknown as { scrollLeft: number; scrollTop: number; scrollWidth: number; scrollHeight: number };
	scroller.scrollWidth = 64000;
	scroller.scrollHeight = 48000;
	o.pinchScaleNow = zoom;
	o.cssScale = zoom;
	o.scale = zoom;
	o.prepareViewportLayout = () => true;
	// The stub layout has no pane or saved styles to put back; the unmount's restore of them is not under test.
	o.restoreViewportLayout = vi.fn();
	// The commit's follow-up runs in CodeMirror's next measure; this rig's view has no measure loop, and the save at rest
	// does not wait on it.
	(o.view as Record<string, unknown>).requestMeasure = vi.fn();
	o.viewportLayout = { width: 800, height: 600, baseTransform: "none", externalScale: 1, columnLocal: null };
	for (const name of ["restorePinchLayers", "retirePanSettle", "releaseMeasures", "clearViewportPan", "refreshPenCursor", "updateExtent", "reanchorPan", "scheduleRepaint", "handleResize", "applyViewportBox"]) o[name] = vi.fn();
	o.setViewportScroll = (left: number, top: number) => {
		scroller.scrollLeft = left;
		scroller.scrollTop = top;
	};
	o.syncBand = () => "none";
	o.firstSettleConsumer = () => false;
	const commit = o.commitCameraScale as (next: number, scroll?: { left: number; top: number }) => boolean;
	return (next, scroll) => commit.call(o, next, scroll);
}

beforeEach(() => {
	vi.useFakeTimers();
	resetTipModeForTest();
	noteCameras.clear();
});
afterEach(() => {
	noteCameras.clear();
	resetTipModeForTest();
	vi.useRealTimers();
});

describe("a note's camera is saved at rest", () => {
	it("a scroll that comes to rest writes the camera, with no leave", () => {
		const s = store();
		setNoteCameraStore(s);
		const m = mounted("rest-scroll.md");
		try {
			m.scrollDOM.scrollTop = 600;
			const scrollFn = m.o.scrollFn as () => void;
			expect(typeof scrollFn, "precondition: the mount installed its scroll listener").toBe("function");
			scrollFn();
			vi.advanceTimersByTime(2000);
			expect(s.read()?.cameras["rest-scroll.md"], "the camera at rest was not written").toMatchObject({ zoom: 1, left: 0, top: 600 });
		} finally {
			m.destroy();
		}
	});

	it("a run of scroll events saves once, after the last one", () => {
		const s = store();
		setNoteCameraStore(s);
		const m = mounted("rest-run.md");
		const save = vi.spyOn(noteCameras, "save");
		try {
			const scrollFn = m.o.scrollFn as () => void;
			// 60 events 16 ms apart, 960 ms: longer than the 500 ms rest, so the first wait ends mid-run and must wait again.
			for (let top = 10; top <= 600; top += 10) {
				m.scrollDOM.scrollTop = top;
				scrollFn();
				vi.advanceTimersByTime(16);
			}
			expect(save, "a save ran while the page was still scrolling").not.toHaveBeenCalled();
			vi.advanceTimersByTime(2000);
			expect(save).toHaveBeenCalledTimes(1);
			expect(s.read()?.cameras["rest-run.md"]).toMatchObject({ top: 600 });
		} finally {
			save.mockRestore();
			m.destroy();
		}
	});

	it("a zoom at an unchanged scroll writes after rest, with no scroll event", () => {
		const s = store();
		setNoteCameraStore(s);
		const m = mounted("rest-zoom.md");
		try {
			const commit = commitReady(m);
			expect(commit(2), "precondition: the commit succeeded").toBe(true);
			expect([m.scrollDOM.scrollLeft, m.scrollDOM.scrollTop], "precondition: the scroll did not move").toEqual([0, 0]);
			vi.advanceTimersByTime(2000);
			expect(s.read()?.cameras["rest-zoom.md"], "a zoom-only change was not written").toMatchObject({ zoom: 2, left: 0, top: 0 });
		} finally {
			m.destroy();
		}
	});

	it("a commit in place at the kept camera writes nothing", () => {
		const s = store();
		s.save(KEY, { v: 1, cameras: { "rest-same.md": { zoom: 2, left: 0, top: 0, at: 1 } } });
		s.save.mockClear();
		// Attached after the mount: a kept camera at mount arms the restore's measure, which this rig's view has no loop for.
		const m = mounted("rest-same.md");
		setNoteCameraStore(s);
		try {
			const commit = commitReady(m, 2);
			expect(commit(2), "precondition: the commit succeeded").toBe(true);
			vi.advanceTimersByTime(2000);
			expect(s.save, "a pane resize's re-commit rewrote an unchanged camera").not.toHaveBeenCalled();
		} finally {
			m.destroy();
		}
	});

	it("the restore's commit writes nothing", () => {
		const s = store();
		s.save(KEY, { v: 1, cameras: { "rest-restore.md": { zoom: 2, left: 0, top: 600, at: 1 } } });
		s.save.mockClear();
		// Attached after the mount, and the restore run by hand: this rig's view has no measure loop.
		const m = mounted("rest-restore.md");
		setNoteCameraStore(s);
		try {
			commitReady(m);
			const o = m.o as Record<string, unknown> & { restoreNoteCamera(path: string): void };
			// A zoomed camera comes back only on a note with the canvas on; the rig's note has it off.
			o.canvasMode = true;
			o.noteCameraRestore = "rest-restore.md";
			o.restoreNoteCamera("rest-restore.md");
			expect([o.pinchScaleNow, m.scrollDOM.scrollLeft, m.scrollDOM.scrollTop], "precondition: the restore landed the kept camera").toEqual([2, 0, 600]);
			vi.advanceTimersByTime(2000);
			expect(s.save, "the restore rewrote the camera it restored").not.toHaveBeenCalled();
		} finally {
			m.destroy();
		}
	});

	it("a stroke writes nothing", () => {
		const s = store();
		setNoteCameraStore(s);
		const m = mounted("rest-stroke.md");
		// Scrolled, so a save from the pen path would be a camera worth writing, not the default that writes nothing.
		m.scrollDOM.scrollTop = 600;
		const save = vi.spyOn(noteCameras, "save");
		const o = m.o as Record<string, unknown> & {
			penDown(sample: unknown, ev: unknown): void;
			penRaw(samples: unknown[], ev: unknown): void;
			penUp(ev?: unknown): void;
			noteCameraMoved(): void;
			mode: string;
		};
		try {
			// Control first: from this state a rest save does save, so the pen path's silence below is a measurement.
			o.noteCameraMoved();
			vi.advanceTimersByTime(500);
			expect(save, "control: a rest save from this state did not save").toHaveBeenCalledTimes(1);
			// The store's own write lands 500 ms after the save; let it, so the stroke below starts with both spies clear.
			vi.advanceTimersByTime(500);
			save.mockClear();
			s.save.mockClear();
			// The rig has no layout width, so the stroke's camera sync marks the geometry invalid and a save armed by the
			// lift returns before it saves: the save spies alone cannot see that arm. The arm itself is watched.
			const arm = vi.spyOn(o, "noteCameraMoved");
			const ev = { pointerType: "pen", buttons: 1, button: 0, clientX: 60, clientY: 60, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
			o.penDown({ x: 60, y: 60, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 }, ev);
			expect(o.mode, "precondition: the nib inks").toBe("ink");
			for (let i = 1; i <= 20; i++) {
				o.penRaw([{ x: 60 + i * 3, y: 60 + i, pressure: 0.5, timestamp: i * 8, tiltX: 0, tiltY: 0 }], { ...ev, clientX: 60 + i * 3, clientY: 60 + i });
				vi.advanceTimersByTime(8);
			}
			o.penUp({ ...ev, buttons: 0 });
			vi.advanceTimersByTime(2000);
			expect(arm, "a stroke armed the rest save").not.toHaveBeenCalled();
			expect(save, "a stroke saved the camera").not.toHaveBeenCalled();
			expect(s.save, "a stroke wrote the cameras").not.toHaveBeenCalled();
		} finally {
			save.mockRestore();
			m.destroy();
		}
	});
});
