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

import { InkOverlayPlugin } from "./InkOverlay";
import { SelectionModel } from "../objects/SelectionModel";
import { resetTipModeForTest, setTipMode } from "./TipMode";

/** The selection's world bounds; the contact below lands in the middle. */
const BOUNDS = { x: 0, y: 0, width: 100, height: 100 };
const INSIDE = { x: 50, y: 50 };

interface Rig {
	/** A pen contact at `at`, through the real `penDown`. */
	penDown(at: { x: number; y: number }): void;
	/** The gesture `penDown` chose. */
	mode(): string;
	/** Whether the selection-grab claimed the contact. */
	grabbed: ReturnType<typeof vi.fn>;
	/** Whether the eraser gesture opened. */
	erased: ReturnType<typeof vi.fn>;
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
	// focusClaimedPenEditor's whole contract: already focused, nothing to do.
	view.view = { hasFocus: true, focus: () => undefined };
	view.frame = { locked: false, begin: () => undefined, end: () => undefined, cancel: () => undefined };
	view.camera = { screenToWorld: (x: number, y: number) => ({ x, y }) };

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
	view.showEraserCursor = () => undefined;
	view.eraseAt = erased;

	const proto = InkOverlayPlugin.prototype as unknown as {
		penDown(this: unknown, sample: unknown, ev: unknown): void;
	};
	return {
		penDown(at) {
			const sample = { ...at, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 };
			// A plain tip: no eraser end (bit 32), no side button (bit 2).
			const ev = { buttons: 1, button: 0, clientX: at.x, clientY: at.y };
			proto.penDown.call(view, sample, ev);
		},
		mode: () => view.mode as string,
		grabbed,
		erased,
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
});
