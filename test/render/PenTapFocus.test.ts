/**
 * WHAT A CLAIMED PEN TAP DOES TO THE EDITOR'S FOCUS AND KEYBOARD, measured in Chromium.
 *
 * A pen-down the router claims is cancelled, which also cancels the browser's
 * own focus change, so the overlay hands focus back to the editor on every
 * claimed pen-down where the editor does not already have it. That keeps
 * Delete and undo with the note the pen is on. On a Windows tablet in tablet
 * mode, focus arriving in an editable element during a pen gesture raises the
 * touch keyboard, and the keyboard shrinking the window scrolls the old caret
 * into view. So the focus comes with `inputmode="none"` on the editor, held
 * until blur, the next contact in the editor that is not a pen, or the pen-off
 * button asking for the keyboard.
 *
 * The case: the caret sits at the top of a long note, the note is scrolled far
 * past it, and a button outside the editor (as a page-scroll plugin puts on the
 * page body) is tapped with the pen, which takes focus. The next pen tap on the
 * note is claimed. A headless browser shows no touch keyboard, so the readout
 * is focus, caret, scroll and the editor's inputmode, before and after.
 *
 * Real pen input through the browser (cdpPen.ts), on the desktop Windows
 * platform stub. Set HW_PEN_TAP_FOCUS_EVIDENCE to a path to write the readout.
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import css from "../../styles.css?raw";
import { penPress, penRelease } from "./cdpPen";
declare module "node:fs" { export function writeFileSync(path: string, data: string): void; }
declare const process: { env: Record<string, string | undefined> };

let browser: Browser, script: string;
const evidence: unknown[] = [];

beforeAll(async () => {
	const here = fileURLToPath(new URL(".", import.meta.url));
	const b = await build({
		stdin: {
			contents: 'import "./penTapFocusPage"; import { Platform } from "obsidian"; import { setPenInk } from "../../src/inline/PenInk"; import { setInlineInkEnabled } from "../../src/inline/InkOverlayRegistry"; (window as any).penTapFocus.setPenInk = setPenInk; (window as any).penTapFocus.setInlineInkEnabled = setInlineInkEnabled; (window as any).penTapFocus.setMobileApp = (on: boolean) => { (Platform as { isMobileApp: boolean }).isMobileApp = on; };',
			resolveDir: here, loader: "ts", sourcefile: "penTapFocusEntry.ts",
		},
		bundle: true, write: false, format: "iife", platform: "browser",
		alias: { obsidian: fileURLToPath(new URL("./mouseUndoObsidianStub.ts", import.meta.url)) },
	});
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
	await browser?.close();
	if (process.env.HW_PEN_TAP_FOCUS_EVIDENCE) writeFileSync(process.env.HW_PEN_TAP_FOCUS_EVIDENCE, JSON.stringify(evidence, null, 2));
});

const BUTTON = { x: 675, y: 55 };
const NOTE = { x: 200, y: 300 };
type Snap = { inputMode: string | null; top: number; head: number; focused: boolean; active: string; strokes: number; focusLog: string[] };
const call = (page: Page, fn: string): Promise<Snap> => page.evaluate((f) => (window as any).penTapFocus[f](), fn);

/**
 * Opens the page, optionally pen-taps the body button, then pen-taps the note.
 * `after` runs with the page and its CDP session and returns extra readings.
 */
async function run(name: string, opts: { hasTouch?: boolean; tapButtonFirst?: boolean }, after?: (page: Page, pen: (x: number, y: number) => Promise<void>) => Promise<Record<string, unknown>>) {
	const context = await browser.newContext({ viewport: { width: 700, height: 540 }, hasTouch: opts.hasTouch ?? false });
	const page = await context.newPage();
	try {
		await page.setContent("<!doctype html><body style='margin:0'></body>");
		await page.addStyleTag({ content: css });
		await page.addScriptTag({ content: script });
		const cdp = await context.newCDPSession(page);
		const pen = async (x: number, y: number) => {
			await penPress(cdp, x, y); await penRelease(cdp, x, y);
			await call(page, "settle");
		};
		const start = await call(page, "setup");
		const touchPoints = await page.evaluate(() => navigator.maxTouchPoints);
		if (opts.tapButtonFirst ?? true) await pen(BUTTON.x, BUTTON.y);
		const beforeTap = await call(page, "snap");
		await pen(NOTE.x, NOTE.y);
		const afterTap = await call(page, "snap");
		const trace = JSON.stringify(await page.evaluate(() => (window as any).penTapFocus.capture()));
		const claimed = trace.includes("pen CLAIMED");
		const notClaimed = trace.includes("pen NOT CLAIMED") || trace.includes("pen IGNORED");
		const extra = after ? await after(page, pen) : {};
		const row = { name, touchPoints, start, beforeTap, afterTap, claimed, notClaimed, ...extra };
		evidence.push(row);
		return row as typeof row & Record<string, any>;
	} finally {
		await context.close();
	}
}

it("focus left for a body button, then a claimed pen tap on the note: focus returns to the editor, the caret stays put, focus itself does not scroll", async () => {
	const r = await run("arm", {}, async (page) => {
		// The touch keyboard shrinking the window, as far as a headless browser
		// can show it: a shorter viewport with the editor focused.
		await page.setViewportSize({ width: 700, height: 300 });
		return { afterShrink: await call(page, "settle").then(() => call(page, "snap")) };
	});
	expect(r.beforeTap.active, "premise: the pen tap on the button took focus").toBe("button");
	expect(r.beforeTap.focused, "premise: the editor lost focus").toBe(false);
	expect(r.claimed, "premise: the note tap was claimed").toBe(true);
	expect(r.notClaimed, "the note tap was handed back").toBe(false);
	expect(r.afterTap.active, "the claimed tap did not bring focus back to the editor").toBe("editor");
	expect(r.afterTap.head, "the claimed tap moved the caret").toBe(r.beforeTap.head);
	expect(r.afterTap.top, "the focus call itself scrolled the note").toBe(r.beforeTap.top);
});

it("the focus a pen tap brings back asks for no keyboard, from the focus event on", async () => {
	const r = await run("held", {});
	const focusLine = r.afterTap.focusLog.find((l: string) => l.startsWith("focus"));
	expect(focusLine, "premise: the editor received focus").toBeDefined();
	expect(focusLine, "the editor was focused while still asking for a keyboard").toContain("inputmode=none");
	expect(r.afterTap.inputMode, "the editor asks for a keyboard after a pen tap").toBe("none");
});

it("a second pen stroke keeps the keyboard down, and CodeMirror rewriting its attributes does not drop the setting", async () => {
	const r = await run("held-through", {}, async (page, pen) => {
		await pen(NOTE.x + 40, NOTE.y + 40);
		const afterSecond = await call(page, "snap");
		const afterSync = await call(page, "syncAttributes");
		const probe = await page.evaluate(() => document.querySelector(".cm-content")?.getAttribute("data-probe"));
		return { afterSecond, afterSync, probe };
	});
	expect(r.afterTap.inputMode, "premise: the pen tap held the keyboard down").toBe("none");
	expect(r.afterSecond.inputMode, "a second pen stroke gave the keyboard back").toBe("none");
	expect(r.probe, "premise: CodeMirror did rewrite the content attributes").toBe("1");
	expect(r.afterSync.inputMode, "CodeMirror's attribute sync dropped the setting").toBe("none");
});

it("a finger tap in the editor gives the ordinary keyboard back", async () => {
	const r = await run("finger", { hasTouch: true }, async (page) => {
		await page.touchscreen.tap(NOTE.x, NOTE.y + 60);
		return { afterFinger: await call(page, "settle").then(() => call(page, "snap")) };
	});
	expect(r.afterTap.inputMode, "premise: the pen tap held the keyboard down").toBe("none");
	expect(r.afterFinger.inputMode, "a finger tap in the editor left the keyboard held down").toBeNull();
});

it("the pen-off button's keyboard request gives the ordinary keyboard back before it focuses", async () => {
	const r = await run("pen-off", {}, async (page) => ({ afterAsk: await call(page, "askForKeyboard") }));
	expect(r.afterTap.inputMode, "premise: the pen tap held the keyboard down").toBe("none");
	expect(r.afterAsk.inputMode, "the pen-off button focused an editor that still asks for no keyboard").toBeNull();
	expect(r.afterAsk.focused).toBe(true);
});

it("leaving the editor gives the ordinary keyboard back", async () => {
	const r = await run("blur", {}, async (page, pen) => {
		await pen(BUTTON.x, BUTTON.y);
		return { afterLeave: await call(page, "snap") };
	});
	expect(r.afterTap.inputMode, "premise: the pen tap held the keyboard down").toBe("none");
	expect(r.afterLeave.active, "premise: the button took focus").toBe("button");
	expect(r.afterLeave.inputMode, "the editor kept asking for no keyboard after it lost focus").toBeNull();
});

type Row = { id: number; ptr: string; type: string; note: string; eventId?: string };
const traceRows = (page: Page): Promise<Row[]> => page.evaluate(() => (window as any).penTapFocus.capture().events);
/** The keyboard row of each pen-down, with the note of the router's own row for the same event. */
async function keyboardRows(page: Page) {
	const rows = await traceRows(page);
	return rows
		.filter((r) => r.note.startsWith("keyboard at pen-down"))
		.map((r) => ({ ptr: r.ptr, note: r.note, router: rows.find((o) => o.eventId === r.eventId && o.note.startsWith("pen "))?.note ?? null }));
}

it("an editor that already has focus gets the hold on a claimed pen tap, with no focus change", async () => {
	const r = await run("already-focused", { tapButtonFirst: false }, async (page) => ({ rows: await keyboardRows(page) }));
	expect(r.beforeTap.focused, "premise: the editor has focus").toBe(true);
	expect(r.claimed).toBe(true);
	expect(r.afterTap.focusLog, "focus moved during a tap on an already focused editor").toEqual([]);
	expect(r.afterTap.head).toBe(r.beforeTap.head);
	expect(r.afterTap.inputMode, "a pen tap on an already focused editor left the keyboard free to rise").toBe("none");
	expect(r.rows, "one keyboard row for the one pen-down").toHaveLength(1);
	expect(r.rows[0]!.note).toBe('keyboard at pen-down: editor focused=yes, inputmode before=(unset) after="none", hold=placed');
	expect(r.rows[0]!.ptr).toBe("pen");
	expect(r.rows[0]!.router, "the router's row for the same event says it claimed").toMatch(/^pen CLAIMED/);
});

it("the trace row of a claimed pen tap on an editor that lost focus", async () => {
	const r = await run("trace-claimed", {}, async (page) => ({ rows: await keyboardRows(page) }));
	// The first pen-down is on the page button, outside the editor: no row. The second is the note tap.
	expect(r.rows).toHaveLength(1);
	expect(r.rows[0]!.note).toBe('keyboard at pen-down: editor focused=no, inputmode before=(unset) after="none", hold=placed');
	expect(r.rows[0]!.router).toMatch(/^pen CLAIMED/);
});

it("a second pen contact the router ignores still holds the keyboard down", async () => {
	const r = await run("ignored", {}, async (page) => {
		const cdp = await page.context().newCDPSession(page);
		await penPress(cdp, NOTE.x + 60, NOTE.y + 60);
		try {
			// The first stroke stays live. Blur releases the hold it placed.
			await page.evaluate(() => (document.querySelector(".cm-content") as HTMLElement).blur());
			const afterBlur = await call(page, "snap");
			await page.evaluate(() => document.querySelector(".cm-content")!.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "pen", pointerId: 99, bubbles: true, cancelable: true, composed: true, clientX: 200, clientY: 300 })));
			return { afterBlur, afterSecond: await call(page, "snap"), rows: await keyboardRows(page) };
		} finally {
			await penRelease(cdp, NOTE.x + 60, NOTE.y + 60);
		}
	});
	expect(r.afterBlur.inputMode, "premise: blur released the hold").toBeNull();
	const last = r.rows[r.rows.length - 1]!;
	expect(last.router, "premise: the router ignored the second contact").toMatch(/^pen IGNORED/);
	expect(r.afterSecond.inputMode, "a pen contact the router ignored left the keyboard free to rise").toBe("none");
	expect(last.note).toBe('keyboard at pen-down: editor focused=no, inputmode before=(unset) after="none", hold=placed');
});

it("pen ink off: a pen pointerdown at the editor leaves the keyboard setting alone, and the trace says why", async () => {
	const r = await run("pen-ink-off", {}, async (page, pen) => {
		await pen(BUTTON.x, BUTTON.y);
		const afterLeave = await call(page, "snap");
		await page.evaluate(() => {
			(window as any).penTapFocus.setPenInk(false);
			document.querySelector(".cm-content")!.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "pen", pointerId: 98, bubbles: true, cancelable: true, composed: true, clientX: 200, clientY: 300 }));
		});
		return { afterLeave, afterOff: await call(page, "snap"), rows: await keyboardRows(page) };
	});
	expect(r.afterLeave.inputMode, "premise: leaving the editor released the hold").toBeNull();
	expect(r.afterOff.inputMode, "a pen pointerdown with pen ink off changed the keyboard setting").toBeNull();
	const last = r.rows[r.rows.length - 1]!;
	expect(last.note).toBe('keyboard at pen-down: editor focused=no, inputmode before=(unset) after=(unset), hold=no (pen ink off)');
	expect(last.router, "premise: the router handed the contact back").toMatch(/^pen NOT CLAIMED/);
});

it("inline ink off: a pen pointerdown at the editor leaves the keyboard setting alone, and the trace says why", async () => {
	const r = await run("inline-ink-off", {}, async (page, pen) => {
		await pen(BUTTON.x, BUTTON.y);
		const afterLeave = await call(page, "snap");
		await page.evaluate(() => {
			(window as any).penTapFocus.setInlineInkEnabled(false);
			document.querySelector(".cm-content")!.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "pen", pointerId: 96, bubbles: true, cancelable: true, composed: true, clientX: 200, clientY: 300 }));
		});
		const afterOff = await call(page, "snap");
		const rows = await keyboardRows(page);
		await page.evaluate(() => (window as any).penTapFocus.setInlineInkEnabled(true));
		return { afterLeave, afterOff, rows };
	});
	expect(r.afterLeave.inputMode, "premise: leaving the editor released the hold").toBeNull();
	expect(r.afterOff.inputMode, "a pen pointerdown with inline ink off changed the keyboard setting").toBeNull();
	expect(r.rows[r.rows.length - 1]!.note).toBe('keyboard at pen-down: editor focused=no, inputmode before=(unset) after=(unset), hold=no (inline ink off)');
});

it("an overlay re-created on the same editor leaves one pen listener: one pen-down, one hold, one keyboard row", async () => {
	const r = await run("recycle", {}, async (page, pen) => {
		const rowsBefore = (await keyboardRows(page)).length;
		await page.evaluate(() => (window as any).penTapFocus.recycleOverlay());
		await pen(BUTTON.x, BUTTON.y);
		const afterLeave = await call(page, "snap");
		await pen(NOTE.x, NOTE.y);
		return { rowsBefore, afterLeave, afterNote: await call(page, "snap"), rows: await keyboardRows(page) };
	});
	expect(r.rowsBefore, "premise: the first overlay's one pen-down left one row").toBe(1);
	expect(r.afterLeave.inputMode, "premise: leaving the editor released the hold").toBeNull();
	expect(r.afterNote.inputMode, "a pen tap on the re-created overlay's editor left the keyboard free to rise").toBe("none");
	// Two pen-downs after the recycle (the button is outside the editor, so only the note tap counts): one row, not one per overlay ever built.
	expect(r.rows.length - r.rowsBefore, "one pen-down in the editor wrote more than one keyboard row").toBe(1);
	expect(r.rows[r.rows.length - 1]!.note).toBe('keyboard at pen-down: editor focused=no, inputmode before=(unset) after="none", hold=placed');
});

it("a mobile app: a pen pointerdown at the editor leaves the keyboard setting alone, and the trace says why", async () => {
	const r = await run("mobile-app", {}, async (page, pen) => {
		await pen(BUTTON.x, BUTTON.y);
		const afterLeave = await call(page, "snap");
		await page.evaluate(() => {
			(window as any).penTapFocus.setMobileApp(true);
			document.querySelector(".cm-content")!.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "pen", pointerId: 97, bubbles: true, cancelable: true, composed: true, clientX: 200, clientY: 300 }));
		});
		return { afterLeave, afterMobile: await call(page, "snap"), rows: await keyboardRows(page) };
	});
	expect(r.afterLeave.inputMode, "premise: leaving the editor released the hold").toBeNull();
	expect(r.afterMobile.inputMode, "a pen pointerdown on a mobile app changed the keyboard setting").toBeNull();
	expect(r.rows[r.rows.length - 1]!.note).toBe('keyboard at pen-down: editor focused=no, inputmode before=(unset) after=(unset), hold=no (mobile app)');
});
