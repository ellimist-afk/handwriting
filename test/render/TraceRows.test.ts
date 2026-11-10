/**
 * TRACE ROWS FOR ISSUES 30 AND 37, IN REAL CHROMIUM.
 *
 * Issue 30 (pen snaps the view back to the caret): with recording on, the
 * pen-down that brings focus back to a scrolled, unfocused note writes one
 * focusin row with scrollTop at the pen-down, at the focusin and a frame
 * later, and the stack below the focus.
 *
 * Issue 37 (painted line interrupted): with recording on, every stroke end
 * writes one row naming the event that ended it, the pen state on it, and the
 * strokes made of the contact. A silent lift mid-line reads as its move.
 *
 * Recording off: no focusin listener is added and neither row is written, by
 * count.
 *
 * TR_OUT=<dir> writes one JSON row per case there.
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
		entryPoints: [fileURLToPath(new URL("./traceRowsPage.ts", import.meta.url))],
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

type Case = "off" | "on" | "on-silent";

async function line(c: Case) {
	const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
	const page = await context.newPage();
	try {
		await page.setContent("<!doctype html><body style='margin:0'></body>");
		await page.addStyleTag({ content: css });
		await page.addScriptTag({ content: pageJs });
		const cdp = await context.newCDPSession(page);
		const setup = await page.evaluate((on) => (window as any).__tr.setupNote(on), c !== "off");
		const y0 = setup.scrollerTop + 300;
		await pen(cdp, "mouseMoved", 380, y0 - 6, 0, 0);
		await pen(cdp, "mouseMoved", 390, y0 - 3, 0, 0);
		await pen(cdp, "mousePressed", 400, y0, 1, 0.5);
		for (let i = 1; i <= 20; i++) {
			const silent = c === "on-silent" && i === 10;
			await pen(cdp, "mouseMoved", 400 + i * 10, y0 + i * 2, silent ? 0 : 1, silent ? 0 : 0.5);
		}
		await pen(cdp, "mouseReleased", 600, y0 + 40, 0, 0);
		await pen(cdp, "mouseMoved", 620, y0 + 46, 0, 0);
		await page.evaluate(() => (window as any).__tr.frames(4));
		const r = await page.evaluate(() => (window as any).__tr.read());
		const row = { case: c, setup, ...r };
		const dir = process.env.TR_OUT;
		if (dir) {
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, `trace-rows-${c}.json`), JSON.stringify(row, null, 1));
		}
		console.log(`TR ${JSON.stringify(row)}`);
		expect(setup.overlay, "premise: the real overlay mounted").toBe(true);
		expect(setup.hasFocus, "premise: editor unfocused before the pen").toBe(false);
		expect(r.strokes, "premise: the pen inked").toBeGreaterThanOrEqual(1);
		return row;
	} finally {
		await context.close();
	}
}

describe("trace rows for issues 30 and 37", () => {
	it("recording off: no focusin listener, no focusin row, no stroke-end row", async () => {
		const r = await line("off");
		expect(r.focusinAdds, "focusin listeners added with recording off").toBe(0);
		expect(r.focusin, "focusin rows with recording off").toHaveLength(0);
		expect(r.strokeEnd, "stroke-end rows with recording off").toHaveLength(0);
	}, 60_000);

	it("recording on: one focusin row with scrollTop, one stroke-end row for the pointerup", async () => {
		const r = await line("on");
		expect(r.focusinAdds, "focusin listeners armed by one pen-down").toBe(1);
		expect(r.focusin, "focusin rows").toHaveLength(1);
		expect(r.focusin[0]).toMatch(/scrollTop at down=\d+ at focusin=\d+ next frame=\d+/);
		expect(r.focusin[0]).toMatch(/stack: (?!\(none\))\S/);
		expect(r.strokeEnd, "stroke-end rows").toHaveLength(1);
		expect(r.strokeEnd[0]).toMatch(/ev=pointerup pointerType=pen pointerId=\d+ pressure=\S+ buttons=0 strokes this contact=1(?!\d)/);
	}, 60_000);

	// Measured at 42ed82ee: in Chromium a pen move with no buttons and no pressure ends the stroke through
	// lostpointercapture, before the router's silent-lift check sees the move. The row names whichever event it was.
	it("recording on, silent lift mid-line: the stroke-end row names the event that cut the line", async () => {
		const r = await line("on-silent");
		expect(r.strokeEnd.length, "stroke-end rows").toBeGreaterThanOrEqual(1);
		expect(r.strokeEnd[0]).toMatch(/ev=(pointermove|pointerrawupdate|lostpointercapture|pointercancel) pointerType=pen pointerId=\d+ pressure=0 buttons=0 strokes this contact=1(?!\d)/);
	}, 60_000);
});
