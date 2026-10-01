/**
 * The pinch preview holds CodeMirror's measuring.
 *
 * Every preview frame writes the counter-sized host box; CodeMirror's observer
 * schedules a measure for it, and that measure rescales `scrollTop` by the
 * previous-to-next scale ratio after the plugin's pan solve ran, so text and
 * ink leave the pane together on every frame it runs (far fixture: 114820 ->
 * 105252 at k 0.10 -> 0.11). The preview is a transform and a translate and
 * needs no CodeMirror measure, so both entries - the scheduler
 * `requestMeasure` and the sink `measure` - are held while the preview lives
 * and released on every end path, replaying what other callers asked for
 * meanwhile, last per key, the way CodeMirror keeps them.
 *
 * This drives the real `pinch` / `applyPinchScale` / `flushPinch` route the
 * way PinchEndPending.test.ts does; only the frame clock, the timers, the
 * style sinks and the final layout transaction are controlled. The fake view
 * owns both entries (spies), which is also what the hold must put back:
 * production CodeMirror reaches them through the prototype and gets them back
 * by deletion, a fixture with own properties gets those.
 *
 * Plants: a release that returns early (CodeMirror never measures again: the
 * "measures again" arms go red); a hold on the scheduler only (a callback
 * CodeMirror scheduled before the hold measures under it: the pending-callback
 * arm goes red).
 */
import { describe, expect, it, vi } from "vitest";

(globalThis as { window?: unknown }).window = globalThis;

import { InkOverlayPlugin } from "./InkOverlay";

type Phase = "start" | "move" | "end";
type Point = { x: number; y: number };
type Fields = Record<string, unknown>;

interface OverlayPrototype {
	pinch(this: unknown, phase: Phase, ratio: number, centroid: Point): void;
	restoreViewportLayout(this: unknown): void;
}

/**
 * `shared`, when given, is another rig's `view` (and only that): this rig's
 * overlay is installed on the SAME view object, the same way a successor
 * plugin on the same EditorView would be. Since `winRef` is derived from
 * `view.dom.ownerDocument.defaultView`, sharing `view` also shares the
 * window mock underneath - one frames map, one timers map, for both rigs -
 * so a shared rig does not get its own frame-stepping helpers; step frames
 * and fire timers through the rig that built the shared view instead.
 */
function makeRig(shared?: { view: Fields }) {
	let view: Fields;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let host: any;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let scroller: any;
	let requestMeasure: ReturnType<typeof vi.fn>;
	let measure: ReturnType<typeof vi.fn>;
	let setTimeout: ReturnType<typeof vi.fn>;
	let clearTimeout: ReturnType<typeof vi.fn>;
	const frames = new Map<number, FrameRequestCallback>();
	const timers = new Map<number, () => void>();
	const hostStyles: Record<string, string> = {};

	if (shared) {
		view = shared.view;
		host = view.dom as Fields;
		scroller = view.scrollDOM as Fields;
		requestMeasure = view.requestMeasure as ReturnType<typeof vi.fn>;
		measure = view.measure as ReturnType<typeof vi.fn>;
		// This rig's own (unshared) frames/timers maps above are never fed:
		// production reaches the SHARED window through `view.dom`, so a
		// caller who steps frames/timers on THIS rig gets a clear "expected
		// one requested animation frame" rather than a silent wrong answer.
		// setTimeout/clearTimeout are exposed anyway for API uniformity.
		const sharedWin = (host.ownerDocument as Fields).defaultView as Fields;
		setTimeout = sharedWin.setTimeout as ReturnType<typeof vi.fn>;
		clearTimeout = sharedWin.clearTimeout as ReturnType<typeof vi.fn>;
	} else {
		let nextFrame = 1;
		const requestAnimationFrame = vi.fn((callback: FrameRequestCallback): number => {
			const id = nextFrame++;
			frames.set(id, callback);
			return id;
		});
		const cancelAnimationFrame = vi.fn((id: number): void => {
			frames.delete(id);
		});
		let nextTimer = 1;
		setTimeout = vi.fn((callback: () => void, _ms: number): number => {
			const id = nextTimer++;
			timers.set(id, callback);
			return id;
		});
		clearTimeout = vi.fn((id: number): void => {
			timers.delete(id);
		});
		const win = { requestAnimationFrame, cancelAnimationFrame, setTimeout, clearTimeout };
		host = {
			clientWidth: 640, clientHeight: 480,
			ownerDocument: { defaultView: win },
			getBoundingClientRect: () => ({ left: 0, top: 0 }),
			style: {
				removeProperty(name: string): void { delete hostStyles[name]; },
			},
			setCssStyles(styles: Record<string, string>): void { Object.assign(hostStyles, styles); },
		};
		scroller = {
			scrollLeft: 12,
			scrollTop: 20,
			getBoundingClientRect: () => ({ left: 0, top: 0 }),
		};
		requestMeasure = vi.fn();
		measure = vi.fn();
		view = { dom: host, scrollDOM: scroller, contentDOM: { getBoundingClientRect: () => ({ left: 0, top: 0 }), children: [] as unknown[] }, requestMeasure, measure };
	}

	const overlay = Object.create(InkOverlayPlugin.prototype) as Fields;
	overlay.view = view;
	// The overlay container's clip comes off with the hold and back with the release.
	const containerStyles = vi.fn();
	overlay.container = { setCssStyles: containerStyles };
	overlay.frame = { locked: false }; overlay.cssScale = 1; overlay.fontZoom = 1;
	// THIS RIG'S SUBJECT IS ZOOM MECHANICS, so its note is a CANVAS note. With the canvas off a
	// two-finger gesture is not a zoom at all (`pinch` returns on its first line), and a fixture left in
	// that mode would run none of the code these arms are about while still reporting a result - measured,
	// the mode gate alone turned several of them green by doing nothing. `canvasMode` is a class field and
	// `Object.create` runs no field initializers, so it is set here rather than assumed.
	overlay.canvasMode = true;
	overlay.pinchScaleNow = 1;
	overlay.pinchRasterScale = 1;
	overlay.pinchRefScale = null;
	overlay.pinchStartPan = { x: 0, y: 0 };
	overlay.pinchBand = { history: [] as number[], lastPan: { x: 0, y: 0 } };
	overlay.pinchAnchor = null;
	overlay.pinchPending = null;
	overlay.pinchRaf = 0;
	overlay.pinchScrollAt = 0;
	overlay.pinchHiddenCanvases = new Map();
	overlay.handleResize = vi.fn();
	overlay.getNoteViewportState = () => ({ busy: false });
	// Production re-establishes `viewportLayout` here if a caller (like
	// `restoreViewportLayout`) nulled it; a stub that only returns true
	// without doing that leaves a later pinch reading `layout.width` off
	// null, which no prior test in this file exercised.
	overlay.prepareViewportLayout = () => {
		if (!overlay.viewportLayout) overlay.viewportLayout = { width: 640, height: 480, baseTransform: "none" };
		return true;
	};
	overlay.viewportLayout = { width: 640, height: 480, baseTransform: "none" };
	overlay.applyViewportBox = (next: number) => host.setCssStyles({ transform: `scale(${next})`, transformOrigin: "0 0" });
	// The settle's own measure request, as the production transaction makes one.
	const settles: number[] = [];
	const settleScrolls: { left: number; top: number }[] = [];
	const settleTargets: { x: number; y: number }[] = [];
	overlay.commitCameraScale = (next: number, scroll?: { left: number; top: number }) => {
		settles.push(next);
		if (scroll) settleScrolls.push(scroll);
		const anchor = overlay.pinchAnchor as { targetX?: number; targetY?: number; focalX?: number; focalY?: number } | null;
		if (anchor) settleTargets.push({ x: anchor.targetX ?? anchor.focalX ?? NaN, y: anchor.targetY ?? anchor.focalY ?? NaN });
		overlay.pinchScaleNow = next;
		overlay.cssScale = next;
		host.setCssStyles({ transform: `scale(${next})`, transformOrigin: "0 0" });
		(view as { requestMeasure: () => void }).requestMeasure();
		return true;
	};

	const prototype = InkOverlayPlugin.prototype as unknown as OverlayPrototype;
	const onPinch = (phase: Phase, ratio: number, centroid: Point): void =>
		prototype.pinch.call(overlay, phase, ratio, centroid);
	const runNextFrame = (): void => {
		const entry = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
		if (!entry) throw new Error("expected one requested animation frame");
		frames.delete(entry[0]);
		entry[1](0);
	};
	const runLastFrame = (): void => {
		const entries = [...frames.entries()];
		const entry = entries[entries.length - 1];
		if (!entry) throw new Error("expected a requested animation frame");
		frames.delete(entry[0]);
		entry[1](0);
	};
	const runFrames = (): number => {
		let n = 0;
		while (frames.size) { runNextFrame(); n++; }
		return n;
	};
	const fireTimers = (): number => {
		const due = [...timers.values()];
		timers.clear();
		for (const callback of due) callback();
		return due.length;
	};
	/** What the view's entry currently is: the spy, or the hold's shadow. */
	const entry = (name: "requestMeasure" | "measure"): unknown => Object.getOwnPropertyDescriptor(view, name)?.value;
	const held = (): boolean => entry("requestMeasure") !== requestMeasure && entry("measure") !== measure;
	/** Calls the scheduler spy received with no request (a plain measure). */
	const plainCalls = (): number => requestMeasure.mock.calls.filter((call) => call.length === 0 || call[0] === undefined).length;
	const previewAt = (ratio: number): void => { onPinch("move", ratio, { x: 100, y: 80 }); runNextFrame(); };
	const reset = (): void => { overlay.viewportLayout = null; prototype.restoreViewportLayout.call(overlay); };

	return { onPinch, previewAt, runNextFrame, runLastFrame, runFrames, fireTimers, entry, held, plainCalls, requestMeasure, measure, containerStyles, view, overlay, settles, settleScrolls, settleTargets, setTimeout, clearTimeout, reset, pendingTimers: () => timers.size, pendingFrames: () => frames.size, scale: () => overlay.pinchScaleNow as number, scroller, transform: () => hostStyles.transform };
}

const centroid = { x: 100, y: 80 };

describe("InkOverlay pinch preview holds CodeMirror's measuring", () => {
	it("holds both entries for the preview and replays what was asked, last per key, at the settle", () => {
		const rig = makeRig();
		rig.onPinch("start", 1, centroid);
		rig.previewAt(2);
		expect(rig.held(), "the preview frame did not take both entries").toBe(true);

		// CodeMirror's observers and other plugins ask for measures mid-preview.
		const ask = rig.view.requestMeasure as (request?: object) => void;
		const keyedFirst = { key: "k", read: () => 1 }, keyedLast = { key: "k", read: () => 2 }, unkeyed = { read: () => 3 };
		ask();
		ask(keyedFirst);
		ask(unkeyed);
		ask(keyedLast);
		ask(unkeyed);
		expect(rig.requestMeasure, "a mid-preview request reached CodeMirror").not.toHaveBeenCalled();
		expect(rig.measure).not.toHaveBeenCalled();

		rig.onPinch("end", 2, centroid);
		expect(rig.held()).toBe(false);
		expect(rig.entry("requestMeasure"), "the settle did not put the scheduler back").toBe(rig.requestMeasure);
		expect(rig.entry("measure"), "the settle did not put the sink back").toBe(rig.measure);
		const objects = rig.requestMeasure.mock.calls.map((call) => call[0]).filter((request) => request !== undefined);
		expect(objects, "keyed requests replay last-per-key, unkeyed ones once").toEqual([keyedLast, unkeyed]);
		// The settle transaction's own plain request goes straight through.
		expect(rig.plainCalls()).toBe(1);
		// What was held is measured AT the release, synchronously, through the
		// captured sink: CodeMirror's fold of the preview scroll lands before
		// the settle's own scroll write, never after it.
		expect(rig.measure, "CodeMirror does not measure again after the settle").toHaveBeenCalledTimes(1);
		expect(rig.measure).toHaveBeenCalledWith(false);
		const plainAt = rig.requestMeasure.mock.calls.findIndex((call) => call.length === 0 || call[0] === undefined);
		expect(rig.measure.mock.invocationCallOrder[0]!, "the fold came after the settle's own request").toBeLessThan(rig.requestMeasure.mock.invocationCallOrder[plainAt]!);
		expect(rig.pendingFrames(), "the release left a frame queued").toBe(0);
		expect(rig.pendingTimers(), "the lost-end timer outlived the settle").toBe(0);
		// The container's clip came off with the hold and went back with the release.
		expect(rig.containerStyles.mock.calls.map((c) => c[0])).toEqual([{ overflow: "visible" }, { overflow: "hidden" }]);
	});

	it("a measure callback CodeMirror scheduled before the hold resolves to the shadow and measures after the settle", () => {
		const rig = makeRig();
		// CodeMirror's animation-frame callback is `() => this.measure()`: it
		// resolves the entry when it fires, which is after the hold went on.
		const scheduledBeforeTheHold = () => (rig.view as { measure: (flush?: boolean) => void }).measure();
		rig.onPinch("start", 1, centroid);
		rig.previewAt(2);
		scheduledBeforeTheHold();
		expect(rig.measure, "the pending callback measured under the preview").not.toHaveBeenCalled();
		rig.onPinch("end", 2, centroid);
		rig.runFrames();
		expect(rig.measure, "the swallowed callback was never made up for").toHaveBeenCalledTimes(1);
	});

	it("holds nothing outside a preview and nothing after a settle", () => {
		const rig = makeRig();
		const ask = rig.view.requestMeasure as (request?: object) => void;
		ask();
		expect(rig.requestMeasure).toHaveBeenCalledTimes(1);
		expect(rig.setTimeout).not.toHaveBeenCalled();
		rig.onPinch("start", 1, centroid);
		rig.previewAt(2);
		rig.onPinch("end", 2, centroid);
		rig.runFrames();
		(rig.view as { measure: () => void }).measure();
		ask();
		expect(rig.requestMeasure).toHaveBeenCalledTimes(3);
		// Nothing was held in that preview, so the release measured nothing.
		expect(rig.measure).toHaveBeenCalledTimes(1);
	});

	it("the router's cancel, an end at the start ratio, releases", () => {
		const rig = makeRig();
		rig.onPinch("start", 1, centroid);
		rig.previewAt(2);
		(rig.view.requestMeasure as () => void)();
		rig.onPinch("end", 1, centroid);
		expect(rig.held()).toBe(false);
		rig.runFrames();
		expect(rig.measure).toHaveBeenCalledTimes(1);
	});

	it("the reset path releases, with the make-up measure a frame later (it can run inside CodeMirror's update)", () => {
		const rig = makeRig();
		rig.onPinch("start", 1, centroid);
		rig.previewAt(2);
		(rig.view.requestMeasure as () => void)();
		rig.reset();
		expect(rig.held()).toBe(false);
		expect(rig.measure, "the reset measured synchronously").not.toHaveBeenCalled();
		expect(rig.pendingFrames()).toBe(1);
		rig.runFrames();
		expect(rig.measure).toHaveBeenCalledTimes(1);
	});

	it("a deferred make-up measure that fires under a newer hold belongs to that hold", () => {
		const rig = makeRig();
		rig.onPinch("start", 1, centroid);
		rig.previewAt(2);
		(rig.view.requestMeasure as () => void)();
		rig.reset();
		// A new gesture installs its hold before the deferred callback fires.
		rig.onPinch("start", 1, centroid);
		rig.onPinch("move", 2, centroid);
		rig.runLastFrame();
		expect(rig.held()).toBe(true);
		rig.runFrames();
		expect(rig.measure, "the captured sink measured under the new hold").not.toHaveBeenCalled();
		rig.onPinch("end", 2, centroid);
		expect(rig.measure, "the swallowed callback was not replayed at the new hold's release").toHaveBeenCalledTimes(1);
	});

	it("the watchdog re-anchors at the raw client centroid, so a still constrained hold does not move", () => {
		const rig = makeRig();
		rig.onPinch("start", 1, centroid);
		rig.previewAt(2);
		// A constraint that accepted the target 50 px left of the fingers.
		const anchor = rig.overlay.pinchAnchor as { constraint: unknown; targetX: number; targetY: number; focalX: number };
		anchor.constraint = { clientX: centroid.x, clientY: centroid.y, offsetX: -50, offsetY: 0, geometry: null };
		anchor.targetX = centroid.x - 50; anchor.targetY = centroid.y;

		// THE FINAL POSITION, not only the anchor (R5). "Scroll stays
		// unchanged" is not the invariant: the rig's scroller is a plain
		// object that never moves during a transform-only preview (production
		// spends the preview's transform into real scroll only at settle), so
		// the scroll BEFORE the watchdog fires is not a meaningful baseline.
		// The actual contract is "the watchdog settles exactly where a normal
		// lift from the identical state would" - so build a second rig, same
		// start/preview/constraint, and let it lift normally to get that
		// reference point.
		const lift = makeRig();
		lift.onPinch("start", 1, centroid);
		lift.previewAt(2);
		const liftAnchor = lift.overlay.pinchAnchor as { constraint: unknown; targetX: number; targetY: number };
		liftAnchor.constraint = { clientX: centroid.x, clientY: centroid.y, offsetX: -50, offsetY: 0, geometry: null };
		liftAnchor.targetX = centroid.x - 50; liftAnchor.targetY = centroid.y;
		lift.onPinch("end", 2, centroid);

		const beforeTransform = rig.transform();
		rig.fireTimers();
		const next = rig.overlay.pinchAnchor as { focalX: number; constraint: { clientX: number } | null };
		expect(next.focalX, "the re-anchor took the offset target as the fingers").toBe(centroid.x);
		expect(next.constraint?.clientX ?? next.focalX).toBe(centroid.x);
		expect(rig.settles, "the watchdog settled more than once").toHaveLength(1);
		expect(rig.transform(), "the scale changed for a still hold").toBe(beforeTransform);
		// Accepted target = client + offset, once (not doubled, not dropped).
		expect(rig.settleTargets[0], "the accepted target reaching the settle was not client + offset").toEqual({ x: centroid.x - 50, y: centroid.y });
		// The source contract: the watchdog settles exactly where a lift from
		// the same state would.
		expect(rig.settleScrolls[0], "the watchdog did not settle where a normal lift would").toEqual(lift.settleScrolls[0]);
	});

	it("a deferred replay fires after a successor overlay installed its own hold on the same view, and belongs to that hold", () => {
		const a = makeRig();
		a.onPinch("start", 1, centroid);
		a.previewAt(2);
		(a.view.requestMeasure as () => void)();
		a.reset();
		// Production premise: A's teardown never clears `this.view`, so A's
		// deferred callback (still pending, captured against this exact view
		// object) is live when a successor plugin mounts on the same view.
		expect(a.overlay.view, "A's view was cleared on teardown").toBe(a.view);

		const b = makeRig({ view: a.view });
		b.onPinch("start", 1, centroid);
		// Not `b.previewAt`: that would call B's own (unshared, and therefore
		// always-empty) frame stepper. Schedule the preview frame directly and
		// step it through A's stepper, which reaches the one shared map.
		b.onPinch("move", 2, centroid);
		a.runLastFrame();
		expect(b.held(), "B's hold did not take on the shared view").toBe(true);

		// A's earlier-queued deferred callback, still pending, fires now -
		// under B's live hold.
		a.runFrames();
		expect(a.measure, "the captured sink measured beneath a successor's hold").not.toHaveBeenCalled();
		expect(
			(b.overlay.measureHold as { swallowed: boolean } | null)?.swallowed,
			"B's hold did not record the swallowed callback"
		).toBe(true);

		b.onPinch("end", 2, centroid);
		expect(a.measure, "the swallowed callback did not replay exactly once, at B's release").toHaveBeenCalledTimes(1);
	});

	it("the watchdog settles a live preview in place and re-anchors it; later ratios continue from there", () => {
		const rig = makeRig();
		rig.onPinch("start", 1, centroid);
		rig.previewAt(2);
		(rig.view.requestMeasure as () => void)();
		// A second preview frame re-arms the same bound rather than stacking timers.
		rig.previewAt(2.5);
		expect(rig.pendingTimers(), "each preview frame armed its own timer").toBe(1);

		expect(rig.fireTimers()).toBe(1);
		expect(rig.settles, "the watchdog did not settle at the scale on screen").toEqual([2.5]);
		expect(rig.held(), "the watchdog left the entries held").toBe(false);
		expect(rig.pendingTimers()).toBe(0);
		rig.runFrames();
		expect(rig.measure, "CodeMirror does not measure again after the watchdog").toHaveBeenCalledTimes(1);

		// Fingers still down: the router's next ratio is relative to ITS start
		// (3 = 2.5 x 1.2), and the gesture continues from the settled scale.
		rig.previewAt(3);
		expect(rig.scale()).toBeCloseTo(3, 6);
		expect(rig.held(), "the continued gesture did not hold again").toBe(true);
		rig.onPinch("end", 3, centroid);
		expect(rig.scale()).toBeCloseTo(3, 6);
		expect(rig.settles).toEqual([2.5, 3]);
		expect(rig.held()).toBe(false);
	});

	it("a shadow is inert once its hold is over, and a wrapper that took the entry keeps it", () => {
		const rig = makeRig();
		rig.onPinch("start", 1, centroid);
		rig.previewAt(2);
		const shadow = rig.entry("requestMeasure") as (request?: object) => void;
		(rig.view.requestMeasure as () => void)();
		// Another wrapper displaces the hold's shadow and keeps a reference to it.
		const foreign = vi.fn((request?: object) => shadow(request));
		Object.defineProperty(rig.view, "requestMeasure", { configurable: true, writable: true, value: foreign });
		rig.onPinch("end", 2, centroid);
		expect(rig.entry("requestMeasure"), "the release clobbered the wrapper that owns the entry").toBe(foreign);
		expect(rig.entry("measure")).toBe(rig.measure);
		// The settle's own request went through the wrapper, and the wrapper's
		// call into the inert shadow reached the captured predecessor: no loop,
		// nothing queued into a dead hold.
		expect(foreign).toHaveBeenCalledTimes(1);
		expect(rig.requestMeasure).toHaveBeenCalledTimes(1);
		shadow();
		expect(rig.requestMeasure).toHaveBeenCalledTimes(2);
	});
});
