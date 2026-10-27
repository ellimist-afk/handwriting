/**
 * WHAT A SPRING-BACK AT THE TOP OR LEFT EDGE COSTS ON A HEAVY NOTE: COUNTS PER FRAME, ON MCB EXAM 3.
 *
 * What it looks like: on Orion (package-b99879c8, vault test 2) the spring-back stutters after a pan into the top or left
 * edge and after a pinch into it. BounceCanvasWrites.test.ts and BounceRepaint.test.ts read that spring on a one-stroke page
 * and found one transform write and one repaint per spring; the stutter is on a note with 28,358 strokes. This cell is
 * their drive and their spy on that note.
 *
 * THIS CELL IS A MEASUREMENT RIG, NOT A CLAIM. It asserts its premises (the ink loaded, Infinite Canvas on, the gesture
 * pulled past the edge, a spring played and came home) and writes the per-frame table to HW_RIG_OUT. Per frame, from the
 * first finger move to four frames after the spring ends: draw calls, size writes and state calls on each overlay canvas
 * (BounceCanvasWrites' spy), style and class rewrites on each canvas or its holder, committed-layer repaints and the kind
 * of committed work they did (BounceRepaint's counter, and the strips-or-all split), long tasks, and the frame interval.
 *
 * Gestures: "fling", one finger, sixteen 30 px moves 16 ms apart into the edge and a lift at speed, at the top edge and at
 * the left edge; "pinch", two fingers spread to three times the note's zoom about a point 60 px in from the top edge,
 * settled, then closed back while their centre travels 120 px away from the edge, so the page ends past its edge and the
 * settle's correction starts the spring. Zooms: 25 and 100 percent (HW_RIG_ZOOMS).
 *
 * Per frame, beyond the counts above: the requestAnimationFrame timestamp (so the interval is the browser's, not the
 * task's), the extent pieces that ran since the last frame (count and ms), the band syncs and their results, the number of
 * handleResize calls, each committed paint with its kind and ms. With HW_RIG_TRACE=1 a Chromium trace runs around the
 * drive and the compositor's Canvas, Produce, Present and DrawFrame events are counted per frame (split by the frame marks
 * the cell writes). The trace perturbs frame times, so the interval is read from the run without it.
 *
 * THE PLANT ARM: HW_RIG_WILLCHANGE=1 sets will-change: transform on the ink layer and the sizer before the drive, from the
 * cell, no source change. The discriminator is the pair: resources per frame and the interval, with and without.
 *
 * THE CLAIM CELLS (names start "claim:", traced, 100 percent, no will-change from the cell): the spring marks the ink layer
 * and the sizer as moving for its length and no longer. From the spring's third frame on, the compositor runs no
 * RasterTask and no tile-state change at the top and left flings (the layers are rastered once, in the second frame, when
 * marked); will-change: transform is on both elements on every spring
 * frame and off both on every frame after it, whether the spring ran out or a new gesture cancelled it.
 *
 * THE CONTROL (always runs): a clearRect planted on the committed canvas on every spring frame of the top fling must be
 * counted against that canvas on every spring frame, or a quiet table could mean a blind spy.
 *
 * Inputs: HW_RIG_INK (the ink copy, JSON), HW_RIG_TEXT (the note's text), both read at run time; none is committed.
 * HW_RIG_ZOOMS (default "0.25,1") are the zooms the note is committed to before the drive. HW_RIG_DPR (default 2).
 *
 * Run: HW_RIG_INK=<ink.json> HW_RIG_TEXT=<note.md> HW_RIG_OUT=<file> npx vitest run --config vitest.render.mts test/render/BounceMcbRig.test.ts
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

declare const process: { env: Record<string, string | undefined> };

const MINIMAL_CSS = readFileSync(fileURLToPath(new URL("./fixtures/minimal-9.0.2-theme.css", import.meta.url)), "utf8");
const INK_PATH = process.env.HW_RIG_INK ?? "", TEXT_PATH = process.env.HW_RIG_TEXT ?? "", OUT = process.env.HW_RIG_OUT ?? "";
const HAVE = !!INK_PATH && !!TEXT_PATH && existsSync(INK_PATH) && existsSync(TEXT_PATH);
const INK = HAVE ? readFileSync(INK_PATH, "utf8") : "", TEXT = HAVE ? readFileSync(TEXT_PATH, "utf8") : "";
const PARSED = HAVE ? JSON.parse(INK) as { pageId: string; strokes: unknown[] } : { pageId: "", strokes: [] };
const DPR = Number(process.env.HW_RIG_DPR ?? "2"), ZOOMS = (process.env.HW_RIG_ZOOMS ?? "0.25,1").split(",").map(Number);
const WILLCHANGE = process.env.HW_RIG_WILLCHANGE === "1", TRACE = process.env.HW_RIG_TRACE === "1";
// HW_RIG_PROBE=1 turns the scroll probe on (its repaint lines carry from= and bake=); HW_RIG_ONLY="fling top,fling left" keeps those drives; HW_RIG_MOVES is the finger moves of a fling.
const PROBE = process.env.HW_RIG_PROBE === "1", ONLY = (process.env.HW_RIG_ONLY ?? "").split(",").filter(Boolean), MOVES = Number(process.env.HW_RIG_MOVES ?? "16");
if (!HAVE) console.log("SKIP the MCB rig: set HW_RIG_INK and HW_RIG_TEXT to the MCB EXAM 3 ink copy and note text");

const PAGE = `
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { inlineInk, inkLookKey, inkOverlayExtension, overlayForPath, setScrollExpansionEnabled, setInlineTool, extentRasterFits, extentPairFits, EXTENT_RASTER_MAX_PX_DESKTOP, EXTENT_RASTER_MAX_PX_MOBILE, EXTENT_PAIR_FACTOR } from "../../src/inline/InkOverlay";
import { Platform } from "obsidian";
import { setDiagnosticsEnabled } from "../../src/diag/DiagSwitch";
import { clearScrollProbe, formatScrollProbe } from "../../src/inline/ScrollProbe";
import { setPenInk } from "../../src/inline/PenInk";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField } from "./iphoneObsidianStub";
import { parsePage, serializePage } from "../../src/model/PageData";

installObsidianDom();

// ---- the spy, as BounceCanvasWrites installs it: before anything mounts, so no canvas is created outside it ----------
const DRAW = new Set(["clearRect", "fillRect", "strokeRect", "fillText", "strokeText", "fill", "stroke", "drawImage", "putImageData"]);
const READ = new Set(["constructor", "getImageData", "getContextAttributes", "getLineDash", "getTransform", "isContextLost",
	"isPointInPath", "isPointInStroke", "measureText", "createLinearGradient", "createRadialGradient", "createConicGradient",
	"createPattern", "createImageData"]);
const spy = { on: false, seen: new Map() };
function note(canvas, method, kind) {
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
// Long tasks: the tasks over 50 ms the browser reports, with their start; the cell lays them over the frame times.
const longTasks = [];
try { new PerformanceObserver(l => { for (const e of l.getEntries()) longTasks.push({ start: e.startTime, dur: e.duration }); }).observe({ type: "longtask", buffered: false }); } catch {}

const ids = new Map(), sidecars = new Map();
const save = (id, page) => { sidecars.set(id, serializePage(page)); };
inlineInk.attachHost({ readPageId: p => ids.get(p) ?? null, claimId: async (p, id) => { ids.set(p, id); return { pageId: id }; },
	loadSidecar: async id => (sidecars.has(id) ? parsePage(sidecars.get(id), id) : null), scheduleSidecar: save, scheduleSidecarNow: async (id, p) => save(id, p), notify: () => {} });

const frame = () => new Promise(r => requestAnimationFrame(() => r()));
let lastRaf = 0;
const rendered = () => new Promise(r => requestAnimationFrame(ts => { lastRaf = ts; setTimeout(r, 0); }));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await frame(); };
const PANE_W = 1397.5, PANE_H = 800, HOST_LEFT = 300, HOST_TOP = 77.5;
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
	return "other:" + (c.className || "(no class)") + (c.isConnected ? "@" + (c.parentElement && c.parentElement.className || "body") : " detached");
}
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

window.mcbRig = {
	async mount(zoom, sidecar, pageId, text, wantStrokes, probe, desktop) {
		// The stub is an iPhone: Platform.isMobile is true, which puts the raster cap at 8 million px and the pair cap at 12.8 million.
		if (desktop) { Platform.isMobile = false; Platform.isMobileApp = false; }
		setDiagnosticsEnabled(!!probe);
		setPenInk(true); setScrollExpansionEnabled(true); setInlineTool("pen");
		const path = "OneNote import/Fall 2015/MCB/MCB EXAM 3.md";
		sidecars.set(pageId, sidecar); ids.set(path, pageId);
		const pane = document.body.appendChild(document.createElement("div"));
		pane.className = "markdown-source-view mod-cm6";
		pane.style.cssText = "position:relative;margin-left:" + (HOST_LEFT + 1 / 3) + "px;margin-top:" + HOST_TOP + "px;width:" + PANE_W + "px;height:" + PANE_H + "px;overflow:hidden";
		document.body.classList.add("handwriting-paper-lines");
		const view = new EditorView({ parent: pane, state: EditorState.create({ doc: text, extensions: [history(), EditorView.lineWrapping,
			editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} })), inkOverlayExtension(),
			EditorView.theme({ "&": { width: PANE_W + "px", height: PANE_H + "px" }, ".cm-scroller": { overflowY: "auto", overflowX: "hidden" } })] }) });
		const sizer = installSizer(view);
		for (let i = 0; i < 120 && wantStrokes > 0 && inlineInk.strokes(path).length === 0; i++) await settle(2);
		await settle(12);
		const overlay = overlayForPath(path);
		if (!overlay) throw new Error("no overlay for " + path);
		rig = { pane, view, overlay, sizer, path, repaints: 0, work: {}, vias: [], pieces: [], syncs: [], resizes: 0, paints: [] };
		overlay.updateExtent(true);
		await settle(12);
		const zoomCommitted = zoom === 1 ? true : !!overlay.commitCameraScale(zoom, { left: 0, top: 0 });
		await settle(16);
		overlay.scheduleRepaint("other");
		await settle(12);
		// Count the committed layer's repaints and the kind of work each did, as BounceRepaint and the imported-ink rig do.
		const repaint = overlay.repaint.bind(overlay);
		overlay.repaint = (...a) => { rig.repaints++; return repaint(...a); };
		const pcw = overlay.paintCommittedWork.bind(overlay);
		overlay.paintCommittedWork = (cam, work, strokes) => { const k = work === "all" ? "all" : "strips"; rig.work[k] = (rig.work[k] || 0) + 1; const t0 = performance.now(); try { return pcw(cam, work, strokes); } finally { rig.paints.push({ work: k, ms: performance.now() - t0, strokes: strokes ? strokes.length : null }); } };
		// The extent pieces, the band syncs and the resize handler, so each frame says what ran between it and the last.
		const piece = overlay.runExtentPiece.bind(overlay);
		overlay.runExtentPiece = (...a) => { const t0 = performance.now(); try { return piece(...a); } finally { rig.pieces.push(performance.now() - t0); } };
		const sync = overlay.syncBand.bind(overlay);
		overlay.syncBand = (...a) => { const r = sync(...a); rig.syncs.push(r); return r; };
		const resize = overlay.handleResize.bind(overlay);
		overlay.handleResize = (...a) => { rig.resizes++; return resize(...a); };
		const schedule = overlay.scheduleRepaint.bind(overlay);
		overlay.scheduleRepaint = via => { rig.vias.push(via === undefined ? "other" : via); return schedule(via); };
		return { strokes: inlineInk.strokes(path).length, zoomCommitted, canvasMode: !!overlay.canvasMode, dpr: window.devicePixelRatio, cssScale: overlay.cssScale,
			scrollWidth: view.scrollDOM.scrollWidth, scrollHeight: view.scrollDOM.scrollHeight, backings: backings() };
	},
	/**
	 * One gesture at one edge. kind "fling": a finger into the edge and a lift at speed. kind "pinch": spread to 300 percent
	 * about a point 60 px in from the edge, settled and rested, then closed to 100 percent while the centre travels 120 px away
	 * from the edge. plant: a canvas name or null; each spring frame clears one pixel of it (the control).
	 */
	async drive(edge, kind, plant, willChange, moves, probe, cancelAt) {
		const { view, overlay } = rig, router = overlay.router, sd = view.scrollDOM;
		setPenInk(false);
		sd.scrollTop = 0; sd.scrollLeft = 0;
		if (willChange) { rig.overlay.inkLayer.style.willChange = "transform"; rig.sizer.style.willChange = "transform"; }
		await settle(8);
		// The assist guard re-arms a second after the last lift, on a real timer (OverscrollBounce.test.ts, giveRegrab).
		await new Promise(res => setTimeout(res, 1200));
		await settle(4);
		const r = sd.getBoundingClientRect(), x0 = r.left + r.width / 2, y0 = r.top + r.height / 2;
		const plantDraw = () => { if (!plant) return; const c = overlay[plant + "Canvas"]; const ctx = c && c.getContext("2d"); if (ctx) ctx.clearRect(0, 0, 1, 1); };
		const read = () => { const b = overlay.overscrollBounceReadout(); return { active: b.active, total: edge === "top" ? b.restY + b.y : b.restX + b.x, fling: router.flingRaf !== 0 }; };
		const rows = [];
		let prev = {}, prevRep = 0, prevWork = {}, prevResizes = rig.resizes;
		const take = (phase, i) => {
			const cur = snapshot(), styles = {};
			for (const n in styleWrites) { styles[n] = styleWrites[n]; delete styleWrites[n]; }
			const work = {}; for (const k in rig.work) { const d = rig.work[k] - (prevWork[k] || 0); if (d) work[k] = d; }
			const n = rows.length;
			rows.push({ phase, i, n, t: performance.now(), raf: lastRaf, wc: rig.overlay.inkLayer.style.willChange + "|" + rig.sizer.style.willChange, canvases: delta(prev, cur), styles, repaints: rig.repaints - prevRep, work, vias: rig.vias.splice(0),
				pieces: rig.pieces.splice(0), syncs: rig.syncs.splice(0), resizes: rig.resizes - prevResizes, paints: rig.paints.splice(0) });
			performance.mark("fr:" + n);
			prev = cur; prevRep = rig.repaints; prevWork = { ...rig.work }; prevResizes = rig.resizes;
		};
		let held = null, springFrames = 0, ended = -1, pinchInfo = null, atLift = null;
		if (kind === "fling") {
			const finger = (type, d, buttons) => {
				const px = edge === "left" ? x0 + d : x0, py = edge === "top" ? y0 + d : y0;
				const e = { type, pointerType: "touch", pointerId: 951, isPrimary: true, clientX: px, clientY: py,
					pressure: buttons === 0 ? 0 : 0.5, buttons, button: 0, timeStamp: performance.now(), tiltX: 0, tiltY: 0,
					width: 0, height: 0, target: sd, preventDefault() {}, stopPropagation() {} };
				if (type === "pointerdown") router.pointerDown(e); else if (type === "pointermove") router.pointerMove(e); else router.pointerUpOrCancel(e);
			};
			spy.seen.clear(); spy.on = true; longTasks.length = 0;
			if (probe) clearScrollProbe();
			const t0 = performance.now();
			finger("pointerdown", 0, 1); take("down", 0);
			for (let i = 1; i <= (moves || 16); i++) { await new Promise(res => setTimeout(res, 16)); finger("pointermove", 30 * i, 1); take("drag", i); }
			held = { pull: edge === "top" ? router.overscrollPullY : router.overscrollPullX, engaged: !!router.assistEngaged };
			finger("pointerup", 30 * (moves || 16) + 30, 0);
			atLift = overlay.overscrollBounceReadout();
			take("lift", 0);
			var start = t0;
		} else {
			const cx = edge === "left" ? r.left + 60 : x0, cy = edge === "top" ? r.top + 60 : y0;
			const pinch = async (to, steps, cx2, cy2, tx, ty, phase) => {
				const from = overlay.pinchScaleNow, spread0 = 300, spread1 = 300 * to / from;
				const touch = (s, f) => { const c = cx2 + tx * f, py = cy2 + ty * f; router.touchPos.set(911, { x: c - s / 2, y: py }); router.touchPos.set(912, { x: c + s / 2, y: py }); };
				const ev = type => new PointerEvent(type, { pointerId: 912, pointerType: "touch" });
				touch(spread0, 0); router.beginPinch(ev("pointerdown"));
				for (let i = 1; i <= steps; i++) { touch(spread0 + (spread1 - spread0) * i / steps, i / steps); router.updatePinch(ev("pointermove")); await rendered(); if (phase) take(phase, i); }
				return () => { router.endPinch(ev("pointerup"), { x: cx2 + tx, y: cy2 + ty }); router.touchPos.clear(); };
			};
			// Spread out to 300 percent about the point near the edge, off the record, and let everything rest.
			const base = overlay.pinchScaleNow;
			const end1 = await pinch(3 * base, 30, cx, cy, 0, 0, null);
			end1();
			for (let j = 0; j < 90; j++) { await rendered(); if (j > 20 && !read().active) break; }
			await new Promise(res => setTimeout(res, 1200)); await settle(8);
			sd.scrollTop = Math.min(sd.scrollTop, 0); if (edge === "left") sd.scrollLeft = Math.min(sd.scrollLeft, 0);
			await settle(4);
			const scaleBefore = overlay.pinchScaleNow;
			spy.seen.clear(); spy.on = true; longTasks.length = 0;
			var start = performance.now();
			take("rest", 0);
			const travel = 120;
			const end2 = await pinch(base, 30, cx, cy, edge === "left" ? travel : 0, edge === "top" ? travel : 0, "pinch");
			held = { pull: edge === "top" ? router.overscrollPullY : router.overscrollPullX, engaged: !!router.assistEngaged };
			end2(); take("lift", 0);
			pinchInfo = { base, scaleBefore, scaleAfter: overlay.pinchScaleNow };
		}
		for (let j = 0; j < 120; j++) {
			await rendered();
			const f = read();
			if (f.active) { springFrames++; plantDraw(); }
			// A new gesture cancels a spring in the product (a contact cancels it first); the cell calls the same method.
			if (cancelAt && springFrames === cancelAt) { overlay.cancelOverscrollBounce(); take("cancel", j); break; }
			take(f.active ? "spring" : "after", j);
			if (springFrames > 0 && !f.active && !f.fling) { ended = j; break; }
		}
		for (let i = 0; i < 4; i++) { await rendered(); take("tail", i); }
		spy.on = false;
		const tasks = longTasks.slice();
		// The scroll probe's lines for the window (repaints with their from= and bake=, extent steps, repaint requests), when asked.
		const probeLines = probe ? formatScrollProbe().split("\\n").filter(l => /  (repaint|extent|sched)  /.test(l)) : null;
		await settle(4);
		return { edge, kind, held, atLift: atLift ? { x: atLift.x, y: atLift.y, restX: atLift.restX, restY: atLift.restY, active: atLift.active } : null, springFrames, ended, rest: read(), pinchInfo, start, tasks, rows, probeLines, backings: backings(), dpr: window.devicePixelRatio };
	},
	/**
	 * A pinch from the mounted zoom down to zoom "to" about the pane centre, released, then quietMs of nothing, with every whole
	 * repaint, the extent arm, the stand-in retry and the queued frame's pre-paint work logged against the clock of the pinch's start.
	 */
	async pinchLow(to, quietMs, waitBuild) {
		const { view, overlay } = rig, router = overlay.router, sd = view.scrollDOM;
		setPenInk(false);
		sd.scrollTop = 0; sd.scrollLeft = 0;
		await settle(8);
		await new Promise(res => setTimeout(res, 1200));
		await settle(4);
		let waitedMs = 0;
		if (waitBuild) { const w0 = performance.now(); while ((overlay.extentBuild || !overlay.extentRaster) && performance.now() - w0 < 60000) await new Promise(res => setTimeout(res, 100)); waitedMs = Math.round(performance.now() - w0); await settle(4); }
		const rasterBefore = !!overlay.extentRaster, buildBefore = !!overlay.extentBuild;
		const r = sd.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
		const T0 = performance.now(), at = () => Math.round((performance.now() - T0) * 10) / 10;
		const ev = [], strokesOf = () => inlineInk.strokes(rig.path);
		longTasks.length = 0; clearScrollProbe();
		const counts = { ext: 0, st: 0 };
		const cfe = overlay.copyFromExtent.bind(overlay); overlay.copyFromExtent = (...a) => { const ok = cfe(...a); if (ok) counts.ext++; return ok; };
		const cfs = overlay.copyFromStandIn.bind(overlay); overlay.copyFromStandIn = (...a) => { const ok = cfs(...a); if (ok) counts.st++; return ok; };
		let repN = 0, repIn = 0, prePaintMs = null;
		const rep = overlay.repaint.bind(overlay);
		overlay.repaint = () => { repN++; repIn = performance.now(); prePaintMs = null; performance.mark("lz:rep:" + repN); try { return rep(); } finally { ev.push({ t: at(), kind: "repaint-frame", n: repN, ms: Math.round((performance.now() - repIn) * 10) / 10, prePaintMs }); } };
		const ids = new WeakMap(); let idN = 0;
		const idOf = o => { if (!o) return null; let n = ids.get(o); if (!n) { n = ++idN; ids.set(o, n); } return n; };
		const strokeIds = () => { const path = overlay.filePath(), src = path ? inlineInk.strokes(path) : null, shown = path ? overlay.noteStrokes(path) : null; return { anchorsGen: overlay.lineAnchors.generation, srcId: idOf(src), shownId: idOf(shown), srcLen: src ? src.length : null }; };
		// Where the stand-in's copy puts the ink: the alpha-weighted centre of the committed layer, in device px, read a moment after the frame
		// that copied it (the stand-in stays until the retry), so the read is not inside the paint.
		let centroidDone = false;
		const centroidOf = canvas => {
			const w = canvas.width, h = canvas.height, d = canvas.getContext("2d").getImageData(0, 0, w, h).data;
			let sx = 0, sy = 0, m = 0;
			for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const a = d[(y * w + x) * 4 + 3]; if (a) { sx += a * x; sy += a * y; m += a; } }
			return { x: m ? sx / m : null, y: m ? sy / m : null, mass: m, w, h };
		};
		const pcw = overlay.paintCommittedWork.bind(overlay);
		overlay.paintCommittedWork = (cam, work, strokes) => {
			if (work === "all") {
				// The camera's move since the raster was built, in device px on the copy's grid: the copy needs both whole to 1e-3.
				const x = overlay.extentRaster, row = { t: at(), kind: "cam", frame: repN, camX: cam.x, camY: cam.y, zoom: cam.zoom, committedBacking: overlay.committedBacking, docTop: overlay.lastSyncDocumentTop, contentLeft: overlay.lastSyncContentLeft,
					bounce: !!overlay.bounceState, settling: !!overlay.previewPaperSettling, pinchHeld: overlay.pinchHeld(), rasterHeld: !!x, standInHeld: !!overlay.standIn, buildHeld: !!overlay.extentBuild, ...strokeIds(), rasterStrokesId: x ? idOf(x.strokes) : null, buildStrokesId: overlay.extentBuild ? idOf(overlay.extentBuild.strokes) : null };
				if (x) {
					const k = cam.zoom * x.backing, mx = (cam.x - x.cam0.x) * k, my = (cam.y - x.cam0.y) * k;
					Object.assign(row, { camX0: x.cam0.x, camY0: x.cam0.y, k, mx, my, fracX: mx - Math.round(mx), fracY: my - Math.round(my), wholeX: Math.abs(mx - Math.round(mx)) < 1e-3, wholeY: Math.abs(my - Math.round(my)) < 1e-3, rasterBacking: x.backing });
				}
				ev.push(row);
			}
			const e0 = counts.ext, s0 = counts.st, d0 = overlay.standInDeferrals, held = !!overlay.standIn, t0 = performance.now();
			if (prePaintMs === null) { prePaintMs = Math.round((t0 - repIn) * 10) / 10; performance.mark("lz:paint:" + repN); }
			try { return pcw(cam, work, strokes); } finally {
				const ms = Math.round((performance.now() - t0) * 10) / 10;
				const source = work !== "all" ? "strips" : counts.ext > e0 ? "raster" : counts.st > s0 ? "stand-in" : overlay.standInDeferrals > d0 ? "deferred" : "path";
				ev.push({ t: at(), kind: "paint", work: work === "all" ? "all" : "strips", source, ms, standInHeld: held, standInAfter: !!overlay.standIn, build: !!overlay.extentBuild, zoom: cam.zoom, frame: repN });
				if (work === "all" && source === "stand-in" && !centroidDone) { centroidDone = true; setTimeout(() => ev.push({ t: at(), kind: "stand-in-centroid", ...centroidOf(overlay.committedCanvas) }), 150); }
			}
		};
		const arm = overlay.armExtentBuild.bind(overlay);
		overlay.armExtentBuild = (cam, strokes, floor) => {
			let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
			for (const s of strokes) { const b = s.bbox; if (b.x < x0) x0 = b.x; if (b.y < y0) y0 = b.y; if (b.x + b.width > x1) x1 = b.x + b.width; if (b.y + b.height > y1) y1 = b.y + b.height; }
			const backing = overlay.committedBacking ?? 0, k = cam.zoom * backing;
			const w = Math.ceil((x1 - cam.x) * k) + 2 - (Math.floor((x0 - cam.x) * k) - 2), h = Math.ceil((y1 - cam.y) * k) + 2 - (Math.floor((y0 - cam.y) * k) - 2);
			const fits = extentRasterFits(w, h), held = overlay.standIn ? overlay.standIn.pen.width * overlay.standIn.pen.height * (overlay.standIn.hl ? 2 : 1) : 0;
			const hlStrokes = strokes.some(s => s.tool === "highlighter"), pairFits = held > 0 ? extentPairFits(w * h * (hlStrokes ? 2 : 1), held) : null;
			// Why the arm returns without a build, read from the same terms before the call.
			const buildPx = w * h * (hlStrokes ? 2 : 1), sIn = overlay.standIn, shrunkPx = sIn ? w * h * (sIn.hl ? 2 : 1) : 0, bb = overlay.extentBuild, fp = overlay.filePath();
			let reason;
			if (bb && bb.path === fp && bb.cam0.zoom === cam.zoom && bb.backing === backing && bb.dpr === overlay.dpr && bb.look === inkLookKey() && bb.strokes === strokes && bb.count === strokes.length && bb.generation === inlineInk.generation(fp)) reason = "same-build-kept";
			else if (!fp || !(backing > 0) || !(cam.zoom > 0) || strokes.length === 0) reason = "precondition";
			else if (!fits) reason = "raster-cap";
			else if (held > 0 && !pairFits) reason = !(shrunkPx < held) ? "pair-over-no-shrink-gain" : !extentPairFits(buildPx, shrunkPx) ? "pair-over-after-shrink" : "pair-over-shrunk-to-fit";
			else reason = "builds";
			arm(cam, strokes, floor);
			ev.push({ t: at(), kind: "arm", ...strokeIds(), reason, buildPx, shrunkPx, standInPxAfter: overlay.standIn ? overlay.standIn.pen.width * overlay.standIn.pen.height * (overlay.standIn.hl ? 2 : 1) : 0, zoom: cam.zoom, backing, dpr: overlay.dpr, w, h, px: w * h, mobile: !!Platform.isMobile, capPx: Platform.isMobile ? EXTENT_RASTER_MAX_PX_MOBILE : EXTENT_RASTER_MAX_PX_DESKTOP, pairCapPx: EXTENT_PAIR_FACTOR * (Platform.isMobile ? EXTENT_RASTER_MAX_PX_MOBILE : EXTENT_RASTER_MAX_PX_DESKTOP), fits, pairFits, standInPx: held, builds: !!overlay.extentBuild, repaintsBefore: repN });
		};
		const retry = overlay.retryStandInLater.bind(overlay); overlay.retryStandInLater = () => { ev.push({ t: at(), kind: "retry-armed" }); return retry(); };
		const ros = overlay.repaintOverStandIn.bind(overlay); overlay.repaintOverStandIn = () => { ev.push({ t: at(), kind: "retry-fired", standIn: !!overlay.standIn, build: !!overlay.extentBuild, raster: !!overlay.extentRaster }); return ros(); };
		const sched = overlay.scheduleRepaint.bind(overlay); overlay.scheduleRepaint = via => { ev.push({ t: at(), kind: "sched", via: via === undefined ? "other" : via }); return sched(via); };
		// Which term of extentBuildHolds failed, where a build is dropped, and which term refuses a finished raster.
		const ebh = overlay.extentBuildHolds.bind(overlay);
		overlay.extentBuildHolds = b => {
			const ok = ebh(b);
			if (!ok) {
				const path = overlay.filePath(), cam = overlay.lastPaintCam, now = path ? overlay.noteStrokes(path) : null;
				ev.push({ t: at(), kind: "holds-failed", terms: { path: path !== b.path, lastPaintCam: !cam, zoom: cam ? cam.zoom !== b.cam0.zoom : null, backing: overlay.committedBacking !== b.backing, dpr: overlay.dpr !== b.dpr, look: inkLookKey() !== b.look, identity: now !== b.strokes, count: now ? now.length !== b.count : null, generation: path ? inlineInk.generation(path) !== b.generation : null },
					vals: { camZoom: cam ? cam.zoom : null, buildZoom: b.cam0.zoom, backing: overlay.committedBacking, buildBacking: b.backing, strokes: now ? now.length : null, buildCount: b.count } });
			}
			return ok;
		};
		const deb = overlay.dropExtentBuild.bind(overlay);
		overlay.dropExtentBuild = () => { if (overlay.extentBuild) ev.push({ t: at(), kind: "build-dropped", from: new Error().stack.split("\\n").slice(2, 5).map(l => l.trim().replace(/^at /, "")).join(" < ") }); return deb(); };
		const ue = overlay.usableExtent.bind(overlay);
		overlay.usableExtent = (cam, strokes) => {
			const x = overlay.extentRaster, r = ue(cam, strokes);
			if (x && !r) ev.push({ t: at(), kind: "raster-refused", ...strokeIds(), rasterStrokesId: idOf(x.strokes), shownNowId: idOf(strokes), camZoom: cam.zoom, rasterZoom: x.cam0.zoom, backing: overlay.committedBacking, rasterBacking: x.backing, dprSame: x.dpr === overlay.dpr, lookSame: x.look === inkLookKey(), identity: x.strokes === strokes, count: strokes.length, rasterCount: x.count, generationSame: x.generation === inlineInk.generation(overlay.filePath()), hlPairDeferred: !!overlay.highlightPairDeferred });
			return r;
		};
		
		const from = overlay.pinchScaleNow, spread0 = 300, spread1 = 300 * to / from;
		const touch = s => { router.touchPos.set(911, { x: cx - s / 2, y: cy }); router.touchPos.set(912, { x: cx + s / 2, y: cy }); };
		const pev = type => new PointerEvent(type, { pointerId: 912, pointerType: "touch" });
		ev.push({ t: at(), kind: "pinch-start", from, ...strokeIds(), rasterStrokesId: overlay.extentRaster ? idOf(overlay.extentRaster.strokes) : null });
		touch(spread0); router.beginPinch(pev("pointerdown"));
		for (let i = 1; i <= 30; i++) { touch(spread0 + (spread1 - spread0) * i / 30); router.updatePinch(pev("pointermove")); await rendered(); }
		ev.push({ t: at(), kind: "pinch-release", scale: overlay.pinchScaleNow });
		router.endPinch(pev("pointerup"), { x: cx, y: cy }); router.touchPos.clear();
		const tRelease = at();
		await new Promise(res => setTimeout(res, quietMs));
		await settle(4);
		const lines = formatScrollProbe().split("\\n").filter(l => /  (repaint|extent|sched|settle)  |LONGTASK/.test(l));
		return { from, to, cssScaleAfter: overlay.cssScale, tRelease, events: ev, tasks: longTasks.map(t => ({ start: Math.round((t.start - T0) * 10) / 10, dur: Math.round(t.dur) })), probeLines: lines,
			standInAfter: !!overlay.standIn, buildAfter: !!overlay.extentBuild, rasterBefore, buildBefore, waitedMs, rasterAfter: !!overlay.extentRaster, backings: backings(), dpr: window.devicePixelRatio, strokes: strokesOf().length };
	},
};
`;

let browser: Browser, script: string;
const record: unknown[] = [];
beforeAll(async () => {
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "bounceMcbRigPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);
afterAll(async () => {
	await browser?.close();
	if (OUT) writeFileSync(OUT, JSON.stringify(record, null, 1));
});

type Counts = { draw: number; state: number; size: number; methods: Record<string, number> };
type Row = { phase: string; i: number; n: number; t: number; raf: number; wc: string; canvases: Record<string, Counts>; styles: Record<string, Record<string, number>>; repaints: number;
	work: Record<string, number>; vias: string[]; pieces: number[]; syncs: string[]; resizes: number; paints: { work: string; ms: number; strokes: number | null }[] };

/** The ink for a mount: the fixture, plus (HW_RIG_OVERCAP=1) one copy of its first stroke 80,000 note px down, so the ink's box is over the raster cap and the side limit at 0.11 and a device ratio of 2. */
function inkFor(overcap: boolean, highlighter = false): { sidecar: string; strokes: number } {
	if (!overcap && !highlighter) return { sidecar: INK, strokes: PARSED.strokes.length };
	const page = JSON.parse(INK) as { strokes: { id: string; tool: string; color: string; width: number; pts: number[] }[] };
	const first = page.strokes[0]!;
	if (overcap) page.strokes.push({ ...first, id: "00000000-0000-4000-8000-0000000000aa", pts: first.pts.map((v, i) => (i % 4 === 1 ? v + 80000 : v)) });
	// One highlighter stroke doubles the extent build and a held stand-in (a pen picture and a highlighter picture), as MCB EXAM 3's six do.
	if (highlighter) page.strokes.push({ ...first, id: "00000000-0000-4000-8000-0000000000bb", tool: "highlighter", color: "#ffd400", width: 14 });
	return { sidecar: JSON.stringify(page), strokes: page.strokes.length };
}

async function open(zoom: number, overcap = false, desktop = false, highlighter = false) {
	const page = await browser.newPage({ viewport: { width: 1800, height: 1000 }, deviceScaleFactor: DPR, hasTouch: true });
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	await page.setContent('<!doctype html><body class="theme-dark" style="margin:0; --font-text-size:19px; --background-modifier-border:#777777"></body>');
	await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
	await page.addStyleTag({ content: MINIMAL_CSS });
	await page.addScriptTag({ content: script });
	const mounted = await page.evaluate(([z, s, id, t, n, pr, d]) => (window as any).mcbRig.mount(z, s, id, t, n, pr, d), [zoom, inkFor(overcap, highlighter).sidecar, PARSED.pageId, TEXT, inkFor(overcap, highlighter).strokes, PROBE, desktop] as const) as any;
	return { page, errors, mounted };
}

const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const median = (a: number[]) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)]! : null; };
/** The compositor's events per frame: the trace's Canvas, Produce, Present and DrawFrame events, split by the frame marks the page wrote. */
function traceByFrame(buf: { toString(encoding: string): string }): Record<number, Record<string, number>> {
	const ev = (JSON.parse(buf.toString("utf8")).traceEvents ?? []) as { name?: string; ph?: string; ts?: number }[];
	const marks: { n: number; ts: number }[] = [];
	for (const e of ev) { const m = /^fr:(\d+)$/.exec(e.name ?? ""); if (m && e.ts !== undefined) marks.push({ n: Number(m[1]), ts: e.ts }); }
	marks.sort((a, b) => a.ts - b.ts);
	const out: Record<number, Record<string, number>> = {};
	for (const e of ev) {
		if (e.ph === "E" || e.ts === undefined || !/Canvas|Produce|Present|DrawFrame|RasterTask|UpdateLayers|LayerTree|BeginMainFrame|Commit/i.test(e.name ?? "")) continue;
		// The events that came after frame k's take belong to the next frame, whose mark is k + 1.
		let k = -1;
		for (let j = 0; j < marks.length && marks[j]!.ts <= e.ts; j++) k = j;
		if (k < 0 || k + 1 >= marks.length) continue;
		const n = marks[k + 1]!.n, o = out[n] ??= {};
		o[e.name!] = (o[e.name!] ?? 0) + 1;
	}
	return out;
}

/** Per spring frame: the rAF interval, transforms, canvas draws and size writes, extent pieces, first sync, resizes, paints, long tasks, compositor events. */
function summarize(r: any, byFrame: Record<number, Record<string, number>> | null) {
	const rows = r.rows as Row[], spring: any[] = [];
	for (let k = 0; k < rows.length; k++) {
		const row = rows[k]!;
		if (row.phase !== "spring") continue;
		const prev = rows[k - 1]!;
		const dirt: Record<string, number> = {};
		for (const [n, c] of Object.entries(row.canvases)) if (c.draw + c.size > 0) dirt[n] = c.draw + c.size;
		const transforms: Record<string, number> = {};
		for (const [n, props] of Object.entries(row.styles)) if (props.transform) transforms[n] = props.transform;
		const styleWrites = Object.values(row.styles).reduce((a, o) => a + Object.values(o).reduce((b, n) => b + n, 0), 0);
		const tasks = (r.tasks as { start: number; dur: number }[]).filter(t => t.start > prev.t && t.start <= row.t);
		const comp = byFrame ? byFrame[row.n] ?? {} : null;
		spring.push({ i: row.i, n: row.n, rafMs: row.raf && prev.raf ? round(row.raf - prev.raf) : null, taskMs: round(row.t - prev.t), transforms, styleWrites, dirty: dirt,
			pieces: row.pieces.length, pieceMs: round(row.pieces.reduce((a, b) => a + b, 0)), firstSync: row.syncs[0] ?? "none", syncs: row.syncs, resizes: row.resizes,
			repaints: row.repaints, paints: row.paints.map(p => `${p.work} ${round(p.ms)} ms`), longTasks: tasks.length, longestTaskMs: tasks.length ? Math.round(Math.max(...tasks.map(t => t.dur))) : 0,
			compositor: comp, resources: comp ? Object.values(comp).reduce((a, b) => a + b, 0) : null });
	}
	const raf = spring.map(s => s.rafMs).filter((x): x is number => x !== null);
	const endRepaints = rows.filter(row => (row.phase === "spring" || row.phase === "after" || row.phase === "tail") && row.paints.length).flatMap(row => row.paints.map(p => `${row.phase} ${row.i}: ${p.work} ${round(p.ms)} ms`));
	return { springFrames: spring.length, rafMedian: median(raf), rafMax: raf.length ? Math.max(...raf) : null,
		piecesPerFrame: round(spring.reduce((a, s) => a + s.pieces, 0) / Math.max(1, spring.length), 2), pieceMsTotal: round(spring.reduce((a, s) => a + s.pieceMs, 0)),
		resourcesPerFrameMedian: byFrame ? median(spring.map(s => s.resources ?? 0)) : null, resourcesPerFrameMax: byFrame ? Math.max(0, ...spring.map(s => s.resources ?? 0)) : null,
		firstSyncFrame0: spring[0]?.firstSync ?? null, firstSyncs: [...new Set(spring.map(s => s.firstSync))], resizesInSpring: spring.reduce((a, s) => a + s.resizes, 0),
		dirtyFrames: spring.filter(s => Object.keys(s.dirty).length).length, repaintsInSpring: spring.reduce((a, s) => a + s.repaints, 0), endRepaints,
		longTasks: spring.reduce((a, s) => a + s.longTasks, 0), longestTaskMs: Math.max(0, ...spring.map(s => s.longestTaskMs)), frames: spring };
}

const DRIVES = [
	{ name: "fling top", edge: "top", kind: "fling" },
	{ name: "fling left", edge: "left", kind: "fling" },
	{ name: "pinch release top", edge: "top", kind: "pinch" },
	{ name: "pinch release left", edge: "left", kind: "pinch" },
] as const;
for (const zoom of ZOOMS) for (const d of DRIVES.filter(x => ONLY.length === 0 || ONLY.includes(x.name))) {
	it.skipIf(!HAVE)(`MCB EXAM 3, zoom ${zoom}, ${d.name}${WILLCHANGE ? ", will-change on" : ""}${TRACE ? ", traced" : ""}: counts per spring frame`, async () => {
		const { page, errors, mounted } = await open(zoom);
		try {
			if (TRACE) await browser.startTracing(page, { categories: ["blink", "blink.user_timing", "cc", "gpu", "viz", "disabled-by-default-devtools.timeline"] });
			const r = await page.evaluate(([e, k, w]) => (window as any).mcbRig.drive(e, k, null, w, MOVES, PROBE), [d.edge, d.kind, WILLCHANGE] as const) as any;
			const traceBuf = TRACE ? await browser.stopTracing() : null;
			// The raw trace beside the JSON (HW_RIG_TRACEDIR): the table is a reading of it, not a substitute.
			if (traceBuf && process.env.HW_RIG_TRACEDIR) writeFileSync(`${process.env.HW_RIG_TRACEDIR}/trace-${WILLCHANGE ? "B" : "A"}-z${zoom}-${d.name.replace(/ /g, "-")}.json`, traceBuf.toString("utf8"));
			const byFrame = traceBuf ? traceByFrame(traceBuf) : null;
			const s = summarize(r, byFrame);
			record.push({ cell: "rig", zoom, drive: d.name, willChange: WILLCHANGE, traced: TRACE, dpr: DPR, mounted, held: r.held, pinchInfo: r.pinchInfo, springFrames: r.springFrames, ended: r.ended,
				rest: r.rest, atLift: r.atLift, probe: PROBE, moves: MOVES, probeLines: r.probeLines, backings: r.backings, summary: s, tasks: r.tasks, rows: r.rows });
			console.log(`MCB-RIG zoom ${zoom} ${d.name} ${JSON.stringify({ springFrames: s.springFrames, rafMedian: s.rafMedian, rafMax: s.rafMax, pieces: s.piecesPerFrame, resources: s.resourcesPerFrameMedian, firstSync: s.firstSyncFrame0, dirtyFrames: s.dirtyFrames, repaints: s.repaintsInSpring })}`);
			expect(errors).toEqual([]);
			// PREMISES: every stroke loaded, Infinite Canvas on, the gesture pulled past the edge, a spring played and the page came home.
			expect(mounted.strokes, "premise: every stroke loaded").toBe(PARSED.strokes.length);
			expect(mounted.canvasMode, "premise: Infinite Canvas on").toBe(true);
			expect(mounted.dpr, "premise: the device ratio").toBeCloseTo(DPR, 3);
			if (zoom !== 1) expect(mounted.cssScale, "premise: the note is at the cell's zoom").toBeCloseTo(zoom, 2);
			// A fling pulls against the edge by the finger; a pinch has no pull, its spring starts from the page left past the edge.
			if (d.kind === "fling") expect(Math.abs(r.held.pull), "premise: the finger pulled against the edge").toBeGreaterThan(10);
			else expect(Math.abs(r.pinchInfo.scaleBefore - r.pinchInfo.scaleAfter), "premise: the pinch changed the zoom").toBeGreaterThan(r.pinchInfo.base);
			expect(r.springFrames, "premise: a spring played at least three frames").toBeGreaterThanOrEqual(3);
			expect(r.ended, "premise: the spring ended").toBeGreaterThanOrEqual(0);
			expect(Math.abs(r.rest.total), "premise: the page came home").toBeLessThanOrEqual(0.5);
		} finally { await page.close(); }
	}, 900_000);
}

/** The claim cells: a traced fling at 100 percent with nothing set from the cell. cancelAt: spring frames to play before a new gesture cuts it. */
async function claimRun(edge: "top" | "left", cancelAt: number) {
	const { page, errors, mounted } = await open(1);
	try {
		await browser.startTracing(page, { categories: ["blink", "blink.user_timing", "cc", "gpu", "viz", "disabled-by-default-devtools.timeline"] });
		const r = await page.evaluate(([e, c]) => (window as any).mcbRig.drive(e, "fling", null, false, 16, false, c), [edge, cancelAt] as const) as any;
		const traceBuf = await browser.stopTracing();
		const s = summarize(r, traceByFrame(traceBuf));
		expect(errors).toEqual([]);
		expect(mounted.strokes, "premise: every stroke loaded").toBe(PARSED.strokes.length);
		expect(mounted.canvasMode, "premise: Infinite Canvas on").toBe(true);
		expect(Math.abs(r.held.pull), "premise: the finger pulled against the edge").toBeGreaterThan(10);
		return { r, s, rows: r.rows as Row[] };
	} finally { await page.close(); }
}
const wcOf = (rows: Row[], phase: (p: string) => boolean) => rows.filter(row => phase(row.phase)).map(row => row.wc);

for (const edge of ["top", "left"] as const) {
	it.skipIf(!HAVE)(`claim: the ${edge} fling's spring runs no raster task and no tile-state change after its second frame, and the ink layer and sizer are marked moving for it only`, async () => {
		const { r, s, rows } = await claimRun(edge, 0);
		record.push({ cell: "claim", edge, springFrames: r.springFrames, summary: s });
		expect(r.springFrames, "premise: a spring played at least five frames").toBeGreaterThanOrEqual(5);
		expect(r.ended, "premise: the spring ended").toBeGreaterThanOrEqual(0);
		// Marking the layers moving rasters them once, in the spring's second frame; from the third on the compositor only moves them.
		const count = (frames: any[], name: string) => frames.reduce((a: number, f: any) => a + (f.compositor[name] ?? 0), 0);
		expect(count(s.frames.slice(2), "RasterTask"), "RasterTask on spring frames 2 on").toBe(0);
		expect(count(s.frames.slice(2), "LayerTreeHostImpl::NotifyTileStateChanged"), "tile-state changes on spring frames 2 on").toBe(0);
		expect(count(s.frames.slice(0, 2), "RasterTask"), "the one raster of marking the layers moving").toBeLessThanOrEqual(2);
		expect(s.frames.some((f: any) => Object.keys(f.compositor).length > 0), "premise: the trace saw compositor events").toBe(true);
		expect(new Set(wcOf(rows, p => p === "spring")), "will-change on both elements on every spring frame").toEqual(new Set(["transform|transform"]));
		expect(new Set(wcOf(rows, p => p === "after" || p === "tail")), "will-change off both elements after the spring").toEqual(new Set(["|"]));
	}, 900_000);
}

it.skipIf(!HAVE)("claim: a gesture that cancels the top fling's spring takes will-change off the ink layer and the sizer", async () => {
	const { r, rows } = await claimRun("top", 3);
	expect(r.springFrames, "premise: the spring played until the cell cancelled it").toBe(3);
	expect(new Set(wcOf(rows, p => p === "spring")), "will-change on both elements while the spring played").toEqual(new Set(["transform|transform"]));
	expect(new Set(wcOf(rows, p => p === "cancel" || p === "tail")), "will-change off both elements after the cancel").toEqual(new Set(["|"]));
}, 900_000);

/**
 * THE REPEAT ARM (HW_RIG_REPEAT=n, n >= 1; off otherwise): n flings into one edge on ONE page at the zoom of HW_RIG_ZOOMS, each
 * a fling, the spring home, then the next. Per fling the record is the lift's overshoot, the band result and paints per frame
 * from the lift to four frames after the spring, the probe's repaint lines (from= and bake=, with HW_RIG_PROBE=1), the canvas
 * size writes, the long tasks and the frame intervals. Untraced. Asserts only its premises.
 */
const REPEAT = Number(process.env.HW_RIG_REPEAT ?? "0");
for (const zoom of ZOOMS) for (const edge of ["top", "left"] as const) {
	it.skipIf(!HAVE || REPEAT < 1)(`repeat: MCB EXAM 3, zoom ${zoom}, ${REPEAT} flings into the ${edge} edge on one page`, async () => {
		const { page, errors, mounted } = await open(zoom);
		try {
			const reps: unknown[] = [];
			for (let k = 0; k < REPEAT; k++) {
				const r = await page.evaluate(([e, mv, pr]) => (window as any).mcbRig.drive(e, "fling", null, false, mv, pr), [edge, MOVES, PROBE] as const) as any;
				const s = summarize(r, null);
				reps.push({ rep: k, held: r.held, atLift: r.atLift, springFrames: r.springFrames, ended: r.ended, rest: r.rest, summary: s, probeLines: r.probeLines, tasks: r.tasks, rows: r.rows });
				console.log(`MCB-REPEAT zoom ${zoom} ${edge} #${k} ${JSON.stringify({ lift: r.atLift && [r.atLift.x, r.atLift.y], springFrames: r.springFrames, firstSync: s.firstSyncs, repaints: s.repaintsInSpring, endRepaints: s.endRepaints, longTasks: s.longTasks, rafMax: s.rafMax })}`);
				expect(r.springFrames, `premise: fling ${k} played a spring`).toBeGreaterThanOrEqual(3);
				expect(r.ended, `premise: fling ${k}'s spring ended`).toBeGreaterThanOrEqual(0);
				expect(Math.abs(r.rest.total), `premise: fling ${k}'s page came home`).toBeLessThanOrEqual(0.5);
			}
			record.push({ cell: "repeat", zoom, edge, dpr: DPR, mounted, probe: PROBE, moves: MOVES, reps });
			expect(errors).toEqual([]);
			expect(mounted.cssScale, "premise: the note is at the cell's zoom").toBeCloseTo(zoom, 2);
		} finally { await page.close(); }
	}, 900_000);
}

/**
 * THE LOW-ZOOM PINCH ARM (HW_RIG_PINCHLOW=1; HW_RIG_FROM, HW_RIG_TO default 0.26, 0.11; HW_RIG_OVERCAP=1 plants an over-cap ink box): a
 * pinch from the mounted zoom to the target about the pane centre, released, then three seconds of nothing, diagnostics on.
 * Recorded against the pinch's clock: each extent arm (the box w by h in device px, whether it fits the cap, whether a build
 * started), the stand-in retry (armed, fired), every committed paint with its kind (strips or whole), source (raster, stand-in,
 * path, deferred) and ms, each queued frame's ms and its pre-paint ms (repaint entry to the first committed paint, with a
 * performance mark at each), and the long tasks. HW_RIG_DESKTOP=1 sets Platform.isMobile false (the stub is an iPhone, with an 8 million
 * px raster cap), so the cap is the desktop 20 million. Premises only; the reading goes in a file.
 */
const PINCHLOW = process.env.HW_RIG_PINCHLOW === "1", OVERCAP = process.env.HW_RIG_OVERCAP === "1";
const LOW_FROM = Number(process.env.HW_RIG_FROM ?? "0.26"), LOW_TO = Number(process.env.HW_RIG_TO ?? "0.11"), DESKTOP = process.env.HW_RIG_DESKTOP === "1";
it.skipIf(!HAVE || !PINCHLOW)(`lowzoom: MCB EXAM 3${DESKTOP ? " on a desktop" : ""}${OVERCAP ? " with an over-cap ink box" : ""}, pinch ${LOW_FROM} to ${LOW_TO}, three seconds quiet`, async () => {
	const { page, errors, mounted } = await open(LOW_FROM, OVERCAP, DESKTOP);
	try {
		const r = await page.evaluate(([to, q]) => (window as any).mcbRig.pinchLow(to, q), [LOW_TO, 3000] as const) as any;
		const events = r.events as { kind: string; t: number; [k: string]: unknown }[];
		const paints = events.filter(e => e.kind === "paint" && e.work === "all"), arms = events.filter(e => e.kind === "arm");
		record.push({ cell: "lowzoom", desktop: DESKTOP, overcap: OVERCAP, from: LOW_FROM, to: LOW_TO, dpr: DPR, mounted, result: r });
		console.log(`MCB-LOWZOOM overcap ${OVERCAP} ${JSON.stringify({ cssScaleAfter: r.cssScaleAfter, arms: arms.map(a => ({ t: a.t, zoom: a.zoom, w: a.w, h: a.h, fits: a.fits, builds: a.builds })), wholePaints: paints.map(p => `${p.t} ${p.source} ${p.ms} ms`), retry: events.filter(e => e.kind.startsWith("retry")).map(e => `${e.t} ${e.kind}`), longTasks: r.tasks })}`);
		expect(errors).toEqual([]);
		expect(mounted.strokes, "premise: every stroke loaded").toBe(inkFor(OVERCAP).strokes);
		expect(mounted.canvasMode, "premise: Infinite Canvas on").toBe(true);
		expect(mounted.cssScale, "premise: the note is at the start zoom").toBeCloseTo(LOW_FROM, 2);
		expect(r.cssScaleAfter, "premise: the pinch settled at the target zoom").toBeCloseTo(LOW_TO, 2);
	} finally { await page.close(); }
}, 900_000);

/**
 * THE PAIR-CAP ARM (HW_RIG_PAIR=1, desktop caps, HW_RIG_FROM / HW_RIG_TO default 0.1734 / 0.1095): the note mounted at the start zoom with the
 * extent build left to finish, then a pinch to the target, a lift and three seconds of nothing, diagnostics on. With one highlighter stroke added
 * the build and a held stand-in both double: the stand-in the lift holds is the whole raster's pen and highlighter pictures, and the pair may not
 * fit the pair cap. The claim: the held stand-in is cut down to the build's grid, the build runs, the whole repaints in the pinch's settle copy the
 * stand-in and none paints by path, and the sharp raster is copied in at the end. The control, the note as it is, builds as before.
 * Measured band on MCB EXAM 3 with the highlighter stroke (build 2 x w x h plus the shrunk stand-in 2 x w x h against the 32 million pair cap): the shrink
 * holds at 0.112 and refuses at 0.116, the square-law estimate from this arm's box being 0.1137. Past it the whole repaint paints by path as before.
 */
const PAIR = process.env.HW_RIG_PAIR === "1";
// HW_RIG_DIAG=1: record the arm's reasons and the build's fate and skip the outcome assertions, for targets where the fix is expected to refuse.
const DIAG = process.env.HW_RIG_DIAG === "1";
// The ink's centre after the stand-in copy, per arm, so the control's can be held against the highlighter arm's (the shrunk picture's placement).
const CENTROIDS: Record<string, { x: number; y: number; mass: number }> = {};
for (const highlighter of [true, false]) {
	it.skipIf(!HAVE || !PAIR)(`pair: MCB EXAM 3${highlighter ? " plus one highlighter stroke" : " (control)"}, settled at ${process.env.HW_RIG_FROM ?? "0.1734"} with the build whole, pinch to ${process.env.HW_RIG_TO ?? "0.1095"}, three seconds quiet`, async () => {
		const from = Number(process.env.HW_RIG_FROM ?? "0.1734"), to = Number(process.env.HW_RIG_TO ?? "0.1095");
		const { page, errors, mounted } = await open(from, false, true, highlighter);
		try {
			const r = await page.evaluate(([t, q]) => (window as any).mcbRig.pinchLow(t, q, true), [to, 3000] as const) as any;
			const events = r.events as { kind: string; t: number; [k: string]: unknown }[];
			record.push({ cell: "pair", highlighter, from, to, dpr: DPR, mounted, result: r });
			const whole = events.filter(e => e.kind === "paint" && e.work === "all");
			const arms = events.filter(e => e.kind === "arm");
			// The shrunk pair (the build plus a stand-in cut to the build's grid) grows with the square of the zoom: the zoom where it first passes the pair cap.
			const failScale = arms.map(a => to * Math.sqrt(Number(a.pairCapPx) / (Number(a.px) * ((highlighter ? 2 : 1) + (highlighter ? 2 : 1)))));
			console.log(`MCB-PAIR highlighter ${highlighter} ${JSON.stringify({ rasterBefore: r.rasterBefore, waitedMs: r.waitedMs, arms, shrunkPairFailsAboveZoom: failScale, whole: whole.map(p => `${p.t} ${p.source} ${p.ms} ms`), retry: events.filter(e => e.kind.startsWith("retry")).map(e => `${e.t} ${e.kind}`), longTasks: r.tasks })}`);
			expect(errors).toEqual([]);
			expect(mounted.strokes, "premise: every stroke loaded").toBe(inkFor(false, highlighter).strokes);
			expect(mounted.canvasMode, "premise: Infinite Canvas on").toBe(true);
			expect(mounted.cssScale, "premise: the note is at the start zoom").toBeCloseTo(from, 2);
			expect(r.rasterBefore, "premise: the extent raster is whole before the pinch").toBe(true);
			expect(r.cssScaleAfter, "premise: the pinch settled at the target zoom").toBeCloseTo(to, 2);
			const after = whole.filter(e => e.t >= (r.tRelease as number) - 500).map(e => e.source as string);
			const cen = events.find(e => e.kind === "stand-in-centroid") as { x: number; y: number; mass: number } | undefined;
			if (!DIAG) {
				expect(cen, "premise: a whole repaint copied the stand-in and its centre was read").toBeDefined();
				expect(cen!.mass, "premise: the copy put ink on the layer").toBeGreaterThan(0);
				CENTROIDS[highlighter ? "highlighter" : "control"] = cen!;
				const hl = CENTROIDS.highlighter, ctl = CENTROIDS.control;
				if (hl && ctl) expect(Math.hypot(hl.x - ctl.x, hl.y - ctl.y), `the shrunk stand-in's copy lands where the control's lands (centres ${hl.x}, ${hl.y} and ${ctl.x}, ${ctl.y})`).toBeLessThanOrEqual(1);
				expect(after, "no whole repaint after the pinch paints by path").not.toContain("path");
				expect(after, "the pinch's whole repaint copies the stand-in").toContain("stand-in");
				expect(r.rasterAfter, "the note ends with the sharp raster").toBe(true);
				expect(arms.some(a => a.builds), "a build was armed").toBe(true);
			}
		} finally { await page.close(); }
	}, 900_000);
}

it.skipIf(!HAVE)("control: a clearRect planted on the committed canvas every spring frame of the top fling is counted against it on every spring frame", async () => {
	const { page, errors } = await open(1);
	try {
		const r = await page.evaluate(() => (window as any).mcbRig.drive("top", "fling", "committed", false)) as any;
		const s = summarize(r, null);
		record.push({ cell: "control", springFrames: r.springFrames, summary: s });
		expect(errors).toEqual([]);
		expect(r.springFrames, "premise: a spring played").toBeGreaterThanOrEqual(3);
		const planted = s.frames.filter((f: any) => (f.dirty.committed ?? 0) > 0).length;
		expect(planted, "the planted draw is counted against the committed canvas on every spring frame").toBeGreaterThanOrEqual(r.springFrames);
	} finally { await page.close(); }
}, 900_000);
