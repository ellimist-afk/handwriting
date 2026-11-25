/**
 * A pinch never starts under a live pen, and the pair that rested through the stroke pinches from where it is
 * when the pen lifts.
 *
 * The pen claim ends a live pinch and measures the pair again. Before this, a finger of that pair moving on under the
 * pen wrote its place and asked the pinch, with no pen test, so the resting hand zoomed the page mid-stroke. Gating
 * only that is not enough: the pen's end did not measure the pair again, so the first finger move after the lift
 * carried the whole drift of the stroke at once (145/130, about 1.12, in one frame between two strokes).
 *
 * C1: no pinch event while the pen is down. C2: the first move after the lift carries no drift. C3: the pair's places
 * stay live during the stroke, so the pinch after the lift starts and ends at the pair's real midpoint. C4 and C5 are
 * pins: finger ink handing over to a pinch, and a plain pinch with no pen, both as before.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { InlinePenRouter } from "./InlinePenRouter";
import { resetPenToolsForTest } from "./PenToolsMode";
import { fakeEl, installFakeWindow, penEvent, recorder, winHandlers } from "../../test/routerHarness";

let undoWindow: () => void;
const routers: InlinePenRouter[] = [];
beforeAll(() => {
	undoWindow = installFakeWindow();
});
afterAll(() => {
	undoWindow();
});
afterEach(() => {
	for (const r of routers.splice(0)) r.dispose();
});

type Pinch = { phase: string; ratio: number; at: { x: number; y: number }; penDown: boolean };

const PEN = 7;

function rig(fingerInk = false) {
	resetPenToolsForTest();
	const el = fakeEl();
	Object.assign(el, { scrollWidth: 2000, clientWidth: 800, scrollHeight: 2000, clientHeight: 600 });
	const pinches: Pinch[] = [];
	let penDown = false;
	const rec = recorder();
	const router = new InlinePenRouter(
		el as unknown as HTMLElement,
		el as unknown as HTMLElement,
		{
			...rec.cb,
			fingerInk: () => fingerInk,
			penOff: () => false,
			onPinch: (phase: string, ratio: number, at: { x: number; y: number }) =>
				pinches.push({ phase, ratio, at: { ...at }, penDown }),
		} as never,
		() => 1
	);
	routers.push(router);
	const live = new Set<number>();
	let ts = 1000;
	function touch(type: string, id: number, x: number, y = 100): void {
		ts += 16;
		el.handlers.get(type)!(
			penEvent(type, ts, {
				pointerId: id,
				pointerType: "touch",
				x,
				y,
				isPrimary: id === 1,
				pressure: 0,
				buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1,
			})
		);
	}
	function native(type: string, id: number): void {
		if (type === "touchstart") live.add(id);
		else if (type !== "touchmove") live.delete(id);
		winHandlers.get(type)!({
			type,
			target: el,
			changedTouches: [{ identifier: id, touchType: "direct", radiusX: 4, radiusY: 4 }],
			touches: [...live].map((identifier) => ({ identifier, touchType: "direct" })),
			preventDefault() {},
			stopPropagation() {},
		} as unknown as Event);
	}
	function pen(type: string, x = 400, y = 300): void {
		ts += 16;
		if (type === "pointerdown") penDown = true;
		el.handlers.get(type)!(
			penEvent(type, ts, { pointerId: PEN, pointerType: "pen", x, y, buttons: type === "pointerup" ? 0 : 1 })
		);
		if (type === "pointerup") penDown = false;
	}
	const down = (id: number, x: number) => {
		touch("pointerdown", id, x);
		native("touchstart", 500 + id);
	};
	const move = (id: number, x: number) => touch("pointermove", id, x);
	const up = (id: number, x: number) => {
		touch("pointerup", id, x);
		native("touchend", 500 + id);
	};
	return { router, rec, pinches, down, move, up, pen };
}

/** The audit's road: a pair 100 px apart pinches to 130, then the pen lands. Fingers 1 at 100, 2 at 230. */
function pairThenPen(h: ReturnType<typeof rig>): void {
	h.down(1, 100);
	h.down(2, 200);
	h.move(2, 230);
	expect(h.pinches.map((p) => p.phase), "precondition: the pair pinched before the pen").toEqual(["start", "move"]);
	h.pen("pointerdown");
	expect(h.router.isStroking, "precondition: the pen owns a stroke").toBe(true);
	expect(h.pinches.at(-1)?.phase, "precondition: the pen claim ended the pinch").toBe("end");
}

describe("C1: a resting pair under a live pen", () => {
	it("a finger of the pair moving 15 px more under the pen sends no pinch", () => {
		const h = rig();
		pairThenPen(h);
		const before = h.pinches.length;
		h.move(2, 238);
		h.move(2, 245);
		h.pen("pointermove", 410, 305);
		expect(h.pinches.slice(before), "the resting hand pinched under the pen").toEqual([]);
		expect(h.pinches.filter((p) => p.penDown && p.phase !== "end"), "a pinch phase other than the claim's end under the pen").toEqual([]);
	});
});

describe("C2: the pen lifts with the pair still resting", () => {
	it("the pair's first move after the lift carries no drift from the stroke", () => {
		const h = rig();
		pairThenPen(h);
		h.move(2, 245); // 15 px of drift during the stroke: spread 145
		h.pen("pointerup");
		expect(h.router.isStroking, "precondition: the stroke ended").toBe(false);
		const before = h.pinches.length;
		h.move(2, 246); // one px
		for (const p of h.pinches.slice(before).filter((p) => p.phase === "move")) {
			expect(Math.abs(p.ratio - 1), `a move at ratio ${p.ratio.toFixed(4)} zoomed by the stroke's drift`).toBeLessThanOrEqual(1 / 130);
		}
	});

	it("the pair then pinches from its spread at the lift, as today's pinch does", () => {
		const h = rig();
		pairThenPen(h);
		h.move(2, 245);
		h.pen("pointerup");
		h.move(2, 290); // spread 145 -> 190
		const moves = h.pinches.filter((p) => !p.penDown && p.phase === "move");
		expect(moves.at(-1)?.ratio, "the pinch after the lift").toBeCloseTo(190 / 145, 6);
	});
});

describe("C3: both fingers move during the stroke, then the pen lifts", () => {
	it("the pinch after the lift starts and ends at the pair's real midpoint", () => {
		const h = rig();
		pairThenPen(h);
		h.move(1, 90); // both fingers drift under the pen: 90 and 250, spread 160, midpoint 170
		h.move(2, 250);
		expect(h.pinches.filter((p) => p.penDown && p.phase !== "end"), "the pair pinched under the pen").toEqual([]);
		h.pen("pointerup");
		const lifted = h.pinches.length;
		h.move(2, 290); // 90 and 290: spread 200, midpoint 190
		const after = h.pinches.slice(lifted);
		expect(after.map((p) => p.phase), "the pair engaged once, after the lift").toEqual(["start", "move"]);
		expect(after[0]!.at, "start centroid").toEqual({ x: 190, y: 100 });
		expect(after[1]!.ratio, "measured from the spread at the lift").toBeCloseTo(200 / 160, 6);
		h.up(1, 90);
		const end = h.pinches.at(-1)!;
		expect(end.phase).toBe("end");
		expect(end.at, "end centroid: the pair's last real midpoint").toEqual({ x: 190, y: 100 });
	});
});

describe("C4 (pin): finger ink hands over to a pinch", () => {
	it("a finger-ink stroke, a second finger, spread +15: start then move, as before", () => {
		const h = rig(true);
		h.down(1, 100);
		h.move(1, 104);
		expect(h.router.isStroking, "precondition: finger ink owns the first finger").toBe(true);
		h.down(2, 200);
		h.move(2, 215);
		expect(h.pinches.map((p) => p.phase)).toEqual(["start", "move"]);
		expect(h.pinches[1]!.ratio).toBeCloseTo(111 / 96, 6);
	});
});

describe("C5 (pin): a pinch with no pen", () => {
	it("two fingers send start, moves and end, as before", () => {
		const h = rig();
		h.down(1, 100);
		h.down(2, 200);
		h.move(2, 230);
		h.move(2, 260);
		h.up(2, 260);
		expect(h.pinches.map((p) => p.phase)).toEqual(["start", "move", "move", "end"]);
		expect(h.pinches[2]!.ratio).toBeCloseTo(160 / 100, 6);
		expect(h.pinches[3]!.at).toEqual({ x: 180, y: 100 });
	});
});
