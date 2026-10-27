/**
 * A pen contact guards the page it is writing on, and nothing else.
 *
 * Alan, 2026-09-05: "i cant poke another note to switch while my pen eraser
 * end is touching the screen". The ownership guard was on the window with no
 * target test at all, so a finger poke anywhere in the app was eaten as the
 * claimed pen's mouse-compat fallout until the pen lifted.
 *
 * Three things are pinned here, and the third is the one that matters. The
 * predicate's own table, the containment test's awkward inputs, and - by
 * source, because no unit test can see a listener's ORDER - that the guard
 * asks the predicate BEFORE it calls preventDefault. A containment test that
 * runs after the swallow is not a fix, and the router's own tests would pass
 * either way.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { codeOnly } from "../CodeOnly";
import {
	GUARD_ROOT_SELECTORS,
	penGuardEatsEvent,
	penGuardReachesTarget,
	penGuardRoot,
} from "./PenGuardReach";
import routerSrc from "./InlinePenRouter.ts?raw";
import { harness, installFakeWindow, penEvent } from "../../test/routerHarness";

describe("penGuardEatsEvent - the four combinations", () => {
	// The pen's presence is the same either way: a nib on the glass or a hand
	// holding it just above. What differs is only WHERE the poke landed.
	it("inside the surface, with an eraser or tip contact live: eaten", () => {
		expect(
			penGuardEatsEvent({
				targetInsideSurface: true,
				penContactLive: true,
				penHoverLive: false,
			})
		).toBe(true);
	});

	it("inside the surface, with only a hover live: eaten", () => {
		expect(
			penGuardEatsEvent({
				targetInsideSurface: true,
				penContactLive: false,
				penHoverLive: true,
			})
		).toBe(true);
	});

	it("OUTSIDE the surface, with a contact live: not eaten - this is alan's bug", () => {
		expect(
			penGuardEatsEvent({
				targetInsideSurface: false,
				penContactLive: true,
				penHoverLive: false,
			})
		).toBe(false);
	});

	it("OUTSIDE the surface, with a hover live: not eaten either", () => {
		expect(
			penGuardEatsEvent({
				targetInsideSurface: false,
				penContactLive: false,
				penHoverLive: true,
			})
		).toBe(false);
	});

	it("no pen anywhere near: nothing is eaten, in or out", () => {
		const dead = { penContactLive: false, penHoverLive: false };
		expect(penGuardEatsEvent({ targetInsideSurface: true, ...dead })).toBe(false);
		expect(penGuardEatsEvent({ targetInsideSurface: false, ...dead })).toBe(false);
	});

	it("reach beats presence: both kinds of pen presence lose to a target elsewhere", () => {
		expect(
			penGuardEatsEvent({
				targetInsideSurface: false,
				penContactLive: true,
				penHoverLive: true,
			})
		).toBe(false);
	});
});

// ---- containment ------------------------------------------------------------

/** A node the DOM can place, without jsdom. */
function node(nodeType: number) {
	return { nodeType } as unknown as Node;
}

/** A root that holds exactly the nodes handed to it. */
function root(...held: unknown[]) {
	return {
		contains: (n: unknown) => held.includes(n),
	} as unknown as HTMLElement;
}

describe("penGuardReachesTarget", () => {
	it("places an element inside the surface", () => {
		const target = node(1);
		expect(penGuardReachesTarget(root(target), target)).toBe(true);
	});

	it("places an element in another pane outside it - the file explorer, a tab", () => {
		const inside = node(1);
		const elsewhere = node(1);
		expect(penGuardReachesTarget(root(inside), elsewhere)).toBe(false);
	});

	it("places a TEXT node, rather than treating it as unplaceable", () => {
		// `selectstart` can carry one, and it is on the guarded list. Reading
		// "not an Element" as unknown would widen the guard back over the
		// whole app for that event alone.
		const text = node(3);
		expect(penGuardReachesTarget(root(text), text)).toBe(true);
		expect(penGuardReachesTarget(root(), text)).toBe(false);
	});

	it("keeps a target it cannot place: null, undefined, window, a document", () => {
		// The palm is what this guard is for. It must never hand a contact
		// back merely because it could not work out where the contact was.
		const held = root();
		expect(penGuardReachesTarget(held, null)).toBe(true);
		expect(penGuardReachesTarget(held, undefined)).toBe(true);
		expect(penGuardReachesTarget(held, { addEventListener() {} })).toBe(true); // window
		expect(penGuardReachesTarget(held, node(9))).toBe(true); // Document
		expect(penGuardReachesTarget(held, node(11))).toBe(true); // ShadowRoot
	});

	it("keeps everything when there is no root, or a root that cannot be asked", () => {
		expect(penGuardReachesTarget(null, node(1))).toBe(true);
		expect(penGuardReachesTarget({} as unknown as HTMLElement, node(1))).toBe(true);
	});

	it("a detached element is answered no, the one place this leans open", () => {
		// `contains` cannot tell "elsewhere" from "gone", and an event whose
		// target left the document has nothing left to protect.
		expect(penGuardReachesTarget(root(node(1)), node(1))).toBe(false);
	});
});

// ---- the root the guard measures against ------------------------------------

/** An element whose `closest` answers for a fixed set of selectors. */
function withClosest(answers: Record<string, unknown>) {
	return {
		closest: (sel: string) => answers[sel] ?? null,
	} as unknown as HTMLElement;
}

describe("penGuardRoot", () => {
	it("takes the leaf's content container, so the strip and the backlinks band are inside", () => {
		const leaf = {};
		const el = withClosest({ ".workspace-leaf-content": leaf });
		expect(penGuardRoot(el)).toBe(leaf);
	});

	it("falls back to the source view when there is no leaf around it", () => {
		const view = {};
		const el = withClosest({ ".markdown-source-view": view });
		expect(penGuardRoot(el)).toBe(view);
	});

	it("prefers the leaf when both are there", () => {
		const leaf = {};
		const view = {};
		const el = withClosest({ ".workspace-leaf-content": leaf, ".markdown-source-view": view });
		expect(penGuardRoot(el)).toBe(leaf);
	});

	it("falls back to the scroller itself when nothing matches, or there is no closest", () => {
		const el = withClosest({});
		expect(penGuardRoot(el)).toBe(el);
		const bare = {} as unknown as HTMLElement;
		expect(penGuardRoot(bare)).toBe(bare);
	});

	it("guards the scroller rather than throwing on the claim path", () => {
		const el = {
			closest: () => {
				throw new Error("detached");
			},
		} as unknown as HTMLElement;
		expect(penGuardRoot(el)).toBe(el);
	});

	it("names the leaf container first, since it is the one that covers both surfaces", () => {
		// `leaf.view.containerEl` is what src/main.ts hands PdfInkController,
		// and it is an ancestor of the note's scrollDOM too.
		expect(GUARD_ROOT_SELECTORS[0]).toBe(".workspace-leaf-content");
	});
});

// ---- the eater consults it BEFORE it swallows --------------------------------

describe("the ownership guard asks before it swallows (source)", () => {
	const code = codeOnly(routerSrc);

	it("calls penGuardEatsEvent at all, in code and not in a comment", () => {
		expect(code).toContain("penGuardEatsEvent(");
	});

	it("asks it BEFORE the first preventDefault in armOwnership", () => {
		// The whole fix is an ordering. A containment test that runs after
		// the swallow is not one, and nothing behavioural in this repo can
		// see the difference on a synthetic event that records both.
		const arm = code.indexOf("\tarmOwnership(): void");
		expect(arm, "armOwnership moved or was renamed").toBeGreaterThan(-1);
		const body = code.slice(arm, code.indexOf("\tscheduleOwnershipDisarm(): void", arm));
		const asked = body.indexOf("penGuardEatsEvent(");
		const swallowed = body.indexOf("preventDefault()");
		expect(asked, "armOwnership no longer consults the reach predicate").toBeGreaterThan(-1);
		expect(swallowed, "armOwnership no longer swallows anything").toBeGreaterThan(-1);
		expect(asked).toBeLessThan(swallowed);
	});

	it("feeds it a real target, not a constant", () => {
		expect(code).toContain("penGuardReachesTarget(this.guardRoot, ev.target)");
	});
});

// ---- the real router --------------------------------------------------------

let uninstallWindow: () => void = () => {};
beforeAll(() => {
	uninstallWindow = installFakeWindow();
});
afterAll(() => {
	uninstallWindow();
});

/**
 * A synthetic mouse click carrying a target, the shape the window guard sees.
 * `AbandonStrokeOnSwitch.test.ts` has the targetless version, deliberately
 * left alone: it pins the TIMING rule, and an unplaceable target is kept, so
 * those assertions still measure what they were written for.
 */
function clickOn(target: unknown) {
	let prevented = false;
	let stopped = false;
	const ev = {
		type: "click",
		pointerType: undefined,
		target,
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

describe("an eraser resting on the note does not block the rest of the app", () => {
	it("a poke on another note in the file explorer reaches it", () => {
		const h = harness();
		// Eraser end down and still on the glass: buttons 32 is the eraser.
		h.fire(penEvent("pointerdown", 100, { buttons: 32 }));
		expect(h.router.isStroking).toBe(true);

		const poke = clickOn({ nodeType: 1 }); // a nav item in another leaf
		h.fireWin(poke.ev);
		expect(poke.suppressed, "the eraser ate a tap in another pane").toBe(false);
	});

	it("but the same contact still owns its own surface - palm rejection intact", () => {
		const h = harness();
		h.fire(penEvent("pointerdown", 100, { buttons: 32 }));

		// The harness scroller `contains` only itself, and has no `closest`,
		// so it is its own guard root.
		const onPage = clickOn(h.el);
		h.fireWin(onPage.ev);
		expect(onPage.suppressed, "the guard stopped protecting the page it is writing on").toBe(
			true
		);
	});

	it("and the tail keeps owning the surface after the nib lifts", () => {
		// `contextmenu` and `click` land AFTER pointerup, which is what the
		// 350ms tail is for. Reach must not have shortened it.
		const h = harness();
		h.fire(penEvent("pointerdown", 100, { buttons: 32 }));
		h.fire(penEvent("pointerup", 110, { pressure: 0, buttons: 0 }));
		expect(h.router.isStroking).toBe(false);

		const onPage = clickOn(h.el);
		h.fireWin(onPage.ev);
		expect(onPage.suppressed).toBe(true);

		const elsewhere = clickOn({ nodeType: 1 });
		h.fireWin(elsewhere.ev);
		expect(elsewhere.suppressed).toBe(false);
	});
});
