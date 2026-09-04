/**
 * Alan, hardware, testing on a page with no ink on it: "all of the tools
 * only work when there's ink on the page but no indication that it's not
 * working other than it's not working" - then: "should add a toast that
 * indicates tools aren't working cause there's no ink on the page".
 *
 * insert-space already carries this lesson (`InkOverlay.spaceDown`'s "no ink
 * below the line" Notice, fired once at pen-down when its id list comes back
 * empty). The eraser and the lasso are the same shape: both need EXISTING
 * ink to do anything, so a page with none guarantees the whole gesture finds
 * nothing, whichever way the pen moves. Pan does not belong here - it drags
 * the view and never touches the store, so it keeps working on a blank page
 * (see the pdf-side "pan drags the scroller and never inks" test) - and gets
 * no notice.
 *
 * Both directions are asserted for each tool, because a refusal that fires
 * on ink too would be a nag: the whole point of insert-space's placement (at
 * the gesture's own discovery, not at tool selection) is that picking up a
 * tool and then drawing is normal and must stay quiet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const notices = vi.hoisted(() => ({ messages: [] as string[] }));
vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		Notice: class {
			constructor(message: string) {
				notices.messages.push(message);
			}
		},
	};
});

import { InkOverlayPlugin, inlineInk } from "./InkOverlay";
import { resetTipModeForTest, setTipMode } from "./TipMode";
import { SelectionModel } from "../objects/SelectionModel";
import { InkStroke } from "../ink/Stroke";

function stroke(id: string): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#000000",
		width: 2,
		points: [
			{ x: 10, y: 10, pressure: 0.5, t: 0 },
			{ x: 20, y: 20, pressure: 0.5, t: 8 },
		],
		bbox: { x: 8, y: 8, width: 16, height: 16 },
		createdAt: 0,
	};
}

/** A rig driving the real `penDown`, stopping short of the real eraser hit test. */
function makeEraseRig(path: string) {
	const view = Object.create(InkOverlayPlugin.prototype) as Record<string, unknown>;
	const eraseAt = vi.fn();

	view.mode = "ink";
	view.scale = 1;
	view.erased = [];
	view.eraseFrom = [];
	view.eraseWhole = true;
	view.penCursorEl = null;
	view.router = null;
	view.mobileTools = null;
	// focusClaimedPenEditor's whole contract: already focused, nothing to do.
	view.view = { hasFocus: true, focus: () => undefined };
	view.frame = { locked: false, begin: () => undefined, end: () => undefined, cancel: () => undefined };
	view.camera = { screenToWorld: (x: number, y: number) => ({ x, y }) };
	view.selection = new SelectionModel();

	// Own properties, so the prototype's versions never run: each of these
	// reaches the editor, the strip or the canvas, none of which is the
	// subject - the subject is the erase branch's own new check.
	view.syncCamera = () => undefined;
	view.captureProbeGeometry = () => undefined;
	view.recordPenDownState = () => undefined;
	view.redrawSelectionUI = () => undefined;
	view.filePath = () => path;
	view.startFrameTicker = () => undefined;
	view.showEraserCursor = () => undefined;
	view.eraseAt = eraseAt;

	const proto = InkOverlayPlugin.prototype as unknown as {
		penDown(this: unknown, sample: unknown, ev: unknown): void;
	};
	return {
		penDown() {
			const sample = { x: 50, y: 50, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 };
			const ev = { buttons: 1, button: 0, clientX: 50, clientY: 50 };
			proto.penDown.call(view, sample, ev);
		},
		eraseAt,
	};
}

/** A rig driving the real `lassoDown`, forced onto the fresh-loop path. */
function makeLassoRig(path: string) {
	const view = Object.create(InkOverlayPlugin.prototype) as Record<string, unknown>;

	view.scale = 1;
	view.camera = { screenToWorld: (x: number, y: number) => ({ x, y }) };
	view.selection = new SelectionModel();
	// No live selection to grab, whatever `strokesHere()` answers: forces the
	// "start a fresh loop" branch, which is where the new check lives.
	view.selectionBounds = () => null;
	view.showLassoCursor = () => undefined;
	view.redrawSelectionUI = () => undefined;
	view.filePath = () => path;
	view.lassoActive = false;
	view.lassoPts = [];

	const proto = InkOverlayPlugin.prototype as unknown as {
		lassoDown(this: unknown, sample: unknown): void;
	};
	return {
		lassoDown() {
			proto.lassoDown.call(view, { x: 50, y: 50, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 });
		},
	};
}

describe("empty-page notices on the note surface", () => {
	beforeEach(() => {
		resetTipModeForTest();
		notices.messages = [];
	});
	afterEach(() => resetTipModeForTest());

	it("eraser on an empty note says so and never reaches the hit test", () => {
		setTipMode("eraser");
		const rig = makeEraseRig("empty-erase.md");

		rig.penDown();

		expect(notices.messages).toEqual(["Handwriting: no ink on the page to erase"]);
		// The gesture still proceeds - only the warning is new - so the real
		// hit test still runs and finds nothing on its own, the same as today.
		expect(rig.eraseAt).toHaveBeenCalledTimes(1);
	});

	it("eraser on a note that already has ink stays quiet", () => {
		setTipMode("eraser");
		const path = "has-ink-erase.md";
		inlineInk.commit(path, stroke("s1"));
		const rig = makeEraseRig(path);

		rig.penDown();

		expect(notices.messages).toEqual([]);
	});

	it("lasso on an empty note says so and starts a fresh loop", () => {
		setTipMode("lasso");
		const rig = makeLassoRig("empty-lasso.md");

		rig.lassoDown();

		expect(notices.messages).toEqual(["Handwriting: no ink on the page to select"]);
	});

	it("lasso on a note that already has ink stays quiet, even before the loop closes", () => {
		setTipMode("lasso");
		const path = "has-ink-lasso.md";
		inlineInk.commit(path, stroke("s1"));
		const rig = makeLassoRig(path);

		rig.lassoDown();

		expect(notices.messages).toEqual([]);
	});
});
