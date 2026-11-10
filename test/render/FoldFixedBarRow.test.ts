/**
 * THE ALWAYS-SHOWN BUTTONS IN SETTINGS ARE ONE ROW IN A PILL.
 *
 * Settings > Toolbar buttons draws the six buttons that never fold (pen,
 * highlighter, eraser, lasso, trash, undo) as a copy of the toolbar. The
 * toolbar's row, fill, border and rounding live on its inner face, so a copy
 * that puts its buttons straight into the outer element gets a block: the six
 * stack in one column on a bare background. The unit suite has no layout, so
 * whether they sit side by side is only a real engine's answer.
 *
 * Read: each button's box, and the computed look of the box around them.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright";
import { launch, openFoldOrder } from "./harness";

let browser: Browser;
beforeAll(async () => {
	browser = await launch();
});
afterAll(async () => {
	await browser?.close();
});

describe("the always-shown buttons in settings", () => {
	it("sit side by side in one row, inside an opaque pill with no shadow", async () => {
		const h = await openFoldOrder(browser, { realStrip: true, modalWidth: 700, viewport: 1400 });
		try {
			const p = await h.page.evaluate(() => {
				const btns = Array.from(document.querySelectorAll<HTMLElement>(".handwriting-fold-fixed-btn"));
				const holder = btns[0]?.parentElement ?? null;
				const cs = holder ? getComputedStyle(holder) : null;
				return {
					boxes: btns.map((b) => {
						const r = b.getBoundingClientRect();
						return { x: r.left, y: r.top + r.height / 2, w: r.width };
					}),
					holderClass: holder?.className ?? "",
					display: cs?.display ?? "",
					background: cs?.backgroundColor ?? "",
					radius: cs?.borderTopLeftRadius ?? "",
					opacity: cs?.opacity ?? "",
					shadow: cs?.boxShadow ?? "",
				};
			});
			// eslint-disable-next-line no-console
			console.log(`fixed bar: ${JSON.stringify(p)}`);
			expect(p.boxes, "premise: six always-shown buttons").toHaveLength(6);
			expect(p.boxes.every((b) => b.w > 0), "premise: every button has a width").toBe(true);

			const ys = p.boxes.map((b) => b.y);
			expect(Math.max(...ys) - Math.min(...ys), "all six centres on one line").toBeLessThanOrEqual(1);
			for (let i = 1; i < p.boxes.length; i++) {
				expect(p.boxes[i]!.x, `button ${i + 1} sits right of button ${i}`).toBeGreaterThan(p.boxes[i - 1]!.x);
			}

			expect(p.display, "the box around the buttons lays out a row").toBe("flex");
			expect(p.background, "the pill has a fill").not.toBe("rgba(0, 0, 0, 0)");
			expect(p.radius, "the pill is rounded").not.toBe("0px");
			expect(p.opacity, "the settings copy is fully opaque").toBe("1");
			expect(p.shadow, "the settings copy has no shadow").toBe("none");
		} finally {
			await h.close();
		}
	});
});
