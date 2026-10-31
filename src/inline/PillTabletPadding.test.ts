/**
 * The folded pill stays square on a tablet.
 *
 * Obsidian 1.13.7 ships `.is-tablet button:not(.clickable-icon) { padding:
 * 4px 20px }` (test/render/fixtures/obsidian-1.13.7-mobile-button.css). That
 * selector is (0,2,1), so the pill's single-class `padding: 0` lost to it and
 * 40px of horizontal padding stretched the 34px pill sideways while its height
 * held. Measured in chromium against that fixture: 40x34 on `.is-tablet`,
 * 34x34 on `.is-phone` and desktop.
 *
 * The fix is a (0,2,1) rule that ties the host and wins on sheet order, the
 * same mechanism as the colour swatches' tie. A unit test has no layout, so
 * this pins the stylesheet text, as CornerSafeArea.test.ts does.
 */

import { describe, expect, it } from "vitest";
import css from "../../styles.css?raw";

/** Comments hold selector-shaped text; drop them before parsing. */
const bare = css.replace(/\/\*[\s\S]*?\*\//g, " ");

/** The declaration bodies of every rule whose selector list contains `selector`. */
function declarationsFor(selector: string): string[] {
	const out: string[] = [];
	for (const block of bare.match(/[^{}]+\{[^{}]*\}/g) ?? []) {
		const brace = block.indexOf("{");
		const selectors = block.slice(0, brace).split(",").map((s) => s.trim());
		if (selectors.includes(selector)) out.push(block.slice(brace + 1, -1));
	}
	return out;
}

describe("the folded pill on a tablet", () => {
	it("ties the host's tablet button padding with a (0,2,1) padding: 0", () => {
		const bodies = declarationsFor("button.handwriting-pen-pill:not(.clickable-icon)");
		expect(bodies.length, "the tablet padding tie for the pill is missing").toBeGreaterThan(0);
		expect(bodies.join(";")).toMatch(/(?:^|;)\s*padding\s*:\s*0\s*(?:;|$)/);
	});
});
