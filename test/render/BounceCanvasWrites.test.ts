/**
 * WHICH OVERLAY CANVAS IS DRAWN ON, AND HOW OFTEN, WHILE THE PAGE BOUNCES OFF ITS TOP EDGE.
 *
 * What it looks like: on Orion (package-1b22f759) a fling into the top of the page gives and springs back laggy. The
 * trace shows the scroll repaints are cheap (+0.3 to +0.7 ms), but the GPU is not: Present blocks 7.7 ms at the median
 * through the first bounce (0.5 ms while writing), and six canvas resources are produced per compositor frame. A
 * scroll-only repaint draws nothing by the code read, so the trace cannot say which canvas is redrawn each frame.
 *
 * THIS CELL IS THE INSTRUMENT, NOT THE FIX. Every 2D context method of every canvas on the page is wrapped by a counter
 * keyed by the canvas element, and every write to a canvas's width or height (which clears it, even to the same size)
 * is counted the same way. The six overlay canvases (committed, wet, wetTile, tail, highlight, highlightWet) are named;
 * any other canvas, the tail renderer's scratch copy included, is listed as "other". Calls are split into DRAW (clearRect,
 * fillRect, strokeRect, fillText, strokeText, fill, stroke, drawImage, putImageData: a call that dirties the bitmap, so
 * the compositor takes a new resource) and STATE (save, restore, setTransform, beginPath, and the rest). Property sets
 * on a context (fillStyle and so on) are not counted.
 *
 * The counts are read per frame, from the first finger move to four frames after the spring ends: the drag (sixteen
 * moves 16 ms apart), the spring, and the tail. The result is a table per canvas per frame.
 *
 * THE CLAIM: no overlay canvas is drawn on or resized from the first scroll event to the end of the bounce, with one
 * admitted write (arm W): the wet canvas's release to 0x0, its width and height on one row, once,
 * at or before the first spring frame. Green at 1b22f759 meant the rig does not reproduce the six per frame and the
 * producer is device only. Red names the canvas and the method.
 *
 * THE WET-ZERO CELL (LazyHighlightPair.test.ts cell 7, read in the rig for the wet canvas): no context call reaches the wet canvas
 * while it is 0x0, through the mount, ten strokes, a top fling, a band shift, the rest repaint that bakes a settled pan,
 * a file switch and an abandoned-stroke teardown. HW_TOP_SPY_PLANT_UNGUARD=1 removes WetInkRenderer.clear's 0x0 guard
 * as the bundle is built (the anchor must match once); the cell must then go red.
 *
 * THE CONTROL (always runs): a planted clearRect on one named canvas on every spring frame must be reported against
 * that canvas, on every frame, and on no other. Without it a green claim could mean the spy is blind.
 * HW_TOP_SPY_PLANT=<committed|wet|wetTile|tail|highlight|highlightWet> plants the same draw into the claim cell, which
 * must then go red naming that canvas.
 *
 * Arms: "device", vault test 2's Untitled 1 in Minimal 9.0.2 at base font 19 with the host offsets of the Orion trace
 * (Infinite Canvas on, device pixel ratio 2, fling); "alan", the same without the host offsets; "rig",
 * OverscrollBounce.test.ts's page (400 lines of monospace 16/24). The page, the drive and the premises are
 * BounceRepaint.test.ts's, so the two cells read the same gesture.
 *
 * Run: npx vitest run --config vitest.render.mts test/render/BounceCanvasWrites.test.ts
 * HW_TOP_SPY_OUT=<file> writes the per-frame tables as JSON.
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

declare const process: { env: Record<string, string | undefined> };

/** Minimal 9.0.2's theme.css, verbatim (the fixture MinimalCameraScale.test.ts loads): vault test 2's theme. */
const MINIMAL_CSS = readFileSync(fileURLToPath(new URL("./fixtures/minimal-9.0.2-theme.css", import.meta.url)), "utf8");

const PAGE = `
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { inlineInk, inkOverlayExtension, overlayForPath, setScrollExpansionEnabled, setInlineTool, setInkSizeMult } from "../../src/inline/InkOverlay";
import { setInkColorHex } from "../../src/ink/InkColor";
import { setPenInk } from "../../src/inline/PenInk";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField } from "./iphoneObsidianStub";
import { parsePage, serializePage } from "../../src/model/PageData";

installObsidianDom();

// ---- the spy: installed before anything mounts, so no canvas can be created outside it ----------------------------
const DRAW = new Set(["clearRect", "fillRect", "strokeRect", "fillText", "strokeText", "fill", "stroke", "drawImage", "putImageData"]);
const READ = new Set(["constructor", "getImageData", "getContextAttributes", "getLineDash", "getTransform", "isContextLost",
	"isPointInPath", "isPointInStroke", "measureText", "createLinearGradient", "createRadialGradient", "createConicGradient",
	"createPattern", "createImageData"]);
const spy = { on: false, seen: new Map() };
// The zero-size watch (the arm W contract): every context call made on a canvas while its backing is 0x0, with the
// canvas and the phase it came in; the cell keeps the wet canvas's.
const zeroWatch = { on: false, phase: "", calls: [] };
function note(canvas, method, kind) {
	if (zeroWatch.on && kind !== "size" && (canvas.width === 0 || canvas.height === 0)) zeroWatch.calls.push({ canvas, phase: zeroWatch.phase, method });
	if (!spy.on) return;
	let e = spy.seen.get(canvas);
	if (!e) { e = { canvas, draw: 0, state: 0, size: 0, methods: {} }; spy.seen.set(canvas, e); }
	e[kind]++;
	e.methods[method] = (e.methods[method] || 0) + 1;
}
const ctxProto = CanvasRenderingContext2D.prototype;
for (const k of Object.getOwnPropertyNames(ctxProto)) {
	const d = Object.getOwnPropertyDescriptor(ctxProto, k);
	if (!d || typeof d.value !== "function" || READ.has(k)) continue;
	const orig = d.value, kind = DRAW.has(k) ? "draw" : "state";
	ctxProto[k] = function (...a) { note(this.canvas, k, kind); return orig.apply(this, a); };
}
for (const dim of ["width", "height"]) {
	const d = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, dim);
	Object.defineProperty(HTMLCanvasElement.prototype, dim, { configurable: true, enumerable: d.enumerable, get: d.get,
		set(v) { if (spy.on) note(this, "size:" + dim + (v === d.get.call(this) ? "(same)" : ""), "size"); d.set.call(this, v); } });
}

// ---- the style spy: which canvas, or the element holding one, had its style or size attributes rewritten ------------
// A compositor resource can be produced for a canvas nobody drew on, when the layer is re-committed; a rewritten style is
// the other thing that does that. Counted per frame by property name, from the attribute mutation records.
const styleWrites = {};
const cssProps = v => { const o = {}; for (const part of String(v || "").split(";")) { const i = part.indexOf(":"); if (i > 0) o[part.slice(0, i).trim()] = part.slice(i + 1).trim(); } return o; };
const mo = new MutationObserver(list => {
	if (!spy.on) return;
	for (const m of list) {
		const t = m.target;
		if (!(t instanceof Element)) continue;
		const isCanvas = t instanceof HTMLCanvasElement;
		if (!isCanvas && !t.querySelector("canvas")) continue;
		const name = isCanvas ? nameOf(t) : "holder:" + (t.className || t.tagName);
		const o = styleWrites[name] || (styleWrites[name] = {});
		if (m.attributeName === "style") {
			const a = cssProps(m.oldValue), b = cssProps(t.getAttribute("style"));
			for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[k] !== b[k]) o[k] = (o[k] || 0) + 1;
		} else o["@" + m.attributeName] = (o["@" + m.attributeName] || 0) + 1;
	}
});
mo.observe(document, { subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ["style", "class", "width", "height", "hidden"] });
const mark = n => { try { performance.mark(n); } catch {} };

const ids = new Map(), sidecars = new Map();
const save = (id, page) => { sidecars.set(id, serializePage(page)); };
inlineInk.attachHost({ readPageId: p => ids.get(p) ?? null, claimId: async (p, id) => { ids.set(p, id); return { pageId: id }; },
	loadSidecar: async id => (sidecars.has(id) ? parsePage(sidecars.get(id), id) : null), scheduleSidecar: save, scheduleSidecarNow: async (id, p) => save(id, p), notify: () => {} });

const frame = () => new Promise(r => requestAnimationFrame(() => r()));
const rendered = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await frame(); };
const PANE_W = 1397.5, PANE_H = 800, HOST_LEFT = 300, TEXT_LINE = 6;
const NAMED = ["committed", "wet", "wetTile", "tail", "highlight", "highlightWet"];
let rig = null;

function installSizer(view) {
	const sizer = document.createElement("div"); sizer.className = "cm-sizer";
	const container = document.createElement("div"); container.className = "cm-contentContainer";
	view.contentDOM.parentElement.insertBefore(sizer, view.contentDOM); sizer.appendChild(container); container.appendChild(view.contentDOM);
	void view.scrollDOM.clientWidth; return sizer;
}
const lineEl = view => view.contentDOM.querySelectorAll(".cm-line")[TEXT_LINE];
const textBox = view => { const range = document.createRange(); range.selectNodeContents(lineEl(view)); const r = range.getBoundingClientRect(); return { left: r.left, cy: (r.top + r.bottom) / 2 }; };

/** The overlay field a canvas is held in, else "other:" with its class and its parent's, else "other:detached". */
function nameOf(c) {
	const o = rig && rig.overlay;
	if (o) for (const n of NAMED) if (o[n + "Canvas"] === c) return n;
	return "other:" + (c.className || "(no class)") + (c.isConnected ? "@" + (c.parentElement && c.parentElement.className || "body") : " detached");
}
/** Cumulative counts per canvas name; canvases sharing a name (several "other") are summed. */
function snapshot() {
	const out = {};
	for (const e of spy.seen.values()) {
		const n = nameOf(e.canvas), o = out[n] || (out[n] = { draw: 0, state: 0, size: 0, methods: {}, backing: null });
		o.draw += e.draw; o.state += e.state; o.size += e.size;
		for (const m in e.methods) o.methods[m] = (o.methods[m] || 0) + e.methods[m];
		o.backing = e.canvas.width + "x" + e.canvas.height;
	}
	return out;
}
/** Per canvas name: what was added between two snapshots, nonzero names only. */
function delta(prev, cur) {
	const out = {};
	for (const n in cur) {
		const a = prev[n] || { draw: 0, state: 0, size: 0, methods: {} }, b = cur[n];
		if (b.draw === a.draw && b.state === a.state && b.size === a.size) continue;
		const methods = {};
		for (const m in b.methods) { const d = b.methods[m] - (a.methods[m] || 0); if (d) methods[m] = d; }
		out[n] = { draw: b.draw - a.draw, state: b.state - a.state, size: b.size - a.size, methods, backing: b.backing };
	}
	return out;
}
const backings = () => { const o = {}; for (const n of NAMED) { const c = rig.overlay[n + "Canvas"]; o[n] = c ? c.width + "x" + c.height + (c.isConnected ? "" : " detached") : "none"; } return o; };

window.topSpy = {
	async mount(tag, arm) {
		setPenInk(true); setScrollExpansionEnabled(true);
		setInlineTool("pen"); setInkColorHex("pen", "#ff00ff"); setInkSizeMult("pen", 4);
		const path = "bounce-canvas-writes-" + tag + ".md";
		const pane = document.body.appendChild(document.createElement("div"));
		pane.className = "markdown-source-view mod-cm6";
		const hostLeft = arm === "device" ? HOST_LEFT + 1 / 3 : HOST_LEFT, hostTop = arm === "device" ? 77.5 : 0;
		pane.style.cssText = "position:relative;margin-left:" + hostLeft + "px;margin-top:" + hostTop + "px;width:" + PANE_W + "px;height:" + PANE_H + "px;overflow:hidden";
		const FENCE = String.fromCharCode(96).repeat(3);
		const alan = arm === "alan" || arm === "device";
		const doc = alan
			? [FENCE + FENCE, FENCE + "7", "", "", "", "", "line " + TEXT_LINE + " alpha beta gamma", "", "", "", ""].join("\\n")
			: Array.from({ length: 400 }, (_, i) => "line " + i + " alpha beta gamma delta epsilon zeta").join("\\n");
		if (alan) document.body.classList.add("handwriting-paper-lines");
		const content = alan ? {} : { fontFamily: "monospace", fontSize: "16px", lineHeight: "24px" };
		// One info object for the life of the view, so the wet-zero cell can switch the note's file by its path.
		const info = { app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} };
		const view = new EditorView({ parent: pane, state: EditorState.create({ doc, extensions: [history(), EditorView.lineWrapping,
			editorInfoField.init(() => info), inkOverlayExtension(),
			EditorView.theme({ "&": { width: PANE_W + "px", height: PANE_H + "px" }, ".cm-scroller": { overflowY: "auto", overflowX: "hidden" }, ".cm-content": content })] }) });
		installSizer(view);
		await settle(12);
		const overlay = overlayForPath(path);
		if (!overlay) throw new Error("no overlay for " + path);
		rig = { pane, view, overlay, info, path };
		const t = textBox(view), x = t.left + 80, y = t.cy;
		const pen = (type, px, py, buttons) => document.elementFromPoint(px, py)?.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "pen", pointerId: 901, isPrimary: true, clientX: px, clientY: py, buttons, pressure: buttons ? 0.5 : 0 }));
		pen("pointerdown", x, y, 1); for (let i = 1; i <= 6; i++) pen("pointermove", x + 30 * i, y, 1); pen("pointerup", x + 180, y, 0);
		await settle(12);
		return { strokes: inlineInk.strokes(path).length, backings: backings() };
	},
	/**
	 * One finger at the top edge of the page: down, sixteen 30 px moves 16 ms apart, lift at speed, then every frame
	 * until the spring ends plus four. The counts are read after the down, after each move, and after each frame.
	 * plant: a canvas name, or null. With it, each spring frame clears one pixel of that canvas, as a stand-in for a
	 * real per-frame writer, so the table must put that canvas's count on every spring frame.
	 */
	async topFling(plant, zero) {
		const { view, overlay } = rig, router = overlay.router, sd = view.scrollDOM;
		setPenInk(false);
		// zero: canvas names emptied to 0x0 before the drive, to read how the compositor's per-frame resource count follows the
		// number of non-empty canvases. A probe, not a claim: the overlay's own canvases are changed by the cell.
		for (const n of zero || []) { const c = overlay[n + "Canvas"]; if (c) { c.width = 0; c.height = 0; } }
		sd.scrollTop = 0; sd.scrollLeft = 0;
		await settle(8);
		// The assist guard re-arms a second after the last lift, on a real timer (OverscrollBounce.test.ts, giveRegrab).
		mark("spy:idle-begin");
		await new Promise(res => setTimeout(res, 1200));
		await settle(4);
		mark("spy:idle-end");
		const r = sd.getBoundingClientRect(), x0 = r.left + r.width / 2, y0 = r.top + r.height / 2;
		const finger = (type, py, buttons) => {
			const e = { type, pointerType: "touch", pointerId: 951, isPrimary: true, clientX: x0, clientY: py,
				pressure: buttons === 0 ? 0 : 0.5, buttons, button: 0, timeStamp: performance.now(), tiltX: 0, tiltY: 0,
				width: 0, height: 0, target: sd, preventDefault() {}, stopPropagation() {} };
			if (type === "pointerdown") router.pointerDown(e); else if (type === "pointermove") router.pointerMove(e); else router.pointerUpOrCancel(e);
		};
		const plantDraw = () => { if (!plant) return; const c = overlay[plant + "Canvas"]; const ctx = c && c.getContext("2d"); if (ctx) ctx.clearRect(0, 0, 1, 1); };
		const rows = [];
		let prev = {};
		const take = (phase, i) => {
			const cur = snapshot(), styles = {};
			for (const n in styleWrites) { styles[n] = styleWrites[n]; delete styleWrites[n]; }
			rows.push({ phase, i, canvases: delta(prev, cur), styles }); prev = cur;
		};
		const read = () => { const b = overlay.overscrollBounceReadout(); return { active: b.active, total: b.restY + b.y, fling: router.flingRaf !== 0 }; };
		const backingsBefore = backings();
		spy.seen.clear(); spy.on = true;
		mark("spy:down");
		finger("pointerdown", y0, 1);
		take("down", 0);
		for (let i = 1; i <= 16; i++) { await new Promise(res => setTimeout(res, 16)); finger("pointermove", y0 + 30 * i, 1); take("drag", i); }
		const held = { pull: router.overscrollPullY, engaged: !!router.assistEngaged };
		mark("spy:lift");
		finger("pointerup", y0 + 480, 0);
		take("lift", 0);
		let springFrames = 0, ended = -1;
		for (let j = 0; j < 120; j++) {
			await rendered();
			const f = read();
			if (f.active) { springFrames++; plantDraw(); }
			take(f.active ? "spring" : "after", j);
			if (springFrames > 0 && !f.active && !f.fling) { ended = j; break; }
		}
		mark("spy:spring-end");
		for (let i = 0; i < 4; i++) { await rendered(); take("tail", i); }
		mark("spy:tail-end");
		spy.on = false;
		await settle(4);
		return { held, springFrames, ended, rest: read(), backingsBefore, backingsAfter: backings(), rows };
	},
	/** Start the zero-size watch before the mount, so the mount is watched too. */
	watchZero() { zeroWatch.on = true; zeroWatch.phase = "mount"; zeroWatch.calls.length = 0; },
	/**
	 * The arm W contract: no context call reaches the wet canvas while it is 0x0. The phases after the mount: ten pen
	 * strokes, a top fling and its spring (which releases the wet canvas), a scroll into the band's margin (the band
	 * moves), the rest repaint that bakes a settled pan, a file switch, and an abandoned-stroke teardown with no stroke
	 * live. Each phase records the wet canvas's backing at its start and end, so a phase that never saw it 0x0 shows.
	 */
	async wetZero() {
		const { view, overlay } = rig, sd = view.scrollDOM, wet = overlay.wetCanvas, dims = c => c.width + "x" + c.height;
		const phases = [], premises = {};
		const begin = name => { zeroWatch.phase = name; phases.push({ name, wetAtStart: dims(wet) }); };
		const end = () => { phases[phases.length - 1].wetAtEnd = dims(wet); };
		begin("strokes");
		setPenInk(true); setInlineTool("pen");
		const r0 = sd.getBoundingClientRect();
		const pen = (type, px, py, buttons) => document.elementFromPoint(px, py)?.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true,
			pointerType: "pen", pointerId: 901, isPrimary: true, clientX: px, clientY: py, buttons, pressure: buttons ? 0.5 : 0 }));
		for (let s = 0; s < 10; s++) {
			const x = r0.left + 200 + (s % 5) * 60, y = r0.top + 120 + s * 40;
			pen("pointerdown", x, y, 1); await frame();
			for (let i = 1; i <= 8; i++) { pen("pointermove", x + 25 * i, y + 6 * Math.sin(i / 2), 1); await frame(); }
			pen("pointerup", x + 200, y, 0); await frame();
		}
		await settle(8);
		end();
		begin("fling");
		const fl = await this.topFling(null);
		premises.fling = { springFrames: fl.springFrames, ended: fl.ended };
		end();
		begin("band shift");
		premises.bandBefore = overlay.band ? { left: overlay.band.left, top: overlay.band.top } : null;
		sd.scrollTop = sd.scrollTop + 3000;
		await settle(12);
		premises.bandAfter = overlay.band ? { left: overlay.band.left, top: overlay.band.top } : null;
		end();
		begin("rest repaint");
		// A settled pan the raster does not hold yet: repaint() bakes it (the rasterPanNeedsBake branch clears the wet layer).
		overlay.viewportPan = { x: -40, y: 0 };
		premises.needsBake = overlay.rasterPanNeedsBake();
		overlay.repaint();
		premises.baked = overlay.rasterPan ? { x: overlay.rasterPan.x, y: overlay.rasterPan.y } : null;
		overlay.viewportPan = { x: 0, y: 0 };
		overlay.repaint();
		await settle(4);
		end();
		begin("file switch");
		const next = rig.path.replace(/\\.md$/, "-switched.md");
		// A new file object: the same object with a new path is Obsidian's rename, which keeps the note (renamedFrom).
		const file = { path: next };
		rig.info.file = file;
		view.dispatch({});
		await settle(12);
		premises.switchedTo = overlay.lastPath === next && overlay.lastFile === file;
		premises.sameWetCanvas = overlay.wetCanvas === wet;
		end();
		begin("abandoned");
		premises.noStrokeLive = overlay.builder === null;
		overlay.strokeAbandoned();
		await settle(4);
		end();
		zeroWatch.on = false;
		return { phases, premises, strokes: inlineInk.strokes(rig.path).length,
			calls: zeroWatch.calls.filter(c => c.canvas === wet).map(c => c.phase + ":" + c.method) };
	},
};
`;

let browser: Browser, script: string, unguarded = 0;
const record: unknown[] = [];
/** The plant for the wet-zero cell: WetInkRenderer.clear without its 0x0 guard. */
const UNGUARD = !!process.env.HW_TOP_SPY_PLANT_UNGUARD;
const UNGUARD_FROM = "\t\tif (!this.zeroSized()) {\n\t\t\tthis.ctx.clearRect(0, 0, cssWidth, cssHeight);\n";
const UNGUARD_TO = "\t\tif (true) {\n\t\t\tthis.ctx.clearRect(0, 0, cssWidth, cssHeight);\n";

beforeAll(async () => {
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "bounceCanvasWritesPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
		plugins: UNGUARD ? [{ name: "top-spy-plant-unguard", setup(pluginBuild) {
			pluginBuild.onLoad({ filter: /src[\\/]ink[\\/]WetInkRenderer\.ts$/ }, args => {
				const text = readFileSync(args.path, "utf8").replace(/\r\n/g, "\n");
				const found = text.split(UNGUARD_FROM).length - 1;
				if (found !== 1) throw new Error(`plant unguard: anchor found ${found} times`);
				unguarded++;
				return { loader: "ts", contents: text.replace(UNGUARD_FROM, UNGUARD_TO) };
			});
		} }] : [] });
	if (UNGUARD && unguarded !== 1) throw new Error(`plant unguard: applied ${unguarded} times`);
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);
afterAll(async () => {
	await browser?.close();
	if (process.env.HW_TOP_SPY_OUT) writeFileSync(process.env.HW_TOP_SPY_OUT, JSON.stringify(record, null, 1));
});

const call = (p: Page, method: string, ...args: unknown[]) => p.evaluate(([m, a]) => (window as any).topSpy[m](...a), [method, args] as const);
async function open(tag: string, arm: string, watchZero = false) {
	const page = await browser.newPage({ viewport: { width: 1800, height: 900 }, deviceScaleFactor: 2, hasTouch: true });
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	await page.setContent(arm !== "rig"
		? '<!doctype html><body class="theme-dark" style="margin:0; --font-text-size:19px; --background-modifier-border:#777777"></body>'
		: '<!doctype html><body style="margin:0"></body>');
	await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
	if (arm !== "rig") await page.addStyleTag({ content: MINIMAL_CSS });
	await page.addScriptTag({ content: script });
	if (watchZero) await call(page, "watchZero");
	const mounted = await call(page, "mount", tag, arm) as any;
	return { page, errors, mounted };
}

type Counts = { draw: number; state: number; size: number; methods: Record<string, number>; backing?: string };
type Row = { phase: string; i: number; canvases: Record<string, Counts>; styles?: Record<string, Record<string, number>> };

/** Per canvas: draw calls, size writes and state calls over the rows of the given phases, and on how many rows it drew. */
function tally(rows: Row[], phases: string[]) {
	const out: Record<string, { draw: number; size: number; state: number; framesDrawn: number; maxPerFrame: number; methods: Record<string, number> }> = {};
	for (const row of rows) {
		if (!phases.includes(row.phase)) continue;
		for (const [name, c] of Object.entries(row.canvases)) {
			const o = out[name] ??= { draw: 0, size: 0, state: 0, framesDrawn: 0, maxPerFrame: 0, methods: {} };
			o.draw += c.draw; o.size += c.size; o.state += c.state;
			if (c.draw + c.size > 0) o.framesDrawn++;
			o.maxPerFrame = Math.max(o.maxPerFrame, c.draw + c.size);
			for (const [m, n] of Object.entries(c.methods)) o.methods[m] = (o.methods[m] ?? 0) + n;
		}
	}
	return out;
}
/** Style and size attribute rewrites per canvas or canvas holder, per property, per phase: how many frames and how many writes. */
function styleTally(rows: Row[]) {
	const out: Record<string, Record<string, Record<string, { writes: number; frames: number }>>> = {};
	for (const row of rows) for (const [name, props] of Object.entries(row.styles ?? {})) for (const [prop, n] of Object.entries(props)) {
		const o = ((out[row.phase] ??= {})[name] ??= {})[prop] ??= { writes: 0, frames: 0 };
		o.writes += n; o.frames++;
	}
	return out;
}
/** The per-frame table, one line per row that touched a canvas, for the failure message and the brief. */
function table(rows: Row[]) {
	return rows.filter(r => Object.keys(r.canvases).length).map(r => r.phase + " " + r.i + ": " +
		Object.entries(r.canvases).map(([n, c]) => n + " d" + c.draw + " z" + c.size + " s" + c.state + " {" +
			Object.entries(c.methods).map(([m, k]) => m + "x" + k).join(",") + "}").join("; ")).join("\n");
}
const WINDOW = ["down", "drag", "lift", "spring", "after"];

const PLANT = process.env.HW_TOP_SPY_PLANT || null;
/** HW_TOP_SPY_ZERO=wet,tail: a probe that empties those canvases to 0x0 first; with HW_TOP_SPY_TRACE it prints the resource count per frame. */
const ZERO = process.env.HW_TOP_SPY_ZERO ? process.env.HW_TOP_SPY_ZERO.split(",") : [];
for (const arm of ["device", "alan", "rig"] as const) {
	it(`${arm}: TOP: no overlay canvas is drawn on or resized from the first scroll event to the end of the bounce`, async () => {
		const { page, errors, mounted } = await open("claim-" + arm, arm);
		try {
			// HW_TOP_SPY_TRACE=<dir>: a Chromium trace around the same drive, for the compositor's own resource events, which
			// the spy cannot see (a canvas can produce a resource without a context call). Off by default; the gate does not pay.
			const traceDir = process.env.HW_TOP_SPY_TRACE;
			if (traceDir) await browser.startTracing(page, { categories: ["blink", "blink.user_timing", "cc", "gpu", "viz", "disabled-by-default-devtools.timeline"] });
			const r = await call(page, "topFling", PLANT, ZERO) as any;
			let traced: Record<string, number> | null = null;
			if (traceDir) {
				const buf = await browser.stopTracing();
				writeFileSync(`${traceDir}/trace-${arm}.json`, buf);
				traced = {};
				for (const ev of (JSON.parse(buf.toString("utf8")).traceEvents ?? []) as { name?: string; ph?: string }[])
					if (/Canvas|Produce|Present|DrawFrame/i.test(ev.name ?? "") && ev.ph !== "E") traced[ev.name!] = (traced[ev.name!] ?? 0) + 1;
			}
			const inWindow = tally(r.rows, WINDOW), all = tally(r.rows, [...WINDOW, "tail"]);
			record.push({ cell: "claim", arm, plant: PLANT, zero: ZERO, mounted, held: r.held, springFrames: r.springFrames, ended: r.ended,
				backingsBefore: r.backingsBefore, backingsAfter: r.backingsAfter, inWindow, withTail: all, traced, styleWrites: styleTally(r.rows), rows: r.rows });
			const brief = `\nper canvas, first move to spring end: ${JSON.stringify(inWindow)}\nper frame:\n${table(r.rows)}\nbackings before ${JSON.stringify(r.backingsBefore)} after ${JSON.stringify(r.backingsAfter)}`;
			expect(errors).toEqual([]);
			// PREMISES: one stroke on the page; the drag pulled against the top edge; a spring played and ended; the page came home.
			expect(mounted.strokes, "premise: one stroke").toBe(1);
			expect(r.held.engaged, "premise: the assist carried the drag").toBe(true);
			expect(Math.abs(r.held.pull), "premise: the drag pulled against the edge").toBeGreaterThan(10);
			expect(r.springFrames, `premise: the spring played at least ten frames${brief}`).toBeGreaterThanOrEqual(10);
			expect(r.ended, "premise: the spring ended").toBeGreaterThanOrEqual(0);
			expect(Math.abs(r.rest.total), "premise: the page came home").toBeLessThanOrEqual(0.5);
			// THE ADMITTED WRITE (arm W): the wet canvas's release to 0x0, width and height on one row,
			// once, at or before the first spring frame, and it stays 0x0. The ZERO probe empties the wet canvas first: no release.
			const inWindowRows = (r.rows as Row[]).filter(row => WINDOW.includes(row.phase));
			const releaseRows = inWindowRows.map((row, k) => ({ row, k })).filter(({ row }) => (row.canvases.wet?.size ?? 0) > 0);
			const firstSpring = inWindowRows.findIndex(row => row.phase === "spring");
			const released = !ZERO.includes("wet");
			expect(releaseRows.map(({ row }) => `${row.phase} ${row.i}: ${JSON.stringify(row.canvases.wet!.methods)}`), `the wet canvas's size writes in the window${brief}`)
				.toEqual(released ? [`${releaseRows[0]?.row.phase} ${releaseRows[0]?.row.i}: {"size:width":1,"size:height":1}`] : []);
			if (released) {
				expect(releaseRows[0]!.k, `the release comes at or before the first spring frame (row ${firstSpring})${brief}`).toBeLessThanOrEqual(firstSpring);
				expect(r.backingsAfter.wet, `the wet canvas is still 0x0 after the bounce${brief}`).toBe("0x0");
			}
			// THE CLAIM: nothing else dirties a canvas bitmap in the window (a draw call, or a write to width or height).
			const dirty = Object.entries(inWindow).filter(([n, c]) => c.draw + (n === "wet" && released ? c.size - 2 : c.size) > 0)
				.map(([n, c]) => `${n}: ${c.draw} draws, ${c.size} size writes on ${c.framesDrawn} rows, at most ${c.maxPerFrame} on one row, ${JSON.stringify(c.methods)}`);
			expect(dirty, `canvases dirtied from the first scroll event to the spring's end${brief}`).toEqual([]);
		} finally { await page.close(); }
	}, 240_000);
}

/**
 * THE CONTROL: the spy must see a draw it was told about, against the right canvas, on every spring frame, and see
 * nothing on the others. Each named canvas takes a turn; a canvas the overlay holds at 0x0 (the deferred highlight pair)
 * still takes the call and the spy must still count it.
 */
for (const name of ["tail", "committed", "highlightWet"] as const) {
	it(`control, device: a clearRect planted on the ${name} canvas every spring frame is reported against ${name} and no other canvas`, async () => {
		const { page, errors } = await open("control-" + name, "device");
		try {
			const r = await call(page, "topFling", name) as any;
			const spring = tally(r.rows, ["spring"]);
			record.push({ cell: "control", plant: name, springFrames: r.springFrames, spring, rows: r.rows });
			const brief = `\n${JSON.stringify(spring)}\n${table(r.rows)}`;
			expect(errors).toEqual([]);
			expect(r.springFrames, `premise: the spring played${brief}`).toBeGreaterThanOrEqual(10);
			expect(spring[name]?.draw ?? 0, `the planted draws are counted against ${name}${brief}`).toBeGreaterThanOrEqual(r.springFrames);
			expect(spring[name]?.framesDrawn ?? 0, `and on every spring frame${brief}`).toBeGreaterThanOrEqual(r.springFrames);
			const others = Object.entries(spring).filter(([n, c]) => n !== name && c.draw + c.size > 0).map(([n]) => n);
			// Any other canvas the claim cell sees drawn at base is a finding there; here it only has to not be the planted one mislabelled.
			expect(spring[name]!.methods.clearRect ?? 0, `the planted method is named${brief}`).toBeGreaterThanOrEqual(r.springFrames);
			record.push({ cell: "control-others", plant: name, others });
		} finally { await page.close(); }
	}, 240_000);
}

/**
 * THE WET-ZERO CONTRACT (arm W): once the wet canvas is released to 0x0, nothing makes a 2D context
 * call on it until a pen stroke sizes it again. A call on a 0x0 canvas draws nothing and still reaches the GPU process and
 * its per-canvas rate limiter (WetInkRenderer.zeroSized). The rig page, the mount watched from the start.
 */
it("rig: no 2D context call reaches the wet canvas while it is 0x0, through mount, ten strokes, a top fling, a band shift, the rest repaint, a file switch and an abandoned-stroke teardown", async () => {
	const { page, errors, mounted } = await open("wet-zero", "rig", true);
	try {
		const r = await call(page, "wetZero") as { phases: { name: string; wetAtStart: string; wetAtEnd: string }[]; premises: any; strokes: number; calls: string[] };
		record.push({ cell: "wet-zero", unguarded, mounted, ...r });
		const phase = (name: string) => r.phases.find(p => p.name === name)!;
		const brief = `\n${JSON.stringify({ unguarded, phases: r.phases, premises: r.premises, calls: r.calls.slice(0, 40) })}`;
		expect(errors).toEqual([]);
		// PREMISES: the strokes are stored; the fling played and released the wet canvas; each later phase begins with it 0x0;
		// the band moved; the pan was baked; the file switched; no stroke was live at the teardown.
		expect(r.strokes, `premise: eleven strokes stored${brief}`).toBe(11);
		expect(phase("strokes").wetAtEnd, `premise: writing leaves the wet canvas sized${brief}`).not.toBe("0x0");
		expect(r.premises.fling.springFrames, `premise: the spring played${brief}`).toBeGreaterThanOrEqual(10);
		expect(phase("fling").wetAtEnd, `premise: the fling released the wet canvas${brief}`).toBe("0x0");
		for (const name of ["band shift", "rest repaint", "file switch", "abandoned"])
			expect(`${name} ${phase(name).wetAtStart}`, `premise: the wet canvas is 0x0 as the phase begins${brief}`).toBe(`${name} 0x0`);
		expect(r.premises.bandAfter?.top, `premise: the band moved${brief}`).not.toBe(r.premises.bandBefore?.top);
		expect(r.premises.needsBake, `premise: a settled pan waited to be baked${brief}`).toBe(true);
		expect(r.premises.baked?.x ?? 0, `premise: the repaint baked the pan${brief}`).toBeLessThan(0);
		expect(r.premises.switchedTo, `premise: the note switched files (not a rename)${brief}`).toBe(true);
		expect(r.premises.sameWetCanvas, `premise: the switch kept the overlay's wet canvas (no remount)${brief}`).toBe(true);
		expect(r.premises.noStrokeLive, `premise: no stroke live at the teardown${brief}`).toBe(true);
		// THE CLAIM.
		expect(r.calls, `context calls on the wet canvas while it was 0x0 (phase:method)${brief}`).toEqual([]);
	} finally { await page.close(); }
}, 240_000);
