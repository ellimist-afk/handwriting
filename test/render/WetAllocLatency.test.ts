/**
 * THE WET CANVAS IS 0x0 WHILE THE PAGE BOUNCES, AND SIZING IT AGAIN AT THE NEXT PEN-DOWN COSTS UNDER 8 MS.
 *
 * What it looks like: on Orion a fling into the top of the page springs back laggy. Nothing is drawn during the bounce
 * (BounceCanvasWrites.test.ts); the cost is the compositor blending every full-size canvas layer each frame at device
 * pixel ratio 2. The pen wet canvas is blank at rest, so it now drops to a 0x0 backing when the page moves with no
 * stroke in flight, and gets its backing back at the next pen-down, before the stroke's first wet pixel (arm W). The
 * price is one backing allocation at the first pen-down after a scroll; this cell prices it.
 *
 * THE DRIVE: the T1 "alan" page (BounceCanvasWrites.test.ts: a fenced note in Minimal 9.0.2 at base font 19, paper
 * lines, dark theme), 1800x900 at device pixel ratio 2 with touch, diagnostics on. Mount, two pen strokes, then per
 * repeat: a touch fling into the top edge (sixteen 30 px moves 16 ms apart), every frame until the spring ends, then a
 * pen-down and three moves in one task, two frames, the lift. One untimed repeat first (traced, for the canvas
 * provider name), then ten timed ones. Repeat i's pen-down lands 1.6 * i ms after a frame callback (0 to 14.4 ms), the
 * same phases in both arms: right after a callback a cost under one frame hides inside the frame, and on the device a
 * pen-down lands anywhere in one.
 *
 * Per repeat: the wet canvas's width on every spring frame; the synchronous cost of the dispatched pointerdown; the
 * time from that dispatch to the first animation frame after the first wet draw (the first draw call on the wet canvas
 * or its tile that is not a clear), which is the frame that shows the stroke's first wet pixels. Printed, not claimed:
 * the lift's synchronous cost and its dispatch to the next frame (the lift's clear is the first write the new backing
 * takes when the stroke stayed inside the wet tile).
 *
 * THE CONTROL ARM: the same drive with the release off (window.HW_ARM_W_OFF, read once at mount).
 *
 * CLAIMS. (a) The wet canvas is 0x0 on every spring frame with the release on, and sized on every spring frame with it
 * off. (b) The median dispatch-to-first-wet-frame time, release on minus release off, is under 8 ms. (b2) The median
 * dispatch-to-first-wet-draw time, release on minus release off, is under 8 ms.
 *
 * Why (b2): headless Chromium runs the next frame as soon as the main thread is free, not on a fixed display grid, so a
 * stall at the pen-down shows in (b) only by what it overruns the next frame by. Measured with the 12 ms plant: (b)
 * read 5.05 ms with the phases spread, and 0 with every pen-down right after a frame callback; the plant never turned (b)
 * red. (b2) is the same path without the frame: the allocation and the handler work up to the first wet pixel drawn,
 * which the plant does turn red. (b) stays as the gate was first written.
 * PREMISES, each asserted: the wet canvas is sized after mount and two strokes (writing alone releases nothing); every
 * repeat played a spring of at least ten frames that ended; the wet canvas is sized right after each pointerdown; every
 * stroke is stored; every repeat saw a wet draw.
 *
 * Rig frame pacing is noisy: a red on (b) gets one rerun of this file alone.
 *
 * PLANTS. HW_WET_ALLOC_PLANT=1: a width setter on HTMLCanvasElement that busy-waits 12 ms whenever a non-zero width is
 * set, from the first timed repeat on; (b2) must go red. HW_WET_ALLOC_PLANT_NO_RELEASE=1: releaseWetIfIdle returns at
 * once, applied to InkOverlay.ts as the bundle is built (the anchor must match once); (a) must go red.
 *
 * On Windows the browser runs with the GPU (the lag rig's flags, LazyHighlightPairTrace.test.ts), so the allocation
 * is priced on a GPU canvas as on the device; the provider name read from the trace is printed (SharedImage = GPU
 * backed, Bitmap = a CPU canvas, which prices a different allocation).
 *
 * Run: npx vitest run --config vitest.render.mts test/render/WetAllocLatency.test.ts
 * HW_WET_ALLOC_OUT=<file> writes both arms' repeats as JSON.
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";
import { INK_TRACE_CATEGORIES } from "../../src/diag/InkTrace";

declare const process: { env: Record<string, string | undefined>; platform: string };

/** Minimal 9.0.2's theme.css, verbatim (the fixture MinimalCameraScale.test.ts loads): vault test 2's theme. */
const MINIMAL_CSS = readFileSync(fileURLToPath(new URL("./fixtures/minimal-9.0.2-theme.css", import.meta.url)), "utf8");

const PAGE = `
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { inlineInk, inkOverlayExtension, overlayForPath, setScrollExpansionEnabled, setInlineTool, setInkSizeMult, inkCanvasReallocs } from "../../src/inline/InkOverlay";
import { setInkColorHex } from "../../src/ink/InkColor";
import { setPenInk } from "../../src/inline/PenInk";
import { setDiagnosticsEnabled } from "../../src/diag/DiagSwitch";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField } from "./iphoneObsidianStub";
import { parsePage, serializePage } from "../../src/model/PageData";

installObsidianDom();

// ---- the first wet draw: a draw call on the wet canvas or its tile, clears excluded, once armed --------------------
const DRAW = ["fillRect", "strokeRect", "fillText", "strokeText", "fill", "stroke", "drawImage", "putImageData"];
const watch = { armed: false, targets: new Map(), drawAt: 0, frameAt: 0, method: "", canvas: "" };
const ctxProto = CanvasRenderingContext2D.prototype;
for (const k of DRAW) {
	const orig = ctxProto[k];
	ctxProto[k] = function (...a) {
		if (watch.armed && !watch.drawAt && watch.targets.has(this.canvas)) {
			watch.drawAt = performance.now(); watch.method = k; watch.canvas = watch.targets.get(this.canvas);
			requestAnimationFrame(() => { watch.frameAt = performance.now(); });
		}
		return orig.apply(this, a);
	};
}
// ---- the plant: a slow backing allocation, 12 ms per non-zero width write, from the first timed repeat --------------
const plant = { on: false, hits: 0 };
{
	const d = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "width");
	Object.defineProperty(HTMLCanvasElement.prototype, "width", { configurable: true, enumerable: d.enumerable, get: d.get,
		set(v) { if (plant.on && v > 0) { plant.hits++; const t = performance.now(); while (performance.now() - t < 12) {} } d.set.call(this, v); } });
}

const ids = new Map(), sidecars = new Map();
const save = (id, page) => { sidecars.set(id, serializePage(page)); };
inlineInk.attachHost({ readPageId: p => ids.get(p) ?? null, claimId: async (p, id) => { ids.set(p, id); return { pageId: id }; },
	loadSidecar: async id => (sidecars.has(id) ? parsePage(sidecars.get(id), id) : null), scheduleSidecar: save, scheduleSidecarNow: async (id, p) => save(id, p), notify: () => {} });

const frame = () => new Promise(r => requestAnimationFrame(() => r()));
const rendered = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await frame(); };
const PANE_W = 1397.5, PANE_H = 800, HOST_LEFT = 300, TEXT_LINE = 6;
let rig = null;

function installSizer(view) {
	const sizer = document.createElement("div"); sizer.className = "cm-sizer";
	const container = document.createElement("div"); container.className = "cm-contentContainer";
	view.contentDOM.parentElement.insertBefore(sizer, view.contentDOM); sizer.appendChild(container); container.appendChild(view.contentDOM);
	void view.scrollDOM.clientWidth; return sizer;
}
const lineEl = view => view.contentDOM.querySelectorAll(".cm-line")[TEXT_LINE];
const textBox = view => { const range = document.createRange(); range.selectNodeContents(lineEl(view)); const r = range.getBoundingClientRect(); return { left: r.left, cy: (r.top + r.bottom) / 2 }; };
const dims = c => c.width + "x" + c.height;
const pen = (type, px, py, buttons) => document.elementFromPoint(px, py)?.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true,
	pointerType: "pen", pointerId: 901, isPrimary: true, clientX: px, clientY: py, buttons, pressure: buttons ? 0.5 : 0 }));

window.wetAlloc = {
	async mount(tag) {
		setPenInk(true); setScrollExpansionEnabled(true); setDiagnosticsEnabled(true);
		setInlineTool("pen"); setInkColorHex("pen", "#ff00ff"); setInkSizeMult("pen", 4);
		const path = "wet-alloc-latency-" + tag + ".md";
		const pane = document.body.appendChild(document.createElement("div"));
		pane.className = "markdown-source-view mod-cm6";
		pane.style.cssText = "position:relative;margin-left:" + HOST_LEFT + "px;width:" + PANE_W + "px;height:" + PANE_H + "px;overflow:hidden";
		const FENCE = String.fromCharCode(96).repeat(3);
		const doc = [FENCE + FENCE, FENCE + "7", "", "", "", "", "line " + TEXT_LINE + " alpha beta gamma", "", "", "", ""].join("\\n");
		document.body.classList.add("handwriting-paper-lines");
		const view = new EditorView({ parent: pane, state: EditorState.create({ doc, extensions: [history(), EditorView.lineWrapping,
			editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} })), inkOverlayExtension(),
			EditorView.theme({ "&": { width: PANE_W + "px", height: PANE_H + "px" }, ".cm-scroller": { overflowY: "auto", overflowX: "hidden" } })] }) });
		installSizer(view);
		await settle(12);
		const overlay = overlayForPath(path);
		if (!overlay) throw new Error("no overlay for " + path);
		rig = { pane, view, overlay, path };
		watch.targets = new Map([[overlay.wetCanvas, "wet"], [overlay.wetTileCanvas, "wetTile"]]);
		const t = textBox(view);
		for (let s = 0; s < 2; s++) {
			const x = t.left + 80 + 200 * s, y = t.cy;
			pen("pointerdown", x, y, 1); for (let i = 1; i <= 6; i++) { pen("pointermove", x + 25 * i, y + 4 * Math.sin(i), 1); await frame(); } pen("pointerup", x + 150, y, 0);
			await settle(6);
		}
		await settle(8);
		return { strokes: inlineInk.strokes(path).length, wet: dims(overlay.wetCanvas), committed: dims(overlay.committedCanvas), releaseOff: overlay.wetReleaseOff };
	},
	/** One repeat: a top fling to the spring's end, then a pen stroke timed from its pointerdown to the first wet frame. */
	async repeat(i, plantOn) {
		const { view, overlay, path } = rig, router = overlay.router, sd = view.scrollDOM;
		setPenInk(false);
		sd.scrollTop = 0; sd.scrollLeft = 0;
		await settle(4);
		// The assist guard re-arms a second after the last lift, on a real timer (OverscrollBounce.test.ts, giveRegrab).
		await new Promise(res => setTimeout(res, 1200));
		await settle(4);
		const r = sd.getBoundingClientRect(), x0 = r.left + r.width / 2, y0 = r.top + r.height / 2;
		const finger = (type, py, buttons) => {
			const e = { type, pointerType: "touch", pointerId: 951, isPrimary: true, clientX: x0, clientY: py, pressure: buttons === 0 ? 0 : 0.5,
				buttons, button: 0, timeStamp: performance.now(), tiltX: 0, tiltY: 0, width: 0, height: 0, target: sd, preventDefault() {}, stopPropagation() {} };
			if (type === "pointerdown") router.pointerDown(e); else if (type === "pointermove") router.pointerMove(e); else router.pointerUpOrCancel(e);
		};
		const wetBefore = dims(overlay.wetCanvas);
		finger("pointerdown", y0, 1);
		for (let k = 1; k <= 16; k++) { await new Promise(res => setTimeout(res, 16)); finger("pointermove", y0 + 30 * k, 1); }
		const held = { pull: router.overscrollPullY, engaged: !!router.assistEngaged };
		finger("pointerup", y0 + 480, 0);
		const springWidths = [];
		let ended = -1;
		for (let j = 0; j < 120; j++) {
			await rendered();
			const b = overlay.overscrollBounceReadout();
			if (b.active) springWidths.push(overlay.wetCanvas.width);
			if (springWidths.length > 0 && !b.active && router.flingRaf === 0) { ended = j; break; }
		}
		await settle(2);
		const wetAtRest = dims(overlay.wetCanvas);
		setPenInk(true); setInlineTool("pen");
		const t = textBox(view), x = t.left + 80 + 60 * (i % 5), y = t.cy + 3 * (i % 3);
		const strokesBefore = inlineInk.strokes(path).length, reallocsBefore = inkCanvasReallocs();
		plant.on = !!plantOn; plant.hits = 0;
		watch.drawAt = watch.frameAt = 0; watch.method = watch.canvas = "";
		// A pen-down lands anywhere in a frame on the device. Right after a frame callback, a cost under a frame hides
		// inside it; so repeat i lands 1.6 * i ms into its frame (0 to 14.4 ms over ten), the same phases in both arms.
		const frameAt = await new Promise(r => requestAnimationFrame(() => r(performance.now())));
		const phase = Math.max(0, i) * 1.6;
		while (performance.now() - frameAt < phase) await new Promise(r => setTimeout(r, 0));
		watch.armed = true;
		const t0 = performance.now();
		pen("pointerdown", x, y, 1);
		const t1 = performance.now();
		const wetAfterDown = dims(overlay.wetCanvas);
		for (let k = 1; k <= 3; k++) pen("pointermove", x + 20 * k, y + 2 * k, 1);
		for (let f = 0; f < 30 && !watch.frameAt; f++) await frame();
		watch.armed = false;
		plant.on = false;
		await frame(); await frame();
		// The lift, timed the same way: its synchronous cost, and its dispatch to the next frame. Printed, not claimed.
		const u0 = performance.now();
		pen("pointerup", x + 80, y + 6, 0);
		const u1 = performance.now();
		const upFrame = await new Promise(r => requestAnimationFrame(() => r(performance.now())));
		await settle(6);
		return {
			i, wetBefore, held, springFrames: springWidths.length, springWidths, ended, wetAtRest, wetAfterDown, phaseMs: t0 - frameAt,
			downMs: t1 - t0, firstWetFrameMs: watch.frameAt ? watch.frameAt - t0 : null, firstDrawMs: watch.drawAt ? watch.drawAt - t0 : null,
			upMs: u1 - u0, upFrameMs: upFrame - u0,
			drawMethod: watch.method, drawCanvas: watch.canvas, plantHits: plant.hits, reallocs: inkCanvasReallocs() - reallocsBefore,
			stored: inlineInk.strokes(path).length - strokesBefore, wetAfter: dims(overlay.wetCanvas),
		};
	},
};
`;

const PLANT_SLOW = !!process.env.HW_WET_ALLOC_PLANT;
const PLANT_NO_RELEASE = !!process.env.HW_WET_ALLOC_PLANT_NO_RELEASE;
const NO_RELEASE = { from: "\tprivate releaseWetIfIdle(): void {\n", to: "\tprivate releaseWetIfIdle(): void {\n\t\treturn;\n" };
/** The lag rig's flags: a GPU canvas, the kind the device draws with. */
const GPU_ARGS = process.platform === "win32" ? ["--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--use-angle=d3d11"] : [];
const REPEATS = 10;

let browser: Browser, script: string, planted = 0;
const record: Record<string, unknown> = {};

beforeAll(async () => {
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "wetAllocLatencyPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
		plugins: PLANT_NO_RELEASE ? [{ name: "wet-alloc-plant-no-release", setup(pluginBuild) {
			pluginBuild.onLoad({ filter: /src[\\/]inline[\\/]InkOverlay\.ts$/ }, args => {
				const text = readFileSync(args.path, "utf8").replace(/\r\n/g, "\n");
				const found = text.split(NO_RELEASE.from).length - 1;
				if (found !== 1) throw new Error(`plant no-release: anchor found ${found} times`);
				planted++;
				return { loader: "ts", contents: text.replace(NO_RELEASE.from, NO_RELEASE.to) };
			});
		} }] : [] });
	if (PLANT_NO_RELEASE && planted !== 1) throw new Error(`plant no-release: applied ${planted} times`);
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true, args: GPU_ARGS });
}, 180_000);
afterAll(async () => {
	await browser?.close();
	if (process.env.HW_WET_ALLOC_OUT) writeFileSync(process.env.HW_WET_ALLOC_OUT, JSON.stringify(record, null, 1));
});

const call = (p: Page, method: string, ...args: unknown[]) => p.evaluate(([m, a]) => (window as any).wetAlloc[m](...a), [method, args] as const);

type Repeat = { i: number; wetBefore: string; held: { pull: number; engaged: boolean }; springFrames: number; springWidths: number[]; ended: number;
	wetAtRest: string; wetAfterDown: string; phaseMs: number; downMs: number; upMs: number; upFrameMs: number; firstWetFrameMs: number | null; firstDrawMs: number | null; drawMethod: string;
	drawCanvas: string; plantHits: number; reallocs: number; stored: number; wetAfter: string };

/** One arm: a page, the mount, one traced untimed repeat (the provider name), then the timed repeats. */
async function arm(tag: string, releaseOff: boolean) {
	const page = await browser.newPage({ viewport: { width: 1800, height: 900 }, deviceScaleFactor: 2, hasTouch: true });
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	try {
		await page.setContent('<!doctype html><body class="theme-dark" style="margin:0; --font-text-size:19px; --background-modifier-border:#777777"></body>');
		await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
		await page.addStyleTag({ content: MINIMAL_CSS });
		if (releaseOff) await page.evaluate(() => { (window as any).HW_ARM_W_OFF = true; });
		await page.addScriptTag({ content: script });
		const mounted = await call(page, "mount", tag) as any;
		// The categories of the plugin's own ink trace, which named Orion's provider (CanvasResourceProviderSharedImage).
		await browser.startTracing(page, { categories: INK_TRACE_CATEGORIES });
		const warm = await call(page, "repeat", -1, false) as Repeat;
		const buf = (await browser.stopTracing()).toString("utf8");
		const providers = [...new Set(buf.match(/Canvas2D\w*Provider\w*|CanvasResourceProvider\w*/g) ?? [])];
		const canvasEvents = [...new Set(buf.match(/"name":"[^"]*Canvas[^"]*"/g) ?? [])].slice(0, 20);
		const repeats: Repeat[] = [];
		for (let i = 0; i < REPEATS; i++) repeats.push(await call(page, "repeat", i, PLANT_SLOW) as Repeat);
		return { mounted, warm, providers, canvasEvents, repeats, errors };
	} finally { await page.close(); }
}

const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const fmt = (v: number[]) => v.map(x => x.toFixed(1)).join(" ");

it("arm W: the wet canvas is 0x0 on every spring frame, and the first wet frame after a pen-down costs under 8 ms more at the median than with the release off", async () => {
	const control = await arm("control", true);
	const armW = await arm("arm", false);
	const lat = (a: typeof armW) => a.repeats.map(r => r.firstWetFrameMs ?? NaN);
	const drawn = (a: typeof armW) => a.repeats.map(r => r.firstDrawMs ?? NaN);
	const diffDraw = median(drawn(armW)) - median(drawn(control));
	const down = (a: typeof armW) => a.repeats.map(r => r.downMs);
	const diff = median(lat(armW)) - median(lat(control));
	const summary = {
		plant: PLANT_SLOW ? "slow-width" : PLANT_NO_RELEASE ? "no-release" : null, planted, gpuArgs: GPU_ARGS,
		providers: { control: control.providers, arm: armW.providers }, canvasEvents: armW.canvasEvents,
		phaseMs: fmt(armW.repeats.map(r => r.phaseMs)),
		mounted: { control: control.mounted, arm: armW.mounted },
		firstWetFrameMs: { control: fmt(lat(control)), arm: fmt(lat(armW)), medianControl: median(lat(control)), medianArm: median(lat(armW)), diff },
		firstDrawMs: { control: fmt(drawn(control)), arm: fmt(drawn(armW)), medianControl: median(drawn(control)), medianArm: median(drawn(armW)), diff: diffDraw },
		downMs: { control: fmt(down(control)), arm: fmt(down(armW)), medianControl: median(down(control)), medianArm: median(down(armW)) },
		upMs: { control: fmt(control.repeats.map(r => r.upMs)), arm: fmt(armW.repeats.map(r => r.upMs)) },
		upFrameMs: { control: fmt(control.repeats.map(r => r.upFrameMs)), arm: fmt(armW.repeats.map(r => r.upFrameMs)) },
		springWidths: { control: control.repeats.map(r => [...new Set(r.springWidths)].join("/")), arm: armW.repeats.map(r => [...new Set(r.springWidths)].join("/")) },
		wetAfterDown: { control: control.repeats.map(r => r.wetAfterDown), arm: armW.repeats.map(r => r.wetAfterDown) },
		reallocs: { control: control.repeats.map(r => r.reallocs), arm: armW.repeats.map(r => r.reallocs) },
		plantHits: { control: control.repeats.map(r => r.plantHits), arm: armW.repeats.map(r => r.plantHits) },
		draw: armW.repeats.map(r => `${r.drawCanvas}.${r.drawMethod}@${r.firstDrawMs?.toFixed(1)}`),
	};
	Object.assign(record, { summary, control, arm: armW });
	const brief = JSON.stringify(summary);
	console.log(`WET-ALLOC ${brief}`);
	for (const [name, a] of [["control", control], ["arm", armW]] as const) {
		expect(a.errors, `${name}: page errors`).toEqual([]);
		// PREMISES.
		expect(a.mounted.releaseOff, `premise, ${name}: the release switch read at mount`).toBe(name === "control");
		expect(a.mounted.strokes, `premise, ${name}: two strokes stored at mount`).toBe(2);
		expect(a.mounted.wet, `premise, ${name}: writing alone leaves the wet canvas sized (${brief})`).toBe(a.mounted.committed);
		for (const r of [a.warm, ...a.repeats]) {
			expect(r.held.engaged, `premise, ${name} repeat ${r.i}: the assist carried the drag`).toBe(true);
			expect(r.springFrames, `premise, ${name} repeat ${r.i}: the spring played at least ten frames`).toBeGreaterThanOrEqual(10);
			expect(r.ended, `premise, ${name} repeat ${r.i}: the spring ended`).toBeGreaterThanOrEqual(0);
			expect(r.wetAfterDown, `premise, ${name} repeat ${r.i}: the wet canvas is sized right after the pointerdown`).toBe(a.mounted.committed);
			expect(r.stored, `premise, ${name} repeat ${r.i}: the stroke is stored`).toBe(1);
			expect(r.firstWetFrameMs, `premise, ${name} repeat ${r.i}: a wet draw was seen (${brief})`).not.toBeNull();
		}
	}
	// (a) 0x0 on every spring frame with the release on; sized on every spring frame with it off.
	const armSized = armW.repeats.flatMap(r => r.springWidths.filter(w => w !== 0).map(w => `repeat ${r.i}: ${w}`));
	const controlZero = control.repeats.flatMap(r => r.springWidths.filter(w => !(w > 0)).map(w => `repeat ${r.i}: ${w}`));
	expect.soft(armSized, `(a) spring frames with a sized wet canvas, release on (${brief})`).toEqual([]);
	expect.soft(controlZero, `(a) spring frames with a 0x0 wet canvas, release off (${brief})`).toEqual([]);
	// (b) The allocation's price at the median, over ten pen-downs.
	expect.soft(diff, `(b) median pointerdown to first wet frame, release on minus release off, ms (${brief})`).toBeLessThan(8);
	// (b2) The same path to the first wet draw, without the frame: the plant's 12 ms shows here whole.
	expect.soft(diffDraw, `(b2) median pointerdown to first wet draw, release on minus release off, ms (${brief})`).toBeLessThan(8);
}, 300_000);
