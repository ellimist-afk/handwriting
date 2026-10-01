/**
 * ONE FINGER AFTER A LOST CONTACT MUST NOT ZOOM.
 *
 * THE SYMPTOM. On an iPad: long-press to select text, lift, then put one
 * finger down and move it. The note zooms. One physical contact, a pinch on
 * screen.
 *
 * THE MECHANISM. The router tracks contacts in `touchPos`, keyed by pointer
 * id, and retires them one at a time from the pointer stream (pointerup,
 * pointercancel). When the selection UI or the OS swallows a contact the
 * pointerup for it never arrives, so its entry stays. The browser still says
 * every finger is up - `touchend` with `touches.length === 0` - but nothing
 * reads that statement, and pointer ids are never reconciled with Touch
 * identifiers. The next single finger makes `touchPos.size` 2, which is the
 * pinch trigger (InlinePenRouter.ts, the second-contact branch), so a solitary
 * finger drives a two-finger gesture.
 *
 * THE FIX. In the native touchend/touchcancel branch, after the liveTouchIds
 * bookkeeping: when the browser reports no touches left and `touchPos` still
 * holds entries, retire them all. `te.touches` is the browser's own statement.
 * A document switch or a capture transfer with fingers still down reports
 * `touches.length > 0` and is untouched by this.
 *
 * THE RIG. The real router on the shared element fake (test/routerHarness.ts),
 * driving BOTH streams the way the device does: pointer events on the element
 * and native touch events on the window. Ported from the iPad selection diagnosis probe
 * (2026-09-18), whose eight stale variants each reported ratio 1.5 on the next single
 * finger.
 *
 * WHAT MUST MOVE AND WHAT MUST NOT. Moving: the eight stale variants (four
 * ways of losing the contact x pen off and on) go from a 1.5 pinch to no
 * pinch at all. Not moving: a clean single finger stays silent, a real
 * two-finger pinch still reports 1.5, and the two retirements that already
 * work - a delivered pointerup and a delivered pointercancel - stay silent.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { InlinePenRouter } from "./InlinePenRouter";
import { resetPenToolsForTest } from "./PenToolsMode";
import { fakeEl, installFakeWindow, penEvent, recorder, winHandlers } from "../../test/routerHarness";

interface Pinch {
	phase: string;
	ratio: number;
}

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

function rig(penOff: boolean) {
	resetPenToolsForTest();
	const el = fakeEl();
	Object.assign(el, { scrollWidth: 2000, clientWidth: 800, scrollHeight: 2000, clientHeight: 600 });
	const record = recorder();
	const pinches: Pinch[] = [];
	el.setPointerCapture = () => {};
	const router = new InlinePenRouter(
		el as unknown as HTMLElement,
		el as unknown as HTMLElement,
		{
			...record.cb,
			fingerInk: () => false,
			penOff: () => penOff,
			onPinch: (phase: string, ratio: number) => pinches.push({ phase, ratio }),
		} as never,
		() => 1,
	);
	routers.push(router);

	/** One pointer event on the element, the stream the router reads positions from. */
	function pointer(type: string, id: number, x: number, primary = true): void {
		const ev = penEvent(type, type === "pointerdown" ? 10 : 700, {
			pointerId: id,
			pointerType: "touch",
			x,
			y: 100,
			isPrimary: primary,
			pressure: 0,
			buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1,
		});
		const handler = el.handlers.get(type);
		if (!handler) throw new Error(`missing handler ${type}`);
		handler(ev);
	}

	/** One native touch event on the window. `live` is what the browser still has down. */
	function nativeTouch(type: string, id: number, live: number[]): void {
		const handler = winHandlers.get(type);
		if (!handler) throw new Error(`missing window handler ${type}`);
		handler({
			type,
			target: el,
			changedTouches: [{ identifier: id, touchType: "direct", radiusX: 4, radiusY: 4 }],
			touches: live.map(identifier => ({ identifier, touchType: "direct" })),
			preventDefault() {},
			stopPropagation() {},
		} as unknown as Event);
	}

	const zoomed = (): boolean => pinches.some(p => p.phase === "move" && p.ratio !== 1);
	const ratios = (): number[] => pinches.filter(p => p.phase === "move").map(p => p.ratio);
	const trackedContacts = (): number => (router as unknown as { touchPos: Map<number, unknown> }).touchPos.size;

	return { el, router, pointer, nativeTouch, zoomed, ratios, trackedContacts };
}

/** The four ways the diagnosis saw a contact go without its pointerup. */
const STALE_RETIREMENTS = [
	"native-touchend-only",
	"native-touchcancel-only",
	"lostpointercapture",
	"blur",
] as const;

/** The two that already retire the contact properly. */
const CLEAN_RETIREMENTS = ["pointerup", "pointercancel"] as const;

function retire(h: ReturnType<typeof rig>, how: string): void {
	if (how === "pointerup" || how === "pointercancel") h.pointer(how, 1, 100);
	if (how === "lostpointercapture") h.pointer("lostpointercapture", 1, 100);
	if (how === "blur") {
		const blur = winHandlers.get("blur");
		if (!blur) throw new Error("missing blur handler");
		blur({ type: "blur" } as Event);
	}
	h.nativeTouch(how === "native-touchcancel-only" ? "touchcancel" : "touchend", 501, []);
}

/** First contact down, retired the named way, then one new single finger that moves. */
function oneFingerAfter(how: string, penOff: boolean): ReturnType<typeof rig> {
	const h = rig(penOff);
	h.pointer("pointerdown", 1, 100);
	h.nativeTouch("touchstart", 501, [501]);
	retire(h, how);
	h.pointer("pointerdown", 2, 200, true);
	h.nativeTouch("touchstart", 502, [502]);
	h.pointer("pointermove", 2, 250, true);
	return h;
}

describe("a single finger after a contact the pointer stream never retired", () => {
	for (const penOff of [false, true]) {
		for (const how of STALE_RETIREMENTS) {
			it(`does not zoom after ${how}; penOff=${penOff}`, () => {
				const h = oneFingerAfter(how, penOff);
				expect(h.ratios()).toEqual([]);
				expect(h.zoomed()).toBe(false);
			});
		}

		it(`leaves no contact behind when the browser says none are down; penOff=${penOff}`, () => {
			const h = rig(penOff);
			h.pointer("pointerdown", 1, 100);
			h.nativeTouch("touchstart", 501, [501]);
			h.nativeTouch("touchend", 501, []);
			expect(h.trackedContacts()).toBe(0);
		});
	}
});

describe("controls: green before the fix and after it", () => {
	for (const penOff of [false, true]) {
		it(`a clean single finger never pinches; penOff=${penOff}`, () => {
			const h = rig(penOff);
			h.pointer("pointerdown", 1, 100);
			h.nativeTouch("touchstart", 501, [501]);
			h.pointer("pointermove", 1, 150);
			expect(h.ratios()).toEqual([]);
		});

		it(`a real two-finger pinch still reports 1.5; penOff=${penOff}`, () => {
			const h = rig(penOff);
			h.pointer("pointerdown", 1, 100);
			h.nativeTouch("touchstart", 501, [501]);
			h.pointer("pointerdown", 2, 200, false);
			h.nativeTouch("touchstart", 502, [501, 502]);
			h.pointer("pointermove", 2, 250, false);
			expect(h.ratios()).toContain(1.5);
		});

		for (const how of CLEAN_RETIREMENTS) {
			it(`a contact retired by ${how} already left nothing to pinch with; penOff=${penOff}`, () => {
				const h = oneFingerAfter(how, penOff);
				expect(h.ratios()).toEqual([]);
			});
		}
	}

	it("a touchend with a finger still down retires nothing", () => {
		const h = rig(false);
		h.pointer("pointerdown", 1, 100);
		h.nativeTouch("touchstart", 501, [501]);
		h.pointer("pointerdown", 2, 200, false);
		h.nativeTouch("touchstart", 502, [501, 502]);
		h.nativeTouch("touchend", 502, [501]);
		expect(h.trackedContacts()).toBe(2);
	});
});
