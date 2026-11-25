/**
 * The pen toolbar after its note is dragged out to another window, and back.
 *
 * The strip listens on its document for seven things: the outside tap (pointerdown), Escape (keydown), the size
 * slider's release (pointerup, pointercancel), the end of a toolbar drag (pointerup, pointercancel) and the trace's
 * click. A note moved to its own window keeps its editor and so its strip, but the strip's elements then belong to the
 * new window's document. Until this fix the seven stayed on the first one: a toolbar dragged by its grip never landed
 * and its place was not saved, a size pop or the folded row stayed open on a tap or Escape, a slider touched once
 * stopped following, and a note closed after the move left all seven on the first window for the session.
 *
 * THE MOVE, AS THE HOST MAKES IT. Every element of the strip reports the new document, then the host's call for a
 * node that changed window runs. Obsidian 1.15.0 builds that call (`onWindowMigrated`) on its node-inserted animation
 * and calls back with the new window only when the window differs; `hostWatch` below does that and nothing more.
 * Whether Obsidian keeps the editor through the move is not known here. If it builds a new one instead, the old strip
 * is destroyed where it was and a new one is built in the new window, which the build pin covers.
 *
 * Each precondition is asserted on its own before the claim, so a throw or a missing element cannot pass a cell.
 *
 * Plant (not committed): the strip does not follow the host's call (its callback does nothing). The cells that drive
 * the strip in the new window go red; the teardown cells stay green, because teardown takes the seven off the
 * document they are on whatever the host did.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileTools, type MobileToolsHost } from "./MobileTools";
import { getInlineTool } from "./InkOverlay";
import { clearToolPicked } from "./MouseInk";
import { markPenHardwareSeen, resetPenToolsForTest } from "./PenToolsMode";
import { penInkEnabled, resetPenInkForTest } from "./PenInk";
import { FakeDoc, FakeEl } from "../testUtils/fakeDom";

const host = (placed: string[]): MobileToolsHost => ({
	exec: () => {},
	activeTool: () => getInlineTool(),
	setPlacement: (corner) => void placed.push(corner),
	eraserOn: () => false,
	eraserWholeStroke: () => false,
	setEraserWholeStroke: () => {},
	lassoOn: () => false,
	spaceOn: () => false,
	panOn: () => false,
	toolColor: () => "#000000",
	eraserRadiusPx: () => 10,
	setEraserRadiusPx: () => {},
	inkSizeMult: () => 1,
	setInkSizeMult: () => {},
	canUndo: () => false,
	canRedo: () => false,
	canPasteInk: () => false,
	mouseInkOn: () => false,
	armMouseInkQuietly: () => {},
	disarmMouseInkQuietly: () => {},
	toast: () => {},
	recordingOn: () => false,
	hasInkSelection: () => false,
	paletteFor: () => [],
	pickColor: () => {},
	presetsFor: () => [],
	applyPreset: () => {},
	starPreset: () => {},
	forgetPreset: () => {},
	setEditorFocus: () => {},
	penInksHere: () => penInkEnabled(),
	hasTouch: () => true,
});

const DOCUMENT_TYPES = ["click", "keydown", "pointercancel", "pointerdown", "pointerup"];

/** One registration of the host's window-move call: the node, the window it was last seen in, the callback. */
interface Watch {
	node: FakeEl;
	win: unknown;
	listener: (win: Window) => unknown;
	live: boolean;
}
let watches: Watch[] = [];

/** The host's `onWindowMigrated`, on the fake element: remembers the window, hands back the call that ends the watch. */
function hostWatch(this: FakeEl, listener: (win: Window) => unknown): () => void {
	const watch: Watch = { node: this, win: this.ownerDocument.defaultView, listener, live: true };
	watches.push(watch);
	return () => {
		watch.live = false;
	};
}

/** The host's side of a move: each live watch whose node now reports another window is called back with it. */
function hostCallsMoved(): void {
	for (const watch of watches) {
		if (!watch.live) continue;
		const win = watch.node.ownerDocument.defaultView;
		if (win === watch.win) continue;
		watch.win = win;
		watch.listener(win as unknown as Window);
	}
}

/** What a move to another window does to the strip's elements: every one of them now reports that document. */
function reportDocument(root: FakeEl, doc: FakeDoc): void {
	(root as unknown as { ownerDocument: FakeDoc }).ownerDocument = doc;
	for (const kid of root.children) reportDocument(kid, doc);
}

interface Rig {
	docA: FakeDoc;
	pane: FakeEl;
	strip: MobileTools;
	grip: FakeEl;
	placed: string[];
}

function build(): Rig {
	const docA = new FakeDoc();
	const pane = new FakeEl("div", docA);
	const placed: string[] = [];
	const strip = new MobileTools(pane as unknown as HTMLElement, host(placed));
	// Expanded, said rather than assumed: the folded state is a session preference shared by every strip in the run.
	strip.setCollapsed(false);
	const grip = pane.querySelector(".handwriting-tools-grip");
	if (!grip) throw new Error("the strip's grip was not built");
	return { docA, pane, strip, grip, placed };
}

/** The note's tab dragged to the window whose document is `doc`. */
function moveTo(rig: Rig, doc: FakeDoc): void {
	reportDocument(rig.pane, doc);
	hostCallsMoved();
}

/** One drag of the grip, 20 px, let go on `doc`; returns whether the drag was live past its threshold before the lift. */
function dragGripAndLift(rig: Rig, doc: FakeDoc, pointerId: number): boolean {
	rig.grip.fire("pointerdown", { pointerId, clientX: 100, clientY: 100 });
	rig.grip.fire("pointermove", { pointerId, clientX: 120, clientY: 100 });
	const live = rig.strip.drag?.moved === true;
	doc.fire("pointerup", { pointerId });
	return live;
}

/** Escape pressed on `doc` with focus at `target`; reports whether anything took the key from the cursor. */
function escape(doc: FakeDoc, target: FakeEl): { prevented: boolean; stopped: boolean } {
	const seen = { prevented: false, stopped: false };
	doc.fire("keydown", {
		key: "Escape",
		defaultPrevented: false,
		target,
		preventDefault: () => {
			seen.prevented = true;
		},
		stopPropagation: () => {
			seen.stopped = true;
		},
	});
	return seen;
}

const proto = FakeEl.prototype as unknown as { onWindowMigrated?: typeof hostWatch };

beforeEach(() => {
	resetPenToolsForTest();
	resetPenInkForTest();
	clearToolPicked();
	markPenHardwareSeen();
	// A drop that lands flies its last few px on `window.setTimeout`, and this suite runs on node.
	vi.useFakeTimers();
	vi.stubGlobal("window", globalThis);
	watches = [];
});

afterEach(() => {
	delete proto.onWindowMigrated;
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("the pen toolbar follows its note to another window", () => {
	beforeEach(() => {
		proto.onWindowMigrated = hostWatch;
	});

	it("a toolbar dragged by its grip in the new window lands on the lift there, and its place is sent once", () => {
		const rig = build();
		const docB = new FakeDoc();
		moveTo(rig, docB);
		expect(rig.pane.ownerDocument, "the note's pane reports the new window's document").toBe(docB);
		expect(rig.grip.ownerDocument, "the grip reports the new window's document").toBe(docB);
		const live = dragGripAndLift(rig, docB, 7);
		expect(live, "the grip's press and 20 px move made a live drag").toBe(true);
		expect(rig.strip.drag, "the drag ended on the lift in the new window").toBeNull();
		expect(rig.placed.length, "one placement sent for the drop").toBe(1);
	});

	it("closing the note after the move leaves none of the seven on the first window", () => {
		const rig = build();
		expect(rig.docA.documentListenerCount(), "the built strip listens on its first window").toBe(7);
		const docB = new FakeDoc();
		moveTo(rig, docB);
		rig.strip.destroy();
		expect(rig.docA.documentListenerCount(), "listeners left on the first window after the note closed").toBe(0);
		expect(rig.docA.documentListenerCount("keydown"), "the closed strip's Escape listener on the first window").toBe(0);
		expect(docB.documentListenerCount(), "listeners left on the new window after the note closed").toBe(0);
	});

	it("after the move the seven sit on the new window's document and on no other", () => {
		const rig = build();
		const docB = new FakeDoc();
		moveTo(rig, docB);
		const missing = DOCUMENT_TYPES.filter((type) => docB.documentListenerCount(type) === 0);
		expect(missing, "types the strip does not listen for on the new window").toEqual([]);
		expect(docB.documentListenerCount(), "the seven on the new window").toBe(7);
		expect(rig.docA.documentListenerCount(), "listeners left on the first window").toBe(0);
		rig.strip.destroy();
	});

	it("a size slider pressed in the new window lets go on the lift there", () => {
		const rig = build();
		const input = rig.pane.querySelector("input");
		expect(input, "the strip has a size slider").not.toBeNull();
		const docB = new FakeDoc();
		moveTo(rig, docB);
		input!.fire("pointerdown", { pointerId: 3 });
		expect(rig.strip.heldSlider, "the slider is held while pressed").toBe(input as unknown as HTMLInputElement);
		docB.fire("pointerup", { pointerId: 3 });
		expect(rig.strip.heldSlider, "the slider is let go on the lift in the new window").toBeNull();
		rig.strip.destroy();
	});

	it("a tap elsewhere in the new window closes an open size pop and the folded row", () => {
		const rig = build();
		const docB = new FakeDoc();
		moveTo(rig, docB);
		rig.strip.openInkSlider = "pen";
		rig.strip.setMoreOpen(true);
		expect(rig.strip.hasOpenPop(), "a size pop is open").toBe(true);
		expect(rig.strip.moreOpen, "the folded row is open").toBe(true);
		docB.fire("pointerdown", { target: new FakeEl("div", docB) });
		expect(rig.strip.openInkSlider, "the size pop closed on a tap in the new window").toBeNull();
		expect(rig.strip.moreOpen, "the folded row closed on a tap in the new window").toBe(false);
		rig.strip.destroy();
	});

	it("Escape in the new window closes an open pop; with nothing open it is left for the cursor", () => {
		const rig = build();
		const docB = new FakeDoc();
		moveTo(rig, docB);
		rig.strip.openInkSlider = "pen";
		expect(rig.strip.hasOpenPop(), "a size pop is open").toBe(true);
		const first = escape(docB, rig.pane);
		expect(rig.strip.openInkSlider, "Escape in the new window closed the pop").toBeNull();
		expect(first.stopped, "the Escape that closed this pane's pop was taken").toBe(true);
		const second = escape(docB, rig.pane);
		expect(second, "Escape with nothing open reaches the cursor").toEqual({ prevented: false, stopped: false });
		rig.strip.destroy();
	});

	it("Escape in the first window after the move reaches the cursor there", () => {
		const rig = build();
		const docB = new FakeDoc();
		moveTo(rig, docB);
		rig.strip.openInkSlider = "pen";
		expect(rig.strip.hasOpenPop(), "a size pop is open in the new window").toBe(true);
		const seen = escape(rig.docA, new FakeEl("div", rig.docA));
		expect(seen, "Escape in the first window was taken from its cursor").toEqual({ prevented: false, stopped: false });
		rig.strip.destroy();
	});

	it("moved out and back, the toolbar's drag lands in each window in turn", () => {
		const rig = build();
		const docB = new FakeDoc();
		moveTo(rig, docB);
		expect(dragGripAndLift(rig, docB, 5), "a live drag in the new window").toBe(true);
		expect(rig.strip.drag, "the drag ended on the lift in the new window").toBeNull();
		moveTo(rig, rig.docA);
		expect(rig.grip.ownerDocument, "the grip reports the first window's document again").toBe(rig.docA);
		expect(dragGripAndLift(rig, rig.docA, 6), "a live drag back in the first window").toBe(true);
		expect(rig.strip.drag, "the drag ended on the lift back in the first window").toBeNull();
		expect(rig.placed.length, "one placement sent per drop").toBe(2);
		expect(rig.docA.documentListenerCount(), "the seven on the first window again").toBe(7);
		expect(docB.documentListenerCount(), "listeners left on the window the note came back from").toBe(0);
		rig.strip.destroy();
	});

	it("closing the note ends the host's watch, and a late call from the host puts nothing back", () => {
		const rig = build();
		const live = (): number => watches.filter((watch) => watch.live).length;
		expect(live(), "the host watches the strip and the pill for a move").toBe(2);
		const late = watches[0]!;
		rig.strip.destroy();
		expect(live(), "watches left after the note closed").toBe(0);
		const docB = new FakeDoc();
		reportDocument(rig.pane, docB);
		late.listener(docB.defaultView as unknown as Window);
		expect(rig.docA.documentListenerCount(), "listeners on the first window after a late call").toBe(0);
		expect(docB.documentListenerCount(), "listeners on the new window after a late call").toBe(0);
	});
});

describe("the pen toolbar with no move, or with no host call for one", () => {
	it("built and never moved, it listens for today's seven on its document, in today's order, all in capture", () => {
		const docA = new FakeDoc();
		const adds: Array<[string, unknown, unknown]> = [];
		const removes: string[] = [];
		const add = docA.addEventListener.bind(docA);
		docA.addEventListener = (type: string, fn: (ev: unknown) => void, opts?: boolean | { capture?: boolean }): void => {
			adds.push([type, fn, opts]);
			add(type, fn, opts);
		};
		docA.removeEventListener = (type: string): void => void removes.push(type);
		const strip = new MobileTools(new FakeEl("div", docA) as unknown as HTMLElement, host([]));
		const capture = { capture: true };
		expect(adds).toEqual([
			["pointerdown", strip.outsideTap, capture],
			["keydown", strip.escapeKey, capture],
			["pointerup", strip.releaseSlider, capture],
			["pointercancel", strip.releaseSlider, capture],
			["pointerup", strip.endDrag, capture],
			["pointercancel", strip.endDrag, capture],
			["click", strip.traceClick, capture],
		]);
		expect(removes, "nothing taken off the document while building").toEqual([]);
	});

	it("on a host with no window-move call, the strip builds as before and closing the note clears the window it listened on", () => {
		const rig = build();
		expect(rig.docA.documentListenerCount(), "the built strip listens on its first window").toBe(7);
		const docB = new FakeDoc();
		reportDocument(rig.pane, docB);
		expect(rig.grip.ownerDocument, "the grip reports the new window's document").toBe(docB);
		rig.strip.destroy();
		expect(rig.docA.documentListenerCount(), "listeners left on the first window after the note closed").toBe(0);
		expect(docB.documentListenerCount(), "listeners left on the new window after the note closed").toBe(0);
	});
});
