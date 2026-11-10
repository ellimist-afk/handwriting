/**
 * FINGERS HELD PAST THE PINCH WATCHDOG'S RE-ANCHOR STILL ZOOM.
 *
 * A pinch whose preview is still up after PINCH_MEASURE_HOLD_MAX_MS (10 s) is settled in place by the watchdog
 * (rebasePinch): the pinch is ended at the current scale and started again at once at the same target, so fingers still on
 * the glass carry on from the new anchor. The new start returns early when the note reads busy (InkOverlayPinch.ts:85). If
 * the settle left it busy, no anchor is taken, every later move returns at the anchor check, and the fingers do nothing
 * until a new gesture.
 *
 * One cell: mount at 100 percent, open a pinch to 200 percent and keep the fingers down, wait past the watchdog with the
 * fingers still, then move them on toward 300 percent. Premises: the watchdog's rebasePinch ran once, and the scale held at
 * 200 percent through it. Pass: after the moves the scale has gone past 250 percent. What the re-anchor saw (the note's busy
 * read and whether an anchor was taken) is logged.
 *
 * Run: npx vitest run --config vitest.render.mts test/render/PinchHeldPastRebase.test.ts
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

const MINIMAL_CSS = readFileSync(fileURLToPath(new URL("./fixtures/minimal-9.0.2-theme.css", import.meta.url)), "utf8");
const TEMPLATE = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/alan-ink-75d1627a.json", import.meta.url)), "utf8")) as Record<string, unknown>;
const PAGE_ID = "75d1627a-c4d7-4a11-947d-bc26b7f83c20";
const COUNT = 400;
const PANE = { w: 1184, h: 824 };
const DSF = 2;
const PATH = "Untitled 1.md";
const MOUNT_ZOOM = 1;
/** Where the held pinch rests, and where the fingers move on to after the re-anchor. */
const HOLD_ZOOM = 2;
const MOVE_ZOOM = 3;
/** Past the watchdog's PINCH_MEASURE_HOLD_MAX_MS (10 s), with room for a slow frame. */
const HOLD_MS = 11_000;

function seeded(seed: number): () => number {
	let a = seed >>> 0;
	return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function strokeJson(i: number, x: number, y: number, rnd: () => number) {
	let heading = rnd() * Math.PI * 2;
	const pts: number[] = [];
	for (let k = 0; k < 14; k++) {
		pts.push(Math.round(x * 100) / 100, Math.round(y * 100) / 100, 0.3 + 0.2 * rnd(), k * 8);
		heading += (rnd() - 0.5) * 0.9; x += Math.cos(heading) * 6; y += Math.sin(heading) * 6;
	}
	return { id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, tool: "pen", color: "#2f6de0", width: 2.6, createdAt: 1788552785194, pts };
}
function syntheticInk(count: number): string {
	const rnd = seeded(37);
	const strokes = [];
	for (let i = 0; i < count; i++) strokes.push(strokeJson(i + 1, 40 + rnd() * 11000, 40 + rnd() * 13000, rnd));
	return JSON.stringify({ ...TEMPLATE, strokes, images: [], textBoxes: [] });
}
const FIXTURE = syntheticInk(COUNT);

// The shared page rig, plus a two-finger pinch driven through the router with the fingers kept down, and a record of the
// watchdog's rebasePinch calls with the note's state right before and after each.
const ENTRY = `import "./panBakeRepaintPage.ts";
import { overlayForPath } from "../../src/inline/InkOverlay";
const PATH = ${JSON.stringify(PATH)};
const touch = { s: 100, cx: 0, cy: 0 };
const place = (s: number) => {
	const router = (overlayForPath(PATH) as any).router;
	router.touchPos.set(911, { x: touch.cx - s / 2, y: touch.cy }); router.touchPos.set(912, { x: touch.cx + s / 2, y: touch.cy });
};
const held: any = {
	rebases: [],
	read() {
		const o: any = overlayForPath(PATH);
		return { scale: o.pinchScaleNow, cssScale: o.cssScale, pinchHeld: !!o.pinchHeld(), anchor: o.pinchAnchor != null,
			refScale: o.pinchRefScale ?? null, ratioBase: o.pinchRatioBase ?? null, busy: !!o.getNoteViewportState().busy };
	},
	/** Record each rebasePinch the watchdog's timer calls, with what the note read right before and after it. */
	watchRebase() {
		const o: any = overlayForPath(PATH), rebase = o.rebasePinch;
		o.rebasePinch = function () { const before = held.read(); const r = rebase.call(this); held.rebases.push({ before, after: held.read() }); return r; };
		return true;
	},
	/** Fingers down at the pane centre, 100 px apart. */
	begin() {
		const router = (overlayForPath(PATH) as any).router;
		const r = (document.body.querySelector(":scope > div") as HTMLElement).getBoundingClientRect();
		touch.cx = r.left + r.width / 2; touch.cy = r.top + r.height / 2; touch.s = 100;
		place(touch.s);
		router.beginPinch(new PointerEvent("pointerdown", { pointerId: 912, pointerType: "touch" }));
		return true;
	},
	/** Spread the fingers to "to" times their first spread, one move a frame over "steps" frames, fingers kept down. */
	spreadTo(to: number, steps: number) {
		const router = (overlayForPath(PATH) as any).router, from = touch.s, s1 = 100 * to;
		return new Promise<boolean>(done => {
			const move = (i: number) => {
				touch.s = from + (s1 - from) * i / steps; place(touch.s);
				router.updatePinch(new PointerEvent("pointermove", { pointerId: 912, pointerType: "touch" }));
				if (i < steps) requestAnimationFrame(() => move(i + 1)); else requestAnimationFrame(() => done(true));
			};
			requestAnimationFrame(() => move(1));
		});
	},
	end() {
		const router = (overlayForPath(PATH) as any).router;
		router.endPinch(new PointerEvent("pointerup", { pointerId: 912, pointerType: "touch" }), { x: touch.cx, y: touch.cy });
		router.touchPos.clear();
		return true;
	},
	frames(n: number) { return new Promise<boolean>(r => { const f = () => (--n > 0 ? requestAnimationFrame(f) : r(true)); requestAnimationFrame(f); }); },
};
(window as any).held = held;`;

let browser: Browser, script: string;

beforeAll(async () => {
	const b = await build({
		stdin: { contents: ENTRY, resolveDir: fileURLToPath(new URL("./", import.meta.url)), sourcefile: "pinchHeldPastRebaseEntry.ts", loader: "ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
	});
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true, args: [`--force-device-scale-factor=${DSF}`, "--window-size=1700,1000"] });
}, 180_000);
afterAll(async () => { await browser?.close(); });

type Read = { scale: number; cssScale: number; pinchHeld: boolean; anchor: boolean; refScale: number | null; ratioBase: number | null; busy: boolean };
const read = (page: Page) => page.evaluate(() => (window as any).held.read()) as Promise<Read>;

async function withPage(body: (page: Page) => Promise<void>) {
	const context = await browser.newContext({ viewport: null, hasTouch: true });
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	try {
		await body(page);
		expect(errors).toEqual([]);
	} finally { await context.close(); }
}

it("fingers held still past the watchdog's re-anchor, then moved on: the zoom follows them", async () => {
	await withPage(async (page) => {
		console.log("[cell] mount");
		await page.setContent(`<!doctype html><body class="theme-dark" style="margin:0; --font-text-size:19px; --background-modifier-border:#777777"></body>`);
		await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
		await page.addStyleTag({ content: MINIMAL_CSS });
		await page.addScriptTag({ content: script });
		const mounted = await page.evaluate(([z, s, id, w, h, n]) => (window as any).panBake.mount(z, s, id, w, h, n), [MOUNT_ZOOM, FIXTURE, PAGE_ID, PANE.w, PANE.h, COUNT] as const) as any;
		expect(mounted.strokes, "premise: every stroke loaded").toBe(COUNT);
		await page.evaluate(() => (window as any).held.watchRebase());
		console.log("[cell] pinch open");
		await page.evaluate(() => (window as any).held.begin());
		await page.evaluate((z) => (window as any).held.spreadTo(z, 8), HOLD_ZOOM);
		const open = await read(page);
		expect(open.pinchHeld && open.anchor, `premise: the pinch is held with an anchor (${JSON.stringify(open)})`).toBe(true);
		expect(open.scale, `premise: the pinch rests at 200 percent (${JSON.stringify(open)})`).toBeCloseTo(HOLD_ZOOM, 1);
		console.log("[cell] hold past the watchdog");
		await page.waitForTimeout(HOLD_MS);
		const rebases = await page.evaluate(() => (window as any).held.rebases) as { before: Read; after: Read }[];
		console.log(`[cell] rebases ${JSON.stringify(rebases)}`);
		expect(rebases.length, `premise: the watchdog's rebasePinch ran once under the held fingers (${JSON.stringify(rebases)})`).toBe(1);
		const rebased = await read(page);
		expect(rebased.scale, `premise: the scale held at 200 percent through the re-anchor (${JSON.stringify(rebased)})`).toBeCloseTo(HOLD_ZOOM, 1);
		console.log("[cell] move on");
		await page.evaluate((z) => (window as any).held.spreadTo(z, 8), MOVE_ZOOM);
		await page.evaluate(() => (window as any).held.frames(4));
		const moved = await read(page);
		console.log(`[cell] after the moves ${JSON.stringify(moved)}`);
		expect(moved.scale > HOLD_ZOOM + 0.5, `the fingers moved on after the re-anchor and the zoom stayed put (${JSON.stringify({ rebases, moved })})`).toBe(true);
		await page.evaluate(() => (window as any).held.end());
		await page.evaluate(() => (window as any).held.frames(8));
	});
}, 60_000);
