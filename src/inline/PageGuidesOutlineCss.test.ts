/**
 * The page guides' dashed outline as styles.css writes it on the box the overlay places (PageGuides.test.ts holds the
 * box's place and size; test/render/PageGuidesOutline.test.ts reads the same from the computed style and the screen).
 *
 * The line style is in one place on the box rule: the ink (the border token at half strength), the dash (4 px) and
 * the gap (4 px). Three background layers draw every line from those: the left and right side lines (a column the
 * paper's rule wide at each edge, dashed down from the top) and the page ends (a tile a dash and a gap wide and a page
 * tall, its dash in the bottom left corner). The cut class drops the right line only; a preview and the setting off
 * draw nothing.
 */
import { describe, expect, it } from "vitest";
import css from "../../styles.css?raw";

const text = css.replace(/\r\n/g, "\n");
/** The body of the first rule whose selector is exactly `selector` at a line start, comments dropped, whitespace folded. */
function rule(selector: string): string {
	const at = text.indexOf(`\n${selector} {`);
	expect(at, `${selector}: rule present`).toBeGreaterThanOrEqual(0);
	const open = text.indexOf("{", at), close = text.indexOf("\n}", open);
	return text.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim();
}
/** Declarations split at top-level semicolons. */
function decls(body: string): Map<string, string> {
	const m = new Map<string, string>();
	for (const d of body.split(/;(?![^(]*\))/)) { const i = d.indexOf(":"); if (i > 0) m.set(d.slice(0, i).trim(), d.slice(i + 1).trim()); }
	return m;
}
const BOX = ".handwriting-page-guides";
const box = () => decls(rule(BOX));

describe("the line style, one place", () => {
	it("ink: the border token at half strength; dash 4 px; gap 4 px", () => {
		const d = box();
		expect(d.get("--handwriting-page-guide-ink")).toBe("color-mix(in srgb, var(--background-modifier-border) 50%, transparent)");
		expect(d.get("--handwriting-page-guide-dash")).toBe("4px");
		expect(d.get("--handwriting-page-guide-gap")).toBe("4px");
		expect(rule(BOX).match(/\d+%/g), "no other strength in the box rule").toEqual(["50%", "100%", "100%"]);
	});
	it("a side line: dashed from its top, a dash then a gap, in the guides' ink", () => {
		expect(box().get("--handwriting-page-guide-side")).toBe("repeating-linear-gradient(to bottom, var(--handwriting-page-guide-ink) 0px, var(--handwriting-page-guide-ink) var(--handwriting-page-guide-dash), transparent var(--handwriting-page-guide-dash), transparent calc(var(--handwriting-page-guide-dash) + var(--handwriting-page-guide-gap)))");
	});
});

describe("the outline's three layers", () => {
	/** A layer list split at its top-level commas. */
	const layers = (v: string | undefined): string[] => {
		const out: string[] = [];
		let depth = 0, from = 0;
		const s = v ?? "";
		for (let i = 0; i < s.length; i++) {
			if (s[i] === "(") depth++;
			else if (s[i] === ")") depth--;
			else if (s[i] === "," && depth === 0) { out.push(s.slice(from, i).trim()); from = i + 1; }
		}
		out.push(s.slice(from).trim());
		return out;
	};
	it("side lines: the first two layers, at the box's left and right edges, the paper's rule wide, once each, from the top", () => {
		const d = box();
		const img = d.get("background-image") ?? "";
		expect(img.startsWith("var(--handwriting-page-guide-side), var(--handwriting-page-guide-right), "), img).toBe(true);
		expect(d.get("--handwriting-page-guide-right"), "the right line is drawn").toBe("var(--handwriting-page-guide-side)");
		expect(layers(d.get("background-size")).slice(0, 2)).toEqual(["var(--handwriting-paper-rule, 1px) 100%", "var(--handwriting-paper-rule, 1px) 100%"]);
		expect(layers(d.get("background-position")).slice(0, 2), "starting at the top, at each edge").toEqual(["left top", "right top"]);
		expect(layers(d.get("background-repeat")).slice(0, 2)).toEqual(["no-repeat", "no-repeat"]);
		expect(d.has("border-style") || d.has("border") || d.has("border-width"), "no border").toBe(false);
	});
	it("page ends: the third layer, a tile a dash and a gap wide and a page tall, its dash at the bottom left, across and down the box", () => {
		const d = box();
		expect(d.get("background-image"), "the dash: a rule tall at the page's foot, a dash long from the tile's left").toContain(", conic-gradient(from 180deg at var(--handwriting-page-guide-dash) calc(var(--handwriting-page-guide-pitch, 979.2px) - var(--handwriting-paper-rule, 1px)), var(--handwriting-page-guide-ink) 0deg 90deg, transparent 90deg)");
		expect(layers(d.get("background-size"))[2]).toBe("calc(var(--handwriting-page-guide-dash) + var(--handwriting-page-guide-gap)) var(--handwriting-page-guide-pitch, 979.2px)");
		expect(layers(d.get("background-position"))[2], "the first dash at the box's left").toBe("left top");
		expect(layers(d.get("background-repeat"))[2]).toBe("repeat");
	});
	it("the cut class drops the right line and nothing else", () => {
		expect([...decls(rule(`${BOX}.handwriting-page-guides-open`)).entries()]).toEqual([["--handwriting-page-guide-right", "none"]]);
	});
});

describe("pins: nothing drawn in a preview or with the setting off", () => {
	it("a preview blanks every layer", () => {
		expect([...decls(rule(`${BOX}.handwriting-page-guides-previewing`)).entries()]).toEqual([["background-image", "none !important"]]);
	});
	it("the setting off hides the box", () => {
		expect(decls(rule(`body.handwriting-page-guides-off ${BOX}`)).get("display")).toBe("none");
	});
});
