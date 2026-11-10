/**
 * ISSUE 30: "PEN SNAPS THE VIEW BACK TO THE FIRST PLACE TO WRITE".
 *
 * Asus Vivobook Flip, Windows 11, Page Scroll plugin installed. A pen-down in
 * a note scrolled away from its caret jumped the view back to the caret.
 * view.focus() (InlineFocus.ts:44) goes through CodeMirror's focusPreventScroll,
 * so our own focus should not scroll; this cell measures it.
 *
 * Real note taller than its view, caret on line 1, scrolled down, focus on a
 * button outside the editor. One pen stroke on the note. scrollTop is read
 * back after the pen-down and after the lift. Green: our pen focus does not
 * move the view, and the snap comes from outside the repo. Red: ours.
 *
 * The plant row adds a focusin listener that scrolls the caret into view, and
 * must see the scroll: it proves the cell reads the snap when one happens.
 *
 * I30_OUT=<dir> writes one JSON row per case there.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, type Browser, type CDPSession } from "playwright";
import css from "../../styles.css?raw";

declare const process: { env: Record<string, string | undefined> };

let browser: Browser;
let pageJs: string;

beforeAll(async () => {
	const out = await build({
		entryPoints: [fileURLToPath(new URL("./issue30PenScrollPage.ts", import.meta.url))],
		bundle: true,
		write: false,
		format: "iife",
		platform: "browser",
		target: "es2022",
		alias: { obsidian: fileURLToPath(new URL("./mouseUndoObsidianStub.ts", import.meta.url)) },
	});
	pageJs = out.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 120_000);
afterAll(async () => {
	await browser?.close();
});

const pen = (cdp: CDPSession, type: string, x: number, y: number, buttons: number, force: number) =>
	cdp.send("Input.dispatchMouseEvent", {
		type, x, y, buttons, pointerType: "pen",
		button: type === "mouseMoved" && buttons === 0 ? "none" : "left",
		clickCount: type === "mouseMoved" ? 0 : 1,
		force,
	} as never);

async function penStroke(plant: boolean) {
	const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
	const page = await context.newPage();
	try {
		await page.setContent("<!doctype html><body style='margin:0'></body>");
		await page.addStyleTag({ content: css });
		await page.addScriptTag({ content: pageJs });
		const cdp = await context.newCDPSession(page);
		const setup = await page.evaluate((p) => (window as any).__i30.setupNote(p), plant);
		const y0 = setup.scrollerTop + 300;
		await pen(cdp, "mouseMoved", 380, y0 - 6, 0, 0);
		await pen(cdp, "mouseMoved", 390, y0 - 3, 0, 0);
		await pen(cdp, "mousePressed", 400, y0, 1, 0.5);
		await page.evaluate(() => (window as any).__i30.frames(3));
		const afterDown = await page.evaluate(() => (window as any).__i30.read());
		for (let i = 1; i <= 10; i++) await pen(cdp, "mouseMoved", 400 + i * 10, y0 + i * 2, 1, 0.5);
		await pen(cdp, "mouseReleased", 500, y0 + 20, 0, 0);
		await pen(cdp, "mouseMoved", 520, y0 + 26, 0, 0);
		await page.evaluate(() => (window as any).__i30.frames(4));
		const afterLift = await page.evaluate(() => (window as any).__i30.read());
		const row = { plant, setup, afterDown, afterLift };
		const dir = process.env.I30_OUT;
		if (dir) {
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, `issue30-${plant ? "plant" : "tip"}.json`), JSON.stringify(row, null, 1));
		}
		console.log(`I30 ${JSON.stringify(row)}`);
		expect(setup.overlay, "premise: the real overlay mounted").toBe(true);
		expect(setup.scrollTop, "premise: the note is scrolled down").toBeGreaterThan(1000);
		expect(setup.caret, "premise: caret on line 1").toBe(0);
		expect(setup.hasFocus, "premise: editor unfocused before the pen").toBe(false);
		expect(afterLift.strokes, "premise: the pen stroke was inked").toBeGreaterThanOrEqual(1);
		return row;
	} finally {
		await context.close();
	}
}

describe("issue 30: a pen-down does not scroll the note to its caret", () => {
	it("pen-down on a scrolled, unfocused note leaves scrollTop where it was", async () => {
		const r = await penStroke(false);
		expect(r.afterDown.scrollTop, "scrollTop after the pen-down").toBe(r.setup.scrollTop);
		expect(r.afterLift.scrollTop, "scrollTop after the lift").toBe(r.setup.scrollTop);
	}, 60_000);

	it("plant: a caret scroll on focus is seen by the cell", async () => {
		const r = await penStroke(true);
		expect(r.afterDown.focusins.length, "plant premise: focus came back to the editor").toBeGreaterThanOrEqual(1);
		expect(r.afterLift.scrollTop, "plant: scrollTop moved to the caret").not.toBe(r.setup.scrollTop);
	}, 60_000);
});
