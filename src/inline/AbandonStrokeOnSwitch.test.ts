/**
 * The note-switch pen-click bug (Orion, 2026-09).
 *
 * Strip buttons act on a DOM `click`. `armOwnership()` installs a
 * window-capture listener for `click` (among other mouse-like events) that
 * `suppressNativeFallout()` eats unconditionally while a stroke is active,
 * and for a tail after it ends. `InkOverlayPlugin.update()`'s file-path-change
 * branch calls `resetGestureState()`, which resets the overlay's own drawing
 * state but never touched the router - so a stroke whose pointerup was lost
 * across the switch (a finger resting through it, landing on a note the
 * router never saw a pointerdown for) left `activePenId` set forever, which
 * kept the click suppressor armed forever, which ate every future pen tap on
 * the toolbar strip.
 *
 * `InlinePenRouter.abandonActiveStroke()` is the fix: called from
 * `InkOverlayPlugin.update()` beside `resetGestureState()` on a path change,
 * it ends any in-flight stroke and stands the suppressor down immediately.
 * This file drives the real router (same harness TraceReplay.test.ts and
 * InkFeedRouting.test.ts use) and proves the two halves of that: no stroke
 * left active, and a mouse click delivered afterward is no longer eaten.
 *
 * The SAME abandoned-stroke shape had a second half this router-only fix
 * never touched (Orion, 2026-09, second report): `InkOverlay.penDown` calls
 * `stripPenDown` -> `MobileTools.setInking(true)` on the strip AND the
 * collapsed pill (styles.css `.is-inking`: opacity 0, visibility hidden - not
 * merely invisible but unhit-testable) the instant a claimed pen gesture
 * starts, and only a normal pointerup's `cb.onPenUp` -> `InkOverlay.penUp` ->
 * `stripPenUp` -> `setInking(false)` puts it back. `abandonActiveStroke()`
 * ends the stroke without a PointerEvent to hand `cb.onPenUp`, so it never
 * called that path - a mid-stroke switch left the NEW note's strip and pill
 * wearing `is-inking` forever, and every pen tap on the toolbar died with no
 * claim, no suppression, and nothing to hit-test. `abandonActiveStroke()` now
 * returns whether it actually tore down a live stroke, so
 * `InkOverlayPlugin.update()` can call `stripPenUp` itself exactly then - see
 * the return-value tests below. (MobileTools/StripPenChrome own no test
 * harness that renders real CSS, so what is pinned here is the router's
 * contract; `setInking`'s own visibility behaviour is exercised by hand
 * against `styles.css` in the diagnosis, not re-asserted in JS.)
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { InlinePenRouter } from "./InlinePenRouter";
import { harness, installFakeWindow, penEvent } from "../../test/routerHarness";

let uninstallWindow: () => void = () => {};
beforeAll(() => {
	uninstallWindow = installFakeWindow();
});
afterAll(() => {
	uninstallWindow();
});

/** Mirrors `OWNERSHIP_TAIL_MS` in InlinePenRouter.ts, which does not export it. */
const TAIL_MS = 350;

/**
 * Every field `abandonActiveStroke()` can touch, so a "no-op" claim is checked
 * rather than asserted. Hoisted to module scope from the no-op block below,
 * because the tail-expiry block further down needs the same witness: "the tail
 * is over" and "nothing was live" are the same claim read two ways, and two
 * hand-kept field lists would drift apart exactly where the drift matters.
 */
const snapshot = (r: InlinePenRouter) => {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const p = r as any;
	return {
		activePenId: p.activePenId,
		guardApplied: p.guardApplied,
		savedTouchAction: p.savedTouchAction,
		savedTouchActionKnown: p.savedTouchActionKnown,
		ownershipFn: p.ownershipFn,
		ownershipDisarmTimer: p.ownershipDisarmTimer,
		ownershipTailUntil: p.ownershipTailUntil,
		rearmTimer: p.rearmTimer,
		flingRaf: p.flingRaf,
		gesturePanned: p.gesturePanned,
		touchesAtStrokeStart: new Map(p.touchesAtStrokeStart),
		touchPos: new Map(p.touchPos),
		liveTouchIds: new Set(p.liveTouchIds),
		guardTouches: new Set(p.guardTouches),
	};
};

/** A synthetic mouse click, the shape the strip's own button listener sees. */
function clickEvent() {
	let prevented = false;
	let stopped = false;
	const ev = {
		type: "click",
		pointerType: undefined,
		preventDefault: () => void (prevented = true),
		stopPropagation: () => void (stopped = true),
	};
	return {
		ev: ev as unknown as PointerEvent,
		get suppressed() {
			return prevented || stopped;
		},
	};
}

describe("InlinePenRouter.abandonActiveStroke", () => {
	it("a stroke stranded mid-note-switch is left active without it (baseline)", () => {
		const h = harness();
		h.fire(penEvent("pointerdown", 100));
		expect(h.router.isStroking).toBe(true);

		// The pointerup that should have ended this stroke never arrives -
		// exactly what a finger resting through a note switch looks like to
		// the router, which never gets a pointerdown on the new surface for
		// a contact that was already down.
		const click = clickEvent();
		h.fireWin(click.ev);
		expect(click.suppressed).toBe(true); // the bug: strip taps still eaten
		expect(h.router.isStroking).toBe(true);
	});

	it("clears the active stroke and stands the click suppressor down", () => {
		const h = harness();
		h.fire(penEvent("pointerdown", 100));
		expect(h.router.isStroking).toBe(true);

		h.router.abandonActiveStroke();
		expect(h.router.isStroking).toBe(false);

		const click = clickEvent();
		h.fireWin(click.ev);
		expect(click.suppressed).toBe(false);
	});

	it("also stands down the post-stroke tail, not just an active stroke", () => {
		const h = harness();
		h.fire(penEvent("pointerdown", 100));
		h.fire(penEvent("pointerup", 110, { pressure: 0, buttons: 0 }));
		expect(h.router.isStroking).toBe(false); // stroke ended, but the tail is up

		const duringTail = clickEvent();
		h.fireWin(duringTail.ev);
		expect(duringTail.suppressed).toBe(true); // still in OWNERSHIP_TAIL_MS

		h.router.abandonActiveStroke();

		const afterAbandon = clickEvent();
		h.fireWin(afterAbandon.ev);
		expect(afterAbandon.suppressed).toBe(false);
	});

	it("is idempotent with no active stroke (blur/switch with no pen down)", () => {
		const h = harness();
		expect(() => h.router.abandonActiveStroke()).not.toThrow();
		expect(h.router.isStroking).toBe(false);
	});
});

describe("InlinePenRouter.abandonActiveStroke is a true no-op with nothing live", () => {
	/**
	 * A fresh router (a note's very first `update()`, or a blur that lands
	 * before any pen ever touched down) has no stroke, no armed guard, no
	 * armed ownership, no pending tail timer, and no touch bookkeeping to
	 * abandon. `abandonActiveStroke()` must change NOTHING in that state -
	 * every field it can touch, snapshotted before and after, byte-for-byte.
	 * This is what pins the fix for the lit-nib regression: the guard/
	 * ownership teardown this method runs for a real abandon must not fire
	 * on a router that never armed anything, because that teardown is what a
	 * fresh note's `update()` (and now blur too) was calling unconditionally.
	 */
	it("leaves guard style, ownership, and touch bookkeeping byte-for-byte unchanged", () => {
		const h = harness();
		const before = snapshot(h.router);

		h.router.abandonActiveStroke();

		expect(snapshot(h.router)).toEqual(before);
		expect(h.router.isStroking).toBe(false);
	});

	it("also does nothing on the window-blur path with no pen ever down", () => {
		const h = harness();
		const before = snapshot(h.router);

		h.fireWin({ type: "blur" } as unknown as PointerEvent);

		expect(snapshot(h.router)).toEqual(before);
		// And it tells the surface nothing either: a blur that abandoned no
		// stroke has no strip chrome to stand down, and firing the callback
		// anyway would cost every alt-tab a needless refresh() (and, on the
		// pdf, a setInking(false) on a strip that was never set).
		expect(h.rec.abandons).toBe(0);
	});
});

describe("window blur COMMITS an in-flight stroke (the 1.4.10 ruling)", () => {
	/**
	 * Owner's ruling, 2026-09-04: "alt tab mid stroke - sure make it
	 * consistent". `dcf0254` and its D2 follow-up made a blur an ABANDON: the
	 * handler ran `abandonActiveStroke()` and, once the boolean was read,
	 * `onStrokeAbandoned` stood the chrome down - and the partial stroke was
	 * thrown away. On hardware that is "alt tabbing out mid stroke causes
	 * stroke to disappear as it never landed".
	 *
	 * `docs/manual.md` already states the opposite rule for the other
	 * teardown a writer meets mid-stroke, the pdf viewer rebuilding under the
	 * pen: the stroke commits what was drawn instead of vanishing, and only
	 * the gesture ends. A blur is the same event from the writer's side, so it
	 * now gets the same answer - on both surfaces.
	 *
	 * `finishActiveStroke()` is that answer, and it is `endPenStroke`'s body,
	 * not `abandonActiveStroke`'s: one `cb.onPenUp`, and every other piece of
	 * the teardown left exactly as a real lift leaves it (see the tail tests
	 * below). What did NOT relax is `abandonActiveStroke` itself - the note
	 * switch still drops its stroke, and still never reaches `onPenUp`; that
	 * is pinned in the return-value block at the foot of this file.
	 */
	it("delivers exactly one onPenUp, and never an abandon", () => {
		const h = harness();
		h.fire(penEvent("pointerdown", 100));
		expect(h.router.isStroking).toBe(true);

		h.fireWin({ type: "blur" } as unknown as PointerEvent);

		expect(h.rec.ups, "the partial stroke was dropped instead of committed").toBe(1);
		expect(h.rec.abandons, "a committed stroke must not also report as abandoned").toBe(0);
		expect(h.router.isStroking).toBe(false);
	});

	it("reports the commit, so the caller knows the stroke ended", () => {
		// The blur handler reads this to tell "a stroke was live" from
		// "ownership bookkeeping only", which is the difference between the
		// two branches it can take.
		const h = harness();
		h.fire(penEvent("pointerdown", 100));

		expect(h.router.finishActiveStroke()).toBe(true);
		expect(h.router.finishActiveStroke(), "nothing left to finish").toBe(false);
		expect(h.rec.ups).toBe(1);
	});

	it("a blur with nothing live is neither an up nor an abandon", () => {
		// The `2e880b4` no-op, unchanged by the ruling: `finishActiveStroke`
		// returns false with no stroke, and the abandon branch behind it finds
		// nothing live either.
		const h = harness();

		h.fireWin({ type: "blur" } as unknown as PointerEvent);

		expect(h.rec.ups).toBe(0);
		expect(h.rec.abandons).toBe(0);
	});

	it("a blur inside the post-stroke tail adds no second pen-up", () => {
		// The stroke already ended properly and its own pointerup already ran
		// the surface's pen-up path. The tail is ownership bookkeeping, not a
		// stroke, so there is nothing to commit and nothing to abandon.
		const h = harness();
		h.fire(penEvent("pointerdown", 100));
		h.fire(penEvent("pointerup", 110, { pressure: 0, buttons: 0 }));

		h.fireWin({ type: "blur" } as unknown as PointerEvent);

		expect(h.rec.ups, "the tail was committed as a second stroke").toBe(1);
		expect(h.rec.abandons).toBe(0);
	});
});

/**
 * A finger resting through the blur (MAJOR 1, review of the ruling above).
 *
 * The blur handler exists for the loss no pointer event reports: the OS takes
 * focus and the contact just goes quiet (see the handler's own header). That
 * argument is about the PEN, but it is equally true of a palm resting beside
 * it - that finger's `pointerup` and its `touchend` never arrive either, so
 * `guardTouches.delete` and `manip.touchEnd` never run.
 *
 * Before the ruling the blur ran `abandonActiveStroke()`, whose teardown
 * cleared that bookkeeping. `finishActiveStroke()` returns true and the
 * handler returns, so unless it clears the maps itself they are stranded for
 * the life of the router - and `hasLiveGesture` reads them, so it is
 * permanently true. Every LATER `abandonActiveStroke()` (every note switch,
 * every pdf `forgetHistory`) then stops being the `2e880b4` no-op and runs
 * `restoreGuardStyle()` with nothing live: the standing `touch-action: none`
 * pulled out from under the first contact as a note opens, which is the
 * lit-nib regression itself.
 *
 * The maps are cleared rather than released: no `restoreGuardStyle()`, no
 * `manip.touchEnd`. A contact that DOES report later finds nothing to delete
 * and does nothing - the "never saw this contact" state `abandonActiveStroke`'s
 * own header argues a stood-down router should be left in.
 *
 * `liveTouchIds` is the one exception (MINOR finding, later review):
 * `touchPos`/`guardTouches` are OUR bookkeeping and get the "never saw it"
 * treatment above, but `liveTouchIds` is nothing but a mirror of what the
 * browser itself still thinks is down. Clearing it here does not make the
 * contact go away, it just makes the mirror wrong - and the very next
 * stroke's `touchesAtStrokeStart` snapshot reads straight off it (see
 * `touchesPredateStroke`), so a resting finger that survived the blur would
 * look brand-new to that snapshot and have its eventual touchend eaten.
 * `finishActiveStroke()` leaves it alone; `abandonActiveStroke()` still
 * clears it, because a note switch - unlike a blur - is defined to forget
 * every contact regardless of whether it is still physically down.
 */
describe("a blur with a finger down strands no touch bookkeeping", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	/** A finger's pointerdown - a different pointerId from `penEvent`'s 7. */
	const fingerDown = (el: unknown, pointerId = 21) =>
		({
			type: "pointerdown",
			pointerType: "touch",
			pointerId,
			isPrimary: true,
			target: el,
			clientX: 300,
			clientY: 400,
			pressure: 0.5,
			buttons: 1,
			button: 0,
			timeStamp: 50,
			tiltX: 0,
			tiltY: 0,
			width: 20,
			height: 20,
			preventDefault: () => {},
			stopPropagation: () => {},
		}) as unknown as PointerEvent;

	/** Its parallel TouchEvent - the only thing `liveTouchIds` is fed from. */
	const fingerTouchStart = (el: unknown, identifier = 21) =>
		({
			type: "touchstart",
			target: el,
			changedTouches: [{ identifier }],
			preventDefault: () => {},
			stopPropagation: () => {},
		}) as unknown as PointerEvent;

	/** The same finger actually lifting - what corrects `liveTouchIds` for real. */
	const fingerTouchEnd = (el: unknown, identifier = 21) => {
		let prevented = false;
		let stopped = false;
		const ev = {
			type: "touchend",
			target: el,
			changedTouches: [{ identifier }],
			preventDefault: () => void (prevented = true),
			stopPropagation: () => void (stopped = true),
		};
		return {
			ev: ev as unknown as PointerEvent,
			get suppressed() {
				return prevented || stopped;
			},
		};
	};

	it("keeps liveTouchIds live across the blur (browser truth), clearing only touchPos and guardTouches", () => {
		const h = harness();
		h.fire(fingerDown(h.el));
		h.fireWin(fingerTouchStart(h.el));
		h.fire(penEvent("pointerdown", 100));
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const p = h.router as any;
		expect(p.touchPos.size, "harness never registered the finger").toBe(1);
		expect(p.liveTouchIds.size).toBe(1);
		expect(p.guardTouches.size).toBe(1);

		h.fireWin({ type: "blur" } as unknown as PointerEvent);

		expect(h.rec.ups, "the stroke still commits exactly once").toBe(1);
		expect(h.rec.abandons).toBe(0);
		expect(p.touchPos.size, "touchPos survived the blur").toBe(0);
		expect(p.guardTouches.size, "guardTouches survived the blur").toBe(0);
		expect(p.gesturePanned).toBe(false);
		// The finger never sent a touchend/touchcancel - it is still
		// physically on the glass, and liveTouchIds is nothing but a mirror
		// of that. Clearing it here would just make the mirror wrong until
		// the browser corrects it, which is exactly what the NEXT assertion
		// would catch: the following stroke's touchesAtStrokeStart snapshot
		// is read straight off liveTouchIds (see touchesPredateStroke).
		expect(p.liveTouchIds.has(21), "the resting finger fell out of the browser-truth mirror").toBe(
			true
		);

		// A second pen stroke starts while the finger is still down. Its
		// snapshot must see the finger as having predated the stroke, or the
		// finger's eventual touchend gets eaten as though it were a brand
		// new mid-stroke contact (the strand this whole mirror exists to
		// prevent - see touchcancel's own comment above, ~1063).
		h.fire(penEvent("pointerup", 110, { pressure: 0, buttons: 0 }));
		h.fire(penEvent("pointerdown", 200));
		expect(
			p.touchesAtStrokeStart.has(21),
			"the resting finger was missing from the new stroke's snapshot"
		).toBe(true);

		const end = fingerTouchEnd(h.el);
		h.fireWin(end.ev);
		expect(end.suppressed, "a touch that predated the stroke was eaten as a fresh one").toBe(
			false
		);
	});

	it("so the next note switch is still the 2e880b4 no-op, guard style included", () => {
		const h = harness();
		h.fire(fingerDown(h.el));
		h.fireWin(fingerTouchStart(h.el));
		h.fire(penEvent("pointerdown", 100));

		h.fireWin({ type: "blur" } as unknown as PointerEvent);
		// Unlike touchPos/guardTouches, liveTouchIds is browser truth and
		// survives the blur (see the test above) - for this to be the
		// genuine 2e880b4 "nothing live" no-op the finger has to actually
		// lift, not merely be forgotten.
		h.fireWin(fingerTouchEnd(h.el).ev);
		// Past the ownership tail the commit legitimately arms, so the only
		// thing left that `hasLiveGesture` could read is the touch bookkeeping.
		vi.advanceTimersByTime(TAIL_MS + 100);

		const before = snapshot(h.router);
		const touchActionBefore = h.el.style.touchAction;

		expect(
			h.router.abandonActiveStroke(),
			"stranded touch bookkeeping made a routine switch look live"
		).toBe(false);

		expect(snapshot(h.router)).toEqual(before);
		expect(h.el.style.touchAction, "the standing guard was un-armed").toBe(touchActionBefore);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect((h.router as any).guardApplied, "guardApplied was un-armed").toBe(true);
	});
});

describe("the ownership tail expires honestly (residual b)", () => {
	/**
	 * `2e880b4` added the "nothing live -> true no-op" predicate so a note
	 * switch with no gesture in flight could not un-arm the standing
	 * touch-action guard (the lit-nib regression). One of its terms was
	 * `ownershipTailUntil !== 0`, and `ownershipTailUntil` is SET at every
	 * stroke end and cleared nowhere except inside `abandonActiveStroke()`
	 * itself. After the session's first completed stroke it is therefore
	 * non-zero forever, the predicate is permanently true, and every later
	 * switch or blur ran the full teardown - `restoreGuardStyle()` included.
	 * The regression `2e880b4` shipped to stop, back after one stroke.
	 *
	 * The tail is a DEADLINE, so the predicate reads it as one. Nothing
	 * writes `ownershipTailUntil` differently, which is what keeps
	 * `suppressNativeFallout`'s behaviour inside the live tail identical -
	 * pinned below rather than asserted.
	 */
	beforeEach(() => {
		// `performance` alongside the timers because the tail is measured with
		// `performance.now()` and disarmed by a `setTimeout`; faking one and
		// not the other tests a clock that cannot happen on a device.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("a completed stroke's tail leaves nothing live once it has expired", () => {
		const h = harness();
		h.fire(penEvent("pointerdown", 100));
		h.fire(penEvent("pointerup", 110, { pressure: 0, buttons: 0 }));

		// Past the tail AND past the disarm timer that follows it.
		vi.advanceTimersByTime(TAIL_MS + 100);
		const before = snapshot(h.router);
		const touchActionBefore = h.el.style.touchAction;

		expect(h.router.abandonActiveStroke()).toBe(false);

		expect(snapshot(h.router)).toEqual(before);
		expect(h.el.style.touchAction).toBe(touchActionBefore);
	});

	it("and a blur after it is the same no-op, with no chrome call", () => {
		const h = harness();
		h.fire(penEvent("pointerdown", 100));
		h.fire(penEvent("pointerup", 110, { pressure: 0, buttons: 0 }));
		vi.advanceTimersByTime(TAIL_MS + 100);
		const before = snapshot(h.router);

		h.fireWin({ type: "blur" } as unknown as PointerEvent);

		expect(snapshot(h.router)).toEqual(before);
		expect(h.rec.abandons).toBe(0);
	});

	it("a click INSIDE the tail is still suppressed - the tail's semantics are untouched", () => {
		const h = harness();
		h.fire(penEvent("pointerdown", 100));
		h.fire(penEvent("pointerup", 110, { pressure: 0, buttons: 0 }));

		vi.advanceTimersByTime(TAIL_MS - 100);
		const click = clickEvent();
		h.fireWin(click.ev);

		expect(click.suppressed).toBe(true);
	});

	it("and a click after the tail is not", () => {
		const h = harness();
		h.fire(penEvent("pointerdown", 100));
		h.fire(penEvent("pointerup", 110, { pressure: 0, buttons: 0 }));

		vi.advanceTimersByTime(TAIL_MS + 100);
		const click = clickEvent();
		h.fireWin(click.ev);

		expect(click.suppressed).toBe(false);
	});

	it("a stroke live INSIDE the tail window still abandons true - f5f2333 stands", () => {
		// The half that must not be traded away for the no-op above: a real
		// mid-stroke switch still reports true so the caller stands the strip
		// chrome down.
		const h = harness();
		h.fire(penEvent("pointerdown", 100));
		h.fire(penEvent("pointerup", 110, { pressure: 0, buttons: 0 }));
		vi.advanceTimersByTime(TAIL_MS + 100);
		h.fire(penEvent("pointerdown", 500));

		expect(h.router.abandonActiveStroke()).toBe(true);
	});
});

describe("window blur ends an in-flight stroke (Slice 2)", () => {
	// pointercancel and lostpointercapture already route a lost stroke through
	// endPenStroke; this covers the loss neither reaches: the OS takes focus
	// away mid-stroke (alt-tab, a system dialog, the on-screen keyboard) with
	// no pointer event at all. Without a blur handler this is the same bug as
	// the note switch, arrived at a different way: activePenId stays set,
	// the click suppressor never comes down.
	//
	// Since the ruling above the blur ends the stroke through
	// `finishActiveStroke()`, so "comes down" means what it means after any
	// lift: the tail first, then nothing. It is the TAIL that these two
	// assert, because the tail is where the regression would hide - an
	// end that forgot to arm it would leave the window's own click fallout
	// (the focus coming back, a dialog dismissed) free to hit a strip button.
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("clears the active stroke and arms the ownership tail, exactly as a lift does", () => {
		const h = harness();
		h.fire(penEvent("pointerdown", 100));
		expect(h.router.isStroking).toBe(true);

		h.fireWin({ type: "blur" } as unknown as PointerEvent);
		expect(h.router.isStroking).toBe(false);

		vi.advanceTimersByTime(TAIL_MS - 100);
		const click = clickEvent();
		h.fireWin(click.ev);
		expect(click.suppressed, "the blur-ended stroke left no tail to eat its fallout").toBe(
			true
		);
	});

	it("and the suppressor comes down when that tail expires, not before", () => {
		const h = harness();
		h.fire(penEvent("pointerdown", 100));

		h.fireWin({ type: "blur" } as unknown as PointerEvent);

		vi.advanceTimersByTime(TAIL_MS + 100);
		const click = clickEvent();
		h.fireWin(click.ev);
		expect(click.suppressed, "the suppressor stayed armed past the tail").toBe(false);
	});
});

describe("InlinePenRouter.abandonActiveStroke's return value (the strip-chrome fix)", () => {
	/**
	 * `InkOverlayPlugin.update()` now reads this to decide whether the note it
	 * is switching TO needs `stripPenUp` called on its behalf, because
	 * `abandonActiveStroke()` - unlike a real pointerup - never reaches
	 * `cb.onPenUp` itself (no PointerEvent to hand it). Get this wrong in
	 * either direction and either a routine switch pays for a needless
	 * `stripPenUp`/`refresh()`, or the strip stays permanently invisible and
	 * unhit-testable (`.is-inking` in styles.css) on the note actually hit by
	 * the bug - see the file header.
	 */
	it("true: a claimed pen stroke was live and just got torn down", () => {
		const h = harness();
		h.fire(penEvent("pointerdown", 100));
		expect(h.router.isStroking).toBe(true);

		expect(h.router.abandonActiveStroke()).toBe(true);
		expect(h.router.isStroking).toBe(false);
	});

	it("false: a fresh router with nothing live at all", () => {
		const h = harness();
		expect(h.router.abandonActiveStroke()).toBe(false);
	});

	it("false the second time: nothing left to abandon once the first call already did", () => {
		const h = harness();
		h.fire(penEvent("pointerdown", 100));

		expect(h.router.abandonActiveStroke()).toBe(true);
		expect(h.router.abandonActiveStroke()).toBe(false);
	});

	/**
	 * The router must never call the overlay back itself - that would let it
	 * reach into ink-commit logic (`InkOverlay.penUp` does far more than
	 * chrome, per surface) for a stroke that is being DROPPED, not finished.
	 * `InkOverlayPlugin.update()` deciding, from the return value, whether to
	 * run only `stripPenUp` (chrome, not commit) is what keeps an abandoned
	 * stroke from being half-committed through a path meant for a real
	 * pen-up. `recorder()`'s onPenUp only counts `cb.onPenUp` calls, so this
	 * fails if abandonActiveStroke is ever changed to call it directly.
	 */
	it("never calls the overlay's onPenUp itself", () => {
		const h = harness();
		h.fire(penEvent("pointerdown", 100));

		h.router.abandonActiveStroke();

		expect(h.rec.ups).toBe(0);
	});
});

/**
 * Release the capture AFTER the id is cleared (MINOR 2, review of the ruling).
 *
 * Both teardown paths that have no pointer event to end the stroke release the
 * pointer capture themselves, and the scroller's own `lostpointercapture`
 * handler calls `endPenStroke(e, false)` - a full commit, `cb.onPenUp(e)`
 * included. The only thing standing between the release and a second commit is
 * `endPenStroke`'s `activePenId === null` test, and until now both callers
 * released while `activePenId` was still set.
 *
 * Chromium dispatches `lostpointercapture` asynchronously, so on a device the
 * re-entry does not happen and neither path double-commits today. That is a
 * property of the engine's scheduling, not of this code, and it became
 * load-bearing the moment `finishActiveStroke` started calling `cb.onPenUp` -
 * a synchronous dispatch would commit the stroke twice on the note and, worse,
 * would make `abandonActiveStroke` reach `onPenUp` at all, which is the one
 * thing its contract promises it never does. Clearing the id first makes the
 * re-entry a no-op by construction and costs a local.
 *
 * The harness below dispatches synchronously on purpose: it is the only way to
 * assert the ordering rather than the engine.
 */
describe("releasing capture cannot re-enter the commit path", () => {
	/** Make `releasePointerCapture` dispatch the event Chromium defers. */
	const dispatchLostCaptureSynchronously = (h: ReturnType<typeof harness>) => {
		h.el.releasePointerCapture = () => h.fire(penEvent("lostpointercapture", 120));
	};

	it("a blur commit stays exactly one pen-up and one strokeEnd", () => {
		const h = harness();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const feed = (h.router as any).inkFeed;
		const realStrokeEnd = feed.strokeEnd.bind(feed);
		let strokeEnds = 0;
		feed.strokeEnd = () => {
			strokeEnds++;
			realStrokeEnd();
		};

		h.fire(penEvent("pointerdown", 100));
		dispatchLostCaptureSynchronously(h);

		h.fireWin({ type: "blur" } as unknown as PointerEvent);

		expect(h.rec.ups, "the stroke committed twice").toBe(1);
		expect(strokeEnds, "the feed was ended twice").toBe(1);
		expect(h.rec.abandons).toBe(0);
		expect(h.router.isStroking).toBe(false);
	});

	it("an abandon still never reaches onPenUp, even re-entered", () => {
		// The invariant the whole abandon path is built on: a stroke being
		// DROPPED must not be half-committed through a path meant for a lift.
		const h = harness();
		h.fire(penEvent("pointerdown", 100));
		dispatchLostCaptureSynchronously(h);

		expect(h.router.abandonActiveStroke()).toBe(true);

		expect(h.rec.ups, "the abandoned stroke was committed by the re-entry").toBe(0);
		expect(h.router.isStroking).toBe(false);
	});
});
