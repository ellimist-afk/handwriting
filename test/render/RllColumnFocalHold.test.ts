/**
 * READABLE LINE LENGTH: THE COLUMN STAYS UNDER THE FINGERS, AND COMES BACK TO ITS REST.
 *
 * Rig: ZoomOutStandingPan's mount and gesture drivers, with three readouts added (the scrollbar gutter, the frozen column
 * inset, the bounce) and a line count for the short-note arm.
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

declare const process: { env: Record<string, string | undefined> };

/** The page: the same mount as scrollColumnAnchorPage (pane offset 300 px, monospace 16/24, Obsidian's sizer), plus the stroke and the readers. */
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
const ids = new Map(), sidecars = new Map();
const save = (id, page) => { sidecars.set(id, serializePage(page)); };
inlineInk.attachHost({ readPageId: p => ids.get(p) ?? null, claimId: async (p, id) => { ids.set(p, id); return { pageId: id }; },
	loadSidecar: async id => (sidecars.has(id) ? parsePage(sidecars.get(id), id) : null), scheduleSidecar: save, scheduleSidecarNow: async (id, p) => save(id, p), notify: () => {} });

const frame = () => new Promise(r => requestAnimationFrame(() => r()));
/** After the frame has rendered: its layout, its observer deliveries and its paint have run. */
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
const lineEl = view => { const all = view.contentDOM.querySelectorAll(".cm-line"); return all[Math.min(TEXT_LINE, all.length - 1)]; };
const textBox = view => { const range = document.createRange(); range.selectNodeContents(lineEl(view)); const r = range.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, cy: (r.top + r.bottom) / 2 }; };
const MAGENTA = p => p[3] > 200 && p[0] > 200 && p[1] < 60 && p[2] > 200;

/** The committed canvas's magenta pixels, mapped through the canvas's client rect. */
function backingInk() {
	const cc = rig.overlay.committedCanvas, w = cc.width, h = cc.height;
	if (!(w > 0 && h > 0)) return null;
	const d = cc.getContext("2d").getImageData(0, 0, w, h).data;
	let minY = Infinity, maxY = -1, minX = Infinity, maxX = -1, n = 0;
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; if (MAGENTA([d[i], d[i + 1], d[i + 2], d[i + 3]])) { n++; if (y < minY) minY = y; if (y > maxY) maxY = y; if (x < minX) minX = x; if (x > maxX) maxX = x; } }
	if (!n) return { n };
	const r = cc.getBoundingClientRect();
	return { n, cy: r.top + ((minY + maxY + 1) / 2) * r.height / h,
		left: r.left + minX * r.width / w, right: r.left + (maxX + 1) * r.width / w };
}

const r2 = v => Math.round(v * 100) / 100;

function sample(phase) {
	const { view, overlay, pane } = rig, t = textBox(view), ink = backingInk(), k = overlay.pinchScaleNow;
	const lr = lineEl(view).getBoundingClientRect();
	const s = view.scrollDOM, pr = pane.getBoundingClientRect(), sr = s.getBoundingClientRect(), cr = view.contentDOM.getBoundingClientRect();
	const pan = overlay.viewportPan || { x: 0, y: 0 };
	return { phase, k, preview: !!overlay.pinchPreview,
		panX: r2(pan.x), panY: r2(pan.y), rasterPanX: r2(overlay.rasterPan ? overlay.rasterPan.x : 0), rasterPanY: r2(overlay.rasterPan ? overlay.rasterPan.y : 0),
		// The scroller's remaining range on each axis: the regime this claim is about.
		rangeX: r2(s.scrollWidth - s.clientWidth), rangeY: r2(s.scrollHeight - s.clientHeight), scrollLeft: r2(s.scrollLeft), scrollTop: r2(s.scrollTop),
		paneLeft: r2(pr.left), paneRight: r2(pr.right), textLeft: r2(t.left), textRight: r2(t.right), textCy: r2(t.cy),
		// The rule bounds the CONTENT's box against the viewport: the scroller is the viewport, .cm-content is the page.
		viewLeft: r2(sr.left), viewRight: r2(sr.right), contentLeft: r2(cr.left), contentRight: r2(cr.right),
		// The overlay's own fit quantity when the build exposes it (the fix's helper), so the cell can cross-check the regime it asserts.
		fitReadout: typeof overlay.panFitReadout === "function" ? overlay.panFitReadout() : null,
		sizerTransform: rig.sizer.style.transform || "",
		// The scrollbar gutter in screen px, the frozen column inset, and the bounce as the overlay reports it.
		barScreen: r2(sr.width - s.clientWidth * sr.width / s.offsetWidth), overflowX: getComputedStyle(s).overflowX, columnLocal: overlay.viewportLayout ? overlay.viewportLayout.columnLocal : null,
		// THE FREEZE, READ RATHER THAN INFERRED. ownLines is the fact the overlay measured; ownLinesClass is whether the
		// host still carries the token that scopes the width pin off (CodeMirror rewrites this attribute on every update);
		// contentLocalW against scrollerLocalW is the pin itself - frozen, .cm-content stays at its 100% width inside a
		// counter-sized scroller, and the theme has no room to re-centre its lines in.
		ownLines: overlay.viewportLayout ? !!overlay.viewportLayout.ownLines : null,
		// NOT columnLeft(): calling it RESOLVES, and resolveColumnLeft writes its cache on every non-null read, so a
		// readout that asked it would refresh the very value a plant aimed at that cache freezes - measured, it made the
		// plant look inert. lineLeft above is the same number read off the line box, with no side effect.
		// ...and the camera it feeds, plus the ink layer's own transform: between them these say whether a plant aimed at
		// the origin read reaches the pixels, or whether something downstream re-establishes it.
		camX: overlay.camera ? r2(overlay.camera.x) : null, camZoom: overlay.camera ? overlay.camera.zoom : null,
		inkLayerTransform: (rig.overlay.committedCanvas && rig.overlay.committedCanvas.style.transform) || "",
		ownLinesClass: view.dom.classList.contains("handwriting-note-viewport-own-lines"),
		contentLocalW: r2((cr.right - cr.left) / k), scrollerLocalW: r2(s.clientWidth),
		bounce: typeof overlay.overscrollBounceReadout === "function" ? overlay.overscrollBounceReadout() : null,
		lineLeft: r2(lr.left), lineRight: r2(lr.right), lineWidth: r2(lr.width), scrollerLocal: r2(s.clientWidth), scrollerBox: r2(s.offsetWidth), sizerLeft: r2(rig.sizer.offsetLeft), sizerWidth: r2(rig.sizer.offsetWidth), sizerMarginLeft: getComputedStyle(rig.sizer).marginLeft,
		columnPx: overlay.viewportLayout ? r2(overlay.viewportLayout.column) : null,
		columnBoxPx: overlay.viewportLayout && overlay.viewportLayout.columnBox !== undefined ? r2(overlay.viewportLayout.columnBox) : null,
		// room and extent, the two terms of the settle's floor (min(0, room - extent)),
		// read the same way the settle reads them - paneWidth/externalScale off viewportLayout, the ink
		// extent off surfaceExtents - so a cell can derive its own expected rest instead of pinning one.
		paneWidthPx: overlay.viewportLayout ? r2(overlay.viewportLayout.paneWidth) : null,
		externalScale: overlay.viewportLayout ? overlay.viewportLayout.externalScale : null,
		extentX: rig.path ? r2(surfaceExtents.get(rig.path).x) : null, fontZoom: overlay.fontZoom,
		// The scrollbar gutter in screen px on this frame: Readable line length centres the column beside it.
		gutter: r2(sr.width - s.clientWidth * sr.width / s.offsetWidth),
		inkN: ink ? ink.n : 0, inkLeft: ink && ink.n ? r2(ink.left) : null, inkRight: ink && ink.n ? r2(ink.right) : null,
		// Test-only: backingInk scans the committed canvas's BACKING STORE, so inkN 0 says
		// only that nothing is rasterised there - it cannot tell a lost stroke from one the page has slid
		// away from. These three read the model and the canvas box instead: the stroke's own note-space x,
		// how many strokes the note still holds, and where the canvas that would paint them actually sits.
		modelStrokes: rig.path ? inlineInk.strokes(rig.path).length : null,
		modelStrokeX: rig.path && inlineInk.strokes(rig.path).length ? r2(inlineInk.strokes(rig.path)[0].points[0].x) : null,
		modelStrokeY: rig.path && inlineInk.strokes(rig.path).length ? r2(inlineInk.strokes(rig.path)[0].points[0].y) : null,
		ccLeft: rig.overlay.committedCanvas ? r2(rig.overlay.committedCanvas.getBoundingClientRect().left) : null,
		ccRight: rig.overlay.committedCanvas ? r2(rig.overlay.committedCanvas.getBoundingClientRect().right) : null,
		ccW: rig.overlay.committedCanvas ? rig.overlay.committedCanvas.width : null,
		dyNote: ink && ink.n ? (ink.cy - t.cy) / k : null };
}

window.standingPan = {
	async mount(readable, tag, lines, noInk, title) {
		// Alan, 2026-09-20: the pinch zoom exists only under the Infinite Canvas now, so a
		// rig that pinches mounts with the canvas ON. The canvas-on settle laws apply here: the
		// page stays where the fingers left it, no centring and no fit window.
		setPenInk(true); setScrollExpansionEnabled(true);
		setInlineTool("pen"); setInkColorHex("pen", "#ff00ff"); setInkSizeMult("pen", 4);
		const path = "standing-pan-" + readable + "-" + (tag || "gesture") + ".md";
		const pane = document.body.appendChild(document.createElement("div"));
		pane.className = "markdown-source-view mod-cm6" + (readable ? " is-readable-line-width" : "");
		pane.style.cssText = "position:relative;margin-left:" + HOST_LEFT + "px;width:" + PANE_W + "px;height:" + PANE_H + "px;overflow:hidden";
		// A lines count of 0 IS AN EMPTY NOTE, which the old lines-or-400 form could not express. Alan's note is a fresh
		// "Untitled" with nothing in it, and an empty note has no line element to measure a column from -
		// the one ingredient the 400-line fixtures cannot carry.
		const doc = lines === 0 ? "" : Array.from({ length: lines || 400 }, (_, i) => "line " + i + " alpha beta gamma delta epsilon zeta").join("\\n");
		const view = new EditorView({ parent: pane, state: EditorState.create({ doc, extensions: [history(), EditorView.lineWrapping,
			editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} })), inkOverlayExtension(),
			EditorView.theme({ "&": { width: PANE_W + "px", height: PANE_H + "px" }, ".cm-scroller": { overflowY: "auto", overflowX: "hidden" }, ".cm-content": { fontFamily: "monospace", fontSize: "16px", lineHeight: "24px" } })] }) });
		const sizer = installSizer(view);
		// Obsidian mounts the inline title as a SIZER CHILD, beside the contentContainer, not inside .cm-content -
		// which is why the own-lines freeze written on the .cm-content children never reached it. Opt-in, so every
		// other arm keeps the geometry it was written against.
		let titleEl = null;
		if (title) { titleEl = document.createElement("div"); titleEl.className = "inline-title"; titleEl.setAttribute("contenteditable", "true"); titleEl.textContent = "Untitled"; sizer.insertBefore(titleEl, sizer.firstChild); }
		await settle(12);
		const overlay = overlayForPath(path);
		if (!overlay) throw new Error("no overlay for " + path);
		rig = { pane, view, overlay, sizer, path, title: titleEl };
		const t = textBox(view), x = t.left + 80, y = t.cy;
		const pen = (type, px, py, buttons) => document.elementFromPoint(px, py)?.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "pen", pointerId: 901, isPrimary: true, clientX: px, clientY: py, buttons, pressure: buttons ? 0.5 : 0 }));
		if (!noInk) { pen("pointerdown", x, y, 1); for (let i = 1; i <= 6; i++) pen("pointermove", x + 30 * i, y, 1); pen("pointerup", x + 180, y, 0); }
		await settle(12);
		return { strokes: inlineInk.strokes(path).length, natural: sample("natural"), inkMiddleX: textBox(view).left + 170, pane: pane.getBoundingClientRect().toJSON() };
	},
	/** Known 10 px down on the committed canvas; both readers must read it back. Removed before returning. */
	async plant(on) { rig.overlay.committedCanvas.style.translate = on ? "0 10px" : ""; await settle(2); return sample(on ? "plant-on" : "plant-off"); },
	/**
	 * READABLE LINE LENGTH TURNED OFF IN SESSION, which is what Alan did on the device and is not the
	 * same fixture as one mounted with it off (mounted off, the rig reads left edge 0 and can
	 * never see this). Obsidian carries the setting as a class on the pane, so the toggle is the class plus
	 * the re-measure the overlay would get from the real setting change. Returns a sample either side so a
	 * cell can see what the toggle itself moved before any gesture runs.
	 */
	/**
	 * THE INSET FLAG AND ITS THREE INPUTS, read straight off the overlay rather than inferred from
	 * where the page ended up. columnInset is InkOverlay.ts :8068, columnBoxLocal <= scroller.clientWidth
	 * minus the slack; this returns both sides of that comparison plus the flag and the margin var, so a
	 * cell can say WHICH side moved when the flag flips.
	 */
	/**
	 * A TAKEOVER AT THE CURRENT ZOOM. prepareViewportLayout builds the layout ONCE (:7894, guarded on
	 * viewportLayout being null) and that build is the only caller of measureNaturalColumn(null) - the only
	 * basis measured LIVE rather than natural. In the rig the first build always happens on the first zoom
	 * frame, while the host is still at scale 1, so it can never see a counter-sized scroller. On the device
	 * a relaunch restores a zoom and the overlay takes over on a note already zoomed out.
	 *
	 * Dropping the layout is how this rig reaches that state: the next zoom rebuilds it, and the rebuild
	 * measures whatever basis the host is in NOW. It pokes a private field, which is why it lives in a probe
	 * and says so; nothing in production clears it this way.
	 */
	async retakeover(tag) {
		rig.overlay.viewportLayout = null;
		rig.overlay.handleResize();
		await settle(16); await new Promise(r => setTimeout(r, 50)); await settle(6);
		return this.insetRead(tag);
	},
	/**
	 * A THEME-LIKE NARROW COLUMN WITH NO SETTING CLASS. Obsidian's own setting caps the line through
	 * .is-readable-line-width; a theme can cap it with its own rule and no class at all. That is the case
	 * the setting gate has to keep working for, and it is the only way this rig can make columnInset read
	 * true with the class absent - which is the state Alan's device was in.
	 */
	async themeNarrow(px) {
		const st = document.createElement("style");
		st.textContent = ".cm-content, .cm-line { max-width: " + px + "px !important; }";
		document.head.appendChild(st);
		rig.overlay.handleResize();
		await settle(16); await new Promise(r => setTimeout(r, 50)); await settle(6);
		return this.insetRead("narrowed");
	},
	insetRead(tag) {
		const L = rig.overlay.viewportLayout, line = lineEl(rig.view);
		return { tag, k: rig.overlay.pinchScaleNow, externalScale: L ? L.externalScale : null,
			columnInset: L ? L.columnInset : null, sizerColumn: L ? L.sizerColumn : null, columnLocal: L ? L.columnLocal : null,
			lineBox: line instanceof HTMLElement ? line.offsetWidth : 0,
			contentW: rig.view.contentDOM.offsetWidth, clientWidth: rig.view.scrollDOM.clientWidth,
			marginVar: rig.view.dom.style.getPropertyValue("--handwriting-column-margin-left"),
			autoVar: rig.view.dom.style.getPropertyValue("--handwriting-column-auto-left"),
			sizerLeft: rig.sizer.getBoundingClientRect().left, scrollerLeft: rig.view.scrollDOM.getBoundingClientRect().left };
	},
	async setReadable(on) {
		const before = sample(on ? "toggle-on-before" : "toggle-off-before");
		// THE CSS VARIABLE ITSELF, read rather than inferred from where the page ended up. The
		// stylesheet clamps the sizer's margin between 0 and this var, and an UNSET var makes the clamp
		// fall back to its own centring calc - so "unset" and "0px" put the page in different places.
		const varBefore = rig.view.dom.style.getPropertyValue("--handwriting-column-margin-left");
		rig.pane.classList.toggle("is-readable-line-width", !!on);
		rig.overlay.handleResize();
		await settle(16); await new Promise(r => setTimeout(r, 50)); await settle(6);
		return { before, after: sample(on ? "toggle-on" : "toggle-off"), varBefore,
			varAfter: rig.view.dom.style.getPropertyValue("--handwriting-column-margin-left") };
	},
	/** The router's two-finger pinch about an EXPLICIT client point, spread 300 -> 300 x to over steps frames, then settle. */
	async pinch(to, steps, cx, cy, tag) {
		const { overlay } = rig, router = overlay.router, from = overlay.pinchScaleNow;
		const spread0 = 300, spread1 = 300 * to / from;
		const touch = s => { router.touchPos.set(911, { x: cx - s / 2, y: cy }); router.touchPos.set(912, { x: cx + s / 2, y: cy }); };
		const ev = type => new PointerEvent(type, { pointerId: 912, pointerType: "touch" });
		const rows = [sample(tag + "-before")];
		touch(spread0); router.beginPinch(ev("pointerdown"));
		for (let i = 1; i <= steps; i++) { touch(spread0 + (spread1 - spread0) * i / steps); router.updatePinch(ev("pointermove")); await rendered(); rows.push(sample(tag + "-move-" + i)); }
		router.endPinch(ev("pointerup"), { x: cx, y: cy }); router.touchPos.clear();
		for (let j = 1; j <= 16; j++) { await rendered(); rows.push(sample(tag + "-settle-" + j)); }
		// The settle's correction glides for half a second, longer than those frames: read on to the rest, one row a frame,
		// so the last row is the settled page and the rows in between still carry the glide.
		for (let j = 1; j <= 90 && rig.overlay.overscrollBounceReadout && rig.overlay.overscrollBounceReadout().active; j++) { await rendered(); rows.push(sample(tag + "-glide-" + j)); }
		return rows;
	},
	/**
	 * ONE gesture from the current scale to "to", its centre travelling from cxStart to cxEnd the whole way: a drag whose
	 * spread drifted, or a zoom that also pans. slopKick (px) opens the spread by that much on the first frame, so a drift
	 * smaller than the router's 12 px pinch slop still belongs to an ACTIVE gesture, as it does on a real screen once the
	 * fingers have moved: measured, a 9 px spread change with no kick never activated and moved nothing.
	 */
	async pinchPath(to, steps, cxStart, cxEnd, cy, tag, slopKick) {
		const { overlay } = rig, router = overlay.router, from = overlay.pinchScaleNow;
		const spread0 = 300, spread1 = 300 * to / from, kick = slopKick || 0;
		const touch = (s, cx) => { router.touchPos.set(911, { x: cx - s / 2, y: cy }); router.touchPos.set(912, { x: cx + s / 2, y: cy }); };
		const ev = type => new PointerEvent(type, { pointerId: 912, pointerType: "touch" });
		const rows = [sample(tag + "-before")];
		touch(spread0, cxStart); router.beginPinch(ev("pointerdown"));
		for (let i = 1; i <= steps; i++) {
			const t = i / steps;
			const spread = kick && i === 1 ? spread0 + kick : kick ? spread0 + kick + (spread1 - spread0 - kick) * (i - 1) / (steps - 1) : spread0 + (spread1 - spread0) * t;
			touch(spread, cxStart + (cxEnd - cxStart) * t);
			router.updatePinch(ev("pointermove")); await rendered(); rows.push(sample(tag + "-move-" + i));
		}
		router.endPinch(ev("pointerup"), { x: cxEnd, y: cy }); router.touchPos.clear();
		for (let j = 1; j <= 16; j++) { await rendered(); rows.push(sample(tag + "-settle-" + j)); }
		// The settle's correction glides for half a second, longer than those frames: read on to the rest, one row a frame,
		// so the last row is the settled page and the rows in between still carry the glide.
		for (let j = 1; j <= 90 && rig.overlay.overscrollBounceReadout && rig.overlay.overscrollBounceReadout().active; j++) { await rendered(); rows.push(sample(tag + "-glide-" + j)); }
		return rows;
	},
	/** ONE gesture in to peak and back out to the scale it began at, the centre drifting from cxStart to cxEnd over the whole of it. */
	async pinchRound(peak, steps, cxStart, cxEnd, cy, tag) {
		const { overlay } = rig, router = overlay.router, from = overlay.pinchScaleNow;
		const spread0 = 300, spreadPeak = 300 * peak / from, total = steps * 2;
		const touch = (s, cx) => { router.touchPos.set(911, { x: cx - s / 2, y: cy }); router.touchPos.set(912, { x: cx + s / 2, y: cy }); };
		const ev = type => new PointerEvent(type, { pointerId: 912, pointerType: "touch" });
		const rows = [sample(tag + "-before")];
		touch(spread0, cxStart); router.beginPinch(ev("pointerdown"));
		for (let i = 1; i <= total; i++) {
			const up = i <= steps ? i / steps : (total - i) / steps;
			touch(spread0 + (spreadPeak - spread0) * up, cxStart + (cxEnd - cxStart) * i / total);
			router.updatePinch(ev("pointermove")); await rendered(); rows.push(sample(tag + "-move-" + i));
		}
		router.endPinch(ev("pointerup"), { x: cxEnd, y: cy }); router.touchPos.clear();
		for (let j = 1; j <= 16; j++) { await rendered(); rows.push(sample(tag + "-settle-" + j)); }
		// The settle's correction glides for half a second, longer than those frames: read on to the rest, one row a frame,
		// so the last row is the settled page and the rows in between still carry the glide.
		for (let j = 1; j <= 90 && rig.overlay.overscrollBounceReadout && rig.overlay.overscrollBounceReadout().active; j++) { await rendered(); rows.push(sample(tag + "-glide-" + j)); }
		return rows;
	},
	/**
	 * THE TITLE'S LEFT EDGE AGAINST THE FIRST LINE'S, both read off their own boxes, plus the text edge inside
	 * each (the line carries padding, the title does not). The FIRST line, not lineEl's sixth: the title sits above the
	 * first line on screen, and that is the pair Alan compares.
	 */
	titleRead(tag) {
		const t = rig.title ? rig.title.getBoundingClientRect() : null;
		const first = rig.view.contentDOM.querySelector(".cm-line");
		const l = first ? first.getBoundingClientRect() : null, s = rig.view.scrollDOM.getBoundingClientRect();
		return { tag, k: rig.overlay.pinchScaleNow,
			ownLines: rig.overlay.viewportLayout ? !!rig.overlay.viewportLayout.ownLines : null,
			ownLinesClass: rig.view.dom.classList.contains("handwriting-note-viewport-own-lines"),
			titleLeft: t ? r2(t.left) : null, titleWidth: t ? r2(t.width) : null,
			lineLeft: l ? r2(l.left) : null, lineWidth: l ? r2(l.width) : null, viewLeft: r2(s.left),
			titleTextLeft: t ? r2(t.left + parseFloat(getComputedStyle(rig.title).paddingLeft || "0")) : null,
			lineTextLeft: l ? r2(l.left + parseFloat(getComputedStyle(first).paddingLeft || "0")) : null,
			titleMarginLeft: rig.title ? getComputedStyle(rig.title).marginLeft : null,
			sizerLeft: r2(rig.sizer.getBoundingClientRect().left), sizerWidth: r2(rig.sizer.getBoundingClientRect().width) };
	},
	sample,
	/** The middle zoom button's own path: zoomNoteBy about the pane's centre, no gesture. */
	async zoomBy(factor) { const ok = rig.overlay.zoomNoteBy(factor); await settle(12); await new Promise(r => setTimeout(r, 50)); await settle(4); return { ok, row: sample("zoomBy") }; },
	/** A synthetic tall stroke, copied from the mounted one and stretched down the note, dx note px to the right of it. */
	async tallInk(dx, height, width) {
		const s = inlineInk.strokes(rig.path)[0];
		const n = s.points.length, pts = s.points.map((p, i) => ({ ...p, x: p.x + dx + (width || 0) * i / (n - 1), y: p.y + height * i / (n - 1) }));
		const xs = pts.map(p => p.x), ys = pts.map(p => p.y), pad = s.bbox.x - Math.min(...s.points.map(p => p.x));
		inlineInk.commit(rig.path, { ...s, id: s.id + "-tall-" + dx, points: pts, bbox: { x: Math.min(...xs) + pad, y: Math.min(...ys) + pad, width: Math.max(...xs) - Math.min(...xs) - 2 * pad, height: Math.max(...ys) - Math.min(...ys) - 2 * pad } });
		rig.overlay.scheduleRepaint("tall-ink"); await settle(10);
		return inlineInk.strokes(rig.path).length;
	},
	/** A CODEMIRROR UPDATE with no camera change: the thing that rewrites the host's class attribute. */
	async update(phase) { rig.view.dispatch({ changes: { from: 0, insert: "x " } }); await settle(12); return sample(phase || "update"); },
	/** A PANE RESIZE with no camera change: handleResize's own path, with an update behind it. */
	async resizePane(dw) { rig.pane.style.width = (PANE_W + dw) + "px"; await settle(16); await new Promise(r => setTimeout(r, 50)); await settle(6); return sample("resize"); },
	/** Fit, the command's own path. */
	async fit() { const r = rig.overlay.fitHandwriting(); await settle(12); await new Promise(res => setTimeout(res, 50)); await settle(4); return { r, row: sample("fit") }; },
	/** After a wait in real time, not frames: a deferred repaint runs on a timer. The overscroll glide is half a second, so
	 * a settle's own frames are not enough: wait it out rather than read a page still on its way to rest. */
	// Turn the Infinite Canvas on for THIS page after mount, so one cell can read the canvas-on settle in a file
	// whose other cells mount canvas off. handleResize takes the new mode through the ordinary box write.
	async canvasOn() {
		setScrollExpansionEnabled(true);
		rig.overlay.handleResize();
		await settle(16);
		await new Promise(r => setTimeout(r, 60));
		await settle(6);
		return sample('canvas-on');
	},
	async later(ms, phase) { await new Promise(r => setTimeout(r, ms));
		for (let i = 0; i < 90 && rig.overlay.overscrollBounceReadout && rig.overlay.overscrollBounceReadout().active; i++) await frame();
		await settle(4); return sample(phase); },
	/**
	 * Screenshot pixels (PNG as base64 from the test): magenta inside the pane and within 120 px of the text line the stroke
	 * was drawn on, in client px. THE BAND IS NOT DECORATION: the toolbar's colour swatch is magenta too (192 device px of
	 * it), and counting it dragged the bbox centre halfway - the 10 px plant read back as 5 and the cells' own liveness
	 * control caught it. The pane-wide count is kept as 'whole' for diagnosis.
	 */
	async screenInk(b64) {
		const img = await createImageBitmap(await (await fetch("data:image/png;base64," + b64)).blob());
		const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const g = c.getContext("2d"); g.drawImage(img, 0, 0);
		const d = g.getImageData(0, 0, c.width, c.height).data;
		const dpr = c.width / window.innerWidth, pr = rig.pane.getBoundingClientRect();
		const t = textBox(rig.view);
		const x0 = Math.max(0, Math.floor(pr.left * dpr)), x1 = Math.min(c.width, Math.ceil(pr.right * dpr));
		const py0 = Math.max(0, Math.floor(pr.top * dpr)), py1 = Math.min(c.height, Math.ceil(pr.bottom * dpr));
		const y0 = Math.max(py0, Math.floor((t.cy - 120) * dpr)), y1 = Math.min(py1, Math.ceil((t.cy + 120) * dpr));
		let n = 0, minX = Infinity, maxX = -1, minY = Infinity, maxY = -1, whole = 0;
		for (let y = py0; y < py1; y++) for (let x = x0; x < x1; x++) { const i = (y * c.width + x) * 4; if (MAGENTA([d[i], d[i + 1], d[i + 2], d[i + 3]])) {
			whole++;
			if (y >= y0 && y < y1) { n++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; } } }
		if (!n) return { n, dpr, whole };
		return { n, dpr, whole, left: r2(minX / dpr), right: r2((maxX + 1) / dpr), cy: r2((minY + maxY + 1) / 2 / dpr) };
	},
};
`;

let browser: Browser, script: string;
/**
 * Plants, one at a time. HW_RLL_PLANT_NO_FOLLOW=1 keeps the preview's cap at scroll 0 for a centred column, in anchorPanTo
 * and in the input reducer: expected red, the four hold arms and the round trip on the slide, and the button arm, whose
 * next touch can no longer follow the fingers right and so reads a bounce. HW_RLL_PLANT_WINDOW_SETTLE=1 settles an inset column on the fitting
 * window again instead of its rest: expected red, the four hold arms on the stay. The round trip stays green under it by
 * construction: held both ways with nothing corrected at 25%, it comes back to its start on its own.
 * HW_RLL_PLANT_NO_LAYOUT_REST=1 RE-POINTED (part 68). It writes the rest as a PAN instead of the column's margin - the
 * pre-a000a659 carrier - by refusing `applyViewportBox` its resting margin, so `columnRestPan` finds the frozen inset
 * and hands the whole centring back as a translate. Under Obsidian's own theme, where the sizer carries the column,
 * that is the claim "the centring lives in the margin, not a standing pan" made falsifiable: expected red on every arm
 * that asserts no pan at rest, and on the arm that asserts the rest costs no reachable sideways room. Its previous
 * anchor had no match in the source at all, so the plant could only throw rather than discriminate.
 *
 * HW_RLL_PLANT_CONTENT_COLUMN=1 measures the page's own width off `.cm-content` instead of the line box - which is what
 * candidate 1 did, and why it did nothing on the device. Expected GREEN under Obsidian's own theme, where the two are
 * the same element's box, and RED under Minimal on the hold arms, the round trip, the button arm and Fit. It is the
 * plant that makes the second theme load-bearing: without it, a suite could run under Minimal and assert nothing that
 * the default theme was not already asserting.
 */
const PLANT: { name: string; edits: [string, string][] } | null = process.env.HW_RLL_PLANT_NO_FOLLOW
	? { name: "no-follow", edits: [["const rightX = fitsX ?", "const rightX = false ?"], ["const fits = inset &&", "const fits = false &&"]] }
	: process.env.HW_RLL_PLANT_NO_LAYOUT_REST ? { name: "no-layout-rest", edits: [["this.columnRestMargin=this.pinchPreview||!layout.sizerColumn?null:this.columnRestCentred(next,layout.externalScale*next);", "this.columnRestMargin=null;"]] }
	: process.env.HW_RLL_PLANT_CONTENT_COLUMN ? { name: "content-column", edits: [["columnBox:columnBoxLocal,", "columnBox:column,"]] }
	// NO_PAGE_BOX_SCROLL drops the commit's payment of what a line-centring theme's centring owes the page box:
	// expected GREEN everywhere except Minimal's Fit arm with ink past the column, which reddens by the 16-24 px the
	// ink is then carried past the pane's right edge. Inert under Obsidian's own theme, where the sizer margin pays it.
	// NO_FACET_CLASS leaves the own-lines token written imperatively in `applyViewportBox` and takes it out of the
	// `editorAttributes` facet - which is the defect this cell was extended for. CodeMirror rewrites the host's whole
	// class attribute on every update from that facet alone, so the token survives only until the next view update:
	// expected GREEN on the gesture arms (a preview re-writes the box every frame, and the last write lands after the
	// update) and RED on the no-gesture arms under Minimal - the button by 345.5 px, Fit by 519.88 px, and the two
	// commit-then-update arms below. Under Obsidian's own theme it asserts nothing, as the token is never on there.
	// Part 49's two. FREEZE_MINIMAL keeps pinning `.cm-content` under a theme that centres its own lines: expected red on
	// Minimal's rest arms (the rest comes back as a translate). NO_SETTLE_REMEASURE offsets the settle's column
	// re-measure by 8 layout px (part 73). Where it points was measured, not guessed: the ink camera's x comes from
	// syncCamera, and on every OWNED path it is `(band.left - ownedColumnLayoutLeft(origin.line)) / fontZoom` - the band
	// against the column's LAYOUT left. `contentLeft`, via `resolveColumnLeft`, is only the UNOWNED fallback branch,
	// which these arms never take. That is why the original plant was inert: it froze `resolveColumnLeft`'s cache, which
	// (a) the ink does not read here and (b) is shared - `columnLeft()` and `freshFrame()` write it on every non-null
	// read, so freezing it at one call site is refreshed by the next reader inside the same settle. Measured: with that
	// cache frozen, and again with syncCamera's own `contentLeft` frozen where nothing could refresh it, all eight ink
	// arms stayed green and camX was identical to the pixel (-4018 at k 0.25).
	//
	// AN OFFSET, NOT A FREEZE, and the difference is what the plant proves. Freezing the read killed the round trip at a
	// premise, which demonstrates a dependency; an 8 layout px error lets every arm reach its PAYLOAD, so what fails is
	// the ink-on-words claim itself, by 8 px x k: measured 2.19 px at k 0.25, 8.00 px at k 1, 11.88 px at k 1.5.
	//
	// ALL EIGHT ARMS RED, on both themes, INCLUDING the four with Readable line length OFF - which part 73 expected to
	// stay green on the grounds that there is nothing to re-measure there. There is: `ownedColumnLayoutLeft` answers
	// with the setting off too (the page's own left edge, measured 300 = the pane edge), and the ink camera derives from
	// it either way. The setting decides whether the column MOVES, not whether it is read, so the sensitivity is real on
	// both settings and is guarded on both. This supersedes the 1-of-8 coverage caveat recorded under part 68.
	: process.env.HW_RLL_PLANT_FREEZE_MINIMAL ? { name: "freeze-minimal", edits: [["host.classList.toggle(\"handwriting-note-viewport-own-lines\",layout.ownLines);", "host.classList.toggle(\"handwriting-note-viewport-own-lines\",false);"], ["class: overlay.noteViewportOwnLines() ?", "class: false ?"], ["if (layout.ownLines) return 0;", "if (false) return 0;"]] }
	: process.env.HW_RLL_PLANT_NO_PAGE_BOX_SCROLL ? { name: "no-page-box-scroll", edits: [["target.left=this.ownLinesPageBoxScrollLeft(next,effective,target.left);", ""]] }
	: process.env.HW_RLL_PLANT_NO_FACET_CLASS ? { name: "no-facet-class", edits: [["class: overlay.noteViewportOwnLines() ?", "class: false ?"]] }
	: process.env.HW_RLL_PLANT_NO_SETTLE_REMEASURE ? { name: "no-settle-remeasure", edits: [["\t\t// creating camera motion and a full repaint while the band is still.\n\t\tconst layoutColumn = this.ownedColumnLayoutLeft(origin.line);", "\t\t// creating camera motion and a full repaint while the band is still.\n\t\tconst layoutColumn = ((v:number|null)=>v===null?null:v+8)(this.ownedColumnLayoutLeft(origin.line));"]] } : null;
const DPR = 2;
const record: unknown[] = [];
/**
 * THE THEME THIS RUN USES. HW_RLL_THEME=Minimal loads the theme file out of Alan's own vault on top of Obsidian's own
 * CSS; anything else (the default) runs Obsidian alone. One theme per run, so every arm below is the SAME claim read
 * twice rather than a second set of arms that could drift apart from the first.
 *
 * WHY A SECOND THEME AT ALL. Obsidian caps `.cm-content` at the readable width and centres that element, so the content
 * box IS the text column. Minimal forces `.cm-content` and `.cm-sizer` to full width and centres each LINE inside them
 * (theme.css:1852-1867, `--content-margin: auto`, `--line-width: 40rem`). Every quantity this suite reads off the
 * content box therefore means something different under the two, and a fix keyed on the content box is blind to half
 * its users. Alan's vault runs Minimal - it is what candidate 1 was installed into, and where it did nothing.
 */
const THEME = process.env.HW_RLL_THEME || "default";
// The vendored Minimal 9.0.2 (fixtures/, same file MinimalCameraScale.test.ts loads), not a vault on one machine.
const THEME_FILES: Record<string, string> = { Minimal: fileURLToPath(new URL("./fixtures/minimal-9.0.2-theme.css", import.meta.url)) };
const THEME_CSS = THEME === "default" ? "" : readFileSync(THEME_FILES[THEME] ?? THEME, "utf8");

beforeAll(async () => {
	let planted = 0;
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "rllColumnFocalHoldPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
		plugins: PLANT ? [{ name: "rll-plant-" + PLANT.name, setup(builder) {
			builder.onLoad({ filter: /src[\\/]inline[\\/]InkOverlay\.ts$/ }, args => {
				let text = readFileSync(args.path, "utf8").replace(/\r\n/g, "\n");
				for (const [from, to] of PLANT.edits) {
					if (text.split(from).length !== 2) throw new Error("rll plant " + PLANT.name + ": anchor not found once: " + from);
					text = text.replace(from, to);
				}
				planted++;
				return { loader: "ts", contents: text };
			});
		} }] : [] });
	if (PLANT && !planted) throw new Error("rll plant requested but never applied");
	script = b.outputFiles[0]!.text;
	// eslint-disable-next-line no-console
	console.log("RLLFOCAL-RUN " + JSON.stringify({ theme: THEME, themeCssBytes: THEME_CSS.length, plant: PLANT ? PLANT.name : null }));
	browser = await chromium.launch({ headless: true });
}, 180_000);
afterAll(async () => {
	await browser?.close();
	if (process.env.HW_RLL_FOCAL_OUT) writeFileSync(process.env.HW_RLL_FOCAL_OUT, JSON.stringify(record, null, 1));
});

const call = (p: Page, method: string, ...args: unknown[]) => p.evaluate(([m, a]) => (window as any).standingPan[m](...a), [method, args] as const);
const r2 = (v: number) => Math.round(v * 100) / 100;
/** A preview frame's text line against the focal hold, px. The pinned focal cells hold to 1 px. */
const LIVE_TOL_PX = 1;
/**
 * THE REST with Readable line length on, where the column fits the pane: centred in the scroller's
 * content box - the pane less the scrollbar gutter, which keeps its screen size under the zoom host. At 100% that is
 * exactly where the engine's own centring puts it, so the natural frame is at rest by construction (checked per arm).
 *
 * READ OFF THE LINE BOX, not `.cm-content`. Under Obsidian's own theme the two are the same number to the pixel (the
 * default-theme arms assert that equality as a premise rather than trusting it), because a line is a block child of a
 * content box with no horizontal padding. Under Minimal `.cm-content` is the full pane and only the line carries the
 * column, so a rest read off the content box there is the constant `barScreen / 2` and would pass while the text slid
 * about underneath it. The line box is the column under both, which is the same choice `contentOriginLeft` makes.
 */
const restMiss = (r: any) => r2((r.lineLeft + r.lineRight) / 2 - (r.viewLeft + r.viewRight - r.barScreen) / 2);
/**
 * THE COLUMN'S LEFT BORDER AGAINST OBSIDIAN'S OWN
 * NATURAL MARGIN, painted at this scale. The plugin adds no centring at any zoom; what remains is the margin
 * Obsidian itself gives the readable column, which is a host-local quantity and so shrinks with the zoom -
 * 341 host px reads 34 screen px at 10%, not mid-pane. `restMiss` measured CENTRING and is kept only for the
 * 100% frames, where Obsidian's own layout does centre the column and nothing of ours is written.
 *
 * READ AGAINST THE CLAMP, NOT AGAINST ONE CARRIER. The old form subtracted the SIZER's
 * margin, which is the carrier under Obsidian's own theme and zero under a theme that centres its own lines: the
 * same landing then read 0 under one theme and the whole inset under the other, and eleven cells stood red on
 * Minimal for a difference that is not on screen. What puts the column where it is under both is the stylesheet's
 * `clamp(0, auto-left, frozen inset)`, so that is what the expectation computes, from this frame's own readout:
 *   the auto term, host-local = (pane - scrollbar gutter - the line's painted width) / 2k
 *   the column's left edge = min(auto term, the frozen 100% inset) x k, from the pane's left edge.
 * Below 100% the frozen inset is the smaller and wins; above it the auto term does, which is why a zoom-in lands
 * the column nearer the pane's edge than its inset scaled would (150%: 205.25 against 550.88) under BOTH themes -
 * the default theme hid that because the sizer margin the old form subtracted already carried the auto value.
 * Read off the LINE BOX, for the same reason `restMiss` is: the line is the column under both themes.
 */
const columnAutoLocal = (r: any) => Math.max(0, (r.viewRight - r.viewLeft - r.barScreen - r.lineWidth) / (2 * r.k));
const columnRestLeft = (r: any) => Math.min(columnAutoLocal(r), r.columnLocal ?? Number.POSITIVE_INFINITY) * r.k;
const leftMiss = (r: any) => r2((r.lineLeft - r.viewLeft) - columnRestLeft(r));
/**
 * THE REST'S CARRIER, which is the theme's to decide and not this suite's.
 *
 * The rest is the column's own MARGIN wherever the sizer is the thing that carries the column: a pan standing at rest
 * costs on every per-frame path that assumes none (measured, a scroll frame at 25% with the setting on ran 4.5 -> 5.9 ms
 * against 1.4.19), and the margin replaces an inset the sizer already had, so an ordinary note's surface does not grow.
 *
 * MINIMAL CANNOT USE THAT CARRIER, and this is the measured reason. Its sizer is full width with no margin of its own -
 * the LINE inside it is what is centred - so the overlay freezes `.cm-content` at its 100% width (which is what keeps
 * the ink's coordinate space still) and the theme's own re-centring stops happening. The rest then has to supply that
 * centring, and the required offset is POSITIVE below 100% and NEGATIVE above it, while a margin can only be positive:
 * the sizer starts at zero and has nothing to give back. Under Obsidian's own theme the same quantity is a REDUCTION of
 * a margin that is already 341.25, so it stays positive and the margin carries it at every scale.
 *
 * Tried and backed out: making the rest the clamp's own term under Minimal. It moved the zoom-out rest into the margin,
 * and left the round trip 60 px short of where it started (613.5 against 673.25 natural, with 2074 px of margin still
 * standing at 100%). The pan carrier is correct on screen at every scale measured, so it is what Minimal uses.
 *
 * SO THE CLAIM IS THE ONE THAT MATTERS TO A READER: at rest the column is centred (asserted above), and the rest costs
 * no REACHABLE sideways room - nothing is scrolled into it and the scroller does not scroll sideways with Infinite
 * Canvas off. The no-pan form is asserted where the margin can carry it, because a pan at rest costs on every per-frame
 * path that assumes none (measured, a scroll frame at 25% with the setting on ran 4.5 -> 5.9 ms against 1.4.19).
 *
 * KNOWN, with its number: under Minimal a zoom-out to 25% leaves 2075 local px of blank surface to the right of the
 * page, carried by the resting translate. It is not reachable, and it is gone at 100%. OPEN, still to decide:
 * whether to keep it, or to stop freezing `.cm-content` under a theme that re-centres its own lines and let the ink
 * origin follow the line box per frame instead - a larger change than this candidate, and not one to make unasked.
 */
const restCarrier = (r: any) => (r.fitReadout?.sizerColumn ? "the column's own margin" : "a resting translate");
const expectRestCarried = (r: any, where: string) => {
	// eslint-disable-next-line no-console
	console.log(`RLLFOCAL-CARRIER ${JSON.stringify({ where, carrier: restCarrier(r), panX: r.panX, rangeX: r.rangeX, scrollLeft: r.scrollLeft })}`);
	expect(Math.abs(r.panX), `${where}: the rest is the column's margin (${restCarrier(r)}), no pan (panX ${r.panX})`).toBeLessThanOrEqual(0.5);
	expect(r.scrollLeft, `${where}: and nothing is scrolled into its room`).toBe(0);
};
/** Obsidian's own theme puts the column on `.cm-content`; Minimal puts it on the line. Asserted, not assumed. */
const columnPremise = (r: any) => {
	if (THEME !== "default") return;
	expect(Math.abs(r2(r.lineLeft - r.contentLeft)), "premise (default theme): the line box IS the content box, left").toBeLessThanOrEqual(1);
	expect(Math.abs(r2(r.contentRight - r.lineRight)), "premise (default theme): the line box IS the content box, right").toBeLessThanOrEqual(1);
};

async function open(readable: boolean, tag: string, lines?: number, noInk = false, title = false) {
	const page = await browser.newPage({ viewport: { width: 1800, height: 900 }, deviceScaleFactor: DPR, hasTouch: true });
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	// theme-dark because that is the only mode Alan runs; the geometry these arms read is the same in either.
	await page.setContent('<!doctype html><body class="theme-dark" style="margin:0"></body>');
	await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
	if (THEME_CSS) await page.addStyleTag({ content: THEME_CSS });
	await page.addScriptTag({ content: script });
	const mounted = await call(page, "mount", readable, tag, lines, noInk, title) as any;
	expect(mounted.strokes, noInk ? "a blank note" : "the stroke committed").toBe(noInk ? 0 : 1);
	if (readable) columnPremise(mounted.natural);
	return { page, errors, mounted, n: mounted.natural };
}

/**
 * Where the focal hold puts the text line on a frame: the note point that was under the centre when the gesture latched is
 * under its centre now. `from` is the frame the gesture began on; `latch` is the centre on the gesture's first move, which
 * is where the router takes its anchor (measured: a centre that travels 5 px per frame reads a constant 5 note px off a
 * hold latched at the pointerdown, on 31b13737 as on the fix).
 */
const held = (from: any, latch: number, c: number, k: number) => c + (from.textLeft - latch) * k / from.k;

/** Every preview frame of a gesture: its miss against the focal hold, and the scroll it must not have written. */
function live(rows: any[], from: any, c0: number, c1: number, steps: number) {
	// The router opens the preview on the first frame that clears its slop, so a gesture's first frame or two can be
	// before it: those frames have not moved anything and are not the claim.
	const latch = c0 + (c1 - c0) / steps;
	const frames = rows.slice(1, steps + 1).map((r, i) => {
		const c = c0 + (c1 - c0) * (i + 1) / steps;
		return { k: r.k, preview: r.preview, textLeft: r.textLeft, expected: r2(held(from, latch, c, r.k)), miss: r2(r.textLeft - held(from, latch, c, r.k)), scrollLeft: r.scrollLeft, panX: r.panX };
	}).filter(f => f.preview);
	return { frames, maxMiss: Math.max(...frames.map(f => Math.abs(f.miss))), previewFrames: frames.length,
		scrollMoved: Math.max(...frames.map(f => Math.abs(f.scrollLeft - rows[0].scrollLeft))) };
}

/**
 * THE SLIDE, Readable line length ON. Alan on Orion, 31b13737, checklist step 3.7: "zooming out causes the body text (first
 * line, second line) to move left. it also stays if i let go", and "yes, first line visibly slid out as the page shrank"
 * while his fingers were down; zooming in "goes out to the right". Measured here first (rll-shift/probe): at 25% the text
 * landed at the same x whatever the focal point, the pan 0 on every frame - the preview never moves the column right of
 * where its frozen margin puts it, so on a column that fits the pane the zoom is anchored at the pane's left edge.
 *
 * Every arm keeps the column inside the pane on every frame, so no bound applies and the hold is the whole claim.
 */
const RLL_ARMS = [
	{ name: "zoom-out to 25% about the pane's centre", to: 0.25, focus: (n: any, pane: any) => pane.left + pane.width / 2, travel: 0 },
	{ name: "zoom-out to 25% 120 px right of the column", to: 0.25, focus: (n: any) => n.contentRight + 120, travel: 0 },
	{ name: "zoom-in to 150% about the text's start", to: 1.5, focus: (n: any) => n.textLeft + 40, travel: 0 },
	// The device step's gesture: a small zoom-out whose fingers also travel outward, lifted inside the drag band.
	{ name: "zoom-out to 85% with the fingers travelling 150 px right", to: 0.85, focus: (n: any, pane: any) => pane.left + pane.width / 2, travel: 150 },
] as const;

for (const arm of RLL_ARMS) {
	it(`RLL on, ${arm.name}: the text stays under the fingers on every preview frame, and the scroll is not written`, async () => {
		const { page, errors, mounted, n } = await open(true, "hold-" + arm.to + "-" + arm.travel);
		try {
			const c0 = arm.focus(n, mounted.pane), c1 = c0 + arm.travel, cy = n.textCy as number;
			// The travelling arm opens its slop by CLOSING the spread, so its first frame is already a zoom-out: a kick that opens it
			// crosses above 100% on frame one, where the hold latches 5 px off (identical on 31b13737, not this claim).
			const rows = await call(page, "pinchPath", arm.to, 30, c0, c1, cy, "hold", arm.travel ? -20 : 0) as any[];
			const later = await call(page, "later", 400, "later") as any;
			const l = live(rows, n, c0, c1, 30), settled = rows.at(-1);
			record.push({ arm: arm.name, c0, c1, natural: n, rows, later, errors });
			// eslint-disable-next-line no-console
			console.log("RLLFOCAL " + JSON.stringify({ arm: arm.name, c0: r2(c0), c1: r2(c1), naturalTextLeft: n.textLeft, maxMiss: r2(l.maxMiss), previewFrames: l.previewFrames, scrollMoved: l.scrollMoved,
				last: l.frames.at(-1), settledTextLeft: settled.textLeft, settledPanX: settled.panX, settledScrollLeft: settled.scrollLeft, laterTextLeft: later.textLeft, naturalRestMiss: restMiss(n), laterRestMiss: restMiss(later), columnLocal: settled.columnLocal,
				viewLeft: settled.viewLeft, viewRight: settled.viewRight, contentLeft: settled.contentLeft, contentRight: settled.contentRight }));
			expect(errors).toEqual([]);
			expect(settled.k, "the gesture reached its scale").toBeCloseTo(arm.to, 2);
			// LIVENESS: frames were staged with the preview up, and the gesture moved the text.
			expect(l.previewFrames, "preview frames staged").toBeGreaterThanOrEqual(27);
			expect(Math.max(...rows.map((r: any) => Math.abs(r.textLeft - n.textLeft))), "the gesture moved the text").toBeGreaterThan(10);
			// THE PREMISE: the held column stays inside the pane on every frame, so no bound excuses a miss here.
			// Read off the LINE BOX, for the same reason `restMiss` is: `.cm-content` is the column only under a theme
			// that caps it. Under Minimal it is the whole pane, and a premise measured there says "this column cannot
			// fit" at every zoom above 1 - a false premise that would have failed the arm on the harness's arithmetic
			// rather than on the product's behaviour.
			for (const f of l.frames) {
				const width = (n.lineRight - n.lineLeft) * f.k, left = f.expected - (n.textLeft - n.lineLeft) * f.k;
				expect(left >= settled.viewLeft - 0.5 && left + width <= settled.viewRight + 0.5, `premise: the held column fits the pane at k ${f.k}`).toBe(true);
			}
			expect(l.maxMiss, "the text line against the focal hold on the worst preview frame, px").toBeLessThanOrEqual(LIVE_TOL_PX);
			expect(l.scrollMoved, "no preview frame wrote the scroll, px").toBe(0);
			// THE SETTLE: drag or zoom, the column returns to its rest, the bounce carrying the correction.
			expect(Math.abs(restMiss(n)), "premise: the natural 100% frame is at rest, px").toBeLessThanOrEqual(0.5);
			expect(settled.columnLocal, "premise: the column has an inset to centre in").toBeGreaterThan(0);
			expect(later.bounce?.active ?? false, "the bounce has ended").toBe(false);
			expect(Math.abs(leftMiss(later)), "the column is back on its own margin once the bounce ends, px").toBeLessThanOrEqual(LIVE_TOL_PX);
			expect(later.scrollLeft, "with no sideways scroll").toBe(0);
			// THE REST IS THE COLUMN'S OWN MARGIN, not a pan standing on the sizer: a pan at rest costs on every per-frame
			// path that assumes none (measured, a scroll frame at 25% with the setting on ran 4.5 -> 5.9 ms against 1.4.19).
			expectRestCarried(later, "the rest");
		} finally { await page.close(); }
	}, 180_000);
}

/**
 * MAXZOOM-6 (Fleet 3 c3, candidate 5): the ceiling moved from 4 to 6 tonight (PinchScale.ts's
 * MAX_PINCH_SCALE), so this carries the array's own "zoom-in about the text's start" arm all the
 * way to the new ceiling instead of stopping at 150%.
 *
 * MEASURED FIRST (this arm, before writing it): the RLL_ARMS loop's "premise: the held column
 * fits the pane" holds only up to about k=1.5-1.7 on this fixture - a fact about this column's
 * width against the PANE_W=1397.5 pane, already true well under the OLD 4x ceiling, and not
 * something the ceiling raise created. Past that point the centred hold legitimately hands off to
 * the column's frozen-margin (left-edge) anchor - a different, pre-existing regime, not a
 * divergence. So the strict 1 px focal-hold bound is asserted only where its premise holds (the
 * fitting prefix of the ramp); what the WHOLE gesture must still do, fitting or not, is reach the
 * real ceiling, write no preview scroll, and settle cleanly with a finite native scroll position -
 * which is the actual candidate-5 claim ("settles at 600% with no jump, scrollLeft/scrollTop both
 * finite"), proven directly rather than through a premise that cannot hold this far out.
 *
 * THE PLANT (Fleet 3's own): leave the ceiling at 4 anywhere among the four call sites
 * (PinchScale.ts's MAX_PINCH_SCALE, or either InkOverlay.ts guard, or MobileTools.ts's button) and
 * this reddens on its own first assertion - the gesture settles at 400%, not 600%.
 */
it("the lift SLIDES the 111.25 px hold home, no jump (Alan 2026-09-21, the slide is in 1.4.20; supersedes the ruling): RLL on, zoom-in to 600% about the text's start: the held column stays under the fingers while it fits the pane, reaches the real ceiling, and lands on its margin at the lift on a finite scroll", async () => {
	const { page, errors, mounted, n } = await open(true, "hold-600");
	try {
		const c0 = n.textLeft + 40, cy = n.textCy as number;
		const rows = await call(page, "pinchPath", 6, 30, c0, c0, cy, "hold600", 0) as any[];
		const later = await call(page, "later", 400, "later") as any;
		const l = live(rows, n, c0, c0, 30), settled = rows.at(-1), lastPreview = rows[30], firstSettle = rows[31];
		// THE LINE BOX, not `.cm-content`. Under a theme that centres its own lines the content box is the
		// whole scroller, so a ramp frame never "fits the pane" by it and the premise below picks an empty set - eleven
		// Minimal reds, one of them this cell's. The line is the column under both themes, which is what the premise means.
		const fits = (f: (typeof l.frames)[number]) => {
			const width = (n.lineRight - n.lineLeft) * f.k, left = f.expected - (n.textLeft - n.lineLeft) * f.k;
			return left >= settled.viewLeft - 0.5 && left + width <= settled.viewRight + 0.5;
		};
		const fitting = l.frames.filter(fits);
		const maxMissFitting = fitting.length ? Math.max(...fitting.map(f => Math.abs(f.miss))) : Number.NaN;
		record.push({ arm: "zoom-in to 600% about the text's start", c0, natural: n, rows, later, errors });
		// eslint-disable-next-line no-console
		console.log("RLLFOCAL-600 " + JSON.stringify({ c0: r2(c0), naturalTextLeft: n.textLeft, previewFrames: l.previewFrames, fittingFrames: fitting.length, maxMissFitting: r2(maxMissFitting),
			scrollMoved: l.scrollMoved, last: l.frames.at(-1), firstSettleTextLeft: firstSettle.textLeft, lastPreviewTextLeft: lastPreview.textLeft, settledTextLeft: settled.textLeft, settledPanX: settled.panX, easeStartedAt: firstSettle.bounce?.active ?? null, settledScrollLeft: settled.scrollLeft, settledScrollTop: settled.scrollTop,
			laterScrollLeft: later.scrollLeft, laterScrollTop: later.scrollTop, laterBounceActive: later.bounce?.active ?? null }));
		expect(errors).toEqual([]);
		// THE PLANT CATCHES HERE FIRST: at the old ceiling this gesture settles at k=4, not 6.
		expect(settled.k, "the gesture reached the new ceiling, not the old one").toBeCloseTo(6, 2);
		expect(l.previewFrames, "preview frames staged").toBeGreaterThanOrEqual(27);
		// THE PREMISE: some prefix of the ramp still fits the pane, so the strict bound is
		// exercised on real frames and not vacuously satisfied by an empty set.
		expect(fitting.length, "premise: the ramp's early frames still fit the pane").toBeGreaterThan(0);
		expect(maxMissFitting, "the text line against the focal hold, on the frames that still fit the pane, px").toBeLessThanOrEqual(LIVE_TOL_PX);
		expect(l.scrollMoved, "no preview frame wrote the scroll, px").toBe(0);
		// THE SETTLE, as a later ruling shapes it (2026-09-18, after this row was written): the first frame
		// after the lift holds the text exactly where the last preview frame left it - no snap - and
		// then the page EASES onto the bound (the column's edge may not rest inside the pane, so the
		// positive pan the focal hold carried goes back to 0 through the bounce, never in one frame).
		// The old form read the text after that ease had finished and called the ease a jump: measured
		// at 4cedb14e, settle-1 0.00 px from the last preview frame, then 111.25 px eased over about
		// thirty frames at 6x; the same shape at 4x (203.25) and 2x (295.25) on the shipped base.
		// HISTORY: the ruling (2026-09-20) accepted an instant reset for 1.4.20 and this row pinned it for a day.
		// Alan, 2026-09-21, "i want it all in 1.4.20": THE SLIDE LANDED. The settle takes its painted capture under
		// the canvas too, so the first frame after the lift paints the last preview's position and the pan the hold carried
		// goes home through the ease. Measured at d624596d: last preview 447.25 carrying panX 111.25, first settle 447.25,
		// ease active, rest 336.00. The rest is still DERIVED from the hold, not a pinned number.
		expect(Math.abs(lastPreview.panX), "premise: the hold really was carrying a pan to give back, px").toBeGreaterThan(LIVE_TOL_PX);
		expect(Math.abs(firstSettle.textLeft - lastPreview.textLeft), "no jump between the last preview frame and the first frame after the lift, px").toBeLessThanOrEqual(1);
		expect(Math.abs(settled.textLeft - (lastPreview.textLeft - lastPreview.panX)), "the rest gives back exactly the pan the hold carried, px").toBeLessThanOrEqual(LIVE_TOL_PX);
		expect(firstSettle.bounce?.active ?? false, "the correction is handed to the ease at the lift").toBe(true);
		expect(settled.panX, "the page comes to rest on the bound: pan 0, the column's edge at the pane's").toBe(0);
		expect(Number.isFinite(settled.scrollLeft) && Number.isFinite(settled.scrollTop), "scrollLeft/scrollTop are both finite at the settle").toBe(true);
		expect(Number.isFinite(later.scrollLeft) && Number.isFinite(later.scrollTop), "scrollLeft/scrollTop stay finite once the bounce (if any) ends").toBe(true);
		expect(later.bounce?.active ?? false, "the bounce has ended").toBe(false);
	} finally { await page.close(); }
}, 180_000);

/**
 * OUT, THEN BACK IN about the same point: the zoom-in Alan saw "go out to the right". Held both ways, and back at 100% the
 * column is where it started, with no sideways room left behind. Measured first on 31b13737: the zoom-in's preview carried
 * the text to x -370, and the settle moved it 676 px to 341 px left of where it began, granting 200 px of sideways room.
 * The lift may still move the column by the rest's own correction: the pane's centre is not the column's centre (the
 * scrollbar gutter), so a hold about it lands a few px off rest and the bounce takes it home.
 */
it("a round trip about one focal point does NOT come back, and that is the design: it lands 2096.25 px left, parked in the room the canvas granted: RLL on, zoom-out to 25% and back to 100% about the pane's centre, held both ways", async () => {
	const { page, errors, mounted, n } = await open(true, "round");
	try {
		const c = mounted.pane.left + mounted.pane.width / 2, cy = n.textCy as number;
		const out = await call(page, "pinch", 0.25, 30, c, cy, "out") as any[];
		const outSettled = out.at(-1);
		const back = await call(page, "pinch", 1, 30, c, cy, "in") as any[];
		const later = await call(page, "later", 400, "later") as any;
		const lo = live(out, n, c, c, 30), li = live(back, outSettled, c, c, 30), settled = back.at(-1), lastPreview = back[30], firstSettle = back[31];
		record.push({ arm: "round", c, natural: n, out, back, later, errors });
		// eslint-disable-next-line no-console
		console.log("RLLFOCAL-ROUND " + JSON.stringify({ c: r2(c), naturalTextLeft: n.textLeft, outMaxMiss: r2(lo.maxMiss), outSettledTextLeft: outSettled.textLeft, inMaxMiss: r2(li.maxMiss),
			lastPreviewTextLeft: lastPreview.textLeft, settledTextLeft: settled.textLeft, liftMoved: r2(settled.textLeft - lastPreview.textLeft), laterTextLeft: later.textLeft,
			settledScrollLeft: settled.scrollLeft, rangeX: settled.rangeX, panX: settled.panX, laterScrollLeft: later.scrollLeft, laterRangeX: later.rangeX, laterPanX: later.panX, lastPreviewRestMiss: restMiss(lastPreview),
			// The lift's own frame, so a red here hands review the three numbers the ruling asks for.
			firstSettleTextLeft: firstSettle?.textLeft ?? null, firstSettleBounce: firstSettle?.bounce?.active ?? null, firstSettlePanX: firstSettle?.panX ?? null }));
		expect(errors).toEqual([]);
		expect(outSettled.k, "out to 25%").toBeCloseTo(0.25, 3);
		expect(settled.k, "back to 100%").toBeCloseTo(1, 3);
		expect(lo.maxMiss, "zoom-out held, px").toBeLessThanOrEqual(LIVE_TOL_PX);
		// THE COLUMN NOW RESTS AT ITS OWN MARGIN AT 25%, not centred, so the pane's centre sits 2454 host px into the
		// blank beside it. Holding that point under the fingers back to 100% would carry the column 1840 px off the pane;
		// the constraint reducer's visibility floor (PAN_MIN_VISIBLE_PX, 24 px of the page kept inside the pane) refuses
		// the part that would, exactly as it already did for a full-width page with the setting off. So each zoom-in
		// preview frame is either held under the fingers OR pinned with the page's right edge 24 px inside the pane.
		for (const r of back.slice(1, 31)) {
			if (!r.preview) continue;
			// The pinned term reads the LINE box's right edge, for the reason the fit predicate above does -
			// `.cm-content` is the whole scroller under a theme that centres its own lines, so the floor it measured there
			// was never the page's edge and no frame could satisfy this branch.
			const miss = Math.abs(r.textLeft - held(outSettled, c, c, r.k)), pinned = Math.abs(r.lineRight - r.viewLeft - 24);
			expect(Math.min(miss, pinned), `zoom-in frame at k ${r2(r.k)}: neither held under the fingers (miss ${r2(miss)} px) nor pinned at the pane's visibility floor (${r2(pinned)} px off it)`).toBeLessThanOrEqual(LIVE_TOL_PX);
		}
		expect(Math.abs(settled.textLeft - lastPreview.textLeft), "the lift moves the column by no more than the rest's correction, px").toBeLessThanOrEqual(Math.abs(restMiss(lastPreview)) + LIVE_TOL_PX);
		// WHAT THAT CORRECTION IS MADE OF, which this cell never read. The bound above is
		// restMiss-relative, so a correction of any size passes it: measured, the lift moves the column 991.25 px
		// under Minimal and 1017.25 px under Obsidian's own theme, both at 1cd3f8c3, because the zoom-in leg's
		// preview is pinned at the visibility floor with the words off the pane's left edge and the lift brings the
		// page home. A correction that size is the contract only if it is EASED. So the same two claims the 600%
		// cell makes at its lift are made here: the first frame after the lift is where the last preview frame left
		// the column, and the correction is handed to the bounce rather than paid in one frame.
		expect(Math.abs(firstSettle.textLeft - lastPreview.textLeft), "no jump between the last preview frame and the first frame after the lift, px").toBeLessThanOrEqual(1);
		// C: THE EASE CLAIM IS OWED ONLY WHERE THE PAGE TRAVELS. A later ruling rewrote this cell after the line above was
		// written: the round trip now parks in the room the canvas granted and the lift moves nothing (measured at d624596d,
		// both themes: last preview, first settle, settled and later identical, bounce inactive). A page already at its rest owes
		// no correction, so there is no ease to hand one to. Where it does travel to its rest, that travel is eased.
		const owedTravel = Math.abs(later.textLeft - lastPreview.textLeft);
		if (owedTravel > 1) expect(firstSettle.bounce?.active ?? false, `the ${r2(owedTravel)} px correction is handed to the ease at the lift`).toBe(true);
		else expect(firstSettle.bounce?.active ?? false, "nothing is owed at the lift, so no ease starts").toBe(false);
		expect(later.bounce?.active ?? false, "the bounce has ended").toBe(false);
		// Same ruling as RoundTripRoom's twin cell, same number, derived the same way. The column
		// does not come back; its whole displacement is the scroll the settle parked plus the standing pan.
		// Measured at f3dc4420: natural 647.25, later -1449.00, scrollLeft 2096, panX -0.25, room 9967.
		expect(later.scrollLeft, "the settle parked a sideways scroll in the granted room").toBeGreaterThan(0);
		expect(later.rangeX, "and the room it parked in is the canvas's own grant").toBeGreaterThanOrEqual(later.scrollLeft);
		expect(Math.abs(later.textLeft - (n.textLeft - later.scrollLeft + later.panX)), "the displacement is the parked scroll plus the standing pan, and nothing else, px").toBeLessThanOrEqual(LIVE_TOL_PX);
		expect(Math.abs(later.textLeft - n.textLeft), "and it does NOT return: it lands left of where it stood, px").toBeGreaterThan(LIVE_TOL_PX);
		// Option (b): this cell no longer calls expectRestCarried. Half of that helper is
		// overturned here - it asserts nothing is scrolled into the room, and under the canvas the settle
		// parks 2096 px of scroll there on purpose, which the rows above now state. Its OTHER half still
		// holds and is kept inline: the rest is the column's margin, with no pan standing at rest.
		// The helper and its three other callers are untouched.
		expect(Math.abs(later.panX), `back at 100%: the rest is the column's margin (${restCarrier(later)}), no pan (panX ${later.panX})`).toBeLessThanOrEqual(0.5);
		// REPLACED. "No sideways scroll left behind" was the canvas-off room contract; under the
		// canvas the settle parks in granted room on purpose, which is what the rows above now assert.
		// What still has to hold is that the scroll it parked is REACHABLE room and not past the end.
		expect(later.scrollLeft, "the parked scroll is inside the room, not past its end").toBeLessThanOrEqual(later.rangeX);
		// NOT ASSERTED: the zoom-in's own writing-room claim still grants 200 px of sideways room here, as it did on 1.4.19
		// and 31b13737; at scroll 0 with the column at rest it shows nothing, and giving it back is T2's shrink, not this.
		// REPLACED. This row asked that the column comes to rest on Obsidian's own margin
		// after the trip, which is the canvas-off rest law; it read 2096.25 px off that margin. Under the
		// canvas the settle parks in granted room on purpose, and where the column ends is already the
		// claim three rows above: the displacement is the parked scroll plus the standing pan and nothing
		// else. The margin is still printed in RLLFOCAL-ROUND, so a change in it stays on the record.
	} finally { await page.close(); }
}, 180_000);

/**
 * THE CONTROL, Readable line length OFF: the column fills the pane at 100%, its left edge is the note's origin edge, and a
 * zoom-out at scroll 0 keeps it there as it always has - no pan, the text scaling toward the pane's left edge. Green before
 * and after the fix; a fix that let the page leave its origin edge with the setting off reddens it.
 */
it("RLL off, zoom-out to 25% about the pane's centre: unchanged, no pan and the page anchored at its origin edge", async () => {
	const { page, errors, mounted, n } = await open(false, "control");
	try {
		const c = mounted.pane.left + mounted.pane.width / 2, cy = n.textCy as number;
		const rows = await call(page, "pinch", 0.25, 30, c, cy, "control") as any[];
		const later = await call(page, "later", 400, "later") as any;
		const frames = rows.slice(1, 31), settled = rows.at(-1);
		const anchored = (r: any) => r2(r.textLeft - (n.viewLeft + (n.textLeft - n.viewLeft) * r.k));
		record.push({ arm: "control", c, natural: n, rows, later, errors });
		// eslint-disable-next-line no-console
		console.log("RLLFOCAL-CONTROL " + JSON.stringify({ columnLocal: settled.columnLocal, naturalTextLeft: n.textLeft, viewLeft: n.viewLeft, maxPanX: Math.max(...frames.map((r: any) => Math.abs(r.panX))),
			maxAnchorMiss: Math.max(...frames.map((r: any) => Math.abs(anchored(r)))), settledTextLeft: settled.textLeft, settledAnchorMiss: anchored(settled), laterTextLeft: later.textLeft }));
		expect(errors).toEqual([]);
		expect(settled.k).toBeCloseTo(0.25, 3);
		expect(settled.columnLocal, "premise: no column inset with the setting off").toBe(0);
		// THE SAME LIVE PIN, on x with the setting off. "No preview pan" was the earlier law: with the
		// fingers down the page follows them, and whether it took pan to do so is not the promise - where
		// the page ENDED UP is. The arm already measures that: `anchored` is the text against the focal
		// law, so the hold is what gets asserted and the pan term is left to the readout.
		// THE HOLD, AGAINST THE FINGERS - which is a different reference from `anchored` above, and that
		// distinction is the whole of this pin. `anchored` measures the text against the ORIGIN edge, so it
		// reads the hold as drift: 524.06 px by k = 0.25. Measured against the FOCAL POINT, the same frames
		// read 0.000 - to eight decimal places at every k this arm samples, 1.0 down to 0.25. The page is
		// exactly under the fingers the whole way out, which is the ruling and carries no setting qualifier.
		// So "no preview pan" was the live edge pin wearing a different hat: the pan is HOW the hold is
		// paid, and forbidding it forbids the hold. The pan stays in the readout; the hold is the claim.
		const heldAtFocal = (r: any) => r2(r.textLeft - (c + (n.textLeft - c) * r.k));
		expect(Math.max(...frames.map((r: any) => Math.abs(heldAtFocal(r)))), "the text holds under the fingers with the setting off, px").toBeLessThanOrEqual(0.5);
		// AND THE SETTLE RETURNS IT to the origin edge with the pan given back, which is where this arm's
		// own name comes from and what its remaining assertions below already check.
		expect(Math.abs(settled.panX), "and the settle gives the pan back, px").toBeLessThanOrEqual(0.5);
		// THE ORIGIN-EDGE CLAIM IS THE SETTLE'S, not the preview's - the second half of the same pin. Over
		// the live frames it is the origin reference reading the hold as drift, 524.06 px by k = 0.25, and
		// that is the page doing what the design asks. Where it IS true is at the settle, which returns the
		// page to the origin edge and gives the pan back: measured 0.000 on every sample after the lift,
		// against 524.06 on the last preview frame. `later` below already carries the same claim 400 ms on.
		expect(Math.abs(anchored(settled)), "the settle scales the text toward the origin edge, px").toBeLessThanOrEqual(0.5);
		expect(Math.abs(anchored(later)), "and stays there, px").toBeLessThanOrEqual(0.5);
	} finally { await page.close(); }
}, 180_000);

/**
 * MAXZOOM-6 (Fleet 3 c3, candidate 5), RLL OFF: zooming IN needs the same focal-hold-via-pan
 * `held()`/`live()` check the RLL-on arms use, not the zoom-OUT control's "no pan, anchored to the
 * origin edge" claim above - that claim is specific to zooming OUT, which never needs more of the
 * page than already fits; zooming in to 600% about an off-centre point needs exactly the same kind
 * of reach RLL-on's column-recentring does, just with no column to recentre (columnLocal stays 0).
 * MEASURED FIRST: with RLL off the unwrapped content is already close to the pane's own width at
 * 100%, so the "fits the pane" premise (see the RLL-on 600% arm above) does not survive even the
 * first frame here - the fitting-prefix strict bound would be vacuous, so this arm asserts what
 * holds unconditionally instead: the ceiling reached, no preview scroll, a clean settle with a
 * finite native scroll position, and no column inset materialising with the setting off.
 */
it("RLL off, zoom-in to 600% about the text's start: no column materialises, and the gesture reaches the real ceiling and settles with no jump on a finite scroll", async () => {
	const { page, errors, mounted, n } = await open(false, "hold-600-off");
	try {
		const c0 = n.textLeft + 40, cy = n.textCy as number;
		const rows = await call(page, "pinchPath", 6, 30, c0, c0, cy, "hold600off", 0) as any[];
		const later = await call(page, "later", 400, "later") as any;
		const l = live(rows, n, c0, c0, 30), settled = rows.at(-1), lastPreview = rows[30];
		record.push({ arm: "RLL off, zoom-in to 600%", c0, natural: n, rows, later, errors });
		// eslint-disable-next-line no-console
		console.log("RLLFOCAL-600-OFF " + JSON.stringify({ c0: r2(c0), naturalTextLeft: n.textLeft, previewFrames: l.previewFrames, scrollMoved: l.scrollMoved, last: l.frames.at(-1),
			settledTextLeft: settled.textLeft, lastPreviewTextLeft: lastPreview.textLeft, settledScrollLeft: settled.scrollLeft, settledScrollTop: settled.scrollTop,
			laterScrollLeft: later.scrollLeft, laterScrollTop: later.scrollTop, laterBounceActive: later.bounce?.active ?? null, columnLocal: settled.columnLocal }));
		expect(errors).toEqual([]);
		// THE PLANT CATCHES HERE FIRST: at the old ceiling this gesture settles at k=4, not 6.
		expect(settled.k, "the gesture reached the new ceiling, not the old one").toBeCloseTo(6, 2);
		expect(l.previewFrames, "preview frames staged").toBeGreaterThanOrEqual(27);
		expect(settled.columnLocal, "premise: no column inset materialises with the setting off").toBe(0);
		expect(l.scrollMoved, "no preview frame wrote the scroll, px").toBe(0);
		expect(Math.abs(settled.textLeft - lastPreview.textLeft), "no jump between the last preview frame and the settle, px").toBeLessThanOrEqual(5);
		expect(Number.isFinite(settled.scrollLeft) && Number.isFinite(settled.scrollTop), "scrollLeft/scrollTop are both finite at the settle").toBe(true);
		expect(Number.isFinite(later.scrollLeft) && Number.isFinite(later.scrollTop), "scrollLeft/scrollTop stay finite once the bounce (if any) ends").toBe(true);
		expect(later.bounce?.active ?? false, "the bounce has ended").toBe(false);
	} finally { await page.close(); }
}, 180_000);

/**
 * THE Y AXIS, one arm decides: the preview's y pan has the same cap at scroll 0 (the content-top inset), and the
 * treatment applies to a FITTING axis. So the arm looks for one on the shortest notes there are - one line and twelve with
 * no ink, twelve with ink - both settings, zoomed out to 50% and to 10% about a point below the text, reading the overlay's
 * own vertical fit (panFitReadout, the quantity the settle's window decides on) on every preview frame and at the settle.
 *
 * READ (M, on the fix with the y cap raised the same way): blank notes fit on every preview frame and the text held within
 * 0.65 px - then jumped back by the whole hold at the lift (-66 / -119 px on one line at 50% / 10%, -138 / -248.56 on
 * twelve), because the settle grants the zoomed-out writing room below the text and the page stops fitting (a one-line
 * note's height 12 -> 1536 painted px at 50%). A note with ink carries that room already and fits on no frame at 50%.
 * So y keeps its cap (for 1.4.20; a settle back to the top waits on Alan's word). THE PINS: fitting
 * preview frames exist on the blank notes, so this arm does reach the case; the settle stops the fit there; and the page
 * takes no y pan and does not move vertically at the lift.
 *
 * KNOWN, PINNED AS-IS for 1.4.20: this is a characterisation of a pre-existing defect, not a contract. The vertical preview hold is
 * capped at scroll 0 on fitting blank notes: the text drifts up off the fingers mid-pinch, up to about 250 px at low zoom.
 * FLIP CONDITION: a y fix that holds the page on fitting frames (and settles without the lift jump, e.g. by deciding the
 * fit with the writing room the settle will grant) turns "no y pan" red on the blank shapes. Those reds are that fix's
 * expected reds, not regressions; rewrite this arm to the hold then.
 */
const Y_SHAPES = [
	{ lines: 1, noInk: true, to: 0.5 }, { lines: 1, noInk: true, to: 0.1 },
	{ lines: 12, noInk: true, to: 0.5 }, { lines: 12, noInk: true, to: 0.1 },
	{ lines: 12, noInk: false, to: 0.5 }, { lines: 12, noInk: false, to: 0.1 },
] as const;
for (const readable of [true, false]) {
	it(`Y, RLL ${readable ? "on" : "off"}, KNOWN (pinned as-is): the vertical preview hold is capped at scroll 0 on fitting blank notes, and nothing jumps at the lift`, async () => {
		const readouts: any[] = [];
		for (const shape of Y_SHAPES) {
			const { page, errors, mounted, n } = await open(readable, `y-${shape.lines}-${shape.noInk ? "blank" : "ink"}-${shape.to}`, shape.lines, shape.noInk);
			try {
				const c = mounted.pane.left + mounted.pane.width / 2, fy = (n.textCy as number) + 120;
				const rows = await call(page, "pinch", shape.to, 30, c, fy, "y") as any[];
				const preview = rows.slice(1, 31).filter((r: any) => r.preview), lastPreview = preview.at(-1), settled = rows.at(-1);
				const missY = (r: any) => r2(r.textCy - (fy + (n.textCy - fy) * r.k));
				const fitting = preview.filter((r: any) => r.fitReadout?.fitsY === true);
				const line = { ...shape, previewFrames: preview.length, fittingFrames: fitting.length, worstFittingMissY: r2(Math.max(0, ...fitting.map((r: any) => Math.abs(missY(r))))),
					lastPreviewContentY: lastPreview?.fitReadout?.contentY, settledContentY: settled.fitReadout?.contentY, viewportY: settled.fitReadout?.viewportY, settledFitsY: settled.fitReadout?.fitsY,
					maxPanY: Math.max(...rows.map((r: any) => Math.abs(r.panY))), liftMovedY: r2(settled.textCy - lastPreview.textCy), errors };
				readouts.push(line);
				record.push({ arm: "y-" + readable, shape, fy, natural: n, rows });
				expect(errors).toEqual([]);
				expect(settled.k, "the zoom reached its scale").toBeCloseTo(shape.to, 3);
				// under the canvas a blank note never "fits" its pane while the fingers are down -
				// the grant is there from the start, so no preview frame reports fitsY and the old premise
				// (more than 20 fitting frames) reads 0. The hold itself is what this arm is for, so it is
				// asked of EVERY preview frame instead of the fitting subset, which is the stricter form.
				expect(preview.length, `premise, ${shape.lines} line(s) to ${shape.to}: the gesture previewed`).toBeGreaterThan(20);
				// THE MECHANISM, under the theme it was measured on. The settle grants zoomed-out writing room below the
				// text and the page stops fitting - a one-line note's height 12 -> 1536 painted px at 50% on Obsidian's
				// own theme. Minimal gives its lines different heights and padding, so a one-line note there can still
				// fit after the room is granted; that is a different number for the same pre-existing defect, not a
				// second defect, and it is recorded in the readout either way. THE CLAIMS BELOW hold under both.
				if (fitting.length && THEME === "default") expect(settled.fitReadout?.fitsY, `${shape.lines} line(s) to ${shape.to}: the settle's writing room stops the fit`).toBe(false);
				// THE FLIP CONDITION ABOVE HAS FIRED, and this is the rewrite it asks for. That note says a y
				// fix which holds the page on fitting frames "turns `no y pan` red on the blank shapes", that
				// those reds are the fix's expected reds rather than regressions, and to rewrite this arm to
				// the hold then. The fix landed: the vertical edge cap became settle-only, so with the fingers
				// down the page follows them on y as it already did on x. Measured here, `no y pan` reads
				// 65.75 px on one blank line at 50%, which is the hold doing its job.
				// So the arm asks the hold's own question instead, on the quantity it already computes: on the
				// frames that fit, the text stays under the fingers. That is a STRICTER statement than the one
				// it replaces - "took no pan" was satisfied by a page that sat still while the fingers moved.
				const worstPreviewMissY = r2(Math.max(0, ...preview.map((r: any) => Math.abs(missY(r)))));
				expect(worstPreviewMissY, `${shape.lines} line(s) to ${shape.to}: the text holds under the fingers on every preview frame, px`).toBeLessThanOrEqual(LIVE_TOL_PX);
				// THE LIFT CARRIES THE CLOSE, which is the candidate's shape on both axes: the edge closes in
				// the frame of the lift rather than over an ease, so "nothing moves vertically at the lift" cannot
				// hold once the preview is allowed to move at all. What the lift owes is the hold that stood on
				// the last preview frame, given back - measured 65.75 px on one blank line at 50%, against a
				// preview pan of the same size.
				expect(Math.abs(line.liftMovedY + (lastPreview?.panY ?? 0)), `${shape.lines} line(s) to ${shape.to}: the lift gives back exactly the hold that stood (pan ${r2(lastPreview?.panY ?? 0)}, moved ${line.liftMovedY})`).toBeLessThanOrEqual(LIVE_TOL_PX);
			} finally { await page.close(); }
		}
		// eslint-disable-next-line no-console
		console.log("RLLFOCAL-Y " + JSON.stringify({ readable, readouts }));
	}, 360_000);
}

/**
 * NO GESTURE: the rest holds at every zoom, not only after a pinch. The zoom buttons, Ctrl+scroll
 * and Fit commit the scale with no gesture; with the setting on they land the centred column on its rest, so the first
 * touch afterwards has nothing to correct. Measured first by reading the source, then here: before, a button zoom-out left
 * the column at the frozen margin and the next touch's settle bounced it to centre.
 */
it("NO GESTURE, RLL on: the zoom button to 50% lands the column on its margin, and the touch after it leaves the column where it left it", async () => {
	const { page, errors, mounted, n } = await open(true, "button");
	try {
		const z = await call(page, "zoomBy", 0.5) as any;
		const c = mounted.pane.left + mounted.pane.width / 2, cy = n.textCy as number;
		// The next touch: a two-finger contact that barely moves, lifted where it began.
		const touch = await call(page, "pinchPath", z.row.k * 1.02, 6, c, c, cy, "touch", 20) as any[];
		const later = await call(page, "later", 400, "later") as any;
		const bounced = touch.some((r: any) => r.bounce && r.bounce.active);
		record.push({ arm: "button", natural: n, zoomed: z, touch, later, errors });
		// eslint-disable-next-line no-console
		console.log("RLLFOCAL-BUTTON " + JSON.stringify({ ownLines: z.row.ownLines, ownLinesClass: z.row.ownLinesClass, contentLocalW: z.row.contentLocalW, scrollerLocalW: z.row.scrollerLocalW, ok: z.ok, k: z.row.k, restMiss: restMiss(z.row), panX: z.row.panX, scrollLeft: z.row.scrollLeft, bounced, laterRestMiss: restMiss(later), laterK: later.k }));
		expect(errors).toEqual([]);
		expect(z.ok, "the button zoomed").toBe(true);
		expect(z.row.k, "to 50%").toBeCloseTo(0.5, 3);
		expect(Math.abs(leftMiss(z.row)), `the column lands on Obsidian's own margin, scaled, with no gesture, px (read ${leftMiss(z.row)})`).toBeLessThanOrEqual(LIVE_TOL_PX);
		expectRestCarried(z.row, "the button's rest");
		// The touch is a 2 percent pinch about the pane's centre, so it moves the column off its margin by a few px
		// while the fingers are down; with no centred rest to absorb that, the lift returns it to the margin through the
		// bounce. The claim is the
		// landing, not the absence of the ease.
		record.push({ arm: "button-bounced", bounced });
		expect(later.bounce?.active ?? false, "the return has ended").toBe(false);
		// there is no centred rest to come back to under the canvas (the page stays
		// where the fingers left it, no centring), so the old row - the column back on its margin
		// after the touch - is the canvas-off law. Measured at aa437ff1 it reads 14.01 px off that
		// margin. The canvas claim is the stricter one this rig can make: the lift leaves the column
		// where the last preview frame had it.
		const touchPreview = touch.filter((r: any) => r.preview).at(-1) ?? touch.at(-1);
		expect(Math.abs(leftMiss(later) - leftMiss(touchPreview)), "the lift leaves the column where the touch left it, px").toBeLessThanOrEqual(LIVE_TOL_PX);
	} finally { await page.close(); }
}, 180_000);

it("NO GESTURE, RLL off: the zoom button to 50% is unchanged, no pan and the page at its origin edge", async () => {
	const { page, errors, n } = await open(false, "button-off");
	try {
		const z = await call(page, "zoomBy", 0.5) as any;
		record.push({ arm: "button-off", natural: n, zoomed: z, errors });
		expect(errors).toEqual([]);
		expect(z.row.k).toBeCloseTo(0.5, 3);
		expect(Math.abs(z.row.panX), "no pan with the setting off, px").toBeLessThanOrEqual(0.5);
		expect(Math.abs(z.row.textLeft - (n.viewLeft + (n.textLeft - n.viewLeft) * z.row.k)), "the text scales toward the origin edge, px").toBeLessThanOrEqual(0.5);
	} finally { await page.close(); }
}, 180_000);

/**
 * AND IT SURVIVES CODEMIRROR. The host's `class` attribute is CodeMirror's, not the overlay's: `updateAttrs` writes it
 * whole from the `editorAttributes` facet on every view update, so a token the overlay only adds imperatively lives
 * until the next update and no longer. Measured on 88ddc5bd: the button's commit added the own-lines token (traced,
 * one `applyViewportBox` call, token present straight after it), CodeMirror's next update set
 * `class="cm-editor ... handwriting-note-viewport"` over it, the `.cm-content` width pin came back on, and the column
 * stayed 345.5 px off its centred rest - the same number as with no part 49 (c) code at all. A pinch hid it, because a
 * preview re-runs the box write every frame and its last write lands after the update.
 *
 * These two arms are the regime the commit paths share with every other path: a commit, then an ordinary view update
 * (a keystroke) or a pane resize. THE CLAIM IS THEME-INDEPENDENT - the token matches the measured fact, and the column
 * is at its rest - so both themes assert it; the content-box claim is read only where the theme centres its own lines.
 */
for (const after of [{ name: "a keystroke", call: ["update", "after-update"] }, { name: "a pane resize", call: ["resizePane", -120] }] as const) {
	it(`NO GESTURE, RLL on: ${after.name} after the button commit leaves the column on its rest`, async () => {
		const { page, errors, n } = await open(true, "button-" + after.call[0]);
		try {
			const z = await call(page, "zoomBy", 0.5) as any;
			const u = await call(page, after.call[0] as string, after.call[1]) as any;
			record.push({ arm: "button-" + after.call[0], zoomed: z, after: u, errors });
			// eslint-disable-next-line no-console
			console.log("RLLFOCAL-AFTER " + JSON.stringify({ after: after.name, k: u.k,
				commit: { restMiss: restMiss(z.row), cls: z.row.ownLinesClass, own: z.row.ownLines, contentLocalW: z.row.contentLocalW, scrollerLocalW: z.row.scrollerLocalW },
				later: { restMiss: restMiss(u), cls: u.ownLinesClass, own: u.ownLines, contentLocalW: u.contentLocalW, scrollerLocalW: u.scrollerLocalW, panX: u.panX, scrollLeft: u.scrollLeft } }));
			expect(errors).toEqual([]);
			expect(z.ok, "premise: the button zoomed").toBe(true);
			// THE TOKEN IS THE MEASURED FACT, at the commit and after it. Under Obsidian's own theme both are false and
			// this asserts that the overlay does not scope its freeze off where the freeze is what centres the column.
			expect(z.row.ownLinesClass, "the commit's own frame carries the token its measurement asked for").toBe(z.row.ownLines);
			expect(u.ownLinesClass, `and ${after.name} does not take it off`).toBe(u.ownLines);
			// THE PIN ITSELF, where the theme centres its own lines: `.cm-content` fills the counter-sized scroller, which
			// is the room the theme re-centres the line in. Frozen, it stays at its 100% width and there is no room.
			if (u.ownLines) {
				expect(Math.abs(z.row.contentLocalW - z.row.scrollerLocalW), "the commit leaves the page its full width, local px").toBeLessThanOrEqual(2);
				expect(Math.abs(u.contentLocalW - u.scrollerLocalW), `and ${after.name} leaves it, local px`).toBeLessThanOrEqual(2);
			}
			expect(Math.abs(leftMiss(z.row)), `the commit lands the column on Obsidian's own margin, scaled, px (read ${leftMiss(z.row)})`).toBeLessThanOrEqual(LIVE_TOL_PX);
			expect(Math.abs(leftMiss(u)), `and it is still there after ${after.name}, px`).toBeLessThanOrEqual(LIVE_TOL_PX);
			expectRestCarried(u, `after ${after.name}`);
		} finally { await page.close(); }
	}, 180_000);
}

/**
 * FIT takes the same predicate. Ink inside the column, tall enough that Fit's scale leaves the column fitting the pane,
 * lands centred. Ink past the column's right edge that still fits at Fit's scale (measured: 1600 note px past it, 3000
 * tall, fits at 25%) lands no further right than keeps the whole page - and so the ink - inside the pane. Ink wide enough
 * that the page does not fit at Fit's scale keeps Fit's own framing, with no pan.
 * THE BOX IS THE GRANTED ONE (part 69): column plus surface extent, the same box every settle window uses, so Fit
 * and the settle agree. On a wide-room note under an own-lines theme that leaves a short stroke sitting well inside
 * the pane rather than snug to its edge - measured ~77 px. Fit's contract is that all ink is visible, not that it
 * is snug, and a box that matched the ink's tight bounds would disagree with the settle's.
 */
const FIT_ARMS = [
	{ name: "ink inside the column lands it centred", dx: 0, height: 3000, width: 0, expect: "centred" },
	{ name: "ink past the column that still fits keeps the page and its ink inside the pane", dx: 3000, height: 3000, width: 0, expect: "inside" },
	// RENAMED to what it now guards. It was written when the fit test asked the granted extent, ink room
	// and all, so a note with ink wider than its page did not fit at Fit's scale and the arm's subject was
	// Fit declining to reframe. The landing asks the PAGE box instead (the ruling: the fit test was being asked
	// of the wrong box), and that box fits - measured, contentX 1452.220 -> 1364.352 against a pane of
	// 1383.005, which crosses under it. So the arm's old subject no longer exists and its premise is false.
	// What it guards now is the other side of the same case: the page box fits, the ink does not, and Fit
	// frames the page rather than the ink.
	{ name: "ink wider than the page frames the page, with the ink overhanging", dx: 0, height: 200, width: 6000, expect: "unchanged" },
] as const;
for (const arm of FIT_ARMS) {
	it(`NO GESTURE, RLL on: Fit with ${arm.name}`, async () => {
		const { page, errors, n } = await open(true, "fit-" + arm.expect);
		try {
			const strokes = await call(page, "tallInk", arm.dx, arm.height, arm.width) as number;
			const f = await call(page, "fit") as any;
			record.push({ arm: "fit-" + arm.expect, natural: n, strokes, fit: f, errors });
			// eslint-disable-next-line no-console
			console.log("RLLFOCAL-FIT " + JSON.stringify({ inkPastPane: r2(f.row.inkRight - f.row.viewRight), rangeX: f.row.rangeX, ownLines: f.row.ownLines, ownLinesClass: f.row.ownLinesClass, contentLocalW: f.row.contentLocalW, scrollerLocalW: f.row.scrollerLocalW, arm: arm.expect, strokes, result: f.r, k: f.row.k, restMiss: restMiss(f.row), panX: f.row.panX, fitsX: f.row.fitReadout?.fitsX,
				contentX: f.row.fitReadout?.contentX, scrollLeft: f.row.scrollLeft, inkLeft: f.row.inkLeft, inkRight: f.row.inkRight, viewLeft: f.row.viewLeft, viewRight: f.row.viewRight, contentLeft: f.row.contentLeft }));
			expect(errors).toEqual([]);
			expect(strokes, "the synthetic stroke committed").toBe(2);
			expect(f.r, "Fit ran").toBe("fit");
			expect(f.row.k, "premise: Fit zoomed out").toBeLessThan(0.9);
			if (arm.expect === "unchanged") {
				expect(f.row.fitReadout?.fitsX, "premise: the PAGE box fits the pane at Fit's scale, whatever the ink does").toBe(true);
				// THE FITTING ARMS' OWN CONTRACT, on the part that applies here: the page box lands inside the
				// pane and the column inside its left edge, with no pan - Fit's framing is the scale, not a pan.
				expect(f.row.fitReadout?.contentX, "the page box lands inside the pane at Fit's scale")
					.toBeLessThanOrEqual((f.row.fitReadout?.viewportX ?? 0) + 0.5);
				// RED-FIRST, and deliberately left red. A page that FITS the pane must be placed inside it, and
				// this one is not: the column sits 55.69 px past the pane's left edge with 91.94 px spare on the
				// right, where centring would put it at about 309. At 10687534 it was inside, at 310.75. So the
				// screen loses the left 55.69 px of the column and 38.44 px of ink after a Fit press, and that is
				// not shipping unnoticed: this clause is the one that says so, and it stays until the placement is
				// fixed rather than being relaxed to match what the page currently does.
				expect(f.row.lineLeft, "and the column inside its left edge").toBeGreaterThanOrEqual(f.row.viewLeft - 0.5);
				expect(Math.abs(f.row.panX), "and Fit frames by scale, not by pan, px").toBeLessThanOrEqual(0.5);
				// WHERE THE PAGE ACTUALLY SITS, measured after the button-path rest landed. At Fit's scale,
				// k = 0.2192, with the standing scroll zeroed:
				//   column left  309.00 against the pane's  300.00   - inside, and where centring wants it
				//   ink left     326.33 against the pane's  300.00   - inside
				//   ink right   1670.33 against the pane's 1697.50   - inside, by 27.17 px
				// Before that fix the same arm put the column at 243.00, 57 px off the pane's left edge, with
				// the ink's left edge off with it - the margin held the centred rest while a scroll of 301.03
				// stood from before the press and nothing gave it back.
				// WHAT THIS ARM STILL DOES NOT CLAIM: that every ink pixel is inside the pane. It happens to be
				// true at this fixture's scale and is recorded above, but the arm's subject is ink WIDER than the
				// page, and at a wider ink or a different scale Fit cannot put all of it inside. The two fitting
				// arms above own that contract; this one owns the placement of the page box, which is asserted.
			} else {
				expect(f.row.fitReadout?.fitsX, "premise: the page fits the pane at Fit's scale").toBe(true);
				if (arm.expect === "centred") expect(Math.abs(leftMiss(f.row)), `Fit lands the column on Obsidian's own margin, scaled, px (read ${leftMiss(f.row)})`).toBeLessThanOrEqual(LIVE_TOL_PX);
				else if (f.row.ownLines) {
					// PART 21 EDGE 2'S CONTRACT, under a theme that centres its own LINES. The theme centres the line and
					// knows nothing about ink granted room past the column, so left to itself it centres as if the page
					// ended at the column and carries the ink out of the pane - measured at 3ca52512, 16.31 px and
					// 23.81 px past the right edge on two runs. The commit now pays that in its own scroll target
					// (`ownLinesPageBoxScrollLeft`), so the claim is the contract itself: every ink pixel inside the
					// pane, and the column still inside its left edge.
					// NOT the premise line the default arm below asserts: at Fit's scale the page fits the pane with
					// room under either theme, so "centring would have overshot" is not a fact about this arm - measured
					// on the default theme too, restMiss 0.04 with the ink already inside.
					// THE LINE BOX for the left edge, not `.cm-content`: under this theme the content box is the whole
					// scroller and sits at the pane's left edge whatever the page does, so it cannot witness the column.
					expect(f.row.inkRight, "the ink stays inside the pane's right edge").toBeLessThanOrEqual(f.row.viewRight + 0.5);
					expect(f.row.lineLeft, "and the column inside its left edge").toBeGreaterThanOrEqual(f.row.viewLeft - 0.5);
					// The scroll-payment clause is gone. It asked HOW the landing was paid (a positive
					// `scrollLeft` from `ownLinesPageBoxScrollLeft`) rather than where anything lands, and at this
					// fixture's scale nothing needs paying - measured, the ink's right edge 6.19 px inside the pane
					// with the scroll at 0. The two claims above are the contract and both hold.

				} else {
					expect(restMiss(f.row), "premise: centring the column alone would have carried the page past the pane, so the rest stops short of centre").toBeLessThan(-LIVE_TOL_PX);
					expect(f.row.inkRight, "the ink stays inside the pane's right edge").toBeLessThanOrEqual(f.row.viewRight + 0.5);
					expect(f.row.contentLeft, "and the column inside its left edge").toBeGreaterThanOrEqual(f.row.viewLeft - 0.5);
				}
			}
		} finally { await page.close(); }
	}, 180_000);
}

/**
 * THE SURFACE THE REST COSTS, measured rather than assumed, because it is not the same everywhere.
 *
 * A left margin widens a scroller's content box by what it adds, and on the lag harness - a note whose own surface is
 * already far wider than the pane - it does: scrollWidth 60691 -> 66980 at 10 percent with the setting on, unchanged with
 * it off, and about 1.2 ms a scroll frame with it (disclosed on the checklist; the device step judges the feel). A
 * counterweight (a negative right margin) was tried and does not shrink it: this engine's scrollable overflow is the
 * sizer's left margin plus its width.
 *
 * ON AN ORDINARY NOTE, which is this arm, it costs no reachable room at all: the sizer's width is the scroller's, so the
 * margin moves the column inside a box that does not grow, and the range stays 0. That is what this arm pins, so a change
 * that starts handing out blank sideways room on a plain note at a zoom-out is caught here.
 *
 * PLANT: HW_RLL_PLANT_NO_LAYOUT_REST=1 puts the centring back in the pan and the column is no longer at its rest, so the
 * premise this arm rests on goes red.
 */
(THEME === "default" ? it : it.skip)("under the canvas the zoom button grants sideways room and scrolls nothing into it", async () => {
	const { page, errors, mounted, n } = await open(true, "surface");
	try {
		const z = await call(page, "zoomBy", 0.25) as any;
		const later = await call(page, "later", 400, "later") as any;
		record.push({ arm: "surface", natural: n, zoomed: z, later, errors });
		// eslint-disable-next-line no-console
		console.log("RLLFOCAL-SURFACE " + JSON.stringify({ k: later.k, naturalRangeX: n.rangeX, laterRangeX: later.rangeX,
			restMiss: restMiss(later), scrollLeft: later.scrollLeft, overflowX: later.overflowX, panX: later.panX }));
		expect(errors).toEqual([]);
		expect(later.k, "the button zoomed out").toBeCloseTo(0.25, 3);
		expect(Math.abs(leftMiss(later)), "premise: the column is on Obsidian's own margin, scaled").toBeLessThanOrEqual(LIVE_TOL_PX);
		// under the Infinite Canvas the room is granted on purpose - measured at aa437ff1,
		// 1775 px on the fresh note and 5820 after the button zoom-out - so "no reachable room" is no
		// longer the claim. What survives, and is the part that would hurt on the device, is that
		// nothing is scrolled into that room by the zoom itself.
		expect(n.rangeX, "premise: the canvas grants the note sideways room").toBeGreaterThan(0);
		expect(later.rangeX, "the zoom-out grants more room, never less").toBeGreaterThanOrEqual(n.rangeX);
		expect(later.scrollLeft, "with nothing scrolled into it").toBe(0);
	} finally { await page.close(); }
}, 180_000);

/**
 * THE INK ON ITS LINE: the pin candidate 1 never had.
 *
 * Every arm above reads the TEXT: where the column is held, where it rests, what carries the rest. None of them reads the
 * committed ink against the words it was written on, and that is the half of Alan's report no cell could have caught -
 * "still broken and worse, the ink is moving too". Part 49 (c) makes it load-bearing: under a theme that centres its own
 * lines the overlay stops pinning `.cm-content`, so the COLUMN moves under the ink at every zoom and the ink's origin has
 * to be re-measured from the line box for the two to stay together. If that re-measure is skipped, these arms are where
 * it shows (plant HW_RLL_PLANT_NO_SETTLE_REMEASURE).
 *
 * READ FROM PIXELS: the committed canvas's own magenta pixels mapped through its client rect, against the text line's
 * left and centre, in client px. The natural frame's offset is the baseline; at a scale k the ink must sit that offset
 * times k from its words.
 *
 * BOUNDS. At rest within 1 device px (0.5 CSS px at DPR 2) on X, the axis this candidate moves. Mid-gesture within 2 note
 * px - the bound InkAtRest pinned for the preview, where the committed raster is carried by a transform until the settle.
 *
 * Y IS READ AGAINST A KNOWN, PRE-EXISTING OFFSET, and is not this candidate's. Measured on 52286ce5 before part 49 (c)
 * was written: at 150% the stroke reads 0.75 CSS px off its line - identically with Readable line length OFF and under
 * both themes, so it is not the column. It may be the ink, or the glyph-range rect of the text rounding at 24px; this rig
 * does not separate the two. It is on the pre-existing list for the small batch or 1.4.21 (with ZoomOutStandingPan's
 * 3.995 px at 150%). The bound is that offset plus 1 device px, in painted px, so this arm cannot go red on it.
 *
 * THE PREMISE IS ASSERTED AT EVERY READ: the text line and the stroke are inside the pane. A read of "no ink" for a line
 * that has scrolled off screen is a premise failure, not a result - measured on 52286ce5, a return pinch aimed at the
 * line's 100% y zoomed about blank paper and left the line at y -143.
 *
 * Both settings: with Readable line length off there is no inset to move, so those arms are the control.
 */
const INK_REST_CSS_PX = 1 / DPR;
const INK_LIVE_NOTE_PX = 2;
const INK_KNOWN_Y_CSS_PX = 0.75;
const inkOff = (r: any) => (r.inkN > 0 && r.inkLeft !== null ? { x: r.inkLeft - r.textLeft, y: r.dyNote === null ? null : r.dyNote * r.k } : null);
const inkPremise = (pane: any, r: any, where: string) => {
	expect(r.textCy > pane.top && r.textCy < pane.bottom, `premise, ${where}: the text line is inside the pane (cy ${r.textCy})`).toBe(true);
	expect(r.inkN, `premise, ${where}: the stroke is on the committed canvas`).toBeGreaterThan(0);
	// The STROKE's x, not the text start's: a pinch in to 150% about the text's start puts the start 14 px left of the
	// pane edge (measured, x 286 against a pane at 300) while the stroke, 80 px in, is on screen and readable.
	expect(r.inkLeft >= pane.left - 0.5 && r.inkRight <= pane.right + 0.5, `premise, ${where}: and the stroke is inside the pane (x ${r.inkLeft}-${r.inkRight})`).toBe(true);
};
const expectInkOnLine = (n: any, r: any, where: string, pane?: any) => {
	if (pane) { inkPremise(pane, n, "at 100%"); inkPremise(pane, r, where); }
	const a = inkOff(n), b = inkOff(r);
	expect(a, `premise, ${where}: the stroke reads at 100%`).not.toBeNull();
	expect(b, `${where}: the stroke is still on the committed canvas`).not.toBeNull();
	const dx = r2(b!.x - a!.x * r.k), dy = b!.y === null || a!.y === null ? null : r2(b!.y - a!.y * r.k);
	expect(Math.abs(dx), `${where}: the ink sits on its line within 1 device px, horizontally (off ${dx} px at k ${r2(r.k)})`).toBeLessThanOrEqual(INK_REST_CSS_PX);
	if (dy !== null) expect(Math.abs(dy), `${where}: Y against the known pre-existing ${INK_KNOWN_Y_CSS_PX} px offset plus 1 device px (off ${dy} px)`).toBeLessThanOrEqual(INK_KNOWN_Y_CSS_PX + INK_REST_CSS_PX);
	return { dx, dy };
};
const worstLiveInk = (n: any, rows: any[]) => {
	const a = inkOff(n);
	let worst = 0, frames = 0;
	for (const r of rows) {
		if (!r.preview) continue;
		const b = inkOff(r);
		if (!a || !b) continue;
		frames++;
		worst = Math.max(worst, Math.abs(b.x - a.x * r.k) / r.k);
	}
	return { worstNote: r2(worst), frames };
};

for (const readable of [true, false]) {
	const tag = `RLL ${readable ? "on" : "off"}`;

	it(`INK ON ITS LINE, ${tag}: a pinch out to 25% about the pane's centre keeps the stroke on its words, live and at rest`, async () => {
		const { page, errors, mounted, n } = await open(readable, `ink-pinch-${readable}`);
		try {
			const c = mounted.pane.left + mounted.pane.width / 2, cy = n.textCy as number;
			const rows = await call(page, "pinch", 0.25, 30, c, cy, "inkout") as any[];
			const later = await call(page, "later", 400, "later") as any;
			const live = worstLiveInk(n, rows);
			record.push({ arm: "ink-pinch", readable, natural: n, rows, later, errors });
			expect(errors).toEqual([]);
			expect(later.k, "out to 25%").toBeCloseTo(0.25, 3);
			const rest = expectInkOnLine(n, later, "at rest", mounted.pane);
			// eslint-disable-next-line no-console
			console.log("RLLINK " + JSON.stringify({ theme: THEME, arm: "pinch-25", readable, rest, live, panX: later.panX, lineLeft: later.lineLeft, restMiss: readable ? restMiss(later) : null }));
			expect(live.frames, "preview frames carried the stroke").toBeGreaterThan(20);
			expect(live.worstNote, "mid-gesture the ink stays within 2 note px of its words").toBeLessThanOrEqual(INK_LIVE_NOTE_PX);
		} finally { await page.close(); }
	}, 180_000);

	it(`INK ON ITS LINE, ${tag}: the zoom button to 25% keeps the stroke on its words`, async () => {
		const { page, errors, mounted, n } = await open(readable, `ink-button-${readable}`);
		try {
			const z = await call(page, "zoomBy", 0.25) as any;
			const later = await call(page, "later", 400, "later") as any;
			record.push({ arm: "ink-button", readable, natural: n, zoomed: z, later, errors });
			expect(errors).toEqual([]);
			expect(later.k, "the button zoomed to 25%").toBeCloseTo(0.25, 3);
			const rest = expectInkOnLine(n, later, "at rest", mounted.pane);
			// eslint-disable-next-line no-console
			console.log("RLLINK " + JSON.stringify({ theme: THEME, arm: "button-25", readable, rest, panX: later.panX, lineLeft: later.lineLeft, restMiss: readable ? restMiss(later) : null }));
		} finally { await page.close(); }
	}, 180_000);

	it(`INK ON ITS LINE, ${tag}: a pinch in to 150% at the text's start keeps the stroke on its words, live and at rest`, async () => {
		const { page, errors, mounted, n } = await open(readable, `ink-in-${readable}`);
		try {
			const cx = (n.textLeft as number) + 40, cy = n.textCy as number;
			const rows = await call(page, "pinch", 1.5, 30, cx, cy, "inkin") as any[];
			const later = await call(page, "later", 400, "later") as any;
			const live = worstLiveInk(n, rows);
			record.push({ arm: "ink-in", readable, natural: n, rows, later, errors });
			expect(errors).toEqual([]);
			expect(later.k, "in to 150%").toBeCloseTo(1.5, 3);
			const rest = expectInkOnLine(n, later, "at rest", mounted.pane);
			// eslint-disable-next-line no-console
			console.log("RLLINK " + JSON.stringify({ theme: THEME, arm: "pinch-150", readable, rest, live, panX: later.panX, lineLeft: later.lineLeft, restMiss: readable ? restMiss(later) : null }));
			expect(live.worstNote, "mid-gesture the ink stays within 2 note px of its words").toBeLessThanOrEqual(INK_LIVE_NOTE_PX);
		} finally { await page.close(); }
	}, 180_000);

	it(`the blank canvas after the trip is finding 2's consequence, not lost ink: the stroke survives in the note and never moves, the words simply leave the pane with the page, ${tag}`, async () => {
		const { page, errors, mounted, n } = await open(readable, `ink-round-${readable}`);
		try {
			const c = mounted.pane.left + mounted.pane.width / 2, cy = n.textCy as number;
			const out = await call(page, "pinch", 0.25, 30, c, cy, "inkrout") as any[];
			const atQuarter = out.at(-1);
			const back = await call(page, "pinch", 1, 30, c, atQuarter.textCy, "inkrin") as any[];
			const later = await call(page, "later", 400, "later") as any;
			const live = worstLiveInk(n, [...out, ...back]);
			record.push({ arm: "ink-round", readable, natural: n, out, back, later, errors });
			expect(errors).toEqual([]);
			expect(later.k, "back to 100%").toBeCloseTo(1, 3);
			inkPremise(mounted.pane, atQuarter, "at 25% before the return");
			// THE READOUT THAT SETTLED THIS. backingInk scans the committed canvas's BACKING
			// STORE, so inkN 0 says only that nothing is rasterised there - it cannot tell a lost stroke from
			// one the page has slid away from. Measured at f3dc4420 with the model read directly: the note
			// still holds its 1 stroke at every phase and its first point stays at note x 86.00 throughout,
			// while the words travel 647.25 -> -1449.00 (RLL on) and 306.00 -> -1790.25 (RLL off), both
			// exactly the 2096.25 px of finding 2, off the left of a canvas box that never moved (100-1883).
			// So this cell no longer asks for ink on screen after the trip. It asks that the ink is INTACT
			// and that the blank is the page's displacement and nothing else. If a future change brings the
			// page back, the last row here reddens and the on-screen claim comes back with it.
			inkPremise(mounted.pane, n, "at 100% before the trip");
			expect(later.modelStrokes, "the note still holds every stroke it held at 100%").toBe(n.modelStrokes);
			expect(later.modelStrokeX, "and the stroke has not moved in note space, x").toBeCloseTo(n.modelStrokeX, 2);
			expect(later.modelStrokeY, "and the stroke has not moved in note space, y").toBeCloseTo(n.modelStrokeY, 2);
			expect(Math.abs(later.textLeft - (n.textLeft - later.scrollLeft + later.panX)), "the words moved by the parked scroll plus the standing pan, and nothing else, px").toBeLessThanOrEqual(LIVE_TOL_PX);
			expect(later.textLeft, "and that displacement carried the words off the left of the pane, which is why the canvas is blank").toBeLessThan(mounted.pane.left);
			const rest = { intact: later.modelStrokes, noteX: later.modelStrokeX, inkN: later.inkN, ccLeft: later.ccLeft, ccRight: later.ccRight };
			// eslint-disable-next-line no-console
			console.log("RLLINK " + JSON.stringify({ theme: THEME, arm: "round-25-100", readable, rest, live, panX: later.panX, textMoved: r2(later.textLeft - n.textLeft) }));
			expect(later.textCy, "premise: the words are back on screen to read").toBeGreaterThan(0);
			// ZERO SNAP. The commit frame (the first settle sample) must carry the same
			// PAINTED position the last preview frame painted - nothing may jump in the frame of the lift,
			// whatever the settle later eases. `panX` alone is the rest the settle wrote (restPanX, the
			// ease's END), not what is painted: the overscroll bounce rides on top as a visual offset
			// (`bounce.x`/`bounce.y`, bounceOffset) that starts at the correction and eases to zero, so the
			// PAINTED pan is `panX + bounce.x`. That sum, not `panX` alone, is what must not jump here.
			const painted = (row: any) => ({ x: row.panX + (row.bounce ? row.bounce.x : 0), y: row.panY + (row.bounce ? row.bounce.y : 0) });
			const lastPreviewRow = back.filter((r: any) => r.phase === "inkrin-move-30").at(-1);
			const lastPreview = painted(lastPreviewRow);
			const commitRow = back.find((r: any) => r.phase === "inkrin-settle-1");
			expect(commitRow, "premise: the commit frame was sampled").toBeTruthy();
			const commitFrame = painted(commitRow);
			// X ONLY: the regression this brief closes (832.59, the -1359 hang, the floor) is the X axis
			// candidate 1 never had. Y carries the pre-existing, documented offset above (lines 878-882,
			// "not this candidate's") and expectInkOnLine already tolerates it there; holding zero-snap to
			// it here would assert a claim this brief never measured or ruled on.
			// THE READOUT MOVED TO WHAT THE READER SEES. `painted` is panX + bounce.x and has
			// no scroll term, so under the canvas it reported a 2096 px snap that never happened on screen:
			// measured at eaffa1d4, textLeft is -1449.00 on both sides of the lift (-1790.25 both sides with
			// Readable line length off) while panX goes -2096.25 to -0.25 and scrollLeft goes 0 to 2096. The
			// pan is handed to the native scroll in one frame and the page does not move. Asserting the text's
			// own painted position covers both terms and loses no power: the same readout moves 447.25 to
			// 336.00 across the lift on the 600 arm, which is the reset the ruling accepts for 1.4.20.
			expect(Math.abs(commitRow.textLeft - lastPreviewRow.textLeft), "zero snap x: the commit frame paints the text where the last preview frame painted it, px").toBeLessThanOrEqual(LIVE_TOL_PX);
			// Kept as a printed decomposition, not a claim: pan and scroll may trade places in that frame.
			// eslint-disable-next-line no-console
			console.log("RLLINK-LIFT " + JSON.stringify({ readable, lastPreviewTextLeft: lastPreviewRow.textLeft, commitTextLeft: commitRow.textLeft, lastPreviewPanX: lastPreview.x, commitPanX: commitFrame.x, lastPreviewScrollLeft: lastPreviewRow.scrollLeft, commitScrollLeft: commitRow.scrollLeft }));
			// AT REST, the words are back within 1 px of a fixed target, DERIVED from
			// this fixture's own geometry (not pinned from a run). floor = min(0, room - extent),
			// the same expression the ruling's cx floors on (InkOverlay.ts, the ruling site): room =
			// max(0, paneWidth * externalScale - PAN_MIN_VISIBLE_PX) (InkOverlay.ts:109, 24), extent =
			// max(columnBox, surfaceExtents(x) * fontZoom) * (k * externalScale). RLL on stays native (0):
			// the inset column fits its room by construction. `later()` already waits out the overscroll
			// glide before sampling (its readback loops on `overscrollBounceReadout().active`).
			const PAN_MIN_VISIBLE_PX = 24;
			const effective = later.k * later.externalScale;
			const room = Math.max(0, later.paneWidthPx * later.externalScale - PAN_MIN_VISIBLE_PX);
			const extent = Math.max(later.columnBoxPx ?? 0, later.extentX * later.fontZoom) * effective;
			const restOffsetPx = Math.abs(later.textLeft - n.textLeft);
			const restTargetPx = readable ? 0 : Math.abs(Math.min(0, room - extent));
			// REPLACED. This row asked that the words come back to a rest DERIVED for a page
			// that parks no scroll - target 0 px with Readable line length on, 3746 px with it off. Measured
			// at ee14c3da the words sit 2096.25 px from where they started in both arms, so the row read
			// 2096.25 against 0 and 1649.75 against 3746 - in each case the parked scroll itself. Under the
			// canvas that rest law is not the claim; the row above states where the words actually end, as
			// the parked scroll plus the standing pan. The floor terms stay computed and printed below, so
			// the day a change moves them it is on the record rather than silently gone.
			// eslint-disable-next-line no-console
			console.log("RLLINK-REST " + JSON.stringify({ readable, restOffsetPx, restTargetPx, room: r2(room), extent: r2(extent), effective, panMinVisiblePx: PAN_MIN_VISIBLE_PX, laterScrollLeft: later.scrollLeft, laterPanX: later.panX }));
			expect(live.worstNote, "mid-gesture the ink stays within 2 note px of its words").toBeLessThanOrEqual(INK_LIVE_NOTE_PX);
		} finally { await page.close(); }
	}, 180_000);
}

/**
 * RED-FIRST, Alan on the device (vault test 2, 20c182e1): Infinite Canvas off, Readable line length
 * turned OFF in session, pinch out to 10% - and the page sits CENTRED in the pane with "Untitled" mid-top.
 * The contract is top-left at every zoom with the setting off.
 *
 * WHY THE TOGGLE IS THE WHOLE CELL. A fixture mounted with the setting off reads left edge 0 and always
 * did, so it cannot see this defect at all. What Alan did was turn it off in a session that
 * had it on, and a quantity frozen while it was on is what survives the change. So: mount ON, pinch once
 * so the resting column margin is established, toggle OFF, then pinch out to 10% and read the left edge.
 *
 * Expected RED at 20c182e1 on the last row: the page's left edge must sit on the pane's, and does not.
 */
it("RLL turned off in session: the page is at the pane's left edge after a pinch out to 10%", async () => {
	const { page, errors, mounted } = await open(true, "toggle");
	try {
		const centre = mounted.pane.left + mounted.pane.width / 2, cy = mounted.natural.textCy as number;
		// With the setting ON, establish the resting column margin the way a real session would.
		const on = await call(page, "pinch", 0.5, 8, centre, cy, "rll-on") as any[];
		const settledOn = on.at(-1);
		expect(settledOn.columnLocal, "premise: the setting is on and a column was measured").not.toBe(null);
		// THE SETTING GOES OFF, no gesture in flight.
		const toggled = await call(page, "setReadable", false) as any;
		// ...and only then the pinch Alan made.
		const out = await call(page, "pinch", 0.1, 12, centre, cy, "rll-off-out") as any[];
		expect(errors).toEqual([]);
		const rest = out.at(-1);
		// eslint-disable-next-line no-console
		console.log("RLL-OFF " + JSON.stringify({
			onColumnLocal: settledOn.columnLocal, onLeftEdge: r2(settledOn.contentLeft - settledOn.viewLeft),
			toggledColumnLocal: toggled.after.columnLocal, toggledLeftEdge: r2(toggled.after.contentLeft - toggled.after.viewLeft),
			toggledSizerTransform: toggled.after.sizerTransform, toggledPanX: toggled.after.panX,
			restK: rest.k, restColumnLocal: rest.columnLocal, restLeftEdge: r2(rest.contentLeft - rest.viewLeft),
			restPanX: rest.panX, restScrollLeft: rest.scrollLeft, restSizerTransform: rest.sizerTransform,
		}));
		expect(rest.k, "premise: the pinch really reached 10%").toBeCloseTo(0.1, 2);
		// THE CLAIM. Top-left with the setting off: the page's own left edge sits on the scroller's.
		expect(Math.abs(rest.contentLeft - rest.viewLeft),
			`the page is at the pane's left edge with the setting off (content ${rest.contentLeft}, pane ${rest.viewLeft})`).toBeLessThanOrEqual(1);
		// AND IT IS NOT HELD THERE BY A PAN OR A SCROLL: the margin is the carrier, as a later ruling requires.
		expect(Math.abs(rest.panX), `no pan stands at the rest (panX ${rest.panX})`).toBeLessThanOrEqual(0.5);
		expect(rest.scrollLeft, "and nothing is scrolled into its room").toBe(0);
	} finally { await page.close(); }
}, 180_000);

/**
 * SECOND ARM, and the one that asks the question the first arm cannot. The first arm pinches ONCE
 * WITH THE SETTING ON before the toggle, which writes `--handwriting-column-margin-left` on the host; after
 * the toggle it is rewritten to 0px and the page is at the edge. That is not what Alan necessarily did.
 *
 * THE STYLESHEET'S CLAMP IS THE REASON THIS MATTERS (styles.css, the sizer's margin-left): it clamps
 * between 0 and the var, and where the var is UNSET the clamp's own fallback is the centring calc
 * `(100% - var(--file-line-width)) / 2`. So an unset var CENTRES and a var of "0px" does not, and the two
 * are indistinguishable from the page's position alone unless the var is read. This arm toggles the
 * setting off with no gesture at all beforehand, then pinches out, and reads the var at every step.
 */
it("RLL turned off with no prior gesture: the page is at the pane's left edge after a pinch out to 10%", async () => {
	const { page, errors, mounted } = await open(true, "nogesture");
	try {
		const centre = mounted.pane.left + mounted.pane.width / 2, cy = mounted.natural.textCy as number;
		const toggled = await call(page, "setReadable", false) as any;
		const out = await call(page, "pinch", 0.1, 12, centre, cy, "nogesture-out") as any[];
		expect(errors).toEqual([]);
		const rest = out.at(-1);
		// eslint-disable-next-line no-console
		console.log("S115B " + JSON.stringify({
			varBefore: toggled.varBefore, varAfter: toggled.varAfter,
			toggledLeftEdge: r2(toggled.after.contentLeft - toggled.after.viewLeft), toggledColumnLocal: toggled.after.columnLocal,
			restK: rest.k, restLeftEdge: r2(rest.contentLeft - rest.viewLeft), restColumnLocal: rest.columnLocal,
			restPanX: rest.panX, restScrollLeft: rest.scrollLeft,
		}));
		expect(rest.k, "premise: the pinch really reached 10%").toBeCloseTo(0.1, 2);
		expect(Math.abs(rest.contentLeft - rest.viewLeft),
			`the page is at the pane's left edge with the setting off (content ${rest.contentLeft}, pane ${rest.viewLeft})`).toBeLessThanOrEqual(1);
		expect(Math.abs(rest.panX), `no pan stands at the rest (panX ${rest.panX})`).toBeLessThanOrEqual(0.5);
		expect(rest.scrollLeft, "and nothing is scrolled into its room").toBe(0);
	} finally { await page.close(); }
}, 180_000);

/**
 * THIRD ARM, and the one that matches what Alan actually had: a fresh
 * "Untitled" note, Readable line length already OFF from a previous session, no gesture at all before the
 * pinch. The two arms above both mount with the setting ON and toggle it, and both are GREEN - so the
 * toggle is not the ingredient. What neither of them carries is an EMPTY note.
 *
 * WHY EMPTINESS COULD BE THE WHOLE THING. Every quantity the column rests on is measured from a LINE
 * element - `contentOrigin(...).left` feeds `columnLocal`, and the var write at InkOverlay.ts :8217 is
 * gated on `columnLocal !== null`. An empty note has no line to measure, so that write can be skipped
 * entirely, and the stylesheet's clamp then falls back to its own centring calc. Centred is exactly what
 * Alan saw. Unproven until this runs: the two arms above showed the var unset and the page STILL at the
 * edge, so an unset var is not on its own enough.
 */
it("fresh empty note with RLL off from the start: the page is at the pane's left edge after a pinch out to 10%", async () => {
	const { page, errors, mounted } = await open(false, "empty", 0, true);
	try {
		const centre = mounted.pane.left + mounted.pane.width / 2, cy = mounted.natural.textCy as number;
		const out = await call(page, "pinch", 0.1, 12, centre, cy, "empty-out") as any[];
		expect(errors).toEqual([]);
		const rest = out.at(-1), start = mounted.natural;
		// eslint-disable-next-line no-console
		console.log("S115C " + JSON.stringify({
			startColumnLocal: start.columnLocal, startLeftEdge: r2(start.contentLeft - start.viewLeft),
			restK: rest.k, restColumnLocal: rest.columnLocal, restLeftEdge: r2(rest.contentLeft - rest.viewLeft),
			restPanX: rest.panX, restScrollLeft: rest.scrollLeft, restSizerTransform: rest.sizerTransform,
		}));
		expect(rest.k, "premise: the pinch really reached 10%").toBeCloseTo(0.1, 2);
		expect(Math.abs(rest.contentLeft - rest.viewLeft),
			`the page is at the pane's left edge with the setting off (content ${rest.contentLeft}, pane ${rest.viewLeft})`).toBeLessThanOrEqual(1);
		expect(Math.abs(rest.panX), `no pan stands at the rest (panX ${rest.panX})`).toBeLessThanOrEqual(0.5);
		expect(rest.scrollLeft, "and nothing is scrolled into its room").toBe(0);
	} finally { await page.close(); }
}, 180_000);

/**
 * THIRD ARM, and the one that matches what Alan actually had: a fresh
 * "Untitled" note, Readable line length already OFF from a previous session, no gesture at all before the
 * pinch. The two arms above both mount with the setting ON and toggle it, and both are GREEN - so the
 * toggle is not the ingredient. What neither of them carries is an EMPTY note.
 *
 * WHY EMPTINESS COULD BE THE WHOLE THING. Every quantity the column rests on is measured from a LINE
 * element: contentOrigin(...).left feeds columnLocal, and the var write at InkOverlay.ts :8217 is gated on
 * columnLocal being non-null. An empty note has no line to measure, so that write can be skipped entirely
 * and the stylesheet's clamp then falls back to its own centring calc. Centred is exactly what Alan saw.
 * Unproven until this runs: arms 1 and 2 showed the var unset and the page STILL at the edge, so an unset
 * var is not on its own enough.
 */
it("fresh empty note with RLL off from the start, repeat arm: the page is at the pane's left edge after a pinch out to 10%", async () => {
	const { page, errors, mounted } = await open(false, "empty", 0, true);
	try {
		const centre = mounted.pane.left + mounted.pane.width / 2, cy = mounted.natural.textCy as number;
		const out = await call(page, "pinch", 0.1, 12, centre, cy, "empty-out") as any[];
		expect(errors).toEqual([]);
		const rest = out.at(-1), start = mounted.natural;
		// eslint-disable-next-line no-console
		console.log("S115C " + JSON.stringify({
			startColumnLocal: start.columnLocal, startLeftEdge: r2(start.contentLeft - start.viewLeft),
			restK: rest.k, restColumnLocal: rest.columnLocal, restLeftEdge: r2(rest.contentLeft - rest.viewLeft),
			restPanX: rest.panX, restScrollLeft: rest.scrollLeft, restSizerTransform: rest.sizerTransform,
		}));
		expect(rest.k, "premise: the pinch really reached 10%").toBeCloseTo(0.1, 2);
		expect(Math.abs(rest.contentLeft - rest.viewLeft),
			`the page is at the pane's left edge with the setting off (content ${rest.contentLeft}, pane ${rest.viewLeft})`).toBeLessThanOrEqual(1);
		expect(Math.abs(rest.panX), `no pan stands at the rest (panX ${rest.panX})`).toBeLessThanOrEqual(0.5);
		expect(rest.scrollLeft, "and nothing is scrolled into its room").toBe(0);
	} finally { await page.close(); }
}, 180_000);

/**
 * RED-FIRST: THE INSET FLAG MUST NOT MOVE WITH THE ZOOM.
 *
 * Alan's device (Orion, fresh Untitled, Readable line length off, pinched to 10%) reported
 * --handwriting-column-margin-left written at 4292.7px and the sizer 432.46 px right of the scroller.
 * columnRestCentred returns null unless layout.columnInset is true, so columnInset is true on a page with
 * no readable column at all.
 *
 * WHY IT TAKES A ZOOM SWEEP AND NOT A STATE. columnInset is InkOverlay.ts :8068, columnBoxLocal against
 * scroller.clientWidth. The comment above it defends the test by saying the page is 1383 local px at every
 * zoom - true - but the SCROLLER is not: the host is counter-sized as the zoom falls, so its local content
 * box grows while the column stands still. Below some zoom a full-width page fits inside it with room to
 * spare and the flag flips, which is the engagement that comment set out to prevent. Nothing is stale and
 * nothing is toggled, which is why four earlier arms at a single zoom were all green.
 *
 * THE CONTROL IS THE COMMENT'S OWN CASE: with the setting off the page is the full 1383, so it is never
 * inset at any zoom. Expected RED at 20c182e1 on the 25% and 10% rows.
 */
it("RLL off: the page is never inset, at any zoom", async () => {
	const { page, errors, mounted } = await open(false, "zoom");
	try {
		const centre = mounted.pane.left + mounted.pane.width / 2, cy = mounted.natural.textCy as number;
		const reads: any[] = [await call(page, "insetRead", "start-100") as any];
		for (const to of [0.5, 0.25, 0.1]) {
			await call(page, "pinch", to, 10, centre, cy, "z-" + to);
			reads.push(await call(page, "insetRead", "at-" + to) as any);
			// AND THE SAME ZOOM AFTER A RE-MEASURE. The zoom alone never re-asks the question -
			// refreshViewportColumn (:7977) does, and it measures with box = layout.width, which IS the
			// counter-sized host while zoomed out. A pane nudge is the rig's way to schedule that refresh;
			// on the device a theme or workspace style change does it for free.
			await call(page, "resizePane", 0);
			reads.push(await call(page, "insetRead", "after-refresh-" + to) as any);
		}
		expect(errors).toEqual([]);
		// eslint-disable-next-line no-console
		console.log("INSET " + JSON.stringify(reads));
		// PREMISE: this is the comment's own 1383 case - a page that fills the scroller in its natural layout.
		const start = reads[0];
		expect(start.contentW, "premise: the page fills its scroller with the setting off").toBeGreaterThanOrEqual(start.clientWidth - 2);
		// The layout is not built until the first gesture or refresh, so the opening read is null, not false.
		expect(start.columnInset === null || start.columnInset === false, "premise: not inset at 100%").toBe(true);
		// THE CLAIM: the flag is a property of the page and the theme, not of the zoom.
		for (const r of reads) {
			expect(r.columnInset === null || r.columnInset === false,
				`${r.tag}: the page became inset by zooming out (line ${r.lineBox}, scroller ${r.clientWidth}, k ${r.k})`).toBe(true);
			expect(r.marginVar === "" || Number.parseFloat(r.marginVar) <= 0.5,
				`${r.tag}: a centring margin was written with the setting off (${r.marginVar})`).toBe(true);
			expect(Math.abs(r.sizerLeft - r.scrollerLeft),
				`${r.tag}: the page sits right of the pane's left edge by ${r2(r.sizerLeft - r.scrollerLeft)} px`).toBeLessThanOrEqual(1);
		}
	} finally { await page.close(); }
}, 180_000);

/**
 * RED-FIRST, THE TAKEOVER PATH. The zoom sweep above proved the flag does not move
 * with the zoom, because every re-measure restores the natural basis first. One caller does not:
 * prepareViewportLayout's first build calls measureNaturalColumn(null) at :7928, which measures the host as
 * it stands. Counter-sized, that is a 13825 px scroller against a 1383 px line, and 1383 fits inside it with
 * room to spare - so a takeover that happens while the note is zoomed out reads "inset" on a page nobody
 * centred, and every rest from then on centres it. Alan relaunched; a restored zoom takes over at 10%.
 *
 * Expected RED at 20c182e1: columnInset true after a rebuild at 25% and at 10%, with the margin var written
 * non-zero and the page standing right of the pane's left edge.
 */
it("RLL off: a takeover while zoomed out does not make the page inset", async () => {
	const { page, errors, mounted } = await open(false, "takeover");
	try {
		const centre = mounted.pane.left + mounted.pane.width / 2, cy = mounted.natural.textCy as number;
		const reads: any[] = [];
		for (const to of [0.25, 0.1]) {
			await call(page, "pinch", to, 10, centre, cy, "tk-" + to);
			reads.push(await call(page, "insetRead", "before-takeover-" + to) as any);
			reads.push(await call(page, "retakeover", "after-takeover-" + to) as any);
		}
		expect(errors).toEqual([]);
		// eslint-disable-next-line no-console
		console.log("S119T " + JSON.stringify(reads));
		for (const r of reads) {
			// The FLAG is not the contract and is not the fix site - columnInset still reads true
			// on a page that fits its scroller, and that is allowed. What may never happen is a centring margin
			// written off the back of it. Read the outcome, not the flag.
			expect(r.marginVar === "" || Number.parseFloat(r.marginVar) <= 0.5,
				`${r.tag}: a centring margin was written with the setting off (${r.marginVar})`).toBe(true);
			expect(Math.abs(r.sizerLeft - r.scrollerLeft),
				`${r.tag}: the page sits right of the pane's left edge by ${r2(r.sizerLeft - r.scrollerLeft)} px`).toBeLessThanOrEqual(1);
		}
	} finally { await page.close(); }
}, 180_000);

/**
 * The ruling's pair lived here: a theme-narrow column with and without the setting class, pinning that the centring
 * margin was written only with the setting on. The ruling superseded that ruling outright - the plugin never adds a
 * centring margin under either setting - so the cells are removed rather than re-pinned. Alan's own device row
 * (setting off, narrow line, 10%: no centring var written) survives as the red-first above.
 */

// Alan, Orion, 2026-09-20, Minimal, Readable line length on, Infinite Canvas on: "as I zoom out the left edge
// is further and further into empty space". The settle landed at pan 0 every time (device trace); what moved was the
// column's home - the theme re-centred its lines in the host the plugin widens by 1/k: 392, 998, 1554, 1697 host px
// across three pinches. Alan direct: the plugin centres nowhere. Under a theme that centres its own lines the
// line inset is now frozen at its 100% value, so the column's left edge sits at nativeLeft x k after every lift.
// RED before the fix (the column lands at the centre of the widened box), GREEN after. Meaningful only under
// HW_RLL_THEME=Minimal (the own-lines premise is asserted, not assumed); under Obsidian's own theme the sizer carries
// the column and this cell asserts the freeze that already held there.
it("a theme that centres its own lines keeps the column at its 100% inset after every zoom-out under the canvas", async () => {
	const { page, errors, mounted, n } = await open(true, "own-lines", undefined, true);
	try {
		const on = await call(page, "canvasOn") as any;
		expect(on.k, "premise: 100% at the start").toBeCloseTo(1, 3);
		const home = on.lineLeft - on.viewLeft;
		expect(home, "premise: the column is inset from the pane's left edge").toBeGreaterThan(8);
		const c = mounted.pane.left + mounted.pane.width / 2, cy = on.textCy as number;
		const rows: any[] = [];
		for (const to of [0.5, 0.3]) {
			await call(page, "pinch", to, 30, c, cy, "pinch-" + to);
			const later = await call(page, "later", 400, "later-" + to) as any;
			const left = later.lineLeft - later.viewLeft, expected = home * later.k;
			rows.push({ to, k: later.k, ownLines: later.ownLines, left: r2(left), expected: r2(expected), panX: later.panX, scrollLeft: later.scrollLeft });
			expect(later.k, "premise: the pinch landed near its target").toBeCloseTo(to, 1);
			expect(Math.abs(left - expected), `after the lift at ${to}: the column's left edge is its 100% inset scaled (${r2(expected)}), not the centre of the widened box (read ${r2(left)})`).toBeLessThanOrEqual(1);
		}
		console.log("RLLFOCAL-OWNLINES " + JSON.stringify({ home: r2(home), rows }));
		record.push({ arm: "own-lines", home: r2(home), rows });
		expect(errors).toEqual([]);
	} finally { await page.close(); }
}, 300_000);

// Alan, Orion, 2026-09-21, Minimal, Readable line length on, Infinite Canvas on, 20.7%: "the untitled title moves
// to the right as i pinch outward", while the text and the ink stay left. Obsidian hangs the inline title off the SIZER,
// beside the contentContainer, and Minimal centres it there with `margin-inline: var(--content-margin) !important`
// (theme.css:1860-1867) inside a sizer the owned host widens by 1/k - so it re-centres further right on every zoom-out
// while the frozen lines stay put. RED at c978650e (the title box lands 513.44 px right of the line box at 25%), GREEN
// at the fix. Meaningful under HW_RLL_THEME=Minimal; under Obsidian's own theme the plugin's own reset already holds the
// title at the sizer's left edge, and this cell asserts that it still does.
it("the inline title takes the same frozen inset as the lines after every zoom-out", async () => {
	const { page, errors, mounted } = await open(true, "title-freeze", undefined, true, true);
	try {
		await call(page, "canvasOn");
		const at100 = await call(page, "titleRead", "pinch-100") as any;
		expect(at100.k, "premise: 100% at the start").toBeCloseTo(1, 3);
		expect(at100.titleLeft, "premise: the rig mounted an inline title as a sizer child").not.toBeNull();
		const rows: any[] = [at100];
		// MEASURED, not assumed: under Minimal the title box and the line box are not flush even at 100% - the theme
		// centres two different widths (title 640, line 648), so the title box starts 4 px right of the line box while its
		// text starts 2 px left of the line's text (the line carries 6 px of padding, the title none). Under Obsidian's own
		// theme both boxes start at 641.25. That offset is the theme's own padding, not what Alan saw move.
		expect(Math.abs(at100.titleLeft - at100.lineLeft), `premise at 100%: title and line start together within the theme's own padding (title ${at100.titleLeft}, line ${at100.lineLeft})`).toBeLessThanOrEqual(8);
		const c = mounted.pane.left + mounted.pane.width / 2, cy = (await call(page, "sample", "cy") as any).textCy as number;
		for (const to of [0.25, 0.15]) {
			await call(page, "pinch", to, 30, c, cy, "pinch-" + to);
			await call(page, "later", 400, "later-" + to);
			const r = await call(page, "titleRead", "read-" + to) as any;
			rows.push(r);
			expect(r.k, "premise: the pinch landed near its target").toBeCloseTo(to, 1);
			// The freeze exists only once the overlay has built its layout, which it does on the first zoom frame - so the
			// premise belongs here, not at 100%, where nothing is frozen and the theme centres title and lines alike.
			if (THEME !== "default") expect(r.ownLinesClass, "premise: the own-lines freeze is in force under this theme").toBe(true);
			// THE FREEZE ITSELF: with the inset in force the title takes the same margin as the lines, so the two boxes start
			// at the same x. At c978650e the title box was 513.44 px right of the line box at 25% - the theme re-centring it
			// in a sizer the host had widened by 1/k, which is the drift Alan reported.
			expect(Math.abs(r.titleLeft - r.lineLeft), `after the lift at ${to}: the title's left edge is the first line's (title ${r.titleLeft}, line ${r.lineLeft})`).toBeLessThanOrEqual(1);
		}
		// eslint-disable-next-line no-console
		console.log("RLLFOCAL-TITLE " + JSON.stringify(rows));
		record.push({ arm: "title-freeze", rows });
		expect(errors).toEqual([]);
	} finally { await page.close(); }
}, 300_000);
