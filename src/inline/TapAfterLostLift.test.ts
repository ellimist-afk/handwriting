/**
 * A TAP AFTER A LOST LIFT IS STILL A TAP (issue 51).
 *
 * When a primary touch lands while the router still holds a contact whose lift never arrived, that stale contact is
 * retired before anything reads the touch maps (InlinePenRouterInput.ts). noteTapStart records a lone finger's landing
 * only while touchPos is empty, so the retire has to run before it: run after it, the new finger's landing is not
 * recorded and its lift is no tap. The rig is the PDF surface's own router, built the way ManipulationGuardIssue51.test.ts
 * builds it, with an onTapLift counter.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { setDiagnosticsEnabled } from "../diag/DiagSwitch";
import { clearInlinePenTrace, InlinePenRouter } from "./InlinePenRouter";
import { resetPenToolsForTest } from "./PenToolsMode";
import { fakeEl, installFakeWindow, penEvent, recorder } from "../../test/routerHarness";

let undoWindow: () => void;
const routers: InlinePenRouter[] = [];

beforeAll(() => {
	undoWindow = installFakeWindow();
	setDiagnosticsEnabled(true);
});

afterAll(() => {
	setDiagnosticsEnabled(false);
	undoWindow();
});

afterEach(() => {
	for (const r of routers.splice(0)) r.dispose();
	clearInlinePenTrace();
});

function pdfRig() {
	resetPenToolsForTest();
	const el: ReturnType<typeof fakeEl> & { scrollWidth: number; clientWidth: number; scrollHeight: number; clientHeight: number; scrollTo(o: { left?: number; top?: number }): void } =
		Object.assign(fakeEl(), { scrollWidth: 0, clientWidth: 0, scrollHeight: 0, clientHeight: 0, scrollTo(o: { left?: number; top?: number }) { if (o.left !== undefined) el.scrollLeft = o.left; if (o.top !== undefined) el.scrollTop = o.top; } });
	Object.assign(el, { scrollWidth: 800, clientWidth: 800, scrollHeight: 4000, clientHeight: 600 });
	el.scrollTop = 1500;
	const rec = recorder();
	let taps = 0;
	const cb = { ...rec.cb, fingerInk: () => false, penOff: () => false, onTapLift: () => void taps++ } as never;
	const router = new InlinePenRouter(el as unknown as HTMLElement, el as unknown as HTMLElement, cb, () => 1, "pinch-zoom", undefined, false);
	routers.push(router);
	let ts = 1000;

	function send(type: string, x: number, y: number, o: { id?: number; isPrimary?: boolean } = {}): void {
		ts += 16;
		const ev = penEvent(type, ts, {
			pointerId: o.id ?? 31, pointerType: "touch", x, y, isPrimary: o.isPrimary ?? true, pressure: 0,
			buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1,
		});
		const handler = el.handlers.get(type);
		if (!handler) throw new Error(`missing handler ${type}`);
		handler(ev);
	}
	function panNoLift(id: number): void {
		send("pointerdown", 400, 300, { id });
		for (let i = 1; i <= 6; i++) send("pointermove", 400, 300 - i * 20, { id });
	}
	function tap(id: number): void {
		send("pointerdown", 200, 200, { id });
		send("pointerup", 200, 200, { id });
	}
	const maps = router as unknown as { touchPos: Map<number, unknown> };
	return { el, maps, panNoLift, tap, taps: () => taps };
}

describe("issue 51: a tap after a lost lift", () => {
	it("CONTROL: a lone tap on the PDF router is a tap", () => {
		const h = pdfRig();
		h.tap(41);
		expect(h.taps(), "the lone tap called onTapLift").toBe(1);
	});

	it("a pan whose lift is lost, then a lone tap by a new primary finger: the stale finger is retired and the tap is a tap", () => {
		const h = pdfRig();
		h.panNoLift(31);
		expect(h.el.scrollTop, "premise: the pan moved the page").not.toBe(1500);
		expect(h.maps.touchPos.has(31), "premise: the stale finger is held").toBe(true);
		h.tap(42);
		expect(h.maps.touchPos.size, "the stale finger is gone").toBe(0);
		expect(h.taps(), "the tap after the lost lift called onTapLift").toBe(1);
	});
});
