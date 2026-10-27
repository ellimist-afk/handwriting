/**
 * WHAT THE STROKE ERASER COSTS AT ITS LARGEST SIZE, ZOOMED OUT, ON ALAN'S HEAVY CANVAS NOTE.
 *
 * What it looks like: on Orion (vault test 2, note "Untitled 1", 4,969 strokes, Infinite Canvas on by the sidecar) the
 * stroke eraser with the size slider at its maximum (64 px) stutters.
 *
 * It mounts the note's real sidecar (a copy of the vault file, read from HW_ESL_SIDECAR; 7 MB, so it is not checked in)
 * with the note's own text, canvas on, Alan's font 12, the Minimal theme, at device pixel ratio 1.8257 (Orion's page
 * zoom). It pinches to HW_ESL_ZOOM (default 0.25), waits for the extent raster, scrolls to the densest viewport, and
 * scrubs: three horizontal passes across the pane at a quarter, half and three quarters of its height, pen down at the
 * left, one move every 16 ms of 10 css px (600 css px a second), pen up at the right. Every pen event goes through the
 * real router as a PointerEvent, with the eraser on in Stroke mode at radius HW_ESL_RADIUS (default 64).
 *
 * A warm-up (six hovers, a pen down and up at the pane's top-left corner) runs first, unrecorded.
 *
 * Per frame it reads the plugin's own work: every requestAnimationFrame callback of that frame plus every pen handler
 * that ran since the frame before. It counts the frames whose damage ledger handed the repaint "all" while the pen was
 * down, and after the last lift, the frames until the extent raster holds again and whether a pan then copies from it.
 *
 * THE CLAIM: no scrub frame takes more than 8 ms of plugin work, and no frame with the pen down repaints "all". After the
 * last lift the extent raster holds again within 300 frames, and no frame after a lift takes
 * more than 16 ms.
 *
 * Run: HW_ERASER_SCRUB_LAG=1 HW_ESL_SIDECAR=<copy of the vault sidecar> npx vitest run --config vitest.render.mts
 *   test/render/EraserScrubLag.test.ts. HW_ESL_OUT=<file> writes the frames as JSON. HW_ESL_ZOOM=<k>, HW_ESL_RADIUS=<px>.
 *   HW_ESL_RECORD=1 records and prints without asserting the claim (for the base arm).
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";
import { timingBound } from "../ciBounds";

declare const process: { env: Record<string, string | undefined>; platform: string };

const SIDECAR_PATH = process.env.HW_ESL_SIDECAR ?? "";
const ENABLED = process.env.HW_ERASER_SCRUB_LAG === "1" && existsSync(SIDECAR_PATH);
const PAGE_ID = "75d1627a-c4d7-4a11-947d-bc26b7f83c20";
/** The note's text below its frontmatter, as in the vault file. */
const NOTE_TEXT = "\tdasdf\n\tasjd\n\tfjas\n\tdjf\n\tasjdf\n\tasjd\n\tfjas\n\tdjf\n\tasdjf\n\tj\nsa\t3d3w3adwmarath";
const DPR = Number(process.env.HW_ESL_DPR ?? "1.8257");
const ZOOM = Number(process.env.HW_ESL_ZOOM ?? "0.25");
const RADIUS = Number(process.env.HW_ESL_RADIUS ?? "64");
const RECORD_ONLY = process.env.HW_ESL_RECORD === "1";
const MINIMAL_CSS = readFileSync(fileURLToPath(new URL("./fixtures/minimal-9.0.2-theme.css", import.meta.url)), "utf8");

const PAGE = `
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { Platform } from "obsidian";
import { inlineInk, inkOverlayExtension, overlayForPath, setScrollExpansionEnabled, setInlineTool, setInlineEraserMode, setEraserWholeStrokes, setEraserRadiusPx } from "../../src/inline/InkOverlay";
import { setPenInk } from "../../src/inline/PenInk";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField } from "./iphoneObsidianStub";
import { parsePage } from "../../src/model/PageData";

installObsidianDom();
Object.assign(Platform, { isMobile: false, isDesktop: true, isIosApp: false, isAndroidApp: false, isDesktopApp: true, isMobileApp: false, isPhone: false, isTablet: false, isWin: true });

const ids = new Map(), sidecars = new Map();
inlineInk.attachHost({ readPageId: p => ids.get(p) ?? null, claimId: async (p, id) => { ids.set(p, id); return { pageId: id }; },
	loadSidecar: async id => (sidecars.has(id) ? parsePage(sidecars.get(id), id) : null),
	scheduleSidecar: () => {}, scheduleSidecarNow: async () => {}, notify: () => {} });

const rawRaf = window.requestAnimationFrame.bind(window);
let phase = "mount", recording = false;
const frames = new Map();
const events = [];
window.requestAnimationFrame = function (cb) {
	return rawRaf(ts => {
		const t0 = performance.now();
		try { return cb(ts); } finally {
			if (recording) {
				const ms = performance.now() - t0;
				let f = frames.get(ts);
				if (!f) { f = { ts, phase, rafMs: 0, callbacks: 0, at: t0 }; frames.set(ts, f); }
				f.rafMs += ms; f.callbacks++;
			}
		}
	});
};
const frame = () => new Promise(r => rawRaf(() => r()));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await frame(); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PANE_W = 1397.5, PANE_H = 800, HOST_LEFT = 300;
let rig = null;
const count = {};
const step = (what) => console.log("ESL-STEP " + what + " " + Math.round(performance.now()));
const bump = k => { count[phase + ":" + k] = (count[phase + ":" + k] ?? 0) + 1; };

function installSizer(view) {
	const sizer = document.createElement("div"); sizer.className = "cm-sizer";
	const container = document.createElement("div"); container.className = "cm-contentContainer";
	view.contentDOM.parentElement.insertBefore(sizer, view.contentDOM); sizer.appendChild(container); container.appendChild(view.contentDOM);
	void view.scrollDOM.clientWidth; return sizer;
}

window.eraserLag = {
	async mount(sidecar, pageId, text, zoom, radius) {
		setPenInk(true); setScrollExpansionEnabled(true); setInlineTool("pen");
		const path = "Untitled 1.md";
		sidecars.set(pageId, sidecar); ids.set(path, pageId);
		const pane = document.body.appendChild(document.createElement("div"));
		pane.className = "markdown-source-view mod-cm6";
		pane.style.cssText = "position:relative;margin-left:" + (HOST_LEFT + 1 / 3) + "px;margin-top:77.5px;width:" + PANE_W + "px;height:" + PANE_H + "px;overflow:hidden";
		document.body.classList.add("handwriting-paper-lines");
		const view = new EditorView({ parent: pane, state: EditorState.create({ doc: text, extensions: [history(), EditorView.lineWrapping,
			editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} })), inkOverlayExtension(),
			EditorView.theme({ "&": { width: PANE_W + "px", height: PANE_H + "px" }, ".cm-scroller": { overflowY: "auto", overflowX: "auto" } })] }) });
		installSizer(view);
		step("view");
		for (let i = 0; i < 200 && inlineInk.strokes(path).length === 0; i++) await settle(2);
		await settle(12);
		const overlay = overlayForPath(path);
		if (!overlay) throw new Error("no overlay for " + path);
		rig = { pane, view, overlay, path };
		step("loaded " + inlineInk.strokes(path).length);
		overlay.updateExtent(true);
		await settle(12);
		if (zoom !== 1) {
			const r = view.scrollDOM.getBoundingClientRect(), focal = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
			overlay.pinch("start", 1, focal); overlay.pinch("move", zoom, focal); overlay.pinch("end", zoom, focal);
			await settle(14); await sleep(400); await settle(8);
		}
		step("zoomed " + overlay.cssScale);
		// The densest viewport: the scroll top whose camera shows the most points. Two probes give the scroll-to-world ratio,
		// so the search scrolls only once more (scrolling a heavy note step by step outlasted the test timeout).
		const sd = view.scrollDOM, strokes = inlineInk.strokes(path);
		const maxTop = sd.scrollHeight - sd.clientHeight;
		sd.scrollTop = 0; await settle(4);
		const c0 = { ...overlay.camera.snapshot };
		const probe = Math.min(800, maxTop);
		sd.scrollTop = probe; await settle(4);
		const c1 = { ...overlay.camera.snapshot }, perPx = probe > 0 ? (c1.y - c0.y) / probe : 0;
		const w = PANE_W / c0.zoom, h = PANE_H / c0.zoom;
		let best = { top: 0, points: -1, strokes: 0 };
		for (let top = 0; top <= maxTop; top += Math.round(PANE_H / 4)) {
			const cy = c0.y + top * perPx;
			let pts = 0, n = 0;
			for (const s of strokes) { const b = s.bbox; if (b.x < c0.x + w && b.x + b.width > c0.x && b.y < cy + h && b.y + b.height > cy) { pts += s.points.length; n++; } }
			if (pts > best.points) best = { top, points: pts, strokes: n };
		}
		step("densest " + JSON.stringify(best) + " of " + sd.scrollHeight);
		sd.scrollTop = best.top;
		await settle(8); await sleep(400); await settle(4);
		for (let i = 0; i < 400 && overlay.extentBuild; i++) await sleep(25);
		await settle(4);
		step("raster " + !!overlay.extentRaster);
		setEraserRadiusPx(radius); setEraserWholeStrokes(true); setInlineEraserMode(true);
		await settle(4);
		const take = overlay.damage.take.bind(overlay.damage);
		overlay.damage.take = function () { const w = take(); if (recording) bump(w === "all" ? "takeAll" : w.length ? "takeRects" : "takeNone"); return w; };
		for (const k of ["copyFromExtent", "copyFromStandIn"]) {
			const orig = overlay[k];
			overlay[k] = function (...a) { const ok = orig.apply(this, a); if (ok && recording) bump(k); return ok; };
		}
		const erase = overlay.eraseAt;
		overlay.eraseAt = function (...a) { if (recording) bump("eraseAt"); return erase.apply(this, a); };
		return { strokes: strokes.length, points: strokes.reduce((s, x) => s + x.points.length, 0), canvasMode: !!overlay.canvasMode,
			cssScale: overlay.cssScale, raster: !!overlay.extentRaster, scrollTop: best.top, visibleStrokes: best.strokes, visiblePoints: best.points,
			dpr: window.devicePixelRatio };
	},
	async run() {
		const { view, overlay, path } = rig, sd = view.scrollDOM;
		const r = sd.getBoundingClientRect();
		let down = false;
		const pen = (type, px, py) => {
			const target = document.elementFromPoint(px, py);
			if (!target) throw new Error("pen point outside the page");
			const t0 = performance.now();
			target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "pen", pointerId: 932, isPrimary: true,
				clientX: px, clientY: py, buttons: type === "pointerdown" || (type === "pointermove" && down) ? 1 : 0, pressure: type === "pointerdown" || (type === "pointermove" && down) ? 0.5 : 0 }));
			if (type === "pointerdown") down = true; else if (type === "pointerup") down = false;
			if (recording) events.push({ phase, type, t: t0, ms: performance.now() - t0 });
		};
		// Warm-up, not recorded: the first pen hover and the first pen down pay one-time setup (about 9 ms between them on
		// both builds at zoom 1, before any erase). Hovers, then a down and up at the pane's top-left corner.
		const wx = r.left + 6, wy = r.top + 6;
		for (let i = 0; i < 6; i++) { pen("pointermove", wx + 4 * i, wy); await sleep(16); }
		const warmBefore = inlineInk.strokes(path).length;
		pen("pointerdown", wx + 20, wy); await sleep(16); pen("pointerup", wx + 20, wy);
		await settle(6); await sleep(200);
		const warmErased = warmBefore - inlineInk.strokes(path).length;
		const before = inlineInk.strokes(path).length;
		recording = true;
		phase = "scrub";
		for (const fy of [0.25, 0.5, 0.75]) {
			const y = r.top + r.height * fy, x0 = r.left + 20, x1 = r.left + r.width - 20;
			pen("pointermove", x0, y); await sleep(16);
			step("pass " + fy);
			pen("pointerdown", x0, y);
			for (let x = x0 + 10; x < x1; x += 10) { await sleep(16); pen("pointermove", x, y); }
			await sleep(16);
			phase = "lift";
			pen("pointerup", x1, y);
			await settle(2);
			phase = "scrub";
		}
		step("scrubbed");
		phase = "after";
		const lift = performance.now();
		let toRaster = null;
		for (let n = 1; n <= 300; n++) {
			await frame(); await sleep(0);
			if (overlay.extentRaster && !overlay.extentBuild) { toRaster = n; break; }
		}
		const afterMs = performance.now() - lift;
		phase = "pan";
		// A pan the length of a touch pan (50 steps of 12 css px, 30 ms apart, as PanBakeRepaint's), toward the side with room
		// (the densest viewport can sit at the end of the scroll range), then the settle: far enough that the band moves and
		// owes strips, which copy from the raster when one holds.
		const panFrom = sd.scrollTop, dir = panFrom + 600 <= sd.scrollHeight - sd.clientHeight ? 1 : -1;
		for (let i = 0; i < 50; i++) { await sleep(30); sd.scrollTop += dir * 12; }
		await sleep(900); await settle(4);
		const panMoved = sd.scrollTop - panFrom;
		recording = false;
		phase = "done";
		return { frames: [...frames.values()].sort((a, b) => a.ts - b.ts), events, count, erased: before - inlineInk.strokes(path).length, warmErased,
			toRaster, afterMs, cssScale: overlay.cssScale, panMoved };
	},
};
`;

let browser: Browser, script: string;
const record: unknown[] = [];
beforeAll(async () => {
	if (!ENABLED) return;
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "eraserScrubLagPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);
afterAll(async () => {
	await browser?.close();
	if (process.env.HW_ESL_OUT) writeFileSync(process.env.HW_ESL_OUT, JSON.stringify(record, null, 1));
});

const call = (p: Page, method: string, ...args: unknown[]) => p.evaluate(([m, a]) => (window as any).eraserLag[m](...a), [method, args] as const);
type Frame = { ts: number; phase: string; rafMs: number; callbacks: number; at: number };
type Ev = { phase: string; type: string; t: number; ms: number };

/** Per frame: its callbacks plus every pen handler that ran after the frame before it. */
function frameWork(frames: Frame[], events: Ev[]) {
	const out: { phase: string; ms: number; rafMs: number; handlerMs: number; handlers: number }[] = [];
	let prev = -Infinity;
	const evs = [...events].sort((a, b) => a.t - b.t);
	for (const f of frames) {
		const mine = evs.filter(e => e.t >= prev && e.t < f.at);
		const handlerMs = mine.reduce((s, e) => s + e.ms, 0);
		out.push({ phase: f.phase, ms: f.rafMs + handlerMs, rafMs: f.rafMs, handlerMs, handlers: mine.length });
		prev = f.at;
	}
	return out;
}

const gated = ENABLED ? it : it.skip;
gated(`stroke eraser at ${RADIUS} px, zoom ${ZOOM}: three scrubs over the densest viewport, no frame over 8 ms of plugin work, none repaints everything`, async () => {
	const page = await browser.newPage({ viewport: { width: 1800, height: 900 }, deviceScaleFactor: DPR });
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	page.on("console", m => { if (m.text().startsWith("ESL-STEP")) console.log(m.text()); });
	try {
		await page.setContent(`<!doctype html><body class="theme-dark" style="margin:0; --font-text-size:12px; --background-modifier-border:#777777"></body>`);
		await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
		await page.addStyleTag({ content: MINIMAL_CSS });
		await page.addScriptTag({ content: script });
		const mounted = await call(page, "mount", readFileSync(SIDECAR_PATH, "utf8"), PAGE_ID, NOTE_TEXT, ZOOM, RADIUS) as any;
		const r = await call(page, "run") as any;
		const fw = frameWork(r.frames, r.events);
		const scrub = fw.filter(f => f.phase === "scrub").map(f => f.ms).sort((a, b) => a - b);
		const q = (p: number) => scrub.length ? Math.round(scrub[Math.min(scrub.length - 1, Math.ceil(p * scrub.length) - 1)]! * 100) / 100 : null;
		const bound = timingBound(8);
		const summary = { zoom: ZOOM, radius: RADIUS, mounted, frames: scrub.length, median: q(0.5), p95: q(0.95), max: q(1),
			over: scrub.filter(ms => ms > bound).length, bound, count: r.count, erased: r.erased, warmErased: r.warmErased, toRaster: r.toRaster, afterMs: Math.round(r.afterMs), cssScale: r.cssScale, panMoved: r.panMoved };
		record.push({ summary, frames: fw, events: r.events });
		console.log("ERASER-SCRUB-LAG " + JSON.stringify(summary));
		const brief = "\n" + JSON.stringify(summary, null, 1);
		expect(errors, "page errors").toEqual([]);
		expect(mounted.strokes, `premise: the note's strokes${brief}`).toBe(4969);
		expect(mounted.canvasMode, `premise: canvas on${brief}`).toBe(true);
		expect(Math.abs(mounted.cssScale - ZOOM), `premise: the note is at zoom ${ZOOM}${brief}`).toBeLessThan(0.01);
		expect(r.count["scrub:eraseAt"] ?? 0, `premise: the eraser ran${brief}`).toBeGreaterThan(100);
		expect(r.erased, `premise: the scrub erased strokes${brief}`).toBeGreaterThan(12);
		if (RECORD_ONLY) return;
		expect(r.count["scrub:takeAll"] ?? 0, `no frame with the pen down repaints everything${brief}`).toBe(0);
		expect(summary.over, `scrub frames over ${bound} ms (max ${summary.max})${brief}`).toBe(0);
		// After the last lift: the lift asks for a build and the raster holds again within the window. The pan after it is recorded,
		// not asserted: a scripted scroll moves the camera by a fraction of a device pixel, which the raster copy refuses; a touch
		// pan after a wide erase copying from the raster is PanBakeRepaint's cell.
		expect(r.toRaster, `the extent raster holds again within 300 frames of the last lift${brief}`).not.toBeNull();
		const afterBound = timingBound(16), afterLift = fw.filter(f => f.phase === "lift" || f.phase === "after");
		expect(afterLift.filter(f => f.ms > afterBound).map(f => Math.round(f.ms * 100) / 100), `frames after a lift over ${afterBound} ms${brief}`).toEqual([]);
	} finally { await page.close(); }
}, 600_000);
