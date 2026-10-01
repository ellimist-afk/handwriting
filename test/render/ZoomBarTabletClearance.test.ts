/**
 * On an iPad-width pane with Infinite Canvas on, the note zoom bar sits just
 * below the pen strip or its folded pill, in every top corner, never on it.
 *
 * The phone fix puts the bar below the strip by the same safe-area inset the
 * strip takes. That was checked at phone width only; this measures it at
 * tablet width, with the body classes Obsidian sets on an iPad, the real
 * MobileTools and the real stylesheet.
 *
 * The plant (HW_ZOOMBAR_PLANT=1) moves the bar to the strip's own top in
 * this fixture, so the same assertions can be shown to go red.
 *
 * WHAT THIS CANNOT ANSWER
 *   - the safe-area insets, which resolve to 0 in desktop Chromium. The bar
 *     and the strip carry the same env() term, so a real inset moves both.
 *   - anything about Obsidian's own header on iPad. The real acceptance is
 *     the device.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import type { Browser } from "playwright";
import { launch, openNoteZoomStrip, type NoteZoomHarness } from "./harness";

declare const process: { env: Record<string, string | undefined> };

/** Measured boxes, one line per arm, written to HW_ZOOMBAR_OUT when set. */
const rows: string[] = [];

/** iPad Air, portrait and landscape, in CSS px. */
const TABLETS = [
	{ name: "portrait", width: 820, height: 1180 },
	{ name: "landscape", width: 1180, height: 820 },
] as const;

const PLANT = process.env.HW_ZOOMBAR_PLANT === "1";

interface Box { left: number; right: number; top: number; bottom: number; width: number; height: number }

let browser: Browser;
beforeAll(async () => {
	browser = await launch();
});
afterAll(async () => {
	await browser?.close();
	if (process.env.HW_ZOOMBAR_OUT) writeFileSync(process.env.HW_ZOOMBAR_OUT, rows.join("\n") + "\n");
});

describe("zoom bar clearance at tablet width, iPad classes, canvas on", () => {
	let h: NoteZoomHarness;
	afterEach(async () => {
		await h?.close();
	});

	for (const size of TABLETS) {
		for (const corner of ["top-right", "top-left", "top-center"] as const) for (const collapsed of [false, true]) {
			it(`${size.name}, ${corner}, strip ${collapsed ? "folded to the pill" : "open"}: bar sits 2 to 12 px below the toolbar`, async () => {
				h = await openNoteZoomStrip(browser);
				await h.page.setViewportSize({ width: size.width, height: size.height });
				await h.probe({ mode: "auto", inking: false });
				const r = await h.page.evaluate(
					({ w, hgt, folded, plant, cornerClass }) => {
						document.body.className = "is-mobile is-tablet is-ios";
						const pane = (window as unknown as { __pane: HTMLElement }).__pane;
						pane.style.width = `${w}px`;
						pane.style.height = `${hgt}px`;
						const strip = pane.querySelector<HTMLElement>(".handwriting-mobile-tools")!;
						const pill = pane.querySelector<HTMLElement>(".handwriting-pen-pill");
						// What MobileTools.setCorner puts on both forms.
						for (const el of [strip, pill]) el?.classList.add(cornerClass);
						if (folded) {
							strip.classList.add("is-collapsed");
							pill?.classList.add("is-showing");
						}
						const bar = pane.querySelector<HTMLElement>(".handwriting-note-viewport-controls")!;
						if (plant) {
							// Plant: put the bar on the toolbar's own corner box.
							const r0 = (folded && pill ? pill : strip).getBoundingClientRect();
							bar.style.top = `${r0.top}px`;
							bar.style.left = `${r0.left}px`;
							bar.style.right = "auto";
						}
						for (const a of document.getAnimations()) a.finish();
						const box = (el: HTMLElement): Box => {
							const b = el.getBoundingClientRect();
							return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height };
						};
						const tool = folded && pill ? pill : strip;
						return {
							pane: box(pane),
							bodyClass: document.body.className,
							toolClass: tool.className,
							barHidden: bar.classList.contains("is-hidden"),
							bar: box(bar),
							tool: box(tool),
						};
					},
					{ w: size.width, hgt: size.height, folded: collapsed, plant: PLANT, cornerClass: `handwriting-corner-${corner}` }
				);
				rows.push(`${size.name} ${corner} folded=${collapsed} plant=${PLANT} ${JSON.stringify(r)}`);
				expect(r.bodyClass).toContain("is-mobile");
				expect(r.barHidden, "canvas on shows the bar").toBe(false);
				expect(r.bar.width, "bar laid out").toBeGreaterThan(0);
				expect(r.tool.width, "toolbar laid out").toBeGreaterThan(0);
				expect(r.bar.left, "bar inside the pane").toBeGreaterThanOrEqual(r.pane.left);
				expect(r.bar.right, "bar inside the pane").toBeLessThanOrEqual(r.pane.right);
				expect(r.bar.top, "bar inside the pane").toBeGreaterThanOrEqual(r.pane.top);
				expect(r.bar.bottom, "bar inside the pane").toBeLessThanOrEqual(r.pane.bottom);
				const gap = r.bar.top - r.tool.bottom;
				expect(gap, "bar at least 2 px below the toolbar").toBeGreaterThanOrEqual(2);
				expect(gap, "bar at most 12 px below the toolbar").toBeLessThanOrEqual(12);
			});
		}
	}
});
