import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launch, openLeaf, type Browser } from "./harness";

/**
 * The lit Infinite canvas header icon reads as lit against its plain neighbours.
 * Under Minimal (dark) the accent colour on the lit icon was dimmer than the plain
 * icons (colour ratio 1.15) on a box nearly the page colour, so the icon looked unlit
 * although is-active was set. The lit icon is now an accent-filled box with the
 * theme's on-accent colour, the same look as the plugin toolbar's lit buttons, and
 * it follows the theme's accent.
 */
const here = (rel: string): string => new URL(rel, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const MINIMAL = readFileSync(here("./fixtures/minimal-9.0.2-theme.css"), "utf8");
const OBSIDIAN_HEADER_ICON = readFileSync(here("./fixtures/obsidian-1.13.7-header-icon-rules.css"), "utf8");

let browser: Browser;
beforeAll(async () => { browser = await launch(); }, 120_000);
afterAll(async () => { await browser?.close(); });

const lum = (c: string): number => {
	const m = c.match(/[\d.]+/g)!.map(Number);
	const f = (v: number): number => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
	return 0.2126 * f(m[0]!) + 0.7152 * f(m[1]!) + 0.0722 * f(m[2]!);
};
const ratio = (a: string, b: string): number => {
	const [hi, lo] = [lum(a), lum(b)].sort((p, q) => q - p);
	return (hi! + 0.05) / (lo! + 0.05);
};

const ARMS = [
	["Minimal dark", [MINIMAL, OBSIDIAN_HEADER_ICON], true],
	["Minimal light", [MINIMAL, OBSIDIAN_HEADER_ICON], false],
	["default theme", [OBSIDIAN_HEADER_ICON], true],
] as const;

describe.each(ARMS)("lit canvas icon, %s", (_name, hostCss, dark) => {
	it("is an accent-filled box with the on-accent icon, and the plain icons stay plain", async () => {
		const leaf = await openLeaf(browser, { header: false, corner: "top-right", collapsed: false, width: 1200, hostCss: [...hostCss] });
		try {
			const r = await leaf.page.evaluate((d) => {
				document.body.classList.toggle("theme-dark", d);
				document.body.classList.toggle("theme-light", !d);
				const actions = document.querySelector<HTMLElement>(".view-actions")!;
				for (const icon of ["scan", "grid-3x-3"]) {
					const a = document.createElement("div");
					a.className = "clickable-icon view-action";
					a.setAttribute("data-icon", icon);
					a.style.cssText = "width:26px;height:26px;";
					if (icon === "scan") a.classList.add("handwriting-canvas-action", "is-active");
					actions.appendChild(a);
				}
				const colorOf = (v: string): string => {
					const s = document.createElement("span");
					s.style.color = `var(${v})`;
					document.body.appendChild(s);
					return getComputedStyle(s).color;
				};
				const lit = document.querySelector<HTMLElement>(".handwriting-canvas-action")!;
				const plain = document.querySelector<HTMLElement>('[data-icon="grid-3x-3"]')!;
				return {
					accent: colorOf("--interactive-accent"),
					onAccent: colorOf("--text-on-accent"),
					litColor: getComputedStyle(lit).color,
					litBg: getComputedStyle(lit).backgroundColor,
					plainColor: getComputedStyle(plain).color,
					plainBg: getComputedStyle(plain).backgroundColor,
				};
			}, dark);
			await leaf.page.hover(".handwriting-canvas-action", { timeout: 5000 });
			const hoverBg = await leaf.page.evaluate(() => getComputedStyle(document.querySelector(".handwriting-canvas-action")!).backgroundColor);
			expect(r.litBg, "the lit icon's box is not the theme's accent colour").toBe(r.accent);
			expect(r.litColor, "the lit icon is not the theme's on-accent colour").toBe(r.onAccent);
			expect(hoverBg, "hovering the lit icon dropped its accent box").toBe(r.accent);
			expect(r.plainBg, "the plain icon got a box").toBe("rgba(0, 0, 0, 0)");
			expect(r.plainColor, "the plain icon took the lit icon's colour").not.toBe(r.litColor);
			expect(ratio(r.litColor, r.litBg), "the lit icon is hard to see against its own box").toBeGreaterThan(2.5);
		} finally {
			await leaf.close();
		}
	}, 120_000);
});
