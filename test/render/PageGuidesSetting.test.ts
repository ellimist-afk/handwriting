/**
 * PAGE GUIDES SETTING, the render half.
 *
 * The setting off puts `handwriting-page-guides-off` on the body (src/settings/PageGuidesSetting.test.ts holds the
 * class's roads); styles.css hides the guides' box under it. On the real note rig (noteViewportCameraPage.ts,
 * Infinite Canvas on), with the shipped styles.css:
 *   - on at rest, the box is up and paints the guides' gradient (premise);
 *   - the class put on live: the box computes display none, on the same page, no reopen;
 *   - the class taken off live: the box shows and paints the gradient again, still no reopen;
 *   - a page that opens with the class: hidden from the first frame, and shown once it comes off.
 * On lined paper and on paper none, the two papers PageGuidesPreview.test.ts runs.
 *
 * Run: npx vitest run --config vitest.render.mts test/render/PageGuidesSetting.test.ts
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";

let browser: Browser, viewportScript: string;
const OFF = "handwriting-page-guides-off";
const PAPERS = [{ name: "lines", bodyClass: "handwriting-paper-lines" }, { name: "none", bodyClass: "" }] as const;
type Paper = typeof PAPERS[number];

beforeAll(async () => {
	const bv = await build({
		entryPoints: [fileURLToPath(new URL("./noteViewportCameraPage.ts", import.meta.url))],
		bundle: true, write: false, format: "iife", platform: "browser",
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
	});
	viewportScript = bv.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);

afterAll(async () => {
	await browser?.close();
});

async function openRig(id: string, bodyClass: string) {
	const page = await browser.newPage({ viewport: { width: 700, height: 540 }, deviceScaleFactor: 2 });
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	await page.setContent(`<!doctype html><body class="${bodyClass}" style="--background-modifier-border:#777; background:white"></body>`);
	await page.addStyleTag({ content: css + readFileSync(fileURLToPath(new URL("./noteViewportCamera.css", import.meta.url)), "utf8") });
	await page.addScriptTag({ content: viewportScript });
	await page.evaluate(i => (window as any).viewportFixture.setup(i), id);
	const committed = await page.evaluate(a => (window as any).edgeAudit.commit(a.id, a.z), { id, z: 0.15 }) as any;
	return { page, errors, committed };
}

const boxState = (page: Page) => page.evaluate(() => {
	const b = document.querySelector(".cm-scroller > .handwriting-page-guides") as HTMLElement | null;
	if (!b) return { present: false, display: "", image: "", height: 0 };
	const cs = getComputedStyle(b);
	return { present: true, display: cs.display, image: cs.backgroundImage, height: b.getBoundingClientRect().height };
});
const frames = (page: Page, n: number) => page.evaluate(k => new Promise<void>(r => {
	let left = k;
	const step = () => (--left <= 0 ? r() : requestAnimationFrame(step));
	requestAnimationFrame(step);
}), n);
const setOff = (page: Page, off: boolean) => page.evaluate(a => document.body.classList.toggle(a.cls, a.off), { cls: OFF, off });

for (const paper of PAPERS) {
	it(`page guides setting, paper ${paper.name}: on paints the guides, off hides the box live, back on paints again, no reopen`, async () => {
		const { page, errors, committed } = await openRig(`guides-setting-${paper.name}`, paper.bodyClass);
		try {
			expect(committed.accepted, "premise: the start zoom committed").toBe(true);
			const on = await boxState(page);
			expect(on.present, "premise: the overlay put the guides' box up").toBe(true);
			expect(on.display, "on: the box shows").not.toBe("none");
			expect(on.image, "on: the box paints the guides").toContain("repeating-linear-gradient");
			expect(on.height, "on: the box has height").toBeGreaterThan(0);

			await setOff(page, true);
			await frames(page, 2);
			const off = await boxState(page);
			expect(off.present, "off: the box stays in the page (the overlay is not touched)").toBe(true);
			expect(off.display, "off: the box computes display none").toBe("none");

			await setOff(page, false);
			await frames(page, 2);
			const back = await boxState(page);
			expect(back.display, "back on: the box shows without a reopen").not.toBe("none");
			expect(back.image, "back on: the box paints the guides again").toContain("repeating-linear-gradient");
			expect(back.height, "back on: the box has height").toBeGreaterThan(0);
			expect(errors, "no page errors").toEqual([]);
		} finally {
			await page.close();
		}
	}, 120_000);

	it(`page guides setting, paper ${paper.name}: a note opened with the guides off never shows the box, and shows it once on`, async () => {
		const { page, errors, committed } = await openRig(`guides-setting-open-off-${paper.name}`, `${paper.bodyClass} ${OFF}`.trim());
		try {
			expect(committed.accepted, "premise: the start zoom committed").toBe(true);
			const off = await boxState(page);
			expect(off.present, "premise: the overlay put the guides' box up").toBe(true);
			expect(off.display, "opened off: display none").toBe("none");
			await setOff(page, false);
			await frames(page, 2);
			const on = await boxState(page);
			expect(on.display, "turned on: the box shows").not.toBe("none");
			expect(on.image, "turned on: the box paints the guides").toContain("repeating-linear-gradient");
			expect(errors, "no page errors").toEqual([]);
		} finally {
			await page.close();
		}
	}, 120_000);
}
