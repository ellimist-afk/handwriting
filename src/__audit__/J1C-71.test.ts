/**
 * J1C-71: palm rejection must hold across panes. Two REAL routers; pen down or
 * hovering in pane A; a palm lands in pane B. Stubbed: callbacks (recorder),
 * window, performance.now. Only scroller-level events are fired.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { InlinePenRouter } from "../inline/InlinePenRouter";
import { resetPenToolsForTest } from "../inline/PenToolsMode";
import { fakeEl, installFakeWindow, penEvent, recorder } from "../../test/routerHarness";

let clock = 1000;
let undo: () => void;
const routers: InlinePenRouter[] = [];
beforeAll(() => { undo = installFakeWindow(); });
afterAll(() => undo());
beforeEach(() => { clock = 1000; vi.spyOn(performance, "now").mockImplementation(() => clock); resetPenToolsForTest(); });
afterEach(() => { for (const r of routers.splice(0)) r.dispose(); vi.restoreAllMocks(); });

function pane() {
	const el = fakeEl() as ReturnType<typeof fakeEl> & Record<string, unknown>;
	Object.assign(el, {
		clientWidth: 800, clientHeight: 600, scrollWidth: 100_000, scrollHeight: 100_000,
		scrollTo(o: { left: number; top: number }) { el.scrollLeft = o.left; el.scrollTop = o.top; },
	});
	el.scrollLeft = 5000;
	el.scrollTop = 5000;
	const rec = recorder();
	const router = new InlinePenRouter(el as unknown as HTMLElement, el as unknown as HTMLElement,
		{ ...rec.cb, fingerInk: () => false, penOff: () => false } as never, () => 1);
	routers.push(router);
	router.setCanvasMomentumDisabled(true);
	const fire = (type: string, pointerType: string, id: number, x: number, y: number, buttons: number) => {
		clock += 16;
		let prevented = false;
		const ev = penEvent(type, clock, { pointerId: id, pointerType, x, y, pressure: buttons ? 0.5 : 0, buttons });
		(ev as unknown as { preventDefault(): void }).preventDefault = () => { prevented = true; };
		el.handlers.get(type)!(ev);
		return prevented;
	};
	return { el, router, rec, fire };
}

function palm(p: ReturnType<typeof pane>, x: number, fast: boolean) {
	p.fire("pointerdown", "touch", 21, x, 400, 1);
	for (let i = 1; i <= 6; i++) {
		if (!fast) clock += 104;
		p.fire("pointermove", "touch", 21, x, 400 - i * (fast ? 10 : 5), 1);
	}
}

describe("J1C-71 a palm in the next pane while the pen writes", () => {
	for (const fast of [true, false]) {
		it(`control: a palm in the SAME pane as the writing pen does not scroll it (fast=${fast})`, () => {
			const a = pane();
			a.fire("pointerdown", "pen", 9, 200, 200, 1);
			expect(a.rec.downs).toBe(1);
			const top = a.el.scrollTop;
			palm(a, 600, fast);
			expect(a.el.scrollTop).toBe(top);
			expect(a.router.palmsBlocked).toBe(1);
		});

		it(`a palm in pane B while the pen is down in pane A does not scroll pane B (fast=${fast})`, () => {
			const a = pane();
			const b = pane();
			a.fire("pointerdown", "pen", 9, 200, 200, 1);
			a.fire("pointermove", "pen", 9, 220, 210, 1);
			expect(a.rec.downs).toBe(1);
			const top = b.el.scrollTop;
			const left = b.el.scrollLeft;
			palm(b, 100, fast);
			expect({ top: b.el.scrollTop, left: b.el.scrollLeft }).toEqual({ top, left });
			expect(b.router.palmsBlocked).toBe(1);
		});
	}

	it("control: a slow palm in the SAME pane the pen hovers over does not scroll it", () => {
		const a = pane();
		a.fire("pointermove", "pen", 9, 200, 200, 0);
		const top = a.el.scrollTop;
		palm(a, 600, false);
		expect(a.el.scrollTop).toBe(top);
	});

	it("a slow palm in pane B while the pen hovers over pane A (palm placed before pen) does not scroll pane B", () => {
		const a = pane();
		const b = pane();
		a.fire("pointermove", "pen", 9, 200, 200, 0);
		const top = b.el.scrollTop;
		palm(b, 100, false);
		expect(b.el.scrollTop).toBe(top);
	});
});
