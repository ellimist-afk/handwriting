/**
 * THE TOOLBAR STAYS ONE ROW UNDER A THEME THAT MAKES THE NOTE PANE A CONTAINER.
 *
 * Issue 54: under the ITS theme the toolbar is one button wide, every control
 * on its own line. ITS sets `container: note/inline-size` on every div
 * straight inside `.view-content > .markdown-source-view`, and the strip, the
 * pen pill's tip and the zoom bar are all divs built straight into that pane.
 * Inline-size containment sizes a box as if it had no content across, so the
 * absolutely placed strip shrinks to its padding and its row wraps one
 * control per line.
 *
 * The pane is built as Obsidian builds it (stripPage `buildSourceViewStrip`).
 * Three arms: no host sheet; the one ITS rule as a host sheet; the whole ITS
 * theme.css as a host sheet, read from HW_ITS_THEME when it is set (the file
 * is third-party and not kept in this repo).
 *
 * Read: the strip's box, every shown control's centre y, and the computed
 * container-type of the three direct children.
 */

import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright";
import { launch, openSourceViewStrip } from "./harness";

declare const process: { env: Record<string, string | undefined> };

/** ITS theme.css line 10272 (SlRvb/Obsidian--ITS-Theme main, 2026-11-06), verbatim. */
const ITS_NOTE_CONTAINER = `.view-content > div:is(.markdown-source-view, .markdown-reading-view) > div {
  container: note/inline-size;
}`;

const fullTheme = process.env.HW_ITS_THEME;

let browser: Browser;
beforeAll(async () => {
	browser = await launch();
});
afterAll(async () => {
	await browser?.close();
});

async function check(arm: string, hostCss?: string): Promise<void> {
	const h = await openSourceViewStrip(browser, hostCss === undefined ? {} : { hostCss });
	try {
		const p = await h.probe();
		// eslint-disable-next-line no-console
		console.log(`${arm}: ${JSON.stringify(p)}`);
		expect(p.strip.found, "premise: the strip is a direct child of the pane").toBe(true);
		expect(p.zoomBar.found, "premise: the zoom bar is a direct child of the pane").toBe(true);
		expect(p.pillTip.found, "premise: the pill tip is a direct child of the pane").toBe(true);
		expect(p.controlYs.length, "premise: the strip shows several controls").toBeGreaterThanOrEqual(5);

		const spread = Math.max(...p.controlYs) - Math.min(...p.controlYs);
		expect(spread, "every control centre on one line").toBeLessThanOrEqual(1);
		expect(p.strip.containerType, "the strip is not a size container").toBe("normal");
		expect(p.pillTip.containerType, "the pill tip is not a size container").toBe("normal");
		expect(p.zoomBar.containerType, "the zoom bar is not a size container").toBe("normal");
	} finally {
		await h.close();
	}
}

describe("the toolbar in the note pane, under a theme's container rule", () => {
	it("C: no host sheet, one row", async () => {
		await check("C no theme");
	});

	it("A: the ITS note container rule alone, still one row", async () => {
		await check("A ITS rule", ITS_NOTE_CONTAINER);
	});

	it.runIf(fullTheme !== undefined)("B: the whole ITS theme, still one row", async () => {
		await check("B ITS theme", readFileSync(fullTheme!, "utf8"));
	});
});
