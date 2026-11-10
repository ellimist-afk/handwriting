import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	fakeEl,
	fedTimestamps,
	installFakeWindow,
	penEvent,
	recorder,
	winHandlers,
} from "../../test/routerHarness";
import { InlinePenRouter } from "./InlinePenRouter";

let uninstallWindow: () => void = () => {};
beforeAll(() => {
	uninstallWindow = installFakeWindow();
});
afterAll(() => uninstallWindow());

function touch(type: string, ts: number, pointerId: number, x: number, y: number, pressure = 0, isPrimary = true) {
	return penEvent(type, ts, {
		pointerType: "touch",
		pointerId,
		isPrimary,
		x,
		y,
		pressure: type === "pointerup" || type === "pointercancel" ? 0 : pressure,
		buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1,
	});
}

function rig(enabled = true) {
	const el = fakeEl();
	const rec = recorder();
	const downPressures: number[] = [];
	let cancellations = 0;
	const pinches: string[] = [];
	const router = new InlinePenRouter(
		el as unknown as HTMLElement,
		el as unknown as HTMLElement,
		{
			...rec.cb,
			onPenDown: (sample, ev) => {
				downPressures.push(sample.pressure);
				rec.cb.onPenDown(sample, ev);
			},
			fingerInk: () => enabled,
			onFingerInkCancelled: () => void cancellations++,
			onPinch: (phase) => void pinches.push(phase),
		}
	);
	const fire = (ev: PointerEvent) => {
		const handler = el.handlers.get(ev.type);
		// No raw listener, no raw event: a browser sends none (the router binds raw per stroke).
		if (!handler && ev.type === "pointerrawupdate") return;
		if (!handler) throw new Error(`missing ${ev.type} handler`);
		handler(ev);
	};
	return {
		el,
		rec,
		router,
		fire,
		pinches,
		downPressures,
		get cancellations() {
			return cancellations;
		},
	};
}

describe("ordinary-note iPhone finger routing", () => {
	it("leaves touch native when the surface did not opt in", () => {
		const h = rig(false);
		h.fire(touch("pointerdown", 100, 1, 30, 40));
		h.fire(touch("pointermove", 108, 1, 40, 50));
		h.fire(touch("pointerup", 116, 1, 40, 50));
		expect(h.rec.downs).toBe(0);
		expect(h.rec.rawCalls).toHaveLength(0);
		expect(h.rec.ups).toBe(0);
	});

	it("leaves touch native when the callback is absent, as it is on PDF", () => {
		const el = fakeEl();
		const rec = recorder();
		new InlinePenRouter(el as unknown as HTMLElement, el as unknown as HTMLElement, rec.cb);
		const down = touch("pointerdown", 100, 1, 30, 40);
		let prevented = false;
		(down as unknown as { preventDefault(): void }).preventDefault = () => void (prevented = true);
		el.handlers.get("pointerdown")!(down);
		expect(rec.downs).toBe(0);
		expect(prevented).toBe(false);
	});

	it("feeds the first finger through the WebKit move pipeline and commits once", () => {
		const h = rig();
		h.fire(touch("pointerdown", 100, 1, 30, 40));
		h.fire(
			penEvent("pointermove", 108, {
				pointerType: "touch",
				pointerId: 1,
				pressure: 0,
				buttons: 1,
				coalescedSamples: [
					{ t: 104, x: 35, y: 45, pressure: 0 },
					{ t: 108, x: 40, y: 50, pressure: 0 },
				],
			})
		);
		h.fire(touch("pointerup", 116, 1, 40, 50));
		expect(h.rec.downs).toBe(1);
		expect(fedTimestamps(h.rec.rawCalls)).toEqual([104, 108]);
		expect(h.rec.rawCalls.flat().map((sample) => sample.pressure)).toEqual([0.5, 0.5]);
		expect(h.rec.ups).toBe(1);
		expect(h.router.isStroking).toBe(false);
	});

	it("uses fixed pressure for positive touch pressure on down, move and raw", () => {
		const h = rig();
		h.fire(touch("pointerdown", 100, 1, 30, 40, 0.2));
		h.fire(
			penEvent("pointermove", 108, {
				pointerType: "touch",
				pointerId: 1,
				pressure: 0.8,
				buttons: 1,
			})
		);
		h.fire(
			penEvent("pointerrawupdate", 112, {
				pointerType: "touch",
				pointerId: 1,
				pressure: 0.9,
				buttons: 1,
			})
		);
		h.fire(touch("pointerup", 120, 1, 30, 40));

		expect(h.downPressures).toEqual([0.5]);
		expect(h.rec.rawCalls.flat().map((sample) => sample.pressure)).toEqual([0.5, 0.5]);
		expect(h.rec.ups).toBe(1);
	});

	it("deduplicates a raw batch that overlaps a move-fed finger batch", () => {
		const h = rig();
		h.fire(touch("pointerdown", 100, 1, 30, 40));
		h.fire(
			penEvent("pointermove", 108, {
				pointerType: "touch",
				pointerId: 1,
				pressure: 0,
				buttons: 1,
				coalesced: [104, 108],
			})
		);
		h.fire(
			penEvent("pointerrawupdate", 112, {
				pointerType: "touch",
				pointerId: 1,
				pressure: 0,
				buttons: 1,
				coalesced: [104, 108, 112],
			})
		);
		expect(fedTimestamps(h.rec.rawCalls)).toEqual([104, 108, 112]);
	});

	it("keeps a finger move-fed after a real pen proved the raw channel", () => {
		const h = rig();
		// Session-level pen raw capability must not silence an iPhone's later
		// direct-touch stream, which WebKit may deliver only through moves.
		h.fire(penEvent("pointerrawupdate", 80, { pointerId: 9, buttons: 0, pressure: 0 }));
		h.fire(touch("pointerdown", 100, 1, 30, 40));
		h.fire(touch("pointermove", 108, 1, 40, 50));
		h.fire(touch("pointerup", 116, 1, 40, 50));

		expect(fedTimestamps(h.rec.rawCalls)).toEqual([108]);
		expect(h.rec.ups).toBe(1);
	});

	it("owns the parallel touch stream through drawing and pinch takeover", () => {
		const h = rig();
		const stream = (type: string) => {
			let prevented = false;
			const ev = {
				type,
				target: h.el,
				changedTouches: [{ identifier: 1, touchType: "direct" }],
				preventDefault: () => void (prevented = true),
				stopPropagation: () => {},
			} as unknown as Event;
			const handler = winHandlers.get(type);
			if (!handler) throw new Error(`missing ${type} touch-stream handler`);
			handler(ev);
			return prevented;
		};

		h.fire(touch("pointerdown", 100, 1, 30, 40));
		expect(stream("touchstart")).toBe(true);
		h.fire(touch("pointerdown", 108, 2, 130, 40));
		expect(stream("touchmove")).toBe(true);
		expect(h.cancellations).toBe(1);
	});

	it("cancels provisional ink for a second finger, then stays in pinch until all lift", () => {
		const h = rig();
		h.fire(touch("pointerdown", 100, 1, 30, 40));
		h.fire(touch("pointermove", 108, 1, 40, 40));
		// A second concurrent touch is never the primary pointer (Pointer Events).
		h.fire(touch("pointerdown", 112, 2, 130, 40, 0, false));
		expect(h.cancellations).toBe(1);
		expect(h.rec.ups).toBe(0);
		expect(h.router.isStroking).toBe(false);
		const fedBeforeLateRaw = fedTimestamps(h.rec.rawCalls);
		h.fire(
			penEvent("pointerrawupdate", 116, {
				pointerType: "touch",
				pointerId: 1,
				buttons: 1,
				coalesced: [112, 116],
			})
		);
		expect(fedTimestamps(h.rec.rawCalls)).toEqual(fedBeforeLateRaw);
		const third = touch("pointerdown", 118, 3, 210, 40, 0, false);
		let thirdPrevented = false;
		(third as unknown as { preventDefault(): void }).preventDefault = () =>
			void (thirdPrevented = true);
		h.fire(third);
		expect(thirdPrevented).toBe(true);
		expect(h.rec.downs).toBe(1);
		h.fire(touch("pointerup", 119, 3, 210, 40));

		h.fire(touch("pointermove", 120, 2, 170, 40));
		expect(h.pinches).toContain("start");
		expect(h.pinches).toContain("move");
		h.fire(touch("pointerup", 128, 2, 170, 40));
		expect(h.pinches).toContain("end");
		h.fire(touch("pointermove", 132, 1, 55, 40));
		expect(h.rec.downs).toBe(1);
		expect(h.rec.ups).toBe(0);

		// A replacement contact joins the still-resting first finger; it may
		// pinch again, but it must never resurrect the cancelled stroke.
		h.fire(touch("pointerdown", 136, 4, 150, 40, 0, false));
		h.fire(touch("pointermove", 144, 4, 190, 40));
		expect(h.rec.downs).toBe(1);
		h.fire(touch("pointerup", 152, 4, 190, 40));
		h.fire(touch("pointerup", 160, 1, 40, 40));

		// A wholly new gesture can draw again.
		h.fire(touch("pointerdown", 200, 5, 50, 60));
		h.fire(touch("pointerup", 208, 5, 50, 60));
		expect(h.rec.downs).toBe(2);
		expect(h.rec.ups).toBe(1);
	});

	it("balances pointercancel and blur exactly once", () => {
		const cancelled = rig();
		cancelled.fire(touch("pointerdown", 100, 1, 30, 40));
		cancelled.fire(touch("pointercancel", 108, 1, 40, 50));
		cancelled.fire(touch("pointerup", 116, 1, 40, 50));
		expect(cancelled.rec.ups).toBe(1);

		const blurred = rig();
		blurred.fire(touch("pointerdown", 200, 2, 30, 40));
		const blur = winHandlers.get("blur");
		if (!blur) throw new Error("missing blur handler");
		blur({ type: "blur" } as Event);
		blurred.fire(touch("pointerup", 216, 2, 40, 50));
		expect(blurred.rec.ups).toBe(1);
	});

	it("commits received finger ink before giving a real pen the surface", () => {
		const h = rig();
		h.fire(touch("pointerdown", 100, 1, 30, 40));
		h.fire(touch("pointermove", 104, 1, 40, 50));
		h.fire(penEvent("pointerdown", 108, { pointerId: 9, x: 80, y: 90 }));
		expect(h.cancellations).toBe(0);
		expect(h.rec.downs).toBe(2);
		expect(h.rec.ups).toBe(1);
		expect(h.router.isStroking).toBe(true);
		h.fire(penEvent("pointerup", 116, { pointerId: 9, x: 90, y: 100, pressure: 0, buttons: 0 }));
		expect(h.rec.ups).toBe(2);
		h.fire(touch("pointerup", 120, 1, 40, 50));
		expect(h.rec.ups).toBe(2);
	});

	it("a capture loss whose target is the scroller itself ends a finger stroke before any lift", () => {
		const h = rig();
		h.fire(touch("pointerdown", 100, 1, 30, 40));
		h.fire(touch("pointermove", 104, 1, 40, 50));
		expect(h.router.isStroking).toBe(true);
		const loss = touch("lostpointercapture", 108, 1, 40, 50) as unknown as Record<string, unknown>;
		loss.target = h.el;
		h.fire(loss as unknown as PointerEvent);
		expect(h.rec.ups, "the scroller's own loss ends the stroke").toBe(1);
		expect(h.router.isStroking, "no stroke left for the lift").toBe(false);
		h.fire(touch("pointerup", 116, 1, 40, 50));
		expect(h.rec.ups, "the lift finds no stroke to end again").toBe(1);
	});

	it("balances lost capture and an outside-window lift exactly once", () => {
		const lost = rig();
		lost.fire(touch("pointerdown", 100, 1, 30, 40));
		lost.fire(touch("lostpointercapture", 108, 1, 40, 50));
		lost.fire(touch("pointerup", 116, 1, 40, 50));
		expect(lost.rec.ups).toBe(1);
		lost.fire(touch("pointerdown", 120, 2, 50, 60));
		lost.fire(touch("pointerup", 128, 2, 50, 60));
		expect(lost.rec.downs).toBe(2);
		expect(lost.rec.ups).toBe(2);

		const outside = rig();
		outside.fire(touch("pointerdown", 200, 2, 30, 40));
		const end = winHandlers.get("pointerup");
		if (!end) throw new Error("missing pointerup backstop");
		const foreign = touch("pointerup", 204, 99, 35, 45);
		let foreignPrevented = false;
		let foreignStopped = false;
		(foreign as unknown as { composedPath: () => EventTarget[] }).composedPath = () => [];
		(foreign as unknown as { preventDefault: () => void }).preventDefault = () =>
			void (foreignPrevented = true);
		(foreign as unknown as { stopPropagation: () => void }).stopPropagation = () =>
			void (foreignStopped = true);
		end(foreign);
		expect(foreignPrevented).toBe(false);
		expect(foreignStopped).toBe(false);
		expect(outside.router.isStroking).toBe(true);
		expect(outside.rec.ups).toBe(0);

		const ev = touch("pointerup", 208, 2, 40, 50);
		let ownedPrevented = false;
		let ownedStopped = false;
		(ev as unknown as { composedPath: () => EventTarget[] }).composedPath = () => [];
		(ev as unknown as { preventDefault: () => void }).preventDefault = () =>
			void (ownedPrevented = true);
		(ev as unknown as { stopPropagation: () => void }).stopPropagation = () =>
			void (ownedStopped = true);
		end(ev);
		expect(ownedPrevented).toBe(true);
		expect(ownedStopped).toBe(true);
		outside.fire(ev);
		expect(outside.rec.ups).toBe(1);
		outside.fire(touch("pointerdown", 216, 3, 50, 60));
		outside.fire(touch("pointerup", 224, 3, 50, 60));
		expect(outside.rec.downs).toBe(2);
		expect(outside.rec.ups).toBe(2);
	});
});
