import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launch, openLeaf, type Browser, type BrowserEngine } from "./harness";

describe.each(["chromium", "webkit"] satisfies BrowserEngine[])("toolbar writing visibility in %s", (engine) => {
	let browser: Browser;
	beforeAll(async () => { browser = await launch(engine); }, 120_000);
	afterAll(async () => { await browser?.close(); });

	it.each([false, true])("On preserves visibility, including manual collapse=%s", async (collapsed) => {
		const note = await openLeaf(browser, { header: false, platform: "ios", corner: "top-right", collapsed, width: 393 });
		try {
			await note.page.bringToFront();
			await note.page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
			for (const mode of ["auto", "show", "auto"] as const) {
				await note.page.evaluate(({ mode, collapsed }) => window.__hw.setWritingVisibility(mode, true, collapsed), { mode, collapsed });
				// Auto steps aside by fading and refusing the pen, not by visibility:
				// the element stays visible so the fade never repaints the window.
				await expect.poll(async () => note.page.evaluate((collapsed) => {
					const style = getComputedStyle(document.querySelector<HTMLElement>(collapsed ? ".handwriting-pen-pill" : ".handwriting-mobile-tools")!);
					return { visibility: style.visibility, faded: Number(style.opacity) === 0, hittable: style.pointerEvents !== "none" };
				}, collapsed)).toEqual(mode === "auto"
					? { visibility: "visible", faded: true, hittable: false }
					: { visibility: "visible", faded: false, hittable: true });
				const state = await note.page.evaluate((collapsed) => {
					const strip = document.querySelector<HTMLElement>(".handwriting-mobile-tools")!;
					const pill = document.querySelector<HTMLElement>(".handwriting-pen-pill")!;
					const style = getComputedStyle(collapsed ? pill : strip);
					return { opacity: style.opacity, display: style.display, collapsed: strip.classList.contains("is-collapsed") };
				}, collapsed);
				expect(state.collapsed).toBe(collapsed);
				if (mode === "show") expect(Number(state.opacity)).toBeGreaterThan(0);
				expect(state.display).not.toBe("none");
			}
		} finally { await note.close(); }
	}, 120_000);
});
