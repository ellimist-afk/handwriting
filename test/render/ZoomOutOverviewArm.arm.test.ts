/**
 * Arm, no assertion on the outcome: does a zoom out from a 4.5x landing on an over-cap note show ink outside the start view, and
 * does a pen stroke written after the landing take that away.
 *
 * Seen on Alan's take 13 path (34 strokes written at 4.5x, then a ctrl+wheel zoom out): no ink outside the start view before the
 * landing. First suspect by reading: overviewHolds refuses once the note holds one stroke more than the overview picture, while a pen
 * commit only extends the extent build.
 *
 * P0: land at 4.5x, wait until the overview is set or 3 s, zoom out. P1: land, wait the same way, write 3 pen strokes inside the start
 * view, lift, zoom out 0.5 s after the last lift. Each logs at the pinch start: overview set (and its count against the store's),
 * the overview build's next and count, the extent build's next and count, and the held source's kind once the first preview frame
 * is up; then ink px outside the start view on the first five preview frames (one wheel run of two 22.66 px events each, the quiet
 * end held off, read on screen the way ZoomOutHeldRaster.test.ts reads it).
 *
 * The landing is a committed camera zoom to 4.5 about the pane's top-left with a whole repaint, as the page's own mount commits its
 * start zoom; not a wheel run in. Desktop platform answers (panBakeRepaintPage.ts sets them).
 *
 * Ink: HW_ZO_INK (the EXAM 2 ink copy, 5307 strokes) with HW_ZO_PAGE, else the committed fixture alan-ink-75d1627a.json whole.
 * Skipped unless HW_OV_ARM=1. Writes the report to HW_ZO_OUT when set.
 *
 * Run: HW_OV_ARM=1 HW_ZO_INK=<exam2-ink-v4.json> HW_ZO_PAGE=1329a73d-4a53-43d6-901e-85f914ac07be
 *   npx vitest run --config vitest.render.mts test/render/ZoomOutOverviewArm.arm.test.ts
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

declare const process: { env: Record<string, string | undefined> };

const ARM = process.env.HW_OV_ARM === "1";
const MINIMAL_CSS = readFileSync(fileURLToPath(new URL("./fixtures/minimal-9.0.2-theme.css", import.meta.url)), "utf8");
const INK = process.env.HW_ZO_INK ? readFileSync(process.env.HW_ZO_INK, "utf8")
	: readFileSync(fileURLToPath(new URL("./fixtures/alan-ink-75d1627a.json", import.meta.url)), "utf8");
const PAGE_ID = process.env.HW_ZO_PAGE ?? "75d1627a-c4d7-4a11-947d-bc26b7f83c20";
const DSF = Number(process.env.HW_ZO_DSF ?? "1.37");
const OUT = process.env.HW_ZO_OUT ?? "";
const START_ZOOM = 0.8498685519398922;
const LAND_ZOOM = 4.5;
const PANE = { w: 1185, h: 710 };
const STEP_PX = 22.66;

const ENTRY = `import "./panBakeRepaintPage.ts";
import { overlayForPath, inlineInk } from "../../src/inline/InkOverlay";
const PATH = "Untitled 1.md";
const frame = () => new Promise<void>(r => requestAnimationFrame(() => r()));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await frame(); };
const Z: any = { masks: new Map(), wraps: [] as Array<() => void>, starts: [] as any[] };
const ov = (): any => overlayForPath(PATH);
function wrap(obj: any, name: string, make: (orig: any) => any) { const orig = obj[name]; obj[name] = make(orig); Z.wraps.push(() => { obj[name] = orig; }); }
function heldKind(o: any) {
	const h = o.heldRaster;
	if (!h) return "none";
	const p = h.src?.pen;
	return o.overview && p === o.overview.pen ? "overview" : o.extentRaster && p === o.extentRaster.pen ? "extent" : o.standIn && p === o.standIn.pen ? "standIn" : "other";
}
function state() {
	const o = ov(), v = o.overview, b = o.overviewBuild, e = o.extentBuild;
	return { t: Math.round(performance.now()), zoom: o.lastPaintCam?.zoom ?? null, scale: o.pinchScaleNow, store: inlineInk.strokes(PATH).length,
		overview: v ? { count: v.count, zoom: v.at.zoom, w: v.pen.width, h: v.pen.height } : null,
		overviewBuild: b ? { next: b.next, count: b.count } : null, extentBuild: e ? { next: e.next, count: e.count } : null,
		extentRaster: !!o.extentRaster, standIn: !!o.standIn, held: heldKind(o) };
}
(window as any).ova = {
	state,
	/** Commit the camera at zoom z about the pane's top-left and repaint whole; then wait until the overview is set or limit ms. */
	async land(z: number, limit: number) {
		const o = ov();
		const t0 = performance.now();
		const committed = !!o.commitCameraScale(z, { left: 0, top: 0 });
		o.scheduleRepaint("other");
		let setMs = -1;
		while (performance.now() - t0 < limit) {
			if (o.overview) { setMs = performance.now() - t0; break; }
			await frame();
		}
		await settle(2);
		return { committed, setMs: setMs < 0 ? -1 : Math.round(setMs), waitedMs: Math.round(performance.now() - t0), after: state() };
	},
	/** n short pen strokes inside the start view, one at a time, each lifted; ms of the last lift. */
	async write(n: number) {
		const o = ov(), view = o.view, r = view.scrollDOM.getBoundingClientRect();
		const before = inlineInk.strokes(PATH).length;
		let down = false;
		const pen = (type: string, x: number, y: number) => {
			const buttons = type === "pointerdown" || (type === "pointermove" && down) ? 1 : 0;
			view.contentDOM.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "pen", pointerId: 83, isPrimary: true, clientX: x, clientY: y, buttons, pressure: buttons ? 0.5 : 0 }));
			if (type === "pointerdown") down = true; else if (type === "pointerup") down = false;
		};
		let lift = 0;
		for (let i = 0; i < n; i++) {
			const x0 = r.left + 200 + i * 120, y0 = r.top + 200;
			pen("pointerdown", x0, y0);
			for (let j = 1; j <= 8; j++) { await frame(); pen("pointermove", x0 + j * 8, y0 + j * 4); }
			pen("pointerup", x0 + 64, y0 + 32);
			lift = performance.now();
			await settle(4);
		}
		return { before, after: inlineInk.strokes(PATH).length, lift: Math.round(lift), state: state() };
	},
	async sleepUntil(t: number) { while (performance.now() < t) await frame(); return Math.round(performance.now()); },
	/** Hold the quiet end off and log the pinch start: state just before and just after the start call. */
	begin() {
		const o = ov();
		o.armWheelZoomQuiet = () => {};
		Z.starts = [];
		wrap(o, "pinch", orig => function (this: any, phase: string, ...a: any[]) {
			if (phase !== "start") return orig.call(this, phase, ...a);
			const pre = state(); const v = orig.call(this, phase, ...a); Z.starts.push({ pre, post: state() }); return v;
		});
		return state();
	},
	/** One wheel run of n events about the pane's top-left, then the next frame: the state there. */
	async wheel(n: number, dy: number) {
		const o = ov(), r = o.view.scrollDOM.getBoundingClientRect();
		const ev = { ctrlKey: true, metaKey: false, deltaY: dy, deltaMode: 0, clientX: r.left + 40, clientY: r.top + 40, preventDefault() {}, stopPropagation() {} };
		for (let i = 0; i < n; i++) o.wheelZoom(ev);
		await frame();
		return { state: state(), starts: Z.starts.slice() };
	},
	end() { for (const u of Z.wraps.splice(0).reverse()) u(); return state(); },
	rects() {
		const o = ov(), sc = o.view.scrollDOM, p = sc.getBoundingClientRect(), c = o.committedCanvas.getBoundingClientRect();
		return { pane: { x: p.left, y: p.top, w: p.width, h: p.height }, start: { x: c.left, y: c.top, w: c.width, h: c.height } };
	},
	hide(on: boolean) {
		let s = document.getElementById("zo-hide");
		if (!s) { s = document.head.appendChild(document.createElement("style")); s.id = "zo-hide"; s.textContent = ".zo-hide canvas { visibility: hidden !important; }"; }
		ov().view.dom.classList.toggle("zo-hide", on);
	},
	/** Ink px: shown against hidden, both PNG base64 of the same clip; the count outside 'excl' (device px in the clip). */
	async diff(a: string, b: string, excl: { x0: number; y0: number; x1: number; y1: number } | null) {
		const read = async (s: string) => { const bm = await createImageBitmap(await (await fetch("data:image/png;base64," + s)).blob());
			const c = new OffscreenCanvas(bm.width, bm.height), x = c.getContext("2d")!; x.drawImage(bm, 0, 0); return x.getImageData(0, 0, bm.width, bm.height); };
		const A = await read(a), B = await read(b), W = A.width, H = A.height;
		let all = 0, outside = 0;
		for (let y = 0, i = 0; y < H; y++) for (let x = 0; x < W; x++, i++) {
			const j = i * 4;
			const d = Math.max(Math.abs(A.data[j]! - B.data[j]!), Math.abs(A.data[j + 1]! - B.data[j + 1]!), Math.abs(A.data[j + 2]! - B.data[j + 2]!));
			if (d <= 24) continue;
			all++;
			if (!excl || x < excl.x0 || x >= excl.x1 || y < excl.y0 || y >= excl.y1) outside++;
		}
		return { all, outside };
	},
};`;

let script: string;
let browser: Browser;
const report: Record<string, unknown> = { dsf: DSF, ink: process.env.HW_ZO_INK ?? "fixtures/alan-ink-75d1627a.json", land: LAND_ZOOM };
beforeAll(async () => {
	if (!ARM) return;
	const b = await build({
		stdin: { contents: ENTRY, resolveDir: fileURLToPath(new URL("./", import.meta.url)), sourcefile: "zoomOutOverviewArmEntry.ts", loader: "ts" },
		bundle: true, write: false, format: "iife", platform: "browser",
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
	});
	script = b.outputFiles![0]!.text;
	browser = await chromium.launch({ headless: true, args: [`--force-device-scale-factor=${DSF}`, "--window-size=1700,1000"] });
}, 180_000);
afterAll(async () => {
	await browser?.close();
	if (ARM && OUT) writeFileSync(OUT, JSON.stringify(report, null, 1));
});

async function withPage(name: string, body: (page: Page) => Promise<void>): Promise<void> {
	const context = await browser.newContext({ viewport: null, hasTouch: true });
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	try {
		await page.setContent(`<!doctype html><body class="theme-dark" style="margin:0; --font-text-size:19px; --background-modifier-border:#777777"></body>`);
		await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
		await page.addStyleTag({ content: MINIMAL_CSS });
		await page.addScriptTag({ content: script });
		const want = (JSON.parse(INK) as { strokes: unknown[] }).strokes.length;
		const mounted = await page.evaluate(([z, s, id, w, h, n]) => (window as any).panBake.mount(z, s, id, w, h, n), [START_ZOOM, INK, PAGE_ID, PANE.w, PANE.h, want] as const) as any;
		expect(mounted.strokes, "premise: every stroke loaded").toBe(want);
		expect(mounted.dpr, "premise: the device ratio is the flag's").toBeCloseTo(DSF, 2);
		await page.evaluate(() => (window as any).panBake.awaitSharp());
		await body(page);
		expect(errors, `${name}: page errors`).toEqual([]);
	} finally { await context.close(); }
}

/** Ink px outside the start view's box on the frame now on screen. */
async function outsideNow(page: Page, start: { x: number; y: number; w: number; h: number }) {
	const r = await page.evaluate(() => (window as any).ova.rects()) as { pane: { x: number; y: number; w: number; h: number } };
	const clip = { x: r.pane.x, y: r.pane.y, width: r.pane.w, height: r.pane.h };
	const a = (await page.screenshot({ clip })).toString("base64");
	await page.evaluate(() => (window as any).ova.hide(true));
	const b = (await page.screenshot({ clip })).toString("base64");
	await page.evaluate(() => (window as any).ova.hide(false));
	const k = DSF, p = r.pane, s = start;
	const excl = { x0: Math.floor((s.x - p.x) * k) - 2, y0: Math.floor((s.y - p.y) * k) - 2, x1: Math.ceil((s.x + s.w - p.x) * k) + 2, y1: Math.ceil((s.y + s.h - p.y) * k) + 2 };
	return await page.evaluate(([a, b, e]) => (window as any).ova.diff(a, b, e), [a, b, excl] as const) as { all: number; outside: number };
}

/** The zoom out: pinch start logged, then five preview frames read for ink outside the start view (the committed layer's box per frame). */
async function zoomOut(page: Page) {
	const begin = await page.evaluate(() => (window as any).ova.begin());
	const frames: unknown[] = [];
	let starts: unknown = null;
	for (let i = 0; i < 5; i++) {
		const w = await page.evaluate(([dy]) => (window as any).ova.wheel(2, dy), [STEP_PX] as const) as { state: unknown; starts: unknown[] };
		const r = await page.evaluate(() => (window as any).ova.rects()) as { start: { x: number; y: number; w: number; h: number } };
		const ink = await outsideNow(page, r.start);
		frames.push({ i, ...ink, state: w.state });
		if (i === 0) starts = w.starts;
	}
	const end = await page.evaluate(() => (window as any).ova.end());
	return { begin, starts, frames, end };
}

it.skipIf(!ARM)(`P0 at dsf ${DSF}: land at ${LAND_ZOOM}x, wait for the overview or 3 s, zoom out`, async () => {
	await withPage("P0", async page => {
		const land = await page.evaluate(([z]) => (window as any).ova.land(z, 3000), [LAND_ZOOM] as const) as any;
		expect(land.committed, "premise: the landing zoom committed").toBe(true);
		const out = await zoomOut(page);
		report.P0 = { land, ...out };
		console.log("P0 " + JSON.stringify(report.P0));
	});
}, 180_000);

it.skipIf(!ARM)(`P1 at dsf ${DSF}: land at ${LAND_ZOOM}x, wait the same, write 3 strokes in the start view, zoom out 0.5 s after the lift`, async () => {
	await withPage("P1", async page => {
		const land = await page.evaluate(([z]) => (window as any).ova.land(z, 3000), [LAND_ZOOM] as const) as any;
		expect(land.committed, "premise: the landing zoom committed").toBe(true);
		const write = await page.evaluate(() => (window as any).ova.write(3)) as any;
		expect(write.after - write.before, "premise: three strokes committed").toBe(3);
		const at = await page.evaluate(([t]) => (window as any).ova.sleepUntil(t), [write.lift + 500] as const) as number;
		const out = await zoomOut(page);
		report.P1 = { land, write, wheelAt: at, ...out };
		console.log("P1 " + JSON.stringify(report.P1));
	});
}, 180_000);
