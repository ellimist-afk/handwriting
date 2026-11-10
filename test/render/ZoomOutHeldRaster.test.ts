/**
 * A zoom out shows the ink the start view did not: while the extent raster is held at the start zoom, its own pen and highlighter
 * canvases go up in one sibling element right after the scroller for the preview, and come down at the landing. With no raster held,
 * the stand-in a landing kept while the next raster builds goes up the same way, its CSS size scaled by the start zoom over its own.
 *
 * Alan's report (1.4.25): during a zoom out (pinch, ctrl+wheel, minus button) the newly shown area stays empty until the zoom
 * settles, then the ink pops in. The committed layer only holds the start view; the extent raster already holds the rest of the
 * note at the start zoom, built off screen, and was never shown during a gesture.
 *
 * Regime: forced --force-device-scale-factor (never the page deviceScaleFactor), at HW_ZO_DSF (default 1.37, the film rig's ratio).
 * Ink: the committed fixture alan-ink-75d1627a.json clipped to its whole strokes inside world (0, 0) to (3600, 2400), or HW_ZO_INK
 * with HW_ZO_PAGE (the film's ink copy, used whole) for an evidence run. The whole fixture spans about 97M device px at the start zoom,
 * over the 20M raster cap, so it never holds a raster; the clip (631 strokes, 9 highlighter) does, and still reaches past the start view.
 * The gesture is the film's: ctrl+wheel runs of two events of 22.66 px about the page's top-left, each run landing on its own
 * quiet end. The quiet timer is held off while a preview frame is read (two screenshots), then let run.
 *
 * Ink outside the start view: a pane screenshot with every canvas shown against one with every canvas hidden, same frame, pixels
 * that differ by more than 24 of 255 outside the committed canvas's box (which is where the start view sits on that frame).
 * Pop at landing: ink pixels on the landed view with no ink within 6 device px on the run's last preview frame, read after the
 * preview has stood 8 frames with the quiet end held off, the landed view first moved by the whole device px shift that best lays
 * it on the preview. The zoom about the page's top-left lands clamped, so the page itself moves at the landing (a8c2158d: preview
 * ink 268228 px against 295916 landed, 77862 unaligned pops); the shift is reported, and only ink the preview never showed counts.
 * Only inside the preview's scroller client box: the preview keeps the 85 percent scrollbar gutter at the pane's right, where no
 * ink shows before or after this fix, and the landing has none (826e95d9 probe: every pop left was in that 20 device px strip).
 * The landed layer is compared with a path draw against a control page where the sibling never goes up: the landing must not
 * change it (at a8c2158d both inks already differ from a path draw by a few px over 24, without the sibling).
 *
 * A wheel run's preview frames are painted on animation frames (flushPinch); the call that takes the events only starts the gesture.
 * The first preview frame is read in the next frame's callback, which runs after flushPinch in the same frame. A frame shows ink when
 * the sibling is up, the pane's committed canvas is shown, or the pinch composite shows the ink in the wet canvas.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

declare const process: { env: Record<string, string | undefined> };

const MINIMAL_CSS = readFileSync(fileURLToPath(new URL("./fixtures/minimal-9.0.2-theme.css", import.meta.url)), "utf8");
/** The committed fixture's whole strokes inside the world box: pts is x, y, pressure, t per sample. */
function clipInk(text: string, x0: number, y0: number, x1: number, y1: number): string {
	const d = JSON.parse(text) as { strokes: Array<{ pts: number[] }> };
	const inside = (p: number[]) => { for (let i = 0; i + 1 < p.length; i += 4) if (p[i]! < x0 || p[i]! > x1 || p[i + 1]! < y0 || p[i + 1]! > y1) return false; return true; };
	return JSON.stringify({ ...d, strokes: d.strokes.filter(s => inside(s.pts)) });
}
const INK = process.env.HW_ZO_INK ? readFileSync(process.env.HW_ZO_INK, "utf8")
	: clipInk(readFileSync(fileURLToPath(new URL("./fixtures/alan-ink-75d1627a.json", import.meta.url)), "utf8"), 0, 0, 3600, 2400);
const PAGE_ID = process.env.HW_ZO_PAGE ?? "75d1627a-c4d7-4a11-947d-bc26b7f83c20";
const DSF = Number(process.env.HW_ZO_DSF ?? "1.37");
const OUT = process.env.HW_ZO_OUT ?? "";
const ZOOM = 0.8498685519398922;
const PANE = { w: 1185, h: 710 };
const STEP_PX = 22.66;
// POP BOUND PER INK, picked by the ink under test: HW_ZO_INK is the film's ink copy. The stand-in cell's landing reads 440
// to 534 on the film ink in five runs (da68643e, 41087511, 1c0c4327) and 0 on the fixture: thin strokes thinned out by the stand-in's
// 0.78 downscale reappear sharp at the landing. A defect of the dry-run shape reads at least the ink outside the start view, about
// 3600 on the film ink and 9700 on the fixture.
const POP_MAX_FILM = 1000;
const POP_MAX_FIXTURE = 500;
const POP_MAX = process.env.HW_ZO_INK ? POP_MAX_FILM : POP_MAX_FIXTURE;
// The landed layer against the control's: two draws of the same strokes differ by a pixel (inked totals 76487 against
// 76486), and the held run reads 2 to 3 over the control in four of four runs, unread. A defect of the stand-in-as-landing shape
// reads hundreds or more.
const LANDED_LAYER_SLACK = 8;

const ENTRY = `import "./panBakeRepaintPage.ts";
import { overlayForPath, inlineInk, inkCanvasReallocs } from "../../src/inline/InkOverlay";
import { inkLookKey, EXTENT_PAIR_FACTOR, EXTENT_RASTER_MAX_PX_DESKTOP } from "../../src/inline/InkOverlayConstants";
const PATH = "Untitled 1.md";
const frame = () => new Promise<void>(r => requestAnimationFrame(() => r()));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await frame(); };
const Z: any = { masks: new Map(), draws: 0, made: 0, watched: [] as HTMLCanvasElement[], wraps: [] as Array<() => void>, snaps: [] as any[], holds: [] as Array<() => void> };
const ov = (): any => overlayForPath(PATH);
const box = (o: any): HTMLElement | null => o.view.dom.querySelector(":scope > .handwriting-ink-held");
const shown = (c: HTMLCanvasElement | null | undefined) => !!c && c.isConnected && getComputedStyle(c).visibility !== "hidden" && c.style.display !== "none";
/** usableExtent's own test (InkOverlayExtent.ts), term by term, against the strokes the committed layer paints from, with no side effect. */
function heldTerms(o: any) {
	const e = o.extentRaster, cam = o.lastPaintCam, strokes = o.committedStrokes(o.freeStrokes(PATH));
	if (!e || !cam) return { ext: !!e, cam: !!cam };
	return { path: e.path === o.filePath() && e.path === PATH, zoom: e.cam0.zoom === cam.zoom, backing: e.backing === o.committedBacking, dpr: e.dpr === o.dpr,
		look: e.look === inkLookKey(), strokes: e.strokes === strokes, count: e.count === strokes.length, generation: e.generation === inlineInk.generation(PATH),
		hlPair: !(e.hl && o.highlightPairDeferred) };
}
function heldNow(o: any) { return Object.values(heldTerms(o)).every(Boolean); }
function snap(tag: string) {
	const o = ov(), b = box(o), canv = b ? Array.from(b.querySelectorAll("canvas")) as HTMLCanvasElement[] : [];
	const w = Z.watched as HTMLCanvasElement[];
	const s = { tag, up: !!b && b.isConnected && canv.length > 0, inHost: !!b, canvases: canv.length, afterScroller: !!b && b.previousElementSibling === o.view.scrollDOM,
		holdsRaster: w.length > 0 && w.every(c => canv.includes(c)), zIndex: b ? getComputedStyle(b).zIndex : null,
		bandZ: o.container ? getComputedStyle(o.container).zIndex : null, paneShown: shown(o.committedCanvas), hlShown: shown(o.highlightCanvas),
		compositeShown: !!o.pinchComposite && shown(o.wetCanvas), inkShown: false, preview: !!o.pinchPreview, scale: o.pinchScaleNow, nums: null as any };
	s.inkShown = s.up || s.paneShown || s.compositeShown;
	const h = o.heldRaster, c = o.container;
	if (h && c) {
		const bt = tr(c.style.transform);
		s.nums = { inner: tr(h.inner.style.transform), layer: tr(o.inkLayer?.style.transform), band: { x: Number.parseFloat(c.style.left) + bt.x, y: Number.parseFloat(c.style.top) + bt.y },
			scroll: { ...h.scroll }, offset: o.previewInkOffset };
	}
	Z.snaps.push(s);
	return s;
}
/** A translate(x px, y px) style's numbers, (0, 0) for none. */
function tr(v: string | undefined) { const m = /translate\\((-?[\\d.e+-]+)px, ?(-?[\\d.e+-]+)px\\)/.exec(v ?? ""); return m ? { x: Number(m[1]), y: Number(m[2]) } : { x: 0, y: 0 }; }
function wrap(obj: any, name: string, make: (orig: any) => any) { const orig = obj[name]; obj[name] = make(orig); Z.wraps.push(() => { obj[name] = orig; }); }
(window as any).zo = {
	state() { const o = ov(); return { held: heldNow(o), terms: heldTerms(o), strokes: inlineInk.strokes(PATH).length, ext: o.extentRaster ? { w: o.extentRaster.pen.width, h: o.extentRaster.pen.height, hl: !!o.extentRaster.hl } : null,
		scale: o.pinchScaleNow, zoom: o.lastPaintCam?.zoom ?? null, noteZoom: o.getNoteViewportState().zoom, committed: [o.committedCanvas.width, o.committedCanvas.height],
		standIn: o.standIn ? { zoom: o.standIn.at.zoom, w: o.standIn.pen.width, h: o.standIn.pen.height, hl: !!o.standIn.hl, count: o.standIn.count,
			f: (o.lastPaintCam.zoom * o.committedBacking) / (o.standIn.at.zoom * o.standIn.backing) } : null,
		build: o.extentBuild ? { zoom: o.extentBuild.cam0.zoom, next: o.extentBuild.next, count: o.extentBuild.count, w: o.extentBuild.w, h: o.extentBuild.h,
			px: o.extentBuild.w * o.extentBuild.h * (o.extentBuild.hasHl ? 2 : 1) } : null, pairCap: EXTENT_PAIR_FACTOR * EXTENT_RASTER_MAX_PX_DESKTOP }; },
	/**
	 * "held": as mounted. "none": no raster and no stand-in. "stale": the raster kept while the store's generation moves on (a plant).
	 * "staying": a lasso drag's snapshot as the committed layer sees it, its last stroke lifted out: the layer and the raster hold the
	 * staying strokes while the store still counts them all. "offset": the first preview frame's ink layer offset moved 7.5 px off the
	 * column's own, as Readable line length re-centring the column moves it, with the pan unchanged.
	 */
	prep(mode: string) {
		const o = ov();
		if (mode === "control") o.putUpHeldRaster = () => {};
		if (mode === "none") { o.dropExtentBuild(); o.extentRaster = null; o.dropStandIn(); }
		if (mode === "stale") (inlineInk as any).byPath.get(PATH).mutationGeneration++;
		if (mode === "staying") {
			const staying = o.committedStrokes(o.freeStrokes(PATH)).slice(0, -1), e = o.extentRaster;
			wrap(o, "committedStrokes", () => () => staying);
			if (e) { e.strokes = staying; e.count = staying.length; }
		}
		if (mode === "offset") {
			Z.offsetDone = false;
			wrap(o, "applyPreviewInkOffset", orig => function (this: any, ...a: any[]) {
				const v = orig.apply(this, a);
				if (!Z.offsetDone) { Z.offsetDone = true; this.previewInkOffset = (this.previewInkOffset || 0) + 7.5; this.writeInkLayerTransform(); }
				return v;
			});
		}
		return (window as any).zo.state();
	},
	/**
	 * One attached group of the note's n topmost strokes, read from the store as a reopen reads it (its target text is in no line, so it
	 * holds at its stored points). The members leave the free list, so the raster is let go and built again from the free strokes.
	 * erased: the group also keeps the id of a stroke the store no longer holds, as an erase leaves it until the next load.
	 */
	async attach(n: number, erased = false) {
		const o = ov(), src = inlineInk.strokes(PATH), members = [...src].sort((a: any, b: any) => a.bbox.y - b.bbox.y).slice(0, n);
		const sig = o.lineAnchors.sig, m0 = members[0] as any;
		const rec = { v: 1, id: "zo-group", strokeIds: [...members.map((s: any) => s.id), ...(erased ? ["zo-erased-member"] : [])], target: { kind: "paragraph", from: 0, to: 0, text: "words that are not in this note", before: "", after: "" },
			ref: { x: m0.bbox.x, y: m0.bbox.y }, layout: { width: sig.width, font: sig.fontPx }, probe: { id: m0.id, x: m0.points[0].x, y: m0.points[0].y } };
		(inlineInk as any).setAttachments(PATH, [rec], false);
		o.dropExtentBuild(); o.extentRaster = null; o.dropStandIn();
		o.scheduleRepaint("zo-attach");
		await settle(8);
		await (window as any).panBake.awaitSharp();
		return { members: o.lineAnchors.follow.memberMap.size, free: o.freeStrokes(PATH).length, store: inlineInk.strokes(PATH).length, ...(window as any).zo.state() };
	},
	/** Watch the raster's canvases (draws into them) and every canvas made, from here until end(). */
	begin() {
		const o = ov(), e = o.extentRaster ?? o.standIn;
		Z.watched = e ? [e.pen, e.hl].filter(Boolean) : [];
		Z.draws = 0; Z.made = 0; Z.snaps = []; Z.realloc0 = inkCanvasReallocs();
		for (const n of ["drawImage", "fill", "stroke", "fillRect", "clearRect", "putImageData"])
			wrap(CanvasRenderingContext2D.prototype, n, orig => function (this: any, ...a: any[]) { if (Z.watched.includes(this.canvas)) Z.draws++; return orig.apply(this, a); });
		wrap(Document.prototype, "createElement", orig => function (this: any, tag: string, ...a: any[]) { if (String(tag).toLowerCase() === "canvas") Z.made++; return orig.call(this, tag, ...a); });
		wrap(Node.prototype, "cloneNode", orig => function (this: any, ...a: any[]) { if (this instanceof HTMLCanvasElement) Z.made++; return orig.apply(this, a); });
		Z.putUpMs = []; Z.lands = [];
		wrap(o, "putUpHeldRaster", orig => function (this: any, ...a: any[]) { const t = performance.now(); const v = orig.apply(this, a); Z.putUpMs.push(performance.now() - t); return v; });
		wrap(o, "landHeldRaster", orig => function (this: any, ...a: any[]) { const was = !!o.heldRaster; const v = orig.apply(this, a); Z.lands.push({ was, after: !!o.heldRaster, deferred: a[0] }); return v; });
		o.armWheelZoomQuiet = () => {};
		return snap("begin");
	},
	/** One wheel run's events, the quiet end held off: a read in the same call as the events (the gesture's start only), and one in the
	 * next frame's callback, after flushPinch has painted the first preview frame. */
	async wheel(n: number, dy: number, fx: number, fy: number) {
		const o = ov(), r = o.view.scrollDOM.getBoundingClientRect();
		const ev = { ctrlKey: true, metaKey: false, deltaY: dy, deltaMode: 0, clientX: r.left + fx, clientY: r.top + fy, preventDefault() {}, stopPropagation() {} };
		const t0 = performance.now();
		for (let i = 0; i < n; i++) o.wheelZoom(ev);
		const ms = performance.now() - t0;
		const same = snap("wheel-same-call");
		await frame();
		const nextMs = performance.now() - t0;
		const next = snap("wheel-next-frame");
		return { ms, nextMs, same, next, draws: Z.draws, made: Z.made, reallocs: inkCanvasReallocs() - Z.realloc0, putUpMs: Z.putUpMs.slice() };
	},
	/** n frames, then a read. */
	async frames(n: number) { await settle(n); return snap("after-" + n); },
	/**
	 * One wheel run landed on its own quiet end with the next build armed but its pieces held off (extentPieceAllowed says no until
	 * end() lets it go), as a quick next gesture finds the note: the raster at the old zoom kept as the stand-in, the layer copied
	 * from it, no raster held. The arm itself must run: a whole repaint lets go a stand-in that no build will replace.
	 */
	async landOnStandIn(dy: number, fx: number, fy: number) {
		const o = ov(), r = o.view.scrollDOM.getBoundingClientRect();
		const ev = { ctrlKey: true, metaKey: false, deltaY: dy, deltaMode: 0, clientX: r.left + fx, clientY: r.top + fy, preventDefault() {}, stopPropagation() {} };
		o.extentPieceAllowed = () => false;
		Z.holds.push(() => { delete o.extentPieceAllowed; });
		const ends: number[] = [];
		wrap(o, "pinch", orig => function (this: any, phase: string, ...a: any[]) { if (phase === "end") ends.push(performance.now()); return orig.call(this, phase, ...a); });
		const before = (window as any).zo.state();
		o.wheelZoom(ev);
		await frame();
		o.wheelZoom(ev);
		const t0 = performance.now();
		while (ends.length === 0 && performance.now() - t0 < 5000) await frame();
		await settle(8);
		for (const u of Z.wraps.splice(0).reverse()) u();
		return { before, landed: ends.length > 0, after: (window as any).zo.state() };
	},
	/** The pane's canvases alone on screen: the sibling hidden, the committed and highlight canvases shown (a read, then end()). */
	paneOnly() {
		const o = ov(), b = box(o);
		if (b) b.style.visibility = "hidden";
		for (const c of [o.committedCanvas, o.highlightCanvas]) if (c) c.style.visibility = "";
	},
	/** The raster let go mid-gesture as a paint at another zoom lets it go (usableExtent), then the stand-in it became dropped. */
	drop() {
		const o = ov(), cam = o.lastPaintCam;
		o.usableExtent({ ...cam, zoom: cam.zoom * 0.5 }, inlineInk.strokes(PATH));
		const afterLetGo = snap("let-go-same-call");
		const standInLetGo = !!o.standIn && (Z.watched as HTMLCanvasElement[]).includes(o.standIn.pen), extAfterLetGo = !!o.extentRaster;
		o.dropStandIn();
		return { afterLetGo, standInLetGo, extAfterLetGo, afterDrop: snap("drop-same-call") };
	},
	rects() {
		const o = ov(), sc = o.view.scrollDOM, p = sc.getBoundingClientRect(), c = o.committedCanvas.getBoundingClientRect();
		const sx = sc.offsetWidth > 0 ? p.width / sc.offsetWidth : 1, sy = sc.offsetHeight > 0 ? p.height / sc.offsetHeight : 1;
		return { pane: { x: p.left, y: p.top, w: p.width, h: p.height }, start: { x: c.left, y: c.top, w: c.width, h: c.height },
			client: { w: (sc.clientLeft + sc.clientWidth) * sx, h: (sc.clientTop + sc.clientHeight) * sy } };
	},
	/** The sibling's pen canvas's left and top edges, and the pane's committed canvas's, in device px (k per CSS px). */
	edges(k: number) {
		const o = ov(), h = o.heldRaster;
		if (!h) return null;
		const sr = h.src.pen.getBoundingClientRect(), cr = o.committedCanvas.getBoundingClientRect();
		return { sib: { l: sr.left * k, t: sr.top * k }, pane: { l: cr.left * k, t: cr.top * k } };
	},
	/** The note's zoom controls (made as a pen contact makes them when not yet made): their box in page CSS px, and whether they show. */
	controls() {
		const o = ov();
		if (!o.noteZoomControls) o.ensurePenTools();
		const el = o.noteZoomControls?.element as HTMLElement | undefined;
		if (!el) return null;
		const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
		return { x: r.left, y: r.top, w: r.width, h: r.height, label: el.querySelectorAll("button")[1]?.textContent ?? null, connected: el.isConnected, shown: cs.display !== "none" && cs.visibility !== "hidden" && Number(cs.opacity) > 0,
			outsideEditor: !o.view.dom.contains(el) };
	},
	/** The zoom controls painted or not (visibility only: their box and the stacking stay). */
	controlsShown(on: boolean) { const el = ov().noteZoomControls?.element as HTMLElement | undefined; if (el) el.style.visibility = on ? "" : "hidden"; },
	/**
	 * TEST-ONLY STYLE "zo-opaque-controls": the controls' own box painted with an opaque background, so ink at rest under them reads
	 * nothing through them and any ink the read finds over them on a preview frame is ink stacked above them. Not product styling.
	 */
	controlsOpaque() {
		let s = document.getElementById("zo-opaque-controls");
		if (!s) { s = document.head.appendChild(document.createElement("style")); s.id = "zo-opaque-controls"; s.textContent = ".zo-opaque-controls { background-color: rgb(32, 32, 32) !important; }"; }
		(ov().noteZoomControls?.element as HTMLElement | undefined)?.classList.add("zo-opaque-controls");
	},
	hide(on: boolean) {
		let s = document.getElementById("zo-hide");
		if (!s) { s = document.head.appendChild(document.createElement("style")); s.id = "zo-hide"; s.textContent = ".zo-hide canvas { visibility: hidden !important; }"; }
		ov().view.dom.classList.toggle("zo-hide", on);
	},
	/** Ink pixels: shown against hidden, both PNG base64 of the same clip; the count outside 'excl' (device px in the clip), the mask kept. */
	async diff(a: string, b: string, excl: { x0: number; y0: number; x1: number; y1: number } | null, keep: string) {
		const read = async (s: string) => { const bm = await createImageBitmap(await (await fetch("data:image/png;base64," + s)).blob());
			const c = new OffscreenCanvas(bm.width, bm.height), x = c.getContext("2d")!; x.drawImage(bm, 0, 0); return x.getImageData(0, 0, bm.width, bm.height); };
		const A = await read(a), B = await read(b), W = A.width, H = A.height, m = new Uint8Array(W * H);
		let all = 0, outside = 0;
		for (let y = 0, i = 0; y < H; y++) for (let x = 0; x < W; x++, i++) {
			const j = i * 4;
			const d = Math.max(Math.abs(A.data[j]! - B.data[j]!), Math.abs(A.data[j + 1]! - B.data[j + 1]!), Math.abs(A.data[j + 2]! - B.data[j + 2]!));
			if (d <= 24) continue;
			m[i] = 1; all++;
			if (!excl || x < excl.x0 || x >= excl.x1 || y < excl.y0 || y >= excl.y1) outside++;
		}
		Z.masks.set(keep, { m, W, H });
		return { all, outside, W, H };
	},
	/** Ink pixels of mask 'b' with no ink of mask 'a' within r px (a square), as the dry run's new-ink-in-blank count. */
	pop(a: string, b: string, r = 6, box: { x1: number; y1: number } | null = null) {
		const A = Z.masks.get(a), B = Z.masks.get(b);
		if (!A || !B || A.W !== B.W || A.H !== B.H) return -1;
		const W = A.W, H = A.H, h = new Uint8Array(W * H);
		for (let y = 0; y < H; y++) { let run = 0; const row = y * W;
			for (let x = 0; x < W + r; x++) { if (x < W && A.m[row + x]) run = 2 * r + 1; if (run > 0) { const t = x - r; if (t >= 0 && t < W) h[row + t] = 1; run--; } } }
		let n = 0;
		for (let x = 0; x < W; x++) { let run = 0;
			for (let y = 0; y < H + r; y++) { if (y < H && h[y * W + x]) run = 2 * r + 1; const t = y - r; const near = run > 0; if (run > 0) run--;
				if (t >= 0 && t < H && B.m[t * W + x] && !near && (!box || (x < box.x1 && t < box.y1))) n++; } }
		return n;
	},
	/**
	 * pop() after the whole device px shift (within max) that best lays mask 'b' on mask 'a': searched on 4 px cells, then refined
	 * by 1 px about the best cell. Returns the count at that shift, the shift, and the count unshifted.
	 */
	popAligned(a: string, b: string, r = 6, max = 64, box: { x1: number; y1: number } | null = null) {
		const A = Z.masks.get(a), B = Z.masks.get(b);
		if (!A || !B || A.W !== B.W || A.H !== B.H) return { n: -1, dx: 0, dy: 0, n0: -1 };
		const W = A.W, H = A.H, C = 4, cw = Math.ceil(W / C), chh = Math.ceil(H / C);
		const pool = (m: Uint8Array) => { const o = new Uint8Array(cw * chh); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (m[y * W + x]) o[((y / C) | 0) * cw + ((x / C) | 0)] = 1; return o; };
		const pa = pool(A.m), pb = pool(B.m), mc = Math.ceil(max / C);
		// Overlap of b moved by (dx, dy) cells on a.
		let best = { dx: 0, dy: 0, v: -1 };
		for (let dy = -mc; dy <= mc; dy++) for (let dx = -mc; dx <= mc; dx++) {
			let v = 0;
			for (let y = Math.max(0, -dy); y < Math.min(chh, chh - dy); y++) { const ra = (y + dy) * cw, rb = y * cw;
				for (let x = Math.max(0, -dx); x < Math.min(cw, cw - dx); x++) if (pb[rb + x] && pa[ra + x + dx]) v++; }
			if (v > best.v) best = { dx, dy, v };
		}
		const shifted = (dx: number, dy: number) => { const m = new Uint8Array(W * H);
			for (let y = 0; y < H; y++) { const ty = y + dy; if (ty < 0 || ty >= H) continue;
				for (let x = 0; x < W; x++) { const tx = x + dx; if (tx >= 0 && tx < W && B.m[y * W + x]) m[ty * W + tx] = 1; } }
			return m; };
		let fine = { dx: 0, dy: 0, n: Infinity };
		for (let ey = -C; ey <= C; ey++) for (let ex = -C; ex <= C; ex += 1) {
			const dx = best.dx * C + ex, dy = best.dy * C + ey;
			Z.masks.set("__s", { m: shifted(dx, dy), W, H });
			const n = (window as any).zo.pop(a, "__s", r, box);
			if (n < fine.n) fine = { dx, dy, n };
		}
		Z.masks.delete("__s");
		return { n: fine.n, dx: fine.dx, dy: fine.dy, n0: (window as any).zo.pop(a, b, r, box) };
	},
	/**
	 * One wheel run with the app's own quiet timer, then from its landing (the pinch end) up to limit ms: when a build is first seen,
	 * when the stand-in is gone, and when a raster first holds at the landed zoom. Times are ms after the landing, -1 for never.
	 */
	async alone(dy: number, fx: number, fy: number, limit: number) {
		const o = ov(), r = o.view.scrollDOM.getBoundingClientRect();
		const ev = { ctrlKey: true, metaKey: false, deltaY: dy, deltaMode: 0, clientX: r.left + fx, clientY: r.top + fy, preventDefault() {}, stopPropagation() {} };
		const ends: number[] = [];
		wrap(o, "pinch", orig => function (this: any, phase: string, ...a: any[]) { if (phase === "end") ends.push(performance.now()); return orig.call(this, phase, ...a); });
		// Each arm after the landing: whether a stand-in was held as it was called, and whether it left a build.
		const arms: Array<{ standIn: boolean; built: boolean }> = [];
		wrap(o, "armExtentBuild", orig => function (this: any, ...a: any[]) { const standIn = !!o.standIn; const v = orig.apply(this, a); if (ends.length > 0) arms.push({ standIn, built: !!o.extentBuild }); return v; });
		const at = (window as any).zo.state(), standInAtStart = !!o.standIn;
		const t0 = performance.now();
		o.wheelZoom(ev);
		await frame();
		o.wheelZoom(ev);
		while (ends.length === 0 && performance.now() - t0 < 5000) await frame();
		const tEnd = ends.length > 0 ? ends[0]! : -1;
		let held = -1, build = -1, noStandIn = -1;
		while (tEnd >= 0 && performance.now() - tEnd < limit) {
			const now = performance.now();
			if (build < 0 && o.extentBuild) build = now - tEnd;
			if (noStandIn < 0 && !o.standIn) noStandIn = now - tEnd;
			if (heldNow(o)) { held = now - tEnd; break; }
			await frame();
		}
		for (const u of Z.wraps.splice(0).reverse()) u();
		const round = (v: number) => (v < 0 ? -1 : Math.round(v));
		return { at, standInAtStart, arms, landed: tEnd >= 0, scaleAfter: o.pinchScaleNow, landToHeld: round(held), landToBuild: round(build),
			landToNoStandIn: round(noStandIn), heldAfter: heldNow(o), buildAfter: !!o.extentBuild, standInAfter: !!o.standIn };
	},
	/** Let the run end on its quiet timer, read every frame of the landing, then wait for the sharp raster. */
	async end() {
		const o = ov();
		for (const u of Z.holds.splice(0)) u();
		const box0 = box(o);
		if (box0) box0.style.visibility = "";
		delete o.armWheelZoomQuiet;
		o.armWheelZoomQuiet();
		const frames: any[] = [];
		for (let j = 0; j < 40; j++) { await frame(); frames.push(snap("landing-" + j)); }
		for (const t50 = performance.now(); performance.now() - t50 < 50;) await frame();
		await (window as any).panBake.awaitSharp();
		await settle(4);
		const final = snap("landed");
		const res = { frames, final, draws: Z.draws, made: Z.made, reallocs: inkCanvasReallocs() - Z.realloc0, snaps: Z.snaps.slice(), lands: (Z.lands ?? []).slice(),
			layer: (window as any).panBake.layerVsPath(), held: heldNow(o), scale: o.pinchScaleNow };
		for (const u of Z.wraps.splice(0).reverse()) u();
		return res;
	},
};`;

let script: string;
let browser: Browser;
const report: Record<string, unknown> = { dsf: DSF, ink: process.env.HW_ZO_INK ?? "fixtures/alan-ink-75d1627a.json" };
beforeAll(async () => {
	const b = await build({
		stdin: { contents: ENTRY, resolveDir: fileURLToPath(new URL("./", import.meta.url)), sourcefile: "zoomOutHeldRasterEntry.ts", loader: "ts" },
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
		const mounted = await page.evaluate(([z, s, id, w, h, n]) => (window as any).panBake.mount(z, s, id, w, h, n), [ZOOM, INK, PAGE_ID, PANE.w, PANE.h, want] as const) as any;
		expect(mounted.strokes, "premise: every stroke loaded").toBe(want);
		expect(mounted.dpr, "premise: the device ratio is the flag's").toBeCloseTo(DSF, 2);
		expect(mounted.zoomCommitted, "premise: the start zoom committed").toBe(true);
		await page.evaluate(() => (window as any).panBake.awaitSharp());
		await body(page);
		expect(errors, `${name}: page errors`).toEqual([]);
	} finally { await context.close(); }
}

/** One preview frame read on screen: ink pixels outside the start view's box, the mask kept as `keep`. */
async function readFrame(page: Page, keep: string, excludeStart: boolean) {
	const r = await page.evaluate(() => (window as any).zo.rects()) as { pane: any; start: any; client: { w: number; h: number } };
	const clip = { x: r.pane.x, y: r.pane.y, width: r.pane.w, height: r.pane.h };
	const a = (await page.screenshot({ clip })).toString("base64");
	await page.evaluate(() => (window as any).zo.hide(true));
	const b = (await page.screenshot({ clip })).toString("base64");
	await page.evaluate(() => (window as any).zo.hide(false));
	const k = DSF, s = r.start, p = r.pane;
	// The start view's box in clip device px, grown by 2 px for the edge's antialiasing.
	const excl = excludeStart ? { x0: Math.floor((s.x - p.x) * k) - 2, y0: Math.floor((s.y - p.y) * k) - 2, x1: Math.ceil((s.x + s.w - p.x) * k) + 2, y1: Math.ceil((s.y + s.h - p.y) * k) + 2 } : null;
	const d = await page.evaluate(([a, b, e, kk]) => (window as any).zo.diff(a, b, e, kk), [a, b, excl, keep] as const) as { all: number; outside: number };
	// The scroller's client box in clip device px (the pane less its scrollbar gutter).
	return { ...d, client: { x1: Math.floor(r.client.w * k), y1: Math.floor(r.client.h * k) } };
}

/** The film's wheel run: two events of 22.66 px about the page's top-left; the preview frame read, then the run let land. */
async function wheelRun(page: Page, i: number) {
	const w = await page.evaluate(([dy]) => (window as any).zo.wheel(2, dy, 40, 40), [STEP_PX] as const) as any;
	const preview = await readFrame(page, `p${i}`, true);
	await page.evaluate(() => (window as any).zo.frames(8));
	const last = await readFrame(page, `q${i}`, true);
	const end = await page.evaluate(() => (window as any).zo.end()) as any;
	const landed = await readFrame(page, `l${i}`, false);
	const aligned = await page.evaluate(([a, b, box]) => (window as any).zo.popAligned(a, b, 6, 64, box), [`q${i}`, `l${i}`, last.client] as const) as { n: number; dx: number; dy: number; n0: number };
	return { w, preview, last, end, landed, pop: aligned.n, popShift: [aligned.dx, aligned.dy], popUnaligned: aligned.n0, popBox: last.client };
}

it(`held raster at dsf ${DSF}: the first wheel run's preview frame shows ink outside the start view, and its landing pops no ink in`, async () => {
	await withPage("ink outside", async page => {
		const runs: unknown[] = [];
		let first: any = null;
		for (let i = 0; i < 6; i++) {
			const at = await page.evaluate(() => (window as any).zo.state()) as any;
			await page.evaluate(() => (window as any).zo.begin());
			const r = await wheelRun(page, i);
			runs.push({ run: i, heldAtStart: at.held, ext: at.ext, scaleFrom: at.scale, scaleTo: r.end.scale, inkOutside: r.preview.outside, inkAll: r.preview.all,
				lastOutside: r.last.outside, lastAll: r.last.all, landedInk: r.landed.all, pop: r.pop, popShift: r.popShift, popUnaligned: r.popUnaligned, popBox: r.popBox, wheelMs: r.w.ms, upFirstFrame: r.w.next.up });
			if (i === 0) first = { at, r };
		}
		report.inkOutside = runs;
		console.log("ZO-RUNS " + JSON.stringify(runs));
		expect(first.at.held, "premise: the extent raster is held at the start zoom").toBe(true);
		expect(first.r.w.next.preview, "premise: the first wheel run put a preview up").toBe(true);
		expect(first.r.preview.outside, "ink pixels outside the start view on the first run's preview frame").toBeGreaterThan(0);
		expect(first.r.pop, `ink pixels popping in at the first run's landing (at most ${POP_MAX})`).toBeLessThanOrEqual(POP_MAX);
	});
}, 600_000);

/**
 * The no-build at a landing: from 85 to 67.8 percent the new build and the stand-in the landing keeps do not fit the pair cap together,
 * and the stand-in cut to the build's grid does not fit either. The stand-in must go and the build must still be armed, so a raster
 * holds at the landed zoom within a second (a build there takes 330 to 420 ms on the film ink).
 */
it(`one wheel run from 85 to 67.8 percent at dsf ${DSF}: a raster holds at the landed zoom within 1 s of the landing`, async () => {
	await withPage("rebuild", async page => {
		const r = await page.evaluate(([dy]) => (window as any).zo.alone(dy, 40, 40, 1000), [STEP_PX] as const) as any;
		report.rebuild = r;
		console.log("ZO-REBUILD " + JSON.stringify(r));
		expect(r.at.held, "premise: the extent raster is held at the start zoom").toBe(true);
		expect(r.landed, "premise: the run landed on its quiet end").toBe(true);
		expect(r.scaleAfter, "premise: the run landed at 67.8 percent").toBeCloseTo(0.678, 2);
		expect((r.arms as Array<{ standIn: boolean }>).some(a => a.standIn), `premise: a build was asked after the landing with the old raster held as the stand-in (${JSON.stringify(r.arms)})`).toBe(true);
		expect(r.landToHeld, `a raster holds at the landed zoom within 1 s of the landing (build seen ${r.landToBuild} ms, stand-in gone ${r.landToNoStandIn} ms)`).toBeGreaterThanOrEqual(0);
	});
}, 600_000);

it(`held raster at dsf ${DSF}: on the first preview frame one sibling right after the scroller holds the raster's own canvases, the pane's canvases hidden and the composite off in the same frame; nothing drawn into them and no canvas made during the gesture`, async () => {
	await withPage("put-up", async page => {
		const at = await page.evaluate(() => (window as any).zo.state()) as any;
		await page.evaluate(() => (window as any).zo.begin());
		const w = await page.evaluate(([dy]) => (window as any).zo.wheel(2, dy, 40, 40), [STEP_PX] as const) as any;
		const end = await page.evaluate(() => (window as any).zo.end()) as any;
		report.putUp = { at, same: w.same, next: w.next, draws: w.draws, made: w.made, reallocs: w.reallocs, wheelMs: w.ms, putUpMs: w.putUpMs };
		const later = (end.frames as Array<{ up: boolean; preview: boolean }>).filter(s => s.preview);
		report.putUp = { ...(report.putUp as object), laterPreviewFrames: later.length };
		expect(at.held, "premise: the extent raster is held at the start zoom").toBe(true);
		expect(w.next.preview, "premise: the first preview frame is painted").toBe(true);
		expect(w.next.up, "the sibling is up on the first preview frame").toBe(true);
		expect(w.next.afterScroller, "the sibling is the scroller's next sibling").toBe(true);
		expect(w.next.holdsRaster, "the sibling holds the raster's own pen and highlighter canvases").toBe(true);
		expect(w.next.paneShown, "the pane's committed canvas is hidden on the same frame").toBe(false);
		expect(w.next.hlShown, "the pane's highlight canvas is hidden on the same frame").toBe(false);
		expect(w.next.compositeShown, "the pinch composite does not show the ink twice under the sibling").toBe(false);
		expect(later.every(s => s.up), "the sibling stays up on every later preview frame").toBe(true);
		expect(w.draws, "draws into the raster's canvases during the gesture").toBe(0);
		expect(w.made, "canvases made during the gesture").toBe(0);
		expect(w.reallocs, "ink canvas reallocations during the gesture").toBe(0);
		expect(end.final.canvases, "after the landing the sibling holds no canvas").toBe(0);
	});
}, 600_000);

/**
 * The zoom controls stay over the ink while a raster is held: below 100 percent, on the first preview frame, the controls' box reads
 * the same with every canvas in the editor shown as with every one hidden. A pixel read, not elementFromPoint: the held element
 * takes no pointer events, so a hit test passes whatever it paints over. The controls are painted opaque by the test-only style
 * "zo-opaque-controls" (zo.controlsOpaque), so at rest the read is 0 and only ink stacked above them counts on the preview frame;
 * where the box's own edge still reads ink at rest (rounded corners), the box is inset until it reads 0, and the inset is logged.
 * The premise read is the same box with the controls themselves unpainted: ink must lie under them at rest, or the cell reads
 * nothing. "Below 100 percent" is the zoom the controls show (getNoteViewportState().zoom, the middle button's label), not the
 * paint camera's zoom, which is in another unit. Five pans, each settled before the gesture: the start, three down the column (150
 * and 450 CSS px move the camera off whole device px, 300 onto them) and one across, so the held element must go up at every one.
 */
const CONTROLS_PANS: ReadonlyArray<readonly [number, number]> = [[0, 0], [0, -150], [0, -300], [0, -450], [-300, -300]];
const CONTROLS_INSETS = [1, 2, 3, 4, 6, 8];
it(`held raster at dsf ${DSF}: on the first preview frame below 100 percent no ink paints over the zoom controls, at five pans`, async () => {
	const rows: any[] = [];
	for (const [px, py] of CONTROLS_PANS) await withPage(`controls ${px},${py}`, async page => {
		const pan = await page.evaluate(([x, y]) => (window as any).panBake.settlePan(x, y), [px, py] as const) as any;
		await page.evaluate(() => (window as any).panBake.awaitSharp());
		const at = await page.evaluate(() => (window as any).zo.state()) as any;
		const c = await page.evaluate(() => (window as any).zo.controls()) as { x: number; y: number; w: number; h: number; label: string | null; connected: boolean; shown: boolean; outsideEditor: boolean } | null;
		expect(c, `premise at pan ${px},${py}: the note's zoom controls are made`).not.toBe(null);
		await page.evaluate(() => (window as any).zo.controlsOpaque());
		// The controls' box less `inset` CSS px each side.
		const clipAt = (inset: number) => ({ x: c!.x + inset, y: c!.y + inset, width: c!.w - 2 * inset, height: c!.h - 2 * inset });
		const inkOver = async (inset: number, keep: string) => {
			const clip = clipAt(inset);
			const a = (await page.screenshot({ clip })).toString("base64");
			await page.evaluate(() => (window as any).zo.hide(true));
			const b = (await page.screenshot({ clip })).toString("base64");
			await page.evaluate(() => (window as any).zo.hide(false));
			return (await page.evaluate(([a, b, kk]) => (window as any).zo.diff(a, b, null, kk), [a, b, keep] as const) as { all: number }).all;
		};
		const inkUnder = async (inset: number, keep: string) => {
			await page.evaluate(() => (window as any).zo.controlsShown(false));
			const v = await inkOver(inset, keep);
			await page.evaluate(() => (window as any).zo.controlsShown(true));
			return v;
		};
		// At rest: the smallest inset whose read is 0, every inset tried logged.
		const tried: Array<[number, number]> = [];
		let inset = -1;
		for (const i of CONTROLS_INSETS) {
			const v = await inkOver(i, `rest-${i}`);
			tried.push([i, v]);
			if (v === 0) { inset = i; break; }
		}
		const use = inset >= 0 ? inset : CONTROLS_INSETS[CONTROLS_INSETS.length - 1]!;
		const restUnder = await inkUnder(use, "rest-under");
		await page.evaluate(() => (window as any).zo.begin());
		const w = await page.evaluate(([dy]) => (window as any).zo.wheel(2, dy, 40, 40), [STEP_PX] as const) as any;
		const over = await inkOver(use, "ctl");
		const under = await inkUnder(use, "ctl-under");
		await page.evaluate(() => (window as any).zo.end());
		rows.push({ pan: [px, py], settled: pan.pan, at: { held: at.held, noteZoom: at.noteZoom, camZoom: at.zoom }, box: c, inset, tried,
			rest: { over: tried[tried.length - 1]![1], under: restUnder }, up: w.next.up, preview: w.next.preview, scale: w.next.scale, inkOver: over, inkUnder: under,
			wheelMs: w.ms, putUpMs: w.putUpMs, nextMs: w.nextMs });
	});
	report.controls = rows;
	console.log("ZO-CONTROLS " + JSON.stringify(rows));
	const restUnder = rows.map(r => `${r.pan[0]},${r.pan[1]} ${r.rest.under}`).join("; ");
	console.log("ZO-CONTROLS-REST-UNDER " + restUnder);
	expect(rows.some(r => r.rest.under > 0), `premise: ink lies under the zoom controls' box at rest at one pan at least (${restUnder})`).toBe(true);
	for (const r of rows) {
		const p = `at pan ${r.pan[0]},${r.pan[1]}`;
		expect(r.at.held, `premise ${p}: the extent raster is held at the start zoom`).toBe(true);
		expect(r.at.noteZoom, `premise ${p}: the zoom the controls show is below 100 percent`).toBeLessThan(1);
		expect(r.box.connected && r.box.shown, `premise ${p}: the zoom controls are on the page and shown`).toBe(true);
		expect(r.box.outsideEditor, `premise ${p}: the zoom controls sit outside the editor, beside the held element's host`).toBe(true);
		expect(r.inset, `premise ${p}: at rest an inset of the opaque controls' box reads no ink (tried ${JSON.stringify(r.tried)})`).toBeGreaterThanOrEqual(0);
		expect(r.preview, `premise ${p}: the first preview frame is painted`).toBe(true);
		expect(r.up, `${p}: the held element is up on the first preview frame`).toBe(true);
		expect(r.inkOver, `${p}: ink pixels painted over the zoom controls on the first preview frame`).toBe(0);
	}
}, 600_000);

let controlLayer: any = null;
it(`control at dsf ${DSF}: the same gesture with the sibling never put up, for the landed layer`, async () => {
	await withPage("control", async page => {
		await page.evaluate(() => (window as any).zo.prep("control"));
		await page.evaluate(() => (window as any).zo.begin());
		await page.evaluate(([dy]) => (window as any).zo.wheel(2, dy, 40, 40), [STEP_PX] as const);
		const end = await page.evaluate(() => (window as any).zo.end()) as any;
		controlLayer = end.layer;
		report.control = { layer: end.layer, up: (end.snaps as Array<{ up: boolean }>).some(s => s.up) };
		expect((end.snaps as Array<{ up: boolean }>).some(s => s.up), "premise: the control never puts the sibling up").toBe(false);
	});
}, 600_000);

it(`held raster at dsf ${DSF}: no frame from put-up through the landing shows neither the sibling nor the pane's canvases, and the landed layer is the control's`, async () => {
	await withPage("swap", async page => {
		await page.evaluate(() => (window as any).zo.begin());
		await page.evaluate(([dy]) => (window as any).zo.wheel(2, dy, 40, 40), [STEP_PX] as const);
		const end = await page.evaluate(() => (window as any).zo.end()) as any;
		const snaps = end.snaps as Array<{ tag: string; up: boolean; inkShown: boolean }>;
		const neither = snaps.filter(s => !s.inkShown).map(s => s.tag);
		report.swap = { neither, upFrames: snaps.filter(s => s.up).length, final: end.final, layer: end.layer };
		expect(snaps.some(s => s.up), "the sibling went up during the gesture").toBe(true);
		expect(neither, "frames that show neither the sibling nor the pane's canvases").toEqual([]);
		expect(end.final.up, "the sibling is down after the landing").toBe(false);
		expect(end.final.paneShown, "the pane's committed canvas is shown after the landing").toBe(true);
		expect(controlLayer, "premise: the control cell ran").not.toBe(null);
		const against = `landed committed layer against a path draw (${JSON.stringify(end.layer)}), against the control's (${JSON.stringify(controlLayer)})`;
		expect(Math.abs(end.layer.over24 - controlLayer.over24), `over24 within ${LANDED_LAYER_SLACK}: ${against}`).toBeLessThanOrEqual(LANDED_LAYER_SLACK);
		expect(Math.abs(end.layer.pmOver24 - controlLayer.pmOver24), `pmOver24 within ${LANDED_LAYER_SLACK}: ${against}`).toBeLessThanOrEqual(LANDED_LAYER_SLACK);
	});
}, 600_000);

it(`held raster at dsf ${DSF}: a raster let go mid-gesture comes down with the pane's canvases shown in the same call`, async () => {
	await withPage("drop", async page => {
		await page.evaluate(() => (window as any).zo.begin());
		const w = await page.evaluate(([dy]) => (window as any).zo.wheel(2, dy, 40, 40), [STEP_PX] as const) as any;
		const d = await page.evaluate(() => (window as any).zo.drop()) as any;
		const w2 = await page.evaluate(([dy]) => (window as any).zo.wheel(2, dy, 40, 40), [STEP_PX] as const) as any;
		const end = await page.evaluate(() => (window as any).zo.end()) as any;
		const neither = (end.snaps as Array<{ tag: string; inkShown: boolean }>).filter(s => !s.inkShown).map(s => s.tag);
		report.drop = { before: w.next, afterLetGo: d.afterLetGo, standInLetGo: d.standInLetGo, extAfterLetGo: d.extAfterLetGo, afterDrop: d.afterDrop, next: w2.next, neither };
		expect(w.next.up, "the sibling was up before the drop").toBe(true);
		expect(d.extAfterLetGo, "premise: the let-go took the raster away").toBe(false);
		expect(d.afterDrop.up, "the sibling is down in the same call as the drop").toBe(false);
		expect(d.afterDrop.paneShown, "the pane's committed canvas is shown in the same call as the drop").toBe(true);
		expect(w2.next.preview, "premise: the later events painted a preview frame").toBe(true);
		expect(w2.next.up, "a later preview frame does not put a dropped raster back up").toBe(false);
		expect(neither, "frames that show neither").toEqual([]);
	});
}, 600_000);

it(`no raster held at dsf ${DSF}: nothing is placed, no canvas is made and the pane's canvases stay shown`, async () => {
	await withPage("none", async page => {
		const at = await page.evaluate(() => (window as any).zo.prep("none")) as any;
		await page.evaluate(() => (window as any).zo.begin());
		const w = await page.evaluate(([dy]) => (window as any).zo.wheel(2, dy, 40, 40), [STEP_PX] as const) as any;
		const end = await page.evaluate(() => (window as any).zo.end()) as any;
		report.none = { at, next: w.next, made: w.made, reallocs: w.reallocs, wheelMs: w.ms, putUpMs: w.putUpMs };
		expect(at.ext, "premise: no raster").toBe(null);
		expect(w.next.preview, "premise: the preview is up").toBe(true);
		expect((end.snaps as Array<{ up: boolean }>).some(s => s.up), "the sibling never goes up").toBe(false);
		expect((end.snaps as Array<{ inkShown: boolean }>).every(s => s.inkShown), "the pane's ink (its canvases or the composite) is shown on every read").toBe(true);
		expect(w.made, "canvases made during the gesture").toBe(0);
		expect(w.reallocs, "ink canvas reallocations during the gesture").toBe(0);
	});
}, 600_000);

it(`stale raster at dsf ${DSF} (the store's generation moved on): nothing is placed`, async () => {
	await withPage("stale", async page => {
		const at = await page.evaluate(() => (window as any).zo.prep("stale")) as any;
		await page.evaluate(() => (window as any).zo.begin());
		const w = await page.evaluate(([dy]) => (window as any).zo.wheel(2, dy, 40, 40), [STEP_PX] as const) as any;
		const end = await page.evaluate(() => (window as any).zo.end()) as any;
		report.stale = { at, next: w.next };
		expect(at.ext, "premise: the raster is still there").not.toBe(null);
		expect(at.held, "premise: it no longer holds the store").toBe(false);
		expect(w.next.preview, "premise: the preview is up").toBe(true);
		expect((end.snaps as Array<{ up: boolean }>).some(s => s.up), "a stale raster never goes up").toBe(false);
	});
}, 600_000);

/**
 * A big note's landing: the old raster and the build for the landed zoom do not fit the pair cap
 * side by side (29.5 M px fixture, 31.1 M px film, held over both layers), so the stand-in is shrunk to the largest grid at or under
 * the build's at which the pair fits, and the build runs beside it. Read at the landing, the build's pieces held off.
 */
it(`stand-in at dsf ${DSF}: a wheel run's landing on a big note keeps the old raster as a stand-in shrunk to fit beside the build`, async () => {
	await withPage("stand-in fit", async page => {
		const land = await page.evaluate(([dy]) => (window as any).zo.landOnStandIn(dy, 40, 40), [STEP_PX] as const) as any;
		console.log("ZO-STANDIN-FIT " + JSON.stringify(land));
		report.standInFit = land;
		const a = land.after, st = a.standIn, b = a.build;
		expect(land.landed, "premise: the run landed on its quiet end").toBe(true);
		expect(land.before.held, "premise: the extent raster is held at the start zoom").toBe(true);
		expect(a.ext, "premise: no raster at the landed zoom").toBe(null);
		expect(b?.zoom, "premise: the build for the landed zoom is armed and held").toBe(a.zoom);
		expect(st, "the stand-in is kept at the landing").not.toBe(null);
		expect(st.w <= b.w && st.h <= b.h, `the stand-in's grid is at or under the build's (${st.w}x${st.h} against ${b.w}x${b.h})`).toBe(true);
		expect(st.w * st.h * (st.hl ? 2 : 1) + b.px, "the stand-in and the build together fit the pair cap").toBeLessThanOrEqual(a.pairCap);
		expect(st.f, "the landed copy upscales the stand-in at most 2").toBeLessThanOrEqual(2 + 1e-9);
	});
}, 600_000);

/**
 * The fallback: a short wheel run (two events of 4 px, about 85 to 82 percent) asks a build so near the old raster's size that the
 * fit would be under one half on a side; the stand-in is dropped and the build is armed alone (5d62ba0e).
 */
it(`stand-in at dsf ${DSF}: a landing whose fit would be under one half a side drops the stand-in and builds alone`, async () => {
	await withPage("stand-in floor", async page => {
		const land = await page.evaluate(() => (window as any).zo.landOnStandIn(4, 40, 40)) as any;
		console.log("ZO-STANDIN-FLOOR " + JSON.stringify(land));
		report.standInFloor = land;
		const a = land.after, b = a.build;
		expect(land.landed, "premise: the run landed on its quiet end").toBe(true);
		expect(land.before.held, "premise: the extent raster is held at the start zoom").toBe(true);
		expect(a.ext, "premise: no raster at the landed zoom").toBe(null);
		expect(b, "the build for the landed zoom is armed").not.toBe(null);
		const fit = Math.sqrt(Math.max(0, a.pairCap - b.px) / b.px);
		expect(fit, `premise: the fit is under one half a side (build ${b.px} px)`).toBeLessThan(0.5);
		expect(a.standIn, "the stand-in is dropped").toBe(null);
	});
}, 600_000);

/**
 * The stand-in as the source: the second of two quick wheel runs, started while the raster for the first run's landed zoom is still
 * to be built (armed, its pieces held off here), so the old raster is the stand-in and no raster holds. The sibling holds the
 * stand-in's own canvases, at its own zoom, CSS-scaled once at put-up.
 */
async function standInStart(page: Page) {
	const land = await page.evaluate(([dy]) => (window as any).zo.landOnStandIn(dy, 40, 40), [STEP_PX] as const) as any;
	console.log("ZO-STANDIN-LAND " + JSON.stringify(land));
	expect(land.landed, "premise: the first run landed on its quiet end").toBe(true);
	expect(land.before.held, "premise: the extent raster is held at the start zoom").toBe(true);
	expect(land.after.ext, "premise: no raster at the landed zoom").toBe(null);
	expect(land.after.build?.zoom, "premise: the build for the landed zoom is armed and held").toBe(land.after.zoom);
	expect(land.after.standIn, "premise: the stand-in is kept at the landed zoom").not.toBe(null);
	// A big note's stand-in is shrunk to fit beside the build, so its copy at the landing upscales (factor over 1, at most 2).
	expect(Math.abs(land.after.standIn.f - 1), "premise: the stand-in is at another density than the landed layer (copy factor off 1)").toBeGreaterThan(0.01);
	return land;
}

it(`stand-in at dsf ${DSF}: the second quick wheel run's preview frame shows ink outside the start view from the stand-in, and its landing pops no ink in`, async () => {
	await withPage("stand-in pop", async page => {
		const land = await standInStart(page);
		await page.evaluate(() => (window as any).zo.begin());
		const r = await wheelRun(page, 0);
		report.standInPop = { land, next: r.w.next, wheelMs: r.w.ms, draws: r.w.draws, made: r.w.made, reallocs: r.w.reallocs, inkOutside: r.preview.outside, inkAll: r.preview.all,
			lastOutside: r.last.outside, landedInk: r.landed.all, pop: r.pop, popShift: r.popShift, popUnaligned: r.popUnaligned, final: r.end.final };
		console.log("ZO-STANDIN-POP " + JSON.stringify(report.standInPop));
		expect(r.w.next.preview, "premise: the second run put a preview up").toBe(true);
		expect(r.pop, `ink pixels popping in at the second run's landing (at most ${POP_MAX})`).toBeLessThanOrEqual(POP_MAX);
		expect(r.preview.outside, "ink pixels outside the start view on the second run's first preview frame").toBeGreaterThan(0);
		expect(r.w.next.up, "the sibling is up on the second run's first preview frame").toBe(true);
		expect(r.w.next.holdsRaster, "the sibling holds the stand-in's own canvases").toBe(true);
		expect(r.w.next.paneShown, "the pane's committed canvas is hidden on the same frame").toBe(false);
		expect(r.w.draws, "draws into the stand-in's canvases during the gesture").toBe(0);
		expect(r.w.made, "canvases made during the gesture").toBe(0);
		expect(r.w.reallocs, "ink canvas reallocations during the gesture").toBe(0);
		expect(r.end.final.up, "the sibling is down after the landing").toBe(false);
		expect(r.end.final.paneShown, "the pane's committed canvas is shown after the landing").toBe(true);
	});
}, 600_000);

/**
 * Registration over the stand-in: on the second run's first preview frame, the sibling's ink against the pane's own committed ink,
 * same frame (the pane's layer is copied from the stand-in with a scaled draw, the sibling scales it by CSS). Inside the start view's
 * box less 4 px (clamped at the pane's top left), the column and row ink profiles of the pane against the sibling's are
 * cross-correlated at lags -6 to 6 device px and the peak refined by a parabola: the sub-pixel offset on x and y must each be
 * strictly under 1 device px. Not (0, 0): the pane sits inside the scroller and the sibling outside it, and the browser rounds the
 * two trees at different points, a per-page term measured up to 0.76 device px. So a defect of the page term's sign is caught from
 * 0.49 (fixture) and 0.79 (film) device px, a defect of the other sign from 1.49 and 1.79, until the 1.5.1 clip move takes the term
 * away.
 */
it(`stand-in at dsf ${DSF}: the stand-in in the sibling lies where the pane's committed ink lies on the first preview frame`, async () => {
	await withPage("stand-in registration", async page => {
		const land = await standInStart(page);
		await page.evaluate(() => (window as any).zo.begin());
		const w = await page.evaluate(([dy]) => (window as any).zo.wheel(2, dy, 40, 40), [STEP_PX] as const) as any;
		const r = await page.evaluate(() => (window as any).zo.rects()) as any;
		// Read out, not asserted: the sibling's canvas left and top edges in device px after the write, and the pane's.
		const edges = await page.evaluate(([k]) => (window as any).zo.edges(k), [DSF] as const) as any;
		const clip = { x: r.pane.x, y: r.pane.y, width: r.pane.w, height: r.pane.h };
		const sib = (await page.screenshot({ clip })).toString("base64");
		await page.evaluate(() => (window as any).zo.hide(true));
		const none = (await page.screenshot({ clip })).toString("base64");
		await page.evaluate(() => (window as any).zo.hide(false));
		await page.evaluate(() => (window as any).zo.paneOnly());
		const pane = (await page.screenshot({ clip })).toString("base64");
		const k = DSF, s = r.start, p = r.pane;
		const bx = { x0: Math.max(0, Math.ceil((s.x - p.x) * k) + 4), y0: Math.max(0, Math.ceil((s.y - p.y) * k) + 4),
			x1: Math.floor((s.x + s.w - p.x) * k) - 4, y1: Math.floor((s.y + s.h - p.y) * k) - 4 };
		const res = await page.evaluate(async ([a, b, n, bx]) => {
			const read = async (s: string) => { const bm = await createImageBitmap(await (await fetch("data:image/png;base64," + s)).blob());
				const c = new OffscreenCanvas(bm.width, bm.height), x = c.getContext("2d")!; x.drawImage(bm, 0, 0); return x.getImageData(0, 0, bm.width, bm.height); };
			const A = await read(a), B = await read(b), N = await read(n), W = A.width, H = A.height;
			const ink = (I: ImageData) => { const m = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) { const j = i * 4;
				if (Math.max(Math.abs(I.data[j]! - N.data[j]!), Math.abs(I.data[j + 1]! - N.data[j + 1]!), Math.abs(I.data[j + 2]! - N.data[j + 2]!)) > 24) m[i] = 1; } return m; };
			const ms = ink(A), mp = ink(B);
			const x1 = Math.min(bx.x1, W), y1 = Math.min(bx.y1, H);
			const cnt = (dx: number, dy: number) => { let so = 0, po = 0, both = 0; for (let y = bx.y0; y < y1; y++) for (let x = bx.x0; x < x1; x++) {
				const yy = y + dy, xx = x + dx; const q = yy >= 0 && yy < H && xx >= 0 && xx < W ? mp[yy * W + xx]! : 0; const v = ms[y * W + x]!;
				if (v && q) both++; else if (v) so++; else if (q) po++; } return { so, po, both }; };
			let best = { dx: 0, dy: 0, bad: Infinity };
			for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) { const c = cnt(dx, dy); if (c.so + c.po < best.bad) best = { dx, dy, bad: c.so + c.po }; }
			const nx = x1 - bx.x0, ny = y1 - bx.y0;
			const prof = (I: ImageData) => { const col = new Float64Array(nx), row = new Float64Array(ny);
				for (let y = bx.y0; y < y1; y++) for (let x = bx.x0; x < x1; x++) { const j = (y * W + x) * 4;
					const v = Math.max(Math.abs(I.data[j]! - N.data[j]!), Math.abs(I.data[j + 1]! - N.data[j + 1]!), Math.abs(I.data[j + 2]! - N.data[j + 2]!));
					col[x - bx.x0]! += v; row[y - bx.y0]! += v; } return { col, row }; };
			// Pane at i + d against sibling at i: a positive lag means the pane's ink lies right of (below) the sibling's.
			const xc = (a: Float64Array, b: Float64Array) => { let ma = 0, mb = 0; for (const v of a) ma += v; for (const v of b) mb += v; ma /= a.length; mb /= b.length;
				const c: number[] = []; for (let d = -6; d <= 6; d++) { let s = 0, n = 0; for (let i = 0; i < a.length; i++) { const q = i + d; if (q < 0 || q >= b.length) continue; s += (a[i]! - ma) * (b[q]! - mb); n++; } c.push(s / n); }
				let bi = 0; for (let i = 1; i < c.length; i++) if (c[i]! > c[bi]!) bi = i;
				const l = c[bi - 1], r = c[bi + 1]; const off = l !== undefined && r !== undefined && l - 2 * c[bi]! + r !== 0 ? (l - r) / (2 * (l - 2 * c[bi]! + r)) : 0;
				return { lag: bi - 6, sub: bi - 6 + off }; };
			const ps = prof(A), pp = prof(B);
			return { at0: cnt(0, 0), best, sub: { x: xc(ps.col, pp.col), y: xc(ps.row, pp.row) } };
		}, [sib, pane, none, bx] as const) as any;
		await page.evaluate(() => (window as any).zo.end());
		report.standInRegistration = { land, up: w.next.up, holdsRaster: w.next.holdsRaster, ...res, box: bx, edges };
		console.log("ZO-STANDIN-REG " + JSON.stringify(report.standInRegistration));
		expect(w.next.preview, "premise: the second run put a preview up").toBe(true);
		expect(w.next.up, "the sibling is up on the second run's first preview frame").toBe(true);
		expect(w.next.holdsRaster, "the sibling holds the stand-in's own canvases").toBe(true);
		expect(res.at0.both, "premise: ink inside the start view on both").toBeGreaterThan(1000);
		expect(Math.abs(res.sub.x.sub), "sub-pixel offset of the pane's ink against the sibling's, x, device px").toBeLessThan(1);
		expect(Math.abs(res.sub.y.sub), "sub-pixel offset of the pane's ink against the sibling's, y, device px").toBeLessThan(1);
	});
}, 600_000);

/**
 * A run that lands back at its start zoom (out, then in by the same travel): the raster still holds at the landing, so nothing lets
 * it go, and the landing schedules a scroll repaint, never the whole paint that calls landHeldRaster. The preview's end takes the
 * sibling down in the same call that shows the pane's canvases: down after the landing, and no landing frame shows neither.
 */
it(`held raster at dsf ${DSF}: a run that lands at its start zoom keeps the raster, and the preview's end takes the sibling down`, async () => {
	await withPage("same zoom", async page => {
		const at = await page.evaluate(() => (window as any).zo.state()) as any;
		await page.evaluate(() => (window as any).zo.begin());
		const w = await page.evaluate(([dy]) => (window as any).zo.wheel(2, dy, 40, 40), [STEP_PX] as const) as any;
		const w2 = await page.evaluate(([dy]) => (window as any).zo.wheel(2, dy, 40, 40), [-STEP_PX] as const) as any;
		const end = await page.evaluate(() => (window as any).zo.end()) as any;
		const after = await page.evaluate(() => (window as any).zo.state()) as any;
		report.sameZoom = { at, next: w.next, back: w2.next, lands: end.lands, final: end.final, after };
		console.log("ZO-SAMEZOOM " + JSON.stringify(report.sameZoom));
		expect(at.held, "premise: the extent raster is held at the start zoom").toBe(true);
		expect(w.next.up, "premise: the sibling is up on the first preview frame").toBe(true);
		expect(after.zoom, "premise: the run landed at its start zoom").toBe(at.zoom);
		expect(after.held, "premise: the raster still holds after the landing (no let-go)").toBe(true);
		const dark = (end.frames as Array<{ tag: string; inkShown: boolean }>).filter(f => !f.inkShown).map(f => f.tag);
		expect(dark, "landing frames with neither the sibling nor the pane's canvases shown").toEqual([]);
		expect(end.final.up, "the sibling is down after the landing").toBe(false);
		expect(end.final.paneShown, "the pane's committed canvas is shown after the landing").toBe(true);
	});
}, 600_000);

/**
 * A lasso drag's snapshot live: the layer and the raster hold the staying strokes and the store counts one more, so put-up's own
 * first write finds the raster no longer held and takes it down. Put-up must stop there: no empty element left in the host and the
 * pane's canvases not hidden into a record nothing holds.
 */
it(`held raster at dsf ${DSF}: with a drag snapshot live, a put-up whose first write takes the raster down leaves no element and the pane's ink shown`, async () => {
	await withPage("staying", async page => {
		const at = await page.evaluate(() => (window as any).zo.prep("staying")) as any;
		await page.evaluate(() => (window as any).zo.begin());
		const w = await page.evaluate(([dy]) => (window as any).zo.wheel(2, dy, 40, 40), [STEP_PX] as const) as any;
		const end = await page.evaluate(() => (window as any).zo.end()) as any;
		report.staying = { at, next: w.next, final: end.final };
		console.log("ZO-STAYING " + JSON.stringify(report.staying));
		expect(at.held, "premise: the raster holds the staying strokes").toBe(true);
		expect(w.next.preview, "premise: the preview is up").toBe(true);
		expect(end.final.paneShown, "after the landing the pane's committed canvas is shown").toBe(true);
		expect(end.final.inHost, "after the landing the held element is not in the host").toBe(false);
		expect(w.next.paneShown, "the pane's committed canvas stays shown on the first preview frame").toBe(true);
	});
}, 600_000);

/**
 * One attached group in the note: the committed layers and the raster hold the free strokes only, while the store counts the members
 * too. The raster must still go up on the first preview frame, show the free ink outside the start view and stay up to the landing.
 */
async function attachedRun(page: Page, erased: boolean, key: string) {
	const at = await page.evaluate(([e]) => (window as any).zo.attach(5, e), [erased] as const) as any;
	await page.evaluate(() => (window as any).zo.begin());
	const r = await wheelRun(page, 0);
	const end = await page.evaluate(() => (window as any).zo.end()) as any;
	const later = (end.frames as Array<{ up: boolean; preview: boolean }>).filter(s => s.preview);
	report[key] = { at: { members: at.members, free: at.free, store: at.store, held: at.held }, same: r.w.same, next: r.w.next, reallocs: r.w.reallocs, made: r.w.made,
		inkOutside: r.preview.outside, laterPreviewFrames: later.length, laterUp: later.filter(s => s.up).length };
	console.log("ZO-" + key + " " + JSON.stringify(report[key]));
	expect(at.members, "premise: the group's ids").toBe(erased ? 6 : 5);
	expect(at.free, "premise: the free list leaves the members out").toBe(at.store - 5);
	expect(at.held, "premise: the raster holds the free strokes at the start zoom").toBe(true);
	expect(r.w.next.preview, "premise: the first preview frame is painted").toBe(true);
	expect(r.w.same.compositeShown, "the pinch composite does not engage at the gesture's start under a held raster").toBe(false);
	expect(r.w.next.up, "the sibling is up on the first preview frame").toBe(true);
	expect(r.w.next.paneShown, "the pane's committed canvas is hidden on the same frame").toBe(false);
	expect(r.w.next.compositeShown, "the pinch composite does not show the ink twice under the sibling").toBe(false);
	expect(r.w.reallocs, "ink canvas reallocations during the gesture").toBe(0);
	expect(r.preview.outside, "ink pixels outside the start view on the first preview frame").toBeGreaterThan(0);
	expect(later.every(s => s.up), "the sibling stays up on every later preview frame").toBe(true);
}

it(`held raster at dsf ${DSF}: with one attached group, the first preview frame holds the raster up and shows free ink outside the start view`, async () => {
	await withPage("attached", page => attachedRun(page, false, "attached"));
}, 600_000);

it(`held raster at dsf ${DSF}: with one attached group that keeps an erased member's id, the first preview frame holds the raster up and shows free ink outside the start view`, async () => {
	await withPage("attached erased", page => attachedRun(page, true, "attachedErased"));
}, 600_000);

/** One attached group and a lasso drag's snapshot live: the raster holds the staying free strokes, so put-up's first write takes it down. */
it(`held raster at dsf ${DSF}: with one attached group and a drag snapshot live, a put-up whose first write takes the raster down leaves no element and the pane's ink shown`, async () => {
	await withPage("attached staying", async page => {
		await page.evaluate(() => (window as any).zo.attach(5));
		const at = await page.evaluate(() => (window as any).zo.prep("staying")) as any;
		await page.evaluate(() => (window as any).zo.begin());
		const w = await page.evaluate(([dy]) => (window as any).zo.wheel(2, dy, 40, 40), [STEP_PX] as const) as any;
		const end = await page.evaluate(() => (window as any).zo.end()) as any;
		report.attachedStaying = { at: at.held, next: w.next, final: end.final, putUps: w.putUpMs.length };
		console.log("ZO-ATTACHED-STAYING " + JSON.stringify(report.attachedStaying));
		expect(at.held, "premise: the raster holds the staying free strokes").toBe(true);
		expect(w.next.preview, "premise: the preview is up").toBe(true);
		expect(w.putUpMs.length, "premise: put-up ran").toBeGreaterThan(0);
		expect(end.final.paneShown, "after the landing the pane's committed canvas is shown").toBe(true);
		expect(end.final.inHost, "after the landing the held element is not in the host").toBe(false);
		expect(w.next.paneShown, "the pane's committed canvas stays shown on the first preview frame").toBe(true);
		expect(w.next.up, "the sibling is not up on the first preview frame").toBe(false);
	});
}, 600_000);

/**
 * The first preview frame with the ink layer's offset off zero and the pan unchanged: the held inner box's translate must be the
 * layer's own numbers plus the band term on that frame, by the numbers.
 */
it(`held raster at dsf ${DSF}: on the first preview frame with a nonzero ink offset the held element takes the ink layer's own translate`, async () => {
	await withPage("offset", async page => {
		await page.evaluate(() => (window as any).zo.prep("offset"));
		await page.evaluate(() => (window as any).zo.begin());
		const w = await page.evaluate(([dy]) => (window as any).zo.wheel(2, dy, 40, 40), [STEP_PX] as const) as any;
		await page.evaluate(() => (window as any).zo.end());
		const n = w.next.nums;
		report.offset = { next: w.next };
		console.log("ZO-OFFSET " + JSON.stringify(n));
		expect(w.next.up, "premise: the sibling is up on the first preview frame").toBe(true);
		expect(n, "premise: the frame's numbers were read").not.toBe(null);
		expect(Math.abs(n.layer.x), "premise: the ink layer's translate is off zero").toBeGreaterThan(1);
		const want = { x: n.band.x - n.scroll.x + n.layer.x, y: n.band.y - n.scroll.y + n.layer.y };
		// The browser reads a written transform back at 6 significant digits (-189.5297 written reads -189.53), so 1e-3 CSS px.
		expect({ dx: Math.abs(n.inner.x - want.x) < 1e-3, dy: Math.abs(n.inner.y - want.y) < 1e-3 }, `held inner translate ${JSON.stringify(n.inner)} against the layer's numbers plus the band term ${JSON.stringify(want)}, within 1e-3 CSS px for the browser's 6-significant-digit transform read-back`)
			.toEqual({ dx: true, dy: true });
	});
}, 600_000);

/**
 * Attached ink in its stacking place under a held raster. At rest the pane stacks free highlight, attached highlight, free pen,
 * attached pen: a highlight never dims a pen line. The held element sits right after the scroller and holds the free highlight and
 * free pen canvases, while the attached canvases stay in the pane under it, CSS-scaled with the pane at one camera. Two reads:
 * where free highlight crosses attached pen, whether the wash lands over the pen for the gesture; and whether attached ink outside
 * the start view shows on the preview frame at all, as free ink does.
 *
 * Both run on their own page script: the entry above plus the helpers below in the same bundle, so they read the same overlay.
 * Canvases are hidden for a read by an attribute under an !important rule, so no style write inside a preview frame can show them.
 * Bounds here are set before any run; the first run's numbers are reported and confirm or move them.
 */
const ATTACHED_ENTRY = `
import { wheelRatio } from "../../src/inline/WheelZoom";
import { computeBBox } from "../../src/ink/Stroke";
const zaMarked = new Set<HTMLCanvasElement>();
/**
 * The canvases a read hides: attached pen, attached highlight, both, the free highlight or free pen (the held one while the raster is up), or one
 * group's ("g:" and its id). Attached ink is the layer's canvases and the tiles a hold put up beside the raster, wherever it shows;
 * "tiles" is the tiles alone, "attCanvases" the layer's canvases alone.
 */
function zaCanvases(name: string): HTMLCanvasElement[] {
	const o = ov(), a = o.attachedLayer, h = o.heldRaster;
	const pen = (h?.penTiles ?? []).map((t: any) => t.c), hl = (h?.hlTiles ?? []).map((t: any) => t.c);
	const list = name === "attPen" ? [a?.pen, ...pen] : name === "attHl" ? [a?.hl, ...hl] : name === "att" ? [a?.pen, a?.hl, ...pen, ...hl]
		: name === "tiles" ? [...pen, ...hl] : name === "attCanvases" ? [a?.pen, a?.hl]
		: name === "freeHl" ? [h ? h.src.hl : o.highlightCanvas]
		: name === "freePen" ? [h ? h.src.pen : o.committedCanvas]
		: name.startsWith("g:") ? [...(h?.penTiles ?? []), ...(h?.hlTiles ?? [])].filter((t: any) => t.id === name.slice(2)).map((t: any) => t.c) : [];
	return list.filter(Boolean);
}
function zaBox(s: any) { const b = s.bbox; return { x0: b.x, y0: b.y, x1: b.x + b.width, y1: b.y + b.height }; }
/** The start view in world units, grown by pad on every side. */
function zaView(pad = 0) { const o = ov(), c = o.lastPaintCam; return { x0: c.x - pad, y0: c.y - pad, x1: c.x + o.cssWidth / c.zoom + pad, y1: c.y + o.cssHeight / c.zoom + pad }; }
const zaMeets = (a: any, b: any) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
const zaInside = (a: any, b: any) => a.x0 >= b.x0 && a.x1 <= b.x1 && a.y0 >= b.y0 && a.y1 <= b.y1;
(window as any).za = {
	/**
	 * Pen strokes wholly inside the start view whose box meets a highlighter stroke's box there, up to n; only lines at least 2.5
	 * world units wide, so a line keeps a core past its antialiasing at the preview's scale.
	 */
	crossing(n: number) {
		const v = zaView(), src = inlineInk.strokes(PATH).filter((s: any) => zaInside(zaBox(s), v));
		const hl = src.filter((s: any) => s.tool === "highlighter");
		return src.filter((s: any) => s.tool !== "highlighter" && s.width >= 2.5 && hl.some((h: any) => zaMeets(zaBox(s), zaBox(h)))).slice(0, n).map((s: any) => s.id);
	},
	/** As crossing(), the other way about: highlighter strokes wholly inside the start view whose box meets such a pen line's box there, up to n. */
	hlCrossing(n: number) {
		const v = zaView(), src = inlineInk.strokes(PATH).filter((s: any) => zaInside(zaBox(s), v));
		const pen = src.filter((s: any) => s.tool !== "highlighter" && s.width >= 2.5);
		return src.filter((s: any) => s.tool === "highlighter" && pen.some((p: any) => zaMeets(zaBox(s), zaBox(p)))).slice(0, n).map((s: any) => s.id);
	},
	/**
	 * Strokes clear of the start view by 8 world units and wholly inside the first preview frame's view, which a wheel run of px
	 * grows by 1 / wheelRatio(px) about its anchor (fx, fy CSS px into the scroller), taking four fifths of the growth for margin;
	 * up to n, the least past the start view's edge first. With runs, the view after that many such runs about the same anchor.
	 */
	outside(n: number, px: number, fx: number, fy: number, runs = 1) {
		const o = ov(), v = zaView(), c = o.lastPaintCam, sc = o.view.scrollDOM.getBoundingClientRect(), cr = o.committedCanvas.getBoundingClientRect();
		const ax = c.x + (sc.left + fx - cr.left) / c.zoom, ay = c.y + (sc.top + fy - cr.top) / c.zoom, g = 1 + 0.8 * (1 / wheelRatio(px) ** runs - 1);
		const grown = { x0: ax + (v.x0 - ax) * g, y0: ay + (v.y0 - ay) * g, x1: ax + (v.x1 - ax) * g, y1: ay + (v.y1 - ay) * g };
		const clear = zaView(8), past = (b: any) => Math.max(b.x1 - v.x1, b.y1 - v.y1);
		return inlineInk.strokes(PATH).filter((s: any) => { const b = zaBox(s); return !zaMeets(b, clear) && zaInside(b, grown); })
			.sort((a: any, b: any) => past(zaBox(a)) - past(zaBox(b))).slice(0, n).map((s: any) => s.id);
	},
	/**
	 * Highlighter strokes wholly inside the start view less a margin of 8 world units, up to n: an attached wash the first preview
	 * frame shows whole.
	 */
	hlInside(n: number) {
		const v = zaView(-8);
		return inlineInk.strokes(PATH).filter((s: any) => s.tool === "highlighter" && zaInside(zaBox(s), v)).slice(0, n).map((s: any) => s.id);
	},
	/**
	 * A free black pen stroke 6.6 world units wide across a blue one 20 wide (its core past two px of edge stays about 11 device px
	 * wide on the preview frame), both inside the start view about its centre, each committed
	 * as a pen-up commits it (the store, the damage, a partial repaint); then the blue one attached by the lasso's Attach step
	 * (attachAt, its reference point read in a measure as attachSelected reads it). The note's text has no paragraph under the ink
	 * (its lines are empty), so the paragraph pick before that step is not taken. Mouse strokes keep their width whole.
	 */
	async penCrossAdd() {
		const o = ov(), v = zaView(), cx = (v.x0 + v.x1) / 2, cy = (v.y0 + v.y1) / 2;
		const line = (id: string, color: string, w: number, x0: number, y0: number, x1: number, y1: number) => {
			const points = Array.from({ length: 25 }, (_, i) => ({ x: x0 + ((x1 - x0) * i) / 24, y: y0 + ((y1 - y0) * i) / 24, pressure: 0.5, t: i * 8 }));
			return { id, tool: "pen", color, width: w, points, bbox: computeBBox(points, w * 2), createdAt: Date.now(), device: "mouse" };
		};
		const blue = line("za-pen-blue", "#2f6fdf", 20, cx - 90, cy, cx + 90, cy), black = line("za-pen-black", "#000000", 6.6, cx, cy - 90, cx, cy + 90);
		for (const s of [blue, black]) { inlineInk.commit(PATH, s as any); o.damage.addRect(s.bbox); o.scheduleRepaint("partial"); await settle(4); }
		const target = { kind: "paragraph", from: 0, to: 0, text: "words that are not in this note", before: "", after: "" };
		const ref = await new Promise<any>(r => o.view.requestMeasure({ read: () => o.followRefAt(target.from), write: r }));
		if (ref) o.attachAt(PATH, "za-group", [blue.id], target, ref);
		o.dropExtentBuild(); o.extentRaster = null; o.dropStandIn();
		o.scheduleRepaint("za-attach");
		await settle(8);
		await (window as any).panBake.awaitSharp();
		const att = inlineInk.attachments(PATH);
		return { ref: !!ref, ids: [blue.id], records: att.length, attached: att.some((a: any) => a.strokeIds?.includes(blue.id)), members: o.lineAnchors.follow.memberMap.size,
			free: o.freeStrokes(PATH).length, store: inlineInk.strokes(PATH).length, held: heldNow(o), box: { blue: zaBox(blue), black: zaBox(black) } };
	},
	/** Two highlighter strokes wholly inside the start view whose boxes overlap most, in store order; none when no two overlap. */
	hlPairInside() {
		const v = zaView(), src = inlineInk.strokes(PATH), hl = src.filter((s: any) => s.tool === "highlighter" && zaInside(zaBox(s), v));
		const area = (a: any, b: any) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
		let best: string[] = [], most = 0;
		for (let i = 0; i < hl.length; i++) for (let j = i + 1; j < hl.length; j++) {
			const v = area(zaBox(hl[i]), zaBox(hl[j]));
			if (v > most) { most = v; best = [hl[i].id, hl[j].id]; }
		}
		return best;
	},
	/**
	 * Of attachMany's groups ("za-group-" and the index of its stroke in ids), those whose member's box does not meet the view now
	 * grown by 8 world units, and how many of them have a whole sprite at the layer's last paint zoom.
	 */
	/** The start view now, world units, and the camera zoom. */
	view() { return { ...zaView(), zoom: ov().lastPaintCam.zoom }; },
	beyond(ids: string[]) {
		const o = ov(), v = zaView(8), byId = new Map(inlineInk.strokes(PATH).map((s: any) => [s.id, s]));
		const groups = ids.map((id, i) => ({ id, g: "za-group-" + i })).filter(x => byId.has(x.id) && !zaMeets(zaBox(byId.get(x.id)), v)).map(x => x.g);
		return { groups, ready: groups.filter(g => (window as any).za.spriteReady(g)).length };
	},
	/** One attached group of the named strokes, read as a reopen reads it, as zo.attach builds its group. */
	async attach(ids: string[]) { return (window as any).za.attachMany([ids]); },
	/** One attached group per list, "za-group-" and its index for id, read as a reopen reads them. */
	async attachMany(lists: string[][]) {
		const o = ov(), src = inlineInk.strokes(PATH), sig = o.lineAnchors.sig;
		const recs = lists.map((ids, i) => {
			const members = src.filter((s: any) => ids.includes(s.id)), m0 = members[0] as any;
			return { v: 1, id: lists.length === 1 ? "za-group" : "za-group-" + i, strokeIds: members.map((s: any) => s.id), target: { kind: "paragraph", from: 0, to: 0, text: "words that are not in this note", before: "", after: "" },
				ref: { x: m0.bbox.x, y: m0.bbox.y }, layout: { width: sig.width, font: sig.fontPx }, probe: { id: m0.id, x: m0.points[0].x, y: m0.points[0].y } };
		});
		(inlineInk as any).setAttachments(PATH, recs, false);
		o.dropExtentBuild(); o.extentRaster = null; o.dropStandIn();
		o.scheduleRepaint("za-attach");
		await settle(8);
		await (window as any).panBake.awaitSharp();
		return { members: o.lineAnchors.follow.memberMap.size, free: o.freeStrokes(PATH).length, store: src.length, held: heldNow(o) };
	},
	/** Mean of the largest channel difference between PNG a and b over mask m's pixels; -1 for no pixel or a size mismatch. */
	async delta(a: string, b: string, m: string) {
		const read = async (s: string) => { const bm = await createImageBitmap(await (await fetch("data:image/png;base64," + s)).blob());
			const c = new OffscreenCanvas(bm.width, bm.height), x = c.getContext("2d")!; x.drawImage(bm, 0, 0); return x.getImageData(0, 0, bm.width, bm.height); };
		const A = await read(a), B = await read(b), M = Z.masks.get(m);
		if (!M || M.W !== A.width || M.H !== A.height) return -1;
		let sum = 0, n = 0;
		for (let i = 0; i < M.m.length; i++) {
			if (!M.m[i]) continue;
			const j = i * 4;
			sum += Math.max(Math.abs(A.data[j]! - B.data[j]!), Math.abs(A.data[j + 1]! - B.data[j + 1]!), Math.abs(A.data[j + 2]! - B.data[j + 2]!));
			n++;
		}
		return n > 0 ? sum / n : -1;
	},
	/** Hides the named canvases, and shows the reveal ones over any style the hold wrote, for one read. */
	hide(names: string[], reveal: string[] = []) {
		let s = document.getElementById("za-hide");
		if (!s) { s = document.head.appendChild(document.createElement("style")); s.id = "za-hide"; }
		s.textContent = "[data-za-hide] { visibility: hidden !important; } [data-za-show] { visibility: visible !important; }";
		for (const n of names) for (const c of zaCanvases(n)) { c.setAttribute("data-za-hide", ""); zaMarked.add(c); }
		for (const n of reveal) for (const c of zaCanvases(n)) { c.setAttribute("data-za-show", ""); zaMarked.add(c); }
	},
	show() { for (const c of zaMarked) { c.removeAttribute("data-za-hide"); c.removeAttribute("data-za-show"); } zaMarked.clear(); },
	/**
	 * The held pen tiles against the attached pen canvas the layer painted, at the layer's device px: each tile's pixels beside the
	 * canvas's own at (x, y), where heldTiles says paint() copied it. Inked tile pixels, and of all tile pixels those that differ.
	 */
	tileMatch() {
		const a = ov().attachedLayer, h = ov().heldRaster, pen = a?.pen as HTMLCanvasElement | undefined;
		if (!h || !pen) return null;
		const P = pen.getContext("2d")!.getImageData(0, 0, pen.width, pen.height).data;
		let ink = 0, changed = 0, outside = 0;
		for (const t of h.penTiles ?? []) {
			const c = t.c as HTMLCanvasElement, T = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
			for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
				const i = (y * c.width + x) * 4, px = t.x + x, py = t.y + y;
				if (T[i + 3]! > 0) ink++;
				if (px < 0 || py < 0 || px >= pen.width || py >= pen.height) { if (T[i + 3]! > 0) outside++; continue; }
				const j = (py * pen.width + px) * 4;
				if (T[i] !== P[j] || T[i + 1] !== P[j + 1] || T[i + 2] !== P[j + 2] || T[i + 3] !== P[j + 3]) changed++;
			}
		}
		return { tiles: (h.penTiles ?? []).length, ink, changed, outside };
	},
	/**
	 * The held pen tiles' CSS place against the attached pen canvas: each tile's client rect beside the canvas's own, offset by the
	 * tile's (x, y) and scaled by the canvas rect's width over its width. The worst edge apart, in device px; tileMatch cannot see it.
	 */
	tileRect() {
		const a = ov().attachedLayer, h = ov().heldRaster, pen = a?.pen as HTMLCanvasElement | undefined;
		if (!h || !pen) return null;
		const A = pen.getBoundingClientRect(), s = A.width / pen.width, dpr = window.devicePixelRatio;
		let worst = 0;
		for (const t of h.penTiles ?? []) {
			const c = t.c as HTMLCanvasElement, r = c.getBoundingClientRect();
			const l = A.left + t.x * s, tp = A.top + t.y * s;
			for (const e of [r.left - l, r.top - tp, r.right - (l + c.width * s), r.bottom - (tp + c.height * s)]) worst = Math.max(worst, Math.abs(e) * dpr);
		}
		return { tiles: (h.penTiles ?? []).length, worst, s, sy: A.height / pen.height, dpr };
	},
	/** Pen strokes at least 2.5 world units wide wholly inside the start view less 8 world units, up to n: lines with a core. */
	penInside(n: number) {
		const v = zaView(-8);
		return inlineInk.strokes(PATH).filter((s: any) => s.tool === "pen" && s.width >= 2.5 && zaInside(zaBox(s), v)).slice(0, n).map((s: any) => s.id);
	},
	heldHl() { const h = ov().heldRaster; return !!h && !!h.src.hl; },
	/** What the hold put up of the attached layer: tile counts, the wrapper, and how many canvases it hid. */
	heldTiles() { const h = ov().heldRaster; return h ? { pen: (h.penTiles ?? []).length, hl: (h.hlTiles ?? []).length, wrap: !!h.hlWrap, hidden: h.hidden.length } : null; },
	/** Whether the named group has a whole sprite at the layer's last paint zoom, every tile drawn: one a hold may put up. */
	spriteReady(id: string) { const o = ov(), sp = o.attachedLayer?.sprites?.get(id); return !!sp && !sp.byPath && sp.pending === 0 && sp.zoom === o.lastPaintCam?.zoom; },
	/** Mask a and mask b into keep; the count, -1 when the masks differ in size. */
	and(a: string, b: string, keep: string) {
		const A = Z.masks.get(a), B = Z.masks.get(b);
		if (!A || !B || A.W !== B.W || A.H !== B.H) return -1;
		const m = new Uint8Array(A.W * A.H);
		let n = 0;
		for (let i = 0; i < m.length; i++) if (A.m[i] && B.m[i]) { m[i] = 1; n++; }
		Z.masks.set(keep, { m, W: A.W, H: A.H });
		return n;
	},
	/**
	 * Mask a less its edge, depth px deep (a pixel stays when its four neighbours are set too, depth times over), into keep: a pen
	 * line's core, past its antialiasing.
	 */
	core(a: string, keep: string, depth = 1) {
		const A = Z.masks.get(a);
		if (!A) return -1;
		const W = A.W, H = A.H;
		let src = A.m, m = new Uint8Array(W * H), n = 0;
		for (let k = 0; k < depth; k++) {
			m = new Uint8Array(W * H); n = 0;
			for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { const i = y * W + x;
				if (src[i] && src[i - 1] && src[i + 1] && src[i - W] && src[i + W]) { m[i] = 1; n++; } }
			src = m;
		}
		Z.masks.set(keep, { m, W, H });
		return n;
	},
};`;
// Crossing pixels a read needs before its share means anything, at rest and on the preview frame (about 0.83 of the area at
// the run's 0.913 scale). Set before any run.
const CROSS_MIN = 40;
// The share of crossing pixels the free highlight changes may rise this much over at rest: at rest only pen cores the erode
// left a part-covered pixel in; with the wash over the pen, nearly all of them.
const CROSS_SHARE_SLACK = 0.1;
// The attached wash's mean change on the first preview frame may differ from at rest by this share: the preview's resampling of a
// flat core. Shown twice it rises by about 0.65 (1 - 0.65 squared against 0.35), without its alpha by about 1.9. Set before any run.
const WASH_SLACK = 0.15;

describe(`attached ink in its stacking place under a held raster at dsf ${DSF}`, () => {
	let attachedScript: string;
	beforeAll(async () => {
		const b = await build({
			stdin: { contents: ENTRY + "\n" + ATTACHED_ENTRY, resolveDir: fileURLToPath(new URL("./", import.meta.url)), sourcefile: "zoomOutHeldRasterAttachedEntry.ts", loader: "ts" },
			bundle: true, write: false, format: "iife", platform: "browser",
			alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
		});
		attachedScript = b.outputFiles![0]!.text;
	}, 180_000);

	/** withPage on this describe's script. */
	async function withAttachedPage(name: string, body: (page: Page) => Promise<void>): Promise<void> {
		const context = await browser.newContext({ viewport: null, hasTouch: true });
		const page = await context.newPage();
		const errors: string[] = [];
		page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
		try {
			await page.setContent(`<!doctype html><body class="theme-dark" style="margin:0; --font-text-size:19px; --background-modifier-border:#777777"></body>`);
			await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
			await page.addStyleTag({ content: MINIMAL_CSS });
			await page.addScriptTag({ content: attachedScript });
			const want = (JSON.parse(INK) as { strokes: unknown[] }).strokes.length;
			const mounted = await page.evaluate(([z, s, id, w, h, n]) => (window as any).panBake.mount(z, s, id, w, h, n), [ZOOM, INK, PAGE_ID, PANE.w, PANE.h, want] as const) as any;
			expect(mounted.strokes, "premise: every stroke loaded").toBe(want);
			expect(mounted.dpr, "premise: the device ratio is the flag's").toBeCloseTo(DSF, 2);
			expect(mounted.zoomCommitted, "premise: the start zoom committed").toBe(true);
			await page.evaluate(() => (window as any).panBake.awaitSharp());
			await body(page);
			expect(errors, `${name}: page errors`).toEqual([]);
		} finally { await context.close(); }
	}

	/** A pane screenshot with the named canvases hidden and the `reveal` ones shown, PNG base64. */
	async function shot(page: Page, hide: string[], reveal: string[] = []): Promise<string> {
		const r = await page.evaluate(() => (window as any).zo.rects()) as { pane: { x: number; y: number; w: number; h: number } };
		await page.evaluate(([n, s]) => (window as any).za.hide(n, s), [hide, reveal] as const);
		const s = (await page.screenshot({ clip: { x: r.pane.x, y: r.pane.y, width: r.pane.w, height: r.pane.h } })).toString("base64");
		await page.evaluate(() => (window as any).za.show());
		return s;
	}
	const diff = (page: Page, a: string, b: string, excl: unknown, keep: string) =>
		page.evaluate(([a, b, e, k]) => (window as any).zo.diff(a, b, e, k), [a, b, excl, keep] as const) as Promise<{ all: number; outside: number }>;

	/**
	 * Crossing pixels: the core of where attached pen shows (all shown against attached pen hidden), inside where the free wash
	 * shows with attached pen hidden. Of those, the share the free highlight changes (all shown against free highlight hidden):
	 * near none with the pen over the wash, near all with the wash over the pen.
	 */
	async function crossing(page: Page, tag: string) {
		const all = await shot(page, []), noPen = await shot(page, ["attPen"]), neither = await shot(page, ["attPen", "freeHl"]), noHl = await shot(page, ["freeHl"]);
		const pen = await diff(page, all, noPen, null, tag + "P"), wash = await diff(page, noPen, neither, null, tag + "W"), hl = await diff(page, all, noHl, null, tag + "D");
		const counts = await page.evaluate(([t]) => { const f = (window as any).za;
			return { core: f.core(t + "P", t + "C"), x: f.and(t + "C", t + "W", t + "X"), y: f.and(t + "X", t + "D", t + "Y") }; }, [tag] as const) as { core: number; x: number; y: number };
		return { pen: pen.all, wash: wash.all, hl: hl.all, ...counts, share: counts.x > 0 ? counts.y / counts.x : Number.NaN };
	}

	it(`where free highlight crosses attached pen, the first preview frame keeps the pen over the wash as at rest`, async () => {
		await withAttachedPage("crossing", async page => {
			const ids = await page.evaluate(() => (window as any).za.crossing(8)) as string[];
			expect(ids.length, "premise: pen strokes in the start view whose boxes meet free highlighter ink").toBeGreaterThan(0);
			const at = await page.evaluate(([i]) => (window as any).za.attach(i), [ids] as const) as any;
			const rest = await crossing(page, "ra");
			await page.evaluate(() => (window as any).zo.begin());
			const w = await page.evaluate(([dy]) => (window as any).zo.wheel(2, dy, 40, 40), [STEP_PX] as const) as any;
			const heldHl = await page.evaluate(() => (window as any).za.heldHl()) as boolean;
			const mid = await crossing(page, "ma");
			const end = await page.evaluate(() => (window as any).zo.end()) as any;
			report.attachedCrossing = { ids, at, rest, mid, next: w.next, heldHl, final: end.final };
			console.log("ZO-ATTACHED-CROSSING " + JSON.stringify(report.attachedCrossing));
			expect(at.members, "premise: the group's ids").toBe(ids.length);
			expect(at.held, "premise: the raster holds the free strokes at the start zoom").toBe(true);
			expect(w.next.up, "premise: the sibling is up on the first preview frame").toBe(true);
			expect(heldHl, "premise: the held raster holds a highlighter canvas").toBe(true);
			expect(rest.x, "premise: crossing pixels at rest").toBeGreaterThanOrEqual(CROSS_MIN);
			expect(mid.x, "premise: crossing pixels on the first preview frame").toBeGreaterThanOrEqual(CROSS_MIN);
			expect(mid.share, `share of crossing pixels the free highlight changes on the first preview frame (${mid.y} of ${mid.x}) against at rest (${rest.y} of ${rest.x}); over it, the wash paints over attached pen for the gesture and pops back under it at the landing`)
				.toBeLessThanOrEqual(rest.share + CROSS_SHARE_SLACK);
		});
	}, 600_000);

	/**
	 * As crossing(), with free pen in place of free highlight, and the crossing found in either order: the core of where attached pen
	 * paints with free pen hidden, inside where free pen paints with attached pen hidden. Of those, the share hiding free pen changes:
	 * near none with attached pen on top, near all with free pen on top. The core is the line less two px at its edge: on the preview
	 * frame the pen's edge alpha spreads over about 1.5 px, and free pen shows through it in the first px in from the edge.
	 */
	async function penCrossing(page: Page, tag: string) {
		const all = await shot(page, []), noAtt = await shot(page, ["attPen"]), neither = await shot(page, ["attPen", "freePen"]), noFree = await shot(page, ["freePen"]);
		const pen = await diff(page, noFree, neither, null, tag + "P"), free = await diff(page, noAtt, neither, null, tag + "W"), d = await diff(page, all, noFree, null, tag + "D");
		const counts = await page.evaluate(([t]) => { const f = (window as any).za;
			return { core: f.core(t + "P", t + "C", 2), x: f.and(t + "C", t + "W", t + "X"), y: f.and(t + "X", t + "D", t + "Y") }; }, [tag] as const) as { core: number; x: number; y: number };
		return { pen: pen.all, free: free.all, d: d.all, ...counts, share: counts.x > 0 ? counts.y / counts.x : Number.NaN };
	}

	it(`where free pen crosses attached pen, the first preview frame keeps attached pen on top as at rest`, async () => {
		await withAttachedPage("pen crossing", async page => {
			// The fixture's start view has no wide pen crossed by free pen of another colour: the cell draws its own two.
			const at = await page.evaluate(() => (window as any).za.penCrossAdd()) as any;
			const ids = at.ids as string[];
			const rest = await penCrossing(page, "rp");
			expect(at.attached, "premise: the blue stroke is in an attached group").toBe(true);
			expect(rest.x, "premise: crossing pixels at rest").toBeGreaterThanOrEqual(CROSS_MIN);
			await page.evaluate(() => (window as any).zo.begin());
			const w = await page.evaluate(([dy]) => (window as any).zo.wheel(2, dy, 40, 40), [STEP_PX] as const) as any;
			const tiles = await page.evaluate(() => (window as any).za.heldTiles());
			const mid = await penCrossing(page, "mp");
			const end = await page.evaluate(() => (window as any).zo.end()) as any;
			report.attachedPenCrossing = { ids, at, rest, mid, tiles, next: w.next, final: end.final };
			console.log("ZO-ATTACHED-PEN-CROSSING " + JSON.stringify(report.attachedPenCrossing));
			expect(at.members, "premise: the group's ids").toBe(ids.length);
			expect(at.held, "premise: the raster holds the free strokes at the start zoom").toBe(true);
			expect(w.next.up, "premise: the sibling is up on the first preview frame").toBe(true);
			expect(mid.x, "premise: crossing pixels on the first preview frame").toBeGreaterThanOrEqual(CROSS_MIN);
			expect(mid.share, `share of crossing pixels free pen changes on the first preview frame (${mid.y} of ${mid.x}) against at rest (${rest.y} of ${rest.x}); over it, free pen paints over attached pen for the gesture`)
				.toBeLessThanOrEqual(rest.share + CROSS_SHARE_SLACK);
		});
	}, 600_000);

	/**
	 * As crossing(), with the roles the other way about: the core of where free pen paints with attached highlight hidden, inside where
	 * the attached wash shows with free pen hidden. Of those, the share the attached highlight changes: near none with free pen over the
	 * wash, near all with the wash over the pen. Two px of edge off the core, as penCrossing() takes, for the preview's resampling.
	 */
	async function washCrossing(page: Page, tag: string) {
		const all = await shot(page, []), noPen = await shot(page, ["freePen"]), neither = await shot(page, ["freePen", "attHl"]), noHl = await shot(page, ["attHl"]);
		const pen = await diff(page, noHl, neither, null, tag + "P"), wash = await diff(page, noPen, neither, null, tag + "W"), hl = await diff(page, all, noHl, null, tag + "D");
		const counts = await page.evaluate(([t]) => { const f = (window as any).za;
			return { core: f.core(t + "P", t + "C", 2), x: f.and(t + "C", t + "W", t + "X"), y: f.and(t + "X", t + "D", t + "Y") }; }, [tag] as const) as { core: number; x: number; y: number };
		return { pen: pen.all, wash: wash.all, hl: hl.all, ...counts, share: counts.x > 0 ? counts.y / counts.x : Number.NaN };
	}

	it(`where free pen crosses attached highlight, the first preview frame keeps the pen over the wash as at rest`, async () => {
		await withAttachedPage("wash crossing", async page => {
			const ids = await page.evaluate(() => (window as any).za.hlCrossing(8)) as string[];
			expect(ids.length, "premise: highlighter strokes in the start view whose boxes meet free pen ink").toBeGreaterThan(0);
			const at = await page.evaluate(([i]) => (window as any).za.attach(i), [ids] as const) as any;
			const rest = await washCrossing(page, "rw");
			await page.evaluate(() => (window as any).zo.begin());
			const w = await page.evaluate(([dy]) => (window as any).zo.wheel(2, dy, 40, 40), [STEP_PX] as const) as any;
			const tiles = await page.evaluate(() => (window as any).za.heldTiles()) as any;
			const mid = await washCrossing(page, "mw");
			const end = await page.evaluate(() => (window as any).zo.end()) as any;
			report.attachedWashCrossing = { ids, at, rest, mid, tiles, next: w.next, final: end.final };
			console.log("ZO-ATTACHED-WASH-CROSSING " + JSON.stringify(report.attachedWashCrossing));
			expect(at.members, "premise: the group's ids").toBe(ids.length);
			expect(at.held, "premise: the raster holds the free strokes at the start zoom").toBe(true);
			expect(w.next.up, "premise: the sibling is up on the first preview frame").toBe(true);
			expect(tiles?.wrap, "premise: the hold put up the group's highlight tiles in their wrapper").toBe(true);
			expect(rest.x, "premise: crossing pixels at rest").toBeGreaterThanOrEqual(CROSS_MIN);
			expect(mid.x, "premise: crossing pixels on the first preview frame").toBeGreaterThanOrEqual(CROSS_MIN);
			expect(mid.share, `share of crossing pixels the attached highlight changes on the first preview frame (${mid.y} of ${mid.x}) against at rest (${rest.y} of ${rest.x}); over it, the wash paints over free pen for the gesture and pops back under it at the landing`)
				.toBeLessThanOrEqual(rest.share + CROSS_SHARE_SLACK);
		});
	}, 600_000);

	it(`attached ink outside the start view shows on the first preview frame, as free ink does`, async () => {
		await withAttachedPage("outside", async page => {
			const ids = await page.evaluate(([px]) => (window as any).za.outside(5, px, 40, 40), [2 * STEP_PX] as const) as string[];
			expect(ids.length, "premise: strokes outside the start view and inside the first preview frame's view").toBeGreaterThan(0);
			const at = await page.evaluate(([i]) => (window as any).za.attach(i), [ids] as const) as any;
			const rest = await diff(page, await shot(page, []), await shot(page, ["att"]), null, "rb");
			await page.evaluate(() => (window as any).zo.begin());
			const w = await page.evaluate(([dy]) => (window as any).zo.wheel(2, dy, 40, 40), [STEP_PX] as const) as any;
			const r = await page.evaluate(() => (window as any).zo.rects()) as { pane: any; start: any };
			const k = DSF, s = r.start, p = r.pane;
			// The start view's box in clip device px, grown by 2 px for the edge's antialiasing, as readFrame takes it.
			const excl = { x0: Math.floor((s.x - p.x) * k) - 2, y0: Math.floor((s.y - p.y) * k) - 2, x1: Math.ceil((s.x + s.w - p.x) * k) + 2, y1: Math.ceil((s.y + s.h - p.y) * k) + 2 };
			const mid = await diff(page, await shot(page, []), await shot(page, ["att"]), excl, "mb");
			const end = await page.evaluate(() => (window as any).zo.end()) as any;
			const landed = await diff(page, await shot(page, []), await shot(page, ["att"]), null, "lb");
			report.attachedOutside = { ids, at, rest, mid, landed, next: w.next, final: end.final };
			console.log("ZO-ATTACHED-OUTSIDE " + JSON.stringify(report.attachedOutside));
			expect(at.members, "premise: the group's ids").toBe(ids.length);
			expect(at.held, "premise: the raster holds the free strokes at the start zoom").toBe(true);
			expect(rest.all, "premise: the group shows nothing in the start view at rest").toBe(0);
			expect(w.next.up, "premise: the sibling is up on the first preview frame").toBe(true);
			expect(landed.all, "premise: the landed view shows the group").toBeGreaterThan(0);
			expect(mid.outside, "attached ink pixels outside the start view on the first preview frame; none means the attached layer is not in the hold and the group pops in at the landing")
				.toBeGreaterThan(0);
		});
	}, 600_000);

	/**
	 * A quick run after a stand-in landing: the raster for the landed zoom builds once the first run lands, with the camera a few
	 * millionths of a world unit off where the attached layer last painted for some frames. Groups the landed view does not show get
	 * their sprites only in that build (buildIn), so the next run's hold can put them up. Each candidate stroke is its own group.
	 */
	// Every stroke the view four runs grow shows past the start view: the landing grows the view by about three runs' factor.
	it(`attached ink outside the view shows on the first preview frame of a run after a stand-in landing, as free ink does`, async () => {
		await withAttachedPage("outside after landing", async page => {
			const v0 = await page.evaluate(() => (window as any).za.view());
			const ids = await page.evaluate(([px]) => (window as any).za.outside(10_000, px, 40, 40, 4), [2 * STEP_PX] as const) as string[];
			expect(ids.length, "premise: strokes outside the start view and inside the view four runs grow").toBeGreaterThan(0);
			const at = await page.evaluate(([i]) => (window as any).za.attachMany(i.map(id => [id])), [ids] as const) as any;
			const land = await standInStart(page);
			const settled = await page.evaluate(() => (window as any).zo.end()) as any;
			const st = await page.evaluate(() => (window as any).zo.state()) as any;
			const far = await page.evaluate(([i]) => (window as any).za.beyond(i), [ids] as const) as { groups: string[]; ready: number };
			const v1 = await page.evaluate(() => (window as any).za.view());
			await page.evaluate(() => (window as any).zo.begin());
			const w = await page.evaluate(([dy]) => (window as any).zo.wheel(2, dy, 40, 40), [STEP_PX] as const) as any;
			const tiles = await page.evaluate(() => (window as any).za.heldTiles());
			const r = await page.evaluate(() => (window as any).zo.rects()) as { pane: any; start: any };
			const k = DSF, sv = r.start, p = r.pane;
			const excl = { x0: Math.floor((sv.x - p.x) * k) - 2, y0: Math.floor((sv.y - p.y) * k) - 2, x1: Math.ceil((sv.x + sv.w - p.x) * k) + 2, y1: Math.ceil((sv.y + sv.h - p.y) * k) + 2 };
			const mid = await diff(page, await shot(page, []), await shot(page, ["att"]), excl, "fb");
			const end = await page.evaluate(() => (window as any).zo.end()) as any;
			report.attachedOutsideAfterLanding = { ids, at, v0, v1, land: { landed: land.landed, zoom: land.after.zoom }, settled: settled.final, st: { held: st.held, ext: st.ext, zoom: st.zoom, standIn: st.standIn },
				far, mid, tiles, next: w.next, final: end.final };
			console.log("ZO-ATTACHED-OUTSIDE-AFTER-LANDING " + JSON.stringify(report.attachedOutsideAfterLanding));
			expect(at.members, "premise: the groups' ids").toBe(ids.length);
			expect(st.held, "premise: a raster holds at the landed zoom before the second run").toBe(true);
			expect(far.groups.length, "premise: groups the landed view does not show").toBeGreaterThan(0);
			expect(w.next.up, "premise: the sibling is up on the first preview frame").toBe(true);
			expect(far.ready, `groups the landed view does not show with a whole sprite before the second run (${far.ready} of ${far.groups.length}); none means the build at the landed zoom skipped them and they pop in at the next landing`)
				.toBeGreaterThan(0);
			expect(mid.outside, "attached ink pixels outside the landed view on the first preview frame of the second run").toBeGreaterThan(0);
		});
	}, 600_000);

	/** The attached wash: its pixels (all shown against attached highlight hidden), their core, and the mean change over the core. */
	async function wash(page: Page, tag: string) {
		const all = await shot(page, []), none = await shot(page, ["attHl"]);
		const d = await diff(page, all, none, null, tag + "M");
		const core = await page.evaluate(([t]) => (window as any).za.core(t + "M", t + "C"), [tag] as const) as number;
		const mean = await page.evaluate(([a, b, t]) => (window as any).za.delta(a, b, t + "C"), [all, none, tag] as const) as number;
		return { all: d.all, core, mean };
	}

	it(`attached highlight in the start view shows its wash on the first preview frame as at rest`, async () => {
		await withAttachedPage("wash", async page => {
			const ids = await page.evaluate(() => (window as any).za.hlInside(6)) as string[];
			expect(ids.length, "premise: highlighter strokes inside the start view").toBeGreaterThan(0);
			const at = await page.evaluate(([i]) => (window as any).za.attach(i), [ids] as const) as any;
			const rest = await wash(page, "rw");
			await page.evaluate(() => (window as any).zo.begin());
			const w = await page.evaluate(([dy]) => (window as any).zo.wheel(2, dy, 40, 40), [STEP_PX] as const) as any;
			const tiles = await page.evaluate(() => (window as any).za.heldTiles());
			const mid = await wash(page, "mw");
			const end = await page.evaluate(() => (window as any).zo.end()) as any;
			report.attachedWash = { ids, at, rest, mid, tiles, next: w.next, final: end.final };
			console.log("ZO-ATTACHED-WASH " + JSON.stringify(report.attachedWash));
			expect(at.held, "premise: the raster holds the free strokes at the start zoom").toBe(true);
			expect(w.next.up, "premise: the sibling is up on the first preview frame").toBe(true);
			expect(rest.core, "premise: attached wash core pixels at rest").toBeGreaterThanOrEqual(CROSS_MIN);
			expect(mid.core, "premise: attached wash core pixels on the first preview frame").toBeGreaterThanOrEqual(CROSS_MIN);
			expect(Math.abs(mid.mean / rest.mean - 1), `attached wash's mean change on the first preview frame (${mid.mean}) against at rest (${rest.mean}); over it, the wash shows twice or without its alpha`)
				.toBeLessThanOrEqual(WASH_SLACK);
		});
	}, 600_000);

	/**
	 * The scaled source on 1.5.0: the second quick wheel run, with the old raster held as the stand-in at another density than the
	 * landed layer (copy factor off 1, a fractional offset), so the tiles a hold puts up are scaled once at put-up.
	 */
	it(`attached highlight in the start view shows its wash on the first preview frame as at rest, with the stand-in held`, async () => {
		await withAttachedPage("wash stand-in", async page => {
			const ids = await page.evaluate(() => (window as any).za.hlInside(6)) as string[];
			expect(ids.length, "premise: highlighter strokes inside the start view").toBeGreaterThan(0);
			const at = await page.evaluate(([i]) => (window as any).za.attach(i), [ids] as const) as any;
			const land = await standInStart(page);
			// The pane moves for some frames after the landing, and the layer builds the group's sprite over still paints: read rest
			// once two shots in a row agree and the sprite is whole, so the hold puts up its tiles.
			let still = -1;
			for (let i = 0, prev = await shot(page, []); i < 40 && still < 0; i++) {
				await page.evaluate(() => (window as any).zo.frames(4));
				const now = await shot(page, []);
				const ready = await page.evaluate(() => (window as any).za.spriteReady("za-group")) as boolean;
				if (ready && (await diff(page, prev, now, null, "sq")).all === 0) still = i;
				prev = now;
			}
			const rest = await wash(page, "sw");
			const st = await page.evaluate(() => (window as any).zo.state()) as any;
			await page.evaluate(() => (window as any).zo.begin());
			const w = await page.evaluate(([dy]) => (window as any).zo.wheel(2, dy, 40, 40), [STEP_PX] as const) as any;
			const tiles = await page.evaluate(() => (window as any).za.heldTiles());
			const mid = await wash(page, "tw");
			const end = await page.evaluate(() => (window as any).zo.end()) as any;
			report.attachedWashStandIn = { ids, at, land, still, standIn: st.standIn, ext: st.ext, rest, mid, tiles, next: w.next, final: end.final };
			console.log("ZO-ATTACHED-WASH-STANDIN " + JSON.stringify(report.attachedWashStandIn));
			expect(at.held, "premise: the raster holds the free strokes at the start zoom").toBe(true);
			expect(still, "premise: two shots in a row agree and the group's sprite is whole before the rest read").toBeGreaterThanOrEqual(0);
			expect(st.ext, "premise: no raster at the landed zoom before the second run").toBe(null);
			expect(st.standIn, "premise: the stand-in is the source of the second run").not.toBe(null);
			expect(w.next.up, "premise: the sibling is up on the first preview frame").toBe(true);
			expect((tiles as any)?.hl, "the hold put up the group's highlight tiles, scaled with the stand-in; none means the layer's canvases stay shown and a group off the start view pops in at the landing").toBeGreaterThan(0);
			expect(rest.core, "premise: attached wash core pixels at rest").toBeGreaterThanOrEqual(CROSS_MIN);
			expect(mid.core, "premise: attached wash core pixels on the first preview frame").toBeGreaterThanOrEqual(CROSS_MIN);
			expect(Math.abs(mid.mean / rest.mean - 1), `attached wash's mean change on the first preview frame (${mid.mean}) against at rest (${rest.mean}), the stand-in held; over it, the wash shows twice or without its alpha`)
				.toBeLessThanOrEqual(WASH_SLACK);
		});
	}, 600_000);

	it(`two attached highlight groups that overlap in the start view show one wash on the first preview frame`, async () => {
		await withAttachedPage("overlap", async page => {
			const ids = await page.evaluate(() => (window as any).za.hlPairInside()) as string[];
			expect(ids.length, "premise: two highlighter strokes inside the start view whose boxes overlap").toBe(2);
			const at = await page.evaluate(([a, b]) => (window as any).za.attachMany([[a], [b]]), [ids[0], ids[1]] as const) as any;
			await page.evaluate(() => (window as any).zo.begin());
			const w = await page.evaluate(([dy]) => (window as any).zo.wheel(2, dy, 40, 40), [STEP_PX] as const) as any;
			// Each group alone (the other hidden, against both hidden), their cores' overlap, and of it the share hiding the lower group changes.
			const all = await shot(page, []), noA = await shot(page, ["g:za-group-0"]), noB = await shot(page, ["g:za-group-1"]), none = await shot(page, ["attHl"]);
			const a = await diff(page, noB, none, null, "oA"), b = await diff(page, noA, none, null, "oB"), d = await diff(page, all, noA, null, "oD");
			const counts = await page.evaluate(() => { const f = (window as any).za;
				return { aCore: f.core("oA", "oAC"), bCore: f.core("oB", "oBC"), x: f.and("oAC", "oBC", "oX"), y: f.and("oX", "oD", "oY") }; }) as { aCore: number; bCore: number; x: number; y: number };
			const end = await page.evaluate(() => (window as any).zo.end()) as any;
			report.attachedOverlap = { ids, at, a: a.all, b: b.all, d: d.all, ...counts, share: counts.x > 0 ? counts.y / counts.x : Number.NaN, next: w.next, final: end.final };
			console.log("ZO-ATTACHED-OVERLAP " + JSON.stringify(report.attachedOverlap));
			expect(at.members, "premise: both groups' ids").toBe(2);
			expect(at.held, "premise: the raster holds the free strokes at the start zoom").toBe(true);
			expect(w.next.up, "premise: the sibling is up on the first preview frame").toBe(true);
			expect(counts.x, "premise: core pixels where the two groups' washes overlap on the first preview frame").toBeGreaterThanOrEqual(CROSS_MIN);
			expect(counts.y / counts.x, `share of overlap pixels hiding the lower group changes (${counts.y} of ${counts.x}); over it, each group carries its own alpha and the overlap takes it twice`)
				.toBeLessThanOrEqual(CROSS_SHARE_SLACK);
		});
	}, 600_000);

	it(`attached pen in the start view: on the first preview frame each held tile holds the pixels the layer painted at its place`, async () => {
		await withAttachedPage("tileplace", async page => {
			const ids = await page.evaluate(() => (window as any).za.penInside(8)) as string[];
			expect(ids.length, "premise: pen strokes inside the start view").toBeGreaterThan(0);
			const at = await page.evaluate(([i]) => (window as any).za.attach(i), [ids] as const) as any;
			await page.evaluate(() => (window as any).zo.begin());
			const w = await page.evaluate(([dy]) => (window as any).zo.wheel(2, dy, 40, 40), [STEP_PX] as const) as any;
			const tiles = await page.evaluate(() => (window as any).za.heldTiles()) as any;
			// The term, at the layer's device px: each tile beside the attached pen canvas the layer painted, at the place heldTiles
			// gave it. paint() copies a tile there whole, so a tile at its place matches every pixel.
			const match = await page.evaluate(() => (window as any).za.tileMatch()) as { tiles: number; ink: number; changed: number; outside: number } | null;
			// The second term, at the CSS place: each tile's client rect where the attached pen canvas's rect puts its (x, y) and size.
			const rect = await page.evaluate(() => (window as any).za.tileRect()) as { tiles: number; worst: number; s: number; sy: number; dpr: number } | null;
			// Reported, not asserted: the frame as held against the tiles hidden and the pane's attached canvases shown in their place,
			// free ink hidden in both (the pane's canvases sit under the held element). The two composite apart, so a green tree reads
			// core pixels changed here too (306 of 1277 at ccb691b8, 799 with the tiles 1 px right); a bound of 0 cannot hold on it.
			const free = ["freeHl", "freePen"];
			const held = await shot(page, free), swapped = await shot(page, [...free, "tiles"], ["attCanvases"]), none = await shot(page, [...free, "att"]);
			const ink = await diff(page, held, none, null, "tI"), pane = await diff(page, swapped, none, null, "tP"), d = await diff(page, held, swapped, null, "tD");
			const screen = await page.evaluate(() => { const f = (window as any).za; return { core: f.core("tI", "tC"), x: f.and("tC", "tD", "tX") }; }) as { core: number; x: number };
			const end = await page.evaluate(() => (window as any).zo.end()) as any;
			report.attachedTilePlace = { ids, at, tiles, match, rect, screen: { ink: ink.all, pane: pane.all, d: d.all, ...screen }, next: w.next, final: end.final };
			console.log("ZO-ATTACHED-TILE-PLACE " + JSON.stringify(report.attachedTilePlace));
			expect(at.members, "premise: the group's ids").toBe(ids.length);
			expect(w.next.up, "premise: the sibling is up on the first preview frame").toBe(true);
			expect([tiles?.pen > 0, tiles?.hidden > 0], "premise: the hold put up pen tiles and hid the pane's canvases").toEqual([true, true]);
			expect([match?.tiles, (match?.ink ?? 0) >= CROSS_MIN, match?.outside], "premise: every pen tile read, inked, inside the attached pen canvas").toEqual([tiles.pen, true, 0]);
			expect(match?.changed, `held tile pixels that differ from the attached pen canvas at the tile's place (${match?.changed} against ${match?.ink} inked); over 0, a tile sits off where paint() copied it`)
				.toBe(0);
			expect([rect?.tiles, (rect?.s ?? 0) > 0], "premise: every pen tile's rect read against a laid-out attached pen canvas").toEqual([tiles.pen, true]);
			expect(rect?.worst, `worst tile edge off the attached pen canvas's rect at the tile's place (${rect?.worst} device px); over 1/16, the hold wrote a tile's CSS place off where the layer paints`)
				.toBeLessThanOrEqual(1 / 16);
		});
	}, 600_000);
});

/**
 * Off whole device px the extent raster goes up the overview's way: clipped off the start view by an even-odd ring, the pane's
 * canvases kept shown. On the first preview frame at pans 0,-150 and 0,-450, the held element alone (every canvas shown against
 * the same frame with only the held element hidden) must add ink outside the start view's box grown by 2 device px, and no ink
 * inside that box less 3 device px. A missing ring paints the start view's ink a second time over the pane's.
 */
const OFF_GRID_PANS: ReadonlyArray<readonly [number, number]> = [[0, -150], [0, -450]];
it(`held raster at dsf ${DSF}: off whole device px the clipped raster adds no ink inside the start view on the first preview frame`, async () => {
	const rows: any[] = [];
	for (const [px, py] of OFF_GRID_PANS) await withPage(`off-grid ${px},${py}`, async page => {
		const pan = await page.evaluate(([x, y]) => (window as any).panBake.settlePan(x, y), [px, py] as const) as any;
		await page.evaluate(() => (window as any).panBake.awaitSharp());
		const at = await page.evaluate(() => (window as any).zo.state()) as any;
		await page.evaluate(() => (window as any).zo.begin());
		const w = await page.evaluate(([dy]) => (window as any).zo.wheel(2, dy, 40, 40), [STEP_PX] as const) as any;
		const r = await page.evaluate(() => (window as any).zo.rects()) as { pane: any; start: any };
		const clip = { x: r.pane.x, y: r.pane.y, width: r.pane.w, height: r.pane.h };
		const a = (await page.screenshot({ clip })).toString("base64");
		await page.evaluate(() => { const s = document.head.appendChild(document.createElement("style")); s.id = "zo-hide-held";
			s.textContent = ".handwriting-ink-held, .handwriting-ink-held * { visibility: hidden !important; }"; });
		const b = (await page.screenshot({ clip })).toString("base64");
		await page.evaluate(() => document.getElementById("zo-hide-held")?.remove());
		const k = DSF, s = r.start, p = r.pane;
		const grown = { x0: Math.floor((s.x - p.x) * k) - 2, y0: Math.floor((s.y - p.y) * k) - 2, x1: Math.ceil((s.x + s.w - p.x) * k) + 2, y1: Math.ceil((s.y + s.h - p.y) * k) + 2 };
		const shrunk = { x0: Math.ceil((s.x - p.x) * k) + 3, y0: Math.ceil((s.y - p.y) * k) + 3, x1: Math.floor((s.x + s.w - p.x) * k) - 3, y1: Math.floor((s.y + s.h - p.y) * k) - 3 };
		const out = await page.evaluate(([a, b, e]) => (window as any).zo.diff(a, b, e, "off-grid-out"), [a, b, grown] as const) as { all: number; outside: number };
		const inn = await page.evaluate(([a, b, e]) => (window as any).zo.diff(a, b, e, "off-grid-in"), [a, b, shrunk] as const) as { all: number; outside: number };
		await page.evaluate(() => (window as any).zo.end());
		rows.push({ pan: [px, py], settled: pan?.pan ?? null, held: at.held, preview: w.next.preview, up: w.next.up, paneShown: w.next.paneShown,
			compositeShown: w.next.compositeShown, start: s, grown, shrunk, all: out.all, outside: out.outside, inside: inn.all - inn.outside });
	});
	report.offGrid = rows;
	console.log("ZO-OFF-GRID " + JSON.stringify(rows));
	for (const r of rows) {
		const p = `at pan ${r.pan[0]},${r.pan[1]}`;
		expect(r.held, `premise ${p}: the extent raster is held at the start zoom`).toBe(true);
		expect(r.preview, `premise ${p}: the first preview frame is painted`).toBe(true);
		expect(r.up, `premise ${p}: the held element is up on the first preview frame`).toBe(true);
		expect(r.paneShown, `premise ${p}: the pane's committed canvas stays shown (a clipped pick)`).toBe(true);
		expect(r.outside, `premise ${p}: the held element adds ink outside the start view`).toBeGreaterThan(0);
		expect(r.inside, `${p}: ink the held element adds inside the start view (box less 3 device px)`).toBe(0);
	}
}, 600_000);
