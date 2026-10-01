/**
 * WHAT A SCROLL EVENT COSTS ON A HEAVY NOTE: A HORIZONTAL FLING AND A TOP BOUNCE, WITH THE INFINITE CANVAS ON AND OFF.
 *
 * What it looks like: on Orion (package-1b22f759, a note of 1462 strokes) the left flings are laggy and the top bounce a
 * little laggy. The scroll probe reads +10 to +13 ms on every repaint inside a left fling, and +0.3 to +0.7 ms inside a top
 * fling, where the camera is constant in both. A repaint ends in updateExtent, which on a scrolled frame that demands
 * room reads layout twice, the column and the origin, and then writes the extent spacer's left and top; a read after a
 * write flushes the layout of the whole document. The top bounce draws nothing (BounceCanvasWrites.test.ts) but the
 * compositor takes a resource per non-empty canvas on every frame.
 *
 * THIS CELL IS THE INSTRUMENT, NOT THE FIX. One rig page with 1500 strokes on the pane, the canvas on and off, drives a
 * horizontal finger fling of 300 px each way (towards the room the scroll demands, and away from it) and a vertical fling
 * into the top edge with its bounce, and reads, for every repaint in the window:
 *   - the repaint's own time, and the time spent inside updateExtent;
 *   - every layout-forcing read (getBoundingClientRect, scrollWidth, scrollHeight, clientWidth, offsetWidth, scrollLeft,
 *     scrollTop and the rest) that took 0.3 ms or more, with the last DOM write it followed, and the call stack's top frames;
 *   - the attribute and style writes made under the scroller during that repaint (a MutationObserver's records);
 *   - the draw, size and state calls on every canvas on the page (the context spy of BounceCanvasWrites.test.ts).
 * With HW_SCROLLCOST_TRACE=<dir> it also records a Chromium trace and reports, per phase, the Layout and UpdateLayoutTree
 * events (count and total ms), the display frames, and the canvas resources produced. Tracing slows the page, so the
 * repaint times are read from an untraced run.
 *
 * THE CLAIMS, per arm:
 *   - a repaint inside the horizontal fling takes at most 2 ms, except a repaint that moves the ink band (it writes the
 *     overlay's left), which takes under 5 ms: the band carries its pixels and draws only the strip it uncovers, and the
 *     first move of a fling can meet a strip of a hundred or more strokes. Priced on a GPU canvas, the launch below;
 *   - no canvas takes a draw or a size write on any frame of the top bounce.
 * A red names the writer: the repaints over 2 ms, each with its slow reads, the write before it, and the method that made it.
 *
 * Arms: "device": vault test 2's Untitled 1 in Minimal 9.0.2 at base font 19 with the host offsets of the Orion trace,
 * device pixel ratio 2, 1500 four-point strokes injected across the pane. The canvas arms set the global Infinite Canvas
 * switch, which is what a note's own setting resolves to; Alan's own note resolves its canvas from its frontmatter, so
 * the arm's mode is the note's effective mode, not the stored flag.
 *
 * Run: npx vitest run --config vitest.render.mts test/render/ScrollCost.test.ts
 * HW_SCROLLCOST_OUT=<file> writes the per-event tables as JSON.
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

declare const process: { env: Record<string, string | undefined>; platform: string };

/** Minimal 9.0.2's theme.css, verbatim (the fixture MinimalCameraScale.test.ts loads): vault test 2's theme. */
const MINIMAL_CSS = readFileSync(fileURLToPath(new URL("./fixtures/minimal-9.0.2-theme.css", import.meta.url)), "utf8");

const PAGE = `
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { inlineInk, inkOverlayExtension, overlayForPath, setScrollExpansionEnabled, setInlineTool, setInkSizeMult } from "../../src/inline/InkOverlay";
import { surfaceExtents } from "../../src/inline/SurfaceExtent";
import { setInkColorHex } from "../../src/ink/InkColor";
import { setPenInk } from "../../src/inline/PenInk";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField } from "./iphoneObsidianStub";
import { parsePage, serializePage } from "../../src/model/PageData";

installObsidianDom();

// ---- the probes: installed before anything mounts --------------------------------------------------------------------
const rs = { on: false, cur: null, dirty: null };
const where = () => {
	const out = [];
	for (const line of String(new Error().stack || "").split("\\n").slice(2)) {
		const m = /at (?:async )?([^ (]+)[^:]*(?:\\(|@)?.*?:(\\d+):\\d+\\)?$/.exec(line.trim());
		if (m && !/^(Object\\.|Array\\.|new )?(wrapRead|noteRead)$/.test(m[1])) out.push(m[1] + ":" + m[2]);
		if (out.length >= 4) break;
	}
	return out.join(" < ");
};

// Layout-forcing reads, timed. A read that follows a DOM write since the last read is what flushes the layout.
const SLOW_MS = 0.3;
function noteRead(api, t0) {
	const ms = performance.now() - t0;
	const cur = rs.cur;
	if (cur) {
		cur.reads++; cur.readMs += ms;
		if (ms >= SLOW_MS) cur.slow.push({ api, ms: Math.round(ms * 100) / 100, after: rs.dirty, where: where() });
	}
	rs.dirty = null;
}
const READ_PROPS = ["scrollWidth", "scrollHeight", "clientWidth", "clientHeight", "clientLeft", "clientTop", "offsetWidth", "offsetHeight", "offsetLeft", "offsetTop", "scrollTop", "scrollLeft"];
for (const proto of [Element.prototype, HTMLElement.prototype]) for (const prop of READ_PROPS) {
	const d = Object.getOwnPropertyDescriptor(proto, prop);
	if (!d || !d.get) continue;
	Object.defineProperty(proto, prop, { configurable: true, enumerable: d.enumerable, get() { const t0 = performance.now(); const v = d.get.call(this); noteRead(prop, t0); return v; }, set: d.set });
}
for (const method of ["getBoundingClientRect", "getClientRects"]) {
	const orig = Element.prototype[method];
	Element.prototype[method] = function (...a) { const t0 = performance.now(); const v = orig.apply(this, a); noteRead(method, t0); return v; };
}
const origGCS = window.getComputedStyle.bind(window);
window.getComputedStyle = (...a) => { const t0 = performance.now(); const v = origGCS(...a); noteRead("getComputedStyle", t0); return v; };

// DOM writes, noted as the last thing that dirtied layout.
const dirtied = (what) => { rs.dirty = what; };
for (const prop of ["left", "top", "width", "height", "transform", "translate", "display", "visibility", "position", "cssText", "margin", "marginLeft", "marginTop", "paddingLeft", "paddingTop"]) {
	const d = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, prop);
	if (!d || !d.set) continue;
	Object.defineProperty(CSSStyleDeclaration.prototype, prop, { configurable: true, enumerable: d.enumerable, get: d.get, set(v) { dirtied("style." + prop + "=" + String(v).slice(0, 30)); d.set.call(this, v); } });
}
const origSetProp = CSSStyleDeclaration.prototype.setProperty;
CSSStyleDeclaration.prototype.setProperty = function (n, v, p) { dirtied("style.setProperty(" + n + "," + String(v).slice(0, 20) + ")"); return origSetProp.call(this, n, v, p); };
for (const [proto, methods] of [[Element.prototype, ["setAttribute", "removeAttribute", "append", "prepend"]], [DOMTokenList.prototype, ["add", "remove", "toggle", "replace"]], [Node.prototype, ["appendChild", "insertBefore", "removeChild", "replaceChild"]]]) {
	for (const m of methods) {
		const orig = proto[m];
		proto[m] = function (...a) { dirtied(m + "(" + (typeof a[0] === "string" ? a[0].slice(0, 24) : (a[0] && a[0].nodeName) || "") + ")"); return orig.apply(this, a); };
	}
}

// The context spy of BounceCanvasWrites.test.ts: every 2D method, every canvas size write, keyed by the canvas element.
const DRAW = new Set(["clearRect", "fillRect", "strokeRect", "fillText", "strokeText", "fill", "stroke", "drawImage", "putImageData"]);
const READ = new Set(["constructor", "getImageData", "getContextAttributes", "getLineDash", "getTransform", "isContextLost", "isPointInPath", "isPointInStroke",
	"measureText", "createLinearGradient", "createRadialGradient", "createConicGradient", "createPattern", "createImageData"]);
const spy = { on: false, seen: new Map() };
function note(canvas, method, kind) {
	if (!spy.on) return;
	let e = spy.seen.get(canvas);
	if (!e) { e = { canvas, draw: 0, state: 0, size: 0, methods: {} }; spy.seen.set(canvas, e); }
	e[kind]++; e.methods[method] = (e.methods[method] || 0) + 1;
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

const ids = new Map(), sidecars = new Map();
const save = (id, page) => { sidecars.set(id, serializePage(page)); };
inlineInk.attachHost({ readPageId: p => ids.get(p) ?? null, claimId: async (p, id) => { ids.set(p, id); return { pageId: id }; },
	loadSidecar: async id => (sidecars.has(id) ? parsePage(sidecars.get(id), id) : null), scheduleSidecar: save, scheduleSidecarNow: async (id, p) => save(id, p), notify: () => {} });

const frame = () => new Promise(r => requestAnimationFrame(() => r()));
const rendered = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await frame(); };
const mark = n => { try { performance.mark(n); } catch {} };
const PANE_W = 1397.5, PANE_H = 800, HOST_LEFT = 300, TEXT_LINE = 6, STROKES = 1500;
const NAMED = ["committed", "wet", "wetTile", "tail", "highlight", "highlightWet"];
let rig = null;

function installSizer(view) {
	const sizer = document.createElement("div"); sizer.className = "cm-sizer";
	const container = document.createElement("div"); container.className = "cm-contentContainer";
	view.contentDOM.parentElement.insertBefore(sizer, view.contentDOM); sizer.appendChild(container); container.appendChild(view.contentDOM);
	void view.scrollDOM.clientWidth; return sizer;
}
function nameOf(c) {
	const o = rig && rig.overlay;
	if (o) for (const n of NAMED) if (o[n + "Canvas"] === c) return n;
	return "other:" + (c.className || "(no class)");
}
function snapshot() {
	const out = {};
	for (const e of spy.seen.values()) {
		const n = nameOf(e.canvas), o = out[n] || (out[n] = { draw: 0, state: 0, size: 0, methods: {} });
		o.draw += e.draw; o.state += e.state; o.size += e.size;
		for (const m in e.methods) o.methods[m] = (o.methods[m] || 0) + e.methods[m];
	}
	return out;
}
function delta(prev, cur) {
	const out = {};
	for (const n in cur) {
		const a = prev[n] || { draw: 0, state: 0, size: 0, methods: {} }, b = cur[n];
		if (b.draw === a.draw && b.state === a.state && b.size === a.size) continue;
		const methods = {};
		for (const m in b.methods) { const d = b.methods[m] - (a.methods[m] || 0); if (d) methods[m] = d; }
		out[n] = { draw: b.draw - a.draw, state: b.state - a.state, size: b.size - a.size, methods };
	}
	return out;
}
const cssProps = v => { const o = {}; for (const part of String(v || "").split(";")) { const i = part.indexOf(":"); if (i > 0) o[part.slice(0, i).trim()] = part.slice(i + 1).trim(); } return o; };
const tagOf = t => t instanceof HTMLCanvasElement ? nameOf(t) : (t.className && typeof t.className === "string" ? t.tagName.toLowerCase() + "." + t.className.split(" ").filter(c => c.startsWith("handwriting") || c.startsWith("cm-")).slice(0, 2).join(".") : t.tagName.toLowerCase());
/** The attribute and style writes under the scroller since the last take, as { target: { property: count } }. */
function takeWrites(mo) {
	const out = {};
	for (const m of mo.takeRecords()) {
		const t = m.target;
		if (!(t instanceof Element) || !(t === rig.view.scrollDOM || rig.view.scrollDOM.contains(t))) continue;
		const o = out[tagOf(t)] || (out[tagOf(t)] = {});
		if (m.attributeName === "style") {
			const a = cssProps(m.oldValue), b = cssProps(t.getAttribute("style"));
			for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[k] !== b[k]) o[k] = (o[k] || 0) + 1;
		} else o["@" + m.attributeName] = (o["@" + m.attributeName] || 0) + 1;
	}
	return out;
}

window.scrollCost = {
	async mount(tag, canvas) {
		setPenInk(true); setScrollExpansionEnabled(canvas);
		setInlineTool("pen"); setInkColorHex("pen", "#222222"); setInkSizeMult("pen", 2);
		const path = "scroll-cost-" + tag + ".md";
		const pane = document.body.appendChild(document.createElement("div"));
		pane.className = "markdown-source-view mod-cm6";
		pane.style.cssText = "position:relative;margin-left:" + (HOST_LEFT + 1 / 3) + "px;margin-top:77.5px;width:" + PANE_W + "px;height:" + PANE_H + "px;overflow:hidden";
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
		// 1500 four-point strokes, injected (1500 pointer sequences would be 1500 commits), spread over the pane and a little past it
		// on both axes, the size a pen leaves. Every one of them is on screen, as in the probe (1462 drawn).
		const PATH = [[0, 0], [9, 7], [18, 0], [27, 7]];
		const ink = [];
		for (let k = 0; k < STROKES; k++) {
			const ox = (k * 977) % 1500, oy = (k * 613) % 700;
			ink.push({ id: "sc-" + k, tool: "pen", color: "#222", width: 2, createdAt: 1, bbox: { x: ox - 2, y: oy - 2, width: 31, height: 11 },
				points: PATH.map(([dx, dy], j) => ({ x: ox + dx, y: oy + dy, pressure: 0.5, t: j * 8 })) });
		}
		inlineInk.applyAdd(path, ink);
		// Room to scroll sideways: a grant of 1500 note px, so the scroller has a range and the demand rule has an edge to meet.
		surfaceExtents.grow(path, { x: 1500, y: 0 });
		overlay.updateExtent(true);
		await settle(12);
		return { strokes: inlineInk.strokes(path).length, canvasMode: !!overlay.canvasMode, scrollWidth: view.scrollDOM.scrollWidth, clientWidth: view.scrollDOM.clientWidth,
			scrollHeight: view.scrollDOM.scrollHeight, clientHeight: view.scrollDOM.clientHeight, dpr: window.devicePixelRatio };
	},
	/**
	 * One finger on the scroller. axis "x": \`start\` is the scrollLeft to begin at, dir +1 drags the finger to the right (the page
	 * moves right, scrollLeft falls), -1 to the left (scrollLeft rises). Sixteen moves of 18.75 px, 16 ms apart, a lift at speed,
	 * then every frame until the fling ends plus four. axis "y" at the top edge: the T1 drive, a pull into the top and its spring.
	 * Every repaint from the first move is one row, with what the probes saw during it.
	 */
	async fling(axis, dir, start, plant) {
		const { view, overlay } = rig, router = overlay.router, sd = view.scrollDOM;
		setPenInk(false);
		sd.scrollTop = 0; sd.scrollLeft = axis === "x" ? start : 0;
		await settle(8);
		mark("sc:idle-begin");
		await new Promise(res => setTimeout(res, 1200));
		await settle(4);
		mark("sc:idle-end");
		const r = sd.getBoundingClientRect(), x0 = r.left + r.width / 2, y0 = r.top + r.height / 2;
		const finger = (type, d, buttons) => {
			const e = { type, pointerType: "touch", pointerId: 961, isPrimary: true, clientX: axis === "x" ? x0 + d : x0, clientY: axis === "y" ? y0 + d : y0,
				pressure: buttons === 0 ? 0 : 0.5, buttons, button: 0, timeStamp: performance.now(), tiltX: 0, tiltY: 0, width: 0, height: 0,
				target: sd, preventDefault() {}, stopPropagation() {} };
			if (type === "pointerdown") router.pointerDown(e); else if (type === "pointermove") router.pointerMove(e); else router.pointerUpOrCancel(e);
		};
		// Wrappers: the repaint, and updateExtent inside it.
		const mo = new MutationObserver(() => {});
		mo.observe(sd, { subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ["style", "class", "width", "height", "hidden"] });
		const rows = [], scrolls = [], extras = [];
		let phase = "down", prevSnap = {}, pendingAt = null;
		const origRepaint = overlay.repaint, origExtent = overlay.updateExtent, origSchedule = overlay.scheduleRepaint;
		// The scroll probe's "+ms" is the wait from the request to the run, not the cost of the repaint: the first request since the last run starts it.
		overlay.scheduleRepaint = function (...a) { if (pendingAt === null) pendingAt = performance.now(); return origSchedule.apply(this, a); };
		// updateExtent, timed wherever it is called from. Inside a repaint it adds to that repaint's row; outside one it is a row of its own.
		overlay.updateExtent = function (...a) {
			const t0 = performance.now();
			const own = rs.cur === null ? { phase, kind: "extent", t: Math.round(t0), ms: 0, extentMs: 0, reads: 0, readMs: 0, slow: [], writes: {}, canvases: {}, scrollLeft: sd.scrollLeft, scrollTop: sd.scrollTop, waited: 0 } : null;
			if (own) { rs.cur = own; rs.dirty = null; }
			try { return origExtent.apply(this, a); } finally {
				const dt = performance.now() - t0;
				if (own) { own.ms = dt; own.extentMs = dt; own.writes = takeWrites(mo); rs.cur = null; rows.push(own); } else if (rs.cur) rs.cur.extentMs += dt;
			}
		};
		overlay.repaint = function (...a) {
			const t0 = performance.now();
			const cur = { phase, kind: "repaint", t: Math.round(t0), ms: 0, extentMs: 0, reads: 0, readMs: 0, slow: [], writes: {}, canvases: {}, scrollLeft: 0, scrollTop: 0, waited: pendingAt === null ? 0 : t0 - pendingAt };
			pendingAt = null;
			rs.cur = cur; rs.dirty = null;
			// Writes made before this repaint (by the scroll handler, the pointer handler) are not this repaint's: keep them as their own record.
			const before = takeWrites(mo); if (Object.keys(before).length) extras.push({ phase, t: Math.round(t0), before: "repaint", writes: before });
			try { return origRepaint.apply(this, a); } finally {
				// The plant: a style write that restyles the page, then a layout read, at the end of every repaint, as a stand-in for the suspect.
				if (plant === "layout") plantLayout();
				cur.ms = performance.now() - t0; rs.cur = null;
				cur.writes = takeWrites(mo);
				const snap = snapshot(); cur.canvases = delta(prevSnap, snap); prevSnap = snap;
				cur.scrollLeft = sd.scrollLeft; cur.scrollTop = sd.scrollTop;
				rows.push(cur);
			}
		};
		const onScroll = () => scrolls.push({ phase, t: Math.round(performance.now()), left: sd.scrollLeft, top: sd.scrollTop });
		const flushWrites = () => { const w = takeWrites(mo); if (Object.keys(w).length) extras.push({ phase, t: Math.round(performance.now()), before: "frame", writes: w }); };
		sd.addEventListener("scroll", onScroll);
		let plantN = 0;
		const plantLayout = () => { document.body.style.setProperty("--font-text-size", (19 + (plantN++ % 2) * 0.02) + "px"); return sd.scrollWidth; };
		const read = () => { const b = overlay.overscrollBounceReadout(); return { active: b.active, total: axis === "y" ? b.restY + b.y : b.restX + b.x, fling: router.flingRaf !== 0 }; };
		const scrollAtStart = { left: sd.scrollLeft, top: sd.scrollTop, scrollWidth: sd.scrollWidth, scrollHeight: sd.scrollHeight };
		spy.seen.clear(); spy.on = true; rs.on = true;
		mark("sc:down");
		finger("pointerdown", 0, 1);
		phase = "drag";
		for (let i = 1; i <= 16; i++) { await new Promise(res => setTimeout(res, 16)); finger("pointermove", dir * 18.75 * i, 1); flushWrites(); }
		const held = { pull: axis === "y" ? router.overscrollPullY : router.overscrollPullX, engaged: !!router.assistEngaged };
		mark("sc:lift");
		phase = "coast";
		finger("pointerup", dir * 300 * (axis === "y" ? 1.6 : 1), 0);
		let coastFrames = 0, ended = -1, active = 0;
		for (let j = 0; j < 160; j++) {
			await rendered();
			flushWrites();
			const f = read();
			coastFrames++; if (f.active) active++;
			if (!f.active && !f.fling) { ended = j; break; }
		}
		mark("sc:end");
		phase = "tail";
		for (let i = 0; i < 4; i++) await rendered();
		mark("sc:tail-end");
		spy.on = false; rs.on = false;
		sd.removeEventListener("scroll", onScroll); mo.disconnect();
		overlay.repaint = origRepaint; overlay.updateExtent = origExtent; overlay.scheduleRepaint = origSchedule;
		await settle(4);
		const end = { left: sd.scrollLeft, top: sd.scrollTop, scrollWidth: sd.scrollWidth };
		return { axis, dir, start, held, scrollAtStart, end, coastFrames, springFrames: active, ended, rest: read(), rows, scrolls, extras };
	},
};
`;

/** The lag rig's flags (LazyHighlightPairTrace.test.ts): a GPU canvas, the kind the device draws with. Without them the
 * canvases are CPU-backed and a blit is a full-surface memory copy, a price the device does not pay. */
const GPU_ARGS = process.platform === "win32" ? ["--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--use-angle=d3d11"] : [];
let browser: Browser, script: string;
const record: unknown[] = [];

beforeAll(async () => {
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "scrollCostPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true, args: GPU_ARGS });
}, 180_000);
afterAll(async () => {
	await browser?.close();
	if (process.env.HW_SCROLLCOST_OUT) writeFileSync(process.env.HW_SCROLLCOST_OUT, JSON.stringify(record, null, 1));
});

const call = (p: Page, method: string, ...args: unknown[]) => p.evaluate(([m, a]) => (window as any).scrollCost[m](...a), [method, args] as const);
async function open(tag: string, canvas: boolean) {
	const page = await browser.newPage({ viewport: { width: 1800, height: 900 }, deviceScaleFactor: 2, hasTouch: true });
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	await page.setContent('<!doctype html><body class="theme-dark" style="margin:0; --font-text-size:19px; --background-modifier-border:#777777"></body>');
	await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
	await page.addStyleTag({ content: MINIMAL_CSS });
	await page.addScriptTag({ content: script });
	const mounted = await call(page, "mount", tag, canvas) as any;
	return { page, errors, mounted };
}

type Row = { phase: string; kind?: string; waited?: number; t: number; ms: number; extentMs: number; reads: number; readMs: number; scrollLeft: number; scrollTop: number;
	slow: { api: string; ms: number; after: string | null; where: string }[]; writes: Record<string, Record<string, number>>;
	canvases: Record<string, { draw: number; state: number; size: number; methods: Record<string, number> }> };

const f2 = (n: number) => Math.round(n * 100) / 100;
/** One line per repaint: its time, the time inside updateExtent, the layout reads that cost 0.3 ms or more with what dirtied layout before them and who called, the writes, the draws. */
function table(rows: Row[]) {
	return rows.map((r, i) => `${String(i).padStart(2)} ${r.phase.padEnd(5)} ${String(r.t).padStart(6)} x=${Math.round(r.scrollLeft)} y=${Math.round(r.scrollTop)} ${r.kind === "extent" ? "updateExtent alone" : "repaint"} ${f2(r.ms)} ms (waited ${f2(r.waited ?? 0)} ms from the request), in updateExtent ${f2(r.extentMs)}, ${r.reads} layout reads ${f2(r.readMs)} ms` +
		(r.slow.length ? ` SLOW: ${r.slow.map(s => `${s.api} ${s.ms} ms after [${s.after ?? "no write"}] at ${s.where}`).join(" | ")}` : "") +
		(Object.keys(r.writes).length ? ` WRITES: ${JSON.stringify(r.writes)}` : "") +
		(Object.keys(r.canvases).length ? ` CANVAS: ${Object.entries(r.canvases).map(([n, c]) => `${n} d${c.draw} z${c.size} s${c.state}`).join(",")}` : "")).join("\n");
}
const SCROLL_PHASES = ["down", "drag", "coast", "tail"];
const inFling = (rows: Row[]) => rows.filter(r => SCROLL_PHASES.includes(r.phase));

/** HW_SCROLLCOST_PLANT=layout: a font-size style write and a scrollWidth read at the end of every repaint; the claim must go red naming that read. */
const PLANT = process.env.HW_SCROLLCOST_PLANT || null;
const HORIZONTAL = [
	{ name: "towards the room the scroll asks for (finger left, scrollLeft rises)", dir: -1, where: "near the right edge of the range" },
	{ name: "away from it (finger right, scrollLeft falls)", dir: 1, where: "well inside the range" },
] as const;
for (const canvas of [true, false]) for (const h of HORIZONTAL) {
	it(`canvas ${canvas ? "on" : "off"}, horizontal fling ${h.name}: a repaint takes at most 2 ms`, async () => {
		const { page, errors, mounted } = await open(`h-${canvas}-${h.dir}`, canvas);
		try {
			const range = mounted.scrollWidth - mounted.clientWidth;
			// Rising: begin 300 px short of the far end of the range, so the fling runs into the last quarter of a viewport,
			// where the demand rule asks for room. Falling: begin where a 300 px fall stays inside the range.
			const start = h.dir < 0 ? Math.max(0, range - 300) : Math.min(range, 600);
			const traceDir = process.env.HW_SCROLLCOST_TRACE;
			if (traceDir) await browser.startTracing(page, { categories: ["blink", "blink.user_timing", "cc", "gpu", "viz", "devtools.timeline", "disabled-by-default-devtools.timeline"] });
			const r = await call(page, "fling", "x", h.dir, start, PLANT) as any;
			let traced: unknown = null;
			if (traceDir) { const buf = await browser.stopTracing(); const name = `trace-h-${canvas ? "on" : "off"}-${h.dir}.json`; writeFileSync(`${traceDir}/${name}`, buf); traced = phaseReport(buf.toString("utf8")); }
			const rows = inFling(r.rows as Row[]);
			const bandMove = (x: Row) => !!x.writes["div.handwriting-ink-overlay"]?.left;
			const over = rows.filter(x => x.ms > (bandMove(x) ? 5 : 2));
			const worst = rows.reduce((a, x) => Math.max(a, x.ms), 0);
			record.push({ cell: "horizontal", canvas, dir: h.dir, mounted, start, range, scrollAtStart: r.scrollAtStart, end: r.end, worst: f2(worst), over: over.length, repaints: rows.length, scrollEvents: r.scrolls.length, traced, rows: r.rows, extras: r.extras });
			const brief = `\nrange ${range}, began at ${start}, ended at ${r.end.left}, ${rows.length} repaints, ${r.scrolls.length} scroll events, worst ${f2(worst)} ms, ${over.length} over 2 ms\n${table(r.rows)}`;
			expect(errors).toEqual([]);
			// PREMISES: 1500 strokes; the mode is the arm's; the scroller has a range; the fling moved it; repaints ran.
			expect(mounted.strokes, "premise: 1500 strokes").toBe(1500);
			expect(mounted.canvasMode, "premise: the arm's mode").toBe(canvas);
			expect(range, `premise: the scroller has a horizontal range${brief}`).toBeGreaterThan(400);
			expect(Math.abs(r.end.left - r.scrollAtStart.left), `premise: the fling moved the scroller${brief}`).toBeGreaterThan(100);
			expect(r.scrolls.length, `premise: scroll events fired${brief}`).toBeGreaterThanOrEqual(10);
			expect(rows.length, `premise: the fling repainted${brief}`).toBeGreaterThanOrEqual(5);
			// THE CLAIM: every repaint in the fling, updateExtent included, takes at most 2 ms; a band move under 5 ms.
			expect(over.map(x => `${f2(x.ms)} ms (updateExtent ${f2(x.extentMs)}): ${x.slow.map(s => `${s.api} ${s.ms} ms after [${s.after ?? "no write"}] at ${s.where}`).join(" | ") || "no slow read"}; writes ${JSON.stringify(x.writes)}`),
				`repaints over 2 ms (a band move: over 5 ms)${brief}`).toEqual([]);
		} finally { await page.close(); }
	}, 240_000);
}

for (const canvas of [true, false]) {
	it(`canvas ${canvas ? "on" : "off"}, top fling and bounce: no canvas takes a draw or a size write on any frame`, async () => {
		const { page, errors, mounted } = await open(`top-${canvas}`, canvas);
		try {
			const traceDir = process.env.HW_SCROLLCOST_TRACE;
			if (traceDir) await browser.startTracing(page, { categories: ["blink", "blink.user_timing", "cc", "gpu", "viz", "devtools.timeline", "disabled-by-default-devtools.timeline"] });
			const r = await call(page, "fling", "y", 1, 0) as any;
			let traced: unknown = null;
			if (traceDir) { const buf = await browser.stopTracing(); writeFileSync(`${traceDir}/trace-top-${canvas ? "on" : "off"}.json`, buf); traced = phaseReport(buf.toString("utf8")); }
			const rows = r.rows as Row[];
			const dirty = rows.flatMap((x, i) => Object.entries(x.canvases).filter(([, c]) => c.draw + c.size > 0).map(([n, c]) => `row ${i} (${x.phase}): ${n} ${c.draw} draws ${c.size} size writes ${JSON.stringify(c.methods)} in a ${f2(x.ms)} ms repaint`));
			record.push({ cell: "top", canvas, mounted, held: r.held, springFrames: r.springFrames, ended: r.ended, repaints: rows.length, traced, rows, extras: r.extras });
			const brief = `\n${rows.length} repaints, spring ${r.springFrames} frames\n${table(rows)}`;
			expect(errors).toEqual([]);
			expect(mounted.strokes, "premise: 1500 strokes").toBe(1500);
			expect(mounted.canvasMode, "premise: the arm's mode").toBe(canvas);
			// With the canvas off the page has no edge give: no pull and no spring, so the premises of a bounce hold for the canvas arm only.
			if (canvas) {
				expect(r.held.engaged, "premise: the assist carried the drag").toBe(true);
				expect(Math.abs(r.held.pull), "premise: the drag pulled against the top edge").toBeGreaterThan(10);
				expect(r.springFrames, `premise: a spring played at least ten frames${brief}`).toBeGreaterThanOrEqual(10);
				expect(r.ended, "premise: the spring ended").toBeGreaterThanOrEqual(0);
			} else expect(r.springFrames, `with the canvas off the top edge plays no spring${brief}`).toBe(0);
			expect(dirty, `canvases dirtied in the bounce${brief}`).toEqual([]);
		} finally { await page.close(); }
	}, 240_000);
}

/** The Chromium trace, per phase between the cell's performance marks: Layout and UpdateLayoutTree (count, total ms), display frames, canvas resources. */
function phaseReport(json: string) {
	const ev = (JSON.parse(json).traceEvents ?? []) as { name?: string; ph?: string; ts: number; dur?: number }[];
	const marks: Record<string, number> = {};
	for (const e of ev) if (e.name?.startsWith("sc:")) marks[e.name] = e.ts;
	const phases: [string, string, string][] = [["idle", "sc:idle-begin", "sc:idle-end"], ["drag", "sc:down", "sc:lift"], ["coast", "sc:lift", "sc:end"], ["tail", "sc:end", "sc:tail-end"]];
	const out: Record<string, unknown> = {};
	for (const [name, a, b] of phases) {
		if (marks[a] === undefined || marks[b] === undefined) continue;
		const inside = ev.filter(e => e.ph !== "E" && e.ts >= marks[a]! && e.ts < marks[b]!);
		const of = (re: RegExp) => { const m = inside.filter(e => re.test(e.name ?? "")); return { n: m.length, ms: f2(m.reduce((s, e) => s + (e.dur ?? 0), 0) / 1000) }; };
		out[name] = { ms: f2((marks[b]! - marks[a]!) / 1000), layout: of(/^Layout$/), updateLayoutTree: of(/^UpdateLayoutTree$/), displayFrames: of(/^DirectRenderer::DrawFrame$/).n, canvasResources: of(/ProduceCanvasResource/).n };
	}
	return out;
}
