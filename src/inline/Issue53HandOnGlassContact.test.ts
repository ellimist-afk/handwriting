import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { releaseTipModes, setPenReticle } from "./InkOverlay";
import { type InlinePenCallbacks, InlinePenRouter } from "./InlinePenRouter";
import { PEN_HOVER_CLASS } from "./PenCursor";
import { setMouseInk } from "./MouseInk";
import { fakeEl, installFakeWindow } from "../../test/routerHarness";
import { type MountedOverlay, type RigEl, mountOverlay } from "./mountRig.test.util";

// GitHub issue 53, the two-pane half. A finger or palm landing in a pane whose own glass is empty fans
// `onHandOnGlass` out to every live router (InlinePenRouterInput.ts:217), and a note's callback is `hidePenCursor`
// (InkOverlayLifecycle.ts:300), which takes the hover class off the scroller (InkOverlayCursors.ts:305). With two
// panes side by side, a palm resting in the next pane while the pen writes in this one did that mid-stroke: the same
// whole-note restyle as the watchdog's, on a note with equations a hitch. The same pane is safe, because there its own
// `handOnGlass()` is true while the pen is down (InlinePenRouter.ts:914-918) and nothing is fanned out.
//
// The callback's job is a parked MOUSE's ring (InkOverlayLifecycle.ts:288-299). A pen in contact has no ring up to
// lose (pen-down concealed it, InkOverlayPenPath.ts:142), so leaving the class alone in contact costs nothing.
//
// Pane A is a real overlay mounted all the way through `mount()` (mountRig.test.util.ts), so its callbacks are the
// production ones and a fix at the callback is what these cells see. Pane B is a bare real router on the harness
// element, there only to be landed on. A's contact is its router's own flag, set by hand: the rig's element sends no
// events, and the claim is all the overlay can ask of it.

let restore: () => void;
beforeAll(() => {
	restore = installFakeWindow();
});
afterAll(() => restore());

beforeEach(() => {
	setPenReticle(true);
	releaseTipModes();
});
afterEach(() => {
	setPenReticle(true);
	releaseTipModes();
});

interface Overlay {
	showPenCursor(s: unknown, pointerType?: string): void;
	hoverWatchdog: unknown;
	penCursorShown: boolean;
}
interface Router {
	cb: InlinePenCallbacks;
	activePenId: number | null;
	activeIsPen: boolean;
}

/** Every class add or remove and every style write on the element, from now on. */
function recordWrites(el: RigEl): string[] {
	const writes: string[] = [];
	const set = el.classes;
	const add = set.add.bind(set);
	const del = set.delete.bind(set);
	set.add = (c: string) => {
		if (!set.has(c)) writes.push(`add ${c}`);
		return add(c);
	};
	set.delete = (c: string) => {
		if (set.has(c)) writes.push(`remove ${c}`);
		return del(c);
	};
	const css = el.setCssStyles.bind(el);
	el.setCssStyles = (s: Record<string, string>) => {
		writes.push(`style ${JSON.stringify(s)}`);
		css(s);
	};
	return writes;
}

function paneA(): { m: MountedOverlay; o: Overlay; router: Router; writes: string[] } {
	const m = mountOverlay("issue53-hand-on-glass.md");
	const writes = recordWrites(m.scrollDOM);
	return { m, o: m.o as unknown as Overlay, router: m.o.router as unknown as Router, writes };
}

function paneB(): { router: InlinePenRouter; fire(ev: PointerEvent): void } {
	const el = fakeEl();
	const noop = (): void => undefined;
	const cb: InlinePenCallbacks = {
		onPenDown: noop, onPenHover: noop, onPenLeave: noop, onPinch: noop, onPenRaw: noop, onPenMove: noop, onPenUp: noop,
	};
	const router = new InlinePenRouter(el as unknown as HTMLElement, el as unknown as HTMLElement, cb);
	return {
		router,
		fire: (ev) => {
			const h = el.handlers.get(ev.type);
			if (!h) throw new Error(`router registered no handler for ${ev.type}`);
			h(ev);
		},
	};
}

function touchDown(pointerId: number, x: number, y: number): PointerEvent {
	return {
		type: "pointerdown", pointerType: "touch", pointerId, isPrimary: true, clientX: x, clientY: y, pressure: 0.5,
		buttons: 1, button: 0, timeStamp: 0, tiltX: 0, tiltY: 0, width: 0, height: 0,
		preventDefault: () => {}, stopPropagation: () => {},
	} as unknown as PointerEvent;
}

const HOVER = { x: 40, y: 40, pressure: 0, timestamp: 0, tiltX: 0, tiltY: 0 };

describe("issue 53: a hand landing in another pane leaves this scroller alone while the pen is down here", () => {
	it("this pane's own stand-down, called in contact, changes no class or style on the scroller", () => {
		const a = paneA();
		try {
			a.o.showPenCursor(HOVER, "pen");
			expect(a.m.scrollDOM.classes.has(PEN_HOVER_CLASS), "precondition: the hover put the class on").toBe(true);
			const before = a.writes.length;
			a.router.activePenId = 7;
			a.router.activeIsPen = true;
			a.router.cb.onHandOnGlass?.();
			expect(a.writes.slice(before), "the scroller was written during the pen contact").toEqual([]);
			// The guard against a ghost: the watchdog that hides a pen gone from range after the contact is still armed.
			expect(a.o.hoverWatchdog, "the watchdog that hides the pen after the contact was stood down in contact").not.toBe(null);
		} finally {
			a.router.activePenId = null;
			a.router.activeIsPen = false;
			a.m.destroy();
		}
	});

	it("a palm landing in the next pane while the pen writes here changes no class or style on this scroller", () => {
		const a = paneA();
		const b = paneB();
		try {
			a.o.showPenCursor(HOVER, "pen");
			const before = a.writes.length;
			a.router.activePenId = 7;
			a.router.activeIsPen = true;
			b.fire(touchDown(2, 120, 300));
			expect(a.writes.slice(before), "a palm in the next pane wrote this scroller during the pen contact").toEqual([]);
		} finally {
			a.router.activePenId = null;
			a.router.activeIsPen = false;
			b.router.dispose();
			a.m.destroy();
		}
	});

	// The guard is THIS pane's contact, not any pane's. A mouse ring parked over the next pane is painted before the pen
	// lands here (while it is down, `anyHandOnGlass` refuses new mouse rings), and a palm landing on that pane must
	// still stand it down, as the 1.4.12 rule says; a guard on any pane's contact would leave it lit under the palm.
	it("a palm in the next pane while the pen writes here still stands down a mouse ring parked over that pane", () => {
		const b = paneA();
		let a: ReturnType<typeof paneA> | null = null;
		setMouseInk(true);
		try {
			b.o.showPenCursor(HOVER, "mouse");
			expect(b.m.scrollDOM.classes.has(PEN_HOVER_CLASS), "precondition: the mouse ring put the class on").toBe(true);
			a = paneA();
			a.router.activePenId = 7;
			a.router.activeIsPen = true;
			b.router.cb.onHandOnGlass?.();
			expect(b.m.scrollDOM.classes.has(PEN_HOVER_CLASS), "the mouse ring under the palm was left up").toBe(false);
		} finally {
			setMouseInk(false);
			if (a) {
				a.router.activePenId = null;
				a.router.activeIsPen = false;
				a.m.destroy();
			}
			b.m.destroy();
		}
	});

	it("control: with no pen down, a finger landing in the next pane still stands this pane's reticle down", () => {
		const a = paneA();
		const b = paneB();
		try {
			a.o.showPenCursor(HOVER, "pen");
			expect(a.m.scrollDOM.classes.has(PEN_HOVER_CLASS), "precondition: the hover put the class on").toBe(true);
			b.fire(touchDown(2, 120, 300));
			expect(a.o.penCursorShown, "a finger in the next pane no longer stands this one down").toBe(false);
			// A pen's ring goes alone (GitHub issue 53): the class stays, so the note is not restyled.
			expect(a.m.scrollDOM.classes.has(PEN_HOVER_CLASS), "the finger took the class off with a pen's ring").toBe(true);
		} finally {
			b.router.dispose();
			a.m.destroy();
		}
	});
});
