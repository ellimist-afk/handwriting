/**
 * The render rig's copy of the page guides' rules (pageGuidesCss.ts) is the same text as styles.css's.
 *
 * The rig injects that copy because no rig page loads styles.css, and without it the guides' box is a flex item in
 * `.cm-scroller` that moves the text column (pageGuidesCss.ts says how). A copy that drifts from styles.css would
 * test a box the product does not draw, so this cell reads both files and fails on any difference.
 */
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PAGE_GUIDES_CSS } from "./pageGuidesCss";

const root = fileURLToPath(new URL("../../", import.meta.url));

it("the rig's page guides rules match styles.css, from the box rule through the off rule", () => {
	const css = readFileSync(root + "styles.css", "utf8").replace(/\r\n/g, "\n");
	const box = ".handwriting-page-guides {", off = "body.handwriting-page-guides-off .handwriting-page-guides {";
	expect(css.split(off).length - 1, "the off rule appears once in styles.css").toBe(1);
	const a = css.indexOf(box), b = css.indexOf(off);
	expect(a, "the box rule comes before the off rule").toBeGreaterThanOrEqual(0);
	expect(b, "the off rule comes after the box rule").toBeGreaterThan(a);
	const second = css.indexOf(box, a + 1);
	expect(second < 0 || second > b, "no second box rule between the two").toBe(true);
	expect(PAGE_GUIDES_CSS).toBe(css.slice(a, css.indexOf("}", b) + 1));
	expect(PAGE_GUIDES_CSS).toContain("position: absolute;");
});
