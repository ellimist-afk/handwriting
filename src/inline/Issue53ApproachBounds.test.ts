import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { InkOverlayPlugin, releaseTipModes, setPenReticle } from "./InkOverlay";
import { Camera } from "../camera/Camera";
import { HOVER_GHOST_MS, PAN_DRAG_CLASS, PEN_HOVER_CLASS } from "./PenCursor";
import { setMouseInk } from "./MouseInk";
import { setPenInk } from "./PenInk";
import { hidePenCursorsEverywhere } from "./InkOverlayRegistry";
import { anyHandOnGlass } from "./InlinePenRouterTrace";
import { installFakeWindow } from "../../test/routerHarness";
import { type MountedOverlay, type RigEl, mountOverlay } from "./mountRig.test.util";

// GitHub issue 53, part 2: the approach. The hover class on the note's scroller (PEN_HOVER_CLASS) is matched by a rule on
// every element under it, so each add or remove restyles the whole note; on a note with equations that is a task of 200 ms
// and more. Part 1 kept it still while the pen is down. Part 2 keeps it still when the pen only goes away, so a pen that
// lifts, leaves and comes back costs no restyle:
// - Bound 2: no scroller class write at approach, lift, pen gone (the watchdog), a pen's leave, a lasso or space lift, or a
//   finger landing with no mouse ring lit. The ring itself still goes.
// - Bound 1: the class is `cursor: none`, so whenever a pointer over the note gets no ring it must come off by that
//   pointer's first row: a plain mouse, an armed mouse refused (keyboard pause, hand on glass), the reticle turned off, the
//   pen tool off, and the Escape floor.
// - The pan swap keeps its order: the hover class comes off before the pan class goes on.
// A pen-down and an ink lift write nothing already (part 1's cells hold that).

let restore: () => void;
beforeAll(() => {
	restore = installFakeWindow();
});
afterAll(() => restore());

function reset(): void {
	setPenReticle(true);
	releaseTipModes();
	setMouseInk(false);
	setPenInk(true);
}
beforeEach(reset);
afterEach(() => {
	vi.useRealTimers();
	reset();
});

const HOVER = { x: 40, y: 40, pressure: 0, timestamp: 0, tiltX: 0, tiltY: 0 };

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

interface Pane {
	m: MountedOverlay;
	o: Record<string, any>;
	router: Record<string, any>;
	writes: string[];
	has(c: string): boolean;
}

/** A real overlay mounted through `mount()`, so the router callbacks are the production ones. */
function pane(): Pane {
	const m = mountOverlay("issue53-approach.md");
	const writes = recordWrites(m.scrollDOM);
	return { m, o: m.o as Record<string, any>, router: m.o.router as Record<string, any>, writes, has: (c) => m.scrollDOM.classes.has(c) };
}

function move(pointerType: "mouse" | "pen", x = 60, y = 60): PointerEvent {
	return {
		type: "pointermove", pointerType, pointerId: pointerType === "pen" ? 2 : 1, isPrimary: true, clientX: x, clientY: y,
		pressure: 0, buttons: 0, button: -1, timeStamp: 0, tiltX: 0, tiltY: 0, width: 1, height: 1,
		getCoalescedEvents: () => [], preventDefault: () => {}, stopPropagation: () => {},
	} as unknown as PointerEvent;
}

/** Pen hover, class on, ring lit: the state every cell starts from unless it says otherwise. */
function penHovering(p: Pane): number {
	p.o.showPenCursor(HOVER, "pen");
	expect(p.has(PEN_HOVER_CLASS), "precondition: the pen hover put the class on").toBe(true);
	expect(p.o.penCursorShown, "precondition: the pen hover lit the ring").toBe(true);
	return p.writes.length;
}

function withPane(body: (p: Pane) => void): void {
	const p = pane();
	try {
		body(p);
	} finally {
		p.router.activePenId = null;
		p.router.activeIsPen = false;
		p.m.destroy();
	}
}

// The watchdog needs real timers: the mounted rig's window never fires one. The rig of Issue53WatchdogContact.test.ts.
function timerRig() {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
	const scroller = new Set<string>();
	const writes: string[] = [];
	const inst = Object.create(InkOverlayPlugin.prototype) as Record<string, any>;
	Object.assign(inst, {
		camera: new Camera(), cssScale: 1, penCursorPinned: false, penCursorShown: false, penCursorClient: null,
		hoverWatchdog: null, mode: "ink", spacePlan: null,
		router: { isStroking: false, anyPenDown: () => false },
		penCursorEl: { classList: { add: () => undefined, remove: () => undefined }, setCssStyles: () => undefined },
		view: {
			dom: { ownerDocument: { defaultView: {
				setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
				clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
			} } },
			scrollDOM: {
				classList: {
					add: (c: string) => { if (!scroller.has(c)) writes.push(`add ${c}`); scroller.add(c); },
					remove: (c: string) => { if (scroller.has(c)) writes.push(`remove ${c}`); scroller.delete(c); },
					contains: (c: string) => scroller.has(c),
				},
				setCssStyles: (s: Record<string, string>) => { writes.push(`style ${JSON.stringify(s)}`); },
			},
		},
		clearSpaceFeedback: () => undefined,
		attachHoverOff: () => undefined,
	});
	return { inst, scroller, writes };
}

describe("issue 53 part 2, bound 2: a pen that only goes away leaves the scroller alone", () => {
	it("A1 the watchdog hides a pen gone from range and writes no class: ring down, class kept", () => {
		const r = timerRig();
		r.inst.showPenCursor(HOVER, "pen");
		expect(r.scroller.has(PEN_HOVER_CLASS), "precondition: the hover put the class on").toBe(true);
		const before = r.writes.length;
		vi.advanceTimersByTime(HOVER_GHOST_MS + 100);
		expect(r.inst.penCursorShown, "the ring of a pen gone from range was left lit").toBe(false);
		expect(r.writes.slice(before), "the pen-gone hide wrote the scroller").toEqual([]);
		r.inst.clearHoverWatchdog();
	});

	it("A3 the next approach after the pen-gone hide writes no class", () => {
		const r = timerRig();
		r.inst.showPenCursor(HOVER, "pen");
		vi.advanceTimersByTime(HOVER_GHOST_MS + 100);
		const before = r.writes.length;
		r.inst.showPenCursor(HOVER, "pen");
		expect(r.inst.penCursorShown, "the approach lit no ring").toBe(true);
		expect(r.writes.slice(before), "the approach after a pen-gone hide wrote the scroller").toEqual([]);
		r.inst.clearHoverWatchdog();
	});

	it("A2 a pen's leave hides the ring and writes no class; its next approach writes none either", () => {
		withPane((p) => {
			const before = penHovering(p);
			p.router.cb.onPenLeave();
			expect(p.o.penCursorShown, "the ring of a pen that left was left lit").toBe(false);
			expect(p.writes.slice(before), "a pen's leave wrote the scroller").toEqual([]);
			p.o.showPenCursor(HOVER, "pen");
			expect(p.writes.slice(before), "the approach after a pen's leave wrote the scroller").toEqual([]);
		});
	});

	it("A6 a lasso lift and a space lift hide the ring and write no class", () => {
		withPane((p) => {
			const before = penHovering(p);
			p.o.hideLassoCursor();
			expect(p.o.penCursorShown, "the lasso ring was left lit after its lift").toBe(false);
			p.o.showPenCursor(HOVER, "pen");
			p.o.hideSpaceCursor();
			expect(p.o.penCursorShown, "the space ring was left lit after its lift").toBe(false);
			expect(p.writes.slice(before), "a lasso or space lift wrote the scroller").toEqual([]);
		});
	});

	it("A7 a finger landing with no mouse ring lit hides the pen's ring and writes no class", () => {
		withPane((p) => {
			const before = penHovering(p);
			p.router.cb.onHandOnGlass();
			expect(p.o.penCursorShown, "the pen's ring was left lit under a landing finger").toBe(false);
			expect(p.writes.slice(before), "a finger landing with no mouse ring lit wrote the scroller").toEqual([]);
		});
	});

	it("A7 guard: a finger landing with an armed mouse's ring lit takes the ring and the class down, as today", () => {
		withPane((p) => {
			setMouseInk(true);
			p.o.showPenCursor(HOVER, "mouse");
			expect(p.o.penCursorShown, "precondition: the armed mouse lit its ring").toBe(true);
			p.router.cb.onHandOnGlass();
			expect(p.o.penCursorShown, "the mouse's ring was left lit under a landing finger").toBe(false);
			expect(p.has(PEN_HOVER_CLASS), "the class stayed on with the mouse's ring down: no pointer at all").toBe(false);
		});
	});
});

describe("issue 53 part 2, bound 1: a pointer that gets no ring gets its pointer back by its first row", () => {
	// Green today, and the guard part 2 most needs: the router stands a plain mouse down through the pen's leave
	// (InlinePenRouterInput.ts:729), and part 2 makes a pen's leave keep the class. That path must still drop it.
	it("B1 guard: a plain mouse moving over the note after a pen hover: class off", () => {
		withPane((p) => {
			penHovering(p);
			p.router.pointerMove(move("mouse"));
			expect(p.has(PEN_HOVER_CLASS), "a plain mouse was left with no pointer (cursor: none) after its first row").toBe(false);
		});
	});

	it("B2 an armed mouse refused in the keyboard pause: class off", () => {
		withPane((p) => {
			penHovering(p);
			setMouseInk(true);
			setPenInk(false);
			p.o.showPenCursor(HOVER, "mouse");
			expect(p.has(PEN_HOVER_CLASS), "a paused mouse was left with no pointer").toBe(false);
		});
	});

	it("B3 an armed mouse refused while a hand is on the glass: class off", () => {
		withPane((p) => {
			penHovering(p);
			setMouseInk(true);
			// A finger the router holds as a guard touch (InlinePenRouter.handOnGlass): no pen contact, so no part 1 rule.
			p.router.guardTouches.add(9);
			try {
				expect(anyHandOnGlass(), "precondition: a hand is on the glass").toBe(true);
				p.o.showPenCursor(HOVER, "mouse");
				expect(p.has(PEN_HOVER_CLASS), "a mouse refused under a hand on the glass was left with no pointer").toBe(false);
			} finally {
				p.router.guardTouches.delete(9);
			}
		});
	});

	it("B4 the reticle turned off, the pen moves: class off", () => {
		withPane((p) => {
			penHovering(p);
			setPenReticle(false);
			p.o.showPenCursor(HOVER, "pen");
			expect(p.has(PEN_HOVER_CLASS), "a pen with the reticle off was left with no pointer").toBe(false);
		});
	});

	it("B5 the pen tool off, the pen moves: class off", () => {
		withPane((p) => {
			penHovering(p);
			setPenInk(false);
			p.router.pointerMove(move("pen"));
			expect(p.has(PEN_HOVER_CLASS), "a pen with the tool off was left with no pointer").toBe(false);
		});
	});

	it("B6 guard: the Escape floor takes the class off", () => {
		withPane((p) => {
			penHovering(p);
			hidePenCursorsEverywhere();
			expect(p.has(PEN_HOVER_CLASS), "the Escape floor left the class on").toBe(false);
			expect(p.o.penCursorShown, "the Escape floor left the ring lit").toBe(false);
		});
	});

	it("B7 guard: an armed mouse moving gets its ring and the class", () => {
		withPane((p) => {
			setMouseInk(true);
			p.o.showPenCursor(HOVER, "mouse");
			expect(p.o.penCursorShown, "an armed mouse got no ring").toBe(true);
			expect(p.has(PEN_HOVER_CLASS), "an armed mouse's ring came with the native pointer still on").toBe(true);
		});
	});
});

describe("issue 53 part 2: the pan swap keeps its order", () => {
	it("guard: a pan drag starting under a kept class takes the hover class off before the pan class goes on", () => {
		withPane((p) => {
			const before = penHovering(p);
			p.o.beginPanDragCursor();
			expect(p.writes.slice(before).filter((w) => w.includes("handwriting-")), "the pan swap's class writes").toEqual([
				`remove ${PEN_HOVER_CLASS}`,
				`add ${PAN_DRAG_CLASS}`,
			]);
		});
	});
});
