/**
 * WHAT INSERT SPACE COSTS ON ALAN'S HEAVY NOTE: HOVER, DRAG AND RELEASE, MEASURED SEPARATELY.
 *
 * What it looks like: on Orion (vault test 2, note "MCB EXAM 3", 28555 strokes, 886592 points, Infinite Canvas on by
 * frontmatter) Insert Space is very slow while the pen hovers, while it drags, and after it lifts.
 *
 * It mounts the note's real sidecar (a copy of the vault file, read from HW_ISL_SIDECAR; 25 MB, so it is not checked in)
 * with the note's own text, canvas on, Alan's font 19 against the page's fontRefPx 19, the Minimal theme, at device pixel
 * ratio 1.8257 (Orion's page zoom). The control arm is the same rig with the note's first 15 strokes only.
 * Every pen event goes through the real router as a PointerEvent. Each phase is timed separately:
 *   hover-still  20 pen hovers at one point, 16 ms apart (the warm, same-y hover);
 *   hover-sweep  30 pen hovers moving down 6 css px each, 16 ms apart (crossing rows, so the preview changes);
 *   drag         pen down, then 30 moves of 4 css px each, 16 ms apart;
 *   release      pen up, then frames until no plugin frame callback has run for 10 frames (cap 90);
 *   rows-shift   the task after the release paint that shifts the cached rows by the drag (one frame of its own);
 *   hover-after  10 pen hovers below the lift point after the commit (the ink changed; before the rows shift, the rows cache was cold again).
 *   HW_ISL_SHIFT=before holds that task until the hovers are done, so the first hover pays the shift in its own frame.
 * Before recording, a warm-up (hovers and a pen down and up in place, 300 css px above) runs the code once.
 * The deferred save (the host's page write) is held and timed once on its own, after the release: serializePage of the
 * page the store handed over, the whole-page work the real PageStore does on its timer.
 *
 * Per frame it reads the plugin's own work: every requestAnimationFrame callback of that frame (grouped by the frame's
 * timestamp) plus every pen event handler that ran since the frame before. Inside that it names where the time went:
 * repaint, paintCommittedWork, redrawSelectionUI, previewSpace, planSpace, the rows cache, moveLive, spaceDown, spaceUp,
 * updateExtent, stroke index rebuilds, inlineInk.moveStrokes and inlineInk.save.
 *
 * THE CLAIM (the ScrollCost family's budget, test/render/ScrollCost.test.ts: a repaint takes at most 2 ms; this cell does
 * not move the band): every frame's plugin work, in every phase, is at most 2 ms. The control arm shows the rig can pass it.
 *
 * Run: HW_INSERT_SPACE_LAG=1 HW_ISL_SIDECAR=<copy of the vault sidecar> npx vitest run --config vitest.render.mts
 *   test/render/InsertSpaceLag.test.ts. HW_ISL_OUT=<file> writes every arm's frames as JSON. HW_ISL_ARMS=heavy,control.
 *   HW_ISL_ROUNDS=<n> runs every arm n times, each on a fresh page. HW_ISL_PIXELS=1 runs the pixel oracle instead: the
 *   committed canvas hashed after each drag move, the release and the hovers after, for comparing two builds; and each
 *   shot against a whole repaint of the same state in the same build (the truth), which every shot must equal. The record
 *   names the path each partial repaint took: drawn (drawRegion), copied from the extent raster, or from the stand-in.
 *   HW_ISL_ZOOM=<k> (default 1, which changes nothing) pinches the note to zoom k after mounting and, after the hovers that
 *   follow the release, waits for any extent raster build to finish and pans down three times, recording per pan which path
 *   its repaints took and its frames (phase "pan"). Below 100 percent a pan copies its exposed band from the extent raster
 *   when one holds; the release used to be the whole repaint that armed a new one after the drag dropped the old.
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

const SIDECAR_PATH = process.env.HW_ISL_SIDECAR ?? "";
const ENABLED = process.env.HW_INSERT_SPACE_LAG === "1" && existsSync(SIDECAR_PATH);
const PAGE_ID = "cf77b392-e4c0-47b3-b87a-b9583f5884cb";
/** The note's text below its frontmatter, as in the vault file. */
const NOTE_TEXT = "\nare\n\nis valau/cave";
const DPR = Number(process.env.HW_ISL_DPR ?? "1.8257");
const MINIMAL_CSS = readFileSync(fileURLToPath(new URL("./fixtures/minimal-9.0.2-theme.css", import.meta.url)), "utf8");

const PAGE = `
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { Platform } from "obsidian";
import { inlineInk, inkOverlayExtension, overlayForPath, setScrollExpansionEnabled, setInlineTool, setInlineSpaceMode } from "../../src/inline/InkOverlay";
import { InsertSpaceRows } from "../../src/inline/InsertSpace";
import { setPenInk } from "../../src/inline/PenInk";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField } from "./iphoneObsidianStub";
import { parsePage, serializePage } from "../../src/model/PageData";

installObsidianDom();
Object.assign(Platform, { isMobile: false, isDesktop: true, isIosApp: false, isAndroidApp: false, isDesktopApp: true, isMobileApp: false, isPhone: false, isTablet: false, isWin: true });

// The host holds what the store hands it; the write (serializePage) is timed once, after the release, on its own.
const ids = new Map(), sidecars = new Map(), pending = new Map();
inlineInk.attachHost({ readPageId: p => ids.get(p) ?? null, claimId: async (p, id) => { ids.set(p, id); return { pageId: id }; },
	loadSidecar: async id => (sidecars.has(id) ? parsePage(sidecars.get(id), id) : null),
	scheduleSidecar: (id, page) => { pending.set(id, page); }, scheduleSidecarNow: async (id, page) => { pending.set(id, page); }, notify: () => {} });

// Frame callbacks, timed. The test's own waits use the original.
const rawRaf = window.requestAnimationFrame.bind(window);
let phase = "mount", recording = false, inRaf = 0;
const frames = new Map(); // frame timestamp -> { phase, rafMs, callbacks }; a queued rows shift's task gets a "rows-shift" entry of its own
const events = [];        // pen handler runs: { phase, type, t, ms }
window.requestAnimationFrame = function (cb) {
	return rawRaf(ts => {
		const t0 = performance.now();
		inRaf++;
		try { return cb(ts); } finally {
			inRaf--;
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
const heldTasks = [];
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await frame(); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PANE_W = 1397.5, PANE_H = 800, HOST_LEFT = 300;
let rig = null;

function installSizer(view) {
	const sizer = document.createElement("div"); sizer.className = "cm-sizer";
	const container = document.createElement("div"); container.className = "cm-contentContainer";
	view.contentDOM.parentElement.insertBefore(sizer, view.contentDOM); sizer.appendChild(container); container.appendChild(view.contentDOM);
	void view.scrollDOM.clientWidth; return sizer;
}

// Named work inside the frames: wrapped once, totals per phase and the slowest single call.
const work = {};
// The hover sweep's previews, kept by reference while recording and compared after the run, outside any frame.
const sweepPreviews = [];
// Inside the pen-up event's dispatch (run).
let inPenUp = 0;
const sameList = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);
// A preview built with no prior preview to reuse (set in mount).
let freshPreview = null;
const timeOn = (obj, name, key) => {
	const orig = obj[name];
	if (typeof orig !== "function") throw new Error("no method " + key);
	obj[name] = function (...a) {
		const t0 = performance.now();
		try { return orig.apply(this, a); } finally {
			if (recording) {
				const ms = performance.now() - t0, k = phase + ":" + key;
				const w = work[k] ??= { n: 0, ms: 0, max: 0 };
				w.n++; w.ms += ms; w.max = Math.max(w.max, ms);
			}
		}
	};
};

window.spaceLag = {
	async mount(arm, sidecar, pageId, text, zoom) {
		setPenInk(true); setScrollExpansionEnabled(true); setInlineTool("pen");
		const path = "MCB EXAM 3.md";
		let data = sidecar;
		// The control: 15 of the note's strokes from the region the gesture works in (below the seam, inside the pane), so they move.
		if (arm === "control") { const d = JSON.parse(sidecar); d.strokes = d.strokes.filter(s => s.pts[1] >= 1500 && s.pts[1] < 1700 && s.pts[0] < 1300).slice(0, 15); data = JSON.stringify(d); }
		sidecars.set(pageId, data); ids.set(path, pageId);
		const pane = document.body.appendChild(document.createElement("div"));
		pane.className = "markdown-source-view mod-cm6";
		pane.style.cssText = "position:relative;margin-left:" + (HOST_LEFT + 1 / 3) + "px;margin-top:77.5px;width:" + PANE_W + "px;height:" + PANE_H + "px;overflow:hidden";
		document.body.classList.add("handwriting-paper-lines");
		const view = new EditorView({ parent: pane, state: EditorState.create({ doc: text, extensions: [history(), EditorView.lineWrapping,
			editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} })), inkOverlayExtension(),
			EditorView.theme({ "&": { width: PANE_W + "px", height: PANE_H + "px" }, ".cm-scroller": { overflowY: "auto", overflowX: "hidden" } })] }) });
		installSizer(view);
		for (let i = 0; i < 200 && inlineInk.strokes(path).length === 0; i++) await settle(2);
		await settle(12);
		const overlay = overlayForPath(path);
		if (!overlay) throw new Error("no overlay for " + path);
		rig = { pane, view, overlay, path, pageId };
		overlay.updateExtent(true);
		await settle(12);
		// HW_ISL_ZOOM: pinch to the zoom about the pane's middle, then let the extent raster build (it builds after a whole repaint
		// below 100 percent, in pieces on later tasks).
		if (zoom !== 1) {
			const r = view.scrollDOM.getBoundingClientRect(), focal = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
			overlay.pinch("start", 1, focal); overlay.pinch("move", zoom, focal); overlay.pinch("end", zoom, focal);
			await settle(14); await sleep(400); await settle(8);
			for (let i = 0; i < 400 && overlay.extentBuild; i++) await sleep(25);
			await settle(4);
		}
		for (const k of ["repaint", "paintCommittedWork", "redrawSelectionUI", "previewSpace", "planSpace", "moveLive", "spaceDown", "spaceMove", "spaceUp", "spaceTextChange", "updateExtent", "showPenCursor"]) timeOn(overlay, k, k);
		timeOn(view, "dispatch", "dispatch");
		const preview = overlay.previewSpace;
		overlay.previewSpace = function (...a) {
			const p = preview.apply(this, a);
			if (recording && phase === "hover-sweep") sweepPreviews.push(p);
			return p;
		};
		// Preview stroke asks that drew nothing (the stroke is off screen), and the preview draw list builds where the build has its own name.
		const spaceAsk = overlay.tail.drawSpaceStroke;
		overlay.tail.drawSpaceStroke = function (...a) {
			const ok = spaceAsk.apply(this, a);
			if (recording && !ok) (work[phase + ":tailStrokeOff"] ??= { n: 0, ms: 0, max: 0 }).n++;
			return ok;
		};
		if (overlay.buildSpaceDrawItems) timeOn(overlay, "buildSpaceDrawItems", "buildSpaceDrawItems");
		freshPreview = (plan, rows) => {
			const keep = overlay.spacePreview;
			overlay.spacePreview = null;
			try { return preview.call(overlay, plan, rows); } finally { overlay.spacePreview = keep; }
		};
		// The tail layer's backing resizes that change its size (a canvas reallocation): in the shrink task after a release
		// ("tailShrinkResize") or anywhere else ("tailResize"). The shrink task gets a "tail-shrink" frame of its own.
		let inTailShrink = 0;
		const resize = overlay.tail.resizeBacking;
		overlay.tail.resizeBacking = function (width, height, ...a) {
			const changed = this.canvas.width !== width || this.canvas.height !== height, t0 = performance.now();
			try { return resize.call(this, width, height, ...a); } finally {
				if (recording && changed) {
					const ms = performance.now() - t0, w = work[phase + (inTailShrink ? ":tailShrinkResize" : ":tailResize")] ??= { n: 0, ms: 0, max: 0 };
					w.n++; w.ms += ms; w.max = Math.max(w.max, ms);
				}
			}
		};
		const shrink = overlay.shrinkTailNow;
		if (shrink) overlay.shrinkTailNow = function (...a) {
			const t0 = performance.now();
			inTailShrink++;
			try { return shrink.apply(this, a); } finally {
				inTailShrink--;
				if (recording && (inRaf || inPenUp)) (work[phase + ":tailShrinkInFrame"] ??= { n: 0, ms: 0, max: 0 }).n++;
				else if (recording) frames.set("tail " + t0, { ts: t0, phase: "tail-shrink", rafMs: performance.now() - t0, callbacks: 1, at: t0 });
			}
		};
		// Whole-note repaint asks: any via but "scroll" (camera only) or "partial" (the caller's own damage) marks every stroke damaged.
		const ask = overlay.scheduleRepaint;
		overlay.scheduleRepaint = function (...a) {
			if (recording && a[0] !== "scroll" && a[0] !== "partial") (work[phase + ":repaintAll"] ??= { n: 0, ms: 0, max: 0 }).n++;
			return ask.apply(this, a);
		};
		timeOn(overlay.strokeIndex, "rebuild", "indexRebuild");
		timeOn(InsertSpaceRows.prototype, "get", "rowsGet");
		// Pixel mode: which path each partial repaint took, outside the truth repaints. The stroke index is asked only on the
		// drawn path (paintCommittedWork's partial branch, after both copies refused).
		const paths = window.__islPaths = { drawRegion: 0, extent: 0, standIn: 0 };
		const q = overlay.strokeIndex.query;
		overlay.strokeIndex.query = function (...a) { if (recording && !window.__islInTruth) paths.drawRegion++; return q.apply(this, a); };
		for (const [k, n] of [["copyFromExtent", "extent"], ["copyFromStandIn", "standIn"]]) {
			const orig = overlay[k];
			overlay[k] = function (...a) { const ok = orig.apply(this, a); if (ok && recording && !window.__islInTruth) paths[n]++; return ok; };
		}
		// The commit's shift of the cached rows, counted when taken (absent before item 11 (b): counts 0).
		const shift = InsertSpaceRows.prototype.shift;
		if (shift) InsertSpaceRows.prototype.shift = function (...a) {
			const ok = shift.apply(this, a);
			if (recording && ok) (work[phase + ":shiftTaken"] ??= { n: 0, ms: 0, max: 0 }).n++;
			return ok;
		};
		// The task that runs the queued shift after the release paint: timed as a frame of phase "rows-shift", so no deferred
		// cost goes uncounted. With window.__islShift "before", the task is held until the hovers after the release are done,
		// so the first hover asks the cache first and pays the shift in its own frame.
		const runQueued = InsertSpaceRows.prototype.runQueued;
		if (runQueued) InsertSpaceRows.prototype.runQueued = function (...a) {
			if (inRaf) return runQueued.apply(this, a);
			if (window.__islShift === "before" && recording) { heldTasks.push(() => runQueued.apply(this, a)); return false; }
			const t0 = performance.now();
			try { return runQueued.apply(this, a); } finally {
				if (recording) frames.set("task " + t0, { ts: t0, phase: "rows-shift", rafMs: performance.now() - t0, callbacks: 1, at: t0 });
			}
		};
		timeOn(inlineInk, "moveStrokes", "moveStrokes");
		timeOn(inlineInk, "save", "save");
		return { strokes: inlineInk.strokes(path).length, points: inlineInk.strokes(path).reduce((s, x) => s + x.points.length, 0), canvasMode: !!overlay.canvasMode,
			cssScale: overlay.cssScale, raster: !!overlay.extentRaster,
			scale: overlay.scale, dpr: window.devicePixelRatio, scrollHeight: view.scrollDOM.scrollHeight, clientHeight: view.scrollDOM.clientHeight };
	},
	/** Scroll to world y top, hover/drag/release at the viewport's middle. Returns the frames, events and named work. */
	async run(top, pans) {
		const { view, overlay, path, pageId } = rig, sd = view.scrollDOM;
		sd.scrollTop = Math.round(top * overlay.scale);
		await settle(8); await sleep(400); await settle(4);
		setInlineSpaceMode(true);
		await settle(4);
		const r = sd.getBoundingClientRect(), x = r.left + r.width * 0.45, y0 = r.top + r.height * 0.35;
		// PIXEL MODE (window.__islPixels): after each drag move, the release and the hovers after, wait two frames and hash the
		// committed canvas's pixels, and the tail canvas's (the seam, its labels and the blue and amber preview). Not timed;
		// run on two builds and compare the lists.
		const pixelMode = !!window.__islPixels, pixels = [];
		const hashOf = c => {
			const data = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
			// Two FNV-1a 32-bit hashes (different offsets) over every byte; the page is not a secure context, so no crypto.subtle.
			let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995, ink = 0;
			for (let i = 0; i < data.length; i++) { h1 = Math.imul(h1 ^ data[i], 16777619); h2 = Math.imul(h2 ^ data[i], 16777619) ^ i; }
			for (let i = 3; i < data.length; i += 4) if (data[i] > 0) ink++;
			return { w: c.width, h: c.height, ink, hash: (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0") };
		};
		// The truth: the same state repainted whole (every stroke on the canvas, no clip), hashed, and the shot's own pixels put
		// back so the gesture goes on from what it drew.
		const shot = async label => {
			await frame(); await frame();
			const tail = hashOf(overlay.tailCanvas), cc = overlay.committedCanvas, g = cc.getContext("2d");
			const own = hashOf(cc);
			const pre = g.getImageData(0, 0, cc.width, cc.height);
			window.__islInTruth = true;
			try { overlay.scheduleRepaint(); await frame(); await frame(); } finally { window.__islInTruth = false; }
			const truth = hashOf(cc);
			g.putImageData(pre, 0, 0);
			pixels.push({ label, ...own, truth: truth.hash, truthInk: truth.ink, tail: tail.hash, tailInk: tail.ink, tailW: tail.w, tailH: tail.h });
		};
		let down = false;
		const pen = (type, px, py) => {
			const target = document.elementFromPoint(px, py);
			if (!target) throw new Error("pen point outside the page");
			const t0 = performance.now();
			target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "pen", pointerId: 931, isPrimary: true,
				clientX: px, clientY: py, buttons: type === "pointerdown" || (type === "pointermove" && down) ? 1 : 0, pressure: type === "pointerdown" || (type === "pointermove" && down) ? 0.5 : 0 }));
			if (type === "pointerdown") down = true; else if (type === "pointerup") down = false;
			if (recording) events.push({ phase, type, t: t0, ms: performance.now() - t0 });
		};
		// Warm-up, not recorded: hovers and a pen down and up at one point (no movement, nothing committed), 300 css px
		// above the gesture, so the first recorded frame is not the first time the code runs.
		for (let i = 0; i < 6; i++) { pen("pointermove", x, y0 - 300 + 4 * i); await sleep(16); }
		pen("pointerdown", x, y0 - 280); await sleep(16); pen("pointerup", x, y0 - 280);
		await settle(6); await sleep(200);
		const sumY = () => inlineInk.strokes(path).reduce((a, s) => a + s.points[0].y, 0);
		const before = { sumY: sumY(), doc: view.state.doc.toString() };
		recording = true;
		phase = "hover-still";
		for (let i = 0; i < 20; i++) { pen("pointermove", x, y0); await sleep(16); }
		await settle(2);
		phase = "hover-sweep";
		for (let i = 1; i <= 30; i++) { pen("pointermove", x, y0 + 6 * i); await sleep(16); }
		// Each sweep preview against a fresh build at its plan and rows, before the drag moves any ink, outside the recording.
		recording = false;
		const staleSweep = sweepPreviews.filter(p => {
			const f = freshPreview(p.plan, p.rows);
			return !(sameList(f.moving, p.moving) && sameList(f.staying, p.staying));
		}).length;
		recording = true;
		await settle(2);
		const yDown = y0 + 180;
		phase = "drag";
		pen("pointerdown", x, yDown);
		const ids = overlay.spaceIds ? [...overlay.spaceIds].length : null;
		for (let i = 1; i <= 30; i++) { await sleep(16); pen("pointermove", x, yDown + 4 * i); if (pixelMode) await shot("drag " + i); }
		await settle(2);
		phase = "release";
		inPenUp++;
		try { pen("pointerup", x, yDown + 120); } finally { inPenUp--; }
		const releaseStart = performance.now();
		if (pixelMode) await shot("release");
		let quiet = 0, n = 0;
		for (; n < 90 && quiet < 10; n++) {
			const before = frames.size;
			await frame();
			await sleep(0);
			quiet = frames.size === before ? quiet + 1 : 0;
		}
		// The next hovers after the commit: the ink changed, so the rows cache is cold again, as on the device after every insert.
		phase = "hover-after";
		for (let i = 1; i <= 10; i++) { pen("pointermove", x, yDown + 120 + 6 * i); await sleep(16); }
		await settle(4);
		if (pixelMode) await shot("after");
		// HW_ISL_ZOOM: wait for any extent raster build the release armed (not recorded), then three pans down, each counted alone.
		const panRows = [];
		let raster = null;
		if (pans > 0) {
			const was = recording; recording = false;
			const w0 = performance.now();
			for (let i = 0; i < 400 && overlay.extentBuild; i++) await sleep(25);
			await settle(4);
			raster = { waitedMs: Math.round(performance.now() - w0), raster: !!overlay.extentRaster, building: !!overlay.extentBuild };
			recording = was;
			phase = "pan";
			const paths = window.__islPaths;
			for (let i = 0; i < pans; i++) {
				const p0 = { ...paths };
				sd.scrollTop += 240;
				await settle(6); await sleep(50);
				panRows.push({ drawRegion: paths.drawRegion - p0.drawRegion, extent: paths.extent - p0.extent, standIn: paths.standIn - p0.standIn });
			}
		}
		recording = false;
		phase = "done";
		for (const t of heldTasks.splice(0)) t();
		// The deferred page write, on its own.
		const page = pending.get(pageId);
		let persistMs = null;
		if (page) { const t0 = performance.now(); serializePage(page); persistMs = performance.now() - t0; }
		const after = { doc: view.state.doc.toString(), history: overlay.view.state.field ? null : null };
		// The sweep's previews: how many distinct moving and staying lists by identity, and how many distinct by content.
		const byContent = [];
		for (const p of sweepPreviews) if (!byContent.some(q => sameList(q.moving, p.moving) && sameList(q.staying, p.staying))) byContent.push(p);
		const previewSets = { previews: sweepPreviews.length, moving: new Set(sweepPreviews.map(p => p.moving)).size,
			staying: new Set(sweepPreviews.map(p => p.staying)).size, contents: byContent.length, stale: staleSweep,
			buildNamed: typeof overlay.buildSpaceDrawItems === "function" };
		return { pixels, pans: panRows, rasterBeforePans: raster, frames: [...frames.values()].sort((a, b) => a.ts - b.ts), events, work, ids, releaseFrames: n, releaseQuiet: quiet, persistMs, pendingSaved: !!page,
			movedInk: sumY() !== before.sumY, docBefore: before.doc, docAfter: after.doc, releaseStart, previewSets };
	},
};
`;

let browser: Browser, script: string;
const record: unknown[] = [];
beforeAll(async () => {
	if (!ENABLED) return;
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "insertSpaceLagPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);
afterAll(async () => {
	await browser?.close();
	if (process.env.HW_ISL_OUT) writeFileSync(process.env.HW_ISL_OUT, JSON.stringify(record, null, 1));
});

const call = (p: Page, method: string, ...args: unknown[]) => p.evaluate(([m, a]) => (window as any).spaceLag[m](...a), [method, args] as const);
const PHASES = ["hover-still", "hover-sweep", "drag", "release", "rows-shift", "hover-after"] as const;
type Frame = { ts: number; phase: string; rafMs: number; callbacks: number; at: number };
type Ev = { phase: string; type: string; t: number; ms: number };
const f2 = (n: number | null) => n === null ? "-" : String(Math.round(n * 100) / 100);

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
	// Handlers after the last frame (the release's own up handler if no frame followed) are a frame of their own.
	const tail = evs.filter(e => e.t >= prev);
	if (tail.length) out.push({ phase: tail[0]!.phase, ms: tail.reduce((s, e) => s + e.ms, 0), rafMs: 0, handlerMs: tail.reduce((s, e) => s + e.ms, 0), handlers: tail.length });
	return out;
}

const ARMS = (process.env.HW_ISL_ARMS ?? "heavy,control").split(",");
const ROUNDS = Number(process.env.HW_ISL_ROUNDS ?? "1");
/** HW_ISL_SHIFT=before: hold the task that runs the queued rows shift until after the hovers, so the first hover pays it. */
const SHIFT = process.env.HW_ISL_SHIFT === "before" ? "before" : "after";
/** HW_ISL_PIXELS=1: the pixel oracle instead of the timing claim (hashes of the committed canvas per drag frame, release, after). */
const PIXELS = process.env.HW_ISL_PIXELS === "1";
/** HW_ISL_ZOOM=<k>: pinch to zoom k after mounting; below 1 the run ends with three pans (default 1: no pinch, no pans). */
const ZOOM = Number(process.env.HW_ISL_ZOOM ?? "1");
const PANS = ZOOM < 1 ? 3 : 0;
const gated = ENABLED ? it : it.skip;
/** The hover sweep's preview draw list builds: the named build where it exists, else one walk per redraw. */
const sweepBuildsOf = (work: Record<string, { n: number } | undefined>, named: boolean) =>
	named ? work["hover-sweep:buildSpaceDrawItems"]?.n ?? 0 : work["hover-sweep:redrawSelectionUI"]?.n ?? 0;
for (let round = 1; round <= ROUNDS; round++) for (const arm of ARMS) {
	gated(`${arm}, round ${round}, shift ${SHIFT} the hover: insert space hover, drag and release, every frame's plugin work within the ScrollCost budget (2 ms)`, async () => {
		const page = await browser.newPage({ viewport: { width: 1800, height: 900 }, deviceScaleFactor: DPR });
		const errors: string[] = [];
		page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
		try {
			await page.setContent(`<!doctype html><body class="theme-dark" style="margin:0; --font-text-size:19px; --background-modifier-border:#777777"></body>`);
			await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
			await page.addStyleTag({ content: MINIMAL_CSS });
			await page.addScriptTag({ content: script });
			const sidecar = readFileSync(SIDECAR_PATH, "utf8");
			const mounted = await call(page, "mount", arm, sidecar, PAGE_ID, NOTE_TEXT, ZOOM) as any;
			if (PIXELS) await page.evaluate(() => { (window as any).__islPixels = true; });
			await page.evaluate(m => { (window as any).__islShift = m; }, SHIFT);
			const r = await call(page, "run", 1000, PANS) as any;
			if (PIXELS) {
				const paths = await page.evaluate(() => (window as any).__islPaths);
				record.push({ arm, round, dpr: DPR, paths, pixels: r.pixels });
				expect(errors, "page errors").toEqual([]);
				expect(r.pixels.length, "pixel mode: 30 drag frames, the release and after").toBe(32);
				expect(r.pixels.every((x: { ink: number }) => x.ink > 0), "pixel mode: ink on the committed canvas in every shot").toBe(true);
				expect(paths.drawRegion, "premise: partial repaints took the drawn path").toBeGreaterThan(0);
				// Every shot, drag frames included, equals a whole repaint of the same state: a partial repaint draws what a whole
				// one draws. A clip edge between device pixels drew every stroke under it with fainter edges.
				expect(r.pixels.filter((x: { hash: string; truth: string }) => x.hash !== x.truth).map((x: { label: string; ink: number; truthInk: number }) => `${x.label} (${x.ink} vs ${x.truthInk})`),
					`every shot equals a whole repaint of the same state ${JSON.stringify(paths)}`).toEqual([]);
				return;
			}
			const fw = frameWork(r.frames, r.events);
			const bound = timingBound(2);
			type PhaseRow = { frames: number; over: number; median: string; p95: string; max: string; total: string; handlers: number; handlerMax: string };
			const byPhase: Record<string, PhaseRow> = Object.fromEntries(PHASES.map(ph => {
				const fr = fw.filter(f => f.phase === ph), ms = fr.map(f => f.ms).sort((a, b) => a - b);
				const p = (q: number) => ms.length ? ms[Math.min(ms.length - 1, Math.ceil(q * ms.length) - 1)]! : null;
				const handlers = (r.events as Ev[]).filter(e => e.phase === ph);
				return [ph, { frames: fr.length, over: fr.filter(f => f.ms > bound).length, median: f2(p(0.5)), p95: f2(p(0.95)), max: f2(ms.at(-1) ?? null),
					total: f2(ms.reduce((s, x) => s + x, 0)), handlers: handlers.length, handlerMax: f2(handlers.reduce((a, e) => Math.max(a, e.ms), 0)) }];
			}));
			const panFrames = fw.filter(f => f.phase === "pan").map(f => Math.round(f.ms * 100) / 100);
			const summary = { arm, round, shift: SHIFT, zoom: ZOOM, pans: r.pans, rasterBeforePans: r.rasterBeforePans, panFrames, mounted, byPhase, persistMs: f2(r.persistMs), pendingSaved: r.pendingSaved, ids: r.ids, movedInk: r.movedInk, releaseFrames: r.releaseFrames, releaseQuiet: r.releaseQuiet, work: r.work, previewSets: r.previewSets };
			record.push({ summary, frames: fw, events: r.events });
			console.log("INSERT-SPACE-LAG " + JSON.stringify(summary));
			const brief = "\n" + JSON.stringify(summary, null, 1);
			expect(errors, "page errors").toEqual([]);
			// PREMISES: the arm's ink is mounted; canvas on; the dpr is the setup's; hover and drag reached the space tool.
			expect(mounted.strokes, `premise: the arm's strokes${brief}`).toBe(arm === "control" ? 15 : 28555);
			expect(mounted.canvasMode, `premise: canvas on${brief}`).toBe(true);
			expect(Math.abs(mounted.dpr - DPR), `premise: dpr ${DPR}${brief}`).toBeLessThan(0.001);
			for (const ph of PHASES) if (ph !== "rows-shift" || SHIFT === "after") expect(byPhase[ph]!.frames, `premise: ${ph} ran frames${brief}`).toBeGreaterThan(0);
			expect(r.work["hover-sweep:showPenCursor"]?.n ?? 0, `premise: hover reached the overlay${brief}`).toBeGreaterThan(0);
			expect(r.work["drag:spaceDown"]?.n ?? 0, `premise: the pen down started an insert space${brief}`).toBe(1);
			expect(r.work["release:spaceUp"]?.n ?? 0, `premise: the lift ended it${brief}`).toBe(1);
			expect(r.ids, `premise: the gesture moved ink${brief}`).toBeGreaterThan(0);
			expect(r.movedInk, `premise: committed ink moved${brief}`).toBe(true);
			if (PANS > 0) {
				// Below 100 percent the pans after an insert space copy their exposed bands from the extent raster: the drag's first
				// frame let the old raster go (the store changed under it), and the release must leave a new one armed.
				// The heavy note's whole ink does not fit the raster cap at 0.5 (no raster at mount in any build), so it pans by path
				// before and after; the control's fits, and is the arm this line is about.
				expect(Math.abs(mounted.cssScale - ZOOM), `premise: the note is at zoom ${ZOOM}${brief}`).toBeLessThan(0.01);
				expect(r.pans.length, `premise: ${PANS} pans ran${brief}`).toBe(PANS);
				if (arm === "control") expect(mounted.raster, `premise: the zoomed-out note built its extent raster before the gesture${brief}`).toBe(true);
				if (mounted.raster) expect(r.pans.map((p: { drawRegion: number; extent: number }) => p.extent > 0 && p.drawRegion === 0),
					`every pan after the release copies from the extent raster and draws no stroke by path${brief}`).toEqual(r.pans.map(() => true));
			}
			// The drag draws its seam and preview once per move: the pen down's draw plus one per move, not one in the move's
			// handler and again in the repaint frame it queued (61 for 30 moves before that fix, about 10 ms a frame on the note).
			const chrome = r.work["drag:redrawSelectionUI"]?.n ?? 0, moves = r.work["drag:spaceMove"]?.n ?? 0;
			expect(moves, `premise: the drag moved${brief}`).toBe(30);
			expect(chrome, `seam and preview drawn once per drag move (pen down + ${moves} moves)${brief}`).toBeLessThanOrEqual(moves + 1);
			// The commit shifts the cached rows by the drag's steps, so the first hover after it does not regroup every point: in the
			// task after the release paint, or, with that task held, in the first hover's own frame.
			expect(r.work[(SHIFT === "after" ? "release" : "hover-after") + ":shiftTaken"]?.n ?? 0, `the commit shifted the cached rows (${SHIFT} the hover)${brief}`).toBe(1);
			// The release repaints only what the commit moved (its snap correction, none on this note: the seam is below all the
			// text), not every stroke on the canvas: the text edit cannot move ink, and the drag already painted the ink where it
			// is (18 ms on the heavy note when the release repainted it all).
			expect(r.work["release:repaintAll"]?.n ?? 0, `the release asks no whole-note repaint${brief}`).toBe(0);
			// The release keeps the tail at its full size: shrinking it reallocates the canvas (3.8 ms heavy, 4.4 ms control in the
			// 0fe13aca probe), so the shrink runs in a task after the frame.
			expect(r.work["release:tailResize"]?.n ?? 0, `the release does not resize the tail backing${brief}`).toBe(0);
			expect(r.work["release:tailShrinkInFrame"]?.n ?? 0, `the tail shrink runs neither in the pen-up event nor in a frame${brief}`).toBe(0);
			// The hover sweep builds new moving and staying lists only when their contents change: below the text every sample is a new
			// plan, and the lists stay the same while no row changes side of the seam.
			expect(r.previewSets.previews, `premise: the sweep built previews${brief}`).toBeGreaterThan(1);
			expect([r.previewSets.moving, r.previewSets.staying], `the hover sweep builds new stroke lists only when their contents change ${JSON.stringify(r.previewSets)}${brief}`)
				.toEqual([r.previewSets.contents, r.previewSets.contents]);
			expect(r.previewSets.stale, `every hover sweep preview's lists equal a fresh build at its plan ${JSON.stringify(r.previewSets)}${brief}`).toBe(0);
			// The sweep's preview redraws walk the store only when the lists change: one draw list per list (the camera holds in the
			// sweep), holding only strokes on screen. A build without its own name is the walk inside every redraw.
			const sweepBuilds = sweepBuildsOf(r.work, r.previewSets.buildNamed);
			expect([sweepBuilds <= r.previewSets.moving, r.work["hover-sweep:tailStrokeOff"]?.n ?? 0],
				`the hover sweep walks the strokes once per preview list and asks no off-screen stroke (builds ${sweepBuilds}, lists ${r.previewSets.moving})${brief}`)
				.toEqual([true, 0]);
			// The drag moves strokes under a frozen preview, so it builds its draw list every redraw: no stroke it asks is off screen.
			expect(r.work["drag:tailStrokeOff"]?.n ?? 0, `the drag asks no off-screen preview stroke${brief}`).toBe(0);
			// The pen up draws the seam layer once: dropping the hover preview no longer draws it a first time before the release's end does.
			expect(r.work["release:redrawSelectionUI"]?.n ?? 0, `the release draws the selection layer once${brief}`).toBe(1);
			// THE CLAIM: no frame over the budget, in any phase.
			expect(PHASES.map(ph => `${ph} ${byPhase[ph]!.over} of ${byPhase[ph]!.frames} over ${bound} ms (max ${byPhase[ph]!.max})`).filter(s => !/^\S+ 0 of/.test(s)),
				`frames over the ScrollCost budget${brief}`).toEqual([]);
		} finally { await page.close(); }
	}, 600_000);
}
