/**
 * A finger tap on attached ink selects its whole group; the link icon shows which ink is attached.
 *
 * What it looks like: every attached group shows a small grey link icon at its top-left while you edit. A finger tap on
 * the ink line or the icon selects the whole group, with the same outline a lasso gives. A tap on the word inside a
 * circle still puts the cursor there. Free ink, a pan, a pinch and iPhone finger ink are as before.
 *
 * The overlay cells drive the real tap (tapReleasesSelection, the router's onTapLift) on a bare overlay with the real
 * selection, line anchors and follow (attachTapRig.test.util.ts). The router cells drive the real InlinePenRouter's
 * pointer handlers with that overlay's tap wired as its onTapLift, the window being a recording one, so what the tap
 * keeps from the text (the lift and its trailing touchend, mousedown, mouseup and click) is read off the events.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Decoration from "./AttachDecoration";
import { InlinePenRouter } from "./InlinePenRouter";
import { TAP_FALLOUT_PX } from "./InlinePenRouterInput";
import { SELECTION_GRAB_PAD } from "./InkOverlayConstants";
import { inlineInk } from "./InkOverlayRegistry";
import { fakeEl, installFakeWindow, penEvent, recorder } from "../../test/routerHarness";
import { line, noteStrokes, record, ring, SHOWN, tapRig } from "./attachTapRig.test.util";

let restore: () => void;
beforeAll(() => {
	restore = installFakeWindow();
});
afterAll(() => restore());

/** Shown places (stored plus SHOWN for group ink). g1's ring shows at x 16..176, y 82..118; g2's at y 352..388. */
const ON_G1_LINE = { x: 96, y: 70 + SHOWN.dy };
const IN_G1_CIRCLE = { x: 150, y: 96 };
const ON_G2_LINE = { x: 96, y: 340 + SHOWN.dy };
const IN_G2_CIRCLE = { x: 150, y: 366 };
const ON_FREE_LINE = { x: 96, y: 780 };
const G1 = ["c1", "c2"], G2 = ["d1", "d2"];

/** The tap's scan count, read through the module so a build without it reads 0. */
const scans = () => (Decoration as unknown as { attachTapCounts?: { scans: number } }).attachTapCounts?.scans ?? 0;

describe("a finger tap on an attached stroke's line selects the whole group", () => {
	it("nothing selected: a tap on g1's ring selects g1, both strokes, and the tap is the overlay's", () => {
		const r = tapRig("finger-line.md");
		const answer = r.tapAt(ON_G1_LINE.x, ON_G1_LINE.y);
		expect(r.selected(), "the tap on the ring's line selected its whole group").toEqual(G1);
		expect(answer, "the overlay took the tap").toBe(true);
	});

	it("the selected group shows today's outline: one box round the group, the chrome redrawn", () => {
		const r = tapRig("finger-outline.md");
		r.calls.length = 0;
		r.tapAt(ON_G1_LINE.x, ON_G1_LINE.y);
		const b = r.shownBox(G1);
		expect(r.calls, "the outline round the whole group, as a lasso of the ring draws it").toContain(`box ${b.x},${b.y},${b.width},${b.height}`);
		expect(r.refreshes(), "the strip refreshed for the new selection").toBeGreaterThan(0);
	});

	it("CONTROL: a tap inside the circle, off its line, selects nothing and leaves the tap to the text", () => {
		const r = tapRig("finger-inside.md");
		const answer = r.tapAt(IN_G1_CIRCLE.x, IN_G1_CIRCLE.y);
		expect(r.selected(), "the word inside the circle is text: nothing selected").toEqual([]);
		expect(answer, "the tap goes on to the text").not.toBe(true);
	});

	it("CONTROL: a tap on free ink or on empty paper selects nothing and leaves the tap to the text", () => {
		const r = tapRig("finger-free.md");
		const onFree = r.tapAt(ON_FREE_LINE.x, ON_FREE_LINE.y);
		expect([r.selected(), onFree === true], "[selected, taken] on the free line").toEqual([[], false]);
		const onPaper = r.tapAt(500, 500);
		expect([r.selected(), onPaper === true], "[selected, taken] on empty paper").toEqual([[], false]);
	});

	it("two rings overlapping: the tap takes the nearest stroke's group", () => {
		const strokes = [ring("c1", 10, 70, 160, 36), ring("d1", 20, 74, 160, 36)];
		const r = tapRig("finger-nearest.md", { strokes, attachments: [record("g1", ["c1"], "line 3 words"), record("g2", ["d1"], "line 3 words")] });
		// 1 under g2's top edge (shown 86), 3 under g1's (shown 82).
		r.tapAt(120, 85);
		expect(r.selected(), "the nearer line's group").toEqual(["d1"]);
	});
});

describe("with a selection, a tap on attached ink switches or narrows", () => {
	it("one group selected: a tap on another group's line selects that group instead", () => {
		const r = tapRig("finger-switch.md");
		r.selection.selectExactly(G1);
		r.redraw();
		const answer = r.tapAt(ON_G2_LINE.x, ON_G2_LINE.y);
		expect(r.selected(), "the tap on g2's ring switched the selection to g2").toEqual(G2);
		expect(answer, "the overlay took the tap").toBe(true);
	});

	it("two groups selected: a tap inside one, off its lines, narrows the selection to it", () => {
		const r = tapRig("finger-narrow.md");
		r.selection.selectExactly([...G1, ...G2]);
		r.redraw();
		const answer = r.tapAt(IN_G2_CIRCLE.x, IN_G2_CIRCLE.y);
		expect(r.selected(), "the selection narrowed to the group the tap is in").toEqual(G2);
		expect(answer, "the overlay took the tap").toBe(true);
	});

	it("CONTROL: one group selected, a tap on empty paper lets go and leaves the tap to the text", () => {
		const r = tapRig("finger-letgo.md");
		r.selection.selectExactly(G1);
		r.redraw();
		const answer = r.tapAt(500, 500);
		expect([r.selected(), answer === true], "[selected, taken]").toEqual([[], false]);
	});

	it("CONTROL: a free stroke selected, a tap on it keeps it and leaves the tap to the text", () => {
		const r = tapRig("finger-keep.md");
		r.selection.selectExactly(["free"]);
		r.redraw();
		const answer = r.tapAt(ON_FREE_LINE.x, ON_FREE_LINE.y);
		expect([r.selected(), answer === true], "[selected, taken]").toEqual([["free"], false]);
	});
});

describe("a tap on a group's link icon selects the group", () => {
	/** The icon's middle, world units at zoom 1: 12 css px square, 3 up and left of the group box's corner. */
	const iconMiddle = (box: { x: number; y: number }) => ({ x: box.x - 9, y: box.y - 9 });

	it("nothing selected: a tap on g1's icon selects g1 and the tap is the overlay's", () => {
		const r = tapRig("icon-tap.md");
		r.redraw();
		r.paint("all");
		const p = iconMiddle(r.shownBox(G1));
		const answer = r.tapAt(p.x, p.y);
		expect(r.selected(), "the tap on the icon selected its group").toEqual(G1);
		expect(answer, "the overlay took the tap").toBe(true);
	});

	it("one group selected: a tap on the other group's icon switches to it", () => {
		const r = tapRig("icon-switch.md");
		r.selection.selectExactly(G1);
		r.redraw();
		r.paint("all");
		const p = iconMiddle(r.shownBox(G2));
		r.tapAt(p.x, p.y);
		expect(r.selected(), "the tap on g2's icon switched to g2").toEqual(G2);
	});

	it("CONTROL: a group that needs reattachment has no icon; a tap where it would be is its pin's, beside the tag", () => {
		const r = tapRig("icon-held.md", { held: ["g1"] });
		r.redraw();
		const ops = r.paint("all");
		// The icon's two rings, in the icon's own frame (drawLinkIcon): 12 css px, 3 clear of the box's corner.
		const icons = ops.filter((op) => op.startsWith("arc -11.5,-9,3.25") || op.startsWith("arc -6.5,-9,3.25"));
		expect(icons, "two rings: g2's icon alone, none on the held g1").toHaveLength(2);
		const p = iconMiddle(r.shownBox(G1));
		r.tapAt(p.x, p.y);
		expect(r.selected(), "the held group's pin took the finger's tap and selected its group").toEqual(G1);
	});
});

/** A recording window for the router: every capture listener kept, and fired in order. */
function recordingWindow() {
	const listeners = new Map<string, Array<(e: Event) => void>>();
	const win = {
		devicePixelRatio: 1,
		addEventListener: (type: string, h: (e: Event) => void) => void (listeners.get(type) ?? listeners.set(type, []).get(type)!).push(h),
		removeEventListener: (type: string, h: (e: Event) => void) => void listeners.set(type, (listeners.get(type) ?? []).filter((x) => x !== h)),
		setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms) as unknown as number,
		clearTimeout: (id: number) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
		requestAnimationFrame: () => 1,
		cancelAnimationFrame: () => {},
	};
	/** One event through the window's listeners: whether it was prevented and whether it was stopped. */
	const fire = (type: string, x: number, y: number): { prevented: boolean; stopped: boolean } => {
		const out = { prevented: false, stopped: false };
		const ev = {
			type, clientX: x, clientY: y, target: null,
			changedTouches: type.startsWith("touch") ? [{ identifier: 31, clientX: x, clientY: y }] : undefined, touches: [],
			preventDefault: () => void (out.prevented = true), stopPropagation: () => void (out.stopped = true),
		} as unknown as Event;
		for (const h of [...(listeners.get(type) ?? [])]) h(ev);
		return out;
	};
	/** How many listeners the window holds for these event types. */
	const listening = (types: readonly string[]): number => types.reduce((n, type) => n + (listeners.get(type)?.length ?? 0), 0);
	return { win, fire, listening };
}

/** The real router on a fake scroller, its onTapLift the rig's overlay tap; `fingerInk` arms finger ink. */
function routerOn(r: ReturnType<typeof tapRig>, opts: { fingerInk?: boolean } = {}) {
	const w = recordingWindow();
	const el = Object.assign(fakeEl(), { scrollWidth: 800, clientWidth: 800, scrollHeight: 3600, clientHeight: 600, ownerDocument: { defaultView: w.win } });
	const rec = recorder();
	const router = new InlinePenRouter(el as unknown as HTMLElement, el as unknown as HTMLElement, {
		...rec.cb,
		fingerInk: () => opts.fingerInk ?? false,
		penOff: () => false,
		onTapLift: (s: { x: number; y: number }, ev: object) => (r.overlay as unknown as { tapReleasesSelection(s: object, ev?: object): unknown }).tapReleasesSelection(s, ev),
	} as never, () => 1);
	let id = 31;
	/** One touch event on the scroller: whether its handler prevented it and stopped it. */
	const touch = (type: string, x: number, y: number, t: number, pointerId = id, target?: object): { prevented: boolean; stopped: boolean } => {
		const out = { prevented: false, stopped: false };
		const ev = penEvent(type, t, { pointerId, pointerType: "touch", x, y, pressure: 0, buttons: type === "pointerup" ? 0 : 1 }) as unknown as Record<string, unknown>;
		if (target) ev.target = target;
		ev.preventDefault = () => void (out.prevented = true);
		ev.stopPropagation = () => void (out.stopped = true);
		const h = el.handlers.get(type);
		if (!h) throw new Error(`missing handler ${type}`);
		h(ev as unknown as Event);
		return out;
	};
	/** A tap; `target` is the element under the finger, set on both events (a plain finger tap has no capture). */
	const tap = (x: number, y: number, t = 10, target?: object) => {
		touch("pointerdown", x, y, t, id, target);
		return touch("pointerup", x, y, t + 80, id, target);
	};
	return { router, touch, tap, fire: w.fire, listening: w.listening, rec, nextId: () => ++id };
}

describe("a tap that selects is kept from the text: the cursor does not move, the keyboard does not rise", () => {
	it("the lift and its trailing touchend, mousedown, mouseup and click are kept from the editor", () => {
		const r = tapRig("consume-line.md");
		const h = routerOn(r);
		try {
			const up = h.tap(ON_G1_LINE.x, ON_G1_LINE.y);
			expect(r.selected(), "premise: the tap selected g1").toEqual(G1);
			expect(up, "the lift prevented and stopped").toEqual({ prevented: true, stopped: true });
			const after = ["touchend", "mousedown", "mouseup", "click"].map((type) => [type, h.fire(type, ON_G1_LINE.x, ON_G1_LINE.y)]);
			expect(after, "each trailing event near the tap kept from the editor (touchend prevented only)").toEqual([
				["touchend", { prevented: true, stopped: false }],
				["mousedown", { prevented: true, stopped: true }],
				["mouseup", { prevented: true, stopped: true }],
				["click", { prevented: true, stopped: true }],
			]);
			expect(h.fire("mousedown", ON_G1_LINE.x, ON_G1_LINE.y), "the click ended the eater: a later mousedown goes through").toEqual({ prevented: false, stopped: false });
		} finally {
			h.router.dispose();
		}
	});

	it("CONTROL: a tap inside the circle reaches the text: the lift and the click go through", () => {
		const r = tapRig("consume-inside.md");
		const h = routerOn(r);
		try {
			const up = h.tap(IN_G1_CIRCLE.x, IN_G1_CIRCLE.y);
			expect(r.selected(), "premise: nothing selected").toEqual([]);
			expect(up, "the lift goes on to the editor").toEqual({ prevented: false, stopped: false });
			expect(["mousedown", "click"].map((type) => h.fire(type, IN_G1_CIRCLE.x, IN_G1_CIRCLE.y)), "the click goes on to the editor").toEqual([
				{ prevented: false, stopped: false },
				{ prevented: false, stopped: false },
			]);
		} finally {
			h.router.dispose();
		}
	});

	it("a router disposed right after a taken tap leaves no eater: no listener stays and a mousedown and click near the tap go through", () => {
		const r = tapRig("consume-dispose.md");
		const h = routerOn(r);
		const FALLOUT = ["touchend", "mousedown", "mouseup", "click"];
		const before = h.listening(FALLOUT);
		h.tap(ON_G1_LINE.x, ON_G1_LINE.y);
		expect(r.selected(), "premise: the tap selected g1").toEqual(G1);
		expect(h.listening(FALLOUT) - before, "premise: the taken tap armed its eater on the window").toBe(FALLOUT.length);
		h.router.dispose();
		expect(h.listening(FALLOUT), "no touchend, mousedown, mouseup or click listener left on the window after the dispose").toBe(0);
		expect(["mousedown", "click"].map((type) => [type, h.fire(type, ON_G1_LINE.x, ON_G1_LINE.y)]), "after the dispose the mousedown and click near the tap go on to the editor").toEqual([
			["mousedown", { prevented: false, stopped: false }],
			["click", { prevented: false, stopped: false }],
		]);
	});

	it("a mousedown far from a taken tap goes through", () => {
		const r = tapRig("consume-far.md");
		const h = routerOn(r);
		try {
			h.tap(ON_G1_LINE.x, ON_G1_LINE.y);
			expect(r.selected(), "premise: the tap selected g1").toEqual(G1);
			expect(h.fire("mousedown", 600, 500), "an event 500 px off is not the tap's").toEqual({ prevented: false, stopped: false });
		} finally {
			h.router.dispose();
		}
	});
});

describe("a second tap soon after a taken tap, near it, is not eaten", () => {
	/** The first tap: on g1's ring's top edge, 40 px left of where ON_G1_LINE taps. */
	const FIRST = { x: 56, y: 70 + SHOWN.dy };
	/** 20 px above FIRST: above g1's padded box, so a tap there lets go of g1, and inside the eater's 24 px. */
	const BESIDE = { x: FIRST.x, y: FIRST.y - 20 };

	it("premise: the second tap's place is above g1's padded box and within the fallout distance of the first", () => {
		const r = tapRig("second-tap-geometry.md");
		const top = r.shownBox(G1).y - SELECTION_GRAB_PAD;
		expect([BESIDE.y < top, Math.hypot(BESIDE.x - FIRST.x, BESIDE.y - FIRST.y) <= TAP_FALLOUT_PX], "[above the padded box, near the first tap]").toEqual([true, true]);
	});

	it("tap g1's ring, then 200 ms later tap just beside it: the second tap's lift, touchend, mousedown and click reach the editor", () => {
		const r = tapRig("second-tap.md");
		const h = routerOn(r);
		try {
			const first = h.tap(FIRST.x, FIRST.y, 10);
			expect([r.selected(), first.prevented], "premise: the first tap selected g1 and was taken").toEqual([G1, true]);
			expect(h.fire("touchend", FIRST.x, FIRST.y), "premise: the first tap's own touchend is prevented").toEqual({ prevented: true, stopped: false });
			h.nextId();
			const second = h.tap(BESIDE.x, BESIDE.y, 210);
			expect([r.selected(), second], "premise: the second tap let go of g1 and went on to the editor").toEqual([[], { prevented: false, stopped: false }]);
			const after = ["touchend", "mousedown", "mouseup", "click"].map((type) => [type, h.fire(type, BESIDE.x, BESIDE.y)]);
			expect(after, "the second tap's touchend and mouse fallout reach the editor, so the cursor moves").toEqual([
				["touchend", { prevented: false, stopped: false }],
				["mousedown", { prevented: false, stopped: false }],
				["mouseup", { prevented: false, stopped: false }],
				["click", { prevented: false, stopped: false }],
			]);
		} finally {
			h.router.dispose();
		}
	});

	it("CONTROL: with no second contact, the first tap's late mousedown and click near it are still kept from the editor", () => {
		const r = tapRig("second-tap-none.md");
		const h = routerOn(r);
		try {
			h.tap(FIRST.x, FIRST.y, 10);
			h.fire("touchend", FIRST.x, FIRST.y);
			expect(["mousedown", "click"].map((type) => h.fire(type, BESIDE.x, BESIDE.y)), "the first tap's fallout, 20 px off").toEqual([
				{ prevented: true, stopped: true },
				{ prevented: true, stopped: true },
			]);
		} finally {
			h.router.dispose();
		}
	});

	it("CONTROL: a second tap on g2's ring soon after is taken itself: its fallout is kept from the editor", () => {
		const r = tapRig("second-tap-taken.md");
		const h = routerOn(r);
		try {
			h.tap(FIRST.x, FIRST.y, 10);
			h.fire("touchend", FIRST.x, FIRST.y);
			h.nextId();
			const second = h.tap(ON_G2_LINE.x, ON_G2_LINE.y, 210);
			expect([r.selected(), second], "premise: the second tap selected g2 and was taken").toEqual([G2, { prevented: true, stopped: true }]);
			expect(["mousedown", "click"].map((type) => h.fire(type, ON_G2_LINE.x, ON_G2_LINE.y)), "the second tap's own fallout").toEqual([
				{ prevented: true, stopped: true },
				{ prevented: true, stopped: true },
			]);
		} finally {
			h.router.dispose();
		}
	});
});

describe("a pan, a pinch and finger ink that start on attached ink never select", () => {
	it("a finger that pans 40 px from g1's ring and comes back selects nothing", () => {
		const r = tapRig("pan-from-line.md");
		const h = routerOn(r);
		try {
			h.touch("pointerdown", ON_G1_LINE.x, ON_G1_LINE.y, 10);
			for (let i = 1; i <= 4; i++) h.touch("pointermove", ON_G1_LINE.x, ON_G1_LINE.y - 10 * i, 10 + 15 * i);
			for (let i = 3; i >= 0; i--) h.touch("pointermove", ON_G1_LINE.x, ON_G1_LINE.y - 10 * i, 130 - 15 * i);
			h.touch("pointerup", ON_G1_LINE.x, ON_G1_LINE.y, 140);
			expect(r.selected(), "a pan is not a tap").toEqual([]);
		} finally {
			h.router.dispose();
		}
	});

	it("two fingers down on g1's and g2's rings, spread 40 px and lifted (a pinch), select nothing", () => {
		const r = tapRig("pinch-from-line.md");
		const h = routerOn(r);
		try {
			h.touch("pointerdown", ON_G1_LINE.x, ON_G1_LINE.y, 10, 41);
			h.touch("pointerdown", ON_G2_LINE.x, ON_G2_LINE.y, 12, 42);
			for (let i = 1; i <= 4; i++) {
				h.touch("pointermove", ON_G1_LINE.x, ON_G1_LINE.y - 5 * i, 12 + 10 * i, 41);
				h.touch("pointermove", ON_G2_LINE.x, ON_G2_LINE.y + 5 * i, 13 + 10 * i, 42);
			}
			h.touch("pointerup", ON_G1_LINE.x, ON_G1_LINE.y - 20, 80, 41);
			h.touch("pointerup", ON_G2_LINE.x, ON_G2_LINE.y + 20, 82, 42);
			expect(r.selected(), "a pinch is not a tap").toEqual([]);
		} finally {
			h.router.dispose();
		}
	});

	it("finger ink armed: a tap on g1's ring draws and selects nothing", () => {
		const r = tapRig("finger-ink-line.md");
		const h = routerOn(r, { fingerInk: true });
		try {
			h.tap(ON_G1_LINE.x, ON_G1_LINE.y);
			expect([h.rec.downs, r.selected()], "[pen downs, selected]: the finger drew").toEqual([1, []]);
		} finally {
			h.router.dispose();
		}
	});
});

describe("the hit runs once, at the lift", () => {
	it("no scan of the ink while the finger moves; one at the lift", () => {
		const r = tapRig("scan-once.md");
		const h = routerOn(r);
		try {
			const before = scans();
			h.touch("pointerdown", ON_G1_LINE.x, ON_G1_LINE.y, 10);
			for (let i = 1; i <= 3; i++) h.touch("pointermove", ON_G1_LINE.x + i, ON_G1_LINE.y, 10 + 10 * i);
			const moving = scans() - before;
			h.touch("pointerup", ON_G1_LINE.x + 3, ON_G1_LINE.y, 60);
			expect([moving, scans() - before], "[scans while moving, scans after the lift]").toEqual([0, 1]);
			expect(r.selected(), "premise: the tap selected g1").toEqual(G1);
		} finally {
			h.router.dispose();
		}
	});

	it("lift to selection within 1.5 ms on a note with a 500-stroke group and 2000 free strokes", () => {
		const strokes = [];
		const members: string[] = [];
		for (let i = 0; i < 500; i++) {
			const id = `m${i}`;
			members.push(id);
			strokes.push(line(id, 10 + (i % 10) * 70, 80 + Math.floor(i / 10) * 30, 60));
		}
		for (let i = 0; i < 2000; i++) strokes.push(line(`f${i}`, 10 + (i % 10) * 70, 1700 + Math.floor(i / 10) * 30, 60));
		const r = tapRig("budget.md", { strokes, attachments: [record("g1", members, "line 3 words")] });
		const target = inlineInk.strokes("budget.md").find((s) => s.id === "m255")!;
		const p = { x: target.points[2]!.x + SHOWN.dx, y: target.points[2]!.y + SHOWN.dy };
		// The first tap reads the member lists once (kept after); the budget is every lift after it.
		r.tapAt(p.x, p.y);
		expect(r.selected(), "premise: the tap selected the whole group").toHaveLength(500);
		const times: number[] = [];
		for (let i = 0; i < 40; i++) {
			r.selection.clear();
			const t0 = performance.now();
			r.tapAt(p.x, p.y);
			times.push(performance.now() - t0);
		}
		times.sort((a, b) => a - b);
		const med = times[Math.floor(times.length / 2)]!;
		console.log(`[attach-tap-budget] median ${med.toFixed(3)} ms, max ${times[times.length - 1]!.toFixed(3)} ms over ${times.length} lifts`);
		expect(r.selected(), "premise: each tap selected the whole group").toHaveLength(500);
		expect(med, "the lift's median time to the selection, ms").toBeLessThanOrEqual(1.5);
	});
});

describe("one group selected, a tap in a gap inside its box keeps it and is kept from the text", () => {
	it("a tap between the group's strokes, inside its box, keeps the group selected and the overlay takes it", () => {
		const r = tapRig("gap-keep.md");
		r.selection.selectExactly(G1);
		r.redraw();
		const answer = r.tapAt(IN_G1_CIRCLE.x, IN_G1_CIRCLE.y);
		expect([r.selected(), answer === true], "[selected, taken]").toEqual([G1, true]);
	});

	it("through the router: the lift and the click that follows are kept from the editor, so the cursor does not move", () => {
		const r = tapRig("gap-consume.md");
		r.selection.selectExactly(G1);
		r.redraw();
		const h = routerOn(r);
		try {
			const up = h.tap(IN_G1_CIRCLE.x, IN_G1_CIRCLE.y);
			expect(r.selected(), "the group stays selected").toEqual(G1);
			expect(up, "the lift prevented and stopped").toEqual({ prevented: true, stopped: true });
			expect(["mousedown", "click"].map((type) => h.fire(type, IN_G1_CIRCLE.x, IN_G1_CIRCLE.y)), "the click kept from the editor").toEqual([
				{ prevented: true, stopped: true },
				{ prevented: true, stopped: true },
			]);
		} finally {
			h.router.dispose();
		}
	});

	it("CONTROL: a lasso of free ink, a tap in a gap inside its box keeps it and the tap goes on to the text", () => {
		const r = tapRig("gap-free.md", { strokes: [...noteStrokes(), ring("loose", 300, 500, 160, 36)] });
		r.selection.selectExactly(["loose"]);
		r.redraw();
		const answer = r.tapAt(440, 518);
		expect([r.selected(), answer === true], "[selected, taken]").toEqual([["loose"], false]);
	});

	it("CONTROL: a tap just outside the group's padded box lets go and goes on to the text", () => {
		const r = tapRig("gap-outside.md");
		r.selection.selectExactly(G1);
		r.redraw();
		const b = r.shownBox(G1);
		const answer = r.tapAt(b.x + b.width + 8 + 6, b.y + b.height / 2);
		expect([r.selected(), answer === true], "[selected, taken]").toEqual([[], false]);
	});
});

/**
 * A Live Preview element under the finger: its tag, classes, input type and parent. closest() walks up the parents and
 * matches the simple selectors a tap check can name (tag, .class, tag.class, tag[type="x"], joined by commas). A selector
 * it cannot read throws, so a check naming something this stub does not model fails loudly instead of matching nothing.
 */
interface LiveEl { tagName: string; classes: string[]; type?: string; parentElement: LiveEl | null; closest(sel: string): LiveEl | null }
function liveEl(tag: string, classes: string[] = [], parent: LiveEl | null = null, type?: string): LiveEl {
	const matches = (n: LiveEl, part: string): boolean => {
		const m = /^([a-z]*)((?:\.[\w-]+)*)(?:\[type="(\w+)"\])?$/.exec(part.trim());
		if (!m || part.trim() === "") throw new Error(`stub cannot read selector part "${part}"`);
		const [, t, cls, ty] = m;
		if (t && n.tagName.toLowerCase() !== t) return false;
		if (cls && !cls.split(".").filter(Boolean).every((c) => n.classes.includes(c))) return false;
		if (ty && n.type !== ty) return false;
		return true;
	};
	const el: LiveEl = {
		tagName: tag.toUpperCase(), classes, type, parentElement: parent,
		closest(sel: string) {
			const parts = sel.split(",");
			for (let n: LiveEl | null = el; n; n = n.parentElement) if (parts.some((p) => matches(n!, p))) return n;
			return null;
		},
	};
	return el;
}
/** A line of the note in Live Preview, as the editor renders it. */
const cmLine = () => liveEl("div", ["cm-line"], liveEl("div", ["cm-content"]));
/** The task checkbox Live Preview draws for "- [ ]". */
const checkbox = () => liveEl("input", ["task-list-item-checkbox"], liveEl("label", ["task-list-label"], cmLine()), "checkbox");

describe("one group selected, a tap in a gap on a checkbox, link, tag or embed reaches it and the group stays selected", () => {
	it("a tap on a task checkbox inside the group's box goes on to the checkbox, and the group stays selected", () => {
		const r = tapRig("gap-checkbox.md");
		r.selection.selectExactly(G1);
		r.redraw();
		const answer = r.tapAt(IN_G1_CIRCLE.x, IN_G1_CIRCLE.y, { target: checkbox() });
		expect([r.selected(), answer === true], "[selected, taken]").toEqual([G1, false]);
	});

	it("a tap on an internal link, an external link, a tag or an embed, or on text inside one, goes on to it", () => {
		const line = cmLine();
		const embed = liveEl("div", ["internal-embed", "image-embed"], line);
		const targets: [string, LiveEl][] = [
			["internal link", liveEl("span", ["cm-hmd-internal-link"], line)],
			["text inside an internal link", liveEl("span", ["cm-underline"], liveEl("span", ["cm-hmd-internal-link"], line))],
			["external link text", liveEl("span", ["cm-link"], line)],
			["external link url", liveEl("span", ["cm-url"], line)],
			["rendered link", liveEl("a", ["external-link"], line)],
			["tag", liveEl("span", ["cm-hashtag", "cm-hashtag-end"], line)],
			["embed", embed],
			["image inside an embed", liveEl("img", [], embed)],
		];
		const got = targets.map(([name, target]) => {
			const r = tapRig(`gap-${name.replace(/ /g, "-")}.md`);
			r.selection.selectExactly(G1);
			r.redraw();
			const answer = r.tapAt(IN_G1_CIRCLE.x, IN_G1_CIRCLE.y, { target });
			return [name, r.selected(), answer === true];
		});
		expect(got, "[target, selected, taken]").toEqual(targets.map(([name]) => [name, G1, false]));
	});

	it("CONTROL: a tap on plain text inside the group's box is still kept from the text, the group selected", () => {
		const r = tapRig("gap-plain-text.md");
		r.selection.selectExactly(G1);
		r.redraw();
		const answer = r.tapAt(IN_G1_CIRCLE.x, IN_G1_CIRCLE.y, { target: liveEl("span", ["cm-strong"], cmLine()) });
		expect([r.selected(), answer === true], "[selected, taken]").toEqual([G1, true]);
	});

	it("CONTROL: a target with no closest (a text node or a bare object) is plain text: kept from the text", () => {
		const r = tapRig("gap-no-closest.md");
		r.selection.selectExactly(G1);
		r.redraw();
		const answer = r.tapAt(IN_G1_CIRCLE.x, IN_G1_CIRCLE.y, { target: { nodeType: 3 } });
		expect([r.selected(), answer === true], "[selected, taken]").toEqual([G1, true]);
	});

	it("through the router: a tap on the checkbox, the lift and its click go on to the editor, and the group stays selected", () => {
		const r = tapRig("gap-checkbox-router.md");
		r.selection.selectExactly(G1);
		r.redraw();
		const h = routerOn(r);
		try {
			const up = h.tap(IN_G1_CIRCLE.x, IN_G1_CIRCLE.y, 10, checkbox());
			expect(r.selected(), "the group stays selected").toEqual(G1);
			expect(up, "the lift goes on to the editor").toEqual({ prevented: false, stopped: false });
			expect(["mousedown", "click"].map((type) => h.fire(type, IN_G1_CIRCLE.x, IN_G1_CIRCLE.y)), "the click goes on to the checkbox").toEqual([
				{ prevented: false, stopped: false },
				{ prevented: false, stopped: false },
			]);
		} finally {
			h.router.dispose();
		}
	});

	it("CONTROL: through the router, a tap on plain text in the gap is still kept from the editor", () => {
		const r = tapRig("gap-plain-router.md");
		r.selection.selectExactly(G1);
		r.redraw();
		const h = routerOn(r);
		try {
			const up = h.tap(IN_G1_CIRCLE.x, IN_G1_CIRCLE.y, 10, liveEl("span", [], cmLine()));
			expect([r.selected(), up], "[selected, lift]").toEqual([G1, { prevented: true, stopped: true }]);
		} finally {
			h.router.dispose();
		}
	});
});
