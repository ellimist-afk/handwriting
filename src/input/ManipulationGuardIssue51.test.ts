/**
 * ISSUE 51: ON LINUX, TOUCH IS DEAD FOR A MOMENT AFTER A PAN ON A PDF STOPS.
 *
 * 1.4.24 (365e6412) builds the PDF router's guard without the native touch window, which fixed it on Windows. The guard is
 * platform-blind, so Linux must reach the dead state another way. Three suspects, named from reading the code
 * only; each arm below replays one suspect's event order through the PDF surface's own router (built the way
 * PdfInkController builds it: guard value "pinch-zoom", no native window) and asks the one thing the reporter lost: the
 * next finger pan moves the page.
 *
 *   S1, a lost lift: the pan's pointerup and pointercancel never arrive. The guard keeps counting the finger, stays in
 *       armed-assist, and gives the next finger no assist under touch-action none.
 *   S2, the lift comes another way: a pointercancel instead of a pointerup, after the pan or before the assist engaged.
 *   S3, the pen: proximity events arrive after the lift and feed the palm gate.
 *
 * A fourth surface, a PDF embedded in a note, rides the note's router and keeps the native window; whether a finger
 * handed to the browser there moves the embed is the browser's answer, read on the rig, not here.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { setDiagnosticsEnabled } from "../diag/DiagSwitch";
import { captureInlinePenTrace, clearInlinePenTrace, InlinePenRouter } from "../inline/InlinePenRouter";
import { resetPenToolsForTest } from "../inline/PenToolsMode";
import { fakeEl, installFakeWindow, penEvent, recorder, winHandlers } from "../../test/routerHarness";

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
	vi.useRealTimers();
	for (const r of routers.splice(0)) r.dispose();
	clearInlinePenTrace();
});

/** The PDF surface's router over a scroller in the middle of a page that scrolls both ways. */
function pdfRig() {
	resetPenToolsForTest();
	const el: ReturnType<typeof fakeEl> & { scrollWidth: number; clientWidth: number; scrollHeight: number; clientHeight: number; scrollTo(o: { left?: number; top?: number }): void } =
		Object.assign(fakeEl(), { scrollWidth: 0, clientWidth: 0, scrollHeight: 0, clientHeight: 0, scrollTo(o: { left?: number; top?: number }) { if (o.left !== undefined) el.scrollLeft = o.left; if (o.top !== undefined) el.scrollTop = o.top; } });
	Object.assign(el, { scrollWidth: 800, clientWidth: 800, scrollHeight: 4000, clientHeight: 600 });
	el.scrollTop = 1500;
	const rec = recorder();
	const cb = { ...rec.cb, fingerInk: () => false, penOff: () => false } as never;
	const router = new InlinePenRouter(el as unknown as HTMLElement, el as unknown as HTMLElement, cb, () => 1, "pinch-zoom", undefined, false);
	routers.push(router);
	let ts = 1000;

	function send(type: string, x: number, y: number, o: { id?: number; pointerType?: string; isPrimary?: boolean; buttons?: number; pressure?: number } = {}): void {
		const pointerType = o.pointerType ?? "touch";
		ts += 16;
		const ev = penEvent(type, ts, {
			pointerId: o.id ?? 31, pointerType, x, y, isPrimary: o.isPrimary ?? true,
			pressure: o.pressure ?? (pointerType === "pen" && type !== "pointerup" ? 0.5 : 0),
			buttons: o.buttons ?? (type === "pointerup" || type === "pointercancel" ? 0 : 1),
		});
		const handler = el.handlers.get(type);
		if (!handler) throw new Error(`missing handler ${type}`);
		handler(ev);
	}

	/** One finger down and dragged up the page in six 20 px steps; `end` names its lift, or "none" for a lift that never comes. */
	function pan(id: number, end: "pointerup" | "pointercancel" | "none" = "pointerup"): void {
		send("pointerdown", 400, 300, { id });
		for (let i = 1; i <= 6; i++) send("pointermove", 400, 300 - i * 20, { id });
		if (end !== "none") send(end, 400, 180, { id });
	}

	/** The browser's touch event on the window, as the router's native bookkeeping listens for it. */
	function native(type: "touchstart" | "touchend", id: number, left: number[]): void {
		const h = winHandlers.get(type);
		if (!h) throw new Error(`router registered no window handler for ${type}`);
		h({ type, target: el, touches: left.map((identifier) => ({ identifier })), changedTouches: [{ identifier: id }], preventDefault: () => {}, stopPropagation: () => {} } as unknown as Event);
	}

	const guard = () => (router as unknown as { manip: { current: string } }).manip.current;
	const downs = () => captureInlinePenTrace({}).events.filter((r) => r.type === "pointerdown").map((r) => r.note);
	const maps = router as unknown as { touchPos: Map<number, unknown>; guardTouches: Set<number>; pinchLive: boolean };
	return { el, router, rec, maps, send, pan, native, guard, downs };
}

describe("issue 51 arms: the next finger pan on a PDF after the first one stops", () => {
	it("CONTROL: an ordinary pan, lifted, then a second pan: both move the page", () => {
		const h = pdfRig();
		h.pan(31);
		const after1 = h.el.scrollTop;
		expect(after1, "premise: the first pan moved the page").not.toBe(1500);
		h.pan(32);
		expect(h.el.scrollTop, "the second pan moved the page").not.toBe(after1);
		expect(h.guard()).toBe("armed");
	});

	it("S1a, a lost pointerup: the browser's touchend says no touch is left; the next pan moves the page", () => {
		const h = pdfRig();
		h.native("touchstart", 31, [31]);
		h.pan(31, "none");
		const after1 = h.el.scrollTop;
		expect(after1, "premise: the first pan moved the page").not.toBe(1500);
		h.native("touchend", 31, []);
		h.native("touchstart", 32, [32]);
		h.pan(32);
		expect(h.el.scrollTop, "the second pan moved the page").not.toBe(after1);
	});

	it("S1b, a lost lift: neither the pan's pointerup nor its touchend arrives; the next finger, the only one on the glass, still pans", () => {
		const h = pdfRig();
		h.pan(31, "none");
		const after1 = h.el.scrollTop;
		expect(after1, "premise: the first pan moved the page").not.toBe(1500);
		// The browser's own word that no other touch is down: the next contact is the primary pointer.
		h.pan(32);
		// The page moving is the reporter's loss; the trace notes are logged as the mechanism, never asserted.
		console.log(`S1b READ guard=${h.guard()} downs=${JSON.stringify(h.downs())} scroll ${after1} -> ${h.el.scrollTop}`);
		expect(h.el.scrollTop, "the second pan moved the page").not.toBe(after1);
	});

	it("S1 CONTROL: a real second finger (not primary) while the first is down is still a pinch, not a pan", () => {
		const h = pdfRig();
		h.send("pointerdown", 400, 300, { id: 31 });
		h.send("pointerdown", 500, 300, { id: 32, isPrimary: false });
		expect(h.downs()[1] ?? "", "the second finger did not start a pan of its own").not.toContain("assist will carry");
	});

	it("S2, the pan lifted by a pointercancel: the next pan moves the page", () => {
		const h = pdfRig();
		h.pan(31, "pointercancel");
		const after1 = h.el.scrollTop;
		expect(after1, "premise: the first pan moved the page").not.toBe(1500);
		h.pan(32);
		expect(h.el.scrollTop, "the second pan moved the page").not.toBe(after1);
	});

	it("S2, a finger cancelled before the assist engaged: the next pan moves the page", () => {
		const h = pdfRig();
		h.send("pointerdown", 400, 300, { id: 31 });
		h.send("pointercancel", 400, 300, { id: 31 });
		h.pan(32);
		expect(h.el.scrollTop, "the pan moved the page").not.toBe(1500);
	});

	it("S3, the pen's proximity after the lift: a finger after the pen has gone quiet past the palm tail pans", () => {
		// The router reads performance.now(), so the clock is faked before the router is built.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
		const h = pdfRig();
		h.pan(31);
		const after1 = h.el.scrollTop;
		h.send("pointermove", 300, 300, { id: 77, pointerType: "pen", buttons: 0, pressure: 0 });
		// The palm gate's hover tail is 300 ms (PalmGate.ts HOVER_TAIL_MS): move the fake clock past it with no pen event.
		vi.advanceTimersByTime(360);
		h.pan(32);
		expect(h.el.scrollTop, "the pan after the pen went quiet moved the page").not.toBe(after1);
	});

	// A readout, asserted in neither direction: the first run (b9dc5957, 2026-10-29T17:04Z) read the finger inside the tail
	// panning (1620 -> 1740), against the reading that the palm gate takes it as a palm. Either answer is no dead touch.
	it("S3 READOUT: a finger inside the pen's hover tail, logged only", () => {
		const h = pdfRig();
		h.pan(31);
		const after1 = h.el.scrollTop;
		h.send("pointermove", 300, 300, { id: 77, pointerType: "pen", buttons: 0, pressure: 0 });
		h.pan(32);
		console.log(`S3 READ inside tail: guard=${h.guard()} downs=${JSON.stringify(h.downs())} scroll ${after1} -> ${h.el.scrollTop}`);
	});
	it("the stale-contact clear retires finger maps only: a pen stroke live, a stale finger held, a palm lands as the primary touch: the stroke runs on, the stale finger is retired", () => {
		const h = pdfRig();
		h.pan(31, "none");
		expect(h.maps.touchPos.has(31), "premise: the stale finger is held").toBe(true);
		h.send("pointerdown", 300, 300, { id: 77, pointerType: "pen" });
		h.send("pointermove", 310, 305, { id: 77, pointerType: "pen" });
		expect(h.router.isStroking, "premise: the pen stroke is live").toBe(true);
		h.send("pointerdown", 500, 400, { id: 33 });
		expect(h.maps.touchPos.has(31), "the stale finger is retired").toBe(false);
		expect(h.router.isStroking, "the pen stroke runs on after the palm").toBe(true);
		h.send("pointermove", 330, 315, { id: 77, pointerType: "pen" });
		h.send("pointerup", 340, 320, { id: 77, pointerType: "pen" });
		expect([h.rec.downs, h.rec.ups, h.rec.abandons], "one stroke, ended by its own lift, never abandoned").toEqual([1, 1, 0]);
	});

	it("a non-primary touch never clears: a live two-finger pinch and a third finger that is not primary: nothing is retired", () => {
		const h = pdfRig();
		h.send("pointerdown", 400, 300, { id: 31 });
		h.send("pointerdown", 500, 300, { id: 32, isPrimary: false });
		h.send("pointermove", 380, 300, { id: 31 });
		h.send("pointermove", 520, 300, { id: 32, isPrimary: false });
		expect([h.maps.touchPos.size, h.maps.pinchLive], "premise: two fingers held, the pinch live").toEqual([2, true]);
		h.send("pointerdown", 450, 400, { id: 33, isPrimary: false });
		expect([h.maps.touchPos.has(31), h.maps.touchPos.has(32), h.maps.pinchLive], "both pinch fingers kept, the pinch still live").toEqual([true, true, true]);
	});
});
