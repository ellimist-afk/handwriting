import { describe, expect, it } from "vitest";
import css from "../styles.css?raw";
import main from "./main.ts?raw";

function rule(selector: string): string {
	const start = css.indexOf(selector);
	expect(start, `missing ${selector}`).toBeGreaterThanOrEqual(0);
	const open = css.indexOf("{", start);
	const close = css.indexOf("}", open);
	return css.slice(open + 1, close);
}

/*
 * The first case here asserted the canvas page's own light paper and its typed
 * text colour, from `.handwriting-box` and `.handwriting-box.is-editing`. Both
 * rules were deleted with the view, so the claim has no subject. The
 * BOUNDARY half - that the white sheet never reached the inline or PDF
 * surfaces - is the half that still has one, and it is the half that was worth
 * having: it is what a reader of the deleted rules could have broken.
 */
describe("the light page stays inside the dedicated canvas boundary", () => {
	it("does not turn inline notes or PDF overlays into white sheets", () => {
		for (const selector of [
			".markdown-source-view.handwriting-page",
			".handwriting-pdf-ink",
			".handwriting-embed-ink",
		]) {
			const blocks = [...css.matchAll(new RegExp(`${selector.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}[^\\{]*\\{([^}]*)\\}`, "g"))];
			for (const match of blocks) expect(match[1]).not.toMatch(/background(?:-color)?:\s*#fff(?:fff)?/i);
		}
	});
});

describe("the obsolete live-adaptation control is gone without migration", () => {
	it("removes only the row and retains the compatibility key", () => {
		expect(main).not.toContain('name: "Adapt ink colour to the theme"');
		expect(main).toContain("inkAdaptsToTheme: boolean;");
		expect(main).toContain("inkAdaptsToTheme: false,");
		expect(main).toContain("inkAdaptsToTheme: raw?.inkAdaptsToTheme === true,");
		expect(main).toContain('case "inkAdaptsToTheme":');
	});

	it("leaves both export controls present", () => {
		expect(main).toContain('name: "Ink color when exporting"');
		expect(main).toContain('name: "Ink color on PDFs"');
	});
});
