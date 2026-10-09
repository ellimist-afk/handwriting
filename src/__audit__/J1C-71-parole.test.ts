/**
 * J1C-71, the parole path: a palm the gate swallowed in pane B is watched on parole, and a swipe-like start would
 * turn it into a scroll. The pen writing in pane A must keep that palm a palm. Only a swallowed touch is on
 * parole, so in every arm the gate is warm when the palm lands; the palm then moves fast enough to earn parole.
 *   - Pen hovering over A when the palm lands in B (nothing is down, so nothing marks the palm as overlapped), then
 *     the pen writes in A while the palm swipes: the parole decision has to read the stroke in EVERY pane.
 *   - Pen writing in A when the palm lands in B, then the pen lifts and the palm swipes: once the stroke is over,
 *     only the overlap flag set at touch-down keeps the palm a palm, so that flag has to read the pen in EVERY pane.
 *   - Pen hovering over A when the palm lands in B, then the pen writes in A and lifts, then the palm swipes: the
 *     pen landing is what marks the palm as overlapped, so it has to mark the palm in EVERY pane, not only its own.
 * Two REAL routers. Stubbed: callbacks (recorder), window, performance.now. Only scroller-level events are fired.
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
		el.handlers.get(type)!(penEvent(type, clock, { pointerId: id, pointerType, x, y, pressure: buttons ? 0.5 : 0, buttons }));
	};
	return { el, router, rec, fire };
}

describe("J1C-71 parole: a palm swallowed in pane B stays a palm while the pen writes in pane A", () => {
	it("palm lands in B while the pen hovers over A, the pen then writes in A, the palm swipes: pane B does not scroll", () => {
		const a = pane();
		const b = pane();
		a.fire("pointermove", "pen", 9, 200, 200, 0);
		b.fire("pointerdown", "touch", 21, 100, 400, 1);
		expect(b.router.palmsBlocked, "premise: the gate swallowed the palm in B").toBe(1);
		a.fire("pointerdown", "pen", 9, 200, 200, 1);
		a.fire("pointermove", "pen", 9, 220, 210, 1);
		expect(a.rec.downs, "premise: the pen is writing in A").toBe(1);
		const at = { top: b.el.scrollTop, left: b.el.scrollLeft };
		// Fast: 10 px every 16 ms, past the parole distance well inside the parole window.
		for (let i = 1; i <= 6; i++) b.fire("pointermove", "touch", 21, 100, 400 - i * 10, 1);
		expect({ top: b.el.scrollTop, left: b.el.scrollLeft }, "pane B did not scroll").toEqual(at);
	});

	it("palm lands in B while the pen writes in A, the pen lifts, the palm swipes inside the window: pane B does not scroll", () => {
		const a = pane();
		const b = pane();
		a.fire("pointerdown", "pen", 9, 200, 200, 1);
		a.fire("pointermove", "pen", 9, 220, 210, 1);
		expect(a.rec.downs, "premise: the pen is writing in A").toBe(1);
		b.fire("pointerdown", "touch", 21, 100, 400, 1);
		expect(b.router.palmsBlocked, "premise: the gate swallowed the palm in B").toBe(1);
		a.fire("pointerup", "pen", 9, 220, 210, 0);
		const at = { top: b.el.scrollTop, left: b.el.scrollLeft };
		for (let i = 1; i <= 6; i++) b.fire("pointermove", "touch", 21, 100, 400 - i * 10, 1);
		expect({ top: b.el.scrollTop, left: b.el.scrollLeft }, "pane B did not scroll").toEqual(at);
	});

	it("palm lands in B while the pen hovers over A, the pen writes in A and lifts, the palm swipes inside the window: pane B does not scroll", () => {
		const a = pane();
		const b = pane();
		a.fire("pointermove", "pen", 9, 200, 200, 0);
		b.fire("pointerdown", "touch", 21, 100, 400, 1);
		expect(b.router.palmsBlocked, "premise: the gate swallowed the palm in B").toBe(1);
		a.fire("pointerdown", "pen", 9, 200, 200, 1);
		a.fire("pointermove", "pen", 9, 220, 210, 1);
		expect(a.rec.downs, "premise: the pen wrote in A").toBe(1);
		a.fire("pointerup", "pen", 9, 220, 210, 0);
		const at = { top: b.el.scrollTop, left: b.el.scrollLeft };
		for (let i = 1; i <= 6; i++) b.fire("pointermove", "touch", 21, 100, 400 - i * 10, 1);
		expect({ top: b.el.scrollTop, left: b.el.scrollLeft }, "pane B did not scroll").toEqual(at);
	});
});
