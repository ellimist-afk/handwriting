/**
 * WHAT ONE LASSO DRAG SAMPLE COSTS ON EXAM 4 STUDY, WITH MOST OF THE NOTE'S INK SELECTED, AND WHAT THE LIFT COSTS.
 *
 * What it looks like: on a heavily inked note, dragging a lasso selection that holds a lot of ink lags behind the pen.
 *
 * The rig is InsertSpaceDragCost.test.ts's page (the same ink file read from HW_LDC_SIDECAR, the same text, canvas off, font 26
 * against the page's fontRefPx 28, the Minimal theme, dark). The device ratio is forced on the browser
 * (--force-device-scale-factor HW_LDC_DPR, default 1.8257); the page sets none. Every pen event goes through the real router as
 * a PointerEvent.
 *
 * The selection: lasso mode on, a real pen-down and moves, then the loop's points replaced by a world rectangle that holds every
 * stroke whose top is at or below the line the insert-space cell's divider sits on (the note at its top, HW_LDC_DOWN css px below
 * the pane's top, default 460; about 93 percent of the strokes), and a real pen-up, so the product's own lasso test selects.
 * The drag: a pen-down inside the selection, HW_LDC_SAMPLES moves (default 60) of 4 css px down (HW_LDC_DY), 16 ms apart, then the lift.
 *
 * Per drag sample (from the move's dispatch to the next move): the plugin work (the move's handler plus the frame callbacks
 * that ran before the next move), the wall time from the move's dispatch to the end of the first frame after it, the
 * selectionBounds calls, the selection walks (SelectionModel.bounds over the note's strokes), the points translated in the
 * store, the Path2D constructions, and the repaint asks by kind. The lift: the pen-up handler, the frames until the page is
 * quiet, the commit and the save, apart.
 *
 * Run: HW_LASSO_DRAG=1 HW_LDC_SIDECAR=<copy of the ink file> npx vitest run --config vitest.render.mts test/render/LassoDragCost.test.ts.
 * The lift: the moving ink's alpha centroid on the tail just before the pen-up (the selection box left out) against the centroid
 * of what the pen-up added to the committed and highlight layers, both taken over the pixels where the layers held no ink before
 * the lift; under 0.05 device px apart in both axes is no jump (the picture is one canvas against the layers', and the edges of
 * thin strokes round apart by a level or two). Where moving ink crosses staying ink the layers stack them in another order than
 * the picture did, which a centroid over all the ink reads as a move: that shift is reported, not asserted. The band is settled
 * before the grab, so the lift paints into the layers the picture was taken over; a band that regrows at the lift re-phases
 * every thin stroke against the grid, which a centroid cannot tell from a move.
 *
 * HW_LDC_OUT=<file> writes the samples as JSON. Another note: HW_LDC_PAGE_ID, HW_LDC_STROKES, HW_LDC_SHARE=<min>,<max>; HW_LDC_ALL=1 selects every stroke.
 * Bounds: HW_LDC_MEDIAN, HW_LDC_P95 (the samples' work, default 6.5 and 12.5 ms), HW_LDC_LIFT (the lift's wall, default 58 ms),
 * HW_LDC_GRAB (the pen-down's repaint, default 46.2 ms).
 * HW_LDC_DY=<css px>: the pen's step down per sample (default 4). Sideways: HW_LDC_DX=<css px> moves the pen that far sideways per sample as well (default 0); HW_LDC_SWING=<css px> turns it
 * back at that distance either side of the grab (a zigzag; default 0, straight on). HW_LDC_NARROW=<css px> (and HW_LDC_NARROW_H=<css px> tall below the line, default to the note's end) lassos only the
 * strokes within that width around the grab (default the whole width). HW_LDC_RERASTER=<n> pins the picture's re-rasters in
 * the drag samples (rasterSpacePicture after the pen-down's) to n. HW_LDC_UNSETTLED=1 grabs without settling the band first: the
 * lift's shift is reported, not asserted (a regrowth at the lift, the band lane's to fix).
 * HW_LDC_HOLD=1: the lift holds the band, settled first or not: the committed layer keeps its place and size, no handleResize
 * runs at the lift, and the ink lands within 0.05 device px of the picture where the layers were clear. With HW_LDC_UNSETTLED=1
 * it is the fresh load's lift, where the extent grows the range at the lift itself. HW_LDC_SCROLL_RIGHT=1: after the lift the
 * pane scrolls right until the old band's right edge is at its left; the moved ink past that edge is painted there.
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";
import { timingBound } from "../ciBounds";

declare const process: { env: Record<string, string | undefined>; platform: string };

const SIDECAR_PATH = process.env.HW_LDC_SIDECAR ?? "";
const ENABLED = process.env.HW_LASSO_DRAG === "1" && existsSync(SIDECAR_PATH);
/** HW_LDC_PAGE_ID: the ink file's page id (default Exam 4 Study's). */
const PAGE_ID = process.env.HW_LDC_PAGE_ID ?? "ce429a99-18bb-4f54-afd1-3963a181a175";
/** The note's text below its frontmatter, as in the vault file. */
const NOTE_TEXT = "Experimental Biology by Alan\n\n\n\n\n\n\n\n\n\n\n\n\n\ntype where you want\n\nwrite where you want";
const DPR = Number(process.env.HW_LDC_DPR ?? "1.8257");
const SAMPLES = Number(process.env.HW_LDC_SAMPLES ?? "60");
const DOWN = Number(process.env.HW_LDC_DOWN ?? "460");
const STROKES = Number(process.env.HW_LDC_STROKES ?? "19736");
/** HW_LDC_ALL=1: the rectangle starts above the note, so the lasso selects every stroke; else it starts at the divider line. */
const ALL = process.env.HW_LDC_ALL === "1";
/** HW_LDC_SHARE=<min>,<max>: the selected share premise in percent (default 85,97: the divider line on Exam 4 Study). */
const [SHARE_MIN, SHARE_MAX] = (process.env.HW_LDC_SHARE ?? "85,97").split(",").map(Number) as [number, number];
const DY = Number(process.env.HW_LDC_DY ?? "4"), DX = Number(process.env.HW_LDC_DX ?? "0"), SWING = Number(process.env.HW_LDC_SWING ?? "0"), NARROW = Number(process.env.HW_LDC_NARROW ?? "0"), NARROW_H = Number(process.env.HW_LDC_NARROW_H ?? "0");
const RERASTER = process.env.HW_LDC_RERASTER === undefined ? null : Number(process.env.HW_LDC_RERASTER);
const UNSETTLED = process.env.HW_LDC_UNSETTLED === "1";
/** HW_LDC_HOLD=1: the lift holds the committed layer, runs no handleResize and lands within SHIFT_MAX, asserted settled or not. */
const HOLD = process.env.HW_LDC_HOLD === "1";
/** HW_LDC_SCROLL_RIGHT=1: after the lift, scroll right until the old band's right edge is at the pane's left; the ink moved past it shows there. */
const SCROLL_RIGHT = process.env.HW_LDC_SCROLL_RIGHT === "1";
const SHIFT_MAX = 0.05;
const MINIMAL_CSS = readFileSync(fileURLToPath(new URL("./fixtures/minimal-9.0.2-theme.css", import.meta.url)), "utf8");

const PAGE = `
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { Platform } from "obsidian";
import { inlineInk, inkOverlayExtension, overlayForPath, setScrollExpansionEnabled, setInlineTool, setInlineLassoMode } from "../../src/inline/InkOverlay";
import { setPenInk } from "../../src/inline/PenInk";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField } from "./iphoneObsidianStub";
import { parsePage, serializePage } from "../../src/model/PageData";

installObsidianDom();
let phase = "mount", recording = false;
// Counters, read at each pen event: Path2D constructions and the named calls below.
const count = { canvasNew: 0, path2d: 0, selectionBounds: 0, walks: 0, moveStrokes: 0, movedIds: 0, partial: 0, scroll: 0, whole: 0, repaintPath: 0, redrawSelectionUI: 0, paintCommittedWork: 0, reRaster: 0 };
{
	const RawPath2D = window.Path2D;
	const Counted = function (...a) {
		if (recording) count.path2d++;
		return new RawPath2D(...a);
	};
	Counted.prototype = RawPath2D.prototype;
	window.Path2D = Counted;
}
// Image copies while recording, timed per phase.
{
	const copy = CanvasRenderingContext2D.prototype.drawImage;
	CanvasRenderingContext2D.prototype.drawImage = function (...a) {
		if (!recording) return copy.apply(this, a);
		const t0 = performance.now();
		try { return copy.apply(this, a); } finally {
			const w = work[phase + ":drawImage"] ??= { n: 0, ms: 0, max: 0 };
			const ms = performance.now() - t0; w.n++; w.ms += ms; w.max = Math.max(w.max, ms);
		}
	};
}
// Canvas allocations while recording: a new element or a clone of one.
{
	const make = document.createElement.bind(document);
	document.createElement = function (tag, ...a) { if (recording && String(tag).toLowerCase() === "canvas") count.canvasNew++; return make(tag, ...a); };
	const clone = HTMLCanvasElement.prototype.cloneNode;
	HTMLCanvasElement.prototype.cloneNode = function (...a) { if (recording) count.canvasNew++; return clone.apply(this, a); };
}
Object.assign(Platform, { isMobile: false, isDesktop: true, isIosApp: false, isAndroidApp: false, isDesktopApp: true, isMobileApp: false, isPhone: false, isTablet: false, isWin: true });

const ids = new Map(), sidecars = new Map(), pending = new Map();
inlineInk.attachHost({ readPageId: p => ids.get(p) ?? null, claimId: async (p, id) => { ids.set(p, id); return { pageId: id }; },
	loadSidecar: async id => (sidecars.has(id) ? parsePage(sidecars.get(id), id) : null),
	scheduleSidecar: (id, page) => { pending.set(id, page); }, scheduleSidecarNow: async (id, page) => { pending.set(id, page); }, notify: () => {} });

// Frame callbacks, timed. The test's own waits use the original.
const rawRaf = window.requestAnimationFrame.bind(window);
const frames = new Map();
const events = [];
window.requestAnimationFrame = function (cb) {
	return rawRaf(ts => {
		const t0 = performance.now();
		try { return cb(ts); } finally {
			if (recording) {
				const ms = performance.now() - t0;
				let f = frames.get(ts);
				if (!f) { f = { ts, phase, rafMs: 0, callbacks: 0, at: t0, end: t0 }; frames.set(ts, f); }
				f.rafMs += ms; f.callbacks++; f.end = performance.now();
			}
		}
	});
};
const frame = () => new Promise(r => rawRaf(() => r()));
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

const work = {};
const timeOn = (obj, name, key, counter) => {
	const orig = obj[name];
	if (typeof orig !== "function") throw new Error("no method " + key);
	obj[name] = function (...a) {
		if (recording && counter) count[counter]++;
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

window.lassoDrag = {
	async mount(sidecar, pageId, text) {
		setPenInk(true); setScrollExpansionEnabled(false); setInlineTool("pen");
		const path = "Exam 4 Study.md";
		sidecars.set(pageId, sidecar); ids.set(path, pageId);
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
		for (const k of ["repaint", "lassoDown", "lassoMove", "lassoUp", "commitLiveDrag", "moveLive", "retakeLineAnchors", "dispatchInk", "showLassoCursor"]) timeOn(overlay, k, k);
		timeOn(overlay, "selectionBounds", "selectionBounds", "selectionBounds");
		timeOn(overlay, "redrawSelectionUI", "redrawSelectionUI", "redrawSelectionUI");
		timeOn(overlay, "paintCommittedWork", "paintCommittedWork", "paintCommittedWork");
		timeOn(overlay, "repaintPath", "repaintPath", "repaintPath");
		timeOn(overlay.selection, "bounds", "selectionWalk", "walks");
		timeOn(overlay.selection, "selectByLasso", "selectByLasso");
		const ask = overlay.scheduleRepaint;
		overlay.scheduleRepaint = function (...a) {
			if (recording) { const via = a[0]; if (via === "partial") count.partial++; else if (via === "scroll") count.scroll++; else count.whole++; }
			return ask.apply(this, a);
		};
		const move = inlineInk.moveStrokes;
		inlineInk.moveStrokes = function (p, list, ...a) {
			if (recording) { count.moveStrokes++; count.movedIds += list.length; }
			return move.call(this, p, list, ...a);
		};
		timeOn(inlineInk, "save", "save");
		// What a repaint runs, named, and the drag picture's steps where the build has them.
		for (const k of ["syncBand", "syncCamera", "rasterPanNeedsBake", "handleResize", "extentBuildAllowed", "updateExtent", "copyFromExtent", "copyFromStandIn",
			"beginSpaceSnapshot", "beginLassoSnapshot", "drawSpacePicture", "rasterSpacePicture", "rasterSpaceRows", "dropExtentBuild"]) if (typeof overlay[k] === "function") timeOn(overlay, k, k, k === "rasterSpacePicture" ? "reRaster" : undefined);
		return { strokes: inlineInk.strokes(path).length, points: inlineInk.strokes(path).reduce((s, x) => s + x.points.length, 0), canvasMode: !!overlay.canvasMode,
			cssScale: overlay.cssScale, scale: overlay.scale, dpr: window.devicePixelRatio, scrollHeight: view.scrollDOM.scrollHeight, clientHeight: view.scrollDOM.clientHeight };
	},
	/** Lasso the strokes at or below the divider line, drag the selection, lift. Returns the samples, the lift and the named work. */
	async run(downAt, samples, all, dx, swing, narrow, dy, tall, unsettled, scrollRight) {
		const { view, overlay, path, pageId } = rig, sd = view.scrollDOM;
		sd.scrollTop = 0;
		await settle(8); await sleep(400); await settle(4);
		setInlineLassoMode(true);
		await settle(4);
		const r = sd.getBoundingClientRect(), x = r.left + r.width * 0.45, yLine = r.top + downAt;
		if (yLine + 40 + dy * samples + 20 > r.bottom + 400) throw new Error("the drag leaves the page");
		let down = false;
		const pen = (type, px, py) => {
			// The pen's target: the element under it, inside the pane (a sideways drag may take the pen past the pane's edge).
			const target = document.elementFromPoint(Math.min(Math.max(px, r.left + 2), r.right - 2), Math.min(py, r.bottom - 2));
			if (!target) throw new Error("pen point outside the page");
			const pre = recording ? { ...count } : null, t0 = performance.now();
			target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "pen", pointerId: 932, isPrimary: true,
				clientX: px, clientY: py, buttons: type === "pointerdown" || (type === "pointermove" && down) ? 1 : 0, pressure: type === "pointerdown" || (type === "pointermove" && down) ? 0.5 : 0 }));
			const t1 = performance.now();
			if (type === "pointerdown") down = true; else if (type === "pointerup") down = false;
			if (recording) events.push({ phase, type, t: t0, end: t1, ms: t1 - t0, pre });
		};
		// Warm-up, not recorded: a small lasso near the pane's top that selects nothing, and a tap that lassos nothing.
		const yWarm = r.top + 20;
		pen("pointerdown", x, yWarm); for (let i = 1; i <= 6; i++) { await sleep(16); pen("pointermove", x + 6 * i, yWarm + 3 * i); }
		pen("pointerup", x + 36, yWarm + 18); await settle(6);
		pen("pointerdown", x, yWarm); await sleep(16); pen("pointerup", x, yWarm); await settle(6); await sleep(200);
		// The selection: a real loop, its points replaced by a world rectangle from the divider line down before the lift.
		const lineY = all ? -1e6 : overlay.camera.screenToWorld(x, yLine).y;
		pen("pointerdown", x - 200, yLine + 10);
		for (let i = 1; i <= 8; i++) { await sleep(16); pen("pointermove", x - 200 + 40 * i, yLine + 10 + 5 * i); }
		const loopReached = overlay.lassoActive === true && overlay.lassoPts.length > 1;
		const far = 1e6;
		// A client point in world units as the pen router maps it: from the overlay's container, in note px.
		const cr = overlay.container.getBoundingClientRect();
		const toWorld = (px, py) => overlay.camera.screenToWorld((px - cr.left) / overlay.cssScale, (py - cr.top) / overlay.cssScale);
		const xL = narrow > 0 ? toWorld(x - narrow / 2, yLine).x : -far, xR = narrow > 0 ? toWorld(x + narrow / 2, yLine).x : far;
		const yB = narrow > 0 && tall > 0 ? toWorld(x, yLine + tall).y : far;
		overlay.lassoPts = [{ x: xL, y: lineY }, { x: xR, y: lineY }, { x: xR, y: yB }, { x: xL, y: yB }];
		pen("pointerup", x + 120, yLine + 50);
		await settle(8); await sleep(200); await settle(4);
		const selected = overlay.selection.strokeIds ? [...overlay.selection.strokeIds].length : overlay.selection.size;
		const wanted = new Set(overlay.selection.strokeIds);
		const r0selected = wanted.size;
		const movingPoints = inlineInk.strokes(path).filter(s => wanted.has(s.id)).reduce((s, x) => s + x.points.length, 0);
		const sumY = () => inlineInk.strokes(path).reduce((a, s) => a + s.points[0].y, 0), sumX = () => inlineInk.strokes(path).reduce((a, s) => a + s.points[0].x, 0);
		const before = { sumY: sumY(), sumX: sumX() };
		// The drag, recorded: pen-down inside the selection, the moves, the lift.
		// The grab: 40 css px below the line, or, for a narrow box, the first point 4 css px apart down from the line inside it.
		// A narrow box of a set height: the grab at its centre.
		let yGrab = yLine + 40, gx = x;
		const sb = narrow > 0 ? overlay.selectionBounds() : null;
		if (sb && tall > 0) {
			const o = toWorld(x, yLine), ux = toWorld(x + 1, yLine).x - o.x, uy = toWorld(x, yLine + 1).y - o.y;
			gx = x + (sb.x + sb.width / 2 - o.x) / ux; yGrab = yLine + (sb.y + sb.height / 2 - o.y) / uy;
		} else if (sb) {
			for (let y = yLine + 10; y < r.bottom - 20; y += 4) {
				const w = toWorld(x, y);
				if (w.x >= sb.x && w.x <= sb.x + sb.width && w.y >= sb.y && w.y <= sb.y + sb.height) { yGrab = y; break; }
			}
		}
		// THE BAND SETTLED BEFORE THE GRAB: the extent granted and the band placed over the ink, so a lift that adds no extent
		// paints into the layers the picture was taken over. Settled: the committed canvas's place held over three rounds with no
		// extent build running.
		const placeNow = () => { const b = overlay.committedCanvas.getBoundingClientRect(); return [b.left, b.top, b.width, b.height, overlay.committedCanvas.width, overlay.committedCanvas.height].join(","); };
		let held = 0, settleRounds = 0, placeWas = placeNow();
		const placeAtStart = placeWas;
		if (!unsettled) for (; settleRounds < 40 && held < 3; settleRounds++) {
			overlay.updateExtent(true);
			overlay.scheduleRepaint();
			await settle(2); await sleep(30);
			const p = placeNow();
			held = p === placeWas && !overlay.extentBuild ? held + 1 : 0;
			placeWas = p;
		}
		const band = { settled: held >= 3, rounds: settleRounds, moved: placeWas !== placeAtStart, unsettled: !!unsettled };
		recording = true;
		phase = "down";
		pen("pointerdown", gx, yGrab);
		const grabbed = !!overlay.dragFrom && !!overlay.dragTotal;
		const dragIds = overlay.dragIds ? overlay.dragIds.length : null;
		await settle(2);
		phase = "drag";
		// The pen's sideways offset after i samples: dx per sample, turned back at the swing either side when one is set.
		const side = i => {
			const t = dx * i;
			if (!(swing > 0)) return t;
			const p = ((t % (4 * swing)) + 4 * swing) % (4 * swing);
			return p < swing ? p : p < 3 * swing ? 2 * swing - p : p - 4 * swing;
		};
		const tailCss = overlay.tailCanvas.getBoundingClientRect().width;
		for (let i = 1; i <= samples; i++) { await sleep(16); pen("pointermove", gx + side(i), yGrab + dy * i); }
		await sleep(16);
		const lastMoveDone = { ...count };
		await settle(2);
		// The picture before the lift, not recorded: the tail drawn once more with the selection box left out, its alpha centroid;
		// and the committed and highlight layers as they stand.
		// In screen device px: each canvas's pixel mapped through its own box on the page, read with it (a band move or resize at
		// the lift moves the canvas, not the ink).
		// Counted only inside the pane where the tail covered it before the lift: a band that grows at the lift's resize shows ink at
		// the pane's edge that the tail never covered, which is not a move.
		const dprNow = window.devicePixelRatio, paneBox = view.scrollDOM.getBoundingClientRect(), tailBox = overlay.tailCanvas.getBoundingClientRect();
		const pane = { left: Math.max(paneBox.left, tailBox.left), right: Math.min(paneBox.right, tailBox.right), top: Math.max(paneBox.top, tailBox.top), bottom: Math.min(paneBox.bottom, tailBox.bottom) };
		const inPane = (X, Y) => X >= pane.left * dprNow && X < pane.right * dprNow && Y >= pane.top * dprNow && Y < pane.bottom * dprNow;
		const centroid = (pairs, keep = null) => {
			let sx = 0, sy = 0, sw = 0;
			for (const [c, before] of pairs) {
				if (!c || c.width === 0) continue;
				const box = c.getBoundingClientRect(), fx = box.width * dprNow / c.width, fy = box.height * dprNow / c.height;
				const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
				// A layer reallocated at the lift (another size) holds only what the lift painted: nothing to take away.
				const was = before && before.length === d.length ? before : null;
				for (let i = 3, n = 0; i < d.length; i += 4, n++) {
					const a = d[i] - (was ? was[i] : 0);
					if (a <= 0) continue;
					const X = box.left * dprNow + (n % c.width + 0.5) * fx, Y = box.top * dprNow + (Math.floor(n / c.width) + 0.5) * fy;
					if (inPane(X, Y) && (!keep || keep(X, Y))) { sx += a * X; sy += a * Y; sw += a; }
				}
			}
			return sw > 0 ? { x: sx / sw, y: sy / sw, alpha: sw } : { x: null, y: null, alpha: 0 };
		};
		const placeOf = c => { const b = c.getBoundingClientRect(); return [b.left, b.top, b.width, b.height, c.width, c.height].join(","); };
		const was = recording; recording = false;
		const box = overlay.tail.drawSelectionBox;
		overlay.tail.drawSelectionBox = () => {};
		try { overlay.redrawSelectionUI(); } finally { overlay.tail.drawSelectionBox = box; }
		const pictureAt = centroid([[overlay.tailCanvas, null]]);
		const grab = c => c && c.width ? c.getContext("2d").getImageData(0, 0, c.width, c.height).data : null;
		const layersBefore = [grab(overlay.committedCanvas), grab(overlay.highlightCanvas)];
		const placeBefore = placeOf(overlay.committedCanvas);
		// Where staying ink sat before the lift (any alpha within a device px on the committed or highlight layer): moved ink the
		// lift paints over it adds less alpha than it has, which pulls the painted centroid off the picture's. The clear centroids
		// count only device px with no staying ink near them, on the tail and on the layers alike.
		const near = (c, data, X, Y) => {
			if (!c || !data) return false;
			const b = c.getBoundingClientRect(), cx = Math.floor((X / dprNow - b.left) * c.width / b.width), cy = Math.floor((Y / dprNow - b.top) * c.height / b.height);
			for (let j = cy - 1; j <= cy + 1; j++) for (let i = cx - 1; i <= cx + 1; i++)
				if (i >= 0 && j >= 0 && i < c.width && j < c.height && data[(j * c.width + i) * 4 + 3] > 0) return true;
			return false;
		};
		const clear = (X, Y) => !near(overlay.committedCanvas, layersBefore[0], X, Y) && !near(overlay.highlightCanvas, layersBefore[1], X, Y);
		const pictureClear = centroid([[overlay.tailCanvas, null]], clear);
		// The committed and highlight layers' ink inside the pane just before the lift: with every stroke selected, none.
		const committedBefore = centroid([[overlay.committedCanvas, null], [overlay.highlightCanvas, null]]).alpha;
		const viewAt = () => ({ scrollLeft: sd.scrollLeft, scrollTop: sd.scrollTop, camX: overlay.camera.x, camY: overlay.camera.y, zoom: overlay.camera.zoom, place: placeOf(overlay.committedCanvas),
			picture: overlay.spaceSnapshot?.canvas ? { col: overlay.spaceSnapshot.col, w: overlay.spaceSnapshot.canvas.width, top: overlay.spaceSnapshot.top, lo: overlay.spaceSnapshot.lo, done: overlay.spaceSnapshot.done, bottom: overlay.spaceSnapshot.bottom } : null });
		const viewBefore = viewAt();
		// The band and the container's right edge before the lift, and that edge in world units, for the scroll after it.
		const bandBefore = overlay.band ? { ...overlay.band } : null, edgeBefore = overlay.container.getBoundingClientRect().right;
		const edgeWorld = toWorld(edgeBefore, yGrab).x, scrollLeftBefore = sd.scrollLeft;
		overlay.redrawSelectionUI();
		recording = was;
		phase = "lift";
		pen("pointerup", gx + side(samples), yGrab + dy * samples);
		let quiet = 0, n = 0;
		for (; n < 90 && quiet < 10; n++) {
			const b = frames.size;
			await frame();
			await sleep(0);
			quiet = frames.size === b ? quiet + 1 : 0;
		}
		recording = false;
		phase = "done";
		const paintedAt = centroid([[overlay.committedCanvas, layersBefore[0]], [overlay.highlightCanvas, layersBefore[1]]]);
		const paintedClear = centroid([[overlay.committedCanvas, layersBefore[0]], [overlay.highlightCanvas, layersBefore[1]]], clear);
		const layerHeld = placeOf(overlay.committedCanvas) === placeBefore;
		const viewAfter = viewAt();
		const bandAfter = overlay.band ? { ...overlay.band } : null;
		// SCROLLED RIGHT AFTER THE LIFT: the ink moved past the old band's right edge shows in the pane. The edge's place on screen
		// after the scroll, and the committed and highlight layers' ink right of it inside the pane; the store's moved ink past it.
		let pastEdge = null;
		if (scrollRight) {
			const inkPast = inlineInk.strokes(path).filter(s => wanted.has(s.id) && s.bbox.x + s.bbox.width > edgeWorld).length;
			// The old edge to the pane's left: everything the pane shows then lies past it.
			sd.scrollLeft = Math.min(sd.scrollWidth - sd.clientWidth, sd.scrollLeft + (edgeBefore - sd.getBoundingClientRect().left) / overlay.cssScale);
			await settle(8); await sleep(200); await settle(8);
			const moved = (sd.scrollLeft - scrollLeftBefore) * overlay.cssScale, edgeNow = edgeBefore - moved;
			const shown = centroid([[overlay.committedCanvas, null], [overlay.highlightCanvas, null]], X => X / dprNow >= edgeNow);
			pastEdge = { inkPast, scrolled: moved, edgeNow, paneRight: view.scrollDOM.getBoundingClientRect().right, shownAlpha: shown.alpha, band: overlay.band ? { ...overlay.band } : null };
		}
		const sizes = { tail: [overlay.tailCanvas.width, overlay.tailCanvas.height], committed: [overlay.committedCanvas.width, overlay.committedCanvas.height] };
		const page = pending.get(pageId);
		let persistMs = null;
		if (page) { const t0 = performance.now(); serializePage(page); persistMs = performance.now() - t0; }
		const sideways = { dx, swing, narrow, yGrab, yLine, gx, grabWorld: toWorld(gx, yGrab), box0: sb, tailCss, travelTails: Math.abs(dx) * samples / Math.max(1, tailCss), endOffset: side(samples) };
		return { band, bandBefore, bandAfter, pastEdge, sideways, committedBefore, viewBefore, viewAfter, pictureAt, paintedAt, pictureClear, paintedClear, layerHeld, stayingStrokes: inlineInk.strokes(path).length - r0selected, sizes, loopReached, lineY, selected, movingPoints, grabbed, dragIds, frames: [...frames.values()].sort((a, b) => a.ts - b.ts), events, work, lastMoveDone, count: { ...count },
			movedInk: sumY() !== before.sumY || sumX() !== before.sumX, persistMs, pendingSaved: !!page, liftFrames: n, liftQuiet: quiet };
	},
};
`;

let browser: Browser, script: string;
const record: unknown[] = [];
beforeAll(async () => {
	if (!ENABLED) return;
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "lassoDragPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true, args: [`--force-device-scale-factor=${DPR}`, "--window-size=1800,900"] });
}, 180_000);
afterAll(async () => {
	await browser?.close();
	if (process.env.HW_LDC_OUT) writeFileSync(process.env.HW_LDC_OUT, JSON.stringify(record, null, 1));
});

type Frame = { ts: number; phase: string; rafMs: number; callbacks: number; at: number; end: number };
type Counts = Record<string, number>;
type Ev = { phase: string; type: string; t: number; end: number; ms: number; pre: Counts };
const f2 = (n: number | null) => n === null ? null : Math.round(n * 100) / 100;
const pct = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]! : null; };
const diff = (a: Counts, b: Counts) => Object.fromEntries(Object.keys(b).map(k => [k, b[k]! - (a[k] ?? 0)]));

/**
 * The bounds: the samples' plugin work, median at most 6.5 ms and p95 at most 12.5 ms on Exam 4 Study (a quarter and a third of the
 * measured 26 and 37.6 ms), 3.7 and 7.0 ms on MCB EXAM 4 (the same ratios of its 14.8 and 20.9 ms); the lift's wall at most 58 ms on Exam 4 Study and 47 on MCB EXAM 4 (the measured median plus 10 percent with the store moved
 * at the lift); the pen-down's repaint at most 46.2 ms on Exam 4 Study (the median of three interleaved quiet runs, 42.0, plus 10 percent)
 * and 27.8 ms on MCB EXAM 4 (its median plus 10 percent), with the picture narrowed to the columns shown.
 */
const DRAG_MEDIAN_MS = Number(process.env.HW_LDC_MEDIAN ?? "6.5");
const DRAG_P95_MS = Number(process.env.HW_LDC_P95 ?? "12.5");
const LIFT_MS = Number(process.env.HW_LDC_LIFT ?? "58");
const GRAB_MS = Number(process.env.HW_LDC_GRAB ?? "46.2");
const gated = ENABLED ? it : it.skip;
gated(`lasso drag of most of the note's ink: ${SAMPLES} samples and the lift recorded; the samples move nothing in the store and repaint no committed ink; work median at most ${DRAG_MEDIAN_MS} ms, p95 at most ${DRAG_P95_MS} ms; the lift under ${LIFT_MS} ms and within ${SHIFT_MAX} device px of the picture`, async () => {
	const page = await (await browser.newContext({ viewport: null })).newPage();
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	try {
		await page.setContent(`<!doctype html><body class="theme-dark" style="margin:0; --font-text-size:26px; --background-modifier-border:#777777"></body>`);
		await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
		await page.addStyleTag({ content: MINIMAL_CSS });
		await page.addScriptTag({ content: script });
		const mounted = await page.evaluate(([s, id, t]) => (window as any).lassoDrag.mount(s, id, t), [readFileSync(SIDECAR_PATH, "utf8"), PAGE_ID, NOTE_TEXT] as const) as any;
		const r = await page.evaluate(([d, n, a, dx, sw, nw, dy, nh, un, sr]) => (window as any).lassoDrag.run(d, n, a, dx, sw, nw, dy, nh, un, sr), [DOWN, SAMPLES, ALL, DX, SWING, NARROW, DY, NARROW_H, UNSETTLED, SCROLL_RIGHT] as const) as any;
		const frames = r.frames as Frame[], evs = (r.events as Ev[]).sort((a, b) => a.t - b.t);
		// Per drag sample: from the move's dispatch to the next move's (the last: to the end of the drag phase).
		const moves = evs.filter(e => e.phase === "drag" && e.type === "pointermove");
		const lift = evs.find(e => e.phase === "lift" && e.type === "pointerup");
		// Counts per sample: from just before the move's dispatch to just before the next move's (the last: after the drag's last wait).
		const samples = moves.map((m, i) => {
			const next = moves[i + 1]?.t ?? lift?.t ?? Infinity;
			const fr = frames.filter(f => f.at >= m.end && f.at < next);
			const first = fr[0];
			const c = diff(m.pre, (moves[i + 1]?.pre ?? r.lastMoveDone) as Counts);
			return { i: i + 1, handlerMs: f2(m.ms), frameMs: f2(fr.reduce((s, f) => s + f.rafMs, 0)), workMs: f2(m.ms + fr.reduce((s, f) => s + f.rafMs, 0)),
				wallMs: first ? f2(first.end - m.t) : null, frames: fr.length, ...c, pointsTranslated: c.moveStrokes! > 0 ? c.movedIds! / Math.max(1, r.dragIds) * r.movingPoints : 0 };
		});
		const downEv = evs.find(e => e.phase === "down");
		const liftFrames = frames.filter(f => f.phase === "lift");
		const liftOut = lift ? { handlerMs: f2(lift.ms), frames: liftFrames.length, frameMs: f2(liftFrames.reduce((s, f) => s + f.rafMs, 0)),
			wallMs: f2((liftFrames.at(-1)?.end ?? lift.end) - lift.t), commitLiveDrag: r.work["lift:commitLiveDrag"] ?? null, save: r.work["lift:save"] ?? null,
			retakeLineAnchors: r.work["lift:retakeLineAnchors"] ?? null, dispatchInk: r.work["lift:dispatchInk"] ?? null, persistMs: f2(r.persistMs), counts: diff(lift.pre, r.count as Counts) } : null;
		const col = (k: string) => samples.map(s => (s as any)[k] as number).filter(v => v !== null);
		const stat = (k: string) => ({ median: f2(pct(col(k), 0.5)), p95: f2(pct(col(k), 0.95)), max: f2(Math.max(...col(k))), mean: f2(col(k).reduce((a, b) => a + b, 0) / Math.max(1, col(k).length)) });
		const summary = { pageId: PAGE_ID, all: ALL, dpr: DPR, regime: `forced --force-device-scale-factor ${DPR}; the page sets no deviceScaleFactor`, down: DOWN, mounted, lineY: r.lineY, loopReached: r.loopReached,
			selected: r.selected, selectedShare: Math.round(1000 * r.selected / mounted.strokes) / 10, movingPoints: r.movingPoints, grabbed: r.grabbed, dragIds: r.dragIds,
			penDown: downEv ? { handlerMs: f2(downEv.ms) } : null,
			perSample: { workMs: stat("workMs"), wallMs: stat("wallMs"), handlerMs: stat("handlerMs"), frameMs: stat("frameMs"), selectionBounds: stat("selectionBounds"), walks: stat("walks"),
				pointsTranslated: stat("pointsTranslated"), canvasNew: stat("canvasNew"), path2d: stat("path2d"), partial: stat("partial"), whole: stat("whole"), scroll: stat("scroll"), repaintPath: stat("repaintPath"),
				redrawSelectionUI: stat("redrawSelectionUI"), paintCommittedWork: stat("paintCommittedWork"), moveStrokes: stat("moveStrokes"), reRaster: stat("reRaster") },
			// The samples that re-rastered the picture (the drag left its window), named with their work.
			reRasters: samples.filter(s => (s as any).reRaster > 0).map(s => ({ i: s.i, reRaster: (s as any).reRaster, workMs: s.workMs, wallMs: s.wallMs })), sideways: r.sideways,
			band: r.band, bandBefore: r.bandBefore, bandAfter: r.bandAfter, pastEdge: r.pastEdge, liftResize: r.work["lift:handleResize"]?.n ?? 0, lift: liftOut, pictureAt: r.pictureAt, paintedAt: r.paintedAt, pictureClear: r.pictureClear, paintedClear: r.paintedClear, committedBefore: r.committedBefore, viewBefore: r.viewBefore, viewAfter: r.viewAfter, layerHeld: r.layerHeld, stayingStrokes: r.stayingStrokes, sizes: r.sizes, movedInk: r.movedInk, pendingSaved: r.pendingSaved, liftQuiet: r.liftQuiet, work: r.work };
		record.push({ summary, samples, frames, events: evs });
		console.log("LASSO-DRAG " + JSON.stringify(summary));
		const brief = "\n" + JSON.stringify({ ...summary, work: undefined }, null, 1);
		expect(errors, "page errors").toEqual([]);
		// PREMISES: the note, the setup's ratio and camera, the loop reached the lasso, the selection is the divider line's share, the
		// pen-down grabbed it, every move reached the drag, the lift committed once and the ink moved.
		expect(mounted.strokes, `premise: the note's strokes${brief}`).toBe(STROKES);
		expect(mounted.canvasMode, `premise: canvas off${brief}`).toBe(false);
		expect(Math.abs(mounted.dpr - DPR), `premise: dpr ${DPR}${brief}`).toBeLessThan(0.001);
		expect(r.loopReached, `premise: the pen drew a lasso loop${brief}`).toBe(true);
		expect(summary.selectedShare > SHARE_MIN && summary.selectedShare <= SHARE_MAX, `premise: the selected share in (${SHARE_MIN}, ${SHARE_MAX}] percent (${summary.selectedShare})${brief}`).toBe(true);
		expect([r.grabbed, r.dragIds], `premise: the pen-down grabbed the whole selection${brief}`).toEqual([true, r.selected]);
		expect(samples.length, `premise: ${SAMPLES} drag samples${brief}`).toBe(SAMPLES);
		expect(r.work["drag:lassoMove"]?.n ?? 0, `premise: every sample reached the selection's drag${brief}`).toBe(SAMPLES);
		expect(r.work["lift:commitLiveDrag"]?.n ?? 0, `premise: the lift committed the drag once${brief}`).toBe(1);
		// A drag of no distance (the no-move control) moves nothing.
		expect(r.movedInk, `premise: committed ink moved, or none for a drag of no distance${brief}`).toBe(DX !== 0 || DY !== 0);
		// The drag reads the selection's box frozen at pen-down: no sample walks the note's strokes for the bounds.
		expect(r.work["drag:selectionWalk"]?.n ?? 0, `no selection walk over the note's strokes in any drag sample${brief}`).toBe(0);
		// The samples carry the ink as a picture: no store move, no committed repaint ask or paint, no other pane, no new canvas.
		const most = (k: string) => Math.max(0, ...samples.map(x => (x as any)[k] as number));
		expect({ moveStrokes: most("moveStrokes"), partial: most("partial"), whole: most("whole"), paintCommittedWork: most("paintCommittedWork"), repaintPath: most("repaintPath"), canvasNew: most("canvasNew") },
			`the drag samples: no store move, no committed repaint, no other pane, no canvas made${brief}`).toEqual({ moveStrokes: 0, partial: 0, whole: 0, paintCommittedWork: 0, repaintPath: 0, canvasNew: 0 });
		// The lift: the ink the pen-up painted sits where the picture showed it.
		const pic = r.pictureAt, put = r.paintedAt;
		expect([pic.alpha > 0, put.alpha > 0], `premise: the picture on the tail before the lift and the ink the lift painted both hold ink${brief}`).toEqual([true, true]);
		// During the drag the committed layers paint without the selected ink: with every stroke selected they hold none.
		if (r.stayingStrokes === 0) expect(r.committedBefore, `the committed layers held the selected ink during the drag${brief}`).toBe(0);
		// The lift: the ink the pen-up painted sits where the picture showed it, under SHIFT_MAX device px in both axes, over the
		// pixels the layers held clear before the lift, the band settled before the grab and the committed layer holding its place
		// through the lift. The shift over all the ink is reported: where moving ink crosses staying ink the stacking differs.
		// An unsettled run reports the shift.
		const cpic = r.pictureClear, cput = r.paintedClear;
		console.log(`LASSO-DRAG lift shift, all ink ${f2(put.x - pic.x)}, ${f2(put.y - pic.y)}; clear ${f2(cput.x - cpic.x)}, ${f2(cput.y - cpic.y)} device px; clear alpha ${cpic.alpha} of ${pic.alpha}`);
		if (!UNSETTLED) {
			expect([r.band.settled, r.layerHeld], `premise: the band settled before the grab (${r.band.rounds} rounds) and the committed layer held its place at the lift${brief}`).toEqual([true, true]);
			expect(cpic.alpha > pic.alpha / 2, `premise: more than half the picture's ink lies where the layers were clear (${cpic.alpha} of ${pic.alpha})${brief}`).toBe(true);
			expect([Math.abs(cpic.x - cput.x) < SHIFT_MAX, Math.abs(cpic.y - cput.y) < SHIFT_MAX],
				`the lift moved the ink ${f2(cput.x - cpic.x)}, ${f2(cput.y - cpic.y)} device px from the picture, where the layers were clear${brief}`).toEqual([true, true]);
		}
		// THE LIFT HOLDS THE BAND: a lift that needs no new pixels on screen keeps the committed layer where and as big as it was, runs
		// no handleResize, and lands where the picture showed it, the band settled first or not.
		if (HOLD) {
			expect([r.layerHeld, summary.liftResize], `the lift held the committed layer and ran no handleResize (band ${JSON.stringify(r.bandBefore)} to ${JSON.stringify(r.bandAfter)})${brief}`).toEqual([true, 0]);
			expect([Math.abs(cpic.x - cput.x) < SHIFT_MAX, Math.abs(cpic.y - cput.y) < SHIFT_MAX],
				`the lift moved the ink ${f2(cput.x - cpic.x)}, ${f2(cput.y - cpic.y)} device px from the picture, where the layers were clear${brief}`).toEqual([true, true]);
		}
		// Scrolled right after the lift: the moved ink past the old band's right edge is painted where the pane now shows it.
		if (SCROLL_RIGHT) {
			const e = r.pastEdge;
			expect([e.inkPast > 0, e.scrolled > 0, e.edgeNow < e.paneRight], `premise: moved ink lies past the old band's edge, the pane scrolled right and shows that edge${brief}`).toEqual([true, true, true]);
			expect(e.shownAlpha, `ink past the old band's right edge painted after the scroll${brief}`).toBeGreaterThan(0);
		}
		if (UNSETTLED && !HOLD) console.log(`LASSO-DRAG UNSETTLED lift shift ${f2(put.x - pic.x)}, ${f2(put.y - pic.y)} device px (layer held ${r.layerHeld}), reported, not asserted`);
		// THE CLAIM: the samples' plugin work, median and p95, within the bounds, and the lift's wall.
		const w = summary.perSample.workMs;
		expect([Number(w.median) <= timingBound(DRAG_MEDIAN_MS), Number(w.p95) <= timingBound(DRAG_P95_MS)],
			`the drag samples' work: median ${w.median} ms (bound ${timingBound(DRAG_MEDIAN_MS)}), p95 ${w.p95} ms (bound ${timingBound(DRAG_P95_MS)})${brief}`).toEqual([true, true]);
		if (RERASTER !== null) expect(samples.reduce((a, s) => a + ((s as any).reRaster as number), 0), `the drag samples' picture re-rasters${brief}`).toBe(RERASTER);
		const grabMs = f2(r.work["down:repaint"]?.ms ?? 0);
		expect(Number(grabMs), `the pen-down's repaint ${grabMs} ms (bound ${timingBound(GRAB_MS)})${brief}`).toBeLessThanOrEqual(timingBound(GRAB_MS));
		expect(Number(liftOut?.wallMs), `the lift's wall ${liftOut?.wallMs} ms (bound ${timingBound(LIFT_MS)})${brief}`).toBeLessThanOrEqual(timingBound(LIFT_MS));
	} finally { await page.close(); }
}, 600_000);
