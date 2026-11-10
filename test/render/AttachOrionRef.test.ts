/**
 * ATTACH ON ORION: THE INK'S LINE AND THE PIN'S WORDS IN ONE FRAME (red-first, test only).
 *
 * What Alan saw on Orion at 261d7ab2, his words: "i drew a stroke, lassod it, moved it over to the this is the test, then i
 * hit attach and it didnt work". The vault test 2 ink file holds one record whose ref puts the words' first letter at
 * world y 18.6 while the ink sits at y 149..166, and the stroke's own line anchor says line 5's top is at 18 too.
 *
 * attachSelected picks the line in one frame (the box centre times scaleY times fontZoom, looked up in the editor's height
 * map, InkOverlayLineAnchors.ts:891-894) and places the words and the ref in another (screen rects, less the container's
 * edge and pan, over cssScale, through the camera, :986-992, :1321-1330). This cell asks which frame is off on Orion's
 * state: the pin far from the right words, or the ink taking a line it is not on.
 *
 * The Orion arm: Infinite Canvas on, note zoom 2.32 through the plugin's own zoom step, Properties shown (one property,
 * the page id, its frontmatter lines hidden), the pen tool, the drift-test note's text, Minimal 9.0.2 at a 12 px base font,
 * readable line length on, inline title on, line numbers on (vault test 2's .obsidian/app.json and appearance.json), and
 * the note's ink file from vault test 2 (fixtures/drift-test-ink-a0af7bc7.json, sha256 8fb0e5a9..., copied verbatim) less
 * its one attach record and the two strokes it held, so the stroke drawn here is fresh and never attached. One pen stroke,
 * a small zigzag, is drawn over the "s" of "test" where the editor shows it; it is selected alone and Attach is asked for
 * (attachSelected, what the round button's tap calls through toggleAttach). The window: 1440 by 960 at device scale 2
 * (Orion's real window is not measured; this is a Surface Pro screen at 200 percent).
 *
 * Asserted on screen px, in the arm's own frame:
 *   (a) the ink box's centre is within one line height of the target line's rect;
 *   (b) the pin head is within one line height of the target's first letter.
 * A record that never lands fails both, naming it. Logged per arm (ATTACH-ORION): both rect tops (the target line's and the
 * first letter's), both pans (the ink display pan and the input pan), cssScale, scaleY, fontZoom, the height map's
 * block.top for the line taken, the ref, the target, and the drawn stroke's own screen box.
 * Probes, one change each from the Orion arm: Properties hidden, zoom 1, Infinite Canvas off (the note zoom is then not
 * offered: 100 percent), scrolled (the words moved 100 screen px up the pane before the stroke).
 *
 * A second set of cells, below, follows Alan's own steps: stroke off the line, pen lasso, finger drag of
 * the box onto the words, one finger tap on the Attach button; its header says what each asserts and logs.
 * Plants: none (test only). check:no-sleep runs.
 * Run: npx vitest run --config vitest.render.mts test/render/AttachOrionRef.test.ts. HW_ATTACH_ORION_OUT=<path> adds
 * each arm's line to that file.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type CDPSession, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";
import { penPress, penRelease, penStroke } from "./cdpPen";

declare const process: { env: Record<string, string | undefined> };

/** vault test 2's drift-test.md, byte for byte (no newline after the last line). */
const NOTE = "---\nhandwriting-page-id: a0af7bc7-bddb-4c6c-86b2-1737d50ad6dd\n---\n\nThis is the test";
const PAGE_ID = "a0af7bc7-bddb-4c6c-86b2-1737d50ad6dd";
/** The attach record's two strokes, removed with the record: the stroke here is fresh. */
const ATTACHED_STROKES = ["58e43e1e", "9ff3cb67"];
const FONT_PX = 12;
/**
 * Orion's editor font when Alan attached: 10 px. Read from the vault's ink file, not its settings:
 * the record att-b35ae21d says layout.font 10, and the 23 newest strokes' lineAnchor.fontPx is 10 (the plugin writes it
 * from the editor content's computed font size, InkOverlayLineAnchors.ts:132). The same file's fontRefPx is 12, so the
 * editor read 10 against a reference of 12: fontZoom 10/12. vault test 2's appearance.json says baseFontSize 12 with
 * baseFontSizeAction true (Obsidian's quick font size), and Minimal 9.0.2 sizes the editor at --font-text-size
 * (theme.css:579, :1780 block): no settings file gives 10.
 */
const ORION_FONT_PX = 10;

const titleCss = (px: number) => `
body { --h1-line-height: 1.2; --h1-size: 1.618em; --h1-weight: 700; --font-text-size: ${px}px; }
.inline-title { white-space: pre-wrap; margin-block-end: 0.5em; font-size: var(--h1-size); font-weight: var(--h1-weight); line-height: var(--h1-line-height); }
.metadata-container { font-size: ${px}px; line-height: 1.5; padding: 8px 0; }
.metadata-property { display: flex; gap: 8px; padding: 2px 0; }
.metadata-property-key { flex: 0 0 160px; }
.metadata-property-value { flex: 1 1 auto; overflow-wrap: anywhere; }
`;
const INLINE_TITLE_CSS = titleCss(FONT_PX);

const PAGE = `
import { EditorState, RangeSetBuilder } from "@codemirror/state";
import { EditorView, Decoration, lineNumbers } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { Platform } from "obsidian";
import { inlineInk, inkOverlayExtension, overlayForPath, setInlineTool, setScrollExpansionEnabled, setShapeSnap, setInkSizeMult } from "../../src/inline/InkOverlay";
import { setInkColorHex } from "../../src/ink/InkColor";
import { setPenInk } from "../../src/inline/PenInk";
import { pinHead, selectionChips } from "../../src/inline/AttachDecoration";
import { attachButtonPoint } from "../../src/inline/LassoTransform";
import { setTipMode } from "../../src/inline/TipMode";
import { noteToVisual } from "../../src/inline/ZoomScale";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField } from "./iphoneObsidianStub";
import { parsePage, serializePage } from "../../src/model/PageData";

Object.assign(Platform, { isMobile: false, isDesktop: true, isIosApp: false, isDesktopApp: true, isMobileApp: false, isPhone: false, isWin: true });
installObsidianDom();
const ids = new Map(), sidecars = new Map();
const save = (id, page) => { sidecars.set(id, serializePage(page)); };
inlineInk.attachHost({ readPageId: p => ids.get(p) ?? null, claimId: async (p, id) => { ids.set(p, id); return { pageId: id }; },
	loadSidecar: async id => (sidecars.has(id) ? parsePage(sidecars.get(id), id) : null), scheduleSidecar: save, scheduleSidecarNow: async (id, p) => save(id, p), notify: () => {} });

const frame = () => new Promise(r => requestAnimationFrame(() => r()));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await frame(); };
const rectOf = (r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
let rig = null;
const restOf = (overlay, view) => ({ pinchScaleNow: overlay.pinchScaleNow, cssScale: overlay.cssScale, scaleY: view.scaleY,
	pinchPreview: overlay.pinchPreview, settleHold: overlay.panAnchorHold ? overlay.panAnchorHold.outcome : null, repaintQueued: overlay.repaintQueued,
	scroll: [view.scrollDOM.scrollLeft, view.scrollDOM.scrollTop], cameraScroll: [overlay.lastSyncScrollLeft, overlay.lastSyncScrollTop],
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

/** The frontmatter lines hidden (Properties shown or hidden, as Obsidian does in both): a block replace, no height. */
const hideFrontmatter = EditorView.decorations.compute(["doc"], state => {
	const b = new RangeSetBuilder(), doc = state.doc;
	let end = 0;
	if (doc.lines >= 2 && doc.line(1).text === "---") for (let n = 2; n <= doc.lines; n++) if (doc.line(n).text === "---") { end = n; break; }
	if (end > 0) b.add(0, doc.line(end).to, Decoration.replace({ block: true }));
	return b.finish();
});

function properties(shown) {
	const box = document.createElement("div"); box.className = "metadata-container"; box.setAttribute("data-property-count", "1");
	const heading = box.appendChild(document.createElement("div")); heading.className = "metadata-properties-heading"; heading.textContent = "Properties";
	const list = box.appendChild(document.createElement("div")); list.className = "metadata-properties";
	const row = list.appendChild(document.createElement("div")); row.className = "metadata-property"; row.setAttribute("data-property-key", "handwriting-page-id");
	const k = row.appendChild(document.createElement("div")); k.className = "metadata-property-key"; k.textContent = "handwriting-page-id";
	const v = row.appendChild(document.createElement("div")); v.className = "metadata-property-value"; v.textContent = "${PAGE_ID}";
	if (!shown) box.style.display = "none";
	return box;
}

/** World point to screen px: the inverse of the pen's mapping (the overlay's rect, its input pan, its scale, the camera). */
function toScreen(w) {
	const { overlay } = rig, edge = overlay.container.getBoundingClientRect(), k = overlay.cssScale, s = overlay.camera.worldToScreen(w.x, w.y);
	return { x: edge.left + overlay.inkInputPanX() + noteToVisual(s.x, k), y: edge.top + overlay.inkInputPanY() + noteToVisual(s.y, k) };
}

window.attachOrion = {
	/** o: { text, sidecar, canvas, zoom, propsShown, scrollBy, paneW, paneH, hostLeft, hostTop }. */
	async mount(o) {
		setPenInk(true); setScrollExpansionEnabled(o.canvas); setInlineTool("pen"); setShapeSnap(true);
		setInkColorHex("pen", "#2f6de0"); setInkSizeMult("pen", 3);
		const path = "drift-test.md";
		ids.set(path, "${PAGE_ID}"); sidecars.set("${PAGE_ID}", o.sidecar);
		const pane = document.body.appendChild(document.createElement("div"));
		pane.className = "markdown-source-view mod-cm6 is-live-preview is-readable-line-width" + (o.propsShown ? " show-properties" : "");
		pane.style.cssText = "position:relative;margin-left:" + o.hostLeft + "px;margin-top:" + o.hostTop + "px;width:" + o.paneW + "px;height:" + o.paneH + "px;overflow:hidden";
		const view = new EditorView({ parent: pane, state: EditorState.create({ doc: o.text, extensions: [history(), EditorView.lineWrapping, lineNumbers(), hideFrontmatter,
			editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} })), inkOverlayExtension(),
			EditorView.theme({ "&": { width: o.paneW + "px", height: o.paneH + "px" }, ".cm-scroller": { overflowY: "auto" }, ".cm-content": { fontSize: (o.fontPx ?? ${FONT_PX}) + "px", lineHeight: "1.5" } })] }) });
		const sizer = document.createElement("div"); sizer.className = "cm-sizer";
		const container = document.createElement("div"); container.className = "cm-contentContainer";
		view.contentDOM.parentElement.insertBefore(sizer, view.contentDOM); sizer.appendChild(container); container.appendChild(view.contentDOM);
		const title = document.createElement("div"); title.className = "inline-title"; title.setAttribute("contenteditable", "true"); title.textContent = "drift-test";
		sizer.insertBefore(properties(o.propsShown), sizer.firstChild);
		sizer.insertBefore(title, sizer.firstChild);
		await settle(12);
		const overlay = overlayForPath(path);
		if (!overlay) throw new Error("no overlay for " + path);
		for (let i = 0; i < 90 && (!overlay.lineAnchors?.sig || inlineInk.strokes(path).length === 0); i++) await frame();
		await settle(6);
		const canvas = overlay.canvasModeOn();
		let stepped = null;
		// With Infinite Canvas off the note zoom is not offered (the zoom bar is busy): that probe runs at 100 percent.
		if (o.zoom !== 1 && o.canvas) {
			stepped = overlay.zoomNoteBy(o.zoom);
			await until("the zoom at rest at " + o.zoom, () => near(overlay.pinchScaleNow, o.zoom) && overlay.panAnchorHold === null && !overlay.pinchPreview &&
				!overlay.repaintQueued && near(overlay.cssScale, o.zoom) && near(view.scaleY, o.zoom), () => restOf(overlay, view));
		}
		// The note's words on screen: the zoom step zooms about the pane's centre, so the scroll is put where "test" shows
		// in the pane's upper third, then the scrolled probe adds its own scroll.
		rig = { pane, view, overlay, path };
		const doc = view.state.doc, line5 = doc.line(doc.lines), sPos = line5.from + line5.text.indexOf("test") + 2;
		const pr = pane.getBoundingClientRect();
		for (let i = 0; i < 3; i++) {
			const r = view.coordsAtPos(sPos, 1);
			if (!r) break;
			view.scrollDOM.scrollLeft += r.left - (pr.left + pr.width / 3);
			view.scrollDOM.scrollTop += r.top - (pr.top + pr.height / 3);
			view.scrollDOM.dispatchEvent(new Event("scroll", { bubbles: true }));
			await settle(6);
		}
		if (o.scrollBy) {
			// scrollBy is screen px: the scroller scrolls note px inside the zoomed host, so one note px moves the words scaleY.
			view.scrollDOM.scrollTop += o.scrollBy / view.scaleY;
			view.scrollDOM.dispatchEvent(new Event("scroll", { bubbles: true }));
			await settle(6);
		}
		const sl = view.scrollDOM.scrollLeft, st = view.scrollDOM.scrollTop;
		await until("the scroll settled", () => view.scrollDOM.scrollLeft === sl && view.scrollDOM.scrollTop === st && overlay.lastSyncScrollLeft === sl &&
			overlay.lastSyncScrollTop === st && !overlay.repaintQueued && overlay.panAnchorHold === null, () => restOf(overlay, view));
		const cs = getComputedStyle(view.dom);
		return { canvas, stepped, noteZoom: overlay.getNoteViewportState().zoom, cssScale: overlay.cssScale, scaleY: view.scaleY, fontZoom: overlay.fontZoom,
			cameraZoom: overlay.camera.snapshot.zoom, hostZoom: cs.zoom, hostTransform: cs.transform, scroll: { left: sl, top: st },
			strokes: inlineInk.strokes(path).length, attachments: inlineInk.attachments(path).length, sPos, pane: rectOf(pr),
			contentFontPx: getComputedStyle(view.contentDOM).fontSize, refFontPx: overlay.refFontPx, fontRefStored: inlineInk.fontRefPx(path) };
	},
	/** Each stroke whose id starts with one of the prefixes: its id, its stored box, its box as shown, the shown box on screen. */
	strokesNow(prefixes) {
		const { overlay, path } = rig;
		return inlineInk.strokes(path).filter(s => prefixes.some(p => s.id.startsWith(p))).map(s => {
			const shown = overlay.lineAnchors.shownOne(s), sb = shown ? shown.bbox : null;
			const a = sb ? toScreen({ x: sb.x, y: sb.y }) : null, c = sb ? toScreen({ x: sb.x + sb.width, y: sb.y + sb.height }) : null;
			return { id: s.id, stored: s.bbox, shown: sb, screen: a && c ? { left: a.x, top: a.y, right: c.x, bottom: c.y } : null };
		});
	},
	/**
	 * What attachSelected reads now, by its own sums (InkOverlayLineAnchors.ts:886-904): the selection box, h, the height
	 * map's block at h with its type (each part's type, top and height when it is an array), the block above it and whether
	 * it is a widget, line 5's own block and the block above it, defaultLineHeight, scaleY, fontZoom, the doc's line count;
	 * and the drag's state (dragTotal, dragBox, the snapshot's kind).
	 */
	pickRead() {
		const { overlay, view } = rig, doc = view.state.doc, box = overlay.selectionBounds(), px = view.scaleY * overlay.fontZoom;
		const part = (b) => ({ from: b.from, to: b.to, top: b.top, height: b.height, bottom: b.bottom, type: Array.isArray(b.type) ? "array" : b.type,
			widget: b.widget ? (b.widget.constructor?.name ?? "widget") : null });
		const blk = (b) => b ? { ...part(b), parts: Array.isArray(b.type) ? b.type.map(part) : null } : null;
		const h = box ? (box.y + box.height / 2) * px : null;
		const at = h !== null ? view.lineBlockAtHeight(h) : null;
		const up = at && at.top > 0 ? view.lineBlockAtHeight(at.top - 1) : null;
		const line5 = view.lineBlockAt(doc.line(doc.lines).from);
		const above5 = line5.top > 0 ? view.lineBlockAtHeight(line5.top - 1) : null;
		const snap = overlay.spaceSnapshot;
		// The blocks under the box's span, two ways: stepping by height (each block's bottom) and by position (each block's
		// end plus one), from the block at the span's top. Ten steps at most each.
		const walks = { byHeight: [], byPosition: [] };
		if (box) {
			const top = box.y * px, bottom = (box.y + box.height) * px;
			for (let y = top, i = 0; y < bottom && i < 10; i++) {
				const b = view.lineBlockAtHeight(y);
				walks.byHeight.push({ y, ...part(b) });
				if (!(b.bottom > y)) break;
				y = b.bottom;
			}
			for (let b = view.lineBlockAtHeight(top), i = 0; i < 10; i++, b = view.lineBlockAt(b.to + 1)) {
				walks.byPosition.push(part(b));
				if (b.top >= bottom || b.to >= doc.length) break;
			}
		}
		return { box, px, h, walks, block: blk(at), up: blk(up), upIsWidget: !!up && typeof up.type === "number" && up.type !== 0, line5: blk(line5),
			aboveLine5: blk(above5), widgetAboveLine5: !!above5 && typeof above5.type === "number" && above5.type !== 0,
			defaultLineHeight: view.defaultLineHeight, scaleY: view.scaleY, fontZoom: overlay.fontZoom, refFontPx: overlay.refFontPx, docLines: doc.lines,
			contentHeight: view.contentHeight, attachShown: overlay.attachButtonShownHere(), dragTotal: overlay.dragTotal, dragBox: overlay.dragBox,
			snapshotKind: snap ? snap.kind : null };
	},
	/** The "s" of "test" and the target line's element, as the editor shows them now. */
	letterS() {
		const { view } = rig, doc = view.state.doc, line5 = doc.line(doc.lines), sPos = line5.from + line5.text.indexOf("test") + 2;
		const a = view.coordsAtPos(sPos, 1), b = view.coordsAtPos(sPos + 1, -1);
		if (!a || !b) return null;
		// What the pen lands on at the letter's centre: the element and its class chain, three up.
		let el = document.elementFromPoint((a.left + b.left) / 2, (a.top + a.bottom) / 2), hit = [];
		for (let i = 0; el && i < 3; i++, el = el.parentElement) hit.push(el.tagName + "." + String(el.className).split(" ").join("."));
		const at = view.domAtPos(line5.from).node, lineEl = (at.nodeType === 1 ? at : at.parentElement)?.closest(".cm-line");
		return { left: a.left, right: b.left, top: a.top, bottom: a.bottom, hit, line: lineEl ? rectOf(lineEl.getBoundingClientRect()) : null, defaultLineHeight: view.defaultLineHeight };
	},
	strokeIds() { return inlineInk.strokes(rig.path).map(s => s.id); },
	/** The record holding a stroke: id, target, ref, probe, layout. Null with none. */
	recordOf(strokeId) {
		const list = inlineInk.attachments(rig.path).filter(a => a.strokeIds.includes(strokeId)), a = list[list.length - 1];
		return a ? { id: a.id, holding: list.length, target: { kind: a.target.kind, from: a.target.from, to: a.target.to, text: a.target.text }, ref: a.ref, probe: a.probe, layout: a.layout } : null;
	},
	/** A world point on screen, as the pen maps it. */
	screenOf(w) { return toScreen(w); },
	async strokeLanded(n) {
		const { overlay, view, path } = rig;
		await until("the stroke landed with the pen up", () => inlineInk.strokes(path).length > n && !(overlay.router?.isStroking ?? false) &&
			overlay.builder === null && !overlay.frame.locked && !overlay.repaintQueued, () => ({ strokes: inlineInk.strokes(path).length, before: n, ...restOf(overlay, view) }), 120);
	},
	/** Select the fresh strokes alone, ask Attach, read the record and every number the line pick uses. */
	async attachFresh(before) {
		const { overlay, view, path } = rig, old = new Set(before);
		const fresh = inlineInk.strokes(path).filter(s => !old.has(s.id));
		overlay.selection.selectExactly(fresh.map(s => s.id));
		overlay.redrawSelectionUI();
		await settle(2);
		const box = overlay.selectionBounds();
		const px = view.scaleY * overlay.fontZoom, h = box ? (box.y + box.height / 2) * px : null;
		const block = h !== null ? view.lineBlockAtHeight(h) : null;
		const n0 = inlineInk.attachments(path).length;
		const offered = overlay.attachSelected();
		for (let j = 0; j < 60 && inlineInk.attachments(path).length === n0; j++) await frame();
		await settle(4);
		const list = inlineInk.attachments(path), rec = list.length > n0 ? list[list.length - 1] : null;
		const out = { fresh: fresh.length, offered, box, h, heightMapBlock: block ? { from: block.from, to: block.to, top: block.top, bottom: block.bottom } : null,
			defaultLineHeight: view.defaultLineHeight, cssScale: overlay.cssScale, scaleY: view.scaleY, fontZoom: overlay.fontZoom,
			camera: overlay.camera.snapshot, inkPan: { x: overlay.inkPanX(), y: overlay.inkPanY() }, inputPan: { x: overlay.inkInputPanX(), y: overlay.inkInputPanY() },
			container: rectOf(overlay.container.getBoundingClientRect()), contentTop: view.contentDOM.getBoundingClientRect().top, scroll: { left: view.scrollDOM.scrollLeft, top: view.scrollDOM.scrollTop },
			record: null, target: null, ref: null, lineRect: null, letterRect: null, inkCentreScreen: null, pinAt: null, pinHeadScreen: null };
		if (box) out.inkCentreScreen = toScreen({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
		return rec ? fillRecord(out, rec) : out;
	},
	setTip(m) { setTipMode(m); },
	/** Whether the router gives a lone finger at client (x, y) to the selection. */
	claims(x, y) {
		const router = rig.overlay.router;
		router.refreshRect();
		return !!router.cb.claimTouch(router.sampleFrom({ clientX: x, clientY: y, pressure: 0.5, tiltX: 0, tiltY: 0, timeStamp: performance.now(), pointerType: "touch", width: 8, height: 8 }));
	},
	/** The palm gate open: a finger landing now is not swallowed for the pen's sake. A state, read once a frame. */
	async palmClear() {
		const router = rig.overlay.router;
		await until("the palm gate open", () => !router.anyGateBlocksNewTouch(performance.now()), () => ({ penDown: router.anyPenDown?.() ?? null }), 600);
	},
	/** The selection now: ids, its box on screen, the Attach button's centre on screen, and the input pan. */
	selectionNow() {
		const { overlay } = rig, b = overlay.selectionBounds();
		if (!b) return { ids: overlay.selection.strokeIds.slice(), box: null, button: null, panY: overlay.inkInputPanY(), shown: overlay.attachButtonShownHere() };
		const a = toScreen({ x: b.x, y: b.y }), c = toScreen({ x: b.x + b.width, y: b.y + b.height });
		return { ids: overlay.selection.strokeIds.slice(), world: b, box: { left: a.x, top: a.y, right: c.x, bottom: c.y }, centre: { x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 },
			button: toScreen(attachButtonPoint(b, overlay.camera.snapshot.zoom, overlay.cssScale)), panY: overlay.inkInputPanY(), shown: overlay.attachButtonShownHere() };
	},
	/**
	 * Spies on the tap's path, on this overlay only: every lasso press (its input, the input pan, whether it took the
	 * button), every lift (whether a button press was live, cancelled, still on the button: whether it reached
	 * toggleAttach), attachSelected and detachSelected with their returns, the button's last draw (attached or loose), and
	 * every notice. Nothing the plugin does is changed.
	 */
	spy() {
		const o = rig.overlay, log = { downs: [], ups: [], attach: [], detach: [], buttonDraws: [] };
		window.__notices = [];
		const down = o.lassoDown, up = o.lassoUp, att = o.attachSelected, det = o.detachSelected;
		o.lassoDown = function (sample, input) {
			const r = down.call(this, sample, input);
			log.downs.push({ input: input ?? "pen", panY: this.inkInputPanY(), onButton: !!this.attachPress, onPin: !!this.pinPress, drag: !!this.dragFrom, lasso: !!this.lassoActive, t: performance.now() });
			return r;
		};
		o.lassoUp = function (cancelled) {
			const p = this.attachPress, row = { cancelledArg: !!cancelled, press: p ? { input: p.input, cancelled: p.cancelled, onButtonAtLift: this.attachButtonAt(p.last, p.input) } : null, panY: this.inkInputPanY() };
			row.reachesToggle = !!(p && !cancelled && !p.cancelled && row.press.onButtonAtLift);
			const na = log.attach.length, nd = log.detach.length;
			const r = up.call(this, cancelled);
			row.attachCalls = log.attach.slice(na); row.detachCalls = log.detach.slice(nd);
			row.toggleReturned = !row.reachesToggle ? "not reached" : row.detachCalls.length ? (row.detachCalls[0] ? "detached" : null) : row.attachCalls.length ? (row.attachCalls[0] ? "attached" : null) : null;
			log.ups.push(row);
			return r;
		};
		// A finger tap does not reach the lasso: the router hands its lift to tapReleasesSelection, whose first branch is
		// the Attach button (InkOverlay.ts:526-534). Logged the same way: on the button, the toggle's calls and returns.
		const tapLift = o.tapReleasesSelection;
		log.taps = [];
		o.tapReleasesSelection = function (sample, ev) {
			const w = this.camera.screenToWorld(sample.x, sample.y), bounds = this.selection.isEmpty ? null : this.selectionBounds();
			const row = { onButton: !!bounds && this.attachButtonAt(w, "touch"), panY: this.inkInputPanY(), t: performance.now() };
			row.reachesToggle = row.onButton;
			const na = log.attach.length, nd = log.detach.length;
			row.kept = tapLift.call(this, sample, ev);
			row.attachCalls = log.attach.slice(na); row.detachCalls = log.detach.slice(nd);
			row.toggleReturned = !row.reachesToggle ? "not reached" : row.detachCalls.length ? (row.detachCalls[0] ? "detached" : null) : row.attachCalls.length ? (row.attachCalls[0] ? "attached" : null) : null;
			log.taps.push(row);
			return row.kept;
		};
		o.attachSelected = function () { const r = att.call(this); log.attach.push(r); return r; };
		o.detachSelected = function () { const r = det.call(this); log.detach.push(r); return r; };
		// The drag's commit (InkOverlayLassoSpace.ts:707-708 on a lasso lift): the drag's total and box going in.
		const commit = o.commitLiveDrag;
		log.commits = [];
		o.commitLiveDrag = function () {
			log.commits.push({ dragTotal: this.dragTotal ? { ...this.dragTotal } : null, dragBox: this.dragBox ? { ...this.dragBox.box } : null,
				snapshotKind: this.spaceSnapshot ? this.spaceSnapshot.kind : null, t: performance.now() });
			return commit.call(this);
		};
		const tail = o.tail, draw = tail.drawAttachButton;
		tail.drawAttachButton = function (cam, bounds, detach, colours) { log.buttonDraws.push({ attached: !!detach, t: performance.now() }); return draw.call(this, cam, bounds, detach, colours); };
		rig.spyLog = log; rig.spyTail = tail;
		return true;
	},
	spyRead() {
		const log = rig.spyLog;
		return { downs: log.downs, ups: log.ups, taps: log.taps, commits: log.commits, attach: log.attach, detach: log.detach, lastButtonDraw: log.buttonDraws[log.buttonDraws.length - 1] ?? null,
			buttonDraws: log.buttonDraws.length, tailSame: rig.overlay.tail === rig.spyTail, notices: (window.__notices ?? []).slice() };
	},
	/** After the tap: the records holding the fresh stroke, and every number the first cells read, for the record. */
	async afterTap(freshId, n0) {
		const { overlay, view, path } = rig;
		await settle(6);
		const list = inlineInk.attachments(path), holding = list.filter(a => a.strokeIds.includes(freshId));
		const rec = holding[holding.length - 1] ?? null;
		const box = overlay.selectionBounds();
		const out = { attachments: list.length, before: n0, holding: holding.length, selection: overlay.selection.strokeIds.slice(), box,
			chips: selectionChips(overlay, list), defaultLineHeight: view.defaultLineHeight, cssScale: overlay.cssScale, scaleY: view.scaleY, fontZoom: overlay.fontZoom,
			camera: overlay.camera.snapshot, inkPan: { x: overlay.inkPanX(), y: overlay.inkPanY() }, inputPan: { x: overlay.inkInputPanX(), y: overlay.inkInputPanY() },
			scroll: { left: view.scrollDOM.scrollLeft, top: view.scrollDOM.scrollTop }, record: null, target: null, ref: null, lineRect: null, letterRect: null,
			inkCentreScreen: box ? toScreen({ x: box.x + box.width / 2, y: box.y + box.height / 2 }) : null, pinAt: null, pinHeadScreen: null };
		return rec ? fillRecord(out, rec) : out;
	},
};

/** A record's target, ref, its line's and first letter's screen rects and its pin head on screen, added to out. */
function fillRecord(out, rec) {
	const { overlay, view } = rig;
	{
		out.record = { id: rec.id, strokeIds: rec.strokeIds.length, probe: rec.probe };
		out.target = { kind: rec.target.kind, from: rec.target.from, to: rec.target.to, text: rec.target.text };
		out.ref = rec.ref;
		const at = view.domAtPos(rec.target.from).node, el = (at.nodeType === 1 ? at : at.parentElement)?.closest(".cm-line");
		out.lineRect = el ? rectOf(el.getBoundingClientRect()) : null;
		const l = view.coordsAtPos(rec.target.from, 1);
		out.letterRect = l ? rectOf(l) : null;
		const off = overlay.lineAnchors.follow.groupOffset(rec.id);
		if (off) {
			out.pinAt = { x: rec.ref.x + off.dx, y: rec.ref.y + off.dy };
			out.pinHeadScreen = toScreen(pinHead(out.pinAt, overlay.camera.snapshot.zoom, overlay.cssScale));
		}
		return out;
	}
}
`;

/** The ink file as Orion saved it, less the attach record and its two strokes. */
function sidecar(): string {
	const raw = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/drift-test-ink-a0af7bc7.json", import.meta.url)), "utf8"));
	raw.attachments = [];
	raw.strokes = raw.strokes.filter((s: { id: string }) => !ATTACHED_STROKES.some(p => s.id.startsWith(p)));
	return JSON.stringify(raw);
}

/** The ink file as Orion saved it, less the attach record only: its two strokes stay where they were saved (arm P). */
function sidecarKeepStrokes(): string {
	const raw = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/drift-test-ink-a0af7bc7.json", import.meta.url)), "utf8"));
	raw.attachments = [];
	return JSON.stringify(raw);
}

const DSF = 2;
const WINDOW = "1440,960";
const HOST = { paneW: 1440 - 44 - 200 - 254.67, paneH: 960 - 76, hostLeft: 44 + 200, hostTop: 76 };
const MINIMAL = readFileSync(fileURLToPath(new URL("./fixtures/minimal-9.0.2-theme.css", import.meta.url)), "utf8");

type Arm = { name: string; canvas: boolean; zoom: number; propsShown: boolean; scrollBy: number };
const ORION: Arm = { name: "orion", canvas: true, zoom: 2.32, propsShown: true, scrollBy: 0 };
const ARMS: Arm[] = [
	ORION,
	{ ...ORION, name: "probe-properties-hidden", propsShown: false },
	{ ...ORION, name: "probe-zoom-1", zoom: 1 },
	{ ...ORION, name: "probe-canvas-off", canvas: false },
	{ ...ORION, name: "probe-scrolled", scrollBy: 100 },
];

let browser: Browser | null = null;
let script = "";

beforeAll(async () => {
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "attachOrionRefPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./attachOrionObsidian.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true, args: [`--force-device-scale-factor=${DSF}`, `--window-size=${WINDOW}`] });
}, 180_000);
afterAll(async () => {
	if (browser) await browser.close();
});

const call = (p: Page, method: string, ...args: unknown[]) => p.evaluate(([n, a]) => (window as any).attachOrion[n](...a), [method, args] as const) as Promise<any>;

type R = { left: number; right: number; top: number; bottom: number };
/** Distance from a point to a rect, screen px: 0 inside. */
const toRect = (p: { x: number; y: number }, r: R) => Math.hypot(Math.max(r.left - p.x, 0, p.x - r.right), Math.max(r.top - p.y, 0, p.y - r.bottom));

/** A small zigzag over the letter's box: six turns, 2 px inside its sides, from its top to its bottom. */
function zigzag(r: R): { x: number; y: number }[] {
	const pts: { x: number; y: number }[] = [];
	for (let i = 0; i <= 12; i++) pts.push({ x: (i % 2 === 0 ? r.left + 1 : r.right - 1), y: r.top + 2 + (r.bottom - r.top - 4) * i / 12 });
	return pts;
}

async function draw(cdp: CDPSession, page: Page, points: { x: number; y: number }[], n: number) {
	await penStroke(cdp, points, { pressure: 0.5, between: async (i) => { if (i % 3 === 0) await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null)))); } });
	await call(page, "strokeLanded", n);
}

for (const arm of ARMS) it(`attach on Orion's state, ${arm.name}: the ink box sits on the target line and the pin head on its first letter`, async () => {
	const page = await (await browser!.newContext({ viewport: null })).newPage();
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	page.on("console", msg => { const t = msg.text(); if (/plugin crashed|isn't allowed during an update/.test(t)) errors.push(("console: " + t).slice(0, 200)); });
	try {
		await page.setContent('<!doctype html><body class="theme-dark" style="margin:0"></body>');
		await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS + INLINE_TITLE_CSS + MINIMAL });
		await page.addScriptTag({ content: script });
		const m = await call(page, "mount", { ...HOST, text: NOTE, sidecar: sidecar(), canvas: arm.canvas, zoom: arm.zoom, propsShown: arm.propsShown, scrollBy: arm.scrollBy });
		const s = await call(page, "letterS") as R | null;
		expect(s, "premise: the s of test is drawn").not.toBeNull();
		const before = await call(page, "strokeIds") as string[];
		const cdp = await page.context().newCDPSession(page);
		const pts = zigzag(s!);
		try {
			await draw(cdp, page, pts, before.length);
		} catch (e) {
			const line = `ATTACH-ORION ${JSON.stringify({ arm, mount: m, letterS: s, drawError: String(e).slice(0, 400), errors })}`;
			if (process.env.HW_ATTACH_ORION_OUT) appendFileSync(process.env.HW_ATTACH_ORION_OUT, line + "\n");
			throw e;
		}
		const r = await call(page, "attachFresh", before);
		const drawn = { left: Math.min(...pts.map(p => p.x)), right: Math.max(...pts.map(p => p.x)), top: Math.min(...pts.map(p => p.y)), bottom: Math.max(...pts.map(p => p.y)) };
		const lineH = r.lineRect ? r.lineRect.bottom - r.lineRect.top : null;
		const a = r.lineRect && r.inkCentreScreen ? toRect(r.inkCentreScreen, r.lineRect) : null;
		const b = r.letterRect && r.pinHeadScreen ? toRect(r.pinHeadScreen, r.letterRect) : null;
		const line = `ATTACH-ORION ${JSON.stringify({ arm, mount: m, letterS: s, drawn, ...r, lineH, a, b, errors })}`;
		// eslint-disable-next-line no-console
		console.log(line);
		if (process.env.HW_ATTACH_ORION_OUT) appendFileSync(process.env.HW_ATTACH_ORION_OUT, line + "\n");
		expect(m.canvas, "premise: Infinite Canvas as the arm sets it").toBe(arm.canvas);
		if (arm.canvas) expect(m.noteZoom, "premise: the note's zoom is the arm's").toBeCloseTo(arm.zoom, 6);
		expect(m.attachments, "premise: the note opens with no attach record").toBe(0);
		expect(r.fresh, "premise: one fresh stroke").toBe(1);
		expect(errors, "page errors").toEqual([]);
		expect(r.record, `a record lands (Attach offered: ${r.offered})`).not.toBeNull();
		expect(r.target?.text, "the target is the note's line").toBe("This is the test");
		expect(a, `(a) the ink box's centre is within one line height (${lineH} px) of the target line's rect, screen px`).toBeLessThanOrEqual(lineH!);
		expect(b, `(b) the pin head is within one line height (${lineH} px) of the target's first letter, screen px`).toBeLessThanOrEqual(lineH!);
	} finally {
		await page.context().close();
	}
}, 120_000);

/*
 * ALAN'S STEPS: the stroke is drawn off the line, lassoed with the pen, the box dragged onto
 * "This is the test", then one tap on the round Attach button. The first cell uses a finger for the drag and the tap, as
 * he did. Probes, one change each: a pen drag, a pen tap, a finger pan before the drag. Same Orion state as the first
 * cells: Infinite Canvas on, zoom 2.32, Properties shown, the drift-test note and its ink.
 *
 * The stroke: a zigzag 175 world units straight below the "s" of "test", on ink-free paper (the note's own ink covers the
 * words and the rows under them). The lasso: a pen loop round it, tip in lasso mode. The drag takes the box's centre to the
 * letter's centre. The tap lands on the Attach button's centre as the overlay places it (attachButtonPoint).
 * Asserted after the tap: (c) one record holds the stroke; (d) the button's last draw is the attached one
 * (InkOverlayLassoSpace.ts:1509-1511); (a) and (b) as above. Logged: the input pan's y before the drag, after it and at
 * the tap's press; whether the lift reached toggleAttach and what it did; every notice; every lasso press and lift.
 */
type Steps = { name: string; drag: "finger" | "pen"; tap: "finger" | "pen"; panFirst: boolean; fontPx?: number; dropSaved?: boolean };
const STEPS: Steps[] = [
	{ name: "alan-steps", drag: "finger", tap: "finger", panFirst: false },
	{ name: "probe-pen-drag", drag: "pen", tap: "finger", panFirst: false },
	{ name: "probe-pen-tap", drag: "finger", tap: "pen", panFirst: false },
	{ name: "probe-finger-pan-first", drag: "finger", tap: "finger", panFirst: true },
	// ARM D: arm P's settings (the editor at Orion's 10 px) with Alan's steps, finger drag and finger tap.
	{ name: "arm-D", drag: "finger", tap: "finger", panFirst: false, fontPx: ORION_FONT_PX },
	// Attach, then drop lower: arm D's steps, then a finger drag of the attached box to where Orion's two strokes were
	// saved (their box's centre, world 111.98, 157.64). A drop moves the record's probe with the ink and keeps its words
	// and its ref (InkOverlayLineAnchors.ts:1171-1180). Logged against Orion's record att-b35ae21d: paragraph 67..83, ref
	// (-0.01, 18.6), probe (109.78, 161.64), layout width 1184 font 10.
	{ name: "attach-then-drop", drag: "finger", tap: "finger", panFirst: false, fontPx: ORION_FONT_PX, dropSaved: true },
];

const nextFrame = (p: Page) => p.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));
const frames = async (p: Page, n: number) => { for (let i = 0; i < n; i++) await nextFrame(p); };
const touch = (cdp: CDPSession, type: string, x: number, y: number) =>
	cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 0.5 }] } as never);

/** One contact from a to b in `steps` moves, a frame apart, then the lift. A finger or the pen. */
async function contactDrag(cdp: CDPSession, page: Page, by: "finger" | "pen", a: { x: number; y: number }, b: { x: number; y: number }, steps: number) {
	const pts = Array.from({ length: steps + 1 }, (_, i) => ({ x: a.x + (b.x - a.x) * i / steps, y: a.y + (b.y - a.y) * i / steps }));
	if (by === "pen") {
		await penStroke(cdp, pts, { pressure: 0.5, between: () => nextFrame(page).then(() => undefined) });
		return;
	}
	await touch(cdp, "touchStart", a.x, a.y);
	try {
		for (const p of pts.slice(1)) {
			await frames(page, 1);
			await touch(cdp, "touchMove", p.x, p.y);
		}
		await frames(page, 1);
	} finally {
		await touch(cdp, "touchEnd", b.x, b.y);
	}
}

/** One tap: down, a frame, up, at the same point. */
async function tapAt(cdp: CDPSession, page: Page, by: "finger" | "pen", at: { x: number; y: number }) {
	if (by === "pen") {
		await penPress(cdp, at.x, at.y, { pressure: 0.5 });
		await frames(page, 1);
		await penRelease(cdp, at.x, at.y);
		return;
	}
	await touch(cdp, "touchStart", at.x, at.y);
	await frames(page, 1);
	await touch(cdp, "touchEnd", at.x, at.y);
}

/*
 * ARM P: Orion's saved ink, no drag. The ink file as Orion saved it less its one record, so its two strokes (58e43e1e,
 * 9ff3cb67) stand where saved (box x 80.8..143.1, y 136.1..179.2), far under the note's last line; the Orion settings with
 * the editor at Orion's 10 px against the file's 12 px reference. A pen lasso round the two strokes as shown, then one pen
 * tap on the round Attach button. Ink under all the text overlaps no text line: it attaches nothing and says so. (Orion's
 * record on these strokes reads as an attach made on the line and then dropped lower, the attach-then-drop cell below.)
 * Asserted: the tap reached toggleAttach; no record holds the strokes; the notice is "No text under the ink". Logged
 * (pickRead) at the lasso and after the tap: h, the block's from, to, top and bottom, its type and parts, the block above
 * and whether it is a widget, line 5's block, defaultLineHeight, scaleY, fontZoom, the doc's lines.
 */
const SAVED_PROBE = "58e43e1e-ee98-4ee5-a993-56935477dba3";
it("arm P, Orion's saved ink: the two strokes where saved, far under the text, a pen lasso, a pen tap on Attach: nothing attaches, the notice says so", async () => {
	const context = await browser!.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: DSF, hasTouch: true });
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	page.on("console", msg => { const t = msg.text(); if (/plugin crashed|isn't allowed during an update/.test(t)) errors.push(("console: " + t).slice(0, 200)); });
	const rows: Record<string, unknown> = { arm: "P" };
	const out = (extra: Record<string, unknown>) => {
		const line = `ATTACH-ORION-P ${JSON.stringify({ ...rows, ...extra, errors })}`;
		// eslint-disable-next-line no-console
		console.log(line);
		if (process.env.HW_ATTACH_ORION_OUT) appendFileSync(process.env.HW_ATTACH_ORION_OUT, line + "\n");
	};
	try {
		await page.setContent('<!doctype html><body class="theme-dark" style="margin:0"></body>');
		await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS + titleCss(ORION_FONT_PX) + MINIMAL });
		await page.addScriptTag({ content: script });
		const cdp = await context.newCDPSession(page);
		const m = await call(page, "mount", { ...HOST, ...ORION, text: NOTE, sidecar: sidecarKeepStrokes(), fontPx: ORION_FONT_PX });
		rows.mount = m;
		const saved = await call(page, "strokesNow", ATTACHED_STROKES) as { id: string; screen: R | null }[];
		rows.saved = saved;
		expect(saved.length, "premise: the two saved strokes load").toBe(2);
		expect(saved.every(x => x.screen), "premise: both are shown").toBe(true);
		const box = { left: Math.min(...saved.map(x => x.screen!.left)), right: Math.max(...saved.map(x => x.screen!.right)),
			top: Math.min(...saved.map(x => x.screen!.top)), bottom: Math.max(...saved.map(x => x.screen!.bottom)) };
		rows.savedScreen = box;
		// The lasso: the tip in lasso mode, a pen loop 12 screen px outside the two strokes' box.
		await call(page, "setTip", "lasso");
		const cx = (box.left + box.right) / 2, cy = (box.top + box.bottom) / 2, rx = (box.right - box.left) / 2 + 12, ry = (box.bottom - box.top) / 2 + 12;
		await penStroke(cdp, Array.from({ length: 37 }, (_, i) => ({ x: cx + rx * Math.cos(2 * Math.PI * i / 36), y: cy + ry * Math.sin(2 * Math.PI * i / 36) })),
			{ pressure: 0.5, between: async (i) => { if (i % 3 === 0) await nextFrame(page); } });
		await frames(page, 8);
		const sel = await call(page, "selectionNow");
		rows.lassoed = sel;
		rows.pickAtLasso = await call(page, "pickRead");
		expect([...sel.ids].sort(), "premise: the lasso holds the two saved strokes alone").toEqual(saved.map(x => x.id).sort());
		expect(sel.button, "premise: the selection has an Attach button to tap").not.toBeNull();
		await call(page, "spy");
		await tapAt(cdp, page, "pen", sel.button);
		const after = await call(page, "afterTap", SAVED_PROBE, 0);
		const spy = await call(page, "spyRead");
		rows.pickAfterTap = await call(page, "pickRead");
		const tapDown = spy.downs[spy.downs.length - 1] ?? null, tapUp = spy.ups[spy.ups.length - 1] ?? null;
		out({ after, spy, tapDown, tapUp });
		expect(errors, "page errors").toEqual([]);
		expect.soft(tapUp?.reachesToggle ?? false, `the pen tap's lift reached toggleAttach (press ${JSON.stringify(tapDown)}, lift ${JSON.stringify(tapUp)})`).toBe(true);
		expect.soft(after.holding, `no record holds the strokes (records ${after.attachments}, attach returned ${JSON.stringify(spy.attach)})`).toBe(0);
		expect.soft(spy.notices, "the notice says there is no text under the ink").toEqual(["No text under the ink"]);
	} catch (e) {
		out({ failedAt: String(e).slice(0, 600) });
		throw e;
	} finally {
		await context.close();
	}
}, 120_000);

/*
 * ARM T: tall ink, as in Alan's picture. Orion's state with no Properties
 * block, the editor at Orion's 10 px. One tall pen stroke through the "s" of "test" (a zigzag across the letter's width),
 * its box from 1.8 line heights above line 5's top to 5.7 line heights under line 5's bottom (line height = the line's own
 * screen rect). A pen lasso round it, then one finger tap on the round Attach button.
 * Asserted, what Alan expects: the tap reached toggleAttach; one record holds the stroke; its target is "This is the test";
 * the button's last draw is attached. Logged: pickRead before the tap (h, the block's top
 * and bottom, defaultLineHeight), the toggle's return, any notice text.
 * Probe, one change: the fixture's record and its two strokes left in (outside the lasso).
 */
const TALL: { name: string; keepSaved: boolean }[] = [
	{ name: "arm T", keepSaved: false },
	{ name: "arm T probe-saved-record-in", keepSaved: true },
];
for (const t of TALL) it(`${t.name}, tall ink through the s of test, pen lasso, finger tap on Attach: one record on This is the test, the button attached`, async () => {
	const context = await browser!.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: DSF, hasTouch: true });
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	page.on("console", msg => { const tx = msg.text(); if (/plugin crashed|isn't allowed during an update/.test(tx)) errors.push(("console: " + tx).slice(0, 200)); });
	const rows: Record<string, unknown> = { arm: t };
	const out = (extra: Record<string, unknown>) => {
		const line = `ATTACH-ORION-T ${JSON.stringify({ ...rows, ...extra, errors })}`;
		// eslint-disable-next-line no-console
		console.log(line);
		if (process.env.HW_ATTACH_ORION_OUT) appendFileSync(process.env.HW_ATTACH_ORION_OUT, line + "\n");
	};
	try {
		await page.setContent('<!doctype html><body class="theme-dark" style="margin:0"></body>');
		await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS + titleCss(ORION_FONT_PX) + MINIMAL });
		await page.addScriptTag({ content: script });
		const cdp = await context.newCDPSession(page);
		const fixture = t.keepSaved ? readFileSync(fileURLToPath(new URL("./fixtures/drift-test-ink-a0af7bc7.json", import.meta.url)), "utf8") : sidecar();
		const m = await call(page, "mount", { ...HOST, ...ORION, propsShown: false, text: NOTE, sidecar: fixture, fontPx: ORION_FONT_PX });
		rows.mount = m;
		expect(m.attachments, "premise: the record count the arm sets").toBe(t.keepSaved ? 1 : 0);
		const s = await call(page, "letterS");
		rows.letterS = s;
		expect(s?.line, "premise: line 5 is drawn").toBeTruthy();
		const lh = s.line.bottom - s.line.top;
		const spot = { left: s.left - 2, right: s.right + 2, top: s.line.top - 1.8 * lh, bottom: s.line.bottom + 5.7 * lh };
		rows.spot = spot; rows.lineH = lh;
		const before = await call(page, "strokeIds") as string[];
		await draw(cdp, page, zigzag(spot), before.length);
		const fresh = (await call(page, "strokeIds") as string[]).filter(id => !before.includes(id));
		rows.fresh = fresh;
		expect(fresh.length, "premise: one fresh stroke").toBe(1);
		rows.strokeDrawn = await call(page, "strokesNow", fresh);
		// The lasso: a pen loop 14 screen px round the stroke's drawn box.
		await call(page, "setTip", "lasso");
		const cx = (spot.left + spot.right) / 2, cy = (spot.top + spot.bottom) / 2, rx = (spot.right - spot.left) / 2 + 14, ry = (spot.bottom - spot.top) / 2 + 14;
		await penStroke(cdp, Array.from({ length: 49 }, (_, i) => ({ x: cx + rx * Math.cos(2 * Math.PI * i / 48), y: cy + ry * Math.sin(2 * Math.PI * i / 48) })),
			{ pressure: 0.5, between: async (i) => { if (i % 3 === 0) await nextFrame(page); } });
		await frames(page, 8);
		const sel = await call(page, "selectionNow");
		rows.lassoed = sel;
		expect(sel.ids, "premise: the lasso holds the tall stroke alone").toEqual(fresh);
		expect(sel.button, "premise: the selection has an Attach button to tap").not.toBeNull();
		await call(page, "spy");
		await call(page, "palmClear");
		rows.fingerClaimsButton = await call(page, "claims", sel.button.x, sel.button.y);
		rows.pickAtTap = await call(page, "pickRead");
		await tapAt(cdp, page, "finger", sel.button);
		const after = await call(page, "afterTap", fresh[0], t.keepSaved ? 1 : 0);
		const spy = await call(page, "spyRead");
		const tapUp = spy.taps[spy.taps.length - 1] ?? null;
		out({ after, spy, tapUp });
		expect(errors, "page errors").toEqual([]);
		expect.soft(tapUp?.reachesToggle ?? false, `the finger tap reached toggleAttach (lift ${JSON.stringify(tapUp)})`).toBe(true);
		expect.soft(after.holding, `one record holds the stroke (records ${after.attachments}, attach returned ${JSON.stringify(spy.attach)}, notices ${JSON.stringify(spy.notices)})`).toBe(1);
		expect.soft(after.target?.text ?? null, "the target is the note's line").toBe("This is the test");
		expect.soft(spy.lastButtonDraw?.attached ?? null, `the button draws as attached (draws ${spy.buttonDraws}, tail kept ${spy.tailSame})`).toBe(true);
	} catch (e) {
		out({ failedAt: String(e).slice(0, 600) });
		throw e;
	} finally {
		await context.close();
	}
}, 120_000);

for (const st of STEPS) it(`attach on Orion's state by Alan's steps, ${st.name}: one record holds the stroke, the button shows attached, the box on its line, the pin on its letter`, async () => {
	const context = await browser!.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: DSF, hasTouch: true });
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	page.on("console", msg => { const t = msg.text(); if (/plugin crashed|isn't allowed during an update/.test(t)) errors.push(("console: " + t).slice(0, 200)); });
	const rows: Record<string, unknown> = { steps: st };
	const out = (extra: Record<string, unknown>) => {
		const line = `ATTACH-ORION-STEPS ${JSON.stringify({ ...rows, ...extra, errors })}`;
		// eslint-disable-next-line no-console
		console.log(line);
		if (process.env.HW_ATTACH_ORION_OUT) appendFileSync(process.env.HW_ATTACH_ORION_OUT, line + "\n");
	};
	try {
		await page.setContent('<!doctype html><body class="theme-dark" style="margin:0"></body>');
		await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS + titleCss(st.fontPx ?? FONT_PX) + MINIMAL });
		await page.addScriptTag({ content: script });
		const cdp = await context.newCDPSession(page);
		const m = await call(page, "mount", { ...HOST, ...ORION, text: NOTE, sidecar: sidecar(), fontPx: st.fontPx ?? FONT_PX });
		rows.mount = m;
		const s0 = await call(page, "letterS") as R | null;
		expect(s0, "premise: the s of test is drawn").not.toBeNull();
		// The stroke, off the line: 175 world units below the letter, on paper with no ink.
		const below = 175 * m.cssScale * m.cameraZoom;
		const spot = { left: s0!.left - 8, right: s0!.right + 8, top: s0!.top + below, bottom: s0!.top + below + 30 };
		const before = await call(page, "strokeIds") as string[];
		await draw(cdp, page, zigzag(spot), before.length);
		const fresh = (await call(page, "strokeIds") as string[]).filter(id => !before.includes(id));
		rows.fresh = fresh;
		expect(fresh.length, "premise: one fresh stroke").toBe(1);
		// The lasso: the tip in lasso mode, a pen loop round the stroke.
		await call(page, "setTip", "lasso");
		const cx = (spot.left + spot.right) / 2, cy = (spot.top + spot.bottom) / 2, R0 = 55;
		await penStroke(cdp, Array.from({ length: 37 }, (_, i) => ({ x: cx + R0 * Math.cos(2 * Math.PI * i / 36), y: cy + R0 * Math.sin(2 * Math.PI * i / 36) })),
			{ pressure: 0.5, between: async (i) => { if (i % 3 === 0) await nextFrame(page); } });
		await frames(page, 8);
		const sel0 = await call(page, "selectionNow");
		rows.lassoed = sel0;
		expect(sel0.ids, "premise: the lasso holds the fresh stroke alone").toEqual(fresh);
		await call(page, "spy");
		if (st.panFirst) {
			await call(page, "palmClear");
			const p0 = { x: m.pane.left + 120, y: m.pane.top + 700 };
			await contactDrag(cdp, page, "finger", p0, { x: p0.x, y: p0.y - 100 }, 15);
			await frames(page, 8);
			rows.afterPan = await call(page, "selectionNow");
		}
		const s = await call(page, "letterS") as R;
		const from = await call(page, "selectionNow");
		rows.beforeDrag = from;
		expect(from.centre, "premise: the box is on screen to drag").toBeTruthy();
		if (st.drag === "finger") {
			await call(page, "palmClear");
			rows.fingerClaimsBox = await call(page, "claims", from.centre.x, from.centre.y);
		}
		const target = { x: (s.left + s.right) / 2, y: (s.top + s.bottom) / 2 };
		await contactDrag(cdp, page, st.drag, from.centre, target, 20);
		await frames(page, 8);
		const dragged = await call(page, "selectionNow");
		rows.afterDrag = dragged;
		rows.letterAtDrag = s;
		// The stroke after the lift: stored and shown, and what the line pick reads.
		rows.strokeAfterLift = await call(page, "strokesNow", fresh);
		rows.pickAfterLift = await call(page, "pickRead");
		rows.commitsAtLift = (await call(page, "spyRead")).commits;
		expect(dragged.button, "premise: the selection has an Attach button to tap").not.toBeNull();
		if (st.tap === "finger") {
			await call(page, "palmClear");
			rows.fingerClaimsButton = await call(page, "claims", dragged.button.x, dragged.button.y);
		}
		rows.strokeAtTap = await call(page, "strokesNow", fresh);
		rows.pickAtTap = await call(page, "pickRead");
		await tapAt(cdp, page, st.tap, dragged.button);
		// Read after the frames the tap's redraw takes (afterTap settles first), so the button's last draw is the tap's.
		const nDowns = (await call(page, "spyRead")).downs.length;
		const after = await call(page, "afterTap", fresh[0], 0);
		const spy = await call(page, "spyRead");
		rows.spy = spy;
		const lineH = after.lineRect ? after.lineRect.bottom - after.lineRect.top : null;
		const a = after.lineRect && after.inkCentreScreen ? toRect(after.inkCentreScreen, after.lineRect) : null;
		const b = after.letterRect && after.pinHeadScreen ? toRect(after.pinHeadScreen, after.letterRect) : null;
		// The tap's own row: a pen tap is a lasso press and lift; a finger tap is the router's tap lift.
		const tapDown = st.tap === "pen" ? spy.downs[spy.downs.length - 1] ?? null : null;
		const tapUp = st.tap === "pen" ? spy.ups[spy.ups.length - 1] ?? null : spy.taps[spy.taps.length - 1] ?? null;
		out({ after, lineH, a, b, panY: { beforeDrag: from.panY, afterDrag: dragged.panY, atTap: tapUp?.panY ?? null }, tapDown, tapUp, lassoPressesAtTap: nDowns });
		expect(errors, "page errors").toEqual([]);
		expect.soft(tapUp?.reachesToggle ?? false, `the tap's lift reached toggleAttach (press ${JSON.stringify(tapDown)}, lift ${JSON.stringify(tapUp)}, notices ${JSON.stringify(spy.notices)})`).toBe(true);
		expect.soft(after.holding, `(c) one record holds the stroke (records ${after.attachments}, notices ${JSON.stringify(spy.notices)})`).toBe(1);
		expect.soft(spy.lastButtonDraw?.attached ?? null, `(d) the button draws as attached (draws ${spy.buttonDraws}, tail kept ${spy.tailSame})`).toBe(true);
		expect.soft(a, `(a) the ink box's centre is within one line height (${lineH} px) of the target line's rect, screen px`).not.toBeNull();
		if (a !== null) expect.soft(a, "(a) distance, screen px").toBeLessThanOrEqual(lineH!);
		expect.soft(b, `(b) the pin head is within one line height (${lineH} px) of the target's first letter, screen px`).not.toBeNull();
		if (b !== null) expect.soft(b, "(b) distance, screen px").toBeLessThanOrEqual(lineH!);
		if (st.dropSaved) {
			const recBefore = await call(page, "recordOf", fresh[0]);
			const sel1 = await call(page, "selectionNow");
			expect(recBefore, "premise: the stroke is attached before the drop").not.toBeNull();
			expect(sel1.centre, "premise: the attached box is selected, on screen").toBeTruthy();
			const savedCentre = { x: (80.84 + 143.11) / 2, y: (136.05 + 179.23) / 2 };
			const to = await call(page, "screenOf", savedCentre);
			const shownBefore = await call(page, "strokesNow", fresh);
			await call(page, "palmClear");
			await contactDrag(cdp, page, "finger", sel1.centre, to, 20);
			await frames(page, 8);
			const dropped = await call(page, "selectionNow");
			const recAfter = await call(page, "recordOf", fresh[0]);
			const shownAfter = await call(page, "strokesNow", fresh);
			const commits = (await call(page, "spyRead")).commits;
			const orion = { target: { kind: "paragraph", from: 67, to: 83 }, ref: { x: -0.01, y: 18.6 }, probe: { x: 109.78, y: 161.64 }, layout: { width: 1184, font: 10 } };
			const shownDy = shownAfter[0] && shownBefore[0] && shownAfter[0].shown && shownBefore[0].shown ? shownAfter[0].shown.y - shownBefore[0].shown.y : null;
			out({ drop: { recBefore, recAfter, orion, selBefore: sel1, dropped, to, savedCentre, shownBefore, shownAfter, shownDy, commits } });
			expect.soft(recAfter?.holding ?? 0, "after the drop one record still holds the stroke").toBe(1);
			expect.soft(recAfter ? [recAfter.target.kind, recAfter.target.from, recAfter.target.to] : null, "the drop keeps the words, paragraph 67..83").toEqual(["paragraph", 67, 83]);
			expect.soft(recAfter?.ref ?? null, "the drop keeps the ref").toEqual(recBefore.ref);
			expect.soft(shownDy !== null && shownDy > 100, `the ink went down to the saved place (shown dy ${shownDy})`).toBe(true);
			if (recAfter && shownDy !== null) expect.soft(Math.abs(recAfter.probe.y - recBefore.probe.y - shownDy), "the probe moved with the ink").toBeLessThanOrEqual(0.5);
		}
	} catch (e) {
		out({ failedAt: String(e).slice(0, 600) });
		throw e;
	} finally {
		await context.close();
	}
}, 120_000);
