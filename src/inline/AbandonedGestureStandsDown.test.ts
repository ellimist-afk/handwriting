/**
 * The note surface's `onStrokeAbandoned` body, executed rather than grepped
 * for (D2, 1.4.10 audit).
 *
 * Nothing in the tree ran it. `AbandonStrokeOnSwitch.test.ts` proves the
 * ROUTER fires the callback against a counter, `InkSurfaceRules.test.ts` scans
 * this surface's raw source for `onStrokeAbandoned:` - which a comment
 * satisfies - and the body itself was reachable by neither: replacing it with
 * `() => {}` left every test in the tree green. The pdf half of the same hole
 * is closed in `PdfInkController.test.ts` ("a stroke torn down with no
 * pointerup stands the surface down"), which drives the real router because
 * that surface can be constructed; this surface cannot, so the body is a named
 * method and this file calls it.
 *
 * WHICH IS NOW THE ONLY THING THAT CALLS IT. Since the 2026-09-04 ruling a
 * window blur COMMITS through `finishActiveStroke()` -> `onPenUp`, so the
 * router's one remaining `onStrokeAbandoned` call site cannot fire with a
 * stroke live, and the note switch that would want this teardown runs it
 * inline in `update()` instead. The body is kept, and kept exercised here,
 * because the callback's contract still has a caller that could satisfy it -
 * `InkOverlay.strokeAbandoned`'s own header says the same in full.
 *
 * WHAT IS AND IS NOT PROVED HERE, said plainly rather than left for a later
 * reader to discover. `InkOverlayPlugin.mount()` wants real canvases and a 2d
 * context, so nothing in this repo builds one - which means the WIRING
 * (`onStrokeAbandoned: () => this.strokeAbandoned()`) is still held only by
 * the registry's source scan, and only the body below is behaviour. That is
 * the same limit `GestureReticlePersists.test.ts` works within, using the same
 * `Object.create` rig, and it is the reason the body is a method at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { InkOverlayPlugin, releaseTipModes } from "./InkOverlay";
import { SelectionModel } from "../objects/SelectionModel";
import { Camera } from "../camera/Camera";
import { StrokeFrame } from "./StrokeFrame";

interface Proto {
	strokeAbandoned(this: unknown): void;
}

interface Layer {
	cleared: number;
}

/**
 * A real `InkOverlayPlugin` built with `Object.create` so `mount()` never
 * runs, seeded mid-gesture: a live builder, a lasso loop in progress, a held
 * selection and a LOCKED stroke frame. Every field `strokeAbandoned` and the
 * `resetGestureState` under it touch is supplied; everything else is absent,
 * the same shape `GestureReticlePersists.test.ts`'s rig takes.
 */
function makeRig() {
	const noop = (): void => undefined;
	const cursorStyle: Record<string, unknown> = { display: "block" };
	const eraserStyle: Record<string, unknown> = { display: "block" };
	const highlightWetStyle: Record<string, unknown> = { opacity: "0" };
	const layer = (): Layer & { clear: () => void } => {
		const l = { cleared: 0, clear: () => void l.cleared++ };
		return l;
	};
	const wet = layer();
	const highlightWet = layer();
	const tail = { cleared: 0, clearAll: () => void tail.cleared++ };
	const inking: boolean[] = [];

	const inst = Object.create(InkOverlayPlugin.prototype) as Record<string, unknown>;

	// Mid-gesture, at the values a live lasso over a held selection has.
	inst.mode = "lasso";
	inst.builder = { live: true };
	inst.camera = new Camera();
	inst.cssScale = 1;
	inst.cssWidth = 800;
	inst.cssHeight = 600;
	inst.selection = new SelectionModel();
	inst.erased = [{ id: "s1" }];
	inst.lassoPts = [{ x: 1, y: 1 }];
	inst.lassoActive = true;
	inst.dragFrom = { x: 0, y: 0 };
	inst.dragTotal = { dx: 3, dy: 4 };
	inst.spaceLineY = 120;
	inst.spaceIds = ["s1"];
	inst.spaceBounds = { x: 0, y: 0 };
	inst.spaceClient = { x: 0, y: 0 };
	inst.spaceTotalDy = 9;
	inst.panLast = { x: 5, y: 5 };
	inst.hoverWatchdog = null;
	inst.selectionDeleteKeys = { reset: noop };

	// The frame lock a live stroke holds. Left held, it freezes the NEXT
	// note's camera and repaints until its first pen-down (the v0.13.6
	// lifecycle rule `resetGestureState` states in its own header).
	const frame = new StrokeFrame();
	frame.begin();
	inst.frame = frame;

	inst.wet = wet;
	inst.highlightWet = highlightWet;
	inst.tail = tail;
	inst.highlightWetCanvas = {
		setCssStyles: (styles: Record<string, unknown>) =>
			Object.assign(highlightWetStyle, styles),
	};
	inst.penCursorEl = {
		setCssStyles: (styles: Record<string, unknown>) => Object.assign(cursorStyle, styles),
	};
	inst.eraserEl = {
		setCssStyles: (styles: Record<string, unknown>) => Object.assign(eraserStyle, styles),
	};
	// The strip. Real enough for `stripPenUp`, which is all this path asks of
	// it - `setInking(false)` now and a `refresh()` on the microtask.
	inst.mobileTools = {
		setInking: (on: boolean) => void inking.push(on),
		refresh: noop,
		closeInkSliders: noop,
	};
	inst.view = {
		dom: { ownerDocument: { defaultView: { setTimeout: vi.fn(() => 1), clearTimeout: vi.fn() } } },
		scrollDOM: { classList: { add: noop, remove: noop } },
	};

	const proto = InkOverlayPlugin.prototype as unknown as Proto;
	return { inst, proto, cursorStyle, highlightWetStyle, wet, highlightWet, tail, inking };
}

describe("the note surface stands its own gesture down when a stroke is abandoned", () => {
	beforeEach(() => {
		releaseTipModes();
	});

	it("puts the strip chrome back down", () => {
		// f5f2333's payload, on the note-switch path: the contact ran
		// stripPenDown -> setInking(true), and abandoning ends the stroke with
		// no PointerEvent for penUp to receive, so nothing else puts
		// `is-inking` back.
		const rig = makeRig();

		rig.proto.strokeAbandoned.call(rig.inst);

		expect(rig.inking).toEqual([false]);
	});

	it("resets the gesture state, releasing the stroke frame lock", () => {
		const rig = makeRig();
		expect((rig.inst.frame as StrokeFrame).locked).toBe(true);

		rig.proto.strokeAbandoned.call(rig.inst);

		expect(
			(rig.inst.frame as StrokeFrame).locked,
			"the abandoned stroke kept the frame lock, freezing the next note's camera"
		).toBe(false);
		expect(rig.inst.builder).toBe(null);
		expect(rig.inst.mode).toBe("ink");
		expect(rig.inst.lassoPts).toEqual([]);
		expect(rig.inst.spaceLineY).toBe(null);
		expect(rig.inst.dragFrom).toBe(null);
		expect(rig.inst.panLast).toBe(null);
	});

	it("clears the wet layers, so the abandoned stroke stops being painted", () => {
		// The update() path-change branch clears these beside its own abandon,
		// and this body has to carry the same three lines: a teardown that
		// reached the strip alone left the half-drawn stroke painted on the
		// wet layer over a note nobody had drawn it on.
		const rig = makeRig();

		rig.proto.strokeAbandoned.call(rig.inst);

		expect(rig.wet.cleared).toBe(1);
		expect(rig.highlightWet.cleared).toBe(1);
		expect(rig.tail.cleared).toBe(1);
		// And the wet highlighter element goes back to its visible opacity: a
		// handoff caught mid-flight would otherwise strand it hidden for every
		// later stroke, the same way the file switch would.
		expect(rig.highlightWetStyle.opacity).not.toBe("0");
	});

	it("takes the reticle with it", () => {
		const rig = makeRig();

		rig.proto.strokeAbandoned.call(rig.inst);

		expect(rig.cursorStyle.display).toBe("none");
	});
});
