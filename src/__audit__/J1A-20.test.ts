import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { InlinePenRouter } from "../inline/InlinePenRouter";
import { fakeEl, installFakeWindow, rafCallbacks, recorder } from "../../test/routerHarness";

let clock = 1000;
let undoWindow: () => void;
const routers: InlinePenRouter[] = [];

const IPAD = { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", platform: "MacIntel", maxTouchPoints: 5 };
const WINDOWS = { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", platform: "Win32", maxTouchPoints: 10 };

beforeAll(() => {
	undoWindow = installFakeWindow();
});
afterAll(() => undoWindow());
beforeEach(() => {
	clock = 1000;
	rafCallbacks.clear();
	vi.spyOn(performance, "now").mockImplementation(() => clock);
});
afterEach(() => {
	for (const r of routers.splice(0)) r.dispose();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function ptr(type: string, pointerId: number, x: number, y: number, buttons: number, pointerType = "touch", size = 0): PointerEvent {
	return {
		type, pointerType, pointerId, isPrimary: true, clientX: x, clientY: y,
		pressure: buttons === 0 ? 0 : 0.5, buttons, button: 0, timeStamp: clock,
		tiltX: 0, tiltY: 0, width: size, height: size,
		preventDefault: () => {}, stopPropagation: () => {},
	} as unknown as PointerEvent;
}

function rig() {
	const el = fakeEl() as ReturnType<typeof fakeEl> & Record<string, unknown>;
	let top = 0;
	Object.defineProperty(el, "scrollLeft", { configurable: true, get: () => 0, set: () => {} });
	Object.defineProperty(el, "scrollTop", { configurable: true, get: () => top, set: (v: number) => void (top = Math.max(0, v)) });
	Object.assign(el, { clientWidth: 900, clientHeight: 700, scrollWidth: 900, scrollHeight: 100_000 });
	const router = new InlinePenRouter(el as unknown as HTMLElement, el as unknown as HTMLElement, recorder().cb, () => 1);
	routers.push(router);
	const fire = (ev: PointerEvent) => {
		const h = el.handlers.get(ev.type);
		if (!h) throw new Error(`no handler for ${ev.type}`);
		h(ev);
	};
	return { el, fire };
}

/** Pencil hovering beside the page, then a fast 60 px upward finger swipe of contact size `size`. */
function swipeNearHoveringPencil(size: number): number {
	const r = rig();
	r.el.scrollTop = 5000;
	r.fire(ptr("pointermove", 9, 800, 300, 0, "pen"));
	clock += 10;
	r.fire(ptr("pointerdown", 5, 400, 400, 1, "touch", size));
	for (let i = 1; i <= 6; i++) {
		clock += 16;
		r.fire(ptr("pointermove", 5, 400, 400 - 10 * i, 1, "touch", size));
	}
	return (r.el.scrollTop as number) - 5000;
}

describe("J1A-20 palm parole for an iPad fingertip near a hovering Pencil", () => {
	it("control: a size-less contact (width 0) earns parole and scrolls", () => {
		vi.stubGlobal("navigator", IPAD);
		expect(swipeNearHoveringPencil(0)).toBeGreaterThan(30);
	});

	it("control: on Windows a 70 px contact is palm-sized and stays swallowed", () => {
		vi.stubGlobal("navigator", WINDOWS);
		expect(swipeNearHoveringPencil(70)).toBe(0);
	});

	it("iPad: a 70 px fingertip (iOS width = 2x radius) swiping near the Pencil scrolls the page", () => {
		vi.stubGlobal("navigator", IPAD);
		const scrolled = swipeNearHoveringPencil(70);
		expect(scrolled, "the iPad fingertip swipe was swallowed as a palm: the page did not scroll").toBeGreaterThan(30);
	});
});
