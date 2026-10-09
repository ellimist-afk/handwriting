/**
 * The pinch measures from the pair down NOW. A third finger lands on a pinch
 * that is armed but not yet engaged, the pair's fingers move while three are
 * down (the pinch ignores moves with three contacts), then one finger of the
 * first pair lifts. The two left are a new pair; their first move must not
 * engage at the ratio of the new spread against the first pair's spread.
 * Companion to TouchThirdFingerPinch.test.ts, which covers the same lift with
 * the pinch already live.
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

function rig() {
	resetPenToolsForTest();
	const el = fakeEl();
	Object.assign(el, { scrollWidth: 2000, clientWidth: 800, scrollHeight: 2000, clientHeight: 600 });
	const pinches: { phase: string; ratio: number }[] = [];
	const router = new InlinePenRouter(
		el as unknown as HTMLElement,
		el as unknown as HTMLElement,
		{
			...recorder().cb,
			fingerInk: () => false,
			penOff: () => false,
			onPinch: (phase: string, ratio: number) => pinches.push({ phase, ratio }),
		} as never,
		() => 1
	);
	routers.push(router);
	const live = new Set<number>();
	function pointer(type: string, id: number, x: number, y = 100): void {
		el.handlers.get(type)!(
			penEvent(type, type === "pointerdown" ? 10 : 700, {
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
	const down = (id: number, x: number) => {
		pointer("pointerdown", id, x);
		native("touchstart", 500 + id);
	};
	const up = (id: number, x: number) => {
		pointer("pointerup", id, x);
		native("touchend", 500 + id);
	};
	return { pointer, down, up, pinches };
}

describe("a pinch armed but not engaged, a third finger, then one of the first pair lifts", () => {
	it("the new pair's first move does not zoom by its spread against the old pair's", () => {
		const h = rig();
		h.down(1, 100);
		h.down(2, 200); // armed, start spread 100, nothing engaged yet
		h.down(3, 600);
		h.pointer("pointermove", 2, 260); // three down: the pinch ignores it
		expect(h.pinches, "precondition: nothing engaged before the lift").toEqual([]);
		h.up(1, 100); // fingers 2 (x=260) and 3 (x=600) remain: spread 340
		h.pointer("pointermove", 2, 262); // two px
		const ratios = h.pinches.filter((p) => p.phase === "move").map((p) => p.ratio);
		for (const r of ratios) expect(r, "the new pair zoomed by 338/100").toBeCloseTo(1, 1);
	});

	it("the new pair then pinches from its own spread", () => {
		const h = rig();
		h.down(1, 100);
		h.down(2, 200);
		h.down(3, 600);
		h.pointer("pointermove", 2, 260);
		h.up(1, 100);
		h.pointer("pointermove", 2, 160); // spread 340 -> 440
		const last = h.pinches.filter((p) => p.phase === "move").at(-1);
		expect(last?.ratio).toBeCloseTo(440 / 340, 6);
	});
});
