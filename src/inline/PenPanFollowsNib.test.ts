/**
 * The pan tool under a pen keeps the page under the nib at any zoom.
 *
 * `panMove` takes each step of the drag in screen px (client coordinates) and writes it into the scroller. The
 * scroller sits inside the zoomed editor, so one scroll px paints as `cssScale` screen px: a step written as it
 * is moves the page by the pen's travel times the zoom, three times too far at 300 percent and a tenth as far at
 * 10 percent. The finger pan in the same file already divides by the scale when it pays pan into the scroll.
 *
 * These cells drive a real pan through `penDown` and `penRaw` on an `InkOverlayPlugin` built with
 * `Object.create` (the rig `GestureReticlePersists.test.ts` uses for its pan drag), over a scroller that rounds
 * what it is given and holds it inside its range, as a browser's does. The page's travel on screen is the
 * scroll it lost times `cssScale`.
 *
 * - A2a: at 200 percent one move of 100 screen px moves the scroll by 50.
 * - A2b: at 300 percent, 100 moves of one screen px: at every sample the page has travelled as far as the pen,
 *   within one scroll px times the zoom. A step divided and written as it is rounds away every time; this is
 *   the cell that says no part of the travel is lost.
 * - A2c: at a range end, a drag 60 px past it and back 10 px moves the page at the first reversed sample.
 * - A2d: at 100 percent the scroll writes are exactly the ones a step written as it is makes, fractional client
 *   coordinates included.
 *
 * Failure messages carry "premise" when the rig did not reach the step and "claim" for the cell's own assert.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";

import { InkOverlayPlugin, releaseTipModes, setPenReticle } from "./InkOverlay";
import { SelectionModel } from "../objects/SelectionModel";
import { Camera } from "../camera/Camera";
import { StrokeFrame } from "./StrokeFrame";
import { setTipMode } from "./TipMode";
import type { PenSample } from "../input/PointerRouter";

function sample(x: number, y: number): PenSample {
	return { x, y, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 };
}

/** A contact or move event: buttons and button 0, so the contact's intent is the tip mode alone. */
function evAt(x: number, y: number): PointerEvent {
	return { clientX: x, clientY: y, buttons: 0, button: 0 } as unknown as PointerEvent;
}

interface Proto {
	penDown(this: unknown, s: PenSample, ev: PointerEvent): void;
	penRaw(this: unknown, s: PenSample[], ev: PointerEvent): void;
}

interface Write {
	axis: "left" | "top";
	value: number;
}

interface Scroller {
	scrollLeft: number;
	scrollTop: number;
	/** Every value written to either axis, as given, before the scroller rounds and clamps it. */
	writes: Write[];
}

/**
 * A scroller that rounds each write to a whole px and holds it in [0, max], the way a browser's scroll range
 * does at a scroll of whole px. Only the two scroll axes and the class list the pan cursor uses are here.
 */
function makeScroller(left: number, top: number, maxLeft: number, maxTop: number): Scroller & Record<string, unknown> {
	let l = left;
	let t = top;
	const writes: Write[] = [];
	const settle = (v: number, max: number): number => Math.max(0, Math.min(max, Math.round(v)));
	const classes = new Set<string>();
	return {
		writes,
		classList: {
			add: (c: string) => void classes.add(c),
			remove: (c: string) => void classes.delete(c),
			contains: (c: string) => classes.has(c),
		},
		get scrollLeft(): number {
			return l;
		},
		set scrollLeft(v: number) {
			writes.push({ axis: "left", value: v });
			l = settle(v, maxLeft);
		},
		get scrollTop(): number {
			return t;
		},
		set scrollTop(v: number) {
			writes.push({ axis: "top", value: v });
			t = settle(v, maxTop);
		},
	};
}

interface Rig {
	inst: Record<string, unknown>;
	scroller: Scroller;
	proto: Proto;
}

/**
 * A real `InkOverlayPlugin` without `mount()`: the fields a pan through `penDown` and `penRaw` touches, at their
 * class-field defaults, and stubs for what reaches the strip, the editor or the camera's layout.
 */
function makeRig(cssScale: number, scroller: Scroller & Record<string, unknown>): Rig {
	const noop = (): void => undefined;
	const inst = Object.create(InkOverlayPlugin.prototype) as Record<string, unknown>;
	inst.mode = "ink";
	inst.camera = new Camera();
	inst.scale = 1;
	inst.cssScale = cssScale;
	inst.selection = new SelectionModel();
	inst.lassoPts = [];
	inst.lassoActive = false;
	inst.dragFrom = null;
	inst.dragTotal = null;
	inst.spaceLineY = null;
	inst.spaceIds = [];
	inst.spaceBounds = null;
	inst.spacePlan = null;
	inst.panLast = null;
	inst.spaceFromY = 0;
	inst.spaceTotalDy = 0;
	inst.mobileTools = null;
	inst.hoverWatchdog = null;
	inst.mouseStroke = false;
	inst.frame = new StrokeFrame();
	inst.viewportPan = { x: 0, y: 0 };
	inst.previewInkOffset = 0;
	inst.penCursorEl = {
		setAttribute: noop,
		classList: { add: noop, remove: noop },
		setCssStyles: noop,
	};
	inst.view = {
		state: EditorState.create({ doc: "text" }),
		dom: { ownerDocument: { defaultView: { setTimeout: () => 1, clearTimeout: noop } } },
		hasFocus: true,
		focus: noop,
		scrollDOM: scroller,
	};
	inst.container = { getBoundingClientRect: () => ({ left: 0, top: 0 }) };
	inst.router = { refreshRect: noop, isStroking: false };
	inst.ensurePenTools = noop;
	inst.syncCamera = noop;
	inst.recordPenDownState = noop;
	inst.redrawSelectionUI = noop;
	inst.updateExtent = noop;
	inst.filePath = (): string | null => null;
	return { inst, scroller, proto: InkOverlayPlugin.prototype as unknown as Proto };
}

/** Pen down in the pan tool at (x, y), each precondition its own assert. */
function panDown(rig: Rig, x: number, y: number): void {
	setTipMode("pan");
	rig.proto.penDown.call(rig.inst, sample(x, y), evAt(x, y));
	expect(rig.inst.mode, "premise: pen down in the pan tool did not start a pan").toBe("pan");
	expect(rig.inst.panLast, "premise: pen down did not hold the pen's client point").toEqual({ x, y });
}

function move(rig: Rig, x: number, y: number): void {
	rig.proto.penRaw.call(rig.inst, [sample(x, y)], evAt(x, y));
}

describe("the pan tool under a pen keeps the page under the nib at any zoom", () => {
	beforeEach(() => {
		setPenReticle(true);
		releaseTipModes();
	});

	afterEach(() => {
		setPenReticle(true);
		releaseTipModes();
	});

	it("A2a at 200 percent one pen move of 100 screen px moves the scroll by 50", () => {
		const rig = makeRig(2, makeScroller(300, 500, 4000, 4000));
		panDown(rig, 100, 100);
		expect(rig.scroller.writes, "premise: pen down wrote the scroll").toEqual([]);

		move(rig, 100, 200);

		expect(rig.scroller.writes.length, "premise: the move reached no scroll write").toBeGreaterThan(0);
		expect(rig.scroller.scrollLeft, "claim: a move straight down shifted the scroll sideways").toBe(300);
		expect(
			rig.scroller.scrollTop,
			"claim: 100 screen px at 200 percent is 50 scroll px; the page did not stay under the pen"
		).toBe(450);
	});

	it("A2b at 300 percent 100 one-px moves keep the page with the pen at every sample", () => {
		const rig = makeRig(3, makeScroller(1000, 1000, 5000, 5000));
		panDown(rig, 100, 100);
		let worst = 0;
		let worstAt = "none";
		for (let i = 1; i <= 100; i++) {
			move(rig, 100 + i, 100 + i);
			const pageX = (1000 - rig.scroller.scrollLeft) * 3;
			const pageY = (1000 - rig.scroller.scrollTop) * 3;
			const off = Math.max(Math.abs(pageX - i), Math.abs(pageY - i));
			if (off > worst) {
				worst = off;
				worstAt = `sample ${i}: pen ${i} px, page x ${pageX} y ${pageY}`;
			}
		}
		expect(rig.scroller.writes.length, "premise: the drag reached no scroll write").toBeGreaterThan(0);
		expect(
			worst,
			`claim: the page left the pen by more than one scroll px times the zoom (3 px); worst at ${worstAt}`
		).toBeLessThanOrEqual(3);
	});

	it("A2c at a range end a drag 60 px past it and back 10 px moves the page at the first reversed sample", () => {
		// 300 percent, 10 scroll px from the top end: the end is 30 screen px of drag away. The drag goes 90 px
		// down in 5 px steps, 60 px past the end, then back up 10 px in one sample.
		const rig = makeRig(3, makeScroller(0, 10, 5000, 5000));
		panDown(rig, 100, 100);
		for (let y = 105; y <= 190; y += 5) move(rig, 100, y);
		expect(rig.scroller.scrollTop, "premise: the drag did not reach the top end of the range").toBe(0);

		move(rig, 100, 180);

		expect(
			rig.scroller.scrollTop,
			"claim: the page did not move at the first sample reversed at the range end"
		).toBeGreaterThan(0);
	});

	it("A2d at 100 percent the scroll writes are a step written as it is, fractional points included", () => {
		const points: Array<[number, number]> = [
			[103.75, 98.25],
			[103.75, 110.6],
			[90.1, 110.6],
			[90.1, 110.6],
			[95.5, 104.5],
			[96, 105],
		];
		const rig = makeRig(1, makeScroller(500, 500, 5000, 5000));
		panDown(rig, 100.25, 100.5);
		for (const [x, y] of points) move(rig, x, y);

		// The same moves against a second scroller, each step written as it is: today's writes at 100 percent.
		const today = makeScroller(500, 500, 5000, 5000);
		let last = { x: 100.25, y: 100.5 };
		for (const [x, y] of points) {
			const dx = x - last.x;
			const dy = y - last.y;
			if (dx === 0 && dy === 0) continue;
			last = { x, y };
			today.scrollLeft -= dx;
			today.scrollTop -= dy;
		}
		expect(today.writes.length, "premise: the reference made no writes").toBe(10);
		expect(rig.scroller.writes, "claim: at 100 percent the scroll writes are not today's").toEqual(today.writes);
	});
});
