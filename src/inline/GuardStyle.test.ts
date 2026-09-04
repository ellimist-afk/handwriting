/**
 * The standing guard has two halves that must never drift apart: the inline
 * `touch-action: none` on the scroller (cold contacts) and the subtree class
 * that styles.css turns into `none` on every descendant (nested scroll
 * containers re-enable panning in Blink — the backlinks dead band).
 *
 * THE STYLESHEET HALF IS MATCHED AGAINST CODE, NOT AGAINST THE FILE'S TEXT.
 * It used to be matched against raw `styles.css`, and a stylesheet read as
 * text is a DOCUMENT: it carries the rule and the four paragraphs explaining
 * the rule, and a text match cannot tell them apart. Both directions were
 * live here and both were demonstrated on this branch before the change:
 *
 *   - toward a false ALL-CLEAR, and this is the expensive one. The subtree
 *     rule was wrapped in `/* … *\/` — deleted from the cascade, still present
 *     in the file — and not only did all 7 tests here pass, the whole suite
 *     passed: 1830 + 1 expected fail, unchanged. The standing touch guard has
 *     a five-version scar history (v0.12.10, v0.12.12, v0.13.6: cold contacts,
 *     post-touchpad contacts, nested scrollers) and every one of those failure
 *     modes is hardware-only, so a false all-clear here is not caught by
 *     anything else in the tree. Nothing behavioural covers this rule.
 *   - toward a false ALARM, on the second test: the prose above the rule
 *     mentions `touch-action` beside `.cm-scroller`, so a commented-out
 *     example of an unguarded rule reads as an unguarded rule.
 *
 * `codeOnly` (src/CodeOnly.ts) is the same stripper `InkSurfaceRules.test.ts`
 * and `StripPenChrome.test.ts` use, imported rather than copied — two
 * comment-blankers in sibling guards is the divergence these guards exist to
 * catch — and the four fixture tests that pin it against returning its input
 * unchanged live over there and stand over this file too. It blanks to spaces,
 * so offsets and line counts survive and a reported position still means
 * something. `styles.css` contains no `//` sequence at all (verified), so the
 * line-comment half of the stripper cannot over-blank this input.
 *
 * Nothing here reads raw text any more: every assertion in this file asks
 * "is this rule in the cascade", and none asks "is this reason documented".
 * The direction of the change is one-way — matching code can only find FEWER
 * rules than matching the whole document, so no real rule stops being seen;
 * what stops being seen is a rule that was only ever a sentence.
 */

import { describe, expect, it } from "vitest";
import css from "../../styles.css?raw";
import { codeOnly } from "../CodeOnly";
import { GUARD_SUBTREE_CLASS, armGuardStyle, disarmGuardStyle } from "./GuardStyle";

/** The stylesheet's cascade, without the stylesheet's prose. */
const cssCode = codeOnly(css);

/**
 * The two halves of the stylesheet assertion, as pure functions over sheet
 * text, so the fixtures at the bottom can attack them with a string instead
 * of having to comment out the real rule and put it back.
 */
function subtreeRuleBody(sheet: string): string | null {
	const rule = new RegExp(`\\.cm-scroller\\.${GUARD_SUBTREE_CLASS}\\s+\\*\\s*\\{([^}]*)\\}`);
	return codeOnly(sheet).match(rule)?.[1] ?? null;
}

function unguardedEditorTouchActionSelectors(sheet: string): string[] {
	const blocks = codeOnly(sheet).match(/[^{}]+\{[^}]*touch-action[^}]*\}/g) ?? [];
	return blocks
		.map((block) => block.slice(0, block.indexOf("{")))
		.filter((selector) => !selector.includes(GUARD_SUBTREE_CLASS))
		.filter((selector) => /cm-/.test(selector));
}

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
		//
		// Read from the cascade, not from the file: commenting this rule out
		// deletes it from the browser and leaves it in the text, and that
		// passed here — and passed the whole suite — until the match moved to
		// `codeOnly`.
		const body = subtreeRuleBody(css);
		expect(body, "subtree rule present in the cascade, not merely in the file").not.toBeNull();
		expect(body!).toMatch(/touch-action:\s*none\s*!important/);
	});

	it("is the only touch-action rule Handwriting puts on editor descendants", () => {
		// An unconditional rule would defeat the touch window (native finger
		// panning after a real pan). Every touch-action mention outside the
		// guarded selector must be on Handwriting's own canvas-era surfaces.
		//
		// Also read from the cascade: the four paragraphs above the subtree
		// rule discuss `touch-action` on `.cm-scroller`, so on raw text a
		// commented-out example is indistinguishable from a live rule. That
		// direction is a false alarm rather than a false all-clear, but it is
		// the same fault and it is fixed by the same call.
		expect(unguardedEditorTouchActionSelectors(css)).toEqual([]);
	});
});

/**
 * Fixtures. The two functions above are attacked directly with sheet text, so
 * these run without touching `styles.css` — and they are the reason a green
 * run above is evidence. A guard whose only proof is that it currently passes
 * proves nothing; see the failure-family section of `1.4.9-design.md`.
 */
describe("the stylesheet reader matches the cascade, not the document", () => {
	const RULE = `.cm-scroller.${GUARD_SUBTREE_CLASS} * {\n\ttouch-action: none !important;\n}\n`;

	it("finds the rule when it is really there", () => {
		// Anti-vacuity. A reader that found nothing anywhere would pass every
		// negative fixture below while proving the opposite of what they claim.
		expect(subtreeRuleBody(RULE)).toMatch(/touch-action:\s*none\s*!important/);
	});

	it("does NOT accept a commented-out copy of the rule", () => {
		// THE DEFEAT, verbatim: the exact edit that left 1830 tests green.
		expect(subtreeRuleBody(`/*\n${RULE}*/\n`)).toBeNull();
	});

	it("does NOT accept the rule spelled out inside prose that explains it", () => {
		// How it would arrive in practice: nobody comments a rule out and
		// leaves it. Somebody deletes it and the paragraph above it stays,
		// still quoting the selector and the declaration it used to carry.
		const prose =
			`/*\n * The router toggles this class in lock-step with the inline style, and\n` +
			` * the sheet turns it into\n * .cm-scroller.${GUARD_SUBTREE_CLASS} * { touch-action: none !important; }\n * on every descendant.\n */\n`;
		expect(subtreeRuleBody(prose)).toBeNull();
	});

	it("does not report a commented-out unguarded rule as a live one", () => {
		expect(unguardedEditorTouchActionSelectors(`/*\n.cm-scroller { touch-action: pan-y; }\n*/\n`)).toEqual(
			[]
		);
	});

	it("still reports a real unguarded rule on an editor descendant", () => {
		// The other anti-vacuity half: blanking comments must not have blanked
		// the thing this test is for.
		expect(unguardedEditorTouchActionSelectors(`.cm-content { touch-action: pan-y; }\n`)).toEqual([
			".cm-content ",
		]);
	});
});
