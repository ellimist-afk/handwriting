/**
 * A pen stroke written after a 4.5x landing goes into the zoom-out overview picture, so the next zoom out still shows the ink outside
 * the start view.
 *
 * Seen on Alan's take 13 path and held by ZoomOutOverviewArm.arm.test.ts at 71fa5c24: with the overview set after the landing, three
 * pen strokes left it one stroke short of the store, overviewHolds refused it, and the zoom out held nothing on all five frames.
 *
 * Store cell: land at 4.5x, wait for the overview, write 3 pen strokes inside the start view through the real pen path (store()).
 * The picture's count equals the store's, its pen canvas changed inside the new strokes' device rect, and the pick the zoom out puts
 * up (heldRasterSource called from putUpHeldRaster) is the picture, clipped off the start view. Each pick is tagged with its caller:
 * the composite probe before it (preparePinchComposite) asks too and gets null on every overview start, pen or not.
 * P1: the same landing and wait, 3 strokes, the zoom out 0.5 s after the last lift. P1b: the same with no wait for the overview
 * before writing, but on this fixture the overview is set before the first pen down, so P1b shows the same path as P1; the unit
 * cell holds a commit while the build runs. Both: the picture holds the store at the pinch start, and the held
 * source is the overview on all five preview frames (one wheel run of two 22.66 px events each, the quiet end held off).
 *
 * The landing is a committed camera zoom to 4.5 about the pane's top-left with a whole repaint, as the arm's. Desktop platform
 * answers (panBakeRepaintPage.ts sets them). Ink: the committed fixture alan-ink-75d1627a.json whole, or HW_ZO_INK with HW_ZO_PAGE
 * for an evidence run. Ratio HW_ZO_DSF, default 1.37 (the film rig's). Writes the report to HW_ZO_OUT when set.
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

declare const process: { env: Record<string, string | undefined> };

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
const Z: any = { wraps: [] as Array<() => void>, picks: [] as any[] };
const ov = (): any => overlayForPath(PATH);
function wrap(obj: any, name: string, make: (orig: any) => any) { const orig = obj[name]; obj[name] = make(orig); Z.wraps.push(() => { obj[name] = orig; }); }
function heldKind(o: any) {
	const h = o.heldRaster;
	if (!h) return "none";
	const p = h.src?.pen;
	return o.overview && p === o.overview.pen ? "overview" : o.extentRaster && p === o.extentRaster.pen ? "extent" : o.standIn && p === o.standIn.pen ? "standIn" : "other";
}
function state() {
	const o = ov(), v = o.overview, b = o.overviewBuild;
	return { t: Math.round(performance.now()), zoom: o.lastPaintCam?.zoom ?? null, store: inlineInk.strokes(PATH).length,
		overview: v ? { count: v.count, zoom: v.at.zoom, w: v.pen.width, h: v.pen.height } : null,
		overviewBuild: b ? { next: b.next, count: b.count } : null, extentRaster: !!o.extentRaster, held: heldKind(o) };
}
(window as any).ovp = {
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
		return { committed, setMs: setMs < 0 ? -1 : Math.round(setMs), after: state() };
	},
	/** n short pen strokes inside the start view, one at a time, each lifted; the state as the first goes down, ms of the last lift. */
	async write(n: number) {
		const o = ov(), view = o.view, r = view.scrollDOM.getBoundingClientRect();
		const before = inlineInk.strokes(PATH).length;
		let down = false, first: unknown = null;
		const pen = (type: string, x: number, y: number) => {
			const buttons = type === "pointerdown" || (type === "pointermove" && down) ? 1 : 0;
			view.contentDOM.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "pen", pointerId: 83, isPrimary: true, clientX: x, clientY: y, buttons, pressure: buttons ? 0.5 : 0 }));
			if (type === "pointerdown") down = true; else if (type === "pointerup") down = false;
		};
		let lift = 0;
		for (let i = 0; i < n; i++) {
			const x0 = r.left + 200 + i * 120, y0 = r.top + 200;
			if (i === 0) first = state();
			pen("pointerdown", x0, y0);
			for (let j = 1; j <= 8; j++) { await frame(); pen("pointermove", x0 + j * 8, y0 + j * 4); }
			pen("pointerup", x0 + 64, y0 + 32);
			lift = performance.now();
			await settle(4);
		}
		return { before, after: inlineInk.strokes(PATH).length, first, lift: Math.round(lift), state: state() };
	},
	/** A copy of the picture's pen canvas as it is now, to compare against after a write. */
	keep() {
		const v = ov().overview;
		if (!v) return false;
		const c = document.createElement("canvas");
		c.width = v.pen.width; c.height = v.pen.height;
		c.getContext("2d")!.drawImage(v.pen, 0, 0);
		Z.kept = { pen: v.pen, copy: c };
		return true;
	},
	/** The strokes from index 'from' on: inside the picture's world rect, and px of its pen canvas changed in their device rect. */
	added(from: number) {
		const v = ov().overview, all = inlineInk.strokes(PATH), add = all.slice(from);
		if (!v || !Z.kept || add.length === 0) return { picture: !!v, same: false, inside: false, rect: null, px: 0, changed: 0 };
		let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
		for (const s of add) { const b = s.bbox; x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height); }
		const k = v.at.zoom * v.backing;
		const inside = x0 >= v.at.x && y0 >= v.at.y && x1 <= v.at.x + v.pen.width / k && y1 <= v.at.y + v.pen.height / k;
		const dx0 = Math.max(0, Math.floor((x0 - v.at.x) * k)), dy0 = Math.max(0, Math.floor((y0 - v.at.y) * k));
		const dx1 = Math.min(v.pen.width, Math.ceil((x1 - v.at.x) * k)), dy1 = Math.min(v.pen.height, Math.ceil((y1 - v.at.y) * k));
		const rect = { x: dx0, y: dy0, w: dx1 - dx0, h: dy1 - dy0 };
		if (!(rect.w > 0 && rect.h > 0)) return { picture: true, same: Z.kept.pen === v.pen, inside, rect, px: 0, changed: 0 };
		const A = v.pen.getContext("2d")!.getImageData(rect.x, rect.y, rect.w, rect.h).data;
		const B = Z.kept.copy.getContext("2d")!.getImageData(rect.x, rect.y, rect.w, rect.h).data;
		let changed = 0;
		for (let i = 0; i < A.length; i += 4) {
			const d = Math.max(Math.abs(A[i]! - B[i]!), Math.abs(A[i + 1]! - B[i + 1]!), Math.abs(A[i + 2]! - B[i + 2]!), Math.abs(A[i + 3]! - B[i + 3]!));
			if (d > 24) changed++;
		}
		return { picture: true, same: Z.kept.pen === v.pen, inside, rect, px: rect.w * rect.h, changed };
	},
	async sleepUntil(t: number) { while (performance.now() < t) await frame(); return Math.round(performance.now()); },
	/** Hold the quiet end off; log each pick the preview asks heldRasterSource for (whether it is the picture, and its clip), tagged
	 *  "putUp" when putUpHeldRaster asked and "other" for any other caller. */
	begin() {
		const o = ov();
		o.armWheelZoomQuiet = () => {};
		Z.picks = [];
		Z.putUp = false;
		wrap(o, "putUpHeldRaster", orig => function (this: any, ...a: any[]) {
			Z.putUp = true;
			try { return orig.apply(this, a); } finally { Z.putUp = false; }
		});
		wrap(o, "heldRasterSource", orig => function (this: any, ...a: any[]) {
			const p = orig.apply(this, a);
			Z.picks.push({ by: Z.putUp ? "putUp" : "other", pick: p ? { overview: !!this.overview && p.src === this.overview, clip: p.clip, count: p.count } : null });
			return p;
		});
		return state();
	},
	/** One wheel run of n events about the pane's top-left, then the next frame: the state there. */
	async wheel(n: number, dy: number) {
		const o = ov(), r = o.view.scrollDOM.getBoundingClientRect();
		const ev = { ctrlKey: true, metaKey: false, deltaY: dy, deltaMode: 0, clientX: r.left + 40, clientY: r.top + 40, preventDefault() {}, stopPropagation() {} };
		for (let i = 0; i < n; i++) o.wheelZoom(ev);
		await frame();
		return { state: state(), picks: Z.picks.slice() };
	},
	end() { for (const u of Z.wraps.splice(0).reverse()) u(); return state(); },
};`;

let script: string;
let browser: Browser;
const report: Record<string, unknown> = { dsf: DSF, ink: process.env.HW_ZO_INK ?? "fixtures/alan-ink-75d1627a.json", land: LAND_ZOOM };
beforeAll(async () => {
	const b = await build({
		stdin: { contents: ENTRY, resolveDir: fileURLToPath(new URL("./", import.meta.url)), sourcefile: "zoomOutOverviewPenEntry.ts", loader: "ts" },
		bundle: true, write: false, format: "iife", platform: "browser",
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
	});
	script = b.outputFiles![0]!.text;
	browser = await chromium.launch({ headless: true, args: [`--force-device-scale-factor=${DSF}`, "--window-size=1700,1000"] });
}, 180_000);
afterAll(async () => {
	await browser?.close();
	if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 1));
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

/** The zoom out: five wheel runs, the state on each one's first frame, the picks the preview asked for. */
async function zoomOut(page: Page) {
	const begin = await page.evaluate(() => (window as any).ovp.begin()) as any;
	const frames: any[] = [];
	let picks: unknown[] = [];
	for (let i = 0; i < 5; i++) {
		const w = await page.evaluate(([dy]) => (window as any).ovp.wheel(2, dy), [STEP_PX] as const) as { state: any; picks: unknown[] };
		frames.push({ i, ...w.state });
		picks = w.picks;
	}
	const end = await page.evaluate(() => (window as any).ovp.end());
	return { begin, frames, picks, end };
}

it(`store cell at dsf ${DSF}: 3 pen strokes after a ${LAND_ZOOM}x landing go into the overview picture`, async () => {
	await withPage("store", async page => {
		const land = await page.evaluate(([z]) => (window as any).ovp.land(z, 3000), [LAND_ZOOM] as const) as any;
		expect(land.committed, "premise: the landing zoom committed").toBe(true);
		expect(land.setMs, "premise: the overview was set after the landing").toBeGreaterThanOrEqual(0);
		expect(await page.evaluate(() => (window as any).ovp.keep()), "premise: a picture to keep").toBe(true);
		const write = await page.evaluate(() => (window as any).ovp.write(3)) as any;
		expect(write.after - write.before, "premise: three strokes committed").toBe(3);
		const added = await page.evaluate(([f]) => (window as any).ovp.added(f), [write.before] as const) as any;
		expect(added.inside, "premise: the strokes lie inside the picture's world rect").toBe(true);
		const out = await zoomOut(page);
		report.store = { land, write, added, ...out };
		console.log("store " + JSON.stringify(report.store));
		expect(write.state.overview?.count ?? null, "the picture's count after the write").toBe(write.after);
		expect(added.same, "the same picture, not a new build").toBe(true);
		expect(added.changed, "picture px changed inside the new strokes' device rect").toBeGreaterThan(0);
		const putUp = (out.picks as any[]).filter(p => p.by === "putUp").map(p => p.pick);
		expect(putUp, "the pick the zoom out puts up").toEqual([{ overview: true, clip: true, count: write.after }]);
	});
}, 180_000);

it.each([
	["P1", 3000],
	["P1b", 0],
] as const)(`%s at dsf ${DSF}: land at ${LAND_ZOOM}x (overview wait %i ms), write 3 strokes, zoom out 0.5 s after the lift: the overview holds`, async (name, wait) => {
	await withPage(name, async page => {
		const land = await page.evaluate(([z, l]) => (window as any).ovp.land(z, l), [LAND_ZOOM, wait] as const) as any;
		expect(land.committed, "premise: the landing zoom committed").toBe(true);
		const write = await page.evaluate(() => (window as any).ovp.write(3)) as any;
		expect(write.after - write.before, "premise: three strokes committed").toBe(3);
		const at = await page.evaluate(([t]) => (window as any).ovp.sleepUntil(t), [write.lift + 500] as const) as number;
		const out = await zoomOut(page);
		report[name] = { land, write, wheelAt: at, ...out };
		console.log(name + " " + JSON.stringify(report[name]));
		expect(out.begin.overview?.count ?? null, "the picture's count at the pinch start").toBe(out.begin.store);
		expect(out.frames.map(f => f.held), "held source on the five preview frames").toEqual(["overview", "overview", "overview", "overview", "overview"]);
	});
}, 180_000);
