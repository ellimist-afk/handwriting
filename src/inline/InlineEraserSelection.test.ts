/**
 * The eraser is reachable INSIDE a live lasso selection.
 *
 * `InkOverlayPlugin.penDown` runs the selection-grab test before the eraser
 * branch, and that test asked only whether the contact landed inside the
 * selection's padded bounds. So a pen landing on its own selection was routed
 * to `lassoDown` even when the eraser owned the tip: the ink you had just
 * lassoed was the one ink on the page the eraser could not touch, and the only
 * way out was to dismiss the selection first.
 *
 * The rule the file already states is the fix. Three lines under the grab
 * test: "Tip and eraser return the pen to normal behavior: selection
 * dissolves." The grab is the BARE TIP's gesture - OneNote's grammar, where
 * the side button selects and the tip moves - and an eraser is not a bare tip.
 *
 * Not a 1.4.6 or 1.4.7 regression: the same ordering is present in
 * `refs/tags/1.4.5`.
 *
 * Both directions are asserted here, because the fix is a narrowing and a
 * narrowing can take too much: the nib still grabs, which is the gesture the
 * grab exists for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InkOverlayPlugin, setInlineTool } from "./InkOverlay";
import { SelectionModel } from "../objects/SelectionModel";
import { resetTipModeForTest, setTipMode } from "./TipMode";
import { DEFAULT_PEN } from "../ink/PenStyle";

/** The selection's world bounds; the contact below lands in the middle. */
const BOUNDS = { x: 0, y: 0, width: 100, height: 100 };
const INSIDE = { x: 50, y: 50 };
/** Clear of the padded box, its handles and the Attach button below it. */
const OUTSIDE = { x: 300, y: 300 };

interface Rig {
	/** A pen contact at `at`, through the real `penDown`. */
	penDown(at: { x: number; y: number }, pointerType?: string): void;
	/** The gesture `penDown` chose. */
	mode(): string;
	/** Whether the selection-grab claimed the contact. */
	grabbed: ReturnType<typeof vi.fn>;
	/** Whether the eraser gesture opened. */
	erased: ReturnType<typeof vi.fn>;
	/** The actual wet/head contact written by an ink down, including a dot. */
	wetDown: ReturnType<typeof vi.fn>;
	headDown: ReturnType<typeof vi.fn>;
	/** Per-stroke pressure state that gates persisted hardware calibration. */
	pressureState(): { gain: number; observesPen: boolean };
	/** Whether the live selection is gone. */
	selectionEmpty(): boolean;
}

function makeRig(): Rig {
	const view = Object.create(InkOverlayPlugin.prototype) as Record<string, unknown>;
	const grabbed = vi.fn();
	const erased = vi.fn();

	view.mode = "ink";
	view.scale = 1;
	view.erased = [];
	view.eraseFrom = [];
	view.eraseWhole = true;
	view.penCursorEl = null;
	view.router = null;
	// stripPenDown takes a nullable strip and no-ops on null.
	view.mobileTools = null;
	view.penStyle = { ...DEFAULT_PEN };
	view.highlighterStyle = { ...DEFAULT_PEN };
	const wetDown = vi.fn();
	const headDown = vi.fn();
	const wet = {
		shape: true,
		beginStroke: wetDown,
		contactHalfWidth: () => 1,
	};
	view.wet = wet;
	view.highlightWet = wet;
	view.predReal = [];
	view.predLastTail = [];
	view.tail = {
		clear: () => undefined, drawHead: headDown,
		configureInlineBacking: () => undefined,
		placeInline: () => undefined,
		restoreFullSurface: () => undefined,
		prepareLive: () => undefined,
	};
	// focusClaimedPenEditor's whole contract: already focused, nothing to do.
	view.view = { hasFocus: true, focus: () => undefined };
	view.frame = { locked: false, begin: () => undefined, end: () => undefined, cancel: () => undefined };
	// The lasso's handle test reads the camera's zoom: a selection's handles are sized in screen px.
	view.camera = { screenToWorld: (x: number, y: number) => ({ x, y }), snapshot: { x: 0, y: 0, zoom: 1 } };

	// A live selection: one stroke id is enough, since the grab test asks
	// `isEmpty` and then consults `selectionBounds` rather than the members.
	// Object.create skips field initialisers, so the model is built here
	// rather than inherited - the real class, not a stand-in for isEmpty.
	const selection = new SelectionModel();
	selection.selectExactly(["s1"]);
	view.selection = selection;

	// Own properties, so the prototype's versions never run: each of these
	// reaches the editor, the store or the canvas, and none is the subject.
	view.syncCamera = () => undefined;
	view.captureProbeGeometry = () => undefined;
	view.recordPenDownState = () => undefined;
	view.redrawSelectionUI = () => undefined;
	view.selectionBounds = () => BOUNDS;
	view.lassoDown = grabbed;
	view.filePath = () => "note.md";
	view.startFrameTicker = () => undefined;
	view.ensurePenTools = () => undefined;
	view.probeSample = () => undefined;
	view.showEraserCursor = () => undefined;
	view.eraseAt = erased;

	const proto = InkOverlayPlugin.prototype as unknown as {
		penDown(this: unknown, sample: unknown, ev: unknown): void;
	};
	return {
		penDown(at, pointerType = "pen") {
			const sample = { ...at, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 };
			// A plain tip: no eraser end (bit 32), no side button (bit 2).
			const ev = { buttons: 1, button: 0, clientX: at.x, clientY: at.y, pointerType };
			proto.penDown.call(view, sample, ev);
		},
		mode: () => view.mode as string,
		grabbed,
		erased,
		wetDown,
		headDown,
		pressureState: () => ({
			gain: view.strokeGain as number,
			observesPen: view.strokePenGesture as boolean,
		}),
		selectionEmpty: () => selection.isEmpty,
	};
}

describe("a pen landing inside a live selection", () => {
	beforeEach(() => resetTipModeForTest());
	afterEach(() => resetTipModeForTest());

	it("erases when the eraser owns the tip, instead of dragging the selection", () => {
		setTipMode("eraser");
		const rig = makeRig();

		rig.penDown(INSIDE);

		expect(rig.mode()).toBe("erase");
		expect(rig.grabbed).not.toHaveBeenCalled();
		expect(rig.erased).toHaveBeenCalledTimes(1);
	});

	it("still drags the selection under a bare nib", () => {
		// The gesture the grab exists for. If the fix takes this too, it has
		// removed OneNote's grammar rather than excluding the eraser from it.
		setTipMode("nib");
		const rig = makeRig();

		rig.penDown(INSIDE);

		expect(rig.mode()).toBe("lasso");
		expect(rig.grabbed).toHaveBeenCalledTimes(1);
	});

	it("a finger the router claimed inside the box takes the selection: a lasso contact, no ink, the selection kept", () => {
		// Since the Attach rethink a finger reaches penDown inside the box only as the router's claim past the tap limit.
		setTipMode("nib");
		setInlineTool("pen");
		const rig = makeRig();

		rig.penDown(INSIDE, "touch");

		expect(rig.mode()).toBe("lasso");
		expect(rig.grabbed).toHaveBeenCalledTimes(1);
		expect(rig.wetDown).not.toHaveBeenCalled();
		expect(rig.headDown).not.toHaveBeenCalled();
		expect(rig.selectionEmpty(), "the selection kept").toBe(false);
	});

	it("clears a stale selection and inks when the eligible contact is a finger outside the padded box", () => {
		setTipMode("nib");
		setInlineTool("pen");
		const rig = makeRig();

		rig.penDown(OUTSIDE, "touch");

		expect(rig.selectionEmpty(), "the selection cleared").toBe(true);
		expect(rig.mode()).toBe("ink");
		expect(rig.grabbed).not.toHaveBeenCalled();
		expect(rig.wetDown).toHaveBeenCalledTimes(1);
		expect(rig.headDown).toHaveBeenCalledTimes(1);
		expect(rig.pressureState()).toEqual({ gain: 1, observesPen: false });
	});
});

/**
 * ERASER-FINGER: a finger never erases, whatever tool is lit. With the eraser lit a
 * finger reaches penDown only as the selection's claim (finger ink needs the nib, FingerInk.ts). Inside the box it takes
 * the selection as with the nib. BR-1: a claimed finger whose contact test at pen-down misses (the claim tested the
 * landing before the pre-down hook) must not fall through to the erase branch either. A pen and a mouse with the eraser
 * lit still erase inside the selection and dissolve it (the rule this file's first cell pins).
 */
describe("ERASER-FINGER: with the eraser lit a finger never erases", () => {
	beforeEach(() => resetTipModeForTest());
	afterEach(() => resetTipModeForTest());

	it("BR-1: a claimed finger that misses the selection at pen-down: nothing erased, the selection kept, no grab, no ink", () => {
		setTipMode("eraser");
		const rig = makeRig();

		rig.penDown(OUTSIDE, "touch");

		expect(rig.erased, "BR-1: nothing erased (a stroke at OUTSIDE kept)").not.toHaveBeenCalled();
		expect(rig.mode(), "BR-1: not the eraser's gesture").not.toBe("erase");
		expect(rig.selectionEmpty(), "BR-1: the selection kept").toBe(false);
		expect(rig.grabbed, "BR-1: nothing under it to grab").not.toHaveBeenCalled();
		expect(rig.wetDown, "BR-1: no ink").not.toHaveBeenCalled();
	});

	it("a claimed finger inside the box takes the selection as with the nib: a lasso contact, nothing erased, the selection kept", () => {
		setTipMode("eraser");
		const rig = makeRig();

		rig.penDown(INSIDE, "touch");

		expect(rig.erased, "nothing erased").not.toHaveBeenCalled();
		expect(rig.mode()).toBe("lasso");
		expect(rig.grabbed).toHaveBeenCalledTimes(1);
		expect(rig.selectionEmpty(), "the selection kept").toBe(false);
	});

	for (const pointerType of ["pen", "mouse"]) {
		it(`PIN: a ${pointerType} with the eraser lit inside the box erases and dissolves the selection, as today`, () => {
			setTipMode("eraser");
			const rig = makeRig();

			rig.penDown(INSIDE, pointerType);

			expect(rig.mode()).toBe("erase");
			expect(rig.erased).toHaveBeenCalledTimes(1);
			expect(rig.grabbed).not.toHaveBeenCalled();
			expect(rig.selectionEmpty(), "the selection dissolved").toBe(true);
		});
	}
});
