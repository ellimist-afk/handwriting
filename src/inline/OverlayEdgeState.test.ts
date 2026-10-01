/**
 * Small pieces of overlay state that went stale across an edge.
 *
 * - A pane resize while a stroke held a zoomed note's layout was skipped and
 *   never replayed, leaving a blank strip or a clipped edge after the lift.
 * - A paper-pan reset cleared the scroller's pan but not the grid box's own
 *   copy, so the vertical grid rules kept an old offset.
 * - The band carried under a live stroke moved the tail canvas's pixels but
 *   not the prediction history drawn on it, so the next predicted tail was
 *   extrapolated from points one carry away.
 * - A pen landing within the quiet time of a ctrl+wheel or touchpad zoom left
 *   the run's timer to end it under the stroke.
 * - A hidden pen cursor took the insert-space guide with it mid-drag.
 * - The snap chip was clamped to the ink band, which reaches past the pane.
 *
 * Each rig is the real InkOverlayPlugin off its prototype, with only the
 * fields the method under test reads; every method named is the real one.
 */
import { describe, expect, it, vi } from "vitest";

(globalThis as { window?: unknown }).window = globalThis;

import { InkOverlayPlugin } from "./InkOverlay";
import { WheelZoomRun } from "./WheelZoom";
import { snapChipOrigin, SNAP_CHIP_H, SNAP_CHIP_OFFSET, SNAP_CHIP_W } from "./SnapChip";

type Fields = Record<string, any>;
const noop = (): undefined => undefined;
const bare = (): Fields => Object.create(InkOverlayPlugin.prototype) as Fields;

describe("a pane resize held back by a stroke on a zoomed note", () => {
	const rig = (paneW: number) => {
		const o = bare();
		const layout = { parent: { clientWidth: paneW, clientHeight: 600 }, paneWidth: 800, paneHeight: 600, width: 800, height: 600 };
		Object.assign(o, {
			viewportLayout: layout, viewportStyleDirty: false,
			frame: { locked: true }, container: {}, pinchPreview: true, resizeDeferred: false,
			deferPinchRaster: () => false, restorePinchLayers: noop, mobileTools: null, noteZoomControls: null, scrollExpansion: null,
			view: { scrollDOM: { scrollLeft: 0, scrollTop: 0 } },
		});
		return o;
	};

	it("is remembered under the stroke and replayed once the frame is free", () => {
		const o = rig(640);
		o.handleResize();
		expect(o.resizeDeferred, "a resize the zoomed layout skipped").toBe(true);
		const replay = vi.fn();
		o.handleResize = replay;
		o.frame.locked = false;
		o.replayDeferredResize();
		expect(replay).toHaveBeenCalledTimes(1);
		o.replayDeferredResize();
		expect(replay, "once").toHaveBeenCalledTimes(1);
	});

	it("control: a pane the layout already matches owes nothing", () => {
		const o = rig(800);
		o.handleResize();
		expect(o.resizeDeferred).toBe(false);
	});

	it("the pen lift replays it", () => {
		const o = bare();
		const replay = vi.fn();
		Object.assign(o, {
			frame: { locked: false, end: noop }, container: {}, resizeDeferred: true,
			retryCanvasOffReset: noop, bandSyncDeferred: false, viewportStyleDirty: false,
			handleResize: replay,
		});
		// endPenGesture's first lines, up to the replay; the rest of the lift is not the subject.
		try { o.endPenGesture(); } catch { /* the lift's later branches need a full overlay */ }
		expect(replay).toHaveBeenCalledTimes(1);
	});
});

describe("a paper-pan reset clears the grid box's own copy", () => {
	const styleOf = () => {
		const props = new Map<string, string>();
		return {
			props,
			style: {
				getPropertyValue: (n: string) => props.get(n) ?? "",
				setProperty: (n: string, v: string) => void props.set(n, v),
				removeProperty: (n: string) => void props.delete(n),
			},
		};
	};

	it("clearScrollerPan takes the box's pan off too", () => {
		const o = bare();
		const scroller = styleOf(), box = styleOf();
		scroller.props.set("--handwriting-paper-pan-x", "12px");
		box.props.set("--handwriting-paper-pan-x", "12px");
		Object.assign(o, { paperGridBox: { style: box.style }, paperGridBoxPanX: "12px", paperPanWritten: { x: "12px", y: "" } });
		o.clearScrollerPan({ style: scroller.style });
		expect(scroller.props.has("--handwriting-paper-pan-x")).toBe(false);
		expect(box.props.has("--handwriting-paper-pan-x"), "vertical rules back at zero pan").toBe(false);
		expect(o.paperGridBoxPanX).toBe("");
	});

	it("then a write at zero pan leaves both at zero", () => {
		const o = bare();
		const scroller = styleOf(), box = styleOf();
		box.props.set("--handwriting-paper-pan-x", "12px");
		Object.assign(o, {
			paperGridBox: { style: box.style }, paperGridBoxPanX: "12px", paperPanWritten: { x: "12px", y: "" },
			view: { scrollDOM: { style: scroller.style } }, cssScale: 1, pinchPreview: false, previewPaperEl: null,
			panX: () => 0, panY: () => 0, paperColumnDrift: 0, paperRewrapY: 0, paperWritten: new Map(),
		});
		o.clearScrollerPan({ style: scroller.style });
		o.writePaperPan();
		expect(box.props.has("--handwriting-paper-pan-x")).toBe(false);
	});
});

describe("the band carried under a live stroke carries the prediction history", () => {
	it("real samples and the last predicted tail move with the pixels", () => {
		const o = bare();
		const ctx = { save: noop, restore: noop, setTransform: noop, drawImage: noop, globalCompositeOperation: "" };
		const carries: Array<[number, number]> = [];
		Object.assign(o, {
			band: { left: 0, top: 0, width: 800, height: 1200 }, container: { setCssStyles: noop },
			committedBacking: 1, fontZoom: 1, cssWidth: 800, cssHeight: 1200,
			camera: { snapshot: { x: 0, y: 0, zoom: 1 }, setState: noop },
			committedCtx: ctx, committedCanvas: {}, highlightCtx: ctx, highlightCanvas: {},
			wet: { carry: noop }, highlightWet: { carry: noop }, tail: { carry: (x: number, y: number) => void carries.push([x, y]) },
			damage: { addRect: noop }, router: { refreshRect: noop }, bandSyncDeferred: false,
			predReal: [{ x: 100, y: 500, pressure: 0.5, timestamp: 1 }, { x: 110, y: 505, pressure: 0.5, timestamp: 2 }],
			predLastTail: [{ x: 120, y: 510, pressure: 0.5, timestamp: 3 }],
		});
		const real = o.predReal as Array<{ x: number; y: number }>;
		expect(o.carryBandUnderLock({ left: 0, top: 300, width: 800, height: 1200 })).toBe("moved");
		expect(carries.length).toBe(1);
		const [sx, sy] = carries[0]!;
		expect(sy, "precondition: the carry moved the tail's pixels").not.toBe(0);
		expect(o.predReal.map((s: { x: number; y: number }) => [s.x, s.y])).toEqual([[100 + sx, 500 + sy], [110 + sx, 505 + sy]]);
		expect(o.predLastTail.map((s: { x: number; y: number }) => [s.x, s.y])).toEqual([[120 + sx, 510 + sy]]);
		expect(real[0], "the builder's own sample objects are not written").toEqual({ x: 100, y: 500, pressure: 0.5, timestamp: 1 });
	});
});

describe("a pen landing inside a wheel zoom's quiet time", () => {
	it("ends the run before the contact, and the quiet timer is gone", () => {
		const o = bare();
		const run = new WheelZoomRun();
		const pinches: string[] = [];
		const cleared: number[] = [];
		Object.assign(o, {
			wheelZoomRun: run, wheelZoomTimer: 7,
			view: { dom: { ownerDocument: { defaultView: { clearTimeout: (id: number) => void cleared.push(id) } } } },
			pinch: (phase: string) => void pinches.push(phase),
			pinchGive: null, cancelOverscrollBounce: noop, restorePinchLayers: noop, rasterPanNeedsBake: () => false,
		});
		for (const step of run.feed({ deltaY: -40, deltaMode: 0, x: 300, y: 300, t: 0 })) pinches.push(step.phase);
		expect(run.isLive, "precondition: a run is under way").toBe(true);
		pinches.length = 0;
		o.beforePenDown();
		expect(pinches).toEqual(["end"]);
		expect(run.isLive).toBe(false);
		expect(o.wheelZoomTimer).toBe(0);
		expect(cleared).toEqual([7]);
	});
});

describe("hiding the pen cursor mid insert-space drag", () => {
	const rig = (mode: string, plan: object | null) => {
		const o = bare();
		const preview = { plan: { y: 100 } };
		Object.assign(o, {
			mode, spacePlan: plan, spacePreview: preview, spaceFeedbackRaf: null, spaceFeedbackKey: "k", spaceHoverY: 100,
			penCursorClient: { x: 0, y: 0 }, penCursorEl: null,
			clearHoverWatchdog: noop, redrawSelectionUI: noop,
			view: { scrollDOM: { classList: { remove: noop } } },
		});
		return { o, preview };
	};

	it("keeps the guide while the drag is live", () => {
		const { o, preview } = rig("space", { y: 100, from: 0, lineHeight: 24 });
		o.hidePenCursor();
		expect(o.spacePreview).toBe(preview);
		expect(o.penCursorClient).toBeNull();
	});

	it("control: with no drag the guide goes with the cursor", () => {
		const { o } = rig("ink", null);
		o.hidePenCursor();
		expect(o.spacePreview).toBeNull();
	});
});

describe("the snap chip stays inside the visible pane", () => {
	it("clamps to the part of the band the scroller shows", () => {
		const o = bare();
		// Band 1000 x 1400 css px starting 200 px above and left of the scroller's box; the scroller shows 800 x 600.
		const band = { getBoundingClientRect: () => ({ left: -200, top: -200, width: 1000, height: 1400 }) };
		Object.assign(o, {
			cssWidth: 1000, cssHeight: 1400,
			view: { scrollDOM: {
				getBoundingClientRect: () => ({ left: 0, top: 0, width: 815, height: 600 }),
				clientLeft: 0, clientTop: 0, clientWidth: 800, clientHeight: 600, offsetWidth: 815, offsetHeight: 600,
			} },
		});
		const area = o.visibleBandArea(band);
		expect(area).toEqual({ left: 200, top: 200, width: 800, height: 600 });
		// A shape ending 10 px above the pane's bottom edge: the chip stays inside the pane.
		const at = snapChipOrigin(500, 200 + 590, area);
		expect(at.top + SNAP_CHIP_H).toBeLessThanOrEqual(area.top + area.height);
		expect(at.top).toBe(area.top + area.height - SNAP_CHIP_H);
		// Near the pane's top-left the offset applies as before, from the pane's corner.
		expect(snapChipOrigin(210, 210, area)).toEqual({ left: 210 + SNAP_CHIP_OFFSET, top: 210 + SNAP_CHIP_OFFSET });
		expect(snapChipOrigin(100, 100, area), "never above or left of the pane").toEqual({ left: 200, top: 200 });
		expect(SNAP_CHIP_W).toBeGreaterThan(0);

		// The real offer hands the chip that area, not the band's own box.
		let offered: { pane: unknown } | null = null;
		Object.assign(o, {
			container: band, rawLastMoveX: 500, rawLastMoveY: 790,
			snapChip: { offer: (deps: { pane: unknown }) => { offered = deps; } },
		});
		(o.view as Fields).dom = { ownerDocument: { defaultView: {} } };
		o.offerSnapChip("note.md", {}, {});
		expect(offered!.pane).toEqual({ left: 200, top: 200, width: 800, height: 600 });
	});
});
