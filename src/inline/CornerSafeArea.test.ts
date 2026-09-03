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
