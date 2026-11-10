/**
 * A click or a finger tap into the text lets go of the ink selection, as OneNote does; a finger pan keeps it; the pen
 * behaves as before.
 *
 * Mouse: the editor's mousedown, from a real mouse with mouse ink not armed, empties the ink selection and is not
 * consumed, so the caret lands where it always did. A pen's compatibility mousedown (Chromium sends one after a pen
 * pointerdown) never does. Finger: the router reports a contact that lifted without panning, pinching or drawing
 * (onTapLift), and the mounted overlay empties its selection on that report. A finger pan reports nothing.
 *
 * The mouse cells drive the editor's own dom event handlers (inlineEditorHandlers, the object the editor extension is
 * built from), so dropping either entry there turns them red.
 *
 * The pen tip down outside the selection already dissolves it (InkOverlayPenPath.ts); its cells live in
 * InkOverlayAttachLasso.test.ts and InkOverlayPenPathTransform.test.ts and run beside this file.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { InlinePenRouter } from "./InlinePenRouter";
import { SelectionModel } from "../objects/SelectionModel";
import { setMouseInk } from "./MouseInk";
import { mountOverlay } from "./mountRig.test.util";
import { inlineEditorHandlers } from "./InkOverlay";
import { fakeEl, installFakeWindow, penEvent, recorder } from "../../test/routerHarness";

/** The editor's pointerdown then mousedown, through its own handlers, for a view whose overlay is `o`. */
function click(o: unknown, p: { pointer: PointerEvent; mouse: MouseEvent }): boolean {
	const view = { plugin: () => o } as never;
	inlineEditorHandlers.pointerdown!(p.pointer, view);
	return inlineEditorHandlers.mousedown!(p.mouse, view) === true;
}

type Overlay = {
	selection: SelectionModel;
	router: InlinePenRouter | null;
	camera: { worldToScreen(x: number, y: number): { x: number; y: number } };
	selectionBounds(): { x: number; y: number; width: number; height: number } | null;
};

function press(pointerType: "mouse" | "pen" | "touch", t: number) {
	let prevented = false;
	const pointer = { type: "pointerdown", pointerType, pointerId: 1, button: 0, buttons: 1, timeStamp: t,
		clientX: 50, clientY: 50, preventDefault: () => { prevented = true; } } as unknown as PointerEvent;
	const mouse = { type: "mousedown", button: 0, buttons: 1, timeStamp: t + 1, clientX: 50, clientY: 50,
		preventDefault: () => { prevented = true; } } as unknown as MouseEvent;
	return { pointer, mouse, prevented: () => prevented };
}

// The router needs a window with animation frames; installed before any mount, which keeps an existing window.
let restore: () => void;
beforeAll(() => {
	restore = installFakeWindow();
});
afterAll(() => restore());

describe("a mouse click into the text lets go of the ink selection", () => {
	afterEach(() => setMouseInk(false));

	function selected(path: string) {
		const m = mountOverlay(path);
		const o = m.o as unknown as Overlay;
		o.selection.selectExactly(["s1"]);
		return { m, o };
	}

	it("a mouse mousedown on the editor empties the selection and leaves the event to the editor", () => {
		const { m, o } = selected("click-mouse.md");
		try {
			const p = press("mouse", 100);
			const consumed = click(o, p);
			expect(o.selection.isEmpty, "the selection let go").toBe(true);
			expect(consumed, "not consumed: the caret lands as today").toBe(false);
			expect(p.prevented(), "default not prevented").toBe(false);
		} finally {
			m.destroy();
		}
	});

	it("a pen's compatibility mousedown keeps the selection", () => {
		const { m, o } = selected("click-pen.md");
		try {
			const p = press("pen", 100);
			expect(click(o, p)).toBe(false);
			expect(o.selection.isEmpty, "the pen's own paths decide, not the compatibility event").toBe(false);
			expect(p.prevented()).toBe(false);
		} finally {
			m.destroy();
		}
	});

	it("with mouse ink armed the mouse is a pen, and its mousedown keeps the selection", () => {
		setMouseInk(true);
		const { m, o } = selected("click-armed.md");
		try {
			const p = press("mouse", 100);
			expect(click(o, p)).toBe(false);
			expect(o.selection.isEmpty).toBe(false);
		} finally {
			m.destroy();
		}
	});
});

describe("a finger tap lets go of the ink selection; a finger pan keeps it", () => {
	function routerRig(opts: { easePlaying?: boolean } = {}) {
		const el = Object.assign(fakeEl(), { scrollWidth: 800, clientWidth: 800, scrollHeight: 3600, clientHeight: 600 });
		const record = recorder();
		let taps = 0;
		let easing = opts.easePlaying ?? false;
		const router = new InlinePenRouter(el as unknown as HTMLElement, el as unknown as HTMLElement, {
			...record.cb,
			fingerInk: () => false,
			penOff: () => false,
			onTapLift: () => void taps++,
			// As the overlay does: its onViewportInput cancels the bounce, so the ease reads playing only until then.
			easePlaying: () => easing,
			onViewportInput: () => {
				easing = false;
			},
		} as never, () => 1);
		function touch(type: string, x: number, y: number, t: number): void {
			const ev = penEvent(type, t, { pointerId: 31, pointerType: "touch", x, y, pressure: 0,
				buttons: type === "pointerup" ? 0 : 1 });
			const h = el.handlers.get(type);
			if (!h) throw new Error(`missing handler ${type}`);
			h(ev);
		}
		function pen(type: string, x: number, y: number, t: number): void {
			const ev = penEvent(type, t, { pointerId: 77, pointerType: "pen", x, y,
				pressure: type === "pointerup" ? 0 : 0.5, buttons: type === "pointerup" ? 0 : 1 });
			const h = el.handlers.get(type);
			if (!h) throw new Error(`missing handler ${type}`);
			h(ev);
		}
		return { router, touch, pen, taps: () => taps,
			panned: () => (router as unknown as { gesturePanned: boolean }).gesturePanned };
	}

	it("a finger that lands and lifts without panning reports one tap", () => {
		const r = routerRig();
		r.touch("pointerdown", 400, 300, 10);
		r.touch("pointerup", 400, 300, 90);
		expect(r.taps(), "the tap was reported at the lift").toBe(1);
		r.router.dispose();
	});

	it("CONTROL: a finger panned 40 px reports no tap", () => {
		const r = routerRig();
		r.touch("pointerdown", 400, 300, 10);
		for (let i = 1; i <= 4; i++) r.touch("pointermove", 400, 300 - 10 * i, 10 + 20 * i);
		expect(r.panned(), "premise: the gesture panned").toBe(true);
		r.touch("pointerup", 400, 260, 120);
		expect(r.taps(), "a pan keeps the selection: no tap").toBe(0);
		r.router.dispose();
	});

	it("a finger held still for 600 ms is a press, not a tap", () => {
		const r = routerRig();
		r.touch("pointerdown", 400, 300, 10);
		r.touch("pointerup", 400, 300, 610);
		expect(r.taps()).toBe(0);
		r.router.dispose();
	});

	it("a finger that travels 12 px before it lifts is not a tap", () => {
		const r = routerRig();
		r.touch("pointerdown", 400, 300, 10);
		r.touch("pointermove", 406, 300, 40);
		r.touch("pointermove", 412, 300, 70);
		r.touch("pointerup", 412, 300, 90);
		expect(r.taps()).toBe(0);
		r.router.dispose();
	});

	it("a finger down 300 ms that travels 4 px is a tap", () => {
		const r = routerRig();
		r.touch("pointerdown", 400, 300, 10);
		r.touch("pointermove", 402, 300, 150);
		r.touch("pointerup", 404, 300, 310);
		expect(r.taps()).toBe(1);
		r.router.dispose();
	});

	it("the bounds are the router's own tap (8 px, 500 ms): 450 ms and 6 px is a tap, 9 px is not", () => {
		const r = routerRig();
		r.touch("pointerdown", 400, 300, 10);
		r.touch("pointerup", 406, 300, 460);
		expect(r.taps(), "450 ms, 6 px").toBe(1);
		r.touch("pointerdown", 400, 300, 1000);
		r.touch("pointerup", 409, 300, 1050);
		expect(r.taps(), "9 px is past the router's 8").toBe(1);
		r.router.dispose();
	});

	it("a finger that lands on a gliding page catches the glide, and its lift is no tap", () => {
		const r = routerRig();
		const nav = r.router as unknown as { flingRaf: number };
		nav.flingRaf = 4242;
		r.touch("pointerdown", 400, 300, 10);
		expect(nav.flingRaf, "the landing stopped the glide").toBe(0);
		r.touch("pointerup", 400, 300, 90);
		expect(r.taps(), "catching a glide is scrolling: the selection stays").toBe(0);
		r.router.dispose();
	});

	it("a finger that lands while the page eases back catches the ease, and its lift is no tap", () => {
		const r = routerRig({ easePlaying: true });
		r.touch("pointerdown", 400, 300, 10);
		r.touch("pointerup", 400, 300, 90);
		expect(r.taps()).toBe(0);
		r.router.dispose();
	});

	it("CONTROL: with no glide and no ease, the same contact is a tap", () => {
		const r = routerRig({ easePlaying: false });
		r.touch("pointerdown", 400, 300, 10);
		r.touch("pointerup", 400, 300, 90);
		expect(r.taps()).toBe(1);
		r.router.dispose();
	});

	it("the mounted overlay says its ease is playing while the page bounces back", () => {
		const m = mountOverlay("ease-playing.md");
		try {
			const o = m.o as unknown as { bounceState: unknown; router: { cb: { easePlaying?: () => boolean } } };
			const cb = o.router.cb;
			expect(cb.easePlaying?.(), "at rest").toBe(false);
			o.bounceState = { raf: 7 };
			expect(cb.easePlaying?.(), "a bounce frame is queued").toBe(true);
			o.bounceState = null;
		} finally {
			m.destroy();
		}
	});

	it("CONTROL: a pen tip down and up reports no tap", () => {
		const r = routerRig();
		r.pen("pointerdown", 400, 300, 10);
		r.pen("pointerup", 400, 300, 90);
		expect(r.taps()).toBe(0);
		r.router.dispose();
	});

	/** A mounted overlay with one selection whose box is world (100, 100) to (200, 150), and its router's tap callback. */
	function tapRig(path: string) {
		const m = mountOverlay(path);
		const o = m.o as unknown as Overlay;
		o.selection.selectExactly(["s1"]);
		o.selectionBounds = () => ({ x: 100, y: 100, width: 100, height: 50 });
		expect(o.router, "premise: the mount made the real router").not.toBeNull();
		const cb = (o.router as unknown as { cb: { onTapLift?: (s: unknown, e: unknown) => void } }).cb;
		const tapAt = (wx: number, wy: number) => {
			const p = o.camera.worldToScreen(wx, wy);
			cb.onTapLift?.({ x: p.x, y: p.y, pressure: 0, timestamp: 0, tiltX: 0, tiltY: 0 }, {});
		};
		return { m, o, tapAt };
	}

	it("the mounted overlay lets go of its selection when its router reports a tap off the selection", () => {
		const { m, o, tapAt } = tapRig("tap-off.md");
		try {
			tapAt(600, 600);
			expect(o.selection.isEmpty, "the tap let go of the selection").toBe(true);
		} finally {
			m.destroy();
		}
	});

	it("a tap on the selected ink keeps the selection", () => {
		const { m, o, tapAt } = tapRig("tap-on.md");
		try {
			tapAt(150, 125);
			expect(o.selection.isEmpty, "a tap on the selection keeps it").toBe(false);
		} finally {
			m.destroy();
		}
	});
});
