import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import type { FingerLifecycleTrace } from "./inlineFingerLifecyclePage";

let browser: Browser;
let page: Page;
let trace: FingerLifecycleTrace;
const pageErrors: string[] = [];
const consoleErrors: string[] = [];

beforeAll(async () => {
	const bundle = await build({
		entryPoints: [fileURLToPath(new URL("./inlineFingerLifecyclePage.ts", import.meta.url))],
		bundle: true,
		write: false,
		format: "iife",
		platform: "browser",
		target: "es2022",
		alias: {
			obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)),
		},
	});
	browser = await chromium.launch({ headless: true });
	page = await browser.newPage({ viewport: { width: 393, height: 852 }, hasTouch: true });
	page.on("pageerror", (error) => pageErrors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") consoleErrors.push(message.text());
	});
	await page.setContent("<!doctype html><html><body></body></html>");
	await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
	const mounted = await page.evaluate(() => "inlineFingerLifecycle" in window);
	if (!mounted) throw new Error(`finger lifecycle fixture failed to mount: ${pageErrors.join(" | ")}`);
	trace = await page.evaluate(() =>
		(
			window as unknown as Window & {
				inlineFingerLifecycle: { run(): Promise<FingerLifecycleTrace> };
			}
		).inlineFingerLifecycle.run()
	);
});

afterAll(async () => browser?.close());

describe("real mounted ordinary-note iPhone finger lifecycle", () => {
	it("routes Pen through the toolbar, switches A to B, rejects late input, and undoes by identity", () => {
		expect(trace.route.buttonLabels.some((label) => label.startsWith("Pen: "))).toBe(true);
		expect(trace.route).toMatchObject({
			mountedA: true,
			penButtonPresent: true,
			penCommandCount: 1,
			toolPicked: true,
			downPrevented: true,
			aAfterDraw: 1,
			pressuresAfterDraw: [0.5],
			widthModeAfterDraw: "uniform",
			widthAfterDraw: 2.2,
			drawUndoDepth: 1,
			mountedB: true,
			latePrevented: false,
			renamedBeforeUndo: 1,
			bBeforeUndo: 0,
			undoOk: true,
			renamedAfterUndo: 0,
			bAfterUndo: 0,
			redoOk: true,
			renamedAfterRedo: 1,
			widthModeAfterRedo: "uniform",
			bAfterRedo: 0,
		});
	});

	it("drops an unfinished finger stroke at real EditorView teardown and removes its listeners", () => {
		expect(trace.teardown).toEqual({
			mounted: true,
			downPrevented: true,
			storeBeforeDestroy: 0,
			routerDownsBeforeDestroy: 1,
			overlayAfterDestroy: false,
			storeAfterDestroy: 0,
			lateDownPrevented: false,
			storeAfterLateEvents: 0,
		});
	});

	it("commits once through the actual Keyboard control, then restores native touch", () => {
		expect(trace.keyboard).toEqual({
			mounted: true,
			keyboardButtonPresent: true,
			downPrevented: true,
			storeBeforeClick: 0,
			keyboardRuns: 1,
			penInkAfterClick: false,
			toolPickedAfterClick: false,
			editorFocused: true,
			storeAfterClick: 1,
			historyAfterClick: 1,
			storeAfterLateUp: 1,
			freshDownPrevented: false,
			storeAfterFreshTouch: 1,
			mousePreferenceBefore: true,
			mousePreferenceAfterClick: true,
			mouseNibBefore: "highlighter",
			mouseNibAfterClick: "highlighter",
			mouseStrokeBeforeKeyboard: 1,
			mouseDownPrevented: true,
			mouseUpPrevented: true,
			mouseLateUpPrevented: true,
			mouseStoreAfterClick: 2,
			mouseFreshDownPrevented: false,
			mouseFreshStore: 2,
			mouseHeldStoreAfterCommand: 2,
			mouseHeldRouterStrokingAfterCommand: true,
			mouseHeldStoreAfterUp: 3,
			mouseHeldRouterStrokingAfterUp: false,
			mousePostHeldDownPrevented: false,
			mousePostHeldStore: 3,
			mouseHoverClassWhilePaused: false,
			mousePreferenceAfterResume: true,
			mouseNibAfterResume: "highlighter",
			mouseResumeDownPrevented: true,
			mouseResumeStore: 4,
		});
	});

	// Infinite canvas is off here (its default), so the host leaves two-finger zoom to the browser
	// and the armed guard reads pinch-zoom; a disarmed guard gives the scroller back its own value.
	it("prepares held-scroll, command, Highlighter, lit-reselect and native-cancel entry before the next contact", () => {
		expect(trace.reentry).toEqual({
			mounted: true,
			touchActionAfterPenWhileHeld: "pinch-zoom",
			touchActionAfterHeldLift: "pinch-zoom",
			touchActionAfterCompletedScroll: "",
			touchActionAfterCommand: "pinch-zoom",
			litReselectPrepareCalls: 1,
			touchActionAfterPointerCancel: "",
			touchActionAfterNativeCancel: "pinch-zoom",
			touchActionAfterHighlighterScroll: "",
			touchActionAfterHighlighter: "pinch-zoom",
			penCommandCount: 3,
			highlighterCommandCount: 1,
			penInkAfterPen: true,
			toolPickedAfterPen: true,
			toolAfterHighlighter: "highlighter",
			downPrevented: true,
			storeAfterDraw: 1,
		});
	});

	it("raises no browser or application console errors", () => {
		expect(pageErrors).toEqual([]);
		expect(consoleErrors).toEqual([]);
	});
});
