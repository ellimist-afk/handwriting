/**
 * A MOUSE NEVER SNAPS A SHAPE ON ITS OWN.
 *
 * Alan, hardware, 2026-09-05, verbatim: "it's correcting into a straight
 * line", "one stub". Shape snap measures the dwell that requests it as time
 * since the last raw pointer MOVE and has no device term at all. A pen
 * leaving the glass keeps moving, so its dwell is a real hold. A mouse sits
 * exactly where it stopped while the button comes up, so EVERY deliberate
 * mouse stroke ends with a >= DWELL_MS hold nobody performed - the recognizer
 * runs, and the freehand is replaced by a figure fitted between the fit's
 * extremes, which is why it appeared to run back past where the stroke
 * started. Shape snap is on by default, so this reached every mouse user.
 *
 * The ruling (Alan, verbatim): "i dont like teaching hotkeys, this must be the
 * only one required", then "yeah that sounds great, chip on a certain dwell
 * sounds great as long as it doesnt get in the way during normal handwriting
 * OR drawing art". So the same two facts the pen's snap fires on - the hold,
 * and a fit the recognizer will stand behind - become an OFFER on a mouse:
 * the stroke is committed exactly as drawn and a small Snap button appears
 * beside where it ended. No modifier, no new setting, and nothing at all on a
 * stroke that ended on the move, which is every letter.
 *
 * THE HARNESS is `InlineEraseFresh.test.ts`'s, extended: a real
 * `InkOverlayPlugin` prototype over a hand-built field bag, driven through the
 * REAL `penUp` against the REAL store, with the ink ops it publishes recorded
 * rather than dispatched into a CodeMirror that does not exist here. The DOM
 * the chip needs is the fake element tree the inline suite already uses
 * (MobileTools.test.ts's `FakeEl`), cut down to the handful of calls
 * `SnapChip.ts` makes - which is the reason that module is duck-typed.
 *
 * WHAT WENT RED ON THE OLD CODE, checked by reverting the `mouseStroke`
 * branch in `penUp` and watching it fail before restoring it:
 *   - "commits a mouse stroke exactly as drawn": `expect(ops).toEqual(["add"])`
 *     read `["add", "replace"]`, and the committed point list was the
 *     recognizer's 41 synthesized points instead of the 16 that were drawn.
 *   - every chip test, because no chip existed at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InkOverlayPlugin, inlineInk, setShapeSnap } from "./InkOverlay";
import { InkOp, invertInkOp } from "./InkHistory";
import { SNAP_CHIP_CLASS, SNAP_CHIP_H, SNAP_CHIP_LABEL, SNAP_CHIP_OFFSET, SNAP_CHIP_MS, SNAP_CHIP_W, SnapChip, snapChipOrigin } from "./SnapChip";
import { DWELL_MS } from "../ink/ShapeSnap";
import { InkStroke } from "../ink/Stroke";
import { StrokeBuilder } from "../ink/StrokeBuilder";
import { StrokeIndex } from "../ink/StrokeIndex";
import { DEFAULT_PEN } from "../ink/PenStyle";
import type { PenSample } from "../input/PointerRouter";

const PATH = "note.md";

/**
 * The pane the chip is clamped inside. Big enough that none of the strokes
 * below is anywhere near an edge, so a clamp can never be what a placement
 * assertion is really reading.
 */
const PANE = { width: 800, height: 600 };

/**
 * A stroke the recognizer WILL fit: near-straight, 16 points, 120 world units
 * end to end. The 1px wobble is deliberate - a mathematically perfect line
 * would make "committed exactly as drawn" indistinguishable from "snapped to
 * a line" by shape, leaving only the point count to tell them apart.
 */
const LINE: Array<[number, number]> = Array.from({ length: 16 }, (_, i) => [i * 8, i % 2]);

/**
 * A stroke the recognizer will NOT fit: the same 120 units of travel as a
 * zigzag whose worst deviation (10) is far past LINE_TOLERANCE (5% of 120),
 * and whose end-to-end gap is a third of its path length, so it is judged as
 * an open figure and refused rather than treated as a closed one.
 */
const ZIGZAG: Array<[number, number]> = Array.from({ length: 16 }, (_, i) => [
	i * 8,
	i % 2 === 0 ? -10 : 10,
]);

// ---- the fake DOM the chip is planted in ------------------------------------

interface ElOpts {
	cls?: string;
	text?: string;
}

class FakeEl {
	readonly children: FakeEl[] = [];
	readonly classes = new Set<string>();
	readonly attrs = new Map<string, string>();
	readonly style: Record<string, string> = {};
	readonly listeners = new Map<string, Array<(ev: unknown) => void>>();
	text = "";
	parent: FakeEl | null = null;

	constructor(readonly tag: string, opts: ElOpts = {}) {
		for (const c of (opts.cls ?? "").split(" ").filter(Boolean)) this.classes.add(c);
		this.text = opts.text ?? "";
	}

	createDiv(opts: ElOpts = {}): FakeEl {
		const el = new FakeEl("div", opts);
		el.parent = this;
		this.children.push(el);
		return el;
	}
	setCssStyles(styles: Record<string, string>): void {
		Object.assign(this.style, styles);
	}
	// The overlay reads the band's and the scroller's boxes to find the
	// visible area; unscaled and the pane's size, so the clamp is the pane's.
	getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
		return { left: 0, top: 0, width: PANE.width, height: PANE.height };
	}
	setAttribute(k: string, v: string): void {
		this.attrs.set(k, v);
	}
	contains(node: unknown): boolean {
		if (node === this) return true;
		return this.children.some((kid) => kid.contains(node));
	}
	remove(): void {
		const at = this.parent?.children.indexOf(this) ?? -1;
		if (at >= 0) this.parent!.children.splice(at, 1);
		this.parent = null;
	}
	addEventListener(type: string, fn: (ev: unknown) => void): void {
		const list = this.listeners.get(type) ?? [];
		list.push(fn);
		this.listeners.set(type, list);
	}
	removeEventListener(type: string, fn: (ev: unknown) => void): void {
		const list = this.listeners.get(type) ?? [];
		const at = list.indexOf(fn);
		if (at >= 0) list.splice(at, 1);
	}
	/** How many listeners of `type` are still hooked up here. */
	count(type: string): number {
		return this.listeners.get(type)?.length ?? 0;
	}
	fire(type: string, ev: Record<string, unknown> = {}): void {
		const event = { type, target: this, stopPropagation: (): void => {}, ...ev };
		for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
	}
	/** The one descendant carrying `cls`, or null. */
	find(cls: string): FakeEl | null {
		for (const kid of this.children) {
			if (kid.classes.has(cls)) return kid;
			const deep = kid.find(cls);
			if (deep) return deep;
		}
		return null;
	}
}

function fakeCtx(): CanvasRenderingContext2D {
	return {
		fillStyle: "",
		strokeStyle: "",
		lineWidth: 0,
		lineCap: "",
		lineJoin: "",
		beginPath() {},
		moveTo() {},
		lineTo() {},
		closePath() {},
		arc() {},
		fill() {},
		stroke() {},
		save() {},
		restore() {},
	} as unknown as CanvasRenderingContext2D;
}

// ---- the surface ------------------------------------------------------------

interface Rig {
	/**
	 * One contact through the real `penUp`, at the raw-layer end position the
	 * chip is placed from.
	 */
	draw(opts: {
		points: Array<[number, number]>;
		mouse: boolean;
		dwell: boolean;
	}): void;
	/**
	 * A mouse stroke driven through the move path (`penRaw`), one sample per event, at the note scale `scale`, then
	 * let go at `liftAt` on the note window's clock. Samples are [x, y, ms] in sample space (note px). The hold is
	 * whatever the move path stamped, not set by hand as `draw` does.
	 */
	mouseRun(opts: { scale: number; fontZoom?: number; samples: Array<[number, number, number]>; liftAt: number }): void;
	/** The move path's stamp after a run: the last place, and time, the pointer moved. */
	stamp(): { t: number; x: number; y: number };
	/** The ops `penUp` (or a chip click) published, in order. */
	ops: InkOp[];
	/** The standing chip, or null. */
	chip(): FakeEl | null;
	/** The editor root: the chip's pointerdown guard lives here. */
	root: FakeEl;
	scroller: FakeEl;
	doc: FakeEl;
	/** Undo the last op, the way the editor's history would. */
	undoLast(): void;
	/** A file switch / unmount / abandoned gesture. */
	tearDown(): void;
}

function makeRig(): Rig {
	const view = Object.create(InkOverlayPlugin.prototype) as Record<string, unknown>;
	const ops: InkOp[] = [];
	const container = new FakeEl("div", { cls: "handwriting-ink-overlay" });
	const scroller = new FakeEl("div", { cls: "cm-scroller" });
	const doc = new FakeEl("#document");
	const root = new FakeEl("div", { cls: "cm-editor" });
	const wet = { clear: () => undefined, clearStroke: () => undefined, countPainted: () => 0 };

	view.mode = "ink";
	view.builder = null;
	view.snapChip = new SnapChip();
	view.container = container;
	view.cssWidth = PANE.width;
	view.cssHeight = PANE.height;
	view.strokePenGesture = false;
	view.strokeRawMax = 0;
	view.mouseStroke = false;
	view.rawLastMoveT = 0;
	view.rawLastMoveX = 0;
	view.rawLastMoveY = 0;
	view.frameTicking = false;
	view.scrollsDuringStroke = 0;
	view.scale = 1;
	view.erased = [];
	view.erasePieces = new Set<string>();
	view.eraseFrom = [];
	view.eraseWhole = false;
	view.strokeIndex = new StrokeIndex();
	view.indexDirty = true;
	view.repaintQueued = false;
	view.activeWet = wet;
	view.highlightWet = { ...wet };
	view.highlightWetCanvas = { setCssStyles: () => undefined };
	view.tail = {
		clear: () => undefined, clearAll: () => undefined,
		configureInlineBacking: () => undefined,
		placeInline: () => undefined,
		restoreFullSurface: () => undefined,
		prepareLive: () => undefined,
	};
	view.committedCtx = fakeCtx();
	view.highlightCtx = fakeCtx();
	view.damage = { addRect: () => undefined, addAll: () => undefined };
	view.eraserEl = null;
	view.frame = { locked: false, end: () => undefined, cancel: () => undefined };
	view.viewportPan = { x: 0, y: 0 };
	view.previewInkOffset = 0;
	view.boundReadout = { floorX: 0, floorY: 0, bx: 0, width: 0, rawX: 0, cx: 0, rawY: 0, cy: 0,
		dragFrame: false, neverZoomed: false, steady: false, next: 0, fromScale: 0, fromScaleValid: false,
		restCeilX: 0, startX: 0, startY: 0, lastX: 0, lastY: 0, bounded: false, settling: false };
	// `prune` is reached by `applyInkOp` (the undo leg), `clear` by
	// `resetGestureState` (the teardown test).
	view.selection = { clear: () => undefined, prune: () => undefined, isEmpty: true };
	view.selectionDeleteKeys = { reset: () => undefined };
	view.lassoPts = [];
	view.camera = {
		snapshot: { x: 0, y: 0, zoom: 1 },
		screenToWorld: (x: number, y: number) => ({ x, y }),
	};
	// `winRef` is a getter over the EDITOR's window, so the harness answers it
	// the way the class reaches it rather than assigning past the getter. Its
	// setTimeout is the global one, which `vi.useFakeTimers()` replaces - so
	// the expiry test drives the real 2000.
	view.view = {
		dom: Object.assign(root, {
			ownerDocument: Object.assign(doc, {
				defaultView: {
					setTimeout: (fn: () => void, ms: number) =>
						setTimeout(fn, ms) as unknown as number,
					clearTimeout: (id: number) => clearTimeout(id),
				},
			}),
		}),
		scrollDOM: scroller,
	};
	// Own properties, so the prototype's versions never run: they reach the
	// editor, the strip or the other panes, none of which is the subject here.
	view.filePath = () => PATH;
	view.updateHandwritingPageClass = () => undefined;
	view.repaintPath = () => undefined;
	view.updateExtent = () => undefined;
	view.recordCommitDiagnostics = () => undefined;
	view.scheduleRepaint = () => undefined;
	view.hidePenCursor = () => undefined;
	view.hideEraserCursor = () => undefined;
	view.dispatchInk = (op: InkOp) => void ops.push(op);

	const proto = InkOverlayPlugin.prototype as unknown as {
		penUp(this: unknown): void;
		applyInkOp(this: unknown, op: InkOp): void;
		resetGestureState(this: unknown): void;
	};

	return {
		ops,
		root,
		scroller,
		doc,
		draw({ points, mouse, dwell }) {
			const builder = new StrokeBuilder(
				"pen",
				DEFAULT_PEN.color,
				DEFAULT_PEN.baseWidth,
				undefined,
				mouse ? "mouse" : undefined
			);
			builder.start(0);
			points.forEach(([x, y], i) => builder.add(x, y, 0.5, i * 8));
			view.builder = builder;
			view.mode = "ink";
			view.mouseStroke = mouse;
			view.strokePenGesture = !mouse;
			const last = points[points.length - 1]!;
			view.rawLastMoveX = last[0];
			view.rawLastMoveY = last[1];
			// The raw layer's clock, not the stroke's: `penUp` asks
			// `performance.now() - rawLastMoveT`. A hold is "the last move was
			// longer ago than DWELL_MS"; an ordinary release is "just now".
			view.rawLastMoveT = dwell ? performance.now() - DWELL_MS * 2 : performance.now();
			proto.penUp.call(view);
		},
		mouseRun({ scale, fontZoom = 1, samples, liftAt }) {
			// Only what the move path reaches past the builder: the wet layer's head, the tail's draws, the
			// prediction and the present probe. None of them reads or writes the hold.
			view.activeWet = { ...wet, appendPoint: () => undefined, head: () => null,
				contactHalfWidth: () => 1, liveHalfWidth: () => 1 };
			view.tail = { ...(view.tail as object), drawHead: () => undefined, draw: () => undefined,
				cutDisc: () => undefined };
			view.strokeGain = 1;
			view.predReal = [];
			view.planPredictedTail = () => null;
			view.schedulePresentProbe = () => undefined;
			// As the zoom commit leaves it: cssScale the note's scale, `scale` that times the font zoom.
			view.cssScale = scale;
			view.scale = scale * fontZoom;
			view.fontZoom = fontZoom;
			// `penUp` reads the hold on the note window's clock; the lift is when it reads it.
			const win = (view.view as { dom: { ownerDocument: { defaultView: Record<string, unknown> } } })
				.dom.ownerDocument.defaultView;
			win.performance = { now: () => liftAt };
			const builder = new StrokeBuilder("pen", DEFAULT_PEN.color, DEFAULT_PEN.baseWidth, undefined, "mouse");
			const [x0, y0, t0] = samples[0]!;
			builder.start(t0);
			builder.add(x0, y0, 0.5, t0);
			view.builder = builder;
			view.mode = "ink";
			view.mouseStroke = true;
			view.strokePenGesture = false;
			// Pen-down stamps the first sample (InkOverlayPenPath.ts penDown), as here.
			view.rawLastMoveT = t0;
			view.rawLastMoveX = x0;
			view.rawLastMoveY = y0;
			const raw = (InkOverlayPlugin.prototype as unknown as {
				penRaw(this: unknown, s: PenSample[], ev: PointerEvent): void;
			}).penRaw;
			for (const [x, y, t] of samples.slice(1)) {
				raw.call(view, [{ x, y, pressure: 0.5, timestamp: t, tiltX: 0, tiltY: 0 }],
					{ timeStamp: t } as PointerEvent);
			}
			proto.penUp.call(view);
		},
		stamp: () => ({ t: view.rawLastMoveT as number, x: view.rawLastMoveX as number, y: view.rawLastMoveY as number }),
		chip: () => container.find(SNAP_CHIP_CLASS),
		undoLast() {
			proto.applyInkOp.call(view, invertInkOp(ops[ops.length - 1]!));
		},
		tearDown() {
			proto.resetGestureState.call(view);
		},
	};
}

function stored(): readonly InkStroke[] {
	return inlineInk.strokes(PATH);
}

function shapeOf(stroke: InkStroke): Array<[number, number]> {
	return stroke.points.map((p) => [p.x, p.y]);
}

beforeEach(() => {
	inlineInk.applyRemove(
		PATH,
		stored().map((s) => s.id)
	);
	setShapeSnap(true);
});

afterEach(() => {
	setShapeSnap(true);
	vi.useRealTimers();
});

describe("pen lift without a displayed preview", () => {
	it("keeps freehand even after a long hold", () => {
		const rig = makeRig();
		rig.draw({ points: LINE, mouse: false, dwell: true });
		expect(rig.ops.map(o => o.type)).toEqual(["add"]);
		expect(shapeOf(stored()[0]!)).toEqual(LINE);
		expect(rig.chip()).toBe(null);
	});
});

describe("a mouse is offered the snap instead of having it applied", () => {
	it("commits a mouse stroke exactly as drawn and stands a chip beside it", () => {
		const rig = makeRig();
		rig.draw({ points: LINE, mouse: true, dwell: true });

		// THE DEFECT, named directly. On the old code this read
		// ["add", "replace"] and the stored shape was the fitted line.
		expect(rig.ops.map((o) => o.type)).toEqual(["add"]);
		expect(stored()).toHaveLength(1);
		expect(shapeOf(stored()[0]!)).toEqual(LINE);

		const chip = rig.chip();
		expect(chip).not.toBe(null);
		expect(chip!.text).toBe(SNAP_CHIP_LABEL);
		// Out of the tab order, and pressable inside a pointer-events: none
		// overlay - both of which it has to say for itself.
		expect(chip!.attrs.get("tabindex")).toBe("-1");
		expect(chip!.style.pointerEvents).toBe("auto");
		// Beside the END of the stroke, never over it.
		const end = LINE[LINE.length - 1]!;
		expect(chip!.style.left).toBe(`${end[0] + SNAP_CHIP_OFFSET}px`);
		expect(chip!.style.top).toBe(`${end[1] + SNAP_CHIP_OFFSET}px`);
	});

	it("offers nothing when the mouse released on the move", () => {
		const rig = makeRig();
		rig.draw({ points: LINE, mouse: true, dwell: false });

		expect(rig.ops.map((o) => o.type)).toEqual(["add"]);
		expect(rig.chip()).toBe(null);
	});

	it("offers nothing when the recognizer will not fit the stroke", () => {
		const rig = makeRig();
		rig.draw({ points: ZIGZAG, mouse: true, dwell: true });

		expect(rig.ops.map((o) => o.type)).toEqual(["add"]);
		expect(shapeOf(stored()[0]!)).toEqual(ZIGZAG);
		expect(rig.chip()).toBe(null);
	});

	it("offers nothing while Shape snap is off", () => {
		setShapeSnap(false);
		const rig = makeRig();
		rig.draw({ points: LINE, mouse: true, dwell: true });

		expect(rig.ops.map((o) => o.type)).toEqual(["add"]);
		expect(rig.chip()).toBe(null);
	});
});

describe("taking the offer", () => {
	it("replaces the stroke through the same replace the pen's snap publishes", () => {
		const rig = makeRig();
		rig.draw({ points: LINE, mouse: true, dwell: true });
		const freehand = stored()[0]!;

		rig.chip()!.fire("click");

		// One `replace`, on top of the `add` the commit already published -
		// so the reader gets the same two undo presses the pen's snap gives.
		expect(rig.ops.map((o) => o.type)).toEqual(["add", "replace"]);
		const op = rig.ops[1]!;
		expect(op.type === "replace" && op.removed.map((s) => s.id)).toEqual([freehand.id]);
		expect(op.type === "replace" && op.removedAt).toEqual([0]);
		expect(op.type === "replace" && op.insertedAt).toEqual([0]);

		// The note holds the fitted figure now, at the same depth.
		expect(stored()).toHaveLength(1);
		expect(stored()[0]!.id).not.toBe(freehand.id);
		expect(stored()[0]!.points.length).toBeGreaterThan(LINE.length);

		// The chip is spent.
		expect(rig.chip()).toBe(null);

		// First undo UN-SNAPS: the freehand comes back, exactly as drawn.
		rig.undoLast();
		expect(stored()).toHaveLength(1);
		expect(stored()[0]!.id).toBe(freehand.id);
		expect(shapeOf(stored()[0]!)).toEqual(LINE);
	});
});

describe("an offer nobody takes", () => {
	it("goes away on the next pointerdown, with the stroke untouched", () => {
		const rig = makeRig();
		rig.draw({ points: LINE, mouse: true, dwell: true });

		rig.root.fire("pointerdown", { target: rig.scroller });

		expect(rig.chip()).toBe(null);
		expect(rig.ops.map((o) => o.type)).toEqual(["add"]);
		expect(shapeOf(stored()[0]!)).toEqual(LINE);
	});

	it("survives a pointerdown ON the chip, and keeps the pen router off it", () => {
		const rig = makeRig();
		rig.draw({ points: LINE, mouse: true, dwell: true });
		const chip = rig.chip()!;
		let stopped = 0;

		rig.root.fire("pointerdown", { target: chip, stopPropagation: () => void stopped++ });

		// Still standing - a contact aimed at the button is not a dismissal -
		// and the event goes no further, so the router one node down never
		// claims it and starts a stroke on the button.
		expect(rig.chip()).toBe(chip);
		expect(stopped).toBe(1);
	});

	it("goes away on any keydown", () => {
		const rig = makeRig();
		rig.draw({ points: LINE, mouse: true, dwell: true });

		rig.doc.fire("keydown", { key: "a" });

		expect(rig.chip()).toBe(null);
		expect(rig.ops.map((o) => o.type)).toEqual(["add"]);
	});

	it("goes away on a scroll", () => {
		const rig = makeRig();
		rig.draw({ points: LINE, mouse: true, dwell: true });

		rig.scroller.fire("scroll");

		expect(rig.chip()).toBe(null);
		expect(rig.ops.map((o) => o.type)).toEqual(["add"]);
	});

	it("expires on its own", () => {
		vi.useFakeTimers();
		const rig = makeRig();
		rig.draw({ points: LINE, mouse: true, dwell: true });

		vi.advanceTimersByTime(SNAP_CHIP_MS - 1);
		expect(rig.chip()).not.toBe(null);
		vi.advanceTimersByTime(1);

		expect(rig.chip()).toBe(null);
		expect(rig.ops.map((o) => o.type)).toEqual(["add"]);
	});
});

describe("one chip at a time", () => {
	it("replaces the standing offer with the new stroke's", () => {
		const rig = makeRig();
		rig.draw({ points: LINE, mouse: true, dwell: true });
		const first = rig.chip()!;

		// A second stroke 200 units down, without the pointerdown that would
		// have taken the first chip down on real hardware - so what is being
		// tested is the offer's own one-at-a-time rule and nothing else.
		rig.draw({
			points: LINE.map(([x, y]) => [x, y + 200] as [number, number]),
			mouse: true,
			dwell: true,
		});

		const chips: FakeEl[] = [];
		const walk = (el: FakeEl): void => {
			if (el.classes.has(SNAP_CHIP_CLASS)) chips.push(el);
			el.children.forEach(walk);
		};
		walk((rig.chip()!.parent ?? rig.chip()) as FakeEl);
		expect(chips).toHaveLength(1);
		expect(chips[0]).not.toBe(first);
		expect(chips[0]!.style.top).toBe(`${200 + 1 + SNAP_CHIP_OFFSET}px`);
	});
});

describe("teardown", () => {
	it("takes the chip and every listener down with the surface", () => {
		const rig = makeRig();
		rig.draw({ points: LINE, mouse: true, dwell: true });
		expect(rig.chip()).not.toBe(null);
		expect(rig.root.count("pointerdown")).toBe(1);
		expect(rig.doc.count("keydown")).toBe(1);
		expect(rig.scroller.count("scroll")).toBe(1);

		rig.tearDown();

		expect(rig.chip()).toBe(null);
		// The three listeners sit on the editor root, the document and the
		// scroller - all of which outlive this overlay, so removing the
		// container would not have reached any of them.
		expect(rig.root.count("pointerdown")).toBe(0);
		expect(rig.doc.count("keydown")).toBe(0);
		expect(rig.scroller.count("scroll")).toBe(0);
	});
});

describe("where the chip sits", () => {
	it("clears the stroke's end point in both axes", () => {
		expect(snapChipOrigin(100, 100, PANE)).toEqual({
			left: 100 + SNAP_CHIP_OFFSET,
			top: 100 + SNAP_CHIP_OFFSET,
		});
	});

	it("stays inside the pane at either edge", () => {
		expect(snapChipOrigin(PANE.width, PANE.height, PANE)).toEqual({
			left: PANE.width - SNAP_CHIP_W,
			// Squeezed into the corner the chip goes above the stroke's end, not onto it.
			top: PANE.height - SNAP_CHIP_OFFSET - SNAP_CHIP_H,
		});
		// A pane too small to hold the chip clamps to its corner rather than
		// going negative and hanging off the other side.
		expect(snapChipOrigin(0, 0, { width: 10, height: 10 })).toEqual({ left: 0, top: 0 });
	});
});

/**
 * A slow mouse stroke along a line: `count` samples, each 10 screen px on from the last, 250 ms apart, in sample space
 * at note scale `scale` (a screen px is 1 / scale note px). A 1 screen px wobble keeps it from being a perfect line.
 */
function slowLine(scale: number, count: number): Array<[number, number, number]> {
	return Array.from({ length: count }, (_, i) => [i * 10 / scale, (i % 2) / scale, i * 250]);
}

describe("the mouse's hold reads the same on screen at every zoom", () => {
	// Zoomed in to 4, each 10 screen px step is 2.5 note px. Read as 4 note px, the hold only moves every second step,
	// so a release one step after an odd sample reads 500 ms held. Read as 4 screen px (1 note px), every step moves
	// it and the same release reads 250 ms: no offer.
	it("offers nothing at scale 4 for a slow stroke that never paused", () => {
		const rig = makeRig();
		const samples = slowLine(4, 48);
		rig.mouseRun({ scale: 4, samples, liftAt: samples[47]![2] + 250 });
		expect(rig.stamp().t, "premise: the move path stamped the samples").toBeGreaterThan(samples[0]![2]);
		expect(rig.ops.map((o) => o.type)).toEqual(["add"]);
		expect(rig.chip()).toBe(null);
	});

	it("still offers at scale 4 when that stroke ends in a real pause", () => {
		const rig = makeRig();
		const samples = slowLine(4, 48);
		rig.mouseRun({ scale: 4, samples, liftAt: samples[47]![2] + 600 });
		expect(rig.chip()).not.toBe(null);
	});

	it("offers nothing at scale 1 for the same slow stroke", () => {
		const rig = makeRig();
		const samples = slowLine(1, 12);
		rig.mouseRun({ scale: 1, samples, liftAt: samples[11]![2] + 250 });
		// Every 10 px step is past the slack, so the stamp is the last moving sample, on the clock `penUp` reads.
		expect(rig.stamp(), "premise: the stamp is the last moving sample")
			.toEqual({ t: samples[11]![2], x: samples[11]![0], y: samples[11]![1] });
		expect(rig.ops.map((o) => o.type)).toEqual(["add"]);
		expect(rig.chip()).toBe(null);
	});

	it("offers at scale 1 when that stroke ends in a real pause", () => {
		const rig = makeRig();
		const samples = slowLine(1, 12);
		rig.mouseRun({ scale: 1, samples, liftAt: samples[11]![2] + 600 });
		expect(rig.chip()).not.toBe(null);
	});

	// Zoomed out to 0.25, a hand on a held button still wanders: here 1.2 screen px, which is 4.8 note px, past a bare
	// 4 note px. Read as 4 screen px (16 note px), the wander is still and the 600 ms hold earns the offer.
	it("offers at scale 0.25 after a 600 ms hold whose samples range 1.2 screen px", () => {
		const rig = makeRig();
		const line = slowLine(0.25, 12).map(([x, y, i]): [number, number, number] => [x, y, i / 5]);
		const [ex, ey, et] = line[11]!;
		const held = Array.from({ length: 12 }, (_, k): [number, number, number] =>
			[ex + (k % 2 === 0 ? 1.2 / 0.25 : 0), ey, et + (k + 1) * 50]);
		rig.mouseRun({ scale: 0.25, samples: [...line, ...held], liftAt: et + 600 });
		expect(rig.stamp().t, "premise: the move path stamped the samples").toBeGreaterThan(line[0]![2]);
		expect(rig.ops.map((o) => o.type)).toEqual(["add"]);
		const chip = rig.chip();
		expect(chip).not.toBe(null);
		// The chip stands off the stamp, so it lags the last sample by at most the slack: 4 screen px at every zoom.
		const last = held[held.length - 1]!;
		expect(Math.abs(parseFloat(String(chip!.style.left)) - SNAP_CHIP_OFFSET - last[0]) * 0.25).toBeLessThanOrEqual(4);
		expect(Math.abs(parseFloat(String(chip!.style.top)) - SNAP_CHIP_OFFSET - last[1]) * 0.25).toBeLessThanOrEqual(4);
	});

	// Zoomed in to 4 with a font zoom of 2, `scale` is 8 and the router still maps by 4. A rest whose samples range
	// 3 screen px (0.75 note px) is still on screen; read through `scale`, the slack is 2 screen px and the rest moves.
	it("offers at scale 4 with font zoom 2 after a 400 ms rest ranging 3 screen px", () => {
		const rig = makeRig();
		const line = Array.from({ length: 12 }, (_, i): [number, number, number] => [i * 10, (i % 2) / 4, i * 50]);
		const [ex, ey, et] = line[11]!;
		const rest = Array.from({ length: 8 }, (_, k): [number, number, number] =>
			[ex + (k % 2 === 0 ? 3 / 4 : 0), ey, et + (k + 1) * 50]);
		rig.mouseRun({ scale: 4, fontZoom: 2, samples: [...line, ...rest], liftAt: et + 400 });
		expect(rig.stamp().t, "premise: the move path stamped the samples").toBeGreaterThan(line[0]![2]);
		expect(rig.chip()).not.toBe(null);
	});

	// A scale that is not finite or not above 0 reads as 1, as the router maps it: 10 px steps are no pause.
	it.each([["0", 0], ["NaN", Number.NaN]])("offers nothing at a note scale of %s for steps that never paused",
		(_name, k) => {
			const rig = makeRig();
			const samples = slowLine(1, 12);
			rig.mouseRun({ scale: k, samples, liftAt: samples[11]![2] + 250 });
			expect(rig.ops.map((o) => o.type)).toEqual(["add"]);
			expect(rig.chip()).toBe(null);
		});
});
