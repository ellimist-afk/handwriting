/**
 * WHAT ONE INSERT-SPACE DRAG BATCH COSTS ON EXAM 4 STUDY, WITH THE DIVIDER NEAR THE TOP OF THE NOTE.
 *
 * What it looks like: on Exam 4 Study (19,736 strokes, 592,980 points, Infinite Canvas off) the insert-space drag lags
 * when the divider is near the top, where about 93 percent of the strokes move with the pen.
 *
 * The rig is InsertSpaceLag.test.ts with this note: its ink file (a copy of the vault file, read from HW_ISD_SIDECAR;
 * 17 MB, so it is not checked in) and its own text, canvas off, font 26 against the page's fontRefPx 28, the Minimal
 * theme, dark. The device ratio is forced on the browser (--force-device-scale-factor HW_ISD_DPR, default 1.8257, Orion's
 * page zoom); the page sets none. Every pen event goes through the real router as a PointerEvent; phases and the named
 * work inside each frame are as in InsertSpaceLag.test.ts.
 *
 * Run: HW_INSERT_SPACE_DRAG=1 HW_ISD_SIDECAR=<copy of the ink file> npx vitest run --config vitest.render.mts
 *   test/render/InsertSpaceDragCost.test.ts. HW_ISD_OUT=<file> writes every arm's frames as JSON. HW_ISD_ARMS=heavy,control.
 *
 * Geometry: the note scrolled to world y HW_ISD_TOP (default 0, its top) and the pen down HW_ISD_DOWN css px below the pane's top
 * (default 460): the divider lands near the note's top and about 93 percent of the heavy note's strokes move. HW_ISD_TOP=1000 is
 * the first baseline's place (74 percent moving).
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

const SIDECAR_PATH = process.env.HW_ISD_SIDECAR ?? "";
const ENABLED = process.env.HW_INSERT_SPACE_DRAG === "1" && existsSync(SIDECAR_PATH);
const PAGE_ID = "ce429a99-18bb-4f54-afd1-3963a181a175";
/** The note's text below its frontmatter, as in the vault file. */
const NOTE_TEXT = "Experimental Biology by Alan\n\n\n\n\n\n\n\n\n\n\n\n\n\ntype where you want\n\nwrite where you want";
const DPR = Number(process.env.HW_ISD_DPR ?? "1.8257");
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
import { drawCommitted } from "../../src/ink/StrokeRenderer";
import { committedFloorFor } from "../../src/inline/InkOverlay";

installObsidianDom();
// Path2D constructions while recording, per phase ("<phase>:path2d" in the named work).
{
	const RawPath2D = window.Path2D;
	const Counted = function (...a) {
		if (recording) (work[phase + ":path2d"] ??= { n: 0, ms: 0, max: 0 }).n++;
		return new RawPath2D(...a);
	};
	Counted.prototype = RawPath2D.prototype;
	window.Path2D = Counted;
}
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
		setPenInk(true); setScrollExpansionEnabled(false); setInlineTool("pen");
		const path = "Exam 4 Study.md";
		let data = sidecar;
		// The control: 15 of the note's strokes from the region the gesture works in at the default geometry (world y 600 to 850,
		// below the seam near 500, inside the pane), so they move.
		if (arm === "control") { const d = JSON.parse(sidecar); d.strokes = d.strokes.filter(s => s.pts[1] >= 600 && s.pts[1] < 850 && s.pts[0] < 1300).slice(0, 15); data = JSON.stringify(d); }
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
		// HW_ISD_ZOOM: pinch to the zoom about the pane's middle, then let the extent raster build (it builds after a whole repaint
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
		// The drag's picture, where the build has one: the snapshot at pen-down, the raster, and the copy per sample.
		for (const k of ["beginSpaceSnapshot", "rasterSpacePicture", "drawSpacePicture"]) if (overlay[k]) timeOn(overlay, k, k);
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
		window.__islExtentCopy = overlay.copyFromExtent;
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
	/** The drag picture's cells (HW_ISD_PICTURE): the look at pen-down, repaints mid-drag, ink pulled in from below. */
	async pictureChecks(top, downAt, lookLevels) {
		const { view, overlay, path } = rig, sd = view.scrollDOM;
		sd.scrollTop = Math.round(top * overlay.scale);
		await settle(8); await sleep(400); await settle(4);
		setInlineSpaceMode(true);
		await settle(4);
		const r = sd.getBoundingClientRect(), x = r.left + r.width * 0.45, yDown = r.top + downAt;
		let down = false;
		const pen = (type, px, py) => {
			const target = document.elementFromPoint(px, py);
			if (!target) throw new Error("pen point outside the page");
			target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "pen", pointerId: 932, isPrimary: true,
				clientX: px, clientY: py, buttons: type === "pointerdown" || (type === "pointermove" && down) ? 1 : 0, pressure: type === "pointerdown" || (type === "pointermove" && down) ? 0.5 : 0 }));
			if (type === "pointerdown") down = true; else if (type === "pointerup") down = false;
		};
		const fnv = d => {
			let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995;
			for (let i = 0; i < d.length; i++) { h1 = Math.imul(h1 ^ d[i], 16777619); h2 = Math.imul(h2 ^ d[i], 16777619) ^ i; }
			return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
		};
		const inked = d => { let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; };
		const readRect = (c, x0, y0, x1, y1) => c.width > 0 && x1 > x0 && y1 > y0 ? c.getContext("2d").getImageData(x0, y0, x1 - x0, y1 - y0).data : new Uint8ClampedArray(0);
		const hoverTo = async y => { for (let i = 0; i < 10; i++) { pen("pointermove", x, y - 60 + 6 * i); await sleep(16); } pen("pointermove", x, y); await settle(4); };
		// Pictures made and row rasters, and the current picture's rastered row ranges (its own rows, as the product clips them).
		const counts = { picture: 0, rows: 0 };
		let rowsLog = [];
		for (const k of ["rasterSpacePicture", "rasterSpaceRows"]) {
			const orig = overlay[k];
			if (typeof orig !== "function") continue;
			overlay[k] = function (...a) {
				counts[k === "rasterSpacePicture" ? "picture" : "rows"]++;
				const sn = a[0];
				if (k === "rasterSpaceRows" && sn === overlay.spaceSnapshot) {
					const r0 = sn.done - sn.top, r1 = Math.min(a[1], sn.bottom) - sn.top;
					if (r1 > r0) rowsLog.push([r0, r1]);
				}
				const ret = orig.apply(this, a);
				if (k === "rasterSpacePicture") rowsLog = [];
				return ret;
			};
		}
		// The old drag's paint: every stroke on the committed layers by drawCommitted, the blue and amber preview strokes by a copy
		// of the old preview stroke (TailRenderer.drawSpaceStroke at c47006f8), in store order, composed as the old screen composed
		// them. At a canvas geometry: height h, the transform moved up by off whole rows, and with clips, drawn once under each of
		// those row ranges of its canvas as the picture's rows are (this backend's antialiasing moves with a canvas's height, the
		// row a stroke lands on and the clip it is drawn under). only: the moving strokes alone, culled to the canvas's rows.
		const oracleFor = (cam, b, W, H, strokes, moving, staying) => {
			const floor = committedFloorFor(b, overlay.dpr);
			const layer = (h, off) => { const c = document.createElement("canvas"); c.width = W; c.height = h; const g = c.getContext("2d"); g.setTransform(b, 0, 0, b, 0, -off); return [c, g]; };
			const compose = (layers, h) => {
				const c = document.createElement("canvas"); c.width = W; c.height = h; const g = c.getContext("2d");
				for (const [canvas, alpha] of layers) if (canvas && canvas.width === W && canvas.height === h) { g.globalAlpha = alpha; g.drawImage(canvas, 0, 0); }
				return g.getImageData(0, 0, W, h).data;
			};
			const draw = (h, off, clips, only) => {
				const list = only ? strokes.filter(s => moving.has(s.id)) : strokes;
				const [hc, hg] = layer(h, off), [pc, pg] = layer(h, off), [ac, ag] = layer(h, off);
				for (const clip of clips || [null]) {
					if (clip) for (const g of [hg, pg, ag]) { g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.beginPath(); g.rect(0, clip[0], W, clip[1] - clip[0]); g.clip(); g.setTransform(b, 0, 0, b, 0, -off); }
					drawCommitted(hg, cam, list, W / b, (off + h) / b, true, "highlighter", undefined, floor);
					drawCommitted(pg, cam, list, W / b, (off + h) / b, true, "pen", false, floor);
					for (const s of list) {
						const m = moving.has(s.id);
						if (!m && !staying.has(s.id)) continue;
						if (!(only ? overlay.tail.spaceStrokeOnScreen(cam, s, W / b, (off + h) / b, overlay.cssScale) : overlay.tail.spaceStrokeOnScreen(cam, s, overlay.cssWidth, overlay.cssHeight, overlay.cssScale))) continue;
						const p = new Path2D(), pts = s.points;
						p.moveTo(pts[0].x, pts[0].y);
						for (let i = 1; i < pts.length; i++) p.lineTo(pts[i].x, pts[i].y);
						if (pts.length === 1) p.lineTo(pts[0].x + .001, pts[0].y);
						ag.save(); ag.translate(-cam.x * cam.zoom, -cam.y * cam.zoom); ag.scale(cam.zoom, cam.zoom);
						ag.strokeStyle = m ? "#7f9cf5" : "#d98b00"; ag.globalAlpha = .65; ag.lineWidth = Math.max(s.width, 4 / (overlay.cssScale * cam.zoom));
						ag.lineCap = "round"; ag.lineJoin = "round"; ag.setLineDash([]); ag.stroke(p); ag.restore();
					}
					if (clip) for (const g of [hg, pg, ag]) g.restore();
				}
				return compose([[hc, 0.35], [pc, 1], [ac, 1]], h);
			};
			return { compose, draw };
		};
		const out = { look: null, repaint: null, window: [] };

		// 1. THE LOOK AT PEN-DOWN.
		await hoverTo(yDown);
		pen("pointerdown", x, yDown);
		await settle(4);
		{
			const cam = overlay.camera.snapshot, b = overlay.committedBacking, cc = overlay.committedCanvas, tc = overlay.tailCanvas;
			const W = cc.width, H = cc.height, k = cam.zoom * b, preview = overlay.spacePreview;
			if (!preview) throw new Error("no preview at pen-down");
			if (tc.width !== W || tc.height !== H) out.look = { skipped: "tail " + tc.width + "x" + tc.height + " vs " + W + "x" + H };
			else {
				const strokes = overlay.strokesHere(), moving = new Set(preview.moving), staying = new Set(preview.staying);
				const O = oracleFor(cam, b, W, H, strokes, moving, staying);
				const screen = O.compose([[overlay.highlightCanvas, 0.35], [cc, 1], [tc, 1]], H);
				let stayingBottom = -Infinity;
				for (const s of strokes) if (!moving.has(s.id) && overlay.tail.spaceStrokeOnScreen(cam, s, overlay.cssWidth, overlay.cssHeight, overlay.cssScale))
					stayingBottom = Math.max(stayingBottom, Math.ceil((s.bbox.y + s.bbox.height - cam.y) * k) + Math.ceil(4 * b / overlay.cssScale) + 2);
				const oracle = O.draw(H, 0);
				const seamRow = (preview.plan.y - cam.y) * k, labelTop = Math.floor(seamRow - 24 * b), labelBottom = Math.ceil(seamRow + 26 * b);
				// Rows y0 .. y1 of image A (the tail's geometry) against image B, whose row 0 is the tail's row off and which has
				// h rows; rows B does not hold are counted as outside.
				const zone = (y0, y1, A = screen, B = oracle, off = 0, h = H) => {
					let n = 0, max = 0, px = 0, outside = 0, over = 0;
					const at = [0, 0, 0];
					for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
						if (y >= labelTop && y < labelBottom) continue;
						if (y - off < 0 || y - off >= h) { outside++; continue; }
						for (let xx = 0; xx < W; xx++) {
							const i = (y * W + xx) * 4, j = ((y - off) * W + xx) * 4;
							px++;
							const d = Math.max(Math.abs(A[i] - B[j]), Math.abs(A[i + 1] - B[j + 1]), Math.abs(A[i + 2] - B[j + 2]), Math.abs(A[i + 3] - B[j + 3]));
							if (d > 0) n++;
							if (d > 0 && d <= 3) at[d - 1]++;
							if (d > lookLevels) over++;
							if (d > max) max = d;
						}
					}
					return { px, differ: n, atLevels: at, overLevels: over, maxLevels: max, outsideRows: outside };
				};
				const aTop = Math.max(stayingBottom, labelBottom);
				const snapL = overlay.spaceSnapshot, pic = snapL ? snapL.canvas : null;
				// Zone A against the old paint at the picture's geometry and row ranges (asserted), and the old paint's own difference
				// between the tail's geometry and the picture's (the backend's share, reported).
				let aPicture = null, aBackend = null;
				const clipsL = rowsLog.slice();
				if (pic) {
					const oracleAtPicture = O.draw(pic.height, snapL.top, clipsL);
					aPicture = zone(aTop, H, screen, oracleAtPicture, snapL.top, pic.height);
					aBackend = zone(aTop, H, oracle, oracleAtPicture, snapL.top, pic.height);
				}
				out.look = { W, H, seamRow: Math.round(seamRow), zoneATop: aTop, a: zone(aTop, H), b: zone(0, aTop), aPicture, aBackend,
					pictureTop: snapL ? snapL.top : null, pictureRows: pic ? pic.height : null, pictureClips: clipsL,
					screenInk: inked(screen), oracleInk: inked(oracle), snapshot: !!overlay.spaceSnapshot };
			}
		}

		// 2. REPAINTS MID-DRAG.
		for (let i = 1; i <= 10; i++) { await sleep(16); pen("pointermove", x, yDown + 4 * i); }
		await settle(4);
		{
			const cam = overlay.camera.snapshot, b = overlay.committedBacking, k = cam.zoom * b, cc = overlay.committedCanvas, hc = overlay.highlightCanvas;
			const snap = overlay.spaceSnapshot, ids = snap ? snap.ids : new Set(overlay.spaceIds);
			const strokes = overlay.strokesHere(), W = cc.width, H = cc.height;
			const rows = bb => ({ x0: Math.floor((bb.x - cam.x) * k), y0: Math.floor((bb.y - cam.y) * k), x1: Math.ceil((bb.x + bb.width - cam.x) * k), y1: Math.ceil((bb.y + bb.height - cam.y) * k) });
			const onCanvas = q => q.x0 >= 0 && q.y0 >= 0 && q.x1 <= W && q.y1 <= H && q.x1 - q.x0 > 2 && q.y1 - q.y0 > 2;
			const meets = (a, c, pad) => a.x - pad < c.x + c.width && c.x - pad < a.x + a.width && a.y - pad < c.y + c.height && c.y - pad < a.y + a.height;
			const mov = strokes.filter(s => ids.has(s.id)), stay = strokes.filter(s => !ids.has(s.id));
			const M = mov.find(s => onCanvas(rows(s.bbox)) && !stay.some(t => meets(s.bbox, t.bbox, 2)));
			const S = stay.find(s => onCanvas(rows(s.bbox)) && !mov.some(t => meets(s.bbox, t.bbox, 2)));
			const read = q => ({ pen: readRect(cc, q.x0, q.y0, q.x1, q.y1), hl: readRect(hc, q.x0, q.y0, q.x1, q.y1) });
			const state = () => {
				const m = M ? read(rows(M.bbox)) : null, s = S ? read(rows(S.bbox)) : null;
				return { mInk: m ? inked(m.pen) + inked(m.hl) : null, s: s ? fnv(s.pen) + fnv(s.hl) : null, sInk: s ? inked(s.pen) : null };
			};
			const before = state();
			overlay.scheduleRepaint();
			await frame(); await frame(); await frame();
			const whole = state();
			if (M && S) {
				const u = { x: Math.min(M.bbox.x, S.bbox.x), y: Math.min(M.bbox.y, S.bbox.y) };
				overlay.damage.addRect({ ...u, width: Math.max(M.bbox.x + M.bbox.width, S.bbox.x + S.bbox.width) - u.x, height: Math.max(M.bbox.y + M.bbox.height, S.bbox.y + S.bbox.height) - u.y });
				overlay.scheduleRepaint("partial");
			}
			await frame(); await frame(); await frame();
			const partial = state();
			out.repaint = { moving: M ? M.id : null, staying: S ? S.id : null, snapshot: !!snap, before, whole, partial };
		}
		// Back to the pen-down place and up: no move, no text change.
		for (let i = 9; i >= 0; i--) { await sleep(16); pen("pointermove", x, yDown + 4 * i); }
		await settle(2);
		pen("pointerup", x, yDown);
		await settle(10); await sleep(200); await settle(4);

		// 3. THE WINDOW.
		for (const reach of [0, undefined]) {
			overlay.spacePictureReach = reach;
			const c0 = { ...counts };
			await hoverTo(yDown);
			pen("pointerdown", x, yDown);
			await settle(4);
			for (let i = 1; i <= 20; i++) { await sleep(16); pen("pointermove", x, yDown - 6 * i); }
			await settle(4);
			const cam = overlay.camera.snapshot, b = overlay.committedBacking, k = cam.zoom * b, tc = overlay.tailCanvas, snap = overlay.spaceSnapshot;
			const W = tc.width, H = tc.height, shift = Math.round(overlay.spaceTotalDy * k);
			// The tail's bottom rows show the pen-down rows that were below the canvas.
			const strip = () => readRect(tc, 0, Math.max(0, H + shift), W, H);
			const whole = () => readRect(tc, 0, 0, W, H);
			const drawn = { strip: strip(), all: whole() };
			const held = snap ? { top: snap.top, done: snap.done, bottom: snap.bottom } : null;
			const pictures = counts.picture - c0.picture, rowRasters = counts.rows - c0.rows;
			// The strip is the picture's own rows (pen-down rows H - shift - top .. H - top below its first), and the picture's
			// rows, rastered as the drag reached them, hold the old drag's paint of the moving ink drawn at the picture's geometry
			// and row ranges.
			let stripIsPicture = null, rowsOracle = null;
			if (snap && snap.canvas && overlay.spacePreview) {
				const pc = snap.canvas, n = snap.done - snap.top, r0 = Math.max(0, H + shift) - shift - snap.top, r1 = H - shift - snap.top;
				stripIsPicture = r0 >= 0 && r1 <= n ? fnv(readRect(pc, 0, r0, W, r1)) === fnv(drawn.strip) : null;
				const clips = rowsLog.slice(), Ow = oracleFor(cam, b, W, H, overlay.strokesHere(), new Set(overlay.spacePreview.moving), new Set());
				const A = readRect(pc, 0, 0, W, n), B = Ow.draw(pc.height, snap.top, clips, true);
				let differ = 0, over = 0, max = 0;
				const at = [0, 0, 0];
				for (let i = 0; i < A.length; i += 4) {
					const d = Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2]), Math.abs(A[i + 3] - B[i + 3]));
					if (d > 0) differ++;
					if (d > 0 && d <= 3) at[d - 1]++;
					if (d > lookLevels) over++;
					if (d > max) max = d;
				}
				rowsOracle = { rows: n, clips: clips.length, inked: inked(A), differ, atLevels: at, overLevels: over, maxLevels: max };
			}
			// Reported only: the same tail from a picture made fresh at this offset, a window of another height.
			if (snap) snap.x = NaN;
			overlay.redrawSelectionUI();
			const fresh = { strip: strip(), all: whole() };
			const entering = snap ? [...snap.moving].filter(s => {
				const y0 = (s.bbox.y - cam.y) * k, y1 = (s.bbox.y + s.bbox.height - cam.y) * k, x0 = (s.bbox.x - cam.x) * k, x1 = (s.bbox.x + s.bbox.width - cam.x) * k;
				return y1 > H && y0 < H - shift && x1 > 0 && x0 < W;
			}).length : 0;
			out.window.push({ reach: reach ?? "default", shift, held, pictures, rowRasters, entering, stripInk: inked(drawn.strip), stripIsPicture, rowsOracle,
				freshAtOffset: { stripInk: inked(fresh.strip), stripSame: fnv(drawn.strip) === fnv(fresh.strip), tailSame: fnv(drawn.all) === fnv(fresh.all) } });
			for (let i = 19; i >= 0; i--) { await sleep(16); pen("pointermove", x, yDown - 6 * i); }
			await settle(2);
			pen("pointerup", x, yDown);
			await settle(10); await sleep(200); await settle(4);
		}
		overlay.spacePictureReach = undefined;
		return out;
	},
	/** Scroll to world y top, hover/drag/release with the pen down downAt css px below the pane's top. Returns the frames, events and named work. */
	async run(top, pans, downAt) {
		const { view, overlay, path, pageId } = rig, sd = view.scrollDOM;
		sd.scrollTop = Math.round(top * overlay.scale);
		await settle(8); await sleep(400); await settle(4);
		setInlineSpaceMode(true);
		await settle(4);
		const r = sd.getBoundingClientRect(), x = r.left + r.width * 0.45, yDown = r.top + downAt, y0 = yDown - 180;
		if (y0 < r.top + 12 || yDown + 200 > r.bottom) throw new Error("pen-down " + downAt + " leaves the hover or the release outside the pane");
		// PIXEL MODE (window.__islPixels): after each drag move, the release and the hovers after, wait two frames and hash the
		// committed canvas's pixels, and the tail canvas's (the seam, its labels and the blue and amber preview). Not timed;
		// run on two builds and compare the lists.
		const pixelMode = !!window.__islPixels, pixels = [];
		// The canvas probe (pixel mode only, nothing on the pen path): every draw call made on the committed canvas's context, by
		// the product or by a shot, counted from here on. A shot's own calls fall outside the window it reads.
		const drawCalls = { n: 0 };
		if (pixelMode) for (const m of ["clearRect", "fillRect", "strokeRect", "fill", "stroke", "drawImage", "putImageData", "fillText", "strokeText"]) {
			const orig = CanvasRenderingContext2D.prototype[m];
			CanvasRenderingContext2D.prototype[m] = function (...a) { if (this.canvas === overlay.committedCanvas) drawCalls.n++; return orig.apply(this, a); };
		}
		const canvasProbe = {};
		const probeNow = key => { const h = hashOf(overlay.committedCanvas); canvasProbe[key] = { hash: h.hash, ink: h.ink, draws: drawCalls.n }; };
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
			// The truth is drawn by path. Once the release's extent raster is built, a whole repaint copies its picture instead, a separate
			// rasterisation of the same strokes whose alpha differs by a few levels at antialiased edges, which is not what a partial
			// repaint draws and not what this compares. Only the copy is refused: the raster itself stays, as the product built it.
			const copyFromExtent = overlay.copyFromExtent;
			const rasterBefore = !!overlay.extentRaster;
			overlay.copyFromExtent = () => false;
			window.__islInTruth = true;
			try { overlay.scheduleRepaint(); await frame(); await frame(); } finally {
				window.__islInTruth = false;
				overlay.copyFromExtent = copyFromExtent;
			}
			const rasterAfter = !!overlay.extentRaster;
			const truth = hashOf(cc);
			g.putImageData(pre, 0, 0);
			pixels.push({ label, rasterBefore, rasterAfter, ...own, truth: truth.hash, truthInk: truth.ink, tail: tail.hash, tailInk: tail.ink, tailW: tail.w, tailH: tail.h });
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
		// above the gesture or at the pane's top, so the first recorded frame is not the first time the code runs. It runs
		// 3000 world units further down the note (as far as it scrolls) and the note scrolls back: at the measured place the
		// warm-up filled the per-stroke caches of the ink below the pane, which a device meets cold.
		sd.scrollTop = Math.round((top + 3000) * overlay.scale);
		await settle(8); await sleep(200); await settle(4);
		const yWarm = Math.max(r.top + 12, y0 - 300);
		for (let i = 0; i < 6; i++) { pen("pointermove", x, yWarm + 4 * i); await sleep(16); }
		pen("pointerdown", x, yWarm + 20); await sleep(16); pen("pointerup", x, yWarm + 20);
		await settle(6); await sleep(200);
		sd.scrollTop = Math.round(top * overlay.scale);
		await settle(8); await sleep(400); await settle(4);
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
		phase = "drag";
		pen("pointerdown", x, yDown);
		const ids = overlay.spaceIds ? [...overlay.spaceIds].length : null;
		for (let i = 1; i <= 30; i++) { await sleep(16); pen("pointermove", x, yDown + 4 * i); if (pixelMode) await shot("drag " + i); }
		await settle(2);
		phase = "release";
		inPenUp++;
		try { pen("pointerup", x, yDown + 120); } finally { inPenUp--; }
		const releaseStart = performance.now();
		if (pixelMode) { await shot("release"); probeNow("afterRelease"); }
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
		if (pixelMode) { probeNow("beforeAfter"); await shot("after"); }
		// HW_ISD_ZOOM: wait for any extent raster build the release armed (not recorded), then three pans down, each counted alone.
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
		return { pixels, copyRestored: pixelMode ? overlay.copyFromExtent === window.__islExtentCopy : null, canvasProbe: pixelMode ? canvasProbe : null, pans: panRows, rasterBeforePans: raster, frames: [...frames.values()].sort((a, b) => a.ts - b.ts), events, work, ids, releaseFrames: n, releaseQuiet: quiet, persistMs, pendingSaved: !!page,
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
	browser = await chromium.launch({ headless: true, args: [`--force-device-scale-factor=${DPR}`, "--window-size=1800,900"] });
}, 180_000);
afterAll(async () => {
	await browser?.close();
	if (process.env.HW_ISD_OUT) writeFileSync(process.env.HW_ISD_OUT, JSON.stringify(record, null, 1));
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

const ARMS = (process.env.HW_ISD_ARMS ?? "heavy,control").split(",");
const ROUNDS = Number(process.env.HW_ISD_ROUNDS ?? "1");
/** HW_ISD_SHIFT=before: hold the task that runs the queued rows shift until after the hovers, so the first hover pays it. */
const SHIFT = process.env.HW_ISD_SHIFT === "before" ? "before" : "after";
/** HW_ISD_PIXELS=1: the pixel oracle instead of the timing claim (hashes of the committed canvas per drag frame, release, after). */
const PIXELS = process.env.HW_ISD_PIXELS === "1";
/** HW_ISD_PICTURE=1: the drag picture's cells instead of the timing claim (the look at pen-down, repaints mid-drag, the window). */
const PICTURE = process.env.HW_ISD_PICTURE === "1";
/**
 * The look at pen-down, zone A (only moving ink), and the picture's rows after an upward drag: the most a channel may differ from
 * the old drag's paint, drawn at the picture's canvas geometry and under its row ranges (this backend's antialiasing moves with a
 * canvas's height, the row a stroke lands on and the clip it is drawn under). The picture composes the moving ink, its highlighter
 * wash and the blue in one canvas where the old drag composed three layers: eight-bit rounding at each of those steps is the only
 * difference expected. Measured on cc9f7938 with the picture (atLevels, reported): of zone A's 3.0M px, 4,178 differ by 1 level,
 * 415 by 2 and 4 by 3; each window's rows differ by 3 at 4 px. The limit is 3 for that cause, not 2; a picture blitted one device
 * row off differs by up to 255 at over a hundred thousand px, so the limit still catches a placement error.
 */
const LOOK_LEVELS = 3;
/** HW_ISD_ZOOM=<k>: pinch to zoom k after mounting; below 1 the run ends with three pans (default 1: no pinch, no pans). */
const ZOOM = Number(process.env.HW_ISD_ZOOM ?? "1");
const PANS = ZOOM < 1 ? 3 : 0;
/** HW_ISD_TOP: the world y the note is scrolled to; HW_ISD_DOWN: the pen-down's css px below the pane's top (see the header). */
const TOP = Number(process.env.HW_ISD_TOP ?? "0");
const DOWN = Number(process.env.HW_ISD_DOWN ?? "460");
const gated = ENABLED ? it : it.skip;
/**
 * The drag's bounds: a quarter of the measured median and a third of the measured p95 of the drag phase's frames on the code before
 * the picture (c47006f8, timed alone on eight cores, forced dpr 1.8257), the lowest round of either geometry: median 22.1 ms (rounds 22.1 to 24.6
 * at the note's top, 23.5 to 24 at world y 1000), p95 29.4 ms (rounds 29.4 to 42).
 */
const DRAG_MEDIAN_MS = 5.5;
const DRAG_P95_MS = 9.8;
/** The hover sweep's preview draw list builds: the named build where it exists, else one walk per redraw. */
const sweepBuildsOf = (work: Record<string, { n: number } | undefined>, named: boolean) =>
	named ? work["hover-sweep:buildSpaceDrawItems"]?.n ?? 0 : work["hover-sweep:redrawSelectionUI"]?.n ?? 0;
if (PICTURE) gated("the drag's picture: the look at pen-down, a whole and a partial repaint mid-drag, ink pulled in from below by an upward drag", async () => {
	const page = await (await browser.newContext({ viewport: null })).newPage();
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	try {
		await page.setContent(`<!doctype html><body class="theme-dark" style="margin:0; --font-text-size:26px; --background-modifier-border:#777777"></body>`);
		await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
		await page.addStyleTag({ content: MINIMAL_CSS });
		await page.addScriptTag({ content: script });
		const mounted = await call(page, "mount", "heavy", readFileSync(SIDECAR_PATH, "utf8"), PAGE_ID, NOTE_TEXT, 1) as any;
		const r = await call(page, "pictureChecks", TOP, DOWN, LOOK_LEVELS) as any;
		record.push({ picture: r, mounted });
		const brief = "\n" + JSON.stringify(r, null, 1);
		console.log("INSERT-SPACE-PICTURE " + JSON.stringify(r));
		expect(errors, "page errors").toEqual([]);
		expect(mounted.strokes, `premise: the heavy note${brief}`).toBe(19736);
		// 1. The look at pen-down.
		expect(r.look?.skipped ?? null, `premise: the tail at the committed layer's size${brief}`).toBeNull();
		expect([r.look.snapshot, r.look.a.px > 0, r.look.oracleInk > 0], `premise: a picture held, a zone below the staying ink, ink drawn${brief}`).toEqual([true, true, true]);
		expect([r.look.aPicture !== null, r.look.aPicture?.outsideRows, r.look.aPicture?.px], `premise: the picture holds every row of zone A${brief}`).toEqual([true, 0, r.look.a.px]);
		expect(r.look.aPicture.maxLevels, `the look at pen-down below the staying ink: at most ${LOOK_LEVELS} levels from the old drag's screen at the picture's canvas geometry${brief}`).toBeLessThanOrEqual(LOOK_LEVELS);
		// 2. Repaints mid-drag.
		expect([r.repaint.snapshot, r.repaint.moving !== null, r.repaint.staying !== null, r.repaint.before.sInk > 0],
			`premise: a picture held, a moving and a staying stroke on the canvas apart from the other set, the staying one inked${brief}`).toEqual([true, true, true, true]);
		expect([r.repaint.before.mInk, r.repaint.whole.mInk, r.repaint.partial.mInk],
			`the committed and highlight layers stay transparent in the moving stroke's pen-down box: before, after a whole repaint, after a partial one${brief}`).toEqual([0, 0, 0]);
		expect([r.repaint.whole.s, r.repaint.partial.s], `the staying stroke's box is unchanged by both repaints${brief}`).toEqual([r.repaint.before.s, r.repaint.before.s]);
		// 3. The window.
		for (const w of r.window) {
			expect([w.held !== null, w.shift < 0, w.entering > 0], `premise (reach ${w.reach}): a picture, an upward offset, moving ink entering from below${brief}`).toEqual([true, true, true]);
			expect([w.stripInk > 0, w.stripIsPicture, w.rowsOracle !== null && w.rowsOracle.inked > 0 && w.rowsOracle.maxLevels <= LOOK_LEVELS],
				`reach ${w.reach}: the strip that entered from below holds ink and is the picture's rows, and those rows hold the old drag's paint of the moving ink within ${LOOK_LEVELS} levels${brief}`).toEqual([true, true, true]);
		}
		const [leave, reach] = r.window;
		expect(leave.pictures, `reach 0: the drag left the window and the picture was made again${brief}`).toBeGreaterThanOrEqual(2);
		expect([reach.pictures, reach.rowRasters > 1], `default reach: one picture, its rows rastered as the drag reached them${brief}`).toEqual([1, true]);
	} finally { await page.close(); }
}, 600_000);
if (!PICTURE) for (let round = 1; round <= ROUNDS; round++) for (const arm of ARMS) {
	gated(`${arm}, round ${round}, shift ${SHIFT} the hover: insert space hover, drag and release, ${arm === "heavy" ? `the drag's frames: median at most ${DRAG_MEDIAN_MS} ms, p95 at most ${DRAG_P95_MS} ms` : "recorded, no bound"}`, async () => {
		const page = await (await browser.newContext({ viewport: null })).newPage();
		const errors: string[] = [];
		page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
		try {
			await page.setContent(`<!doctype html><body class="theme-dark" style="margin:0; --font-text-size:26px; --background-modifier-border:#777777"></body>`);
			await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
			await page.addStyleTag({ content: MINIMAL_CSS });
			await page.addScriptTag({ content: script });
			const sidecar = readFileSync(SIDECAR_PATH, "utf8");
			const mounted = await call(page, "mount", arm, sidecar, PAGE_ID, NOTE_TEXT, ZOOM) as any;
			if (PIXELS) await page.evaluate(() => { (window as any).__islPixels = true; });
			await page.evaluate(m => { (window as any).__islShift = m; }, SHIFT);
			const r = await call(page, "run", TOP, PANS, DOWN) as any;
			if (PIXELS) {
				const paths = await page.evaluate(() => (window as any).__islPaths);
				record.push({ arm, round, dpr: DPR, paths, pixels: r.pixels, canvasProbe: r.canvasProbe });
				// The committed canvas between the release shot and the shot after: a hash that holds and no draw call means the shots
				// read the same pixels; a hash that moves with no draw call means a writer outside the drawn-path repaint.
				const probe = r.canvasProbe as { afterRelease: { hash: string; draws: number }; beforeAfter: { hash: string; draws: number } };
				console.log("INSERT-SPACE-CANVAS-PROBE " + JSON.stringify({ arm, round, afterRelease: probe.afterRelease.hash, beforeAfter: probe.beforeAfter.hash,
					hashChanged: probe.afterRelease.hash !== probe.beforeAfter.hash, drawCallsBetween: probe.beforeAfter.draws - probe.afterRelease.draws }));
				expect(errors, "page errors").toEqual([]);
				expect(r.pixels.length, "pixel mode: 30 drag frames, the release and after").toBe(32);
				// The control arm's committed canvas holds no ink in every shot by construction (measured red at the base), so this
				// premise belongs to the heavy arm alone.
				if (arm === "heavy") expect(r.pixels.every((x: { ink: number }) => x.ink > 0), "pixel mode: ink on the committed canvas in every shot").toBe(true);
				expect(paths.drawRegion, "premise: partial repaints took the drawn path").toBeGreaterThan(0);
				// The reference repaint is a measurement and leaves the product as it found it: the raster the release built is still
				// there afterwards, and the extent copy is the product's own again.
				if (arm === "control") expect(r.pixels.some((x: { rasterBefore: boolean }) => x.rasterBefore), "premise: the release's extent raster was built before a shot").toBe(true);
				expect(r.pixels.filter((x: { rasterBefore: boolean; rasterAfter: boolean }) => x.rasterBefore && !x.rasterAfter).map((x: { label: string }) => x.label),
					"the reference repaint dropped the built extent raster").toEqual([]);
				expect(r.copyRestored, "the reference repaint left the extent copy replaced").toBe(true);
				// Every shot, drag frames included, equals a whole repaint of the same state: a partial repaint draws what a whole
				// one draws. A clip edge between device pixels drew every stroke under it with fainter edges.
				expect(r.pixels.filter((x: { hash: string; truth: string }) => x.hash !== x.truth).map((x: { label: string; ink: number; truthInk: number }) => `${x.label} (${x.ink} vs ${x.truthInk})`),
					`every shot equals a whole repaint of the same state ${JSON.stringify(paths)}`).toEqual([]);
				return;
			}
			const fw = frameWork(r.frames, r.events);
			// The pen-down cost: from the pen down to the end of the first frame after the first move, the plugin work in that span
			// (handlers and frame callbacks) and the wall time.
			const evs = (r.events as Ev[]).filter(e => e.phase === "drag");
			const downEv = evs.find(e => e.type === "pointerdown"), moveEv = evs.find(e => e.type === "pointermove");
			const firstMoved = moveEv ? (r.frames as Frame[]).find(f => f.at > moveEv.t) : undefined;
			const penDown = downEv && firstMoved ? {
				wallMs: f2(firstMoved.at + firstMoved.rafMs - downEv.t),
				workMs: f2((r.frames as Frame[]).filter(f => f.at >= downEv.t && f.at <= firstMoved.at).reduce((s, f) => s + f.rafMs, 0) +
					evs.filter(e => e.t >= downEv.t && e.t <= firstMoved.at).reduce((s, e) => s + e.ms, 0)),
			} : null;
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
			const summary = { arm, round, shift: SHIFT, zoom: ZOOM, top: TOP, down: DOWN, movingShare: Math.round(1000 * r.ids / mounted.strokes) / 10, pans: r.pans, rasterBeforePans: r.rasterBeforePans, panFrames, mounted, byPhase, persistMs: f2(r.persistMs), pendingSaved: r.pendingSaved, ids: r.ids, movedInk: r.movedInk, penDown, releaseFrames: r.releaseFrames, releaseQuiet: r.releaseQuiet, work: r.work, previewSets: r.previewSets };
			record.push({ summary, frames: fw, events: r.events });
			console.log("INSERT-SPACE-DRAG " + JSON.stringify(summary));
			const brief = "\n" + JSON.stringify(summary, null, 1);
			expect(errors, "page errors").toEqual([]);
			// PREMISES: the arm's ink is mounted; canvas on; the dpr is the setup's; hover and drag reached the space tool.
			expect(mounted.strokes, `premise: the arm's strokes${brief}`).toBe(arm === "control" ? 15 : 19736);
			expect(mounted.canvasMode, `premise: canvas off${brief}`).toBe(false);
			expect(Math.abs(mounted.dpr - DPR), `premise: dpr ${DPR}${brief}`).toBeLessThan(0.001);
			for (const ph of PHASES) if (ph !== "rows-shift" || SHIFT === "after") expect(byPhase[ph]!.frames, `premise: ${ph} ran frames${brief}`).toBeGreaterThan(0);
			expect(r.work["hover-sweep:showPenCursor"]?.n ?? 0, `premise: hover reached the overlay${brief}`).toBeGreaterThan(0);
			expect(r.work["drag:spaceDown"]?.n ?? 0, `premise: the pen down started an insert space${brief}`).toBe(1);
			expect(r.work["release:spaceUp"]?.n ?? 0, `premise: the lift ended it${brief}`).toBe(1);
			expect(r.ids, `premise: the gesture moved ink${brief}`).toBeGreaterThan(0);
			if (arm === "control") expect(r.ids, `premise: the control moves all its strokes${brief}`).toBe(15);
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
			// THE CLAIM, heavy arm: the drag's frames, the pen-down frame among them, at most a quarter of the measured median and a
			// third of the measured p95 (DRAG_MEDIAN_MS, DRAG_P95_MS). The release, the pen-down cost and every other phase are recorded.
			if (arm === "heavy") {
				const drag = byPhase["drag"]!;
				expect([Number(drag.median) <= timingBound(DRAG_MEDIAN_MS), Number(drag.p95) <= timingBound(DRAG_P95_MS)],
					`the drag's frames: median ${drag.median} ms (bound ${timingBound(DRAG_MEDIAN_MS)}), p95 ${drag.p95} ms (bound ${timingBound(DRAG_P95_MS)})${brief}`).toEqual([true, true]);
			}
		} finally { await page.close(); }
	}, 600_000);
}
