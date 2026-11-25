/**
 * A RESIZED PICTURE KEEPS ITS INK (render cells for the fix).
 *
 * Alan, 2026-11-10: "mostly people will want to stick ink to pictures"; 2026-11-11: "ink attach to pictures scope yes".
 * Screen promise: ink attached to a picture stays on the picture when the picture is resized. Contract
 * (product-context.md:174): attached groups move on local text edits, stored coordinates translated, never scaled.
 *
 * The rig and PA6r are taken from the picture cells file at dfd8c432 (test/render/PictureAttach.test.ts, the
 * 1.5.2-picture-attach-cells branch); its other cells stay on that branch. Every Obsidian 1.15 resize (the handle's
 * drag end, the keyboard steps, reset) replaces the picture's whole link in one change (obsidian-1.15.1.asar, read only).
 *
 * The page: real CodeMirror with the plugin's overlay and history, Obsidian's readable-width rules, the picture built as
 * 1.15 builds it in Live Preview (div.internal-embed.media-embed.image-embed.is-loaded > img, inline in its line), 320 by
 * 200 px, decoded before mount. The note: a text line, a blank, the picture alone on its line, a blank, two text lines
 * with a blank between. Infinite Canvas on. Chromium 1440 by 960 at device scale 2. Strokes are real pen input
 * (cdpPen); Attach is attachSelected on the selection (what the round button calls).
 *
 * Cells (each logs PICTURE-ATTACH lines; HW_PICTURE_ATTACH_OUT=<path> appends them to that file):
 * - PA6r: `![[pic.png]]` to `![[pic.png|200]]` in one change: the group still follows the picture's line (no tag), and
 *   after a line typed above the ink still sits on the picture, 0.5 px.
 * - PA6r2: `|200` then `|250`, then a line typed above: the same.
 * - PA6r-undo: the resize, then the editor's undo, then a line typed above: the target is `![[pic.png]]` again, the
 *   same.
 * - PA6r-reopen: the resize, the note saved, closed and reopened: the group is found on the resized link, follows, no
 *   tag, and the ink is where it was.
 * - PA7w B-stale, B-fresh, B-late, and B-fresh with free ink only: the note's Reading view, drawn over the editor's pane
 *   from the same store, records and line signature (the plugin's own providers), open while lines are typed above ink on
 *   a text line in the picture's place, no pause; its text as opened, built again at each character, or built again late.
 *   The ink against the view's line and each member's guard at each change; at rest attached ink is on its line, and free
 *   ink alone paints the view no more once the typing stops.
 * - PA7w B2 (pinned, a named limit): B-fresh on a long note saved and opened again, the group below the lines the editor
 *   has measured: at rest the view does not paint the group.
 * The other PA7 cells (the picture against Live Preview in Reading view and an embed, their text-line control, Obsidian's
 * own Reading view rules, free against attached ink) stay on the cells branch.
 * The page wires what the plugin wires at load (PluginOnload.ts:188-192). The view's ink is read from its painted pixels
 * (paintedBox).
 * Not covered: the real Obsidian widget, its edit mode tooltip and its rename write; a picture that loads late or changes
 * height (S2); ink scaling with a resize (S3, not this step); a picture inside a sentence (S5). Alan's device run only.
 * A theme that centres pictures moves the picture's top left on a resize; the PA6r cells read the ink against it.
 * Plants: none (test only). check:no-sleep runs.
 * Run: npx vitest run --config vitest.render.mts test/render/PictureAttach.test.ts
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type CDPSession, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";
import { penStroke } from "./cdpPen";

declare const process: { env: Record<string, string | undefined> };

const NOTE = "Text above the picture, line one.\n\n![[pic.png]]\n\nText under the picture.\n\nMore text at the end.";
const PIC_LINE = 3;
const PIC_W = 320, PIC_H = 200;
const PAGE_ID = "5c1d2a47-0b6e-4f39-9a83-2e7f6c1b9d04";
const PATH = "picture-note.md";

const PAGE = String.raw`
import { EditorState, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { EditorView, Decoration, WidgetType } from "@codemirror/view";
import { history, undo as historyUndo } from "@codemirror/commands";
import { Platform } from "obsidian";
import { inlineInk, inkOverlayExtension, overlayForPath, setInlineTool, setScrollExpansionEnabled, setShapeSnap, setInkSizeMult } from "../../src/inline/InkOverlay";
import { setInkColorHex } from "../../src/ink/InkColor";
import { setPenInk } from "../../src/inline/PenInk";
import { attachPinsOf } from "../../src/inline/AttachDecoration";
import { attachEmbedInkOnceReady, embedInkChanged, embedInkLinesMoved, initEmbedInkFontRef, initEmbedInkRefresh } from "../../src/inline/EmbedInk";
import { initEmbedInkPrintPaper } from "../../src/inline/EmbedInkPrint";
import { onInkChanged } from "../../src/inline/InkEvents";
import { newestAnchorSignature, splitLines } from "../../src/inline/EmbedInkLines";
import { aboveOf, lineKey, newAboveRun, underSignature } from "../../src/inline/LineAnchor";
import { noteToVisual, visualToNote } from "../../src/inline/ZoomScale";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField } from "./iphoneObsidianStub";
import { parsePage, serializePage } from "../../src/model/PageData";

Object.assign(Platform, { isMobile: false, isDesktop: true, isIosApp: false, isDesktopApp: true, isMobileApp: false, isPhone: false, isWin: true });
installObsidianDom();
const ids = new Map(), sidecars = new Map();
const save = (id, page) => { sidecars.set(id, serializePage(page)); };
inlineInk.attachHost({ readPageId: p => ids.get(p) ?? null, claimId: async (p, id) => { ids.set(p, id); return { pageId: id }; },
	loadSidecar: async id => (sidecars.has(id) ? parsePage(sidecars.get(id), id) : null), scheduleSidecar: save, scheduleSidecarNow: async (id, p) => save(id, p), notify: () => {} });
// What the plugin wires at load (PluginOnload.ts:188-192): the strokes and the note's reference font for every render,
// the export paper (no saved export settings here), and every ink change repainting the rendered roots showing that note.
// The rest (column width, line signature, attach records, canvas note) InkOverlayRegistry.ts wires on import.
initEmbedInkRefresh(p => inlineInk.strokes(p));
initEmbedInkFontRef(p => inlineInk.fontRefPx(p));
initEmbedInkPrintPaper(() => undefined);
onInkChanged(p => embedInkChanged(p));
// What PluginOnloadReload.ts wires on the metadata cache's "changed" for a note: its rendered sections let their read text
// go, and a shown note with an attached group repaints its views. The page has no metadata cache: relineView calls this
// where Obsidian would fire it, once the saved text is parsed.
const linesMoved = (p) => { if (embedInkLinesMoved(p)) embedInkChanged(p); };
window.__wired = ["initEmbedInkRefresh", "initEmbedInkFontRef", "initEmbedInkPrintPaper", "onInkChanged -> embedInkChanged", "metadata changed -> embedInkLinesMoved -> embedInkChanged"];

const frame = () => new Promise(r => requestAnimationFrame(() => r()));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await frame(); };
const rectOf = (r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
const r3 = (v) => Math.round(v * 1000) / 1000;
let rig = null;
const restOf = (overlay, view) => ({ pinchScaleNow: overlay.pinchScaleNow, cssScale: overlay.cssScale, scaleY: view.scaleY,
	pinchPreview: overlay.pinchPreview, repaintQueued: overlay.repaintQueued, scroll: [view.scrollDOM.scrollLeft, view.scrollDOM.scrollTop],
	stroking: overlay.router?.isStroking ?? false, builder: overlay.builder !== null, frameLocked: overlay.frame.locked });
/** Wait for a state, read once a frame, held on two frames running; at the cap throw, naming it. */
const until = async (state, ready, read, cap = 240) => {
	let held = 0;
	for (let i = 0; i <= cap; i++) {
		held = ready() ? held + 1 : 0;
		if (held >= 2) return;
		await frame();
	}
	throw new Error("not reached in " + cap + " frames: " + state + " " + JSON.stringify(read()));
};
const near = (a, b) => Math.abs(a - b) < 1e-6;

/** A picture's link on a line of its own: its file name and its size, as Obsidian writes it. */
const LINK = /^!\[\[([^|\]]+\.png)(?:\|(\d+))?\]\]$/;

/** The picture as Live Preview builds it: div.internal-embed.media-embed.image-embed.is-loaded > img, inline in its line. */
class Pic extends WidgetType {
	constructor(src, name, width) { super(); this.src = src; this.name = name; this.width = width; }
	eq(o) { return o.src === this.src && o.name === this.name && o.width === this.width; }
	toDOM() {
		const d = document.createElement("div"); d.className = "internal-embed media-embed image-embed is-loaded"; d.setAttribute("src", this.name); d.tabIndex = -1;
		const img = d.appendChild(document.createElement("img")); img.src = this.src; img.style.display = "block";
		if (this.width) img.setAttribute("width", String(this.width));
		return d;
	}
}
/** The edit mode's spacer: the picture's height less one text row, a block after the line (1.15, the reveal state). */
class Spacer extends WidgetType {
	constructor(h) { super(); this.h = h; }
	eq(o) { return o.h === this.h; }
	toDOM() { const d = document.createElement("div"); d.className = "picture-edit-spacer"; d.style.height = this.h + "px"; return d; }
	get estimatedHeight() { return this.h; }
}
const setEdit = StateEffect.define();
const editState = StateField.define({ create: () => null, update: (v, tr) => { for (const e of tr.effects) if (e.is(setEdit)) return e.value; return v; } });
function picField(src) {
	const deco = (state) => {
		const b = new RangeSetBuilder(), doc = state.doc, edit = state.field(editState, false);
		for (let i = 1; i <= doc.lines; i++) {
			const l = doc.line(i), m = LINK.exec(l.text);
			if (!m) continue;
			if (edit && edit.line === i) { b.add(l.to, l.to, Decoration.widget({ widget: new Spacer(edit.h), block: true, side: 1 })); continue; }
			b.add(l.from, l.to, Decoration.replace({ widget: new Pic(src, m[1], m[2] ? Number(m[2]) : 0) }));
		}
		return b.finish();
	};
	return StateField.define({ create: deco, update: (v, tr) => (tr.docChanged || tr.effects.some(e => e.is(setEdit)) ? deco(tr.state) : v), provide: f => EditorView.decorations.from(f) });
}
async function pictureSrc(w, h) {
	const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d"); g.fillStyle = "#c8a165"; g.fillRect(0, 0, w, h);
	const src = c.toDataURL("image/png"), img = new Image(); img.src = src; await img.decode(); return src;
}

/** World point to screen px: the inverse of the pen's mapping (the overlay's rect, its input pan, its scale, the camera). */
function toScreen(w) {
	const { overlay } = rig, edge = overlay.container.getBoundingClientRect(), k = overlay.cssScale, s = overlay.camera.worldToScreen(w.x, w.y);
	return { x: edge.left + overlay.inkInputPanX() + noteToVisual(s.x, k), y: edge.top + overlay.inkInputPanY() + noteToVisual(s.y, k) };
}
/** Screen px to a world point, as the pen maps it. */
function toWorld(p) {
	const { overlay } = rig, edge = overlay.container.getBoundingClientRect(), k = overlay.cssScale;
	return overlay.camera.screenToWorld(visualToNote(p.x - edge.left - overlay.inkInputPanX(), k), visualToNote(p.y - edge.top - overlay.inkInputPanY(), k));
}
function picEl() { return rig.view.contentDOM.querySelector(".image-embed img"); }
function picLine() {
	const doc = rig.view.state.doc;
	for (let i = 1; i <= doc.lines; i++) { const l = doc.line(i); if (LINK.test(l.text)) return { n: i, from: l.from, to: l.to, text: l.text }; }
	return null;
}
/** Every stroke of the note as shown now, on screen: its id and its shown box's top left and bottom right. */
function shownNow() {
	const { overlay, path } = rig;
	return inlineInk.strokes(path).map(s => {
		const shown = overlay.lineAnchors.shownOne(s), b = shown ? shown.bbox : null;
		if (!b) return { id: s.id, screen: null };
		const a = toScreen({ x: b.x, y: b.y }), c = toScreen({ x: b.x + b.width, y: b.y + b.height });
		return { id: s.id, screen: { left: r3(a.x), top: r3(a.y), right: r3(c.x), bottom: r3(c.y) } };
	});
}
const key = (o) => JSON.stringify(o);
/** The pen's colour as mountNote sets it; a painted pixel counts as ink within PEN_TOL of it on each channel. */
const PEN_RGB = [0x2f, 0x6d, 0xe0], PEN_TOL = 64;
/**
 * The painted box of ink pixels on the given canvases, screen px: every pixel with any alpha and the pen's colour, each
 * canvas mapped to the screen by its own on-screen rect. The editor and the second views are read by this one rule.
 * n: ink pixels; other: painted pixels of another colour (left out); per: each canvas with ink, its box.
 */
function paintedBox(canvases) {
	let l = 1e9, t = 1e9, rr = -1e9, b = -1e9, n = 0, other = 0;
	const per = [];
	for (const c of canvases) {
		if (!c.width || !c.height) continue;
		const cr = c.getBoundingClientRect();
		if (!cr.width || !cr.height) continue;
		const sx = cr.width / c.width, sy = cr.height / c.height, d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
		let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, k = 0;
		for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
			const i = (y * c.width + x) * 4;
			if (d[i + 3] === 0) continue;
			if (Math.abs(d[i] - PEN_RGB[0]) > PEN_TOL || Math.abs(d[i + 1] - PEN_RGB[1]) > PEN_TOL || Math.abs(d[i + 2] - PEN_RGB[2]) > PEN_TOL) { other++; continue; }
			k++;
			if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
		}
		if (!k) continue;
		const box = { left: cr.left + x0 * sx, top: cr.top + y0 * sy, right: cr.left + (x1 + 1) * sx, bottom: cr.top + (y1 + 1) * sy };
		per.push({ canvas: c.className || "layer canvas " + Array.from(c.parentElement.children).indexOf(c), n: k, box: { left: r3(box.left), top: r3(box.top), right: r3(box.right), bottom: r3(box.bottom) } });
		n += k; l = Math.min(l, box.left); t = Math.min(t, box.top); rr = Math.max(rr, box.right); b = Math.max(b, box.bottom);
	}
	if (!n) return { n: 0, other, per };
	return { left: r3(l), top: r3(t), right: r3(rr), bottom: r3(b), x: r3((l + rr) / 2), y: r3((t + b) / 2), n, other, per };
}
/** The ink layer's canvases under el, a second view's. */
const viewCanvases = (el) => el.querySelectorAll(":scope > canvas.handwriting-embed-ink");
/** Paints of a second view's ink: each clear of a handwriting-embed-ink canvas on the page (EmbedInk.ts clears before it draws). */
let viewPaints = 0;
const clearRect0 = CanvasRenderingContext2D.prototype.clearRect;
CanvasRenderingContext2D.prototype.clearRect = function (...a) {
	if (this.canvas?.isConnected && this.canvas.classList?.contains("handwriting-embed-ink")) viewPaints++;
	return clearRect0.apply(this, a);
};
/** A second view's reference for refText: the paragraph holding it, its top, and its first character's left edge. */
function refOf(h) {
	if (!h.refText) return null;
	const s = h.els.find(e => h.lines.slice(e.lineStart, e.lineEnd + 1).join("\n") === h.refText), p = s ? s.el.querySelector("p") : null, t = p ? p.firstChild : null;
	if (!p || !t || t.nodeType !== 3) return null;
	const rg = document.createRange(); rg.setStart(t, 0); rg.setEnd(t, 1);
	const c = rg.getBoundingClientRect();
	return { left: c.left, top: p.getBoundingClientRect().top };
}
/**
 * Log only: a second view's picture top against its block, screen px. block is the el-p the view measures; p, span (the
 * image-embed) and img each element's top; pMargin the p's top margin; gap is img less block.
 */
function viewPicTop(img) {
	if (!img) return null;
	const block = img.closest(".el-p"), p = img.closest("p"), top = (e) => (e ? r3(e.getBoundingClientRect().top) : null), imgTop = img.getBoundingClientRect().top;
	const cs = p ? getComputedStyle(p) : null;
	return { block: top(block), p: top(p), span: top(img.closest(".image-embed")), img: r3(imgTop), pMargin: cs ? cs.marginTop : null,
		pLineHeight: cs ? cs.lineHeight : null, gap: block ? r3(imgTop - block.getBoundingClientRect().top) : null };
}
/** Log only, the common 6/5.5: a second view's reference paragraph, screen px: its el-p's and p's boxes, the p's margin, its first character's box. */
function viewGeom(h) {
	if (!h.refText) return null;
	const s = h.els.find(e => h.lines.slice(e.lineStart, e.lineEnd + 1).join("\n") === h.refText), p = s ? s.el.querySelector("p") : null, t = p ? p.firstChild : null;
	if (!p || !t || t.nodeType !== 3) return null;
	const rg = document.createRange(); rg.setStart(t, 0); rg.setEnd(t, 1);
	const c = rg.getBoundingClientRect(), pr = p.getBoundingClientRect(), er = s.el.getBoundingClientRect(), cs = getComputedStyle(p);
	return { elp: { left: r3(er.left), top: r3(er.top) }, p: { left: r3(pr.left), top: r3(pr.top), margin: cs.marginTop, padLeft: cs.paddingLeft, lineHeight: cs.lineHeight },
		char: { left: r3(c.left), top: r3(c.top), bottom: r3(c.bottom) } };
}
/** The view's leaf scrolled so the section holding refText sits px under the leaf's top, as a reader scrolled to it. */
function scrollViewTo(leaf, els, lines, refText, px) {
	const s = els.find(e => lines.slice(e.lineStart, e.lineEnd + 1).join("\n") === refText);
	if (!s) return false;
	leaf.scrollTop += s.el.getBoundingClientRect().top - (leaf.getBoundingClientRect().top + px);
	return true;
}
/** The note's sections as the reading renderer splits them: runs of non-blank lines, 0-based. */
function sectionsOf(lines) {
	const sections = [];
	for (let i = 0; i < lines.length; ) {
		if (lines[i].trim() === "") { i++; continue; }
		let j = i;
		while (j + 1 < lines.length && lines[j + 1].trim() !== "") j++;
		sections.push({ lineStart: i, lineEnd: j });
		i = j + 1;
	}
	return sections;
}
/** A section's DOM as the 1.15 reading renderer builds it: a p, or the picture's span and img. */
function sectionHtml(lines, s) {
	const t = lines.slice(s.lineStart, s.lineEnd + 1).join("\n"), m = LINK.exec(t);
	if (!m) return "<p>" + t + "</p>";
	return '<p><span class="internal-embed media-embed image-embed is-loaded" src="' + m[1] + '" alt="' + m[1] + '"><img src="' + rig.src + '"' + (m[2] ? ' width="' + m[2] + '"' : "") + "></span></p>";
}
/** One section handed to the plugin's embed ink, its section info read from the handle at each paint. */
function postProcess(h, s) {
	attachEmbedInkOnceReady(s.el, h.inkRoot, rig.path, () => inlineInk.strokes(rig.path), undefined, false, {
		section: () => ({ text: h.text, lineStart: s.lineStart, lineEnd: s.lineEnd }), cached: () => null });
}
/** The painted centre of the ink under el, screen px; null when nothing is painted. */
function paintedCentre(el) {
	const b = paintedBox(viewCanvases(el));
	return b.n ? { x: b.x, y: b.y } : null;
}

async function mountNote(o) {
	setPenInk(true); setScrollExpansionEnabled(true); setInlineTool("pen"); setShapeSnap(false);
	setInkColorHex("pen", "#2f6de0"); setInkSizeMult("pen", 3);
	const path = o.path;
	ids.set(path, o.pageId);
	if (o.sidecar) sidecars.set(o.pageId, o.sidecar);
	const src = await pictureSrc(o.picW, o.picH);
	const pane = document.body.appendChild(document.createElement("div"));
	pane.className = "markdown-source-view mod-cm6 is-live-preview is-readable-line-width";
	pane.style.cssText = "position:relative;margin-left:" + o.hostLeft + "px;margin-top:" + o.hostTop + "px;width:" + o.paneW + "px;height:" + o.paneH + "px;overflow:hidden";
	const view = new EditorView({ parent: pane, state: EditorState.create({ doc: o.text, extensions: [history(), EditorView.lineWrapping, editState, picField(src),
		editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} })), inkOverlayExtension(),
		EditorView.theme({ "&": { width: o.paneW + "px", height: o.paneH + "px" }, ".cm-scroller": { overflowY: "auto" }, ".cm-content": { fontSize: "16px", lineHeight: "1.5" } })] }) });
	const sizer = document.createElement("div"); sizer.className = "cm-sizer";
	const container = document.createElement("div"); container.className = "cm-contentContainer";
	view.contentDOM.parentElement.insertBefore(sizer, view.contentDOM); sizer.appendChild(container); container.appendChild(view.contentDOM);
	await settle(12);
	const overlay = overlayForPath(path);
	if (!overlay) throw new Error("no overlay for " + path);
	for (let i = 0; i < 90 && !overlay.lineAnchors?.sig; i++) await frame();
	await settle(6);
	rig = { pane, view, overlay, path, pageId: o.pageId, src };
	const img = picEl();
	if (img && !img.complete) await img.decode();
	return { canvas: overlay.canvasModeOn(), strokes: inlineInk.strokes(path).length, attachments: inlineInk.attachments(path).length };
}

window.pictureAttach = {
	/** o: { text, sidecar, zoom, path, pageId, paneW, paneH, hostLeft, hostTop, picW, picH }. */
	async mount(o) {
		const m = await mountNote(o);
		const { overlay, view, pane } = rig;
		let stepped = null;
		if (o.zoom !== 1) {
			stepped = overlay.zoomNoteBy(o.zoom);
			await until("the zoom at rest at " + o.zoom, () => near(overlay.pinchScaleNow, o.zoom) && overlay.panAnchorHold === null && !overlay.pinchPreview &&
				!overlay.repaintQueued && near(overlay.cssScale, o.zoom) && near(view.scaleY, o.zoom), () => restOf(overlay, view));
			// The picture put 40 px in from the pane's top left, so it is whole on the pane at zoom 2.
			const pr = pane.getBoundingClientRect();
			for (let i = 0; i < 3; i++) {
				const r = picEl()?.getBoundingClientRect();
				if (!r) break;
				view.scrollDOM.scrollLeft += r.left - (pr.left + 40);
				view.scrollDOM.scrollTop += r.top - (pr.top + 40);
				view.scrollDOM.dispatchEvent(new Event("scroll", { bubbles: true }));
				await settle(6);
			}
		}
		const sl = view.scrollDOM.scrollLeft, st = view.scrollDOM.scrollTop;
		await until("the scroll settled", () => view.scrollDOM.scrollLeft === sl && view.scrollDOM.scrollTop === st && overlay.lastSyncScrollLeft === sl &&
			overlay.lastSyncScrollTop === st && !overlay.repaintQueued && overlay.panAnchorHold === null, () => restOf(overlay, view));
		return { ...m, stepped, noteZoom: overlay.getNoteViewportState().zoom, cssScale: overlay.cssScale, scaleY: view.scaleY, fontZoom: overlay.fontZoom, pic: this.pic() };
	},
	/** The picture's img on screen, and its line. */
	pic() { const el = picEl(); return { rect: el ? rectOf(el.getBoundingClientRect()) : null, line: picLine() }; },
	/** The line whose text is text, on screen: its block's top and bottom, its first character's left, its last's right. */
	lineRef(text) {
		const { view } = rig, doc = view.state.doc;
		for (let i = 1; i <= doc.lines; i++) {
			const l = doc.line(i);
			if (l.text !== text) continue;
			const a = view.coordsAtPos(l.from, 1), b = view.coordsAtPos(l.to, -1), k = view.lineBlockAt(l.from);
			return a && b ? { n: i, left: a.left, right: b.right, top: view.documentTop + k.top, bottom: view.documentTop + k.bottom } : null;
		}
		return null;
	},
	/**
	 * Log only: the picture's top against its line in the editor, screen px. lineTop is lineBlockAt's top (the line's
	 * block); img, span (the image-embed) and cmLine are each element's top; gap is img less lineTop.
	 */
	picTop() {
		const { view } = rig, img = picEl(), l = picLine();
		if (!img || !l) return null;
		const k = view.lineBlockAt(l.from), lineTop = view.documentTop + k.top, line = img.closest(".cm-line");
		const top = (e) => (e ? r3(e.getBoundingClientRect().top) : null), imgTop = img.getBoundingClientRect().top;
		const cs = line ? getComputedStyle(line) : null;
		return { lineTop: r3(lineTop), lineBottom: r3(view.documentTop + k.bottom), img: r3(imgTop), span: top(img.closest(".image-embed")), cmLine: top(line),
			cmLinePad: cs ? { top: cs.paddingTop, left: cs.paddingLeft } : null, gap: r3(imgTop - lineTop) };
	},
	/**
	 * Log only, the common 6/5.5: the text line's geometry in the editor, screen px: its block's top (lineRef's reference),
	 * its first character's box, its .cm-line's box and padding, and the content's left.
	 */
	lineGeom(text) {
		const { view } = rig, doc = view.state.doc;
		for (let i = 1; i <= doc.lines; i++) {
			const l = doc.line(i);
			if (l.text !== text) continue;
			const a = view.coordsAtPos(l.from, 1), k = view.lineBlockAt(l.from), d = view.domAtPos(l.from).node;
			const line = (d.nodeType === 3 ? d.parentElement : d)?.closest(".cm-line"), lr = line?.getBoundingClientRect(), cs = line ? getComputedStyle(line) : null;
			return { blockTop: r3(view.documentTop + k.top), char: a ? { left: r3(a.left), top: r3(a.top), bottom: r3(a.bottom) } : null,
				cmLine: lr ? { left: r3(lr.left), top: r3(lr.top), padLeft: cs.paddingLeft, padTop: cs.paddingTop, lineHeight: cs.lineHeight } : null,
				contentLeft: r3(view.contentDOM.getBoundingClientRect().left) };
		}
		return null;
	},
	/** The first word of line 1 on screen. */
	firstWord() {
		const { view } = rig, a = view.coordsAtPos(0, 1), b = view.coordsAtPos(4, -1);
		return a && b ? { left: a.left, right: b.right, top: a.top, bottom: a.bottom } : null;
	},
	strokeIds() { return inlineInk.strokes(rig.path).map(s => s.id); },
	/** The editor's ink as painted: every canvas of the overlay's ink layer, read by paintedBox (the second views' rule). */
	painted() { return paintedBox(rig.overlay.inkLayer.querySelectorAll("canvas")); },
	/**
	 * World units for the members ids: the union of their stored boxes, the union of their shown boxes (the editor's
	 * layout), and each named screen box (left, top, right, bottom) mapped through the pen's own screen-to-world.
	 */
	worldBoxes(ids, screens) {
		const { overlay, path } = rig, strokes = inlineInk.strokes(path).filter(s => ids.includes(s.id));
		const union = (bs) => {
			const v = bs.filter(Boolean);
			if (!v.length) return null;
			const x = Math.min(...v.map(q => q.x)), y = Math.min(...v.map(q => q.y)), r = Math.max(...v.map(q => q.x + q.width)), u = Math.max(...v.map(q => q.y + q.height));
			return { x: r3(x), y: r3(y), width: r3(r - x), height: r3(u - y) };
		};
		const out = { stored: union(strokes.map(s => s.bbox)), shown: union(strokes.map(s => overlay.lineAnchors.shownOne(s)?.bbox ?? null)), widths: strokes.map(s => s.width) };
		for (const [name, b] of Object.entries(screens)) {
			if (!b) { out[name] = null; continue; }
			const a = toWorld({ x: b.left, y: b.top }), c = toWorld({ x: b.right, y: b.bottom });
			out[name] = { x: r3(a.x), y: r3(a.y), width: r3(c.x - a.x), height: r3(c.y - a.y) };
		}
		return out;
	},
	async strokeLanded(n) {
		const { overlay, view, path } = rig;
		await until("the stroke landed with the pen up", () => inlineInk.strokes(path).length > n && !(overlay.router?.isStroking ?? false) &&
			overlay.builder === null && !overlay.frame.locked && !overlay.repaintQueued, () => ({ strokes: inlineInk.strokes(path).length, before: n, ...restOf(overlay, view) }), 120);
	},
	/** Select the strokes not in before, ask Attach, wait for the record: the answer and the record. */
	async attachFresh(before) {
		const { overlay, view, path } = rig, old = new Set(before);
		const fresh = inlineInk.strokes(path).filter(s => !old.has(s.id));
		overlay.selection.selectExactly(fresh.map(s => s.id));
		overlay.redrawSelectionUI();
		await settle(2);
		const box = overlay.selectionBounds(), px = view.scaleY * overlay.fontZoom, h = box ? (box.y + box.height / 2) * px : null;
		const block = h !== null ? view.lineBlockAtHeight(h) : null;
		const n0 = inlineInk.attachments(path).length;
		const offered = overlay.attachSelected();
		for (let j = 0; j < 60 && inlineInk.attachments(path).length === n0; j++) await frame();
		await settle(4);
		overlay.selection.clear?.();
		overlay.redrawSelectionUI();
		await settle(2);
		const list = inlineInk.attachments(path), rec = list.length > n0 ? list[list.length - 1] : null;
		return { fresh: fresh.map(s => s.id), offered, box, h, block: block ? { from: block.from, to: block.to, top: block.top, bottom: block.bottom } : null,
			boxCentreScreen: box ? toScreen({ x: box.x + box.width / 2, y: box.y + box.height / 2 }) : null, groupId: rec ? rec.id : null, state: rec ? this.state(rec.id) : null };
	},
	/**
	 * One group now: its record's target (kind, from, to, the stored text, collapsed or not), its ref, whether it follows
	 * its text, whether a held pin (the tag's pin) is shown for it, its members, the picture and every stroke on screen, the
	 * target's first character and its line's top on screen.
	 */
	/** Whether each stroke holds a line anchor in the store now, read with no layout read and no wait. */
	anchorsNow(ids) {
		const strokes = inlineInk.strokes(rig.path);
		return ids.map(id => { const s = strokes.find(x => x.id === id); return !s ? "gone" : s.lineAnchor ? "anchor" : "no anchor"; });
	},
	/** Remember the store's stroke objects now, so a later read can say whether an open kept them or read the file. */
	keepStrokes() {
		window.__keptStrokes = new WeakSet(inlineInk.strokes(rig.path));
		return inlineInk.strokes(rig.path).length;
	},
	/** For each id, whether the store holds the very stroke object keepStrokes saw (an open that kept it in memory). */
	keptNow(ids) {
		const kept = window.__keptStrokes, strokes = inlineInk.strokes(rig.path);
		return ids.map(id => { const s = strokes.find(x => x.id === id); return !!(s && kept && kept.has(s)); });
	},
	/** The note's ink read again from its file, as an outside change to the file is (reloadExternal). */
	async reloadFromFile() {
		return await inlineInk.reloadExternal(rig.path);
	},
	state(groupId) {
		const { overlay, view, path } = rig, list = inlineInk.attachments(path), a = list.find(x => x.id === groupId) ?? null;
		const strokes = inlineInk.strokes(path);
		const pins = attachPinsOf(overlay, list, strokes, performance.now());
		const out = { groupId, record: null, follows: null, heldPin: pins.some(p => p.id === groupId && p.held), pins: pins.map(p => ({ id: p.id, held: p.held })),
			strokeIds: strokes.map(s => s.id), pic: this.pic(), shown: shownNow(), letter: null, lineTop: null, offset: overlay.lineAnchors.follow.groupOffset(groupId),
			doc: view.state.doc.toString() };
		if (!a || a.opaque) return { ...out, opaque: !!a };
		out.record = { strokeIds: a.strokeIds.slice(), target: { kind: a.target.kind, from: a.target.from, to: a.target.to, text: a.target.text, collapsed: a.target.from === a.target.to },
			ref: a.ref, shownKept: a.shown ?? null };
		out.follows = overlay.lineAnchors.follow.followsText(groupId);
		if (a.target.from <= view.state.doc.length) {
			const l = view.coordsAtPos(a.target.from, 1);
			out.letter = l ? rectOf(l) : null;
			out.lineTop = view.lineBlockAt(a.target.from).top;
		}
		return out;
	},
	/** The editor's undo (history), then the layout and the follow at rest. */
	async undo() {
		const done = historyUndo(rig.view);
		await this.rest();
		return { done, doc: rig.view.state.doc.toString() };
	},
	/** One change to the note, as a user event, then the layout and the follow at rest (the ink still on two frames). */
	async edit(changes, userEvent) {
		const { view, overlay } = rig;
		view.dispatch({ changes, userEvent: userEvent ?? "input" });
		rig.editedAt = performance.now();
		await this.rest();
		return { doc: view.state.doc.toString() };
	},
	/**
	 * The editor left quiet: frames until ms have passed since the last edit (or since now, with none) and the old-ink
	 * anchor pass (armed 300 ms after the last update that drew lines, InkOverlayLineAnchors.ts) is not pending, at most
	 * 240 frames. Frame-paced, no timer. Returns the time waited and whether the pass was still pending at the end.
	 */
	async quiet(ms) {
		const { overlay } = rig, t0 = rig.editedAt ?? performance.now(), start = performance.now();
		let n = 0;
		for (; n < 240 && (performance.now() - t0 < ms || overlay.lineAnchorPassTimer > 0); n++) await frame();
		await this.rest();
		return { waitedMs: Math.round(performance.now() - start), sinceEditMs: Math.round(performance.now() - t0), frames: n, passPending: overlay.lineAnchorPassTimer > 0 };
	},
	/**
	 * Each stroke's line anchor against the note's text now, through the guards a read-only view applies before it draws
	 * a stroke at its anchor (EmbedInkLines.ts anchoredDy), in order; the first that fails is named. The view's own two
	 * (a frontmatter line, a line the view gives no top) need its layout and are not read here: "data guards pass".
	 * The signature is the one the view takes: the open editor's, else the newest anchored stroke's. With text, the
	 * lines are that text's (a second view's), else the note's now.
	 */
	guards(ids, text) {
		const { overlay, path, view } = rig, strokes = inlineInk.strokes(path), lines = splitLines(text ?? view.state.doc.toString());
		const sig = overlay.lineAnchorState?.sig ?? newestAnchorSignature(strokes);
		return strokes.filter(s => ids.includes(s.id)).map(s => {
			const a = s.lineAnchor ?? null, out = { id: s.id, anchor: a ? { line: a.line, top: r3(a.top), y: r3(a.y), key: a.key, above: a.above ?? null, width: a.width, fontPx: a.fontPx } : null, bboxY: r3(s.bbox.y), sig, failed: null };
			const i = a ? a.line - 1 : -1;
			if (!a) out.failed = "no anchor";
			else if (!underSignature(a, sig)) out.failed = "signature";
			else if (!Number.isInteger(a.line) || a.line < 1 || a.line > lines.length) out.failed = "line out of range";
			else if (Math.abs(a.y - s.bbox.y) > 0.5) out.failed = "y slack";
			else if (lineKey(lines[i]) !== a.key) out.failed = "line key";
			else if (a.above !== undefined && a.above !== aboveOf(newAboveRun(), i + 1, (k) => lineKey(lines[k - 1]))) out.failed = "lines above";
			else out.failed = "data guards pass";
			return out;
		});
	},
	async rest() {
		const { view, overlay } = rig;
		await settle(4);
		let last = "";
		await until("the ink and the picture at rest", () => {
			const k = key({ s: shownNow(), p: this.pic().rect });
			const same = k === last; last = k;
			return same && !overlay.repaintQueued && overlay.panAnchorHold === null;
		}, () => restOf(overlay, view));
	},
	/** The cursor put at pos, the editor focused, as a click there does. */
	async cursor(pos) {
		const { view } = rig;
		view.focus();
		view.dispatch({ selection: { anchor: pos }, userEvent: "select.pointer" });
		await this.rest();
		return { head: view.state.selection.main.head };
	},
	/** The edit mode on the picture's line, as 1.15 builds it: the link selected, its text drawn, the spacer after. */
	async editMode(h) {
		const { view } = rig, l = picLine();
		view.focus();
		view.dispatch({ selection: { anchor: l.from + 3, head: l.to - 2 }, effects: setEdit.of({ line: l.n, h }), scrollIntoView: false });
		await this.rest();
		const spacer = view.contentDOM.querySelector(".picture-edit-spacer");
		return { line: l, picShown: !!picEl(), spacer: spacer ? rectOf(spacer.getBoundingClientRect()) : null, defaultLineHeight: view.defaultLineHeight };
	},
	/** The group's pin dropped at a screen point: dropAttachPin's answer and the record after its measure. */
	async dropPin(groupId, p) {
		const { path } = rig, before = key(inlineInk.attachments(path).find(a => a.id === groupId));
		const w = toWorld(p);
		const taken = rig.overlay.dropAttachPin(groupId, w);
		for (let j = 0; j < 60 && key(inlineInk.attachments(path).find(a => a.id === groupId)) === before; j++) await frame();
		await this.rest();
		return { taken, world: w, notices: (window.__notices ?? []).slice(), state: this.state(groupId) };
	},
	/** The note written out, the view closed; returns the saved ink file. */
	async close() {
		const { path, pageId, view, pane } = rig;
		inlineInk.save(path);
		await settle(4);
		const saved = sidecars.get(pageId) ?? null;
		view.destroy(); pane.remove();
		await settle(4);
		return { saved };
	},
	/**
	 * The note's ink written out as a save does, the view left open. Returns the file on disk after it and whether this
	 * save wrote it (false: the older file stands, as on disk).
	 */
	async saveNow() {
		const { path, pageId } = rig, before = sidecars.get(pageId) ?? null;
		// The last file set aside first, so an older save is never read as this one; put back if nothing is written.
		sidecars.delete(pageId);
		inlineInk.save(path);
		await settle(4);
		const wrote = sidecars.has(pageId);
		if (!wrote && before !== null) sidecars.set(pageId, before);
		return { saved: sidecars.get(pageId) ?? null, wrote };
	},
	/**
	 * The note as a second view draws it, over the editor's pane as Reading view takes the leaf: kind "reading" is the
	 * note's reading view, kind "embed" is another note whose reading view embeds this one under a line of its own. Each
	 * section is post-processed with its own section info, as the renderer gives it; the picture as the reading renderer
	 * builds it (a span.internal-embed in a p, loaded: media-embed image-embed is-loaded and its img). The ink comes from the
	 * store, its records and the editor's line signature through the plugin's own providers. Returns the painted centre of
	 * the ink layer's pixels and the picture's rect, screen px; with refText, the top of the paragraph holding that text
	 * and its first character's left edge (the control's reference).
	 */
	async secondView(kind, refText) {
		const out = await this.openView(kind, refText);
		this.closeView();
		await settle(2);
		return out;
	},
	/**
	 * The second view built and left open (secondView's build, without the close): its sections stay as the text was
	 * at the open, as a Reading view's do until Obsidian renders the note again. readView reads it, closeView removes it.
	 */
	async openView(kind, refText) {
		const h = await this.buildView(kind, refText), { leaf, layerHost } = h;
		// A print's layer may be split in strips: every canvas under it is read there.
		const canvases = () => (kind === "print" ? leaf.querySelectorAll("canvas") : viewCanvases(layerHost));
		const centre = () => { const b = paintedBox(canvases()); return b.n ? { x: b.x, y: b.y } : null; };
		let painted = null;
		for (let i = 0; i < 60 && !painted; i++) { await frame(); painted = centre(); }
		await settle(4);
		painted = centre();
		const img = leaf.querySelector(".image-embed img");
		const box = paintedBox(canvases());
		const out = { kind, sections: h.sections, painted, paintedBox: box.n ? { left: box.left, top: box.top, right: box.right, bottom: box.bottom, n: box.n, other: box.other } : null,
			pic: img ? rectOf(img.getBoundingClientRect()) : null, ref: refOf(h), layers: leaf.querySelectorAll("canvas.handwriting-embed-ink").length,
			canvases: Array.from(leaf.querySelectorAll("canvas")).map(c => ({ cls: c.className, w: c.width, h: c.height })), svgs: leaf.querySelectorAll("svg").length,
			picTop: viewPicTop(img), geom: viewGeom(h) };
		rig.second = h;
		return out;
	},
	/**
	 * The second view's DOM built from the note's text now, over the editor's pane (any earlier one removed), each
	 * section handed to the plugin's embed ink; returns at once, before the ink paints. The handle keeps the text built.
	 */
	async buildView(kind, refText) {
		const { view, path } = rig, text = view.state.doc.toString(), lines = text.split("\n");
		const sections = sectionsOf(lines), html = (s) => sectionHtml(lines, s);
		document.querySelector(".picture-second-view")?.remove();
		const leaf = document.body.appendChild(document.createElement("div"));
		leaf.className = "picture-second-view markdown-reading-view";
		const pr = rig.pane.getBoundingClientRect();
		leaf.style.cssText = "position:fixed;left:" + pr.left + "px;top:" + pr.top + "px;width:" + pr.width + "px;height:" + pr.height + "px;overflow:auto;background:#fff;z-index:50";
		const preview = (parent) => {
			const root = parent.appendChild(document.createElement("div")); root.className = "markdown-preview-view markdown-rendered is-readable-line-width";
			const sizer = root.appendChild(document.createElement("div")); sizer.className = "markdown-preview-sizer markdown-preview-section";
			sizer.appendChild(document.createElement("div")).className = "markdown-preview-pusher";
			sizer.appendChild(document.createElement("div")).className = "mod-header";
			return { root, sizer };
		};
		if (kind === "print") {
			// Export to PDF, as Obsidian's print() builds it: div.print > a preview view with no sizer, each block in a div of
			// its own, laid out whole (no scroller). The renderer gives no section info: the line source is the cache's.
			leaf.className = "picture-second-view print";
			leaf.style.cssText = "position:absolute;left:" + pr.left + "px;top:" + pr.top + "px;width:" + pr.width + "px;background:#fff;z-index:50";
			const root = leaf.appendChild(document.createElement("div")); root.className = "markdown-preview-view markdown-rendered";
			root.style.height = "auto"; root.style.overflow = "visible";
			const cached = sections.map(s => ({ type: "paragraph", lineStart: s.lineStart, lineEnd: s.lineEnd }));
			const els = sections.map(s => { const el = root.appendChild(document.createElement("div")); el.innerHTML = html(s); return { el, ...s }; });
			for (const img of Array.from(leaf.querySelectorAll("img"))) if (!img.complete) await img.decode();
			await frame();
			// The page scrolled so the reference line is on screen (closeView scrolls back): a layer that paints only what
			// is shown still paints it.
			const at = refText ? els.find(e => lines.slice(e.lineStart, e.lineEnd + 1).join("\n") === refText) : null;
			if (at) window.scrollBy(0, at.el.getBoundingClientRect().top - 200);
			const h = { kind, refText, text, lines, sections, els, leaf, layerHost: root, inkRoot: root };
			// Obsidian's Export to PDF runs the post-processor once, on the print container itself (its element and its
			// container are both the root), not on each block: the blocks are the root's children, laid out under it.
			attachEmbedInkOnceReady(root, root, rig.path, () => inlineInk.strokes(rig.path), undefined, false, { section: () => null, cached: () => ({ sections: cached, text: h.text }) });
			return h;
		}
		let layerHost, inkRoot, sizerOf;
		const host = preview(leaf);
		if (kind === "reading") {
			layerHost = host.root; inkRoot = host.root; sizerOf = host.sizer;
		} else {
			const above = host.sizer.appendChild(document.createElement("div")); above.innerHTML = "<p>A host note's line above the embed.</p>";
			const wrap = host.sizer.appendChild(document.createElement("div"));
			const p = wrap.appendChild(document.createElement("p"));
			const embed = p.appendChild(document.createElement("span")); embed.className = "internal-embed markdown-embed inline-embed is-loaded"; embed.setAttribute("src", "picture-note");
			const content = embed.appendChild(document.createElement("div")); content.className = "markdown-embed-content";
			const inner = content.appendChild(document.createElement("div")); inner.className = "markdown-preview-view markdown-rendered";
			layerHost = content; inkRoot = inner; sizerOf = inner;
		}
		const els = sections.map(s => { const el = sizerOf.appendChild(document.createElement("div")); el.className = "el-p"; el.innerHTML = html(s); return { el, ...s }; });
		for (const img of Array.from(leaf.querySelectorAll("img"))) if (!img.complete) await img.decode();
		await frame();
		// viewAt set (the long-note cell): the view opened scrolled to its reference line, before the ink is handed over.
		if (rig.viewAt != null && refText) scrollViewTo(leaf, els, lines, refText, rig.viewAt);
		// Each section's info is read from the handle when the ink paints, as Obsidian's getSectionInfo reads its renderer's
		// sections then: relineView moves the lines and text under sections it does not build again.
		const h = { kind, refText, text, lines, sections, els, leaf, layerHost, inkRoot };
		for (const s of els) postProcess(h, s);
		return h;
	},
	/**
	 * Obsidian's render of the saved note, for a view opened before the typing (its sections as built at the open): the
	 * typed lines' new sections are built and post-processed above the old ones, and each old section keeps its DOM and
	 * its post-processing, its section info now on the new lines. Then what the metadata cache's "changed" runs (linesMoved).
	 * Answers the sections added.
	 */
	relineView() {
		const h = rig.second, text = rig.view.state.doc.toString(), lines = text.split("\n"), sections = sectionsOf(lines);
		const added = sections.length - h.els.length;
		h.els.forEach((e, i) => { e.lineStart = sections[added + i].lineStart; e.lineEnd = sections[added + i].lineEnd; });
		h.text = text; h.lines = lines; h.sections = sections;
		const first = h.els[0].el, made = [];
		for (let i = 0; i < added; i++) {
			const el = first.parentElement.insertBefore(document.createElement("div"), first); el.className = "el-p"; el.innerHTML = sectionHtml(lines, sections[i]);
			made.push({ el, ...sections[i] });
		}
		h.els = [...made, ...h.els];
		for (const s of made) postProcess(h, s);
		linesMoved(rig.path);
		return added;
	},
	/** The open second view's ink as painted now, its reference now, and the paints counted so far. */
	readView() { const h = rig.second; return { box: paintedBox(viewCanvases(h.layerHost)), ref: refOf(h), paints: viewPaints }; },
	closeView() { rig.second?.leaf.remove(); rig.second = null; if (window.scrollY) window.scrollTo(0, 0); },
	/**
	 * text typed at the note's start one character per everyFrames frames (no pause near 300 ms) while the second view
	 * stays open, then frames until 600 ms after the last character and the old-ink anchor pass done (at most 240), then
	 * 4 more. fresh: the view is built again from the note's text after every character (as Obsidian's render of the
	 * changed note gives it); else it keeps the text it was opened on. The view is read every frame; a row is kept each
	 * time the ink against the view's line, or a member's first failing guard against the view's text, changes: the
	 * frame, ms since the first character, characters typed, the phase, whether the anchor pass is pending, the paints
	 * so far (clears of the view's ink canvas), the ink against the line, each member's guard.
	 */
	async typeLive(text, everyFrames, mode, ids) {
		const { view, overlay } = rig, t0 = performance.now(), rows = [], paints0 = viewPaints, fresh = mode === "fresh";
		let f = 0, typed = 0, last = "", builds = 0, relined = null;
		const read = (phase) => {
			const { box: b, ref } = this.readView(), against = b.n && ref ? { x: r3(b.x - ref.left), y: r3(b.y - ref.top) } : null;
			const guards = this.guards(ids, rig.second.text).map(g => g.failed);
			const k = key([against, guards]);
			if (k === last) return;
			last = k;
			rows.push({ f, ms: Math.round(performance.now() - t0), typed, phase, passPending: overlay.lineAnchorPassTimer > 0, paints: viewPaints - paints0, builds, against, guards });
		};
		read("before");
		for (let i = 0; i < text.length; i++) {
			view.dispatch({ changes: { from: i, insert: text[i] }, userEvent: "input.type" });
			rig.editedAt = performance.now();
			typed++;
			if (fresh) { rig.second = await this.buildView(rig.second.kind, rig.second.refText); builds++; }
			for (let j = 0; j < everyFrames; j++) { await frame(); f++; read("typing"); }
		}
		const typedMs = Math.round(performance.now() - t0), paintsTyped = viewPaints - paints0;
		for (let n = 0; n < 240 && (performance.now() - rig.editedAt < 600 || overlay.lineAnchorPassTimer > 0); n++) { await frame(); f++; read("quiet"); }
		// late: Obsidian's render of the saved note, about 2 s after the last edit (its save), past the anchor pass.
		if (mode === "late") {
			for (let n = 0; n < 240 && performance.now() - rig.editedAt < 2000; n++) { await frame(); f++; read("saving"); }
			relined = { at: Math.round(performance.now() - t0), added: this.relineView() };
			for (let n = 0; n < 20; n++) { await frame(); f++; read("relined"); }
		}
		for (let n = 0; n < 4; n++) { await frame(); f++; read("rest"); }
		return { rows, frames: f, typedMs, ms: Math.round(performance.now() - t0), paints: viewPaints - paints0, paintsTyped, relined, builds, passPending: overlay.lineAnchorPassTimer > 0, doc: view.state.doc.toString() };
	},
	/** Second views built from now on open scrolled so their reference line sits px under the view's top (null: at the top). */
	viewAt(px) { rig.viewAt = px; return px; },
	/** The editor scrolled so the line whose text is text sits px under the pane's top, then the layout at rest. */
	async scrollEditorTo(text, px) {
		const { view, pane } = rig, doc = view.state.doc;
		let pos = -1;
		for (let i = 1; i <= doc.lines && pos < 0; i++) if (doc.line(i).text === text) pos = doc.line(i).from;
		if (pos < 0) return null;
		for (let i = 0; i < 4; i++) {
			const c = view.coordsAtPos(pos, 1), pr = pane.getBoundingClientRect();
			view.scrollDOM.scrollTop = c ? view.scrollDOM.scrollTop + c.top - (pr.top + px) : view.lineBlockAt(pos).top - px;
			view.scrollDOM.dispatchEvent(new Event("scroll", { bubbles: true }));
			await settle(6);
		}
		await this.rest();
		return { scrollTop: view.scrollDOM.scrollTop, line: this.lineRef(text) };
	},
	/** The editor's measured line prefix (the anchors' last measured line), the line holding text, the viewport, the scroll. */
	measuredNow(text) {
		const { view, overlay } = rig, doc = view.state.doc;
		let n = null;
		for (let i = 1; i <= doc.lines && n === null; i++) if (doc.line(i).text === text) n = i;
		return { measured: overlay.lineAnchorState?.measured ?? null, line: n, lines: doc.lines, viewport: { from: view.viewport.from, to: view.viewport.to },
			viewportLines: { from: doc.lineAt(view.viewport.from).number, to: doc.lineAt(view.viewport.to).number }, scrollTop: view.scrollDOM.scrollTop };
	},
	/** The same note opened again on the given text, its ink file as saved. */
	async reopen(o, groupId) {
		const m = await mountNote(o);
		await this.rest();
		return { mount: m, state: this.state(groupId), attachments: inlineInk.attachments(rig.path).map(a => ({ id: a.id, target: a.target })) };
	},
};
`;

const DSF = 2;
const WINDOW = "1440,960";
const HOST = { paneW: 900, paneH: 820, hostLeft: 244, hostTop: 76 };

let browser: Browser | null = null;
let script = "";

beforeAll(async () => {
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "pictureAttachPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./attachOrionObsidian.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true, args: [`--force-device-scale-factor=${DSF}`, `--window-size=${WINDOW}`] });
}, 180_000);
afterAll(async () => {
	if (browser) await browser.close();
});

type Pt = { x: number; y: number };
type R = { left: number; right: number; top: number; bottom: number };
type Shown = { id: string; screen: R | null };
type State = {
	groupId: string;
	record: { strokeIds: string[]; target: { kind: string; from: number; to: number; text: string; collapsed: boolean }; ref: Pt; shownKept: { dx: number; dy: number } | null } | null;
	follows: boolean | null; heldPin: boolean; strokeIds: string[]; pic: { rect: R | null; line: { n: number; from: number; to: number; text: string } | null };
	shown: Shown[]; letter: R | null; lineTop: number | null; doc: string;
};

const call = (p: Page, method: string, ...args: unknown[]) => p.evaluate(([n, a]) => (window as any).pictureAttach[n](...a), [method, args] as const) as Promise<any>;

function log(cell: string, data: unknown) {
	const line = `PICTURE-ATTACH ${JSON.stringify({ cell, ...(data as object) })}`;
	// eslint-disable-next-line no-console
	console.log(line);
	if (process.env.HW_PICTURE_ATTACH_OUT) appendFileSync(process.env.HW_PICTURE_ATTACH_OUT, line + "\n");
}

/** Each stroke's top left less the picture's top left, screen px, by id. */
function offsets(s: State): Map<string, Pt> {
	const out = new Map<string, Pt>(), p = s.pic.rect;
	if (!p) return out;
	for (const k of s.shown) if (k.screen) out.set(k.id, { x: k.screen.left - p.left, y: k.screen.top - p.top });
	return out;
}
/** The largest move of any stroke against the picture between two states, screen px, per axis; and the strokes missing. */
function drift(a: State, b: State, ids: readonly string[]): { dx: number; dy: number; missing: string[] } {
	const oa = offsets(a), ob = offsets(b), missing: string[] = [];
	let dx = 0, dy = 0;
	for (const id of ids) {
		const p = oa.get(id), q = ob.get(id);
		if (!p || !q) { missing.push(id); continue; }
		dx = Math.max(dx, Math.abs(q.x - p.x));
		dy = Math.max(dy, Math.abs(q.y - p.y));
	}
	return { dx, dy, missing };
}

/** A small zigzag in a rect, six turns. */
function zigzag(r: R): Pt[] {
	const pts: Pt[] = [];
	for (let i = 0; i <= 12; i++) pts.push({ x: i % 2 === 0 ? r.left + 1 : r.right - 1, y: r.top + 2 + (r.bottom - r.top - 4) * i / 12 });
	return pts;
}

async function draw(cdp: CDPSession, page: Page, points: Pt[]) {
	const n = (await call(page, "strokeIds") as string[]).length;
	await penStroke(cdp, points, { pressure: 0.5, between: async (i) => { if (i % 3 === 0) await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null)))); } });
	await call(page, "strokeLanded", n);
}

type Rig = { page: Page; cdp: CDPSession; errors: string[]; mount: any };

async function open(zoom: number, text = NOTE): Promise<Rig> {
	const page = await (await browser!.newContext({ viewport: null })).newPage();
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	page.on("console", msg => { const t = msg.text(); if (/plugin crashed|isn't allowed during an update/.test(t)) errors.push(("console: " + t).slice(0, 200)); });
	await page.setContent('<!doctype html><body class="theme-light" style="margin:0"></body>');
	await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
	await page.addScriptTag({ content: script });
	const mount = await call(page, "mount", { ...HOST, text, sidecar: null, zoom, path: PATH, pageId: PAGE_ID, picW: PIC_W, picH: PIC_H });
	const cdp = await page.context().newCDPSession(page);
	if (!wiringLogged) { wiringLogged = true; log("wiring", { from: "PluginOnload.ts:188-192", wired: await page.evaluate(() => (window as any).__wired ?? null) }); }
	return { page, cdp, errors, mount };
}
let wiringLogged = false;

/** Two strokes on the picture (a zigzag over its centre, a line under it, both on it), selected, Attach. */
async function attachOnPicture(r: Rig) {
	const pic = (await call(r.page, "pic")).rect as R;
	const cx = (pic.left + pic.right) / 2, cy = (pic.top + pic.bottom) / 2, k = (pic.right - pic.left) / PIC_W;
	const before = await call(r.page, "strokeIds") as string[];
	await draw(r.cdp, r.page, zigzag({ left: cx - 30 * k, right: cx + 30 * k, top: cy - 25 * k, bottom: cy + 15 * k }));
	await draw(r.cdp, r.page, Array.from({ length: 9 }, (_, i) => ({ x: cx - 40 * k + i * 10 * k, y: cy + 30 * k })));
	const a = await call(r.page, "attachFresh", before);
	return { ...a, pic } as { fresh: string[]; offered: boolean; groupId: string | null; state: State | null; pic: R; box: unknown; block: unknown; boxCentreScreen: Pt | null };
}

type LineRef = { n: number; left: number; right: number; top: number; bottom: number };

/** Two strokes on a text line (a zigzag over its first words, a stroke along its middle), selected, Attach. */
async function attachOnLine(r: Rig, text: string) {
	const l = await call(r.page, "lineRef", text) as LineRef;
	const before = await call(r.page, "strokeIds") as string[];
	const right = Math.min(l.right - 10, l.left + 140);
	await draw(r.cdp, r.page, zigzag({ left: l.left + 20, right: l.left + 80, top: l.top + 3, bottom: l.bottom - 3 }));
	await draw(r.cdp, r.page, Array.from({ length: 9 }, (_, i) => ({ x: l.left + 30 + i * (right - l.left - 40) / 8, y: (l.top + l.bottom) / 2 })));
	const a = await call(r.page, "attachFresh", before);
	return { ...a, line: l } as { fresh: string[]; offered: boolean; groupId: string | null; state: State | null; line: LineRef };
}

const premises = (r: Rig, zoom: number) => {
	expect(r.mount.canvas, "premise: Infinite Canvas on").toBe(true);
	expect(r.mount.noteZoom, "premise: the note's zoom is the arm's").toBeCloseTo(zoom, 6);
	expect(r.mount.attachments, "premise: the note opens with no attach record").toBe(0);
	expect(r.mount.pic.rect, "premise: the picture is drawn").not.toBeNull();
	expect(r.mount.pic.line?.n, "premise: the picture is alone on its line").toBe(PIC_LINE);
};

it("PA6r: a picture resized from its handle keeps its ink: the group follows and rides a line typed above", async () => {
	const r = await open(1);
	try {
		premises(r, 1);
		const a = await attachOnPicture(r);
		expect(a.state?.record, "premise: attached").not.toBeNull();
		const id = a.groupId!, s0 = await call(r.page, "state", id) as State, line = s0.pic.line!;
		// The handle's drag end: the picture's whole link replaced in one change (1.15). The ink against the picture's top
		// left holds across the resize only because the rig's picture is left-aligned; a theme that centres pictures moves
		// that corner on a resize. A green here: check PA1's stored target text first (a collapsed target is found again
		// when the inserted text holds it, InkAttachments.ts refindCollapsed).
		await call(r.page, "edit", { from: line.from, to: line.to, insert: "![[pic.png|200]]" });
		const s1 = await call(r.page, "state", id) as State;
		await call(r.page, "edit", { from: 0, insert: "Typed line.\n\n" }, "input.type");
		const s2 = await call(r.page, "state", id) as State;
		const resized = drift(s0, s1, a.fresh), typed = drift(s1, s2, a.fresh);
		const moved = s2.pic.rect && s1.pic.rect ? s2.pic.rect.top - s1.pic.rect.top : null;
		log("PA6r", { groupId: id, s0, s1, s2, resized, typed, moved, errors: r.errors });
		expect(r.errors, "page errors").toEqual([]);
		expect(s1.pic.rect && s1.pic.rect.right - s1.pic.rect.left, "premise: the picture is 200 px wide in css px").toBeCloseTo(200, 0);
		expect(moved, "premise: the picture moved down when a line was typed above").toBeGreaterThan(20);
		expect(s1.record?.target.collapsed, `the resize keeps the target (${JSON.stringify(s1.record?.target)})`).toBe(false);
		expect(s1.follows, "the group still follows the picture's line").toBe(true);
		expect(s1.heldPin, "no Drag the pin to the text tag").toBe(false);
		expect(Math.max(resized.dx, resized.dy), "the resize leaves the ink at the picture's top left, screen px").toBeLessThanOrEqual(0.5);
		expect(typed.missing, "every stroke shown").toEqual([]);
		expect(Math.max(typed.dx, typed.dy), "after a line typed above, the ink still sits on the picture, screen px").toBeLessThanOrEqual(0.5);
	} finally {
		await r.page.context().close();
	}
}, 120_000);

/** Attached on the picture, then the picture's link replaced by `link` in one change, as a resize does. */
async function attachAndResize(r: Rig, ...links: string[]) {
	premises(r, 1);
	const a = await attachOnPicture(r);
	expect(a.state?.record, "premise: attached").not.toBeNull();
	const id = a.groupId!, s0 = await call(r.page, "state", id) as State;
	for (const link of links) {
		const line = (await call(r.page, "state", id) as State).pic.line!;
		await call(r.page, "edit", { from: line.from, to: line.to, insert: link });
	}
	return { a, id, s0, s1: await call(r.page, "state", id) as State };
}

/** The group kept: on a link to the picture, following it, no tag; and it rides a line typed above, 0.5 px. */
async function keptAndRides(r: Rig, cell: string, id: string, fresh: readonly string[], s0: State, s1: State, link: string, extra: object = {}) {
	await call(r.page, "edit", { from: 0, insert: "Typed line.\n\n" }, "input.type");
	const s2 = await call(r.page, "state", id) as State;
	const kept = drift(s0, s1, fresh), typed = drift(s1, s2, fresh);
	const moved = s2.pic.rect && s1.pic.rect ? s2.pic.rect.top - s1.pic.rect.top : null;
	log(cell, { groupId: id, s0, s1, s2, kept, typed, moved, ...extra, errors: r.errors });
	expect(r.errors, "page errors").toEqual([]);
	expect(moved, "premise: the picture moved down when a line was typed above").toBeGreaterThan(20);
	expect(s1.record?.target.collapsed, `the target is kept (${JSON.stringify(s1.record?.target)})`).toBe(false);
	expect(s1.record?.target.text, "the target is the picture's link as it is now").toBe(link);
	expect(s1.follows, "the group still follows the picture's line").toBe(true);
	expect(s1.heldPin, "no Drag the pin to the text tag").toBe(false);
	expect(Math.max(kept.dx, kept.dy), "the ink stays at the picture's top left, screen px").toBeLessThanOrEqual(0.5);
	expect(typed.missing, "every stroke shown").toEqual([]);
	expect(Math.max(typed.dx, typed.dy), "after a line typed above, the ink still sits on the picture, screen px").toBeLessThanOrEqual(0.5);
}

it("PA6r2: a picture resized twice keeps its ink: the group follows and rides a line typed above", async () => {
	const r = await open(1);
	try {
		const { a, id, s0, s1 } = await attachAndResize(r, "![[pic.png|200]]", "![[pic.png|250]]");
		expect(s1.pic.rect && s1.pic.rect.right - s1.pic.rect.left, "premise: the picture is 250 px wide in css px").toBeCloseTo(250, 0);
		await keptAndRides(r, "PA6r2", id, a.fresh, s0, s1, "![[pic.png|250]]");
	} finally {
		await r.page.context().close();
	}
}, 120_000);

it("PA6r-undo: a resize undone keeps the ink: the target is the first link again, follows and rides a line typed above", async () => {
	const r = await open(1);
	try {
		const { a, id, s0 } = await attachAndResize(r, "![[pic.png|200]]");
		const u = await call(r.page, "undo");
		const s1 = await call(r.page, "state", id) as State;
		expect(u.done, "premise: the editor's history undid the resize").toBe(true);
		expect(s1.doc, "premise: the note holds the first link again").toContain("![[pic.png]]\n");
		expect(s1.pic.rect && s1.pic.rect.right - s1.pic.rect.left, "premise: the picture is 320 px wide again").toBeCloseTo(PIC_W, 0);
		await keptAndRides(r, "PA6r-undo", id, a.fresh, s0, s1, "![[pic.png]]");
	} finally {
		await r.page.context().close();
	}
}, 120_000);

it("PA6r-reopen: a resized picture's note saved and reopened finds the group on the resized link", async () => {
	const r = await open(1);
	try {
		const { a, id, s0, s1 } = await attachAndResize(r, "![[pic.png|200]]");
		const closed = await call(r.page, "close");
		const saved = closed.saved ? JSON.parse(closed.saved).attachments : null;
		const re = await call(r.page, "reopen", { ...HOST, text: s1.doc, sidecar: closed.saved, zoom: 1, path: PATH, pageId: PAGE_ID, picW: PIC_W, picH: PIC_H }, id);
		const s2 = re.state as State;
		expect(closed.saved, "premise: the page was saved at close").not.toBeNull();
		expect(s2.pic.rect && s2.pic.rect.right - s2.pic.rect.left, "premise: the reopened picture is 200 px wide").toBeCloseTo(200, 0);
		await keptAndRides(r, "PA6r-reopen", id, a.fresh, s0, s2, "![[pic.png|200]]", { saved, reopened: re.attachments });
	} finally {
		await r.page.context().close();
	}
}, 120_000);

const TYPED_ABOVE = "Typed line one.\n\nTyped line two.\n\n";
type View2 = { painted: Pt | null; paintedBox: (R & { n: number; other: number }) | null; pic: R | null; ref: { left: number; top: number } | null; picTop?: unknown; geom?: unknown };

/**
 * The control note: the same note with a text line in the picture's place, the group drawn on that line (PA7w and its
 * B2 pin).
 */
const CONTROL_LINE = "A text line in the picture's place, long enough to write on.";
const CONTROL_NOTE = NOTE.replace("![[pic.png]]", CONTROL_LINE);
/** A member's anchor and the first read-only-view guard it fails. */
type GuardRow = { id: string; anchor: { line: number; top: number; y: number } | null; bboxY: number; failed: string };

/**
 * PA7w (measure, no finding asserted): Reading view open while lines are typed above attached ink with no pause. The
 * control note, a group attached on its line, the Reading view opened over the editor's pane and left open; then
 * TYPED_ABOVE typed at the note's start one character every 6 frames (about 100 ms), then the editor left quiet (600 ms
 * and the anchor pass). Two arms. B-stale: the view keeps the text it was opened on (Reading view before Obsidian renders
 * the changed note), so its line does not move and its text no longer matches the anchors. B-fresh: the view built again
 * from the note's text after every character (Obsidian's render of the changed note). A row each time the ink against
 * the view's line, or a member's first failing guard against the view's text, changes (typeLive); d is that ink against
 * the line less where it was before the typing. A move while typing in B-fresh: the view jumped with the store.
 */
const r3n = (v: number) => Math.round(v * 1000) / 1000;
type LiveRow = { f: number; ms: number; typed: number; phase: string; passPending: boolean; paints: number; builds: number; against: Pt | null; guards: string[] };
const PA7W = [["attached", "stale"], ["attached", "fresh"], ["attached", "late"], ["free", "fresh"]] as const;
for (const [kind, mode] of PA7W) it(`PA7w B-${mode}${kind === "free" ? ", free ink only" : ""}: Reading view open while lines are typed above ${kind} ink, no pause: where the view paints the ink at each repaint${mode === "stale" ? "" : kind === "free" ? "; the views are not painted again once the typing stops" : "; at rest the ink is on its line"}`, async () => {
	const r = await open(1, CONTROL_NOTE);
	try {
		expect(r.mount.canvas, "premise: Infinite Canvas on").toBe(true);
		expect(r.mount.attachments, "premise: the note opens with no attach record").toBe(0);
		let ids: string[], id = "none";
		if (kind === "attached") {
			const a = await attachOnLine(r, CONTROL_LINE);
			expect(a.state?.record, `premise: attached (Attach offered: ${a.offered})`).not.toBeNull();
			ids = a.fresh; id = a.groupId!;
		} else {
			const l = await call(r.page, "lineRef", CONTROL_LINE) as LineRef, before = await call(r.page, "strokeIds") as string[];
			await draw(r.cdp, r.page, zigzag({ left: l.left + 20, right: l.left + 80, top: l.top + 3, bottom: l.bottom - 3 }));
			ids = (await call(r.page, "strokeIds") as string[]).filter(x => !before.includes(x));
			expect(ids.length, "premise: one free stroke drawn").toBe(1);
		}
		const a = { fresh: ids };
		const v = await call(r.page, "openView", "reading", CONTROL_LINE) as View2;
		const geom = { editor: await call(r.page, "lineGeom", CONTROL_LINE), view: v.geom ?? null };
		const t = await call(r.page, "typeLive", TYPED_ABOVE, 6, mode, a.fresh) as { rows: LiveRow[]; frames: number; typedMs: number; ms: number; paints: number; paintsTyped: number; relined: { at: number; added: number } | null; builds: number; passPending: boolean; doc: string };
		await call(r.page, "closeView");
		const s = await call(r.page, "state", id) as State;
		const guards = await call(r.page, "guards", a.fresh) as GuardRow[];
		const base = t.rows[0]?.against ?? null;
		const rows = t.rows.map(x => ({ ...x, d: x.against && base ? { dx: r3n(x.against.x - base.x), dy: r3n(x.against.y - base.y) } : null }));
		const off = (x: typeof rows[number]) => x.d !== null && Math.max(Math.abs(x.d.dx), Math.abs(x.d.dy)) > 1.5;
		const rest = rows[rows.length - 1] ?? null, paintsAfterTyping = t.paints - t.paintsTyped;
		log("PA7w", { arm: "B-" + mode, kind, groupId: id, ref: v.ref, geom, base, rest: rest?.d ?? null, paintsAfterTyping, relined: t.relined, typedMs: t.typedMs, ms: t.ms, frames: t.frames, paints: t.paints, builds: t.builds, passPending: t.passPending,
			movedWhileTyping: rows.filter(x => x.phase === "typing" && off(x)).length, movedAfter: rows.filter(x => x.phase !== "typing" && x.phase !== "before" && off(x)).length,
			unpaintedRows: rows.filter(x => x.against === null).length, rows,
			target: s.record?.target ?? null, shownKept: s.record?.shownKept ?? null, follows: s.follows, guards, docTyped: t.doc.startsWith(TYPED_ABOVE), errors: r.errors });
		expect(r.errors, "page errors").toEqual([]);
		expect(v.ref, "premise: Reading view draws the line").not.toBeNull();
		expect(base, "premise: Reading view paints the group before the typing").not.toBeNull();
		expect(t.doc.startsWith(TYPED_ABOVE), "premise: every character typed").toBe(true);
		expect(t.passPending, "premise: the anchor pass done at the end").toBe(false);
		if (mode === "late") expect(t.relined?.added, "premise: the typed lines rendered as new sections above").toBeGreaterThan(0);
		if (mode === "stale") return;
		if (kind === "free") {
			expect(paintsAfterTyping, "free ink only: no paint of the view once the typing stopped").toBe(0);
			return;
		}
		if (mode === "fresh") expect(paintsAfterTyping, "at most one paint of the view once the typing stopped").toBeLessThanOrEqual(1);
		expect(rest?.d, "at rest: the view paints the group").not.toBeNull();
		expect(Math.max(Math.abs(rest!.d!.dx), Math.abs(rest!.d!.dy)), `at rest: the group against its line in the view, as before the typing (${JSON.stringify(rest?.d)}), screen px`).toBeLessThanOrEqual(1.5);
	} finally {
		await r.page.context().close();
	}
	if (mode !== "fresh" || kind !== "attached") return;
	// Log only (B-fresh rides it): the picture note as drawn, the picture's top against its line in the editor and
	// against its block in Reading view and the embed. Ink against the picture sat about 19 px lower than on a text line;
	// a gap here that differs by about 19 names where the product's line or block top and the picture part.
	const p = await open(1);
	try {
		const editor = await call(p.page, "picTop");
		const reading = await call(p.page, "secondView", "reading") as View2, embed = await call(p.page, "secondView", "embed") as View2;
		const rt = reading.picTop as { gap: number | null } | null, et = embed.picTop as { gap: number | null } | null, eg = (editor as { gap: number } | null)?.gap ?? null;
		log("PA7pic", { editor, reading: reading.picTop ?? null, embed: embed.picTop ?? null,
			readingLessEditor: rt?.gap != null && eg != null ? r3n(rt.gap - eg) : null, embedLessEditor: et?.gap != null && eg != null ? r3n(et.gap - eg) : null, errors: p.errors });
	} finally {
		await p.page.context().close();
	}
}, 120_000);

/**
 * PA7w B2: B-fresh with the group below the lines the editor has measured this session. A long note (LONG_FILLER blank-
 * separated filler lines, then the control note), the group attached on the control line with the editor scrolled to
 * it, the note saved, closed and opened again (as PA6r-reopen; the editor comes back scrolled to the group), so the
 * editor this session has measured lines from the top only part way down. A Reading view opened scrolled to the group, the lines typed at the note's start
 * as PA7w B-fresh, then the editor left quiet. At rest each member holds an anchor that passes every guard against the
 * view's text, and the view paints the group on its line as before the typing, where no measure has read the lines
 * between. The editor's measured prefix is logged at the reopen, before the typing and at rest, with each member's first
 * failing guard; a red cell says whether the view painted the group off its place or not at all.
 */
const LONG_FILLER = 150;
const LONG_NOTE = Array.from({ length: LONG_FILLER }, (_, i) => `Filler line ${i + 1}, plain text above the ink.`).join("\n\n") + "\n\n" + CONTROL_NOTE;
it("PA7w B2: a long note saved and opened again, Reading view open on attached ink far below the editor's measured lines, lines typed above with no pause: at rest the view paints the ink on its line", async () => {
	const r = await open(1, LONG_NOTE);
	try {
		expect(r.mount.canvas, "premise: Infinite Canvas on").toBe(true);
		expect(r.mount.attachments, "premise: the note opens with no attach record").toBe(0);
		const sc = await call(r.page, "scrollEditorTo", CONTROL_LINE, 200);
		expect(sc?.line, "premise: the editor scrolled to the control line").not.toBeNull();
		const a = await attachOnLine(r, CONTROL_LINE);
		expect(a.state?.record, `premise: attached (Attach offered: ${a.offered})`).not.toBeNull();
		const id = a.groupId!, ids = a.fresh;
		const s0 = await call(r.page, "state", id) as State;
		const closed = await call(r.page, "close");
		expect(closed.saved, "premise: the page was saved at close").not.toBeNull();
		const re = await call(r.page, "reopen", { ...HOST, text: s0.doc, sidecar: closed.saved, zoom: 1, path: PATH, pageId: PAGE_ID, picW: PIC_W, picH: PIC_H }, id);
		const s1 = re.state as State;
		const atReopen = await call(r.page, "measuredNow", CONTROL_LINE);
		const guardsReopen = await call(r.page, "guards", ids) as GuardRow[];
		await call(r.page, "viewAt", 200);
		const v = await call(r.page, "openView", "reading", CONTROL_LINE) as View2;
		const geom = { editor: await call(r.page, "lineGeom", CONTROL_LINE), view: v.geom ?? null };
		const beforeTyping = await call(r.page, "measuredNow", CONTROL_LINE);
		const t = await call(r.page, "typeLive", TYPED_ABOVE, 6, "fresh", ids) as { rows: LiveRow[]; frames: number; typedMs: number; ms: number; paints: number; paintsTyped: number; relined: unknown; builds: number; passPending: boolean; doc: string };
		await call(r.page, "closeView");
		const atRest = await call(r.page, "measuredNow", CONTROL_LINE);
		const s2 = await call(r.page, "state", id) as State;
		const guards = await call(r.page, "guards", ids) as GuardRow[];
		const base = t.rows[0]?.against ?? null;
		const rows = t.rows.map(x => ({ ...x, d: x.against && base ? { dx: r3n(x.against.x - base.x), dy: r3n(x.against.y - base.y) } : null }));
		const off = (x: typeof rows[number]) => x.d !== null && Math.max(Math.abs(x.d.dx), Math.abs(x.d.dy)) > 1.5;
		const rest = rows[rows.length - 1] ?? null, paintsAfterTyping = t.paints - t.paintsTyped;
		log("PA7wB2", { groupId: id, filler: LONG_FILLER, scrolled: sc, reopened: re.attachments, atReopen, beforeTyping, atRest, guardsReopen, guards, ref: v.ref, geom, base, rest: rest?.d ?? null,
			paintsAfterTyping, typedMs: t.typedMs, ms: t.ms, frames: t.frames, paints: t.paints, builds: t.builds, passPending: t.passPending,
			movedWhileTyping: rows.filter(x => x.phase === "typing" && off(x)).length, movedAfter: rows.filter(x => x.phase !== "typing" && x.phase !== "before" && off(x)).length,
			unpaintedRows: rows.filter(x => x.against === null).length, rows,
			targetReopen: s1.record?.target ?? null, target: s2.record?.target ?? null, shownKept: s2.record?.shownKept ?? null, follows: s2.follows, docTyped: t.doc.startsWith(TYPED_ABOVE), errors: r.errors });
		expect(r.errors, "page errors").toEqual([]);
		expect(s1.record, "premise: the reopened note holds the group's record").not.toBeNull();
		expect(atReopen.measured != null && atReopen.measured < atReopen.line!, `premise: the reopened editor has not measured down to the group's line (${JSON.stringify(atReopen)})`).toBe(true);
		expect(beforeTyping.measured != null && beforeTyping.measured < beforeTyping.line!, `premise: still not measured down to it once the view is open (${JSON.stringify(beforeTyping)})`).toBe(true);
		expect(v.ref, "premise: Reading view draws the line").not.toBeNull();
		expect(base, "premise: Reading view paints the group before the typing").not.toBeNull();
		expect(t.doc.startsWith(TYPED_ABOVE), "premise: every character typed").toBe(true);
		expect(t.passPending, "premise: the anchor pass done at the end").toBe(false);
		// The typing at the note's top cut the editor's measured lines above the group: the members' anchors are carried
		// with the text, never taken away, so the view keeps painting the group on its line.
		expect(atRest.measured != null && atRest.measured < atRest.line!, `premise: at rest the editor has not measured down to the group's line (${JSON.stringify(atRest)})`).toBe(true);
		expect(guards.map(g => g.failed), `at rest every member holds an anchor that passes the view's guards (${JSON.stringify(guards)})`).toEqual(ids.map(() => "data guards pass"));
		const why = !rest?.against ? "absent" : off(rest) ? "off its place" : "on its line";
		expect(why, `at rest the view paints the group on its line, as before the typing (${JSON.stringify(rest?.d ?? null)}), screen px`).toBe("on its line");
	} finally {
		await r.page.context().close();
	}
}, 180_000);

/**
 * LN: the long note of PA7w B2, saved and opened again, read by a read-only view built fresh (Reading view, or an
 * Export to PDF's print container) twice: right after the reopen with nothing typed, and again after TYPED_ABOVE typed
 * at the note's start in one go and the editor left quiet. Each read logs the group against its line (null: nothing
 * painted), the members' guards and the editor's measured prefix. d is the typed read less the untyped one. The print
 * container's canvas layer is read; the vector layer a print swaps in is not. Reading view: a measure, no outcome
 * asserted. Export to PDF: the group is on its line, within 1.5 screen px of where a fresh Reading view draws it before
 * the typing, and the typing does not move it (Obsidian's own export on Rogue puts it on its line at four depths).
 */
for (const kind of ["reading", "print"] as const) it(kind === "reading"
	? "LN Reading view (measure): a long note opened again, attached ink far below the editor's measured lines, built fresh before and after lines typed at the top: where it draws the group"
	: "LN Export to PDF: a long note opened again, attached ink far below the editor's measured lines, built fresh before and after lines typed at the top: it draws the group on its line, where a fresh Reading view does, before and after the typing", async () => {
	const r = await open(1, LONG_NOTE);
	try {
		expect(r.mount.canvas, "premise: Infinite Canvas on").toBe(true);
		const sc = await call(r.page, "scrollEditorTo", CONTROL_LINE, 200);
		expect(sc?.line, "premise: the editor scrolled to the control line").not.toBeNull();
		const a = await attachOnLine(r, CONTROL_LINE);
		expect(a.state?.record, `premise: attached (Attach offered: ${a.offered})`).not.toBeNull();
		const id = a.groupId!, ids = a.fresh;
		const s0 = await call(r.page, "state", id) as State;
		const closed = await call(r.page, "close");
		expect(closed.saved, "premise: the page was saved at close").not.toBeNull();
		const re = await call(r.page, "reopen", { ...HOST, text: s0.doc, sidecar: closed.saved, zoom: 1, path: PATH, pageId: PAGE_ID, picW: PIC_W, picH: PIC_H }, id);
		await call(r.page, "viewAt", 200);
		const read = async () => {
			const v = await call(r.page, "openView", kind, CONTROL_LINE) as View2 & { canvases: unknown; svgs: number; layers: number };
			await call(r.page, "closeView");
			return { against: v.painted && v.ref ? { x: r3n(v.painted.x - v.ref.left), y: r3n(v.painted.y - v.ref.top) } : null, ref: v.ref, paintedBox: v.paintedBox,
				layers: v.layers, canvases: v.canvases, svgs: v.svgs, guards: (await call(r.page, "guards", ids) as GuardRow[]).map(g => ({ failed: g.failed, anchor: g.anchor })),
				measured: await call(r.page, "measuredNow", CONTROL_LINE) };
		};
		// The print read's reference: where a fresh Reading view draws the group, nothing typed.
		const reading = kind === "print" ? await readFresh(r, "reading", ids) : null;
		const untyped = await read();
		await call(r.page, "edit", { from: 0, insert: TYPED_ABOVE }, "input.type");
		const quiet = await call(r.page, "quiet", 600);
		const typed = await read();
		const s1 = await call(r.page, "state", id) as State;
		const d = untyped.against && typed.against ? { dx: r3n(typed.against.x - untyped.against.x), dy: r3n(typed.against.y - untyped.against.y) } : null;
		log("LN", { kind, groupId: id, filler: LONG_FILLER, scrolled: sc, reopened: re.attachments, reading: reading?.against ?? null, untyped, typed, d, quiet,
			target: s1.record?.target ?? null, shownKept: s1.record?.shownKept ?? null, follows: s1.follows, docTyped: s1.doc.startsWith(TYPED_ABOVE), errors: r.errors });
		expect(r.errors, "page errors").toEqual([]);
		expect(untyped.ref, "premise: the view draws the line before the typing").not.toBeNull();
		expect(typed.ref, "premise: the view draws the line after the typing").not.toBeNull();
		expect(s1.doc.startsWith(TYPED_ABOVE), "premise: the lines typed").toBe(true);
		expect((untyped.measured as { measured: number | null; line: number }).measured! < (untyped.measured as { line: number }).line, `premise: the reopened editor has not measured down to the group's line (${JSON.stringify(untyped.measured)})`).toBe(true);
		if (kind === "print") {
			expect(reading!.against, "premise: a fresh Reading view paints the group").not.toBeNull();
			// Soft: each of the two is told, the second too when the first fails.
			expect.soft(placeOf(untyped.against, reading!.against), `the export draws the group where a fresh Reading view does, nothing typed (${JSON.stringify({ print: untyped.against, reading: reading!.against })}), screen px`).toBe("on its line");
			expect.soft(placeOf(typed.against, untyped.against), `the export draws the group where it did before the typing (${JSON.stringify(d)}), screen px`).toBe("on its line");
		}
	} finally {
		await r.page.context().close();
	}
}, 240_000);

/**
 * LN-save: the long note of LN, opened again, a Reading view built fresh before the typing, lines typed at the top, the
 * editor left quiet, a Reading view built fresh, then the ink saved with the note still open and the saved file read:
 * each member's line anchor as written. Then the editor scrolled down to the group's line, left quiet, a Reading view
 * built fresh again, a second save and its file read. Each time every member's anchor is in the file on the group's
 * line, passes the view's guards, and the view paints the group where it did before the typing; a red cell says whether
 * the view painted it off its place or not at all. The rig's save writes the file in one go (serializePage), not in
 * slices (named limit).
 */
it("LN-save: a long note opened again, lines typed at the top, the ink saved with the note open, then the editor scrolled down to the group and saved again: each time every member's line anchor is on disk on the group's line, and Reading view paints the group on its line", async () => {
	const r = await open(1, LONG_NOTE);
	try {
		expect(r.mount.canvas, "premise: Infinite Canvas on").toBe(true);
		const sc = await call(r.page, "scrollEditorTo", CONTROL_LINE, 200);
		expect(sc?.line, "premise: the editor scrolled to the control line").not.toBeNull();
		const a = await attachOnLine(r, CONTROL_LINE);
		expect(a.state?.record, `premise: attached (Attach offered: ${a.offered})`).not.toBeNull();
		const id = a.groupId!, ids = a.fresh;
		const s0 = await call(r.page, "state", id) as State;
		const closed = await call(r.page, "close");
		expect(closed.saved, "premise: the page was saved at close").not.toBeNull();
		const onDisk = (saved: string | null) => {
			if (!saved) return null;
			const strokes = (JSON.parse(saved).strokes ?? []) as { id: string; lineAnchor?: unknown }[];
			return ids.map(sid => { const s = strokes.find(x => x.id === sid); return { id: sid, inFile: !!s, lineAnchor: s?.lineAnchor ?? null }; });
		};
		const atClose = onDisk(closed.saved);
		const re = await call(r.page, "reopen", { ...HOST, text: s0.doc, sidecar: closed.saved, zoom: 1, path: PATH, pageId: PAGE_ID, picW: PIC_W, picH: PIC_H }, id);
		await call(r.page, "viewAt", 200);
		const measuredAtReopen = await call(r.page, "measuredNow", CONTROL_LINE);
		const step = async () => {
			const v = await call(r.page, "openView", "reading", CONTROL_LINE) as View2;
			await call(r.page, "closeView");
			const guards = (await call(r.page, "guards", ids) as GuardRow[]).map(g => ({ failed: g.failed, anchor: g.anchor }));
			const measured = await call(r.page, "measuredNow", CONTROL_LINE);
			const save = await call(r.page, "saveNow") as { saved: string | null; wrote: boolean };
			return { drawn: !!v.painted, against: v.painted && v.ref ? { x: r3n(v.painted.x - v.ref.left), y: r3n(v.painted.y - v.ref.top) } : null, ref: v.ref,
				guards, measured, wrote: save.wrote, onDisk: onDisk(save.saved) };
		};
		// Where the view paints the group before the typing: each later read is told against it.
		const v0 = await call(r.page, "openView", "reading", CONTROL_LINE) as View2;
		await call(r.page, "closeView");
		const untyped = v0.painted && v0.ref ? { x: r3n(v0.painted.x - v0.ref.left), y: r3n(v0.painted.y - v0.ref.top) } : null;
		await call(r.page, "edit", { from: 0, insert: TYPED_ABOVE }, "input.type");
		const quiet1 = await call(r.page, "quiet", 600);
		const typed = await step();
		const sc2 = await call(r.page, "scrollEditorTo", CONTROL_LINE, 200);
		const quiet2 = await call(r.page, "quiet", 600);
		const scrolled = await step();
		const s1 = await call(r.page, "state", id) as State;
		log("LN-save", { groupId: id, filler: LONG_FILLER, scrolled0: sc, reopened: re.attachments, atClose, measuredAtReopen, untyped, quiet1, typed, scrolledTo: sc2, quiet2, scrolled,
			target: s1.record?.target ?? null, follows: s1.follows, docTyped: s1.doc.startsWith(TYPED_ABOVE), errors: r.errors });
		expect(r.errors, "page errors").toEqual([]);
		expect(s1.doc.startsWith(TYPED_ABOVE), "premise: the lines typed").toBe(true);
		expect(sc2?.line, "premise: the editor scrolled down to the group's line after the typing").not.toBeNull();
		expect((measuredAtReopen as { measured: number | null; line: number }).measured! < (measuredAtReopen as { line: number }).line, `premise: the reopened editor has not measured down to the group's line (${JSON.stringify(measuredAtReopen)})`).toBe(true);
		expect(untyped, "premise: the view paints the group before the typing").not.toBeNull();
		// Each member's line at close, moved down by the lines typed above it: the line its words are on now.
		const typedLines = TYPED_ABOVE.split("\n").length - 1;
		const lineNow = (sid: string) => ((atClose?.find(m => m.id === sid)?.lineAnchor as { line: number } | null)?.line ?? NaN) + typedLines;
		expect(atClose?.map(m => m.lineAnchor !== null), `premise: every member anchored at close (${JSON.stringify(atClose)})`).toEqual(ids.map(() => true));
		for (const [name, s] of [["typed", typed], ["scrolled", scrolled]] as const) {
			expect(s.wrote, `premise: the ${name} save wrote the file`).toBe(true);
			expect(s.onDisk?.map(m => m.lineAnchor === null ? `${m.id} absent` : `${m.id} on line ${(m.lineAnchor as { line: number }).line}`),
				`${name}: each member's line anchor in the saved file, on its line at close moved down ${typedLines} (${JSON.stringify(s.onDisk)})`).toEqual(ids.map(sid => `${sid} on line ${lineNow(sid)}`));
			expect(s.guards.map(g => g.failed), `${name}: every member's anchor passes the view's guards (${JSON.stringify(s.guards)})`).toEqual(ids.map(() => "data guards pass"));
			const d = s.against && untyped ? Math.max(Math.abs(s.against.x - untyped.x), Math.abs(s.against.y - untyped.y)) : null;
			const why = d === null ? "absent" : d > 1.5 ? "off its place" : "on its line";
			expect(why, `${name}: a fresh Reading view paints the group on its line, as before the typing (${JSON.stringify({ against: s.against, untyped })}), screen px`).toBe("on its line");
		}
	} finally {
		await r.page.context().close();
	}
}, 240_000);

/** Each listed member as a saved ink file holds it: in the file, and its line anchor (null for none). */
const anchorsOnDisk = (saved: string | null, ids: readonly string[]) => {
	if (!saved) return null;
	const strokes = (JSON.parse(saved).strokes ?? []) as { id: string; lineAnchor?: unknown }[];
	return ids.map(sid => { const s = strokes.find(x => x.id === sid); return { id: sid, inFile: !!s, lineAnchor: s?.lineAnchor ?? null }; });
};

/** A fresh read-only view of the note, opened and closed: the group against the control line, the guards, the measured prefix. */
const readFresh = async (r: Rig, kind: "reading" | "print", ids: readonly string[]) => {
	const v = await call(r.page, "openView", kind, CONTROL_LINE) as View2 & { canvases: unknown; svgs: number; layers: number };
	await call(r.page, "closeView");
	return { against: v.painted && v.ref ? { x: r3n(v.painted.x - v.ref.left), y: r3n(v.painted.y - v.ref.top) } : null, ref: v.ref, paintedBox: v.paintedBox,
		guards: (await call(r.page, "guards", ids) as GuardRow[]).map(g => ({ failed: g.failed, anchor: g.anchor })),
		measured: await call(r.page, "measuredNow", CONTROL_LINE) as { measured: number | null; line: number } };
};

/** "on its line" within 1.5 screen px of `ref`, "off its place" past it, "absent" when nothing was painted. */
const placeOf = (at: { x: number; y: number } | null, ref: { x: number; y: number } | null) =>
	!at || !ref ? "absent" : Math.max(Math.abs(at.x - ref.x), Math.abs(at.y - ref.y)) > 1.5 ? "off its place" : "on its line";

/**
 * LN-near: the long note of LN, opened again with the editor at the group, and the lines typed just above the control
 * note, inside the lines the editor draws, not at the note's start. A fresh Reading view before and after: at rest the
 * group is on its line and every member's anchor passes the view's guards, the editor's measured lines still short of it.
 */
it("LN-near: a long note opened again, lines typed just above attached ink inside the editor's drawn lines, its measured lines short of the ink: a fresh Reading view paints the group on its line", async () => {
	const r = await open(1, LONG_NOTE);
	try {
		expect(r.mount.canvas, "premise: Infinite Canvas on").toBe(true);
		const sc = await call(r.page, "scrollEditorTo", CONTROL_LINE, 200);
		expect(sc?.line, "premise: the editor scrolled to the control line").not.toBeNull();
		const a = await attachOnLine(r, CONTROL_LINE);
		expect(a.state?.record, `premise: attached (Attach offered: ${a.offered})`).not.toBeNull();
		const id = a.groupId!, ids = a.fresh;
		const s0 = await call(r.page, "state", id) as State;
		const closed = await call(r.page, "close");
		expect(closed.saved, "premise: the page was saved at close").not.toBeNull();
		const re = await call(r.page, "reopen", { ...HOST, text: s0.doc, sidecar: closed.saved, zoom: 1, path: PATH, pageId: PAGE_ID, picW: PIC_W, picH: PIC_H }, id);
		await call(r.page, "viewAt", 200);
		const untyped = await readFresh(r, "reading", ids);
		const at = s0.doc.indexOf(CONTROL_NOTE);
		await call(r.page, "edit", { from: at, insert: TYPED_ABOVE }, "input.type");
		const quiet = await call(r.page, "quiet", 600);
		const typed = await readFresh(r, "reading", ids);
		const s1 = await call(r.page, "state", id) as State;
		const place = placeOf(typed.against, untyped.against);
		log("LN-near", { groupId: id, filler: LONG_FILLER, at, scrolled: sc, reopened: re.attachments, untyped, typed, place, quiet, target: s1.record?.target ?? null, follows: s1.follows, errors: r.errors });
		expect(r.errors, "page errors").toEqual([]);
		expect(at > 0 && s1.doc.slice(at, at + TYPED_ABOVE.length) === TYPED_ABOVE, "premise: the lines typed just above the control note").toBe(true);
		expect(untyped.against, "premise: the view paints the group before the typing").not.toBeNull();
		expect(typed.measured.measured! < typed.measured.line, `premise: at rest the editor has not measured down to the group's line (${JSON.stringify(typed.measured)})`).toBe(true);
		expect(typed.guards.map(g => g.failed), `at rest every member's anchor passes the view's guards (${JSON.stringify(typed.guards)})`).toEqual(ids.map(() => "data guards pass"));
		expect(place, `at rest a fresh Reading view paints the group on its line, as before the typing (${JSON.stringify({ typed: typed.against, untyped: untyped.against })}), screen px`).toBe("on its line");
	} finally {
		await r.page.context().close();
	}
}, 240_000);

/**
 * LN-save-short: a short note (the control note), a group attached, lines typed at its start and the ink saved at once,
 * well inside the quiet time before the old-ink pass runs: every member's line anchor is in the saved file.
 */
it("LN-save-short: a short note, lines typed above attached ink and the ink saved at once, before the old-ink pass: every member's line anchor is in the saved file", async () => {
	const r = await open(1, CONTROL_NOTE);
	try {
		expect(r.mount.canvas, "premise: Infinite Canvas on").toBe(true);
		const a = await attachOnLine(r, CONTROL_LINE);
		expect(a.state?.record, `premise: attached (Attach offered: ${a.offered})`).not.toBeNull();
		const ids = a.fresh;
		const rested = await call(r.page, "saveNow") as { saved: string | null; wrote: boolean };
		const t0 = Date.now();
		await call(r.page, "edit", { from: 0, insert: TYPED_ABOVE }, "input.type");
		const save = await call(r.page, "saveNow") as { saved: string | null; wrote: boolean };
		const ms = Date.now() - t0;
		const before = anchorsOnDisk(rested.saved, ids), after = anchorsOnDisk(save.saved, ids);
		log("LN-save-short", { ids, ms, quietMs: 300, before, after, wrote: save.wrote, errors: r.errors });
		expect(r.errors, "page errors").toEqual([]);
		expect(before?.map(m => m.lineAnchor !== null), `premise: every member anchored in the file before the typing (${JSON.stringify(before)})`).toEqual(ids.map(() => true));
		expect(save.wrote, "premise: the save after the typing wrote the file").toBe(true);
		expect(ms < 300, `premise: saved inside the quiet time before the old-ink pass (${ms} ms)`).toBe(true);
		expect(after?.map(m => m.lineAnchor === null ? `${m.id} absent` : `${m.id} kept`), `each member's line anchor in the file saved at once (${JSON.stringify(after)})`).toEqual(ids.map(sid => `${sid} kept`));
	} finally {
		await r.page.context().close();
	}
}, 120_000);

/**
 * LN-short: the control for LN's Export to PDF read. The short control note, a group attached, saved, closed and
 * opened again, read by a fresh Reading view and a fresh print container with nothing typed: the print container draws
 * the group against its line where Reading view does, within 1.5 screen px.
 */
it("LN-short: a short note opened again, attached ink, Reading view and Export to PDF built fresh with nothing typed: the export draws the group on its line, where Reading view does", async () => {
	const r = await open(1, CONTROL_NOTE);
	try {
		expect(r.mount.canvas, "premise: Infinite Canvas on").toBe(true);
		const a = await attachOnLine(r, CONTROL_LINE);
		expect(a.state?.record, `premise: attached (Attach offered: ${a.offered})`).not.toBeNull();
		const id = a.groupId!, ids = a.fresh;
		const s0 = await call(r.page, "state", id) as State;
		const closed = await call(r.page, "close");
		expect(closed.saved, "premise: the page was saved at close").not.toBeNull();
		const re = await call(r.page, "reopen", { ...HOST, text: s0.doc, sidecar: closed.saved, zoom: 1, path: PATH, pageId: PAGE_ID, picW: PIC_W, picH: PIC_H }, id);
		await call(r.page, "viewAt", 200);
		const reading = await readFresh(r, "reading", ids);
		const print = await readFresh(r, "print", ids);
		log("LN-short", { groupId: id, reopened: re.attachments, reading, print, errors: r.errors });
		expect(r.errors, "page errors").toEqual([]);
		expect(reading.ref, "premise: Reading view draws the line").not.toBeNull();
		expect(reading.against, "premise: Reading view paints the group").not.toBeNull();
		expect(print.ref, "premise: the export draws the line").not.toBeNull();
		expect(placeOf(print.against, reading.against), `the export draws the group where Reading view does (${JSON.stringify({ print: print.against, reading: reading.against })}), screen px`).toBe("on its line");
	} finally {
		await r.page.context().close();
	}
}, 180_000);

/**
 * LN-heal (measure, no outcome asserted): a long note whose file was saved with no member anchors (as the published build
 * writes it after this defect), opened scrolled down to the group, nothing typed. Read first from the file as saved with
 * anchors (the reference), then from the same file with the members' anchors taken out: where a fresh Reading view draws
 * the group against the reference, and whether the old-ink pass gives the members anchors once the editor is quiet.
 */
it("LN-heal (measure): a long note saved with no member line anchors, opened scrolled down to the group, nothing typed: where Reading view draws the group, and whether the old-ink pass anchors the members", async () => {
	const r = await open(1, LONG_NOTE);
	try {
		expect(r.mount.canvas, "premise: Infinite Canvas on").toBe(true);
		const sc = await call(r.page, "scrollEditorTo", CONTROL_LINE, 200);
		expect(sc?.line, "premise: the editor scrolled to the control line").not.toBeNull();
		const a = await attachOnLine(r, CONTROL_LINE);
		expect(a.state?.record, `premise: attached (Attach offered: ${a.offered})`).not.toBeNull();
		const id = a.groupId!, ids = a.fresh;
		const s0 = await call(r.page, "state", id) as State;
		const closed = await call(r.page, "close");
		expect(closed.saved, "premise: the page was saved at close").not.toBeNull();
		const host = { ...HOST, text: s0.doc, zoom: 1, path: PATH, pageId: PAGE_ID, picW: PIC_W, picH: PIC_H };
		await call(r.page, "reopen", { ...host, sidecar: closed.saved }, id);
		await call(r.page, "viewAt", 200);
		const reference = await readFresh(r, "reading", ids);
		await call(r.page, "keepStrokes");
		await call(r.page, "close");
		const file = JSON.parse(closed.saved!) as { strokes: { id: string; lineAnchor?: unknown }[] };
		for (const s of file.strokes) if (ids.includes(s.id)) delete s.lineAnchor;
		const stripped = JSON.stringify(file);
		const re = await call(r.page, "reopen", { ...host, sidecar: stripped }, id);
		// As the note opens: whether the store kept the stroke objects from before the close, and whether they hold anchors.
		const atReopen = { kept: await call(r.page, "keptNow", ids) as boolean[], anchors: await call(r.page, "anchorsNow", ids) as string[] };
		// The ink read from the stripped file, before the view scrolls to the group, where an old-ink pass may anchor them.
		const reloaded = await call(r.page, "reloadFromFile") as boolean;
		const atMount = await call(r.page, "anchorsNow", ids) as string[];
		await call(r.page, "viewAt", 200);
		const atOpen = await readFresh(r, "reading", ids);
		const quiet = await call(r.page, "quiet", 600);
		const atRest = await readFresh(r, "reading", ids);
		log("LN-heal", { groupId: id, filler: LONG_FILLER, reopened: re.attachments, reference, atReopen, reloaded, atMount, atOpen, atRest, quiet,
			placeAtOpen: placeOf(atOpen.against, reference.against), placeAtRest: placeOf(atRest.against, reference.against),
			healedAtOpen: atOpen.guards.map(g => g.failed !== "no anchor"), healed: atRest.guards.map(g => g.failed !== "no anchor"), errors: r.errors });
		expect(r.errors, "page errors").toEqual([]);
		expect(reference.against, "premise: the view paints the group from the file with anchors").not.toBeNull();
		expect(reloaded, "premise: the ink was read again from the stripped file").toBe(true);
		expect(atMount, "premise: the stripped file's members load with no anchor").toEqual(ids.map(() => "no anchor"));
	} finally {
		await r.page.context().close();
	}
}, 240_000);
