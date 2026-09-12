/**
 * Regression for camera writes feeding back into a content-sized parent.
 * The constrained and content-sized arms use the same editor. On b3ee the
 * latter reaches 5242880 x 3932160 after four command zoom-outs, while the
 * constrained arm stays bounded. This is a synthetic layout reproduction;
 * it does not establish the cause of the reported Orion flicker.
 */

import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import css from "../../styles.css?raw";

let browser: Browser, script: string;

beforeAll(async () => {
	const b = await build({
		entryPoints: [fileURLToPath(new URL("./unconstrainedViewportLoopPage.ts", import.meta.url))],
		bundle: true,
		write: false,
		format: "iife",
		platform: "browser",
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
	});
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
	await browser?.close();
});

async function run(kind: "constrained" | "shrinkToFit", steps: number, resize = false) {
	const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
	try {
		const errors: string[] = [];
		page.on("pageerror", (e) => errors.push(e.message));
		await page.setContent("<!doctype html><body></body>");
		await page.addStyleTag({
			content:
				css + readFileSync(fileURLToPath(new URL("./noteViewportCamera.css", import.meta.url)), "utf8"),
		});
		await page.addScriptTag({ content: script });
		const r = await page.evaluate(
			(args) => (window as any).unconstrainedLoop(...args),
			[kind, steps, resize] as const
		);
		expect(errors).toEqual([]);
		return r;
	} finally {
		await page.close();
	}
}

/**
 * The ceiling the production guard itself uses. Anything at or near this is the
 * runaway, not a large-but-legitimate layout.
 */
const RUNAWAY = 1_000_000;

it("CALIBRATION: the constrained pane settles, which is why it never reproduced", async () => {
	const r = await run("constrained", 4);
	expect(r.after.hostWidth).toBeLessThan(RUNAWAY);
	expect(r.after.paneWidth).toBeLessThan(RUNAWAY);
	expect(r.interactive).toBe(true);
}, 120_000);

it("a pane that sizes to its content must not inflate the stored layout", async () => {
	const r = await run("shrinkToFit", 4);
	// The failure this pins: each zoom-out adds the pane's own growth back into
	// layout.width, so the host and the pane climb together without limit.
	expect(r.after.hostWidth, `host grew to ${r.after.hostWidth}px (${JSON.stringify(r.after)})`).toBeLessThan(
		RUNAWAY
	);
	expect(r.after.hostHeight, `host grew to ${r.after.hostHeight}px`).toBeLessThan(RUNAWAY);
	expect(r.after.paneWidth).toBeLessThan(RUNAWAY);
	expect(r.after.paneHeight).toBeLessThan(RUNAWAY);
	// Parent growth caused by counter-sizing must never change the logical
	// viewport, and every requested halving must remain accepted.
	expect(r.zooms).toEqual([0.5, 0.25, 0.125, 0.0625]);
	for (const sample of r.samples) {
		expect(sample.layoutWidth).toBe(r.before.hostWidth);
		expect(sample.layoutHeight).toBe(r.before.hostHeight);
		expect(sample.cachedPaneWidth).toBe(sample.paneWidth);
		expect(sample.cachedPaneHeight).toBe(sample.paneHeight);
	}
	expect(r.after.hostWidth).toBe(r.before.hostWidth / 0.0625);
	expect(r.after.hostHeight).toBe(r.before.hostHeight / 0.0625);
}, 120_000);

it("a content-sized editor still answers a coordinate query", async () => {
	// This passed on b3ee too; it does not certify native interactivity.
	const r = await run("shrinkToFit", 4);
	expect(r.interactive, `zooms observed: ${JSON.stringify(r.zooms)}`).toBe(true);
}, 120_000);

it("still adopts a genuine external pane resize after zoom", async () => {
	const r = await run("constrained", 1, true);
	expect(r.after.layoutWidth).toBe(800);
	expect(r.after.layoutHeight).toBe(600);
	expect(r.after.hostWidth).toBe(1600);
	expect(r.after.hostHeight).toBe(1200);
	expect(r.after.cachedPaneWidth).toBe(800);
	expect(r.after.cachedPaneHeight).toBe(600);
}, 120_000);
