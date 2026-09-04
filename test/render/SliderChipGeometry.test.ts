/**
 * The slider chip, MEASURED.
 *
 * `MobileTools.test.ts` already pins the property that is supposed to make
 * the chip constant-width - every label is the same run of digit-width
 * glyphs - and says so honestly in its own header: "There is no layout in
 * this suite, so this cannot measure a rendered pop."
 *
 * This file measures it. Same code path, same stylesheet, a real engine
 * laying it out. It exists because two defects walked past the text-matching
 * suite: `min-width: 5ch`, which is below the chip's own border-box width and
 * would have shipped as a no-op, and `tabular-nums` under Georgia, which the
 * engine declines because Georgia has no `tnum` feature.
 *
 * Run: npm run test:render. Deliberately NOT in `npx vitest run` - see
 * `harness.ts` for what this can and cannot answer, and the branch report for
 * what that split trades.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright";
import {
	INJECTED,
	SLIDERS,
	THEME_CASES,
	declaredChipMinWidth,
	distinct,
	launch,
	openStrip,
	stylesCss,
} from "./harness";

let browser: Browser;
beforeAll(async () => {
	browser = await launch();
});
afterAll(async () => {
	await browser?.close();
});

describe("the harness itself", () => {
	it("renders the chip under the injected box-sizing reset, not by luck", async () => {
		// The parameter the 5ch mistake got wrong. Obsidian's app.css applies
		// the reset; styles.css does not, so it is supplied here - and checked,
		// because an injected value nobody reads back is a guess.
		const h = await openStrip(browser, { theme: THEME_CASES[0]! });
		const probe = await h.floor("Eraser size", "0px");
		expect(probe.boxSizing).toBe("border-box");
		await h.close();
	});

	it("actually injected styles.css, rather than an empty string", async () => {
		// Vitest empties a `.css` import unless it matches css.include, and a
		// `?raw` id still ends in `.css?raw`. An emptied stylesheet renders a
		// chip with browser defaults and no borders, which would sail through
		// "one width" while measuring nothing at all.
		const css = stylesCss();
		expect(css.length).toBeGreaterThan(1000);
		expect(css).toContain(".handwriting-slider-val");
		const h = await openStrip(browser, { theme: THEME_CASES[0]! });
		const s = await h.sweep("Eraser size");
		// Padding and border from the rule, not from nothing: the chip has to
		// be wider than the text it holds.
		expect(s.widths[0]!).toBeGreaterThan(s.inheritedWidths[0]!);
		await h.close();
	});

	it("pins the chip's family to the injected --font-monospace", async () => {
		// If this resolved to the page font instead, every assertion below
		// would be measuring the defect and calling it a pass.
		const h = await openStrip(browser, { theme: THEME_CASES[1]! });
		const sweep = await h.sweep("Pen size");
		expect(sweep.chipFont).toContain("monospace");
		expect(sweep.chipFont).not.toContain("Georgia");
		expect(sweep.pageFont).toContain("Georgia");
		expect(INJECTED.loadBearing["--font-monospace"]).toBe("monospace");
		await h.close();
	});

	it("walks each slider's whole range at its own grain", async () => {
		const h = await openStrip(browser, { theme: THEME_CASES[0]! });
		for (const aria of SLIDERS) {
			const s = await h.sweep(aria);
			expect(s.max).toBeGreaterThan(s.min);
			expect(s.step).toBeGreaterThan(0);
			// The walk has to have happened and have crossed the place the
			// width used to change - a whole number for the pen, 9 -> 10 for
			// the other two.
			expect(s.labels.length).toBeGreaterThan(20);
			expect(s.labels.some((l) => l.includes("1"))).toBe(true);
			// A display:none pop measures zero for everything, which would
			// satisfy "one width" perfectly.
			expect(Math.min(...s.widths)).toBeGreaterThan(0);
		}
		await h.close();
	});
});

describe("the value chip holds ONE rendered width across each slider's range", () => {
	for (const theme of THEME_CASES) {
		for (const aria of SLIDERS) {
			it(`${aria}, interface font ${theme.name}`, async () => {
				const h = await openStrip(browser, { theme });
				const s = await h.sweep(aria);

				// Precondition, both ways. A case only proves something if the
				// SAME labels really do render unevenly with nothing pinning
				// the family - otherwise a missing Georgia, or a slider whose
				// labels never need padding, passes for nothing at all.
				const uneven = distinct(s.inheritedWidths).length > 1;
				expect(
					uneven,
					uneven
						? `${theme.name} renders ${aria}'s labels unevenly and the ` +
							`case list says it does not - the list is measured, update it`
						: `${theme.name} was supposed to render ${aria}'s labels ` +
							`unevenly and did not, so this case proves nothing`
				).toBe(theme.unevenSliders.includes(aria));

				// The assertion the judder fix actually needs.
				expect(distinct(s.widths)).toHaveLength(1);
				await h.close();
			});
		}
	}
});

describe("the two declarations on the chip do different jobs - measured, not assumed", () => {
	const FIGURE_SPACE = " ";
	const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
	const TABULAR = "tabular-nums";

	it("Georgia: the digits differ, so tabular-nums cannot save the chip", async () => {
		// Rule 3 of the 1.4.9 design doc, measured: a CSS declaration is a
		// request. Georgia has old-style figures and no `tnum` feature, so
		// asking for tabular-nums changes nothing and the digits stay unequal.
		const h = await openStrip(browser, { theme: THEME_CASES[1]! });
		const plain = await h.glyphs([...DIGITS, FIGURE_SPACE]);
		const tabular = await h.glyphs([...DIGITS, FIGURE_SPACE], TABULAR);
		console.log("Georgia 11px, normal: ", JSON.stringify(plain));
		console.log("Georgia 11px, tabular:", JSON.stringify(tabular));
		expect(new Set(DIGITS.map((d) => plain[d]!)).size).toBeGreaterThan(1);
		// The request was made and declined: the widths are unchanged.
		for (const d of DIGITS) expect(tabular[d]).toBeCloseTo(plain[d]!, 3);
		// So the family pin is the only thing standing between this theme and
		// a chip that changes width.
	});

	it("Arial: the digits agree, and tabular-nums is what suppresses the 11 kern", async () => {
		// The other half, and it is not the half anyone expected. Arial's
		// digits are all one advance, so `constantWidthLabel`'s padding does
		// hold - EXCEPT that Arial kerns the pair `11`, which shortens exactly
		// one label out of the eraser's 62. Asking for tabular-nums turns the
		// kern off and the set goes even again. On this face the family pin is
		// belt to `font-variant-numeric`'s braces; on Georgia it is the only
		// thing holding the chip up.
		const h = await openStrip(browser, { theme: THEME_CASES[0]! });
		const samples = [...DIGITS, FIGURE_SPACE, `${FIGURE_SPACE}3px`, "10px", "11px"];
		const plain = await h.glyphs(samples);
		const tabular = await h.glyphs(samples, TABULAR);
		console.log("Arial 11px, normal: ", JSON.stringify(plain));
		console.log("Arial 11px, tabular:", JSON.stringify(tabular));
		expect(new Set(DIGITS.map((d) => plain[d]!)).size).toBe(1);
		expect(plain[FIGURE_SPACE]).toBeCloseTo(plain["0"]!, 2);
		// The kern, in a label the eraser really produces.
		expect(plain["11px"]!).toBeLessThan(plain["10px"]!);
		// And the request being honoured, which is the difference from Georgia.
		expect(tabular["11px"]).toBeCloseTo(tabular["10px"]!, 3);
		expect(tabular[`${FIGURE_SPACE}3px`]).toBeCloseTo(tabular["10px"]!, 3);
	});
});

describe("a min-width floor that does not bind is worthless", () => {
	/**
	 * `5ch` was proposed for this chip, measured under content-box by
	 * mistake, and rejected on reasoning rather than by a test. Both halves
	 * are pinned here: the floor is inert on the real element, and it is
	 * inert BECAUSE of the box model - so the next person who measures it the
	 * old way can see the two answers side by side.
	 */
	it("5ch is a no-op on the real chip, and binds only under content-box", async () => {
		const h = await openStrip(browser, { theme: THEME_CASES[0]! });
		const borderBox = await h.floor("Eraser size", "5ch");
		expect(borderBox.boxSizing).toBe("border-box");
		expect(borderBox.binds).toBe(false);
		expect(borderBox.floored).toBeCloseTo(borderBox.natural, 2);

		const contentBox = await h.floor("Eraser size", "5ch", "content-box");
		expect(contentBox.boxSizing).toBe("content-box");
		expect(contentBox.binds).toBe(true);
		await h.close();
	});

	it("the binding check can say yes - a floor above the natural width moves it", async () => {
		// The positive control. A detector that can only ever answer "no" is
		// the green-that-proves-nothing this facility exists to prevent.
		const h = await openStrip(browser, { theme: THEME_CASES[0]! });
		const p = await h.floor("Eraser size", "12ch");
		expect(p.binds).toBe(true);
		expect(p.floored).toBeGreaterThan(p.natural);
		await h.close();
	});

	it("any min-width styles.css declares on the chip MUST bind", async () => {
		// The live guard. Today the rule declares none, so this asserts the
		// absence and nothing else; the moment someone adds one, it has to
		// change a rendered width or this goes red. The two tests above are
		// what keep it from being a guard that cannot fail.
		const declared = declaredChipMinWidth(stylesCss());
		if (declared === null) {
			expect(declared).toBeNull();
			return;
		}
		const h = await openStrip(browser, { theme: THEME_CASES[0]! });
		for (const aria of SLIDERS) {
			const p = await h.floor(aria, declared);
			expect(
				p.binds,
				`min-width: ${declared} does nothing to ${aria}'s chip ` +
					`(natural ${p.natural.toFixed(3)}px, floored ${p.floored.toFixed(3)}px, ` +
					`${p.boxSizing}) - it is a no-op, not a fix`
			).toBe(true);
		}
		await h.close();
	});
});
