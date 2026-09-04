/**
 * The floating toolbar parks in a screen corner, and a phone's screen corners
 * are not all reachable: the top edge of a notched iphone is behind the
 * dynamic island and the bottom edge is the home indicator's swipe strip. A
 * control parked there is not merely ugly, it is untappable - the same class
 * of defect as the android notification shade (boox go 6, 2026-08-30), and
 * confirmed on hardware for ios (alan, iphone, 2026-09-02: "it's behind the
 * notch").
 *
 * The fix is an unconditional env() on every corner offset, and it is easy to
 * lose by accident, because three separate blocks re-declare `top`/`bottom`
 * for these elements and the last one to match wins. So this asserts the
 * stylesheet text directly - the pattern GuardStyle.test.ts already uses for
 * rules the code depends on but cannot observe in a unit test.
 *
 * What this canNOT prove: that ios actually reports a non-zero inset in
 * Obsidian's webview. That needs the device. It proves the stylesheet asks
 * for the inset everywhere it must, and that android's shade constant did
 * not get dragged along with it.
 */

import { describe, expect, it } from "vitest";
import css from "../../styles.css?raw";
import { TOOLBAR_CORNERS, toolbarCornerClass } from "./ToolbarCorner";

/** Comments hold commas and selector-shaped text; drop them before parsing. */
const bare = css.replace(/\/\*[\s\S]*?\*\//g, " ");

/** The declaration bodies of every rule whose selector list contains `selector`. */
function declarationsFor(selector: string): string[] {
	const out: string[] = [];
	for (const block of bare.match(/[^{}]+\{[^{}]*\}/g) ?? []) {
		const brace = block.indexOf("{");
		const selectors = block
			.slice(0, brace)
			.split(",")
			.map((s) => s.trim().replace(/\s+/g, " "));
		if (selectors.includes(selector)) out.push(block.slice(brace + 1, -1));
	}
	return out;
}

/** Which physical edge a corner is anchored to, and the inset that edge needs. */
function edgeOf(corner: string): "top" | "bottom" {
	return corner.startsWith("top") ? "top" : "bottom";
}

/**
 * The HORIZONTAL edge, which matters for the same reason and is easier to
 * forget: rotate a notched iphone and the island moves to a side, so
 * inset-top collapses and inset-left/right become the large ones. A fix that
 * wraps only the vertical offsets protects portrait and rotates away.
 */
function sideOf(corner: string): "left" | "right" {
	return corner.endsWith("right") ? "right" : "left";
}

/**
 * Every selector that sets a vertical offset for a corner, and the base
 * offset it is documented to use. The android rules are deliberately absent:
 * they are asserted separately, and they must NOT gain a second inset.
 */
function insetBearingSelectors(cls: string): Array<{ selector: string; base: number }> {
	return [
		// The strip and the pill share this one - both are listed on it.
		{ selector: `.handwriting-mobile-tools.${cls}`, base: 8 },
		{ selector: `.handwriting-pen-pill.${cls}`, base: 8 },
		// The pill re-declares the offset to sit concentric with the corner
		// button it replaces: 11px on desktop, 15px on mobile.
		{ selector: `.handwriting-pen-pill.${cls}`, base: 11 },
		{ selector: `.is-mobile .handwriting-pen-pill.${cls}`, base: 15 },
	];
}

describe("styles.css - toolbar corners clear the phone's unsafe edges", () => {
	for (const corner of TOOLBAR_CORNERS) {
		const cls = toolbarCornerClass(corner);
		const edge = edgeOf(corner);

		const side = sideOf(corner);

		it.each([edge, side])(`${corner}: every rule that sets %s adds the safe-area inset`, (axis) => {
			const seen = new Set<string>();
			for (const { selector } of insetBearingSelectors(cls)) {
				if (seen.has(selector)) continue;
				seen.add(selector);

				const bodies = declarationsFor(selector);
				expect(bodies.length, `rule missing: ${selector}`).toBeGreaterThan(0);

				for (const body of bodies) {
					const decl = body.match(new RegExp(`(?:^|;)\\s*${axis}\\s*:([^;]*)`));
					expect(decl, `${selector} sets no ${axis}`).not.toBeNull();
					// A bare pixel offset here is the bug: it measures from the
					// screen edge, which on a notched phone is behind the chrome.
					expect(
						decl![1],
						`${selector} sets ${axis} from the raw screen edge, not the safe area`
					).toMatch(new RegExp(`env\\(\\s*safe-area-inset-${axis}\\s*,\\s*0px\\s*\\)`));
				}
			}
		});
	}

	it("the inset is unconditional, not gated behind a platform class", () => {
		// env() is 0px wherever no inset is reported, so gating it would add a
		// branch that buys nothing and rots the moment a new platform ships.
		for (const corner of TOOLBAR_CORNERS) {
			const cls = toolbarCornerClass(corner);
			const bodies = declarationsFor(`.handwriting-mobile-tools.${cls}`);
			expect(bodies.length, `base strip rule missing for ${corner}`).toBe(1);
		}
		expect(bare).not.toMatch(/\.handwriting-ios\s+\.handwriting-(mobile-tools|pen-pill)/);
	});

	it("android keeps its notification-shade constants, and only on android", () => {
		// The 48/55 clear a pullable shade, which is an android interaction and
		// NOT a safe-area allowance. If these ever appear on a rule without the
		// android class, ios has been handed 48px it does not want.
		for (const [selector, expected] of [
			[".handwriting-android .handwriting-mobile-tools.handwriting-corner-top-right", 48],
			[".handwriting-android .handwriting-mobile-tools.handwriting-corner-top-left", 48],
			[".handwriting-android .handwriting-pen-pill.handwriting-corner-top-right", 55],
			[".handwriting-android .handwriting-pen-pill.handwriting-corner-top-left", 55],
		] as Array<[string, number]>) {
			const bodies = declarationsFor(selector);
			expect(bodies.length, `android rule missing: ${selector}`).toBeGreaterThan(0);
			const joined = bodies.join(";");
			expect(joined).toMatch(
				new RegExp(`top:\\s*calc\\(\\s*env\\(\\s*safe-area-inset-top\\s*,\\s*0px\\s*\\)\\s*\\+\\s*${expected}px\\s*\\)`)
			);
		}

		// The shade constants live nowhere else: every 48px/55px top offset in
		// the stylesheet must be under .handwriting-android.
		for (const block of bare.match(/[^{}]+\{[^{}]*\}/g) ?? []) {
			const brace = block.indexOf("{");
			const selector = block.slice(0, brace);
			const body = block.slice(brace + 1, -1);
			if (!/top:\s*calc\([^;]*\+\s*(48|55)px/.test(body)) continue;
			expect(selector, `shade constant outside android: ${selector.trim()}`).toMatch(
				/\.handwriting-android\b/
			);
		}
	});
});

/*
 * The slider readout's width is load-bearing: `hangUnder` re-centres the pop
 * from its own offsetWidth, so a chip that changes width moves the pop. The
 * label is padded to a constant character count to stop that, which only
 * works if the characters are constant width. `tabular-nums` asks for that
 * and a font without a `tnum` feature ignores the request silently, so the
 * chip has to pin a font rather than inherit the theme's interface one.
 *
 * This block used to read `css` and take the FIRST matching rule, and both
 * halves of that were defeatable - by exactly the two mistakes the corner
 * rules above already defend against, in the same file:
 *
 *   - COMMENTING THE DECLARATION OUT passed, because the raw stylesheet still
 *     contains the text. `bare` is the stripper the corner assertions have
 *     used all along and it was sitting six lines up;
 *   - A LATER OVERRIDE passed, because `[0]` reads the first block and the
 *     LAST rule to match is the one that wins. That is the hazard this file's
 *     own header names - "three separate blocks re-declare top/bottom for
 *     these elements and the last one to match wins" - and `declarationsFor`
 *     is the answer it already reached for.
 *
 * So this reads `bare` through `declarationsFor` and holds EVERY font-family
 * the chip is given, not the first. All of them must be the monospace var
 * rather than only the last: a chip that names another font anywhere is a
 * chip somebody meant to change, and a rule ordering is a worse thing to rest
 * on than a rule.
 *
 * A rendered-geometry harness that measures the chip for real is being built
 * alongside this. It does not make this redundant - the stylesheet assertion
 * is the cheap first line, and it is the one that says WHICH font was asked
 * for rather than what some engine did about the request.
 */
describe("styles.css - the slider readout pins a font", () => {
	const CHIP = ".handwriting-slider-val";
	/** Monospace by definition; this stylesheet's choice for every readout. */
	const MONO = /^var\(\s*--font-monospace\s*\)$/;

	/** Every font-family declared inside a rule, in source order. */
	function fontFamiliesIn(body: string): string[] {
		return [...body.matchAll(/(?:^|;)\s*font-family\s*:([^;]*)/g)].map((m) => m[1]!.trim());
	}

	/** Every font-family the chip's own rules declare, in source order. */
	function chipFonts(): string[] {
		return declarationsFor(CHIP).flatMap(fontFamiliesIn);
	}

	it("declares a font-family rather than inheriting the theme's", () => {
		expect(declarationsFor(CHIP).length, `${CHIP} rule missing`).toBeGreaterThan(0);
		expect(
			chipFonts().length,
			"the chip inherits the interface font, so a serif theme reintroduces the pop-width judder"
		).toBeGreaterThan(0);
	});

	it("pins one whose digits are equal width, in every rule that sets one", () => {
		const fonts = chipFonts();
		// Length first: with none at all the loop below is vacuous and would
		// pass over a chip that declares no font whatsoever.
		expect(fonts.length).toBeGreaterThan(0);
		for (const font of fonts) {
			expect(font, `${CHIP} is given a font that is not the monospace var`).toMatch(MONO);
		}
	});

	it("nothing anywhere in the stylesheet re-declares the chip's font", () => {
		// The same sweep the android shade constants get above, and for the
		// same reason: `declarationsFor` matches a selector LIST, so a
		// compound or descendant selector - `.is-mobile .handwriting-slider-val`
		// - would override the font from outside its reach.
		for (const block of bare.match(/[^{}]+\{[^{}]*\}/g) ?? []) {
			const brace = block.indexOf("{");
			const selector = block.slice(0, brace);
			if (!selector.includes(CHIP)) continue;
			for (const font of fontFamiliesIn(block.slice(brace + 1, -1))) {
				expect(font, `${CHIP} font re-declared by ${selector.trim()}`).toMatch(MONO);
			}
		}
	});
});
