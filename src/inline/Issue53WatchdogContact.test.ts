import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InkOverlayPlugin, releaseTipModes, setPenReticle } from "./InkOverlay";
import { Camera } from "../camera/Camera";
import { HOVER_GHOST_MS, PEN_HOVER_CLASS } from "./PenCursor";

// GitHub issue 53: writing on a note with equations hitches mid-stroke.
//
// The hover class on the note's scroller (PEN_HOVER_CLASS) is matched by a rule on every element under it, so adding
// or removing it restyles the whole note; on a note with rendered equations that is a 184 to 263 ms task at 6x CPU
// slowdown (measured in a performance trace of pen strokes on an equation note in Live Preview; the same restyle on a
// plain note took 20 to 26 ms). A pen in contact sends no hover samples, so the one
// second hover watchdog fired in the middle of every stroke longer than a second and took the class off: the note was
// restyled mid-stroke, and the pointer the class hides could come back under the pen.
//
// The bound: during a pen contact the plugin changes no class
// or style on the scroller; the watchdog still hides a reticle left by a pen that went away, after the contact. These
// cells drive the reticle methods directly on an Object.create rig, the idiom of HoverWatchdogRearm.test.ts, with the
// router reduced to the two contact questions the overlay can ask of it: `isStroking` (a contact claimed in this pane)
// and `anyPenDown()` (a contact claimed in any pane).

const STEP_MS = 50;

function rig() {
	let timers = 0;
	let now = 0;
	const scroller = new Set<string>();
	const scrollerWrites: string[] = [];
	const contact = { here: false, anywhere: false };
	const inst = Object.create(InkOverlayPlugin.prototype) as Record<string, any>;
	Object.assign(inst, {
		camera: new Camera(), cssScale: 1, penCursorPinned: false, penCursorShown: false, penCursorClient: null,
		hoverWatchdog: null, mode: "ink", spacePlan: null,
		router: {
			get isStroking() { return contact.here; },
			anyPenDown: () => contact.here || contact.anywhere,
		},
		penCursorEl: {
			classList: { add: () => undefined, remove: () => undefined },
			setCssStyles: () => undefined,
		},
		view: {
			dom: { ownerDocument: { defaultView: {
				setTimeout: (fn: () => void, ms: number) => { timers++; return setTimeout(fn, ms); },
				clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
			} } },
			scrollDOM: {
				classList: {
					add: (c: string) => { scrollerWrites.push(`${now} add ${c}`); scroller.add(c); },
					remove: (c: string) => { if (scroller.has(c)) scrollerWrites.push(`${now} remove ${c}`); scroller.delete(c); },
					contains: (c: string) => scroller.has(c),
				},
				setCssStyles: (s: Record<string, string>) => { scrollerWrites.push(`${now} style ${JSON.stringify(s)}`); },
			},
		},
		clearSpaceFeedback: () => undefined,
		attachHoverOff: () => undefined,
	});
	const hover = (x: number) => inst.showPenCursor({ x, y: 10, pressure: 0, timestamp: 0, tiltX: 0, tiltY: 0 }, "pen");
	const advance = (ms: number) => {
		for (let t = 0; t < ms; t += STEP_MS) { vi.advanceTimersByTime(STEP_MS); now += STEP_MS; }
	};
	const hoverFor = (ms: number) => {
		for (let t = 0; t < ms; t += STEP_MS) { hover(10 + (t % 200)); vi.advanceTimersByTime(STEP_MS); now += STEP_MS; }
	};
	return { inst, hover, advance, hoverFor, contact, scroller, scrollerWrites, timers: () => timers, now: () => now };
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
	setPenReticle(true);
	releaseTipModes();
});
afterEach(() => {
	vi.useRealTimers();
	setPenReticle(true);
	releaseTipModes();
});

describe("issue 53: the hover watchdog leaves the scroller alone while a pen is in contact", () => {
	it("a three second stroke after a hover changes no class or style on the scroller", () => {
		const r = rig();
		r.hoverFor(300);
		expect(r.scroller.has(PEN_HOVER_CLASS), "the hover never put the class on").toBe(true);
		const before = r.scrollerWrites.length;
		r.contact.here = true;
		r.advance(3000);
		expect(r.scrollerWrites.slice(before), "the scroller was written during the pen contact").toEqual([]);
		// The screen half (bound 3): the class is what hides the mouse pointer under the pen; it is still on at the end
		// of the stroke, so the pointer did not come back mid-stroke.
		expect(r.scroller.has(PEN_HOVER_CLASS), "the class that hides the pointer came off during the stroke").toBe(true);
	});

	it("a stroke in another pane also leaves this scroller alone", () => {
		const r = rig();
		r.hoverFor(300);
		const before = r.scrollerWrites.length;
		r.contact.anywhere = true;
		r.advance(3000);
		expect(r.scrollerWrites.slice(before), "this scroller was written while a pen was in contact in another pane").toEqual([]);
	});

	it("a pen that lifts and goes away is hidden after the contact: shown half a second on, hidden one second on", () => {
		const r = rig();
		r.hoverFor(300);
		r.contact.here = true;
		r.advance(3000);
		r.contact.here = false;
		r.advance(500);
		expect(r.inst.penCursorShown, "hidden less than half a second after the lift").toBe(true);
		r.advance(HOVER_GHOST_MS - 500);
		// The hide is the ring alone: a pen that only goes away keeps the class, since taking it off and back at the next
		// approach restyles the whole note twice.
		expect(r.scroller.has(PEN_HOVER_CLASS), "the class came off when the pen only went away").toBe(true);
		expect(r.inst.penCursorShown, "the ghost reticle was left on screen").toBe(false);
		expect(r.inst.hoverWatchdog, "a timer was left running after the ghost was hidden").toBe(null);
	});

	it("a pen that lifts and hovers on is never hidden", () => {
		const r = rig();
		r.hoverFor(300);
		r.contact.here = true;
		r.advance(3000);
		r.contact.here = false;
		r.hoverFor(3000);
		expect(r.scrollerWrites.filter((w) => w.includes("remove")), "the class came off around a stroke the pen never left").toEqual([]);
		expect(r.inst.penCursorShown).toBe(true);
	});

	it("a three second stroke wakes the main thread at most four times a second", () => {
		const r = rig();
		r.hoverFor(300);
		const before = r.timers();
		r.contact.here = true;
		r.advance(3000);
		expect(r.timers() - before, "the watchdog polled the contact too often").toBeLessThanOrEqual(12);
	});

	// Whatever the phase of the lift against the watchdog's own timer, the pen is still marked hovering half a second
	// after it. A watchdog that simply re-arms for a whole second while the pen is down passes cell 3 (its one phase
	// hides 950 ms after the lift) but fails here: its first tick after the lift finds no time left and hides anywhere
	// from 0 to 1000 ms after it. That hide takes the ring down; a pen that only goes away keeps the class, so the cell
	// reads the ring, and the class as well.
	it("whatever the phase of the lift, the pen is still marked hovering half a second after it", () => {
		const early: string[] = [];
		for (let len = 3000; len < 4000; len += STEP_MS) {
			const r = rig();
			r.hoverFor(300);
			r.contact.here = true;
			r.advance(len);
			r.contact.here = false;
			r.advance(500);
			if (!r.inst.penCursorShown || !r.scroller.has(PEN_HOVER_CLASS)) early.push(`contact ${len} ms`);
			r.inst.clearHoverWatchdog();
		}
		expect(early, "hidden less than half a second after the lift, at these contact lengths").toEqual([]);
	});

	// The router's contact flag has seven ways home (InlinePenRouter.ts:886-890) and a disposed router leaves the set
	// `anyPenDown()` reads (:701), so the watchdog needs no cap of its own: a cap would take the class off in the middle
	// of a real long contact. What it does need is to hide once the flag clears, even when the clear comes with no lift
	// sample and no hover after it (the abandon path).
	it("a contact the router abandons is hidden within a second of the flag clearing, with no timer left", () => {
		const stranded: string[] = [];
		const dropped: string[] = [];
		for (let len = 3000; len < 4000; len += STEP_MS) {
			const r = rig();
			r.hoverFor(300);
			r.contact.here = true;
			r.advance(len);
			r.contact.here = false;
			r.advance(HOVER_GHOST_MS);
			if (r.inst.penCursorShown || r.inst.hoverWatchdog !== null) {
				stranded.push(`contact ${len} ms`);
			}
			if (!r.scroller.has(PEN_HOVER_CLASS)) dropped.push(`contact ${len} ms`);
			r.inst.clearHoverWatchdog();
		}
		expect(stranded, "still shown or timed a second after the flag cleared, at these contact lengths").toEqual([]);
		expect(dropped, "the class came off when the pen only went away, at these contact lengths").toEqual([]);
	});
});

// The drags that keep the ring alive in contact (a lasso, an insert-space drag, a snapped shape being steered) call
// showPenCursor on their samples (InkOverlayPenPath.ts:483, :490, :518, :525; InkOverlayLassoSpace.ts:461, :902), and
// showPenCursor adds the class when it is missing (InkOverlayCursors.ts:195). A contact that starts with the class off
// (a pen that sent no hover first, or one back from out of range with no hover on the way in) puts the class on at its
// first drag sample. That add stays, a known limit: leaving the class off would show the pointer it hides next to the
// ring. So in contact the add is the one scroller write: no second add, no remove, no style. The three wrappers are
// pass-throughs (InkOverlayCursors.ts:413-415, :507-509, :524-526), so the rig's mode does not route them.
describe("issue 53: a drag that keeps the ring alive in contact writes the scroller once", () => {
	it("a snap, lasso and space drag with no hover before it adds the class once and writes nothing else to the scroller", () => {
		const r = rig();
		r.contact.here = true;
		const at = (x: number) => ({ x, y: 10, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 });
		for (let t = 0; t < 1000; t += STEP_MS) {
			r.inst.showSnapCursor(at(10 + t / 10));
			r.inst.showLassoCursor(at(20 + t / 10));
			r.inst.showSpaceCursor(at(30 + t / 10));
			r.advance(STEP_MS);
		}
		expect(r.scrollerWrites, "in contact, the add at the first drag sample was not the one scroller write").toEqual([`0 add ${PEN_HOVER_CLASS}`]);
		r.inst.clearHoverWatchdog();
	});
});
