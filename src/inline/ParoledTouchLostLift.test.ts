/**
 * A touch the palm gate swallowed and then paroled into the assist pan sits in
 * guardTouches but never in touchPos. When its lift was lost, the native "no
 * touch left" touchend retired only touchPos keys, and only when touchPos was
 * non-empty, so guardTouches and the assist stayed set and hasActiveNavigation
 * read true for good. InkOverlay reads that before it reports the pane quiet,
 * and only a quiet pane takes ink synced from another device.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { InlinePenRouter } from "./InlinePenRouter";
import { harness as baseHarness, installFakeWindow, penEvent } from "../../test/routerHarness";

const built: InlinePenRouter[] = [];
function harness(): ReturnType<typeof baseHarness> {
	const h = baseHarness();
	built.push(h.router);
	return h;
}

let uninstall: () => void = () => {};
beforeAll(() => {
	uninstall = installFakeWindow();
});
afterAll(() => uninstall());
afterEach(() => {
	for (const r of built.splice(0)) r.dispose();
});

const FINGER = 41;
const touch = (type: string, t: number, x: number) =>
	penEvent(type, t, { pointerType: "touch", pointerId: FINGER, isPrimary: false, x, y: 300, pressure: 0.5 });

describe("a paroled touch whose lift never arrives", () => {
	it("the native all-touches-ended touchend ends the navigation it was carrying", () => {
		const h = harness();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const p = h.router as any;
		// A pen hovering beside the page: the next touch is swallowed and watched for parole.
		h.fire(penEvent("pointermove", 100, { x: 800, y: 300, pressure: 0, buttons: 0 }));
		h.fireWin({ type: "touchstart", target: h.el, touches: [{ identifier: FINGER }], changedTouches: [{ identifier: FINGER }], preventDefault: () => {}, stopPropagation: () => {} } as unknown as PointerEvent);
		h.fire(touch("pointerdown", 105, 600));
		expect(p.swallowedTouches.has(FINGER), "precondition: the gate swallowed the touch").toBe(true);
		h.fire(touch("pointermove", 110, 590));
		h.fire(touch("pointermove", 115, 570));
		expect(p.guardTouches.has(FINGER), "precondition: the touch earned parole into the assist pan").toBe(true);
		expect(p.touchPos.has(FINGER), "precondition: a paroled touch is not in touchPos").toBe(false);
		// Its pointerup is lost; the browser says the hand is off the glass.
		h.fireWin({ type: "touchend", target: h.el, touches: [], changedTouches: [{ identifier: FINGER }], preventDefault: () => {}, stopPropagation: () => {} } as unknown as PointerEvent);
		expect(h.router.hasActiveNavigation, "the lost lift holds the pane busy for good").toBe(false);
	});
});
