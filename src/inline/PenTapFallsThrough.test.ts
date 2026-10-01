/**
 * A PEN TAP THE ROUTER DOES NOT CLAIM IS AN EDITOR CLICK.
 *
 * The router claims a pen contact by cancelling its pointerdown. A contact it
 * returns from without cancelling goes on to the editor as a mouse click: the
 * caret moves and, on a touch-keyboard device, the keyboard comes up. Two of
 * the router's early returns hand a pen contact back that way.
 *
 * Pen off. On purpose: with pen input switched off the tap is a caret
 * placement, and on a touch device the keyboard that comes with it is the
 * feature. That hand-back must stay.
 *
 * A stroke that never ended. The router takes one pen at a time and ignores a
 * pen that lands while a stroke is live. Windows gives the pen the same
 * pointer id on every contact, so when the end of one stroke is lost the next
 * contact arrives with the id of the stroke the router still thinks is live.
 * A pointer cannot be down twice, so that contact proves the old stroke is
 * over; ignoring it hands every later tap to the editor.
 *
 * The rig is the real router on the shared element fake (test/routerHarness.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { installFakeWindow, fakeEl, penEvent } from "../../test/routerHarness";
import { InlinePenRouter, type InlinePenCallbacks } from "./InlinePenRouter";

let uninstall: (() => void) | null = null;
beforeEach(() => { uninstall = installFakeWindow(); });
afterEach(() => { uninstall?.(); uninstall = null; });

/** A pointer event that records whether the router cancelled it. */
function tracked(type: string, t: number, pointerId: number, x = 200, y = 300) {
	const ev = penEvent(type, t, { pointerId, x, y }) as unknown as Record<string, unknown>;
	const seen = { prevented: false };
	ev.preventDefault = () => { seen.prevented = true; };
	return { ev: ev as unknown as PointerEvent, seen };
}

function rig(penOff: () => boolean) {
	const el = fakeEl();
	let downs = 0;
	let ups = 0;
	const cb: InlinePenCallbacks = {
		onPenDown: () => void downs++,
		onPenHover: () => {},
		onPenLeave: () => {},
		onPinch: () => {},
		onPenRaw: () => {},
		onPenMove: () => {},
		onPenUp: () => void ups++,
		penOff,
	};
	const router = new InlinePenRouter(el as unknown as HTMLElement, el as unknown as HTMLElement, cb);
	const fire = (ev: PointerEvent) => {
		const h = el.handlers.get(ev.type);
		if (!h) throw new Error(`router registered no handler for ${ev.type}`);
		h(ev);
	};
	return { router, fire, get downs() { return downs; }, get ups() { return ups; } };
}

describe("a pen tap the router hands back reaches the editor", () => {
	it("pen off: the tap is handed back uncancelled, which the keyboard mode depends on", () => {
		const r = rig(() => true);
		const down = tracked("pointerdown", performance.now(), 7);
		r.fire(down.ev);
		expect(down.seen.prevented, "a pen-off tap was cancelled, so it cannot place the caret").toBe(false);
		expect(r.downs, "a pen-off tap started a stroke").toBe(0);
	});

	it("pen on: an ordinary tap is claimed", () => {
		const r = rig(() => false);
		const down = tracked("pointerdown", performance.now(), 7);
		r.fire(down.ev);
		expect(down.seen.prevented, "an ordinary pen tap was not cancelled").toBe(true);
		expect(r.downs).toBe(1);
	});

	// KNOWN GAP, pinned rather than fixed. No device report has shown a lost
	// stroke end, and the router ends a stroke on pointerup, pointercancel,
	// lostpointercapture, a window-level backstop and blur. If one is ever lost,
	// this is what the next contact does today. A change to that behaviour turns
	// this cell red on purpose: restate it to the new contract.
	it("known gap: after a stroke whose end was lost, the next contact with the same pointer id is ignored and handed to the editor", () => {
		const r = rig(() => false);
		const t = performance.now();
		const first = tracked("pointerdown", t, 7);
		r.fire(first.ev);
		expect(first.seen.prevented, "premise: the first contact was claimed").toBe(true);
		// No pointerup, pointercancel or lostpointercapture: the end is lost.
		const next = tracked("pointerdown", t + 400, 7, 260, 340);
		r.fire(next.ev);
		expect(next.seen.prevented, "the ignored contact is now cancelled: restate this cell").toBe(false);
		expect(r.ups, "the lost stroke is now ended by the next contact: restate this cell").toBe(0);
		expect(r.downs, "the next contact now starts a stroke: restate this cell").toBe(1);
	});
});
