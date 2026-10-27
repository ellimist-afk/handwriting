/**
 * INK STAYS ON ITS LINE WHEN THE EDITOR RE-MEASURES THE TEXT ABOVE IT; TYPING STILL NEVER MOVES INK.
 *
 * CodeMirror estimates the height of every line it has not drawn. When those estimates change - a zoom re-reads the
 * editor's line height from whichever short line happens to be drawn, or scrolling draws and measures the lines - the
 * text below them moves in the document and ink that sits at a fixed page position slides off the words it was written
 * on. Alan saw it on his Untitled 2 note: a ctrl+wheel zoom moved the text about a dozen lines under the ink.
 *
 * The document here is synthetic. It has the line shapes of that note (lengths, headings, quotes, rules and blank lines
 * in the same order, the ink on line 74 at column 75) and none of its words. Minimal, dark, readable line length off,
 * inline title on, a four-row Properties block above the text, line numbers on, a 26 px font, Infinite Canvas on,
 * window 1440 by 960 with the pane sized as on Alan's desktop. Device scale: forced through Chromium's
 * `--force-device-scale-factor=2`, never a page deviceScaleFactor. The first page each browser opens is mounted and
 * discarded: it starts with a different line-height estimate from every later page.
 *
 * Three cells, each on two mounts that must agree:
 *  - zoom: ctrl+wheel notches from 100 percent to about 50 and back, the pointer still on the ink. At every settle the
 *    text row under the ink's centre is the row it was written on, and the ink's centre is within one line of it.
 *  - scroll: no zoom; scroll up to the top through the lines never drawn, then back to the same scrollTop. The row under
 *    the ink is the row it was written on.
 *  - typing: a wrapped paragraph inserted three lines above the ink. The editor lays the paragraph out under its old
 *    guess and measures it in the next frame, and that measure may also re-measure the lines above. The typing moves no
 *    ink; the re-measure moves the ink with its line. So after the settle the ink's own words sit exactly the typed
 *    block's measured height lower under the ink than before (within one px).
 *  - lasso: the stroke lasso-moved to the line ten below, then the zoom cell's notches. The drop leaves the ink where the
 *    drag put it, on its new words, with its anchor on the line under its top, and the zoom keeps it on them.
 *  - insert space: two lines opened over the ink's line, then the editor's undo and redo of that step. After each, the
 *    ink sits on its words as at the rest, and its anchor names their line: the document change moves the anchor once.
 *
 * Run: npm run test:render -- test/render/InkStaysOnItsLine.test.ts. HW_INK_LINE_REPORT=<path> writes every row.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

const INLINE_TITLE_CSS = `
body { --h1-line-height: 1.2; --h1-size: 1.618em; --h1-weight: 700; --h1-font: inherit; --h1-style: normal; --h1-variant: normal; --h1-color: inherit;
  --inline-title-color: var(--h1-color); --inline-title-font: var(--h1-font); --inline-title-line-height: var(--h1-line-height);
  --inline-title-size: var(--h1-size); --inline-title-style: var(--h1-style); --inline-title-variant: var(--h1-variant);
  --inline-title-weight: var(--h1-weight); --inline-title-margin-bottom: 0.5em; }
.inline-title { color: var(--inline-title-color); white-space: pre-wrap; margin-block-end: var(--inline-title-margin-bottom); }
.inline-title:not([data-level]) { font-size: var(--inline-title-size); font-weight: var(--inline-title-weight); line-height: var(--inline-title-line-height);
  font-style: var(--inline-title-style); font-variant: var(--inline-title-variant); font-family: var(--inline-title-font); letter-spacing: -0.015em; }
.metadata-container { font-size: 16px; line-height: 24px; padding: 8px 0; }
.metadata-property { display: flex; gap: 8px; padding: 2px 0; }
.metadata-property-key { flex: 0 0 160px; }
.metadata-property-value { flex: 1 1 auto; overflow-wrap: anywhere; }
.cm-line.HyperMD-header-1 { font-size: var(--h1-size); line-height: var(--h1-line-height); font-weight: var(--h1-weight); }
.cm-line.HyperMD-header-2 { font-size: var(--h2-size, 1.05em); line-height: var(--h2-line-height, 1.2); font-weight: var(--h2-weight, 700); }
.cm-line.HyperMD-header-3 { font-size: var(--h3-size, 1em); line-height: var(--h3-line-height, 1.3); font-weight: var(--h3-weight, 700); }
`;

const PAGE = `
import { EditorState, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { EditorView, Decoration, lineNumbers } from "@codemirror/view";
import { history, undo, redo } from "@codemirror/commands";
import { Platform } from "obsidian";
import { inlineInk, inkOverlayExtension, overlayForPath, setScrollExpansionEnabled, setInlineTool, setInkSizeMult } from "../../src/inline/InkOverlay";
import { setInkColorHex } from "../../src/ink/InkColor";
import { setPenInk } from "../../src/inline/PenInk";
import { setTipMode } from "../../src/inline/TipMode";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField } from "./iphoneObsidianStub";
import { parsePage, serializePage } from "../../src/model/PageData";

Object.assign(Platform, { isMobile: false, isDesktop: true, isIosApp: false, isDesktopApp: true, isMobileApp: false, isPhone: false, isWin: true });
installObsidianDom();
const ids = new Map(), sidecars = new Map();
// Every save the store asks the host for, counted: a correction or a rebase alone must ask for none.
let saves = 0;
const save = (id, page) => { saves++; sidecars.set(id, serializePage(page)); };
inlineInk.attachHost({ readPageId: p => ids.get(p) ?? null, claimId: async (p, id) => { ids.set(p, id); return { pageId: id }; },
	loadSidecar: async id => (sidecars.has(id) ? parsePage(sidecars.get(id), id) : null), scheduleSidecar: save, scheduleSidecarNow: async (id, p) => save(id, p), notify: () => {} });

const frame = () => new Promise(r => requestAnimationFrame(() => r()));
const rendered = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
const wait = ms => new Promise(r => setTimeout(r, ms));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await frame(); };
const FONT_PX = 26, LINE_PX = 39;
const PROPS = [["keywords", "[]"], ["updated", "2026-10-04T16:25:51"], ["created", "2026-08-27T04:44:00"], ["handwriting-page-id", "84289706-de29-4e71-a784-34056a6dc15d"]];
let rig = null;

// Obsidian's Live Preview line classes for headings and quotes, so Minimal sizes those lines as it does in the app.
const markdownLines = EditorView.decorations.compute(["doc"], state => {
	const b = new RangeSetBuilder();
	for (let n = 1; n <= state.doc.lines; n++) {
		const l = state.doc.line(n), h = /^(#{1,6}) /.exec(l.text);
		if (h) b.add(l.from, l.from, Decoration.line({ class: "HyperMD-header HyperMD-header-" + h[1].length }));
		else if (l.text.startsWith(">")) b.add(l.from, l.from, Decoration.line({ class: "HyperMD-quote" }));
	}
	return b.finish();
});
// One line made a level-1 heading by an effect, with no change to its text: a line above the ink that grows in the same
// update as typing, as a Live Preview line does when the cursor leaves it.
const growLine = StateEffect.define();
const grownLine = StateField.define({
	create: () => Decoration.none,
	update(deco, tr) {
		deco = deco.map(tr.changes);
		for (const e of tr.effects) if (e.is(growLine)) deco = Decoration.set([Decoration.line({ class: "HyperMD-header HyperMD-header-1" }).range(tr.changes.mapPos(e.value))]);
		return deco;
	},
	provide: f => EditorView.decorations.from(f),
});
function installSizer(view) {
	const sizer = document.createElement("div"); sizer.className = "cm-sizer";
	const container = document.createElement("div"); container.className = "cm-contentContainer";
	view.contentDOM.parentElement.insertBefore(sizer, view.contentDOM); sizer.appendChild(container); container.appendChild(view.contentDOM);
	void view.scrollDOM.clientWidth; return sizer;
}
function properties() {
	const box = document.createElement("div"); box.className = "metadata-container"; box.setAttribute("data-property-count", String(PROPS.length));
	const heading = box.appendChild(document.createElement("div")); heading.className = "metadata-properties-heading"; heading.textContent = "Properties";
	const list = box.appendChild(document.createElement("div")); list.className = "metadata-properties";
	for (const [key, value] of PROPS) {
		const row = list.appendChild(document.createElement("div")); row.className = "metadata-property"; row.setAttribute("data-property-key", key);
		const k = row.appendChild(document.createElement("div")); k.className = "metadata-property-key"; k.textContent = key;
		const v = row.appendChild(document.createElement("div")); v.className = "metadata-property-value"; v.textContent = value;
	}
	return box;
}
function lineEl(view, pos) {
	const { node } = view.domAtPos(view.state.doc.lineAt(pos).from);
	const el = node.nodeType === 1 ? node : node.parentElement;
	return el ? el.closest(".cm-line") : null;
}
// The first client rect of len characters of text at pos, or null while they are not drawn.
function textRect(pos, len) {
	const { view } = rig, vp = view.viewport;
	if (pos < vp.from || pos + len > vp.to) return null;
	const a = view.domAtPos(pos), b = view.domAtPos(pos + len), r = document.createRange();
	r.setStart(a.node, a.offset); r.setEnd(b.node, b.offset);
	const rs = r.getClientRects(); return rs.length ? rs[0] : null;
}
// The anchor text's first client rect: where the ink was written.
const anchorRect = () => textRect(rig.anchor.pos(), rig.anchor.len);
const pen = (type, px, py, buttons) => document.elementFromPoint(px, py)?.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "pen", pointerId: 901, isPrimary: true, clientX: px, clientY: py, buttons, pressure: buttons ? 0.5 : 0 }));
// The text row under a screen y: the document line, and which wrapped row of it (nearest row centre).
function rowAt(y) {
	const { view } = rig;
	for (const l of view.contentDOM.querySelectorAll(".cm-line")) {
		const lr = l.getBoundingClientRect(); if (y < lr.top || y >= lr.bottom) continue;
		const n = view.state.doc.lineAt(view.posAtDOM(l, 0)).number, r = document.createRange(); r.selectNodeContents(l);
		const rows = [];
		for (const q of r.getClientRects()) { if (q.height < 1) continue; const c = (q.top + q.bottom) / 2; if (!rows.some(v => Math.abs(v - c) < 4)) rows.push(c); }
		rows.sort((p, q) => p - q);
		let best = -1; for (let i = 0; i < rows.length; i++) if (best < 0 || Math.abs(rows[i] - y) < Math.abs(rows[best] - y)) best = i;
		return "L" + n + " r" + (best < 0 ? "?" : best);
	}
	return null;
}
function inkCentre() {
	const { overlay } = rig, cc = overlay.committedCanvas;
	if (!cc || !cc.width || !cc.height) return null;
	const w = cc.width, h = cc.height, d = cc.getContext("2d").getImageData(0, 0, w, h).data;
	let sw = 0, sx = 0, sy = 0;
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
		const i = (y * w + x) * 4, a = d[i + 3];
		if (!a || d[i + 1] > 90 || d[i] < 128 || d[i + 2] < 128) continue;
		sw += a; sx += (x + 0.5) * a; sy += (y + 0.5) * a;
	}
	if (!sw) return null;
	const r = cc.getBoundingClientRect();
	return { x: r.left + (sx / sw) * r.width / w, y: r.top + (sy / sw) * r.height / h };
}
const measureOnce = () => new Promise(r => rig.view.requestMeasure({ read: v => [v.scrollDOM.scrollTop, v.contentHeight, v.lineBlockAt(rig.anchor.pos()).top, v.defaultLineHeight, v.viewport.from, v.viewport.to].join(","), write: m => r(m) }));
/** Two consecutive measure cycles that read the same geometry; the cycle count, or -1. */
async function idleMeasures(max = 40) {
	let prev = null, same = 0;
	for (let i = 0; i < max; i++) { await frame(); const m = await measureOnce(); if (m === prev) { if (++same >= 2) return i; } else same = 0; prev = m; }
	return -1;
}
function sample(phase, dir, step) {
	const { view, overlay, anchor } = rig, ink = inkCentre(), ar = anchorRect(), vp = view.viewport, doc = view.state.doc;
	const s = overlay.cssScale, contentTop = view.contentDOM.getBoundingClientRect().top;
	const textY = ar ? (ar.top + ar.bottom) / 2 : null;
	return { phase, dir, step, k: overlay.pinchScaleNow, cssScale: s, scrollTop: view.scrollDOM.scrollTop,
		hostForm: view.dom.style.zoom ? "zoom " + view.dom.style.zoom : view.dom.style.transform ? "transform " + view.dom.style.transform : "none",
		inkX: ink ? ink.x : null, inkY: ink ? ink.y : null, under: ink ? rowAt(ink.y) : null, own: textY === null ? null : rowAt(textY), textY,
		// Note px: the ink's and the anchor text's distance below the document's first line, and the ink from its text.
		inkDoc: ink ? (ink.y - contentTop) / s : null, textDoc: textY === null ? null : (textY - contentTop) / s,
		driftNote: ink && textY !== null ? (ink.y - textY) / s : null,
		drawn: "L" + doc.lineAt(vp.from).number + "-L" + doc.lineAt(vp.to).number, defaultLineH: view.defaultLineHeight, saves, ...anchorReadout() };
}
/** How far the surface shows a stroke below its page spot; 0 on a build without line anchors. */
function shownDy(st) {
	return rig.overlay.lineAnchorDy ? rig.overlay.lineAnchorDy(st) : 0;
}
/**
 * A reader scrolls to the ink: the stroke's shown centre (its page spot plus its correction) is scrolled back under the
 * pointer, from the stroke's data, so ink moved off the screen with its text is found. Repeated while lines measured on the
 * way move it, as the mount's jump is.
 */
async function scrollToInk() {
	const { view, overlay, path } = rig, st = inlineInk.strokes(path)[0];
	if (!st) return;
	for (let i = 0; i < 4; i++) {
		const s = overlay.cssScale, top = view.contentDOM.getBoundingClientRect().top;
		const y = top + (st.bbox.y + st.bbox.height / 2 + shownDy(st) + rig.inkOff) * s;
		if (Math.abs(y - rig.cursor.y) < 1) return;
		view.scrollDOM.scrollTop += (y - rig.cursor.y) / s;
		await settle(8);
		await idleMeasures();
	}
}
/** The stroke's anchor and the correction the surface shows it at, the signature, and what the signature could be read from. */
function anchorReadout() {
	const { view, overlay, path } = rig, st = inlineInk.strokes(path)[0], a = st && st.lineAnchor, sig = overlay.lineAnchors ? overlay.lineAnchors.sig : null;
	const dy = st ? shownDy(st) : null, cc = overlay.committedCanvas, cr = cc ? cc.getBoundingClientRect() : null;
	return { anchorLine: a ? a.line : null, dy, shownTop: st ? st.bbox.y + dy : null, sigW: sig ? sig.width : null, sigFont: sig ? sig.fontPx : null,
		anchorW: a ? a.width : null, anchorFont: a ? a.fontPx : null, clientW: view.contentDOM.clientWidth, rectW: view.contentDOM.getBoundingClientRect().width,
		fontCss: getComputedStyle(view.contentDOM).fontSize, fontZoom: overlay.fontZoom, canvasTop: cr ? cr.top : null, canvasBottom: cr ? cr.bottom : null,
		paints: rig.paints === undefined ? null : rig.paints };
}
function wheel(dy, x, y) {
	const e = new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: dy, deltaMode: 0, clientX: x, clientY: y });
	rig.view.scrollDOM.dispatchEvent(e);
	return e.defaultPrevented;
}
async function quiet(maxFrames = 120) {
	const o = rig.overlay;
	for (let j = 0; j < maxFrames; j++) {
		await rendered();
		const easing = !!(o.overscrollBounceReadout && o.overscrollBounceReadout().active);
		if (!o.pinchPreview && !o.pinchGive && !easing && !o.wheelZoomRun.isLive) return j;
	}
	return -1;
}

window.inkStaysOnItsLine = {
	/** o: { text, phrase, paneW, paneH, hostLeft, hostTop }. */
	async mount(o) {
		setPenInk(true); setScrollExpansionEnabled(true);
		setInlineTool("pen"); setInkColorHex("pen", "#ff00ff"); setInkSizeMult("pen", 4);
		const path = "ink-stays-on-its-line.md";
		const pane = document.body.appendChild(document.createElement("div"));
		pane.className = "markdown-source-view mod-cm6";
		pane.style.cssText = "position:relative;margin-left:" + o.hostLeft + "px;margin-top:" + o.hostTop + "px;width:" + o.paneW + "px;height:" + o.paneH + "px;overflow:hidden";
		const view = new EditorView({ parent: pane, state: EditorState.create({ doc: o.text, extensions: [history(), EditorView.lineWrapping, lineNumbers(), markdownLines, grownLine,
			editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} })), inkOverlayExtension(),
			EditorView.theme({ "&": { width: o.paneW + "px", height: o.paneH + "px" }, ".cm-scroller": { overflowY: "auto", overflowX: "hidden" }, ".cm-content": { fontSize: FONT_PX + "px", lineHeight: LINE_PX + "px" } })] }) });
		const sizer = installSizer(view);
		const title = document.createElement("div"); title.className = "inline-title"; title.setAttribute("contenteditable", "true"); title.textContent = "Untitled 2";
		sizer.insertBefore(properties(), sizer.firstChild);
		sizer.insertBefore(title, sizer.firstChild);
		await settle(12);
		const overlay = overlayForPath(path);
		if (!overlay) throw new Error("no overlay for " + path);
		const idx = o.text.indexOf(o.phrase);
		if (idx < 0) throw new Error("phrase not in the document: " + o.phrase);
		// The anchor follows edits: its position is mapped through every change made after the mount.
		let at = idx;
		rig = { pane, view, overlay, path, phrase: o.phrase, anchor: { pos: () => at, len: o.phrase.length, map: changes => { at = changes.mapPos(at, 1); } } };
		const pr = pane.getBoundingClientRect(), mid = pr.top + pr.height / 2;
		// Jump straight to the phrase, as a restored scroll does: the lines above it stay estimates. Heights near it are
		// measured as they come into view, so the jump is repeated until the phrase sits at the pane's middle.
		view.scrollDOM.scrollTop = Math.max(0, view.lineBlockAt(idx).top - o.paneH / 2);
		for (let i = 0; i < 4; i++) {
			await settle(8);
			const ar = anchorRect();
			if (ar) view.scrollDOM.scrollTop += (ar.top + ar.bottom) / 2 - mid;
			else view.scrollDOM.scrollTop = Math.max(0, view.lineBlockAt(idx).top - o.paneH / 2);
		}
		await settle(12);
		const idleScroll = await idleMeasures();
		const ar = anchorRect();
		if (!ar) throw new Error("anchor not drawn");
		const cx = (ar.left + ar.right) / 2, cy = (ar.top + ar.bottom) / 2;
		// A small loop on the anchor text: its centre is the text's centre.
		const R = 14, N = 24;
		pen("pointerdown", cx + R, cy, 1);
		for (let i = 1; i <= N; i++) pen("pointermove", cx + R * Math.cos(2 * Math.PI * i / N), cy + R * Math.sin(2 * Math.PI * i / N), 1);
		pen("pointerup", cx + R, cy, 0);
		await settle(16);
		const idleInk = await idleMeasures();
		const ink = inkCentre();
		rig.cursor = { x: ink ? ink.x : cx, y: ink ? ink.y : cy };
		// Where the stroke's centre sits against the content top, note px, beyond its own world centre: the scroll to the ink
		// below puts the shown centre back under the pointer with it.
		const st0 = inlineInk.strokes(path)[0];
		rig.inkOff = st0 ? (rig.cursor.y - view.contentDOM.getBoundingClientRect().top) / overlay.cssScale - (st0.bbox.y + st0.bbox.height / 2 + shownDy(st0)) : 0;
		// Every committed paint, counted, so a row shows whether one ran after the update it follows.
		rig.paints = 0;
		const paintWork = overlay.paintCommittedWork;
		overlay.paintCommittedWork = function (...a) { rig.paints++; return paintWork.apply(this, a); };
		return { strokes: inlineInk.strokes(path).length, anchorLine: view.state.doc.lineAt(idx).number, cursor: rig.cursor, dpr: window.devicePixelRatio,
			inner: [window.innerWidth, window.innerHeight], lines: view.state.doc.lines, canvasMode: !!overlay.canvasMode, idle: [idleScroll, idleInk], rest: sample("rest", "none", 0) };
	},
	/** Mouse notches: one event each, a gap past the quiet time between them, so each notch is its own run and settle. */
	async notches(dy, count, gapMs = 260) {
		const rows = [], { x, y } = rig.cursor, dir = dy < 0 ? "in" : "out";
		for (let i = 1; i <= count; i++) {
			wheel(dy, x, y);
			await rendered();
			rows.push(sample("preview", dir, i));
			await wait(gapMs);
			const frames = await quiet();
			await scrollToInk();
			rows.push({ ...sample("settled", dir, i), quietFrames: frames });
		}
		return rows;
	},
	/** No zoom: scroll up through the never-drawn lines to the top, then back down to the scroll the rest had. */
	async scrollTrip(step) {
		const rows = [], s = rig.view.scrollDOM, home = s.scrollTop;
		while (s.scrollTop > 0) { s.scrollTop = Math.max(0, s.scrollTop - step); await rendered(); }
		await quiet(); await idleMeasures();
		rows.push(sample("top", "up", 1));
		while (s.scrollTop < home) { s.scrollTop = Math.min(home, s.scrollTop + step); await rendered(); }
		await quiet();
		const idle = await idleMeasures();
		rows.push(sample("home", "back", 1));
		await scrollToInk();
		rows.push({ ...sample("settled", "back", 1), home, idle });
		return rows;
	},
	/**
	 * Typing: text and a blank line inserted at the start of the line N lines over the anchor's line, N being the above
	 * argument. With grow, the line that many lines over the anchor's line (above the typed one) becomes a heading in the same
	 * transaction, so the measure after the edit carries a height change the typing did not make.
	 */
	async typeAbove(above, text, grow = 0) {
		const { view } = rig, doc = view.state.doc, anchorLine = doc.lineAt(rig.anchor.pos()).number;
		const line = anchorLine - above, from = doc.line(line).from;
		const growAt = grow > 0 ? doc.line(anchorLine - grow).from : -1;
		const heightOf = (pos) => { const b = view.lineBlockAt(pos); return (b.bottom - b.top) / rig.overlay.cssScale; };
		const grownBefore = growAt >= 0 ? heightOf(growAt) : null;
		const tr = view.state.update({ changes: { from, insert: text + "\\n\\n" }, effects: growAt >= 0 ? growLine.of(growAt) : [], userEvent: "input.type" });
		rig.anchor.map(tr.changes);
		const lineHBefore = view.defaultLineHeight, paintsBefore = rig.paints;
		view.dispatch(tr);
		await quiet();
		const idle = await idleMeasures();
		// Before the scroll to the ink: where the surface shows the stroke, and whether a committed paint ran after the edit.
		const seen = { ...sample("seen", "pre", 1), lineHBefore, paintsBefore };
		await scrollToInk();
		// The typed block as measured after the settle: the paragraph's line and the blank line after it, in note px.
		const top = (n) => view.lineBlockAt(view.state.doc.line(n).from).top;
		const grewNote = growAt >= 0 ? heightOf(tr.changes.mapPos(growAt)) - grownBefore : null;
		return [seen, { ...sample("settled", "typed", 1), idle, insertedAt: line, blockNote: (top(line + 2) - top(line)) / rig.overlay.cssScale, lineHBefore, paintsBefore, grewNote }];
	},
	/**
	 * Lasso: a loop round the ink, then the selection dragged down by the distance from its words to the start of the line that
	 * many lines below, so the ink keeps its rest offset from its new words. The ink is first scrolled near the pane's top so
	 * the drop lands inside the pane. From then on the new words are the text the rows judge the ink against.
	 */
	async lassoDown(lines) {
		const { view, overlay, pane } = rig, pr = pane.getBoundingClientRect();
		view.scrollDOM.scrollTop += (rig.cursor.y - (pr.top + 150)) / overlay.cssScale;
		await settle(8); await idleMeasures();
		const doc = view.state.doc, target = doc.line(doc.lineAt(rig.anchor.pos()).number + lines), len = Math.min(10, target.length);
		const ink0 = inkCentre(), from = anchorRect(), to = textRect(target.from, len);
		if (!ink0 || !from || !to) throw new Error("lasso: the ink, its words or the words " + lines + " lines below are not drawn");
		const dy = (to.top + to.bottom) / 2 - (from.top + from.bottom) / 2, x = ink0.x, y = ink0.y, R = 60, N = 32;
		setTipMode("lasso");
		pen("pointermove", x + R, y, 0); await frame();
		pen("pointerdown", x + R, y, 1);
		for (let i = 1; i <= N; i++) { pen("pointermove", x + R * Math.cos(2 * Math.PI * i / N), y + R * Math.sin(2 * Math.PI * i / N), 1); await frame(); }
		pen("pointerup", x + R, y, 0); await settle(4);
		const selected = overlay.selection.size;
		pen("pointermove", x, y, 0); await frame();
		pen("pointerdown", x, y, 1);
		const grabbed = overlay.dragFrom !== null;
		for (let i = 1; i <= 20; i++) { pen("pointermove", x, y + dy * i / 20, 1); await frame(); }
		pen("pointerup", x, y + dy, 0);
		await settle(8);
		overlay.dissolveSelection(); setTipMode("nib");
		await settle(8); await idleMeasures();
		let at = target.from;
		rig.anchor = { pos: () => at, len, map: changes => { at = changes.mapPos(at, 1); } };
		const ink = inkCentre(), st = inlineInk.strokes(rig.path)[0];
		rig.cursor = { x: ink ? ink.x : x, y: ink ? ink.y : y + dy };
		rig.inkOff = st ? (rig.cursor.y - view.contentDOM.getBoundingClientRect().top) / overlay.cssScale - (st.bbox.y + st.bbox.height / 2 + shownDy(st)) : 0;
		// jump: where the drop left the ink's centre against where the drag put it, css px. topRow: the text row under the
		// stroke's shown top edge, the line an anchor is taken on.
		const topRow = st ? rowAt(view.contentDOM.getBoundingClientRect().top + (st.bbox.y + shownDy(st)) * overlay.cssScale) : null;
		return [{ ...sample("dropped", "down", 1), targetLine: target.number, selected, grabbed, dragPx: dy, jump: ink ? ink.y - (y + dy) : null, topRow }];
	},
	/**
	 * Insert space: the pen in space mode on the seam at the top of the line over the ink's line, dragged down that many lines,
	 * so the text opens and the ink rides down with it in one step; then the editor's undo of that step, and its redo. Each row
	 * is read once the editor is quiet, against the ink's words wherever the step left them.
	 */
	async spaceUndoRedo(lines) {
		const { view, overlay, pane } = rig, pr = pane.getBoundingClientRect();
		view.scrollDOM.scrollTop += (rig.cursor.y - (pr.top + 300)) / overlay.cssScale;
		await settle(8); await idleMeasures();
		const doc = view.state.doc, seam = doc.line(doc.lineAt(rig.anchor.pos()).number - 1), c = view.coordsAtPos(seam.from);
		if (!c || c.top < pr.top) throw new Error("space: the line over the ink's line is not drawn in the pane");
		const x = rig.cursor.x, y = c.top + 1, drag = lines * LINE_PX * overlay.cssScale;
		setTipMode("space");
		pen("pointermove", x, y, 0); await frame();
		pen("pointerdown", x, y, 1);
		const cut = overlay.spaceLineY !== null, moving = overlay.spaceIds.length;
		for (let i = 1; i <= 12; i++) { pen("pointermove", x, y + drag * i / 12, 1); await frame(); }
		pen("pointerup", x, y + drag, 0);
		await settle(8);
		setTipMode("nib");
		// The ink's words, found by their text: the step moved them. The editor's undo and redo scroll to the change, so the
		// reader scrolls back to the ink first.
		const read = async (dir, extra) => {
			await quiet(); await idleMeasures();
			await scrollToInk();
			const idle = await idleMeasures(), at = view.state.doc.toString().indexOf(rig.phrase);
			rig.anchor = { pos: () => at, len: rig.phrase.length, map: () => {} };
			return { ...sample("settled", dir, 1), idle, wordsLine: at < 0 ? null : view.state.doc.lineAt(at).number, ...extra };
		};
		const rows = [await read("spaced", { cut, moving })];
		const undid = undo(view);
		rows.push(await read("undone", { did: undid }));
		const redid = redo(view);
		rows.push(await read("redone", { did: redid }));
		return rows;
	},
};
`;

declare const process: { env: Record<string, string | undefined> };
const MINIMAL = readFileSync(fileURLToPath(new URL("./fixtures/minimal-9.0.2-theme.css", import.meta.url)), "utf8");
const DSF = 2;
const LINE_PX = 39;
// The growth the grown cell needs before it judges: ten times its 1 note px check. A level-1 heading in Minimal grows a
// body line by about 19.5 note px at this font, under half a line, so a whole line is not asked for.
const GREW_MIN_NOTE = 10;
const WINDOW = "1440,960";
// Alan's note has Infinite Canvas on through its ink file, not the global setting. The rig turns the global on;
// canvasForNote resolves the same canvas mode either way, so the overlay under test is the same.
const MOUNT = { phrase: "ink rides on this text", paneW: 1440 - 44 - 200 - 254.67, paneH: 960 - 76, hostLeft: 44 + 200, hostTop: 76 };
/**
 * The line shapes of the note the defect was seen on, in order: p = paragraph of that many characters, q = quote line,
 * hN.L = heading of level N and L characters, "-" = a rule, "_" = a blank line. Line 74 carries the ink at column 75.
 */
const SHAPE = ("p53 _ p51 _ p234 _ h2.42 _ p49 _ p106 _ p8 _ q59 _ h2.38 _ p59 _ p114 _ p8 _ q172 _ h2.55 _ p44 _ p132 _ p8 _ q131 _ " +
	"h2.23 _ p49 _ p66 _ p72 _ p14 _ q24 q43 q45 _ - _ h1.16 _ h2.30 _ h3.13 _ p198 _ h3.13 _ p219 _ p63 _ h3.15 _ p227 _ _ p437 _ p415 _ " +
	"p157 _ - _ h2.27 _ h3.13 _ p64 _ h3.13 _ p146 _ p284 _ p51 _ h3.15 _ p215 _ - _ h2.34 _ h3.13 _ p67 _ h3.13 _ p151 _ p137 _ h3.15 _ " +
	"p143 _ p84 _ - _ h2.26 _ h3.13 _ p89 _ h3.13 _ p146 _ p128 _ h3.15 _ p173 _ p95 _ - _ h2.22 _ h3.13 _ p117 _ h3.13 _ p172 _ p170 _ " +
	"h3.15 _ p150 _ p102 _ - _ h2.25 _ h3.13 _ p93 _ h3.13 _ p209 _ p116 _ h3.15 _ p156 _ p118 _ - _ h2.14 _ h3.13 _ p97 _ h3.13 _ p175 _ " +
	"p165 _ h3.15 _ p148 _ p150 _ - _ h2.30 _ h3.13 _ p63 _ h3.13 _ p156 _ p160 _ p57 _ h3.15 _ p143 _ p172 _ - _ h2.27 _ h3.13 _ p150 _ " +
	"h3.13 _ p258 _ p92 _ h3.15 _ p164 _ p151 _ - _ h1.19 _ p19 _ p57 _ p88 _ p186").split(" ");
const WORDS = ["slate", "pen", "margin", "ruled", "paper", "column", "quiet", "stroke", "layer", "page", "note", "corner", "border", "fold", "sketch"];
/** Plain ASCII filler of exactly n characters, deterministic per line. */
function filler(n: number, seed: number): string {
	let out = "", i = seed;
	while (out.length < n) { out += (out ? " " : "") + WORDS[i % WORDS.length]; i += 7; }
	return out.slice(0, n).replace(/ $/, "x");
}
function syntheticNote(): string {
	return SHAPE.map((shape, i) => {
		if (shape === "_") return "";
		if (shape === "-") return "---";
		const h = /^h(\d)\.(\d+)$/.exec(shape);
		if (h) { const prefix = "#".repeat(Number(h[1])) + " "; return prefix + filler(Number(h[2]) - prefix.length, i); }
		if (shape.startsWith("q")) return "> " + filler(Number(shape.slice(1)) - 2, i);
		const text = filler(Number(shape.slice(1)), i);
		return i + 1 === 74 ? text.slice(0, 75) + MOUNT.phrase + text.slice(75 + MOUNT.phrase.length) : text;
	}).join("\n");
}
// A paragraph that wraps over several rows, typed above the ink.
const TYPED = filler(300, 3);
// A line on one row, of a height the editor has already seen, typed above the ink: its estimate does not move.
const PLAIN = filler(16, 5);

let script: string;
let browser: Browser | null = null;
const report: unknown[] = [];

beforeAll(async () => {
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "inkStaysOnItsLinePage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
}, 180_000);
afterAll(async () => {
	if (browser) await browser.close();
	if (process.env.HW_INK_LINE_REPORT) writeFileSync(process.env.HW_INK_LINE_REPORT, JSON.stringify(report, null, 1));
});

async function openPage(b: Browser): Promise<{ page: Page; m: any; errors: string[] }> {
	const page = await (await b.newContext({ viewport: null })).newPage();
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	// A layout read inside an editor update throws there; CodeMirror catches it, logs "CodeMirror plugin crashed" and deactivates
	// the overlay, so no page error is raised. The log fails the cell.
	page.on("console", msg => { const t = msg.text(); if (/plugin crashed|isn't allowed during an update/.test(t)) errors.push(("console: " + t).slice(0, 200)); });
	await page.setContent('<!doctype html><body class="theme-dark" style="margin:0"></body>');
	await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS + INLINE_TITLE_CSS + MINIMAL });
	await page.addScriptTag({ content: script });
	const m = await page.evaluate(o => (window as any).inkStaysOnItsLine.mount(o), { ...MOUNT, text: syntheticNote() });
	return { page, m, errors };
}
async function mounted(): Promise<{ page: Page; m: any; errors: string[] }> {
	if (!browser) {
		browser = await chromium.launch({ headless: true, args: [`--force-device-scale-factor=${DSF}`, `--window-size=${WINDOW}`] });
		// The warm-up page: the first page a browser opens starts with a different line-height estimate.
		const warm = await openPage(browser);
		await warm.page.context().close();
	}
	return openPage(browser);
}
const call = (p: Page, method: string, ...args: unknown[]) => p.evaluate(([n, a]) => (window as any).inkStaysOnItsLine[n](...a), [method, args] as const) as Promise<any[]>;

const f = (v: unknown, d = 2) => typeof v === "number" ? v.toFixed(d) : String(v);
function line(r: any): string {
	return `${r.phase.padEnd(8)} ${r.dir.padEnd(5)} #${r.step} k ${f(r.k, 4)} form ${r.hostForm} scrollTop ${f(r.scrollTop)} ink ${f(r.inkX)},${f(r.inkY)} ` +
		`under "${r.under}" own "${r.own}" drift ${f(r.driftNote)} note px | inkDoc ${f(r.inkDoc)} textDoc ${f(r.textDoc)} drawn ${r.drawn} lineH ${f(r.defaultLineH)} | ` +
		`anchor L${r.anchorLine} dy ${f(r.dy)} shownTop ${f(r.shownTop)} canvas ${f(r.canvasTop)}-${f(r.canvasBottom)} | sig ${f(r.sigW)}/${f(r.sigFont)} ` +
		`anchorSig ${f(r.anchorW)}/${f(r.anchorFont)} clientW ${f(r.clientW)} rectW ${f(r.rectW)} font ${r.fontCss} fontZoom ${f(r.fontZoom, 4)} paints ${r.paints}` +
		` saves ${r.saves}` + (r.lineHBefore === undefined ? "" : ` | lineH before ${f(r.lineHBefore)} paints before ${r.paintsBefore}`) +
		(typeof r.grewNote === "number" ? ` grew ${f(r.grewNote)}` : "") +
		(r.phase === "dropped" ? ` | target L${r.targetLine} selected ${r.selected} grabbed ${r.grabbed} drag ${f(r.dragPx)} jump ${f(r.jump)} top "${r.topRow}"` : "") +
		(r.wordsLine === undefined ? "" : ` | words L${r.wordsLine} cut ${r.cut} moving ${r.moving} did ${r.did}`);
}
/**
 * Every cell: the anchor taken at the stroke's commit names the line its text was drawn on. A typing cell: nothing after the
 * rest asks for a save, as a rebase alone saves nothing (the anchors reach the file at the next ordinary save).
 */
function judgeCommon(name: string, rows: any[], fails: string[], saves: boolean): void {
	const rest = rows[0], own = /^L(\d+) /.exec(rest?.own ?? "");
	if (!own || rest.anchorLine !== Number(own[1])) fails.push(`${name}: the anchor taken at commit names L${rest?.anchorLine}, the ink was drawn on "${rest?.own}"`);
	if (saves) for (const r of rows) if (r.saves !== rest.saves) fails.push(`${name} ${r.phase} ${r.dir} #${r.step}: ${r.saves - rest.saves} saves asked for after the rest`);
}
/** The row under the ink's centre is the row the ink was written on, and the centre is within a line of its text. */
function judgeOnLine(name: string, rows: any[], fails: string[]): void {
	for (const r of rows) {
		if (r.phase !== "settled") continue;
		if (r.own === null || r.under !== r.own) fails.push(`${name} ${r.dir} #${r.step} k ${f(r.k, 4)}: text under the ink is "${r.under}", the ink was written on "${r.own}"`);
		if (r.driftNote === null || Math.abs(r.driftNote) >= LINE_PX) fails.push(`${name} ${r.dir} #${r.step} k ${f(r.k, 4)}: ink centre ${f(r.driftNote)} note px from its text's centre (bar ${LINE_PX}, one line)`);
	}
}
/** Typing: the ink's own words sit the typed block's measured height lower under the ink than before, within one note px. */
function judgeTyped(name: string, rows: any[], fails: string[]): void {
	const rest = rows[0], typed = rows.find(r => r.dir === "typed");
	const read = (r: any) => r && typeof r.inkDoc === "number" && typeof r.textDoc === "number";
	if (!read(rest) || !read(typed) || typeof typed.blockNote !== "number") { fails.push(`${name}: no ink, text or typed block read after typing`); return; }
	const lower = (typed.textDoc - typed.inkDoc) - (rest.textDoc - rest.inkDoc);
	if (Math.abs(lower - typed.blockNote) > 1) fails.push(`${name}: the ink's words moved ${f(lower)} note px lower under the ink, not the typed block's measured ${f(typed.blockNote)}`);
}
/** A short plain line typed: the estimate stays, nothing else changes height, and the ink holds its page spot exactly. */
function judgePlain(name: string, rows: any[], fails: string[]): void {
	judgeTyped(name, rows, fails);
	const rest = rows[0], typed = rows.find(r => r.dir === "typed");
	if (!typed || typed.lineHBefore !== typed.defaultLineH) fails.push(`${name}: premise: the line estimate moved, ${f(typed?.lineHBefore)} to ${f(typed?.defaultLineH)}`);
	if (!typed || typeof typed.inkDoc !== "number" || Math.abs(typed.inkDoc - rest.inkDoc) > 0.5)
		fails.push(`${name}: the ink moved ${f(typed?.inkDoc - rest.inkDoc)} note px in the page; typing moves no ink`);
}
/** Typing while a line above grows in the same update: the ink moves with that growth and not with the typed block. */
function judgeGrown(name: string, rows: any[], fails: string[]): void {
	judgeTyped(name, rows, fails);
	const rest = rows[0], typed = rows.find(r => r.dir === "typed");
	if (!typed || typeof typed.grewNote !== "number" || typed.grewNote < GREW_MIN_NOTE) { fails.push(`${name}: premise: the line above grew ${f(typed?.grewNote)} note px, not ${GREW_MIN_NOTE} or more`); return; }
	if (typeof typed.inkDoc !== "number" || Math.abs(typed.inkDoc - rest.inkDoc - typed.grewNote) > 1)
		fails.push(`${name}: the ink moved ${f(typed.inkDoc - rest.inkDoc)} note px in the page, not with the line above it, which grew ${f(typed.grewNote)}`);
}
/**
 * A lasso drop: the ink stays where the drag left it, on the words it was dropped on, and its anchor names the line under its
 * shown top, as at commit; then the zoom cell's rule against those words.
 */
function judgeMoved(name: string, rows: any[], fails: string[]): void {
	const d = rows.find(r => r.phase === "dropped");
	if (!d) { fails.push(`${name}: no row after the drop`); return; }
	if (d.selected !== 1 || !d.grabbed) fails.push(`${name}: premise: the lasso selected ${d.selected} strokes and grabbed ${d.grabbed}, not one stroke grabbed`);
	if (d.own !== `L${d.targetLine} r0`) fails.push(`${name}: premise: the words the ink was dropped on are on "${d.own}", not L${d.targetLine} r0`);
	if (d.under !== d.own) fails.push(`${name}: after the drop the text under the ink is "${d.under}", the ink was dropped on "${d.own}"`);
	// An anchor names the line under the stroke's top edge: the dropped words' line, or the line just above it when the stroke
	// reaches over its row's top.
	const top = /^L(\d+) /.exec(d.topRow ?? ""), topLine = top ? Number(top[1]) : null;
	if (topLine === null || topLine < d.targetLine - 1 || topLine > d.targetLine) fails.push(`${name}: premise: the stroke's top is on "${d.topRow}", not on L${d.targetLine} or the line above it`);
	if (d.anchorLine !== topLine) fails.push(`${name}: after the drop the anchor names L${d.anchorLine}, not the line under the dropped stroke's top, L${topLine}`);
	if (typeof d.jump !== "number" || Math.abs(d.jump) > 1) fails.push(`${name}: the drop moved the ink ${f(d.jump)} css px from where the drag left it`);
	judgeOnLine(name, rows, fails);
}
/**
 * Insert space, then its undo and its redo: after each step the ink's anchor names the line its words are on, and the ink sits
 * on them as it did at the rest, within one note px.
 */
function judgeSpaced(name: string, rows: any[], fails: string[]): void {
	const rest = rows[0], restLine = Number(/^L(\d+) /.exec(rest?.own ?? "")?.[1]);
	const step = (dir: string) => rows.find(r => r.phase === "settled" && r.dir === dir);
	const spaced = step("spaced"), undone = step("undone"), redone = step("redone");
	if (!spaced || !undone || !redone) { fails.push(`${name}: no row after the space, its undo or its redo`); return; }
	if (!spaced.cut || spaced.moving !== 1) fails.push(`${name}: premise: the seam was set ${spaced.cut} with ${spaced.moving} strokes below it, not one`);
	if (!(spaced.wordsLine > restLine)) fails.push(`${name}: premise: the space left the ink's words on L${spaced.wordsLine}, not below L${restLine}`);
	if (undone.did !== true || undone.wordsLine !== restLine) fails.push(`${name}: premise: the undo (${undone.did}) left the words on L${undone.wordsLine}, not L${restLine}`);
	if (redone.did !== true || redone.wordsLine !== spaced.wordsLine) fails.push(`${name}: premise: the redo (${redone.did}) left the words on L${redone.wordsLine}, not L${spaced.wordsLine}`);
	for (const r of [spaced, undone, redone]) {
		if (r.anchorLine !== r.wordsLine) fails.push(`${name} ${r.dir}: the anchor names L${r.anchorLine}, the ink's words are on L${r.wordsLine}`);
		if (typeof r.driftNote !== "number" || typeof rest.driftNote !== "number" || Math.abs(r.driftNote - rest.driftNote) > 1)
			fails.push(`${name} ${r.dir}: the ink is ${f(r.driftNote)} note px from its words' centre, ${f(rest.driftNote)} at the rest`);
	}
	judgeOnLine(name, rows, fails);
}
/**
 * The two mounts agree: every settled drift, less that mount's own rest drift, within one note px. The loop drawn at the mount
 * lands up to about 2 note px from its text's centre, differently per mount, before anything moves.
 */
function agree(name: string, a: any[], b: any[], fails: string[]): void {
	const sa = a.filter(r => r.phase === "settled"), sb = b.filter(r => r.phase === "settled");
	const za = a.find(r => r.phase === "rest")?.driftNote, zb = b.find(r => r.phase === "rest")?.driftNote;
	sa.forEach((r, i) => { const o = sb[i]; if (!o || typeof r.driftNote !== "number" || typeof o.driftNote !== "number" || typeof za !== "number" || typeof zb !== "number" ||
		Math.abs((r.driftNote - za) - (o.driftNote - zb)) >= 1)
		fails.push(`${name}: mounts disagree at ${r.dir} #${r.step}: drift ${f(r.driftNote)} from rest ${f(za)} against ${f(o?.driftNote)} from rest ${f(zb)}`); });
}

const CELLS = [
	{ name: "ctrl+wheel zoom out, 100 to about 50 percent and back in notches", steps: [["notches", 50, 7], ["notches", -50, 7]], judge: judgeOnLine, reach: (k: number) => k <= 0.55, saves: false },
	{ name: "no zoom, scroll up through the never-drawn lines to the top and back", steps: [["scrollTrip", 400]], judge: judgeOnLine, reach: null, saves: false },
	{ name: "a wrapped paragraph typed three lines above the ink", steps: [["typeAbove", 3, TYPED]], judge: judgeTyped, reach: null, saves: true },
	{ name: "a short plain line typed three lines above the ink", steps: [["typeAbove", 3, PLAIN]], judge: judgePlain, reach: null, saves: true },
	{ name: "a wrapped paragraph typed three lines above the ink while the paragraph five lines above it becomes a heading", steps: [["typeAbove", 3, TYPED, 5]], judge: judgeGrown, reach: null, saves: true },
	{ name: "the stroke lasso-moved ten lines down, then ctrl+wheel zoom out to about 50 percent and back in notches", steps: [["lassoDown", 10], ["notches", 50, 7], ["notches", -50, 7]], judge: judgeMoved, reach: (k: number) => k <= 0.55, saves: false },
	{ name: "insert space opening two lines above the ink, then its undo and its redo", steps: [["spaceUndoRedo", 2]], judge: judgeSpaced, reach: null, saves: false },
] as const;
for (const cell of CELLS) it(`${cell.name}: the ink stays on the words it was written on, and typing never moves it`, async () => {
	const fails: string[] = [], runs: any[][] = [];
	for (const mountName of ["A", "B"]) {
		const { page, m, errors } = await mounted();
		try {
			const out: any[][] = [];
			for (const [method, ...args] of cell.steps) out.push(await call(page, method, ...args));
			const rows = [m.rest, ...out.flat()];
			const name = `${cell.name} mount ${mountName}`;
			runs.push(rows);
			report.push({ cell: name, dsf: DSF, mount: { ...MOUNT, strokes: m.strokes, anchorLine: m.anchorLine, lines: m.lines, cursor: m.cursor, dpr: m.dpr,
				inner: m.inner, canvasMode: m.canvasMode, idle: m.idle }, errors, rows });
			// eslint-disable-next-line no-console
			console.log(`INK STAYS ON ITS LINE, ${name}, forced device scale ${DSF} (dpr ${m.dpr}, viewport ${m.inner.join("x")}), canvas ${m.canvasMode}, ` +
				`${m.lines} lines, ink on line ${m.anchorLine}, idle measures ${m.idle.join("/")}:\n  ` + rows.map(line).join("\n  "));
			if (errors.length) fails.push(`${name}: page errors ${JSON.stringify(errors)}`);
			if (m.strokes !== 1) fails.push(`${name}: ${m.strokes} strokes`);
			if (!m.canvasMode) fails.push(`${name}: Infinite Canvas is not on`);
			if (m.idle.some((n: number) => n < 0)) fails.push(`${name}: geometry never went idle before the rest (${m.idle.join("/")})`);
			const far = out.flat().filter(r => r.phase === "settled" && r.dir === "out").at(-1);
			if (cell.reach && (!far || !cell.reach(far.k))) fails.push(`${name}: the zoom reached k ${f(far?.k, 4)}, not about 0.5`);
			judgeCommon(name, rows, fails, cell.saves);
			cell.judge(name, rows, fails);
		} finally {
			await page.context().close();
		}
	}
	agree(cell.name, runs[0]!, runs[1]!, fails);
	expect(fails, fails.join("\n")).toEqual([]);
}, 300_000);
