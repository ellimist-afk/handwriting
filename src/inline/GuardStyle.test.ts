/**
 * The standing guard has two halves that must never drift apart: the inline
 * `touch-action: none` on the scroller (cold contacts) and the subtree class
 * that styles.css turns into `none` on every descendant (nested scroll
 * containers re-enable panning in Blink — the backlinks dead band).
 */

import { describe, expect, it } from "vitest";
import css from "../../styles.css?raw";
import { GUARD_SUBTREE_CLASS, armGuardStyle, disarmGuardStyle } from "./GuardStyle";

function fakeScroller(initialTouchAction = "") {
	const classes = new Set<string>();
	const style = { touchAction: initialTouchAction };
	return {
		style,
		setCssStyles: (styles: { touchAction: string }) => {
			style.touchAction = styles.touchAction;
		},
		classList: {
			add: (c: string) => void classes.add(c),
			remove: (c: string) => void classes.delete(c),
		},
		classes,
	};
}

describe("guard style — inline touch-action and subtree class move together", () => {
	it("arming writes none on the scroller AND marks its subtree", () => {
		const el = fakeScroller();
		armGuardStyle(el);
		expect(el.style.touchAction).toBe("none");
		expect(el.classes.has(GUARD_SUBTREE_CLASS)).toBe(true);
	});

	it("writes whatever value the surface asked for", () => {
		// A pdf viewer passes pinch-zoom: single-finger panning stays denied,
		// which is the arbitration a cold pen contact must survive, while the
		// browser keeps two-finger gestures instead of leaking them to the app.
		const el = fakeScroller();
		armGuardStyle(el, "pinch-zoom");
		expect(el.style.touchAction).toBe("pinch-zoom");
		expect(el.classes.has(GUARD_SUBTREE_CLASS)).toBe(true);
	});

	it("disarming restores the saved inline value AND drops the mark", () => {
		const el = fakeScroller("pan-y");
		armGuardStyle(el);
		disarmGuardStyle(el, "pan-y");
		expect(el.style.touchAction).toBe("pan-y");
		expect(el.classes.has(GUARD_SUBTREE_CLASS)).toBe(false);
	});

	it("a scroller that carried no inline value comes back empty", () => {
		const el = fakeScroller();
		armGuardStyle(el);
		disarmGuardStyle(el, "");
		expect(el.style.touchAction).toBe("");
		expect(el.classes.size).toBe(0);
	});

	it("repeated arm / disarm is idempotent", () => {
		const el = fakeScroller();
		armGuardStyle(el);
		armGuardStyle(el);
		expect(el.classes.size).toBe(1);
		disarmGuardStyle(el, "");
		disarmGuardStyle(el, "");
		expect(el.classes.size).toBe(0);
		expect(el.style.touchAction).toBe("");
	});
});

describe("styles.css — the subtree half of the standing guard", () => {
	it("applies touch-action: none to EVERY descendant of a guarded scroller", () => {
		// Universal on purpose: scroll containers cannot be selected by
		// computed style, and the rule is inert for everything that already
		// inherited none from the scroller.
		const rule = new RegExp(`\\.cm-scroller\\.${GUARD_SUBTREE_CLASS}\\s+\\*\\s*\\{([^}]*)\\}`);
		const m = css.match(rule);
		expect(m, "subtree rule present").not.toBeNull();
		expect(m![1]).toMatch(/touch-action:\s*none\s*!important/);
	});

	it("is the only touch-action rule Handwriting puts on editor descendants", () => {
		// An unconditional rule would defeat the touch window (native finger
		// panning after a real pan). Every touch-action mention outside the
		// guarded selector must be on Handwriting's own canvas-era surfaces.
		const blocks = css.match(/[^{}]+\{[^}]*touch-action[^}]*\}/g) ?? [];
		for (const block of blocks) {
			const selector = block.slice(0, block.indexOf("{"));
			if (selector.includes(GUARD_SUBTREE_CLASS)) continue;
			expect(selector, `unguarded touch-action rule: ${selector.trim()}`).not.toMatch(/cm-/);
		}
	});
});
