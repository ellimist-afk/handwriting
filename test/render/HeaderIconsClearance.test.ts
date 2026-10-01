import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launch, openLeaf, type Browser, type LeafOptions } from "./harness";

let browser: Browser;
beforeAll(async () => { browser = await launch(); }, 120_000);
afterAll(async () => { await browser?.close(); });

describe("note strip beside four header actions", () => {
	it("clears the menu plus scan and grid at desktop and tablet widths", async () => {
		const cases: LeafOptions[] = [
			{ header: false, corner: "top-right", collapsed: false, width: 1200 },
			{ header: false, overlayHeader: true, platform: "android", corner: "top-right", collapsed: false, width: 820 },
		];
		for (const options of cases) {
			const leaf = await openLeaf(browser, options);
			try {
				await leaf.page.evaluate(() => {
					const actions = document.querySelector<HTMLElement>(".view-actions");
					if (!actions) throw new Error("missing view-actions");
					for (const icon of ["scan", "grid-3x-3"]) {
						const action = document.createElement("div");
						action.className = "clickable-icon view-action";
						action.setAttribute("data-icon", icon);
						if (icon === "scan") action.classList.add("handwriting-canvas-action", "is-active");
						action.style.cssText = "width:26px;height:26px;";
						actions.appendChild(action);
					}
				});
				const litColor = await leaf.page.evaluate(() =>
					getComputedStyle(document.querySelector<HTMLElement>(".handwriting-canvas-action")!).color);
				expect(litColor).toBe("rgb(123, 108, 217)");
				await leaf.reapply();
				const probe = await leaf.probe();
				expect(probe.actions.right - probe.actions.left).toBeGreaterThanOrEqual(116);
				expect(probe.wouldOverlap).toBe(false);
				expect(probe.overlaps, `${options.width}px strip covers actions`).toBe(false);
				expect(probe.strip.left).toBeGreaterThanOrEqual(0);
				expect(probe.strip.right).toBeLessThanOrEqual(options.width);
			} finally {
				await leaf.close();
			}
		}
	}, 120_000);
});
