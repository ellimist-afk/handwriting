/**
 * Page half of PanBakeRepaint.test.ts. Mounts a note with a lot of ink under the real overlay, with Infinite Canvas on and
 * the zoom committed low, and records what each repaint DREW: whether it came from a settled-pan bake, whether a bounce was
 * playing, the work the committed layer was given ("all" or strips) and how many paths the committed canvas received.
 * Counting only; nothing here changes what the overlay does.
 */
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { Platform } from "obsidian";
import { inlineInk, inkOverlayExtension, overlayForPath, repaintAllInkOverlays, setScrollExpansionEnabled, setInlineTool, cameraWithin, CAMERA_STILL_BACKING_PX } from "../../src/inline/InkOverlay";
import { setInkShaping } from "../../src/ink/InkShape";
import { setDiagnosticsEnabled } from "../../src/diag/DiagSwitch";
import { setPenInk } from "../../src/inline/PenInk";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField } from "./iphoneObsidianStub";
import { parsePage, serializePage } from "../../src/model/PageData";
import { drawCommitted, drawStroke } from "../../src/ink/StrokeRenderer";

installObsidianDom();
Object.assign(Platform, { isMobile: false, isDesktop: true, isIosApp: false, isAndroidApp: false, isDesktopApp: true, isMobileApp: false, isPhone: false, isTablet: false, isWin: true });

const ids = new Map<string, string>(), sidecars = new Map<string, string>();
const save = (id: string, page: any) => { sidecars.set(id, serializePage(page)); };
(inlineInk as any).attachHost({ readPageId: (p: string) => ids.get(p) ?? null, claimId: async (p: string, id: string) => { ids.set(p, id); return { pageId: id }; },
	loadSidecar: async (id: string) => (sidecars.has(id) ? parsePage(sidecars.get(id)!, id) : null), scheduleSidecar: save, scheduleSidecarNow: async (id: string, p: any) => save(id, p), notify: () => {} });

const frame = () => new Promise<void>(r => requestAnimationFrame(() => r()));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await frame(); };
let rig: any = null;

function installSizer(view: EditorView) {
	const sizer = document.createElement("div"); sizer.className = "cm-sizer";
	const container = document.createElement("div"); container.className = "cm-contentContainer";
	view.contentDOM.parentElement!.insertBefore(sizer, view.contentDOM); sizer.appendChild(container); container.appendChild(view.contentDOM);
	void view.scrollDOM.clientWidth;
}

type Cam = { x: number; y: number; zoom: number };
type Rect = { x: number; y: number; width: number; height: number };
type Diff = { differ: number; inked: number; over24: number; maxDelta: number; edge: number; pmOver24: number; pmMax: number };
const NO_DIFF: Diff = { differ: 0, inked: 0, over24: 0, maxDelta: 0, edge: 0, pmOver24: 0, pmMax: 0 };

/** The device px a check reads: the whole layer, or the pixels wholly inside `rect` (a strip's edge pixels take their value from strokes beyond it). */
function checkWindow(W: number, H: number, cam: Cam, k: number, rect: Rect | null) {
	if (!rect) return { x0: 0, y0: 0, x1: W, y1: H };
	return {
		x0: Math.max(0, Math.ceil((rect.x - cam.x) * k) + 1), y0: Math.max(0, Math.ceil((rect.y - cam.y) * k) + 1),
		x1: Math.min(W, Math.floor((rect.x + rect.width - cam.x) * k) - 1), y1: Math.min(H, Math.floor((rect.y + rect.height - cam.y) * k) - 1),
	};
}

/** Layer pixels `p` against reference pixels `q` of the same window: differing px, inked px of the reference, over 24 of 255, largest delta, outer-edge px, and over 24 and largest delta on premultiplied RGBA. */
function diffPixels(p: Uint8ClampedArray, q: Uint8ClampedArray, x0: number, y0: number, w: number, W: number, H: number): Diff {
	let differ = 0, inked = 0, over24 = 0, maxDelta = 0, edge = 0, pmOver24 = 0, pmMax = 0;
	const pm = (d: Uint8ClampedArray, i: number, c: number) => (c === 3 ? d[i + 3]! : Math.round(d[i + c]! * d[i + 3]! / 255));
	for (let i = 0; i < p.length; i += 4) {
		const d = Math.max(Math.abs(p[i]! - q[i]!), Math.abs(p[i + 1]! - q[i + 1]!), Math.abs(p[i + 2]! - q[i + 2]!), Math.abs(p[i + 3]! - q[i + 3]!));
		if (d > 0) {
			differ++;
			if (d > 24) over24++;
			if (d > maxDelta) maxDelta = d;
			// A pixel in the canvas's outer column or row: where a whole-layer path draw culls strokes a raster still holds.
			const x = x0 + (i / 4) % w, y = y0 + Math.floor(i / 4 / w);
			if (x === 0 || y === 0 || x === W - 1 || y === H - 1) edge++;
			let e = 0;
			for (let c = 0; c < 4; c++) e = Math.max(e, Math.abs(pm(p, i, c) - pm(q, i, c)));
			if (e > 24) pmOver24++;
			if (e > pmMax) pmMax = e;
		}
		if (q[i + 3] !== 0) inked++;
	}
	return { differ, inked, over24, maxDelta, edge, pmOver24, pmMax };
}

function scratchCtx(key: "scratchA" | "scratchB", w: number, h: number): CanvasRenderingContext2D {
	const c: HTMLCanvasElement = rig[key] ?? (rig[key] = document.createElement("canvas"));
	if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
	const x = c.getContext("2d")!;
	x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, w, h);
	return x;
}

/**
 * The layer against a direct paint at its own camera on a canvas the layer's own size: every stroke of the store drawn by path
 * with the committed context's transform. Recorded, not a bar for a copy: a canvas edge, like a clip edge, changes how the renderer
 * fills a path that crosses it, and the raster has no edge where the layer has one.
 */
function directDiff(overlay: any, cam: Cam, rect: Rect | null): Diff {
	const c = overlay.committedCanvas as HTMLCanvasElement, W = c.width, H = c.height, backing = overlay.committedBacking;
	const sx = scratchCtx("scratchA", W, H);
	sx.setTransform(overlay.committedCtx.getTransform());
	drawCommitted(sx, cam, inlineInk.strokes(rig.path), overlay.cssWidth, overlay.cssHeight, true, "pen", false, backing === null ? undefined : { backing, dpr: overlay.dpr });
	const { x0, y0, x1, y1 } = checkWindow(W, H, cam, cam.zoom * backing, rect);
	if (!(x1 > x0) || !(y1 > y0)) return NO_DIFF;
	return diffPixels(overlay.committedCtx.getImageData(x0, y0, x1 - x0, y1 - y0).data, sx.getImageData(x0, y0, x1 - x0, y1 - y0).data, x0, y0, x1 - x0, W, H);
}

/**
 * A fill by copy against its reference: the store's current ink drawn by the committed layer's own path painter (drawCommitted)
 * on a canvas of the raster's own size at the raster's camera, both computed here by the branch's rule from the strokes the raster
 * holds and the camera it was built at, never read from the raster, and read back at the copy's whole-pixel offset, taken from the
 * camera's move since the build. Exact: a stale raster, or a copy moved by one pixel, differs. `frameOk` is the premise that the
 * raster stands in that frame (scale, origin, size), so a raster in the wrong frame cannot carry its reference with it.
 */
function rasterFrameDiff(overlay: any, ext: any, cam: Cam, rect: Rect | null): Diff & { frameOk: boolean } {
	const c = overlay.committedCanvas as HTMLCanvasElement, W = c.width, H = c.height, b = overlay.committedBacking;
	const k = ext.cam0.zoom * b;
	let ix0 = Infinity, iy0 = Infinity, ix1 = -Infinity, iy1 = -Infinity;
	for (const s of ext.strokes as Array<{ bbox: Rect }>) {
		ix0 = Math.min(ix0, s.bbox.x); iy0 = Math.min(iy0, s.bbox.y); ix1 = Math.max(ix1, s.bbox.x + s.bbox.width); iy1 = Math.max(iy1, s.bbox.y + s.bbox.height);
	}
	// The branch's rule: the origin on the committed raster's device grid two px outside the ink's extent, the size two px past it.
	const kx = Math.floor((ix0 - ext.cam0.x) * k) - 2, ky = Math.floor((iy0 - ext.cam0.y) * k) - 2;
	const rw = Math.ceil((ix1 - ext.cam0.x) * k) + 2 - kx, rh = Math.ceil((iy1 - ext.cam0.y) * k) + 2 - ky;
	const frameOk = ext.backing === b && ext.cam0.zoom === cam.zoom && ext.kx === kx && ext.ky === ky && ext.pen.width === rw && ext.pen.height === rh;
	const offX = Math.round((cam.x - ext.cam0.x) * k) - kx, offY = Math.round((cam.y - ext.cam0.y) * k) - ky;
	const { x0, y0, x1, y1 } = checkWindow(W, H, cam, cam.zoom * b, rect);
	if (!(x1 > x0) || !(y1 > y0)) return { ...NO_DIFF, frameOk };
	// Layer pixel (x, y) is reference pixel (x + offX, y + offY); reference pixels outside its canvas read transparent, as the
	// raster holds no ink there.
	const sx = scratchCtx("scratchB", Math.max(1, rw), Math.max(1, rh));
	sx.setTransform(b, 0, 0, b, 0, 0);
	const at = { x: ext.cam0.x + kx / k, y: ext.cam0.y + ky / k, zoom: ext.cam0.zoom };
	drawCommitted(sx, at, inlineInk.strokes(rig.path), rw / b, rh / b, true, "pen", false, { backing: b, dpr: overlay.dpr });
	const d = diffPixels(overlay.committedCtx.getImageData(x0, y0, x1 - x0, y1 - y0).data, sx.getImageData(x0 + offX, y0 + offY, x1 - x0, y1 - y0).data, x0, y0, x1 - x0, W, H);
	return { ...d, frameOk };
}

(window as any).panBake = {
	/** Every copy's layer against a whole redraw at the layer's size, since the last call. */
	copyLog() { const l = rig.copyLog ?? []; rig.copyLog = []; return l; },
	async mount(zoom: number, sidecar: string, pageId: string, paneW: number, paneH: number, wantStrokes: number) {
		setDiagnosticsEnabled(false);
		setPenInk(true); setScrollExpansionEnabled(true); setInlineTool("pen");
		const path = "Untitled 1.md";
		sidecars.set(pageId, sidecar); ids.set(path, pageId);
		const pane = document.body.appendChild(document.createElement("div"));
		pane.className = "markdown-source-view mod-cm6";
		pane.style.cssText = "position:relative;margin-left:300px;margin-top:20px;width:" + paneW + "px;height:" + paneH + "px;overflow:hidden";
		document.body.classList.add("handwriting-paper-lines");
		const view = new EditorView({ parent: pane, state: EditorState.create({ doc: "\n\n\n", extensions: [history(), EditorView.lineWrapping,
			editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} })), inkOverlayExtension(),
			EditorView.theme({ "&": { width: paneW + "px", height: paneH + "px" }, ".cm-scroller": { overflowY: "auto", overflowX: "hidden" } })] }) });
		installSizer(view);
		for (let i = 0; i < 60 && wantStrokes > 0 && inlineInk.strokes(path).length === 0; i++) await settle(2);
		await settle(12);
		const overlay: any = overlayForPath(path);
		if (!overlay) throw new Error("no overlay");
		rig = { pane, view, overlay, path, rows: [], phase: "mount", cnt: { fills: 0, pts: 0 }, restore: null };
		overlay.updateExtent(true);
		await settle(12);
		const zoomCommitted = !!overlay.commitCameraScale(zoom, { left: 0, top: 0 });
		await settle(12);
		overlay.scheduleRepaint("other");
		await settle(8);
		await settle(4);
		const sd = view.scrollDOM, r = sd.getBoundingClientRect();
		return { strokes: inlineInk.strokes(path).length, canvasMode: !!overlay.canvasMode, scale: overlay.scale, cssScale: overlay.cssScale, dpr: window.devicePixelRatio,
			zoomCommitted, scrollRect: { left: r.left, top: r.top, width: r.width, height: r.height }, committed: [overlay.committedCanvas.width, overlay.committedCanvas.height],
			bakeNow: !!overlay.rasterPanNeedsBake(), pan: { ...overlay.viewportPan }, rasterPan: overlay.rasterPan ? { ...overlay.rasterPan } : null };
	},
	/** Install the recorders. Every row is one repaint(); restore() is called by stop(). */
	record() {
		const { overlay } = rig;
		const wraps: Array<[any, string, any]> = [];
		const wrap = (o: any, n: string, f: (orig: any) => any) => { const orig = o[n]; if (typeof orig !== "function") return; wraps.push([o, n, orig]); o[n] = f(orig); };
		const ctxProtos: any[] = [CanvasRenderingContext2D.prototype];
		if (typeof OffscreenCanvasRenderingContext2D !== "undefined") ctxProtos.push(OffscreenCanvasRenderingContext2D.prototype);
		// Paths filled on the committed canvas: one fill is one stroke ribbon or dot drawn there.
		for (const P of ctxProtos) wrap(P, "fill", o => function (this: any, ...a: any[]) { if (this.canvas === overlay.committedCanvas) rig.cnt.fills++; return o.apply(this, a); });
		// Path points put on the committed canvas: the work a strip drawn by path costs, and none for one filled by copy.
		for (const P of ctxProtos) for (const n of ["moveTo", "lineTo", "quadraticCurveTo", "bezierCurveTo", "arc"])
			wrap(P, n, o => function (this: any, ...a: any[]) { if (this.canvas === overlay.committedCanvas) rig.cnt.pts++; return o.apply(this, a); });
		let current: any = null;
		wrap(overlay, "paintCommittedWork", o => function (this: any, cam: any, work: any, strokes: any) {
			if (current) { current.work = work === "all" ? "all" : `strips:${work.length}`; current.strokesGiven = strokes.length; current.painted = true; }
			return o.apply(this, [cam, work, strokes]);
		});
		// Strips filled by copy from the extent raster, and those it turned back to the path. Every fill by copy is checked on the
		// spot against its reference (rasterFrameDiff), and its distance from a direct paint is recorded (directDiff).
		wrap(overlay, "copyFromExtent", o => function (this: any, ...a: any[]) {
			const ok = rig.noCopy ? false : o.apply(this, a);
			if (current) {
				if (ok) current.copies = (current.copies ?? 0) + 1; else current.copyMiss = (current.copyMiss ?? 0) + 1;
				current.missWhy = ok ? current.missWhy : JSON.stringify({ cam: a[1], cam0: this.extentRaster?.cam0, rect: a[2], k: a[1].zoom * this.extentRaster?.backing });
				if (ok && !rig.noCheck) {
					const v = rasterFrameDiff(this, a[0], a[1], a[2]), d = directDiff(this, a[1], a[2]);
					current.vDiffer = (current.vDiffer ?? 0) + v.differ; current.vInked = (current.vInked ?? 0) + v.inked;
					current.vOver24 = (current.vOver24 ?? 0) + v.over24; current.vEdge = (current.vEdge ?? 0) + v.edge; current.vMax = Math.max(current.vMax ?? 0, v.maxDelta);
					current.dDiffer = (current.dDiffer ?? 0) + d.differ; current.dOver24 = (current.dOver24 ?? 0) + d.over24; current.dMax = Math.max(current.dMax ?? 0, d.maxDelta);
					current.vFrameBad = (current.vFrameBad ?? 0) + (v.frameOk ? 0 : 1);
					current.dPmOver24 = (current.dPmOver24 ?? 0) + d.pmOver24; current.dPmMax = Math.max(current.dPmMax ?? 0, d.pmMax);
					(rig.copyLog ?? (rig.copyLog = [])).push({ phase: rig.phase, rect: !!a[2], differ: d.differ, over24: d.pmOver24, max: d.pmMax });
				}
			}
			return ok;
		});
		// Fills from the zoom settle stand-in (the old raster, or the layer's own pixels, scaled into place).
		wrap(overlay, "copyFromStandIn", o => function (this: any, ...a: any[]) {
			const ok = o.apply(this, a);
			if (current && ok) current.standCopies = (current.standCopies ?? 0) + 1;
			return ok;
		});
		// An extent raster built inside this repaint.
		wrap(overlay, "buildExtentRaster", o => function (this: any, ...a: any[]) { if (current) current.built = true; return o.apply(this, a); });
		// A piece of the build: how many strokes it drew and its ms. One that runs inside a repaint marks that row built.
		wrap(overlay, "runExtentPiece", o => function (this: any, ...a: any[]) {
			const b = this.extentBuild, n0 = b ? b.next : 0, t = performance.now();
			const r = o.apply(this, a);
			const drew = b ? b.next - n0 : 0;
			if (drew > 0) {
				rig.pieces.push({ t, ms: performance.now() - t, drew, inFrame: !!current, locked: !!this.frame?.locked, phase: rig.phase });
				if (current) current.built = true;
			}
			return r;
		});
		wrap(overlay, "repaint", o => function (this: any, ...a: any[]) {
			if (rig.hold) return;
			const row: any = { phase: rig.phase, t: performance.now(), backing: this.committedBacking, bake: !!this.rasterPanNeedsBake(), bounce: !!this.overscrollBounceReadout().active,
				work: null, strokesGiven: 0, painted: false, scrollOnly: !!this.repaintScrollOnly, locked: !!this.frame?.locked, ext: !!this.extentRaster,
				restBefore: { x: this.viewportPan.x, y: this.viewportPan.y }, rasterBefore: this.rasterPan ? { x: this.rasterPan.x, y: this.rasterPan.y } : null,
				camBefore: this.lastPaintCam ? { ...this.lastPaintCam } : null };
			const f0 = rig.cnt.fills, p0 = rig.cnt.pts;
			current = row;
			try { return o.apply(this, a); } finally {
				row.fills = rig.cnt.fills - f0; row.pts = rig.cnt.pts - p0; row.camAfter = this.lastPaintCam ? { ...this.lastPaintCam } : null;
				row.rasterAfter = this.rasterPan ? { x: this.rasterPan.x, y: this.rasterPan.y } : null;
				current = null; rig.rows.push(row);
			}
		});
		rig.restore = () => { for (const [o, n, f] of wraps.reverse()) o[n] = f; };
		rig.rows.length = 0; rig.cnt.fills = 0; rig.cnt.pts = 0; rig.pieces = [];
	},
	phase(name: string) { rig.phase = name; },
	rows() { return rig.rows.map((r: any) => ({ ...r })); },
	stop() { rig.restore?.(); rig.restore = null; return rig.rows.map((r: any) => ({ ...r })); },
	/** What a whole-layer repaint draws on this note: the reference for "all". */
	async full() {
		const { overlay } = rig;
		rig.phase = "full"; const n0 = rig.rows.length;
		overlay.damage.addAll(); overlay.scheduleRepaint("other");
		await settle(6);
		return rig.rows.slice(n0).filter((r: any) => r.painted).map((r: any) => ({ ...r }));
	},
	/** Move the resting pan by a fraction of a backing pixel, with no gesture: the raster and the pan now differ by less than the camera bar. */
	async nudge(backingPx: number) {
		const { overlay } = rig;
		rig.phase = "nudge";
		const dx = backingPx / (overlay.committedBacking > 0 ? overlay.committedBacking : (window.devicePixelRatio || 1));
		overlay.viewportPan.x += dx * overlay.cssScale;
		overlay.writeViewportPan();
		overlay.scheduleRepaint("scroll");
		await settle(8);
		return { dx, pan: { ...overlay.viewportPan }, rasterPan: overlay.rasterPan ? { ...overlay.rasterPan } : null };
	},
	/** A pan settled at rest: the resting pan moves to x, y with no gesture, and the repaint that follows is the bake. */
	async settlePan(x: number, y: number) {
		const { overlay } = rig;
		rig.phase = "settle-pan";
		overlay.viewportPan.x = x; overlay.viewportPan.y = y;
		overlay.writeViewportPan();
		overlay.scheduleRepaint("scroll");
		await settle(10);
		return { pan: { ...overlay.viewportPan }, rasterPan: overlay.rasterPan ? { ...overlay.rasterPan } : null };
	},
	/**
	 * Move the resting pan with every repaint held (the recorder's repaint wrap returns early), so the screen shows the pan through
	 * the ink layer's transform alone: the state just before the bake. "nudge" is a fraction of a backing pixel, "settle" is 40 px.
	 */
	async holdAndMove(kind: string) {
		const { overlay } = rig;
		rig.hold = true; rig.phase = "held";
		if (kind === "nudge") {
			const dx = 0.02 / (overlay.committedBacking > 0 ? overlay.committedBacking : (window.devicePixelRatio || 1));
			overlay.viewportPan.x += dx * overlay.cssScale;
		} else { overlay.viewportPan.x = -40; overlay.viewportPan.y = 0; }
		overlay.writeViewportPan();
		await settle(6);
		return { pan: { ...overlay.viewportPan }, rasterPan: overlay.rasterPan ? { ...overlay.rasterPan } : null, bakePending: !!overlay.rasterPanNeedsBake() };
	},
	/** Let repaints run again and ask for the one that bakes. */
	async release() {
		const { overlay } = rig;
		rig.hold = false; rig.phase = "release-bake";
		overlay.scheduleRepaint("scroll");
		await settle(10);
		return { pan: { ...overlay.viewportPan }, rasterPan: overlay.rasterPan ? { ...overlay.rasterPan } : null };
	},
	/**
	 * The page pulled past its left edge and let go, as in a recorded probe ("extent overscroll bounce from 96,0"): the resting pan
	 * stands 96 px right of its bound, a repaint runs while it is held there (the band-move and scroll repaints in the probe), then
	 * the release (resumeStrandedPan) parks the pan at its bound and starts the bounce. Frames are read until the spring ends.
	 */
	async pullAndRelease(axis: "x" | "y" | "xy" = "x", px = 96, py = px) {
		const { overlay, view } = rig, sd = view.scrollDOM;
		setPenInk(false);
		sd.scrollTop = 0; sd.scrollLeft = 0;
		await settle(8);
		rig.phase = "pull";
		overlay.viewportPan.x = axis === "y" ? 0 : px; overlay.viewportPan.y = axis === "x" ? 0 : py;
		overlay.writeViewportPan();
		rig.phase = "hold";
		overlay.scheduleRepaint("scroll");
		await settle(6);
		const held = { panX: overlay.viewportPan.x, panY: overlay.viewportPan.y, rasterX: overlay.rasterPan ? overlay.rasterPan.x : 0 };
		rig.phase = "release";
		const started = !!overlay.resumeStrandedPan();
		let springFrames = 0, ended = -1;
		for (let j = 0; j < 150; j++) {
			await frame();
			const b = overlay.overscrollBounceReadout();
			if (b.active) springFrames++;
			// The scroll and band-move repaints of Alan's probe land while the spring plays; resumeStrandedPan schedules none itself.
			if (j === 3) overlay.scheduleRepaint("scroll");
			if (springFrames > 0 && !b.active) { ended = j; break; }
		}
		rig.phase = "after";
		await settle(6);
		return { held, started, springFrames, ended, pan: { ...overlay.viewportPan } };
	},
	/**
	 * The page pulled `px` past its left edge (axis "x") or its top edge (axis "y") and let go, with the ink raster read on every
	 * frame of the bounce: how many pane pixels have no ink canvas under them, from the committed canvas's box against the scroller's.
	 * The repaint a scroll owes is asked for on the fourth frame, as in pullAndRelease.
	 */
	async bounceCoverage(axis: "x" | "y", px: number) {
		const { overlay, view } = rig, sd = view.scrollDOM;
		setPenInk(false);
		sd.scrollTop = 0; sd.scrollLeft = 0;
		await settle(8);
		rig.phase = "pull";
		overlay.viewportPan.x = axis === "x" ? px : 0; overlay.viewportPan.y = axis === "y" ? px : 0;
		overlay.writeViewportPan();
		rig.phase = "hold";
		overlay.scheduleRepaint("scroll");
		await settle(6);
		const paneRect = sd.getBoundingClientRect();
		const uncovered = () => {
			const c = overlay.committedCanvas.getBoundingClientRect();
			const w = Math.max(0, Math.min(paneRect.right, c.right) - Math.max(paneRect.left, c.left));
			const h = Math.max(0, Math.min(paneRect.bottom, c.bottom) - Math.max(paneRect.top, c.top));
			return Math.round(paneRect.width * paneRect.height - w * h);
		};
		const atHold = uncovered();
		rig.phase = "release";
		const started = !!overlay.resumeStrandedPan();
		const frames: number[] = [uncovered()];
		let springFrames = 0;
		for (let j = 0; j < 200; j++) {
			await frame();
			const b = overlay.overscrollBounceReadout();
			if (b.active) springFrames++;
			if (j === 3) overlay.scheduleRepaint("scroll");
			frames.push(uncovered());
			if (springFrames > 0 && !b.active) break;
		}
		rig.phase = "after";
		await settle(6);
		return { started, springFrames, atHold, frames, atRest: uncovered(), pane: { w: paneRect.width, h: paneRect.height }, pan: { ...overlay.viewportPan } };
	},
	/**
	 * The same pull and release as pullAndRelease, returned one frame after the spring's last frame, with no settling: the page is at
	 * its rest and the frame that bake owed (if it waits for the bounce) has just run or is about to. A pen goes down right after.
	 */
	async pullAndReleaseToEnd() {
		const { overlay, view } = rig, sd = view.scrollDOM;
		sd.scrollTop = 0; sd.scrollLeft = 0;
		await settle(8);
		rig.phase = "pull";
		overlay.viewportPan.x = 96; overlay.viewportPan.y = 0;
		overlay.writeViewportPan();
		rig.phase = "hold";
		overlay.scheduleRepaint("scroll");
		await settle(6);
		rig.phase = "release";
		const started = !!overlay.resumeStrandedPan();
		let springFrames = 0;
		for (let j = 0; j < 200; j++) {
			await frame();
			const b = overlay.overscrollBounceReadout();
			if (b.active) springFrames++;
			if (j === 3) overlay.scheduleRepaint("scroll");
			if (springFrames > 0 && !b.active) break;
		}
		rig.phase = "after";
		await frame();
		return { started, springFrames, pan: { ...overlay.viewportPan }, bake: !!overlay.rasterPanNeedsBake(), bounce: !!overlay.overscrollBounceReadout().active };
	},
	/**
	 * pullAndRelease with every strip a carry uncovers read on the committed canvas. A carry slides the painted pixels by whole
	 * backing px (slideCommittedPixels) and leaves the strips it uncovered to the same repaint's strip work. Right after each repaint
	 * that slid, the uncovered strips (canvas px, inside the css box) are read, the whole layer is drawn at the camera those strips
	 * were drawn at, under a clip of each strip the slide uncovers padded as a damage rect is, in turn as the strip draw clips each
	 * (a clip's bounds change the edge shading of a path; the clips come from the slide, not from the strips the overlay chose, so
	 * a short strip still shows), and the uncovered pixels are read again: byte for byte they must agree. That clipped draw against the whole layer drawn with no clip is read too,
	 * on premultiplied RGBA: the count that differs at all, the count over 24 of 255 and the largest difference are recorded (the
	 * cell asserts none over 24 on the synthetic note). The carried region is outside the compare
	 * (the renderer's pixels are not byte-equal under a whole-pixel shift). The strips' camera must stand within the plan's still
	 * bar of the camera the carry recorded, or strips drawn at a wrong camera would match a reference drawn there too. The reference
	 * is drawn over the layer and the layer put back after, so later carries slide the pixels the overlay painted. Inked = pixels
	 * of the whole-layer reference with alpha.
	 */
	async pullAndReleaseStrips(axis: "x" | "y" | "xy" = "xy", px = 96) {
		const { overlay, path } = rig;
		const ctx: CanvasRenderingContext2D = overlay.committedCtx, canvas: HTMLCanvasElement = overlay.committedCanvas;
		const slides: Array<{ sx: number; sy: number }> = [];
		// The pad, in world units, every damage rect gets: src/ink/DamageLedger.ts, `const PAD = 4;` (line 18).
		const pad = 4;
		let workCam: { x: number; y: number; zoom: number } | null = null;
		const carries: any[] = [];
		const slideOrig = overlay.slideCommittedPixels, workOrig = overlay.paintCommittedWork, repaintOrig = overlay.repaint;
		overlay.slideCommittedPixels = function (this: any, shiftX: number, shiftY: number, backing: number) {
			slides.push({ sx: Math.round(shiftX * backing), sy: Math.round(shiftY * backing) });
			return slideOrig.call(this, shiftX, shiftY, backing);
		};
		overlay.paintCommittedWork = function (this: any, cam: any, work: any, strokes: any) {
			if (work !== "all") workCam = { x: cam.x, y: cam.y, zoom: cam.zoom };
			return workOrig.call(this, cam, work, strokes);
		};
		overlay.repaint = function (this: any, ...a: any[]) {
			slides.length = 0; workCam = null;
			const out = repaintOrig.apply(this, a);
			if (slides.length > 0) {
				const W = canvas.width, H = canvas.height, b = this.committedBacking;
				const wc = Math.min(W, Math.floor(this.cssWidth * b + 1e-6)), hc = Math.min(H, Math.floor(this.cssHeight * b + 1e-6));
				let sx = 0, sy = 0;
				for (const s of slides) { sx += s.sx; sy += s.sy; }
				const rects: Array<[number, number, number, number]> = [];
				if (sx > 0) rects.push([0, 0, Math.min(sx, wc), hc]); else if (sx < 0) rects.push([Math.max(0, wc + sx), 0, wc - Math.max(0, wc + sx), hc]);
				// The row strip leaves out the columns the column strip already holds, as the overlay's own strips do.
				const bx0 = sx > 0 ? Math.min(sx, wc) : 0, bx1 = sx < 0 ? Math.max(0, wc + sx) : wc;
				if (sy > 0) rects.push([bx0, 0, bx1 - bx0, Math.min(sy, hc)]); else if (sy < 0) rects.push([bx0, Math.max(0, hc + sy), bx1 - bx0, hc - Math.max(0, hc + sy)]);
				const read = () => rects.filter(r => r[2] > 0 && r[3] > 0).map(r => ctx.getImageData(r[0], r[1], r[2], r[3]).data);
				const before = read();
				const drawnCam = workCam as { x: number; y: number; zoom: number } | null;
				const cam = drawnCam ?? this.lastPaintCam;
				const kept = ctx.getImageData(0, 0, W, H);
				// The reference clips: this test's own uncovered strips (from the slide, never the overlay's own damage), taken to world units
				// at the strips' camera and padded as a damage rect is; drawn below as drawRegion converts a rect.
				// Snapped outward to whole device pixels as the product's partial-repaint clip is (InkOverlay, 137b7727): floor the near
				// edges, ceil the far edges, about the camera origin. Without it this clip's fractional edges draw the reference fainter.
				const k = cam.zoom * b;
				const snap = (v: number, o: number, f: (n: number) => number) => o + f((v - o) * k) / k;
				const clips = rects.filter(r => r[2] > 0 && r[3] > 0).map(r => {
					const l = cam.x + r[0] / b / cam.zoom - pad, t = cam.y + r[1] / b / cam.zoom - pad;
					const rt = cam.x + (r[0] + r[2]) / b / cam.zoom + pad, bt = cam.y + (r[1] + r[3]) / b / cam.zoom + pad;
					const sl = snap(l, cam.x, Math.floor), st = snap(t, cam.y, Math.floor);
					const sr = snap(rt, cam.x, Math.ceil), sb = snap(bt, cam.y, Math.ceil);
					return { x: sl, y: st, width: sr - sl, height: sb - st };
				});
				for (const r of clips) {
					ctx.save();
					ctx.beginPath();
					ctx.rect((r.x - cam.x) * cam.zoom, (r.y - cam.y) * cam.zoom, r.width * cam.zoom, r.height * cam.zoom);
					ctx.clip();
					workOrig.call(this, cam, "all", inlineInk.strokes(path));
					ctx.restore();
				}
				const after = read();
				ctx.putImageData(kept, 0, 0);
				workOrig.call(this, cam, "all", inlineInk.strokes(path));
				const whole = read();
				ctx.putImageData(kept, 0, 0);
				let differ = 0, inked = 0, max = 0, clipDiffer = 0, clipOver24 = 0, clipMaxPm = 0;
				const pm = (d: Uint8ClampedArray, i: number, c: number) => (c === 3 ? d[i + 3]! : Math.round(d[i + c]! * d[i + 3]! / 255));
				for (let k = 0; k < after.length; k++) {
					const p = before[k]!, q = after[k]!;
					for (let i = 0; i < q.length; i += 4) {
						if (q[i + 3]! > 0) inked++;
						const d = Math.max(Math.abs(p[i]! - q[i]!), Math.abs(p[i + 1]! - q[i + 1]!), Math.abs(p[i + 2]! - q[i + 2]!), Math.abs(p[i + 3]! - q[i + 3]!));
						if (d > 0) differ++;
						if (d > max) max = d;
						const w = whole[k]!;
						let e = 0, any = false;
						for (let c = 0; c < 4; c++) { if (q[i + c] !== w[i + c]) any = true; e = Math.max(e, Math.abs(pm(q, i, c) - pm(w, i, c))); }
						if (any) clipDiffer++;
						if (e > 24) clipOver24++;
						if (e > clipMaxPm) clipMaxPm = e;
					}
				}
				carries.push({ phase: rig.phase, sx, sy, canvas: [W, H], box: [wc, hc], rects, stripsDrawn: drawnCam !== null,
					camWithin: drawnCam === null || (!!this.lastPaintCam && cameraWithin(this.lastPaintCam.x, this.lastPaintCam.y, this.lastPaintCam.zoom, drawnCam.x, drawnCam.y, drawnCam.zoom, b, CAMERA_STILL_BACKING_PX)), differ, inked, max, clipDiffer, clipOver24, clipMaxPm, pad, clips: clips.length });
			}
			return out;
		};
		try {
			const pull = await (window as any).panBake.pullAndRelease(axis, px);
			return { pull, carries };
		} finally {
			overlay.slideCommittedPixels = slideOrig; overlay.paintCommittedWork = workOrig; overlay.repaint = repaintOrig;
		}
	},
	/** The part of a backing pixel the last bake left in the ink layer's translate, per axis, in backing px. */
	remainder() {
		const { overlay } = rig, k = overlay.cssScale, b = overlay.committedBacking;
		const r = overlay.rasterPan ?? { x: 0, y: 0 };
		return { x: (overlay.viewportPan.x / k - r.x) * b, y: (overlay.viewportPan.y / k - r.y) * b };
	},
	/** The raster moved to the exact resting pan and the whole layer redrawn there: the place a bake with no carry gives the ink. */
	async exactRedraw() {
		const { overlay } = rig;
		rig.phase = "exact";
		overlay.rasterPan = { x: overlay.viewportPan.x / overlay.cssScale, y: overlay.viewportPan.y / overlay.cssScale };
		overlay.writeInkLayerTransform();
		overlay.damage.addAll(); overlay.scheduleRepaint("other");
		await settle(8);
		return { rasterPan: { ...overlay.rasterPan }, bake: !!overlay.rasterPanNeedsBake() };
	},
	/** Whether the overlay holds an extent raster: its size in device px, its stroke count and generation, and the store's. */
	extent() {
		const e = rig.overlay.extentRaster;
		return e ? { w: e.pen.width, h: e.pen.height, count: e.count, generation: e.generation, storeCount: inlineInk.strokes(rig.path).length, storeGeneration: inlineInk.generation(rig.path) } : null;
	},
	/**
	 * Erase `n` strokes in view, as a selection delete or the eraser's removal would: out of the store, their boxes damaged, and the
	 * partial repaint run. Returns how many went.
	 */
	async eraseVisible(n = 3) {
		const { overlay, path } = rig, cam = overlay.lastPaintCam;
		const x0 = cam.x, y0 = cam.y, x1 = cam.x + overlay.cssWidth / cam.zoom, y1 = cam.y + overlay.cssHeight / cam.zoom;
		const gone = inlineInk.strokes(path).filter((s: any) => s.bbox.x > x0 && s.bbox.y > y0 && s.bbox.x + s.bbox.width < x1 && s.bbox.y + s.bbox.height < y1).slice(0, n);
		rig.phase = "erase";
		inlineInk.applyRemove(path, gone.map((s: any) => s.id));
		for (const s of gone) overlay.damage.addRect(s.bbox);
		overlay.scheduleRepaint("partial");
		await settle(8);
		return { erased: gone.length, strokes: inlineInk.strokes(path).length };
	},
	/**
	 * The renderer alone, no raster (the control for the copy bar). The whole layer drawn by path at the camera, against the same layer drawn
	 * with its origin `n` device px up and left - by moving the camera ("cam") or by the context's translate ("translate") - read
	 * back shifted by n. Pixels that differ, over 24 of 255, largest delta, inked.
	 */
	shiftControl(n: number) {
		const o = rig.overlay, cam = o.lastPaintCam, backing = o.committedBacking, k = cam.zoom * backing;
		const W = o.committedCanvas.width, H = o.committedCanvas.height, floor = { backing, dpr: o.dpr }, strokes = inlineInk.strokes(rig.path);
		const layer = (tx: number, at: { x: number; y: number; zoom: number }) => {
			const c = document.createElement("canvas"); c.width = W + n; c.height = H + n;
			const x = c.getContext("2d")!; x.setTransform(backing, 0, 0, backing, tx, tx);
			drawCommitted(x, at, strokes, (W + n) / backing, (H + n) / backing, true, "pen", false, floor);
			return x;
		};
		const cmp = (p: Uint8ClampedArray, q: Uint8ClampedArray) => {
			let differ = 0, over24 = 0, maxDelta = 0, inked = 0;
			for (let i = 0; i < p.length; i += 4) {
				const d = Math.max(Math.abs(p[i]! - q[i]!), Math.abs(p[i + 1]! - q[i + 1]!), Math.abs(p[i + 2]! - q[i + 2]!), Math.abs(p[i + 3]! - q[i + 3]!));
				if (d > 0) { differ++; if (d > 24) over24++; if (d > maxDelta) maxDelta = d; }
				if (p[i + 3] !== 0) inked++;
			}
			return { differ, over24, maxDelta, inked };
		};
		const ref = layer(0, cam).getImageData(0, 0, W, H).data;
		const again = layer(0, cam).getImageData(0, 0, W, H).data;
		const byCam = layer(0, { x: cam.x - n / k, y: cam.y - n / k, zoom: cam.zoom }).getImageData(n, n, W, H).data;
		const byTranslate = layer(n, cam).getImageData(n, n, W, H).data;
		return { n, same: cmp(ref, again), cam: cmp(ref, byCam), translate: cmp(ref, byTranslate) };
	},
	/** From now on every copy is refused and its strip drawn by path, as on the base: the same pan with copies off. */
	copiesOff() { rig.noCopy = true; },
	/** Skip the on-the-spot check of each copy from the raster (it redraws by path to compare), so a cell can time the settle. */
	checksOff() { rig.noCheck = true; },
	/** The whole committed layer against a path draw of every stroke at the camera it was painted at: pixels that differ, inked pixels. */
	layerVsPath() { return directDiff(rig.overlay, rig.overlay.lastPaintCam, null); },
	/** The smoothing setting turned off as a synced settings change does it (main.ts): the switch, then every overlay repainted. */
	async shapingOff() {
		rig.phase = "shaping-off";
		setInkShaping(false);
		repaintAllInkOverlays();
		await settle(8);
	},
	/** Erase every `k`th stroke of the note, wherever it is, as an eraser gesture and its lift would: strips a pan uncovers then hold erased ink. */
	async eraseEvery(k = 10) {
		const { overlay, path } = rig;
		const gone = inlineInk.strokes(path).filter((_: any, i: number) => i % k === 0);
		rig.phase = "erase";
		inlineInk.applyRemove(path, gone.map((s: any) => s.id));
		// The gesture's frames: one rect per erased stroke, as eraseAt adds them.
		for (const s of gone) overlay.damage.addRect(s.bbox);
		overlay.scheduleRepaint("partial");
		await settle(8);
		// The lift, as the erase pen-up does it: ask the next repaint to arm a build, over the box of everything taken.
		rig.phase = "erase-lift";
		let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
		for (const s of gone) { x0 = Math.min(x0, s.bbox.x); y0 = Math.min(y0, s.bbox.y); x1 = Math.max(x1, s.bbox.x + s.bbox.width); y1 = Math.max(y1, s.bbox.y + s.bbox.height); }
		overlay.extentArmAsked = true;
		overlay.damage.addRect({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
		overlay.scheduleRepaint("partial");
		await settle(2);
		const armed = !!overlay.extentBuild || !!overlay.extentRaster;
		await settle(6);
		return { erased: gone.length, strokes: inlineInk.strokes(path).length, armed };
	},
	/** A whole-layer repaint asked for by no pan, stroke or bounce (a size or a setting, say): where a stale extent raster is built again. */
	async wholeRepaint() {
		const { overlay } = rig;
		rig.phase = "whole";
		overlay.damage.addAll(); overlay.scheduleRepaint("other");
		await settle(8);
	},
	/**
	 * The stand-in the overlay shows at a new scale while the sharp raster is built: held or not, its size, backing and stroke count,
	 * and how many were taken from the layer's own pixels so far (null where the overlay has no such counter).
	 */
	standIn() {
		const o = rig.overlay, st = o.standIn ?? null;
		return { held: !!st, w: st ? st.pen.width : 0, h: st ? st.pen.height : 0, backing: st ? st.backing : 0, count: st ? st.count : 0,
			snapshots: typeof o.standInSnapshots === "number" ? o.standInSnapshots : null, building: !!o.extentBuild, ext: !!o.extentRaster };
	},
	/** Keep the stand-in's pen canvas, so a test can see it released later. */
	keepStandInCanvas() { rig.keptStand = rig.overlay.standIn?.pen ?? null; return !!rig.keptStand; },
	/** Whether the stand-in held now is the one whose canvas was kept (never a copy of a copy). */
	standInIsKept() { return !!rig.keptStand && rig.overlay.standIn?.pen === rig.keptStand; },
	keptStandInSize() { const c = rig.keptStand as HTMLCanvasElement | null; return c ? [c.width, c.height] : null; },
	/**
	 * Where the stand-in lands on the committed canvas at the last paint camera, in device px (its scaled copy's rect), clamped to the
	 * canvas. Null with no stand-in.
	 */
	standInRect() {
		const o = rig.overlay, st = o.standIn, cam = o.lastPaintCam, b = o.committedBacking;
		if (!st || !cam || !b) return null;
		const kn = cam.zoom * b, f = kn / (st.at.zoom * st.backing);
		const x0 = Math.max(0, Math.ceil((st.at.x - cam.x) * kn)), y0 = Math.max(0, Math.ceil((st.at.y - cam.y) * kn));
		const x1 = Math.min(o.committedCanvas.width, Math.floor((st.at.x - cam.x) * kn + st.pen.width * f));
		const y1 = Math.min(o.committedCanvas.height, Math.floor((st.at.y - cam.y) * kn + st.pen.height * f));
		return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
	},
	/** Inked pixels (alpha above 0) of the committed canvas inside `r`, device px. */
	/** Inked pixels over the whole committed canvas. */
	wholeLayerInk() { const c = rig.overlay.committedCanvas; return (window as any).panBake.layerInk({ x: 0, y: 0, w: c.width, h: c.height }); },
	layerInk(r: { x: number; y: number; w: number; h: number }) {
		const d = rig.overlay.committedCtx.getImageData(r.x, r.y, r.w, r.h).data;
		let n = 0;
		for (let i = 3; i < d.length; i += 4) if (d[i]! > 0) n++;
		return n;
	},
	/**
	 * The store's last stroke drawn alone by path at the last paint camera, on a blank canvas of the committed canvas's size: of its
	 * solid pixels (alpha 255), how many the committed canvas shows differently by more than 24 of 255 in any channel. A stroke drawn
	 * sharp on top of the layer leaves none.
	 */
	lastStrokeSharp() {
		const o = rig.overlay, strokes = inlineInk.strokes(rig.path), st = strokes[strokes.length - 1], cam = o.lastPaintCam, b = o.committedBacking;
		if (!st || !cam || !b) return null;
		const c = document.createElement("canvas");
		c.width = o.committedCanvas.width; c.height = o.committedCanvas.height;
		const x = c.getContext("2d")!;
		x.setTransform(b, 0, 0, b, 0, 0);
		drawStroke(x, cam, st, undefined, true, undefined, { backing: b, dpr: o.dpr });
		const r = x.getImageData(0, 0, c.width, c.height).data, q = o.committedCtx.getImageData(0, 0, c.width, c.height).data;
		c.width = 0; c.height = 0;
		let solid = 0, bad = 0;
		for (let i = 0; i < r.length; i += 4) {
			if (r[i + 3] !== 255) continue;
			solid++;
			if (Math.max(Math.abs(r[i]! - q[i]!), Math.abs(r[i + 1]! - q[i + 1]!), Math.abs(r[i + 2]! - q[i + 2]!), Math.abs(255 - q[i + 3]!)) > 24) bad++;
		}
		return { solid, bad, count: strokes.length };
	},
	/**
	 * Where the committed layer's ink stands against the whole layer drawn by path at the layer's camera and floor, in device px: the
	 * shift of the layer that best matches the path draw (least sum of squared alpha differences over a central `n` px window, whole-px
	 * shifts -3..3 per axis, refined by a parabola through the minimum). A width difference changes the sum, not where its minimum is.
	 */
	placeVsPath(n = 600) {
		const o = rig.overlay, cam = o.lastPaintCam, b = o.committedBacking, w = o.committedCanvas.width, h = o.committedCanvas.height;
		const c = document.createElement("canvas");
		c.width = w; c.height = h;
		const x = c.getContext("2d")!;
		x.setTransform(b, 0, 0, b, 0, 0);
		drawCommitted(x, cam, inlineInk.strokes(rig.path), o.cssWidth, o.cssHeight, true, "pen", false, { backing: b, dpr: o.dpr });
		const A = o.committedCtx.getImageData(0, 0, w, h).data, B = x.getImageData(0, 0, w, h).data;
		c.width = 0; c.height = 0;
		const cx = Math.floor(w / 2 - n / 2), cy = Math.floor(h / 2 - n / 2);
		const ssd = (sx: number, sy: number) => {
			let e = 0;
			for (let yy = cy; yy < cy + n; yy++) for (let xx = cx; xx < cx + n; xx++) { const d = A[(yy * w + xx) * 4 + 3]! - B[((yy + sy) * w + xx + sx) * 4 + 3]!; e += d * d; }
			return e;
		};
		const fit = (v: number[]) => {
			let k = 0;
			for (let i = 1; i < v.length; i++) if (v[i]! < v[k]!) k = i;
			if (k === 0 || k === v.length - 1) return k - 3;
			return k - 3 + 0.5 * (v[k - 1]! - v[k + 1]!) / (v[k - 1]! - 2 * v[k]! + v[k + 1]!);
		};
		const steps = [-3, -2, -1, 0, 1, 2, 3];
		let inked = 0;
		for (let yy = cy; yy < cy + n; yy++) for (let xx = cx; xx < cx + n; xx++) if (B[(yy * w + xx) * 4 + 3]! > 0) inked++;
		return { dx: fit(steps.map(s => ssd(s, 0))), dy: fit(steps.map(s => ssd(0, s))), inked };
	},
	/** A whole repaint now, in this task (damage all, repaint), as a later frame's would be. */
	repaintNow() { const o = rig.overlay; rig.phase = "repaint-now"; o.damage.addAll(); o.repaint(); },
	/** The whole layer drawn by path at the camera it has (copies refused), and the frames after it: the reference screen. */
	async pathRedraw() {
		const o = rig.overlay;
		rig.phase = "path";
		rig.noCopy = true;
		try { o.damage.addAll(); o.repaint(); } finally { rig.noCopy = false; }
		await settle(4);
	},
	/**
	 * Wait until no build is pending and no stand-in is held, then let the repaint that follows run. Pieces must be
	 * let go first (holdPieces(false)).
	 */
	async awaitSharp(limitMs = 30_000) {
		const o = rig.overlay, t0 = performance.now();
		let whole = o.extentBuild ? -1 : 0;
		while ((o.extentBuild || o.standIn) && performance.now() - t0 < limitMs) {
			await new Promise(r => setTimeout(r, 10));
			if (whole < 0 && !o.extentBuild) whole = performance.now() - t0;
		}
		// The copy-in frame runs inside the wait and carries the rig's own per-copy check, so the wait's end is not the app's time:
		// `whole` (the raster handed over) is, and the copy-in itself is one copy on the next frame.
		await settle(4);
		return { whole, building: !!o.extentBuild, held: !!o.standIn };
	},
	/** Wait until no build is pending (the raster is whole, or none was started): ms waited, and the raster's state. */
	async awaitWhole(limitMs = 30_000) {
		const o = rig.overlay, t0 = performance.now();
		while (o.extentBuild && performance.now() - t0 < limitMs) await new Promise(r => setTimeout(r, 20));
		return { ms: performance.now() - t0, pending: !!o.extentBuild, ext: (window as any).panBake.extent() };
	},
	/** The pending build: next store index, its target count, whether its canvases are allocated. Null when none. */
	build() {
		const b = rig.overlay.extentBuild;
		return b ? { next: b.next, count: b.count, allocated: !!b.pen, penW: b.pen ? b.pen.width : 0, storeCount: inlineInk.strokes(rig.path).length } : null;
	},
	/** Pieces recorded since record(), and clear them. */
	pieces() { const p = rig.pieces ?? []; rig.pieces = []; return p; },
	/**
	 * Hold every piece back, or let them run: the instance's piece gate answers no while held. Not the scroll-quiet stamp, which every
	 * scroll repaint rewrites (a zoom commit asks for some), so a hold kept there let the build run to the end before the cell read it.
	 */
	holdPieces(on: boolean) { const o = rig.overlay; if (on) o.extentPieceAllowed = () => false; else delete o.extentPieceAllowed; },
	/** Run one piece now, past the hold, as its timer would; the hold stays for the next one. */
	stepPiece() {
		const o = rig.overlay, held = Object.prototype.hasOwnProperty.call(o, "extentPieceAllowed"), f = o.extentPieceAllowed;
		if (held) delete o.extentPieceAllowed;
		try { o.runExtentPiece(); } finally { if (held) o.extentPieceAllowed = f; }
	},
	/** The pending build's pen canvas, kept so a test can see it released after a drop. */
	keepBuildCanvas() { rig.keptCanvas = rig.overlay.extentBuild?.pen ?? null; return !!rig.keptCanvas; },
	keptCanvasSize() { const c = rig.keptCanvas as HTMLCanvasElement | null; return c ? [c.width, c.height] : null; },
	/**
	 * Hold one member of the piece gate on or off, as that state would hold it: a contact holding the frame, a stroke being built,
	 * a pinch scale held, a bounce playing, a repaint queued, scroll repaints asked for every 40 ms.
	 */
	gate(member: string, on: boolean) {
		const o = rig.overlay;
		if (member === "contact") { if (on) o.frame.begin(); else o.frame.cancel(); }
		else if (member === "stroke") o.builder = on ? {} : null;
		else if (member === "pinch") o.pinchRefScale = on ? 1 : null;
		else if (member === "bounce") o.bounceState = on ? { hold: {}, fromX: 0, fromY: 0, startedAt: performance.now(), raf: 0 } : null;
		else if (member === "queued") o.repaintQueued = on;
		else if (member === "scroll") {
			rig.scrollTick = on;
			const tick = () => { if (!rig.scrollTick) return; o.lastScrollAskAt = performance.now(); setTimeout(tick, 40); };
			if (on) tick(); else o.lastScrollAskAt = -Infinity;
		} else throw new Error("no gate member " + member);
	},
	/**
	 * Commit a new zoom, then in the same task do `then` ("none"; "scroll", a pan asking for its repaint; "drop", the stand-in let
	 * go; "twice", two more whole repaints), and return the whole-layer repaints that ran inside that task: path points and stand-in
	 * copies of each. `zoom` null skips the commit. afterFrame returns those of the three animation frames after the task.
	 *
	 * The frame watch is registered here, inside the task, after the overlay's queued frame: its first callback runs in the first
	 * frame after the task, after the overlay's repaint and before that frame paints (a watch registered from a later call can miss
	 * that frame). There it reads the stand-in's place and the ink in it (`inkRect`), and does `between`: "pan", the resting pan
	 * moved 40 px; "stroke", a stroke committed in view; "resize", the pane made 24 px narrower and the overlay resized;
	 * "resize-scheduled", the pane made 24 px shorter with the eraser tool active, so the resize leaves its repaint to the queued
	 * frame. A zoom
	 * commit asks one more whole repaint in a second frame (the editor's reflow, then the settle's follow-up), so the watch runs on
	 * two more frames.
	 */
	async commitThen(zoom: number | null, then: "none" | "scroll" | "drop" | "twice",
		between: "none" | "pan" | "stroke" | "resize" | "resize-scheduled" | "dpr" = "none",
		inkRect = false) {
		const o = rig.overlay, n0 = rig.rows.length;
		const atBacking = o.committedBacking, atZoom = o.lastPaintCam?.zoom ?? null;
		rig.phase = "commit-task";
		const ok = zoom === null ? true : !!o.commitCameraScale(zoom, { left: 0, top: 0 });
		await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
		if (then === "scroll") o.scheduleRepaint("scroll");
		else if (then === "drop") o.dropStandIn();
		else if (then === "twice") for (let i = 0; i < 2; i++) { o.damage.addAll(); o.repaint(); }
		const rs = rig.rows.slice(n0).filter((r: any) => r.painted && r.work === "all").map((r: any) => ({ pts: r.pts, stand: r.standCopies ?? 0 }));
		rig.phase = "frame";
		rig.frameFrom = rig.rows.length;
		const win: any = rig.win = { first: -1, rect: null, ink: -1, between, did: null, done: null };
		win.done = new Promise<void>(res => requestAnimationFrame(() => {
			try { watchFirst(); } catch (e) { win.err = String(e); }
			requestAnimationFrame(() => requestAnimationFrame(() => res()));
		}));
		const watchFirst = () => {
			win.first = rig.rows.length;
			if (inkRect) {
				const r = win.rect = (window as any).panBake.standInRect();
				if (r) win.ink = (window as any).panBake.layerInk(r);
				win.layerInk = (window as any).panBake.layerInk({ x: 0, y: 0, w: o.committedCanvas.width, h: o.committedCanvas.height });
			}
			if (between === "pan") {
				o.viewportPan.x += 40 * o.cssScale;
				o.writeViewportPan();
				o.scheduleRepaint("scroll");
				win.did = { pan: { ...o.viewportPan } };
			} else if (between === "stroke") {
				const cam = o.lastPaintCam, x0 = cam.x, y0 = cam.y, x1 = cam.x + o.cssWidth / cam.zoom, y1 = cam.y + o.cssHeight / cam.zoom;
				const s = inlineInk.strokes(rig.path).find((s: any) => s.bbox.x > x0 && s.bbox.y > y0 && s.bbox.x + s.bbox.width < x1 && s.bbox.y + s.bbox.height < y1);
				if (s) {
					const ns = { ...s, id: "00000000-0000-4000-8000-999999999999", points: s.points.map((p: any) => ({ ...p })) };
					inlineInk.commit(rig.path, ns);
					o.damage.addRect(ns.bbox);
					o.scheduleRepaint("partial");
				}
				win.did = { stroke: !!s, count: inlineInk.strokes(rig.path).length };
			} else if (between === "dpr") {
				// The device ratio changes with no size change (page zoom), as the resolution media query reports it.
				const d0 = o.dpr;
				Object.defineProperty(window, "devicePixelRatio", { configurable: true, get: () => 1.5 });
				o.handleResize();
				win.did = { d0, d1: o.dpr, held: !!o.standIn };
			} else if (between === "resize" || between === "resize-scheduled") {
				// "resize-scheduled" makes the pane shorter, not narrower: a narrower pane re-centres the column and moves the camera, which
				// alone copies again; a shorter one keeps the camera, so only the reallocation tells the frame its copy is gone.
				const w0 = o.committedCanvas.width, h0 = o.committedCanvas.height, mode = o.mode, n0 = rig.rows.length;
				const cam0 = { ...o.camera.snapshot };
				if (between === "resize") rig.pane.style.width = (rig.pane.clientWidth - 24) + "px";
				else { rig.pane.style.height = (rig.pane.clientHeight - 24) + "px"; o.mode = "erase"; }
				try { o.handleResize(); } finally { o.mode = mode; }
				const cam1 = o.camera.snapshot;
				win.did = { w0, w1: o.committedCanvas.width, h0, h1: o.committedCanvas.height, inTask: rig.rows.length - n0, queued: !!o.repaintQueued,
					camKept: cam0.x === cam1.x && cam0.y === cam1.y && cam0.zoom === cam1.zoom };
			}
		};
		// The copy factor a stand-in made from the layer before the commit is shown at: new zoom times backing over the old.
		const cam = o.lastPaintCam, factor = atBacking && atZoom && cam && o.committedBacking ? (cam.zoom * o.committedBacking) / (atZoom * atBacking) : null;
		return { ok, rows: rs, deferrals: o.standInDeferrals ?? null, held: !!o.standIn, factor };
	},
	/**
	 * The repaints of the frames commitThen watched: all of them (`rows`), and those of the first frame after the task (`first`), with
	 * the stand-in's place and the ink in it read in that first frame, before it paints.
	 */
	async afterFrame() {
		const win = rig.win;
		await win.done;
		const o = rig.overlay, from = rig.frameFrom ?? 0;
		const map = (rs: any[]) => rs.filter((r: any) => r.painted).map((r: any) => ({ work: r.work, pts: r.pts, stand: r.standCopies ?? 0 }));
		return { rows: map(rig.rows.slice(from)), first: map(rig.rows.slice(from, win.first)), later: map(rig.rows.slice(win.first)), held: !!o.standIn,
			deferrals: o.standInDeferrals ?? null, rect: win.rect, ink: win.ink, layerInk: win.layerInk ?? -1, did: win.did, err: win.err ?? null };
	},
	/** Commit a new zoom as a zoom control does, and let the settle repaint run: the frame that arms a build. */
	async rezoom(zoom: number) {
		const o = rig.overlay;
		rig.phase = "rezoom";
		const ok = !!o.commitCameraScale(zoom, { left: 0, top: 0 });
		await settle(12);
		o.scheduleRepaint("other");
		await settle(8);
		return { ok, cssScale: o.cssScale, backing: o.committedBacking };
	},
	/**
	 * The finished raster against the one-pass reference of row 478 (1): every stroke of the store drawn by drawCommitted on a canvas
	 * of the raster's size at the raster's camera, per layer. Pixels that differ (any channel), inked pixels.
	 */
	extentVsOnePass() {
		const o = rig.overlay, e = o.extentRaster;
		if (!e) return null;
		const strokes = inlineInk.strokes(rig.path);
		const one = (tool: string, w: number, h: number) => {
			const c = document.createElement("canvas"); c.width = w; c.height = h;
			const x = c.getContext("2d")!; x.setTransform(e.backing, 0, 0, e.backing, 0, 0);
			drawCommitted(x, e.at, strokes, w / e.backing, h / e.backing, true, tool as any, false, { backing: e.backing, dpr: e.dpr });
			const d = x.getImageData(0, 0, w, h).data; c.width = 0; c.height = 0; return d;
		};
		const cmp = (cv: HTMLCanvasElement, tool: string) => {
			const p = cv.getContext("2d")!.getImageData(0, 0, cv.width, cv.height).data, q = one(tool, cv.width, cv.height);
			let differ = 0, inked = 0;
			for (let i = 0; i < p.length; i += 4) {
				if (p[i] !== q[i] || p[i + 1] !== q[i + 1] || p[i + 2] !== q[i + 2] || p[i + 3] !== q[i + 3]) differ++;
				if (q[i + 3] !== 0) inked++;
			}
			return { differ, inked };
		};
		return { pen: cmp(e.pen, "pen"), hl: e.hl ? cmp(e.hl, "highlighter") : null, count: e.count, storeCount: strokes.length };
	},
	state() {
		const { overlay, view } = rig, sd = view.scrollDOM;
		return { left: sd.scrollLeft, top: sd.scrollTop, pan: { ...overlay.viewportPan }, rasterPan: overlay.rasterPan ? { ...overlay.rasterPan } : null,
			cam: overlay.lastPaintCam ? { ...overlay.lastPaintCam } : null, bake: !!overlay.rasterPanNeedsBake(), bounce: overlay.overscrollBounceReadout(),
			strokes: inlineInk.strokes(rig.path).length };
	},
};
