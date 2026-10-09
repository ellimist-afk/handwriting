import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { InlinePenRouter } from "./InlinePenRouter";
import { resetPenToolsForTest } from "./PenToolsMode";
import { fakeEl, installFakeWindow, penEvent, recorder, winHandlers } from "../../test/routerHarness";

let undoWindow: () => void;
const routers: InlinePenRouter[] = [];
beforeAll(() => { undoWindow = installFakeWindow(); });
afterAll(() => { undoWindow(); });
afterEach(() => { for (const r of routers.splice(0)) r.dispose(); });

function rig() {
	resetPenToolsForTest();
	const el = fakeEl();
	Object.assign(el, { scrollWidth: 2000, clientWidth: 800, scrollHeight: 2000, clientHeight: 600 });
	const record = recorder();
	const pinches: { phase: string; ratio: number }[] = [];
	const router = new InlinePenRouter(
		el as unknown as HTMLElement,
		el as unknown as HTMLElement,
		{
			...record.cb,
			fingerInk: () => false,
			penOff: () => false,
			onPinch: (phase: string, ratio: number) => pinches.push({ phase, ratio }),
		} as never,
		() => 1,
	);
	routers.push(router);
	const live = new Set<number>();
	function pointer(type: string, id: number, x: number, y = 100): void {
		const ev = penEvent(type, type === "pointerdown" ? 10 : 700, {
			pointerId: id, pointerType: "touch", x, y, isPrimary: id === 1, pressure: 0,
			buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1,
		});
		el.handlers.get(type)!(ev);
	}
	function native(type: string, id: number): void {
		if (type === "touchstart") live.add(id); else if (type !== "touchmove") live.delete(id);
		winHandlers.get(type)!({
			type, target: el,
			changedTouches: [{ identifier: id, touchType: "direct", radiusX: 4, radiusY: 4 }],
			touches: [...live].map((identifier) => ({ identifier, touchType: "direct" })),
			preventDefault() {}, stopPropagation() {},
		} as unknown as Event);
	}
	const down = (id: number, x: number) => { pointer("pointerdown", id, x); native("touchstart", 500 + id); };
	const up = (id: number, x: number) => { pointer("pointerup", id, x); native("touchend", 500 + id); };
	return { pointer, down, up, pinches };
}

describe("three fingers, one of the pinch pair lifts", () => {
	it("a 1px nudge of a remaining finger does not zoom the note 3.5x", () => {
		const h = rig();
		h.down(1, 100);
		h.down(2, 200);           // pinch armed, start spread 100
		h.pointer("pointermove", 2, 250); // live pinch, ratio 1.5
		expect(h.pinches.at(-1)).toEqual({ phase: "move", ratio: 1.5 });
		h.down(3, 600);           // a third finger lands
		h.up(1, 100);             // finger 1 lifts: pinch ends; fingers 2 (x=250) and 3 (x=600) remain
		expect(h.pinches.at(-1)?.phase).toBe("end");
		const before = h.pinches.length;
		h.pointer("pointermove", 2, 251); // finger 2 moves ONE pixel
		const after = h.pinches.slice(before).filter((p) => p.phase === "move").map((p) => p.ratio);
		for (const r of after) expect(r).toBeCloseTo(1, 1);
	});
});
