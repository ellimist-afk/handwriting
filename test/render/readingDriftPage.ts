/**
 * The page for ReadingDrift.test.ts. A measurement rig: it changes nothing.
 *
 * One note's text and sidecar, shown two ways in one page each: the real CodeMirror editor with the real ink overlay
 * (mounted as scrollColumnAnchorPage.ts mount() does, cut to the minimum), and the ReadingViewJump rig's Reading view
 * (readingViewJumpPage.ts readingViewOf, copied). For each view the page reports, for chosen strokes, where the stroke's
 * box lands on screen, as px from the first body text line's top-left and as px inside the scroller's viewport.
 *
 * Editor transform: the overlay's own camera. visual = container rect + worldToScreen(camera, world) * cssScale
 * (src/camera/coordinates.ts worldToScreen; src/inline/InkOverlayCamera.ts syncCamera reads `this.container` rect at
 * :31 and sets the camera at :180; the composition is the one src/camera/FontZoomTransform.test.ts:17 spells out).
 * Reading view transform: the ink's world origin in client px = the view root's padding box, less its scroll, plus
 * embedInkAnchor(root) (src/inline/EmbedInkRoot.ts:269), the anchor EmbedInk.ts anchorLayer (:358) places the layer
 * from; a stroke is drawn at origin + world * inkZoomOf (EmbedInk.ts:661).
 * Both are checked against painted pixels of the stroke's own colour in single-stroke mounts.
 */
import { EditorState, RangeSetBuilder, StateField } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { inlineInk, inkOverlayExtension, overlayForPath, setScrollExpansionEnabled } from "../../src/inline/InkOverlay";
import { attachEmbedInkOnceReady, embedInkFileOpened, initEmbedInkFontRef, initEmbedInkRefresh, inkZoomOf, placeStrokes, teardownEmbedInk } from "../../src/inline/EmbedInk";
import { embedInkAnchor } from "../../src/inline/EmbedInkRoot";
import { splitLines } from "../../src/inline/EmbedInkLines";
import { setPenInk } from "../../src/inline/PenInk";
import type { InkStroke } from "../../src/ink/Stroke";
import { parsePage } from "../../src/model/PageData";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField } from "./iphoneObsidianStub";

installObsidianDom();

const PATH = "Untitled 1.md";
const PAGE_ID = "75d1627a-c4d7-4a11-947d-bc26b7f83c20";
const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await frame(); };
const r2 = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const w = window as unknown as Record<string, unknown>;

const ids = new Map<string, string>();
const sidecars = new Map<string, string>();
inlineInk.attachHost({
	readPageId: (p) => ids.get(p) ?? null,
	claimId: async (p, id) => { ids.set(p, id); return { pageId: id }; },
	loadSidecar: async (id) => (sidecars.has(id) ? parsePage(sidecars.get(id)!, id) : null),
	scheduleSidecar: () => {},
	scheduleSidecarNow: async () => {},
	notify: () => {},
});

let STROKES: InkStroke[] = [];
let FONT_REF = 17;

type Box = { x: number; y: number; width: number; height: number };
type Pt = { x: number; y: number };

/** The sidecar with only `keep` strokes, and no paper (so painted pixels are ink alone). */
function sidecarWith(sidecar: string, keep: string[] | null): string {
	if (!keep) return sidecar;
	const j = JSON.parse(sidecar);
	j.strokes = j.strokes.filter((s: { id: string }) => keep.includes(s.id));
	delete j.notePaper;
	return JSON.stringify(j);
}

w.driftLoad = (sidecar: string) => {
	const parsed = parsePage(sidecar, PAGE_ID);
	STROKES = parsed.data.strokes as InkStroke[];
	FONT_REF = parsed.data.fontRefPx ?? 17;
	const colours: Record<string, number> = {};
	for (const s of STROKES) colours[s.color] = (colours[s.color] ?? 0) + 1;
	const purple = STROKES.filter((s) => s.color.toLowerCase() === "#7a4bbd").sort((a, b) => a.bbox.x + a.bbox.y - (b.bbox.x + b.bbox.y));
	const far = [...STROKES].sort((a, b) => b.bbox.x + b.bbox.width + b.bbox.y + b.bbox.height - (a.bbox.x + a.bbox.width + a.bbox.y + a.bbox.height))[0]!;
	const p0 = purple[0]!;
	// The purple strokes near the first one (the written words "Vault test"): within 250 world of its box.
	const cluster = purple.filter((s) => Math.abs(s.bbox.x - p0.bbox.x) < 250 && Math.abs(s.bbox.y - p0.bbox.y) < 120);
	const union = cluster.reduce((u, s) => ({ x0: Math.min(u.x0, s.bbox.x), y0: Math.min(u.y0, s.bbox.y), x1: Math.max(u.x1, s.bbox.x + s.bbox.width), y1: Math.max(u.y1, s.bbox.y + s.bbox.height) }), { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 });
	let ext = { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 };
	for (const s of STROKES) ext = { x0: Math.min(ext.x0, s.bbox.x), y0: Math.min(ext.y0, s.bbox.y), x1: Math.max(ext.x1, s.bbox.x + s.bbox.width), y1: Math.max(ext.y1, s.bbox.y + s.bbox.height) };
	return {
		strokes: STROKES.length, fontRef: FONT_REF, damaged: parsed.damaged ?? false, colours,
		purple: { id: p0.id, color: p0.color, bbox: p0.bbox, firstPurpleByXY: purple.slice(0, 5).map((s) => ({ id: s.id, bbox: s.bbox })), clusterN: cluster.length, clusterUnion: union },
		far: { id: far.id, color: far.color, bbox: far.bbox },
		inkExtent: ext,
	};
};

const byId = (id: string) => STROKES.find((s) => s.id === id)!;

/** Painted pixels near `rgb` on every 2d canvas under `container`, as a client-px box, or null. */
function paintedBox(container: HTMLElement, hex: string | null, near?: { x0: number; y0: number; x1: number; y1: number }) {
	const rgb = hex ? [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) : null;
	let sample: number[] | null = null;
	let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, n = 0;
	for (const c of Array.from(container.querySelectorAll("canvas"))) {
		if (c.width === 0 || c.height === 0) continue;
		const ctx = c.getContext("2d");
		if (!ctx) continue;
		const r = c.getBoundingClientRect();
		// The content box: a Reading view tile carries transparent borders out to the ink box's far edges.
		const sx = c.clientWidth / c.width, sy = c.clientHeight / c.height;
		const bl = r.left + c.clientLeft, bt = r.top + c.clientTop;
		const d = ctx.getImageData(0, 0, c.width, c.height).data;
		for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
			const k = (y * c.width + x) * 4;
			if (d[k + 3]! < 160) continue;
			if (rgb && (Math.abs(d[k]! - rgb[0]!) > 40 || Math.abs(d[k + 1]! - rgb[1]!) > 40 || Math.abs(d[k + 2]! - rgb[2]!) > 40)) continue;
			const cx = bl + (x + 0.5) * sx, cy = bt + (y + 0.5) * sy;
			if (near && (cx < near.x0 || cx > near.x1 || cy < near.y0 || cy > near.y1)) continue;
			n++;
			sample ??= [d[k]!, d[k + 1]!, d[k + 2]!, d[k + 3]!];
			x0 = Math.min(x0, cx); y0 = Math.min(y0, cy); x1 = Math.max(x1, cx); y1 = Math.max(y1, cy);
		}
	}
	return n === 0 ? null : { x0: r2(x0), y0: r2(y0), x1: r2(x1), y1: r2(y1), cx: r2((x0 + x1) / 2), cy: r2((y0 + y1) / 2), n, rgba: sample };
}

/** The first character's client rect of `text` inside `el` (the first body text line's top-left). */
function firstTextAt(el: HTMLElement, text: string): Pt | null {
	const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
	for (let n = walker.nextNode(); n; n = walker.nextNode()) {
		const i = (n.textContent ?? "").indexOf(text);
		if (i < 0) continue;
		const range = document.createRange();
		range.setStart(n, i);
		range.setEnd(n, i + 1);
		const r = range.getClientRects()[0] ?? range.getBoundingClientRect();
		return { x: r.left, y: r.top };
	}
	return null;
}

/** One row per stroke: screen box (client px), offset of its top-left from the text line, place in the viewport. */
function rowsFor(idsWanted: string[], toClient: (x: number, y: number) => Pt, text: Pt, vp: DOMRect, shownOf: (id: string) => InkStroke = byId) {
	return idsWanted.map((id) => {
		const s = shownOf(id);
		const a = toClient(s.bbox.x, s.bbox.y), b = toClient(s.bbox.x + s.bbox.width, s.bbox.y + s.bbox.height);
		return {
			id, client: { x0: r2(a.x), y0: r2(a.y), x1: r2(b.x), y1: r2(b.y), cx: r2((a.x + b.x) / 2), cy: r2((a.y + b.y) / 2) },
			dx: r2(a.x - text.x), dy: r2(a.y - text.y),
			vx: r2(a.x - vp.left), vy: r2(a.y - vp.top),
			onScreen: b.x > vp.left && a.x < vp.right && b.y > vp.top && a.y < vp.bottom,
			shownMinusStoredWorld: { x: r2(s.bbox.x - byId(id).bbox.x), y: r2(s.bbox.y - byId(id).bbox.y) },
		};
	});
}

// ---------------------------------------------------------------- the editor

const EDITOR_CSS = (font: number, lh: number) => `
body { margin: 0; }
.markdown-source-view.mod-cm6 .cm-content { font-size: ${font}px; line-height: ${lh}; font-family: sans-serif; }
.markdown-source-view.mod-cm6 .cm-scroller { padding: 0 32px; }
`;

/** The frontmatter lines hidden as Alan's editor shows them (the sidecar's anchors put line 4's top at world y 0). */
function hideFrontmatter(doc: string) {
	const lines = doc.split("\n");
	let end = -1;
	if (lines[0] === "---") for (let i = 1; i < lines.length; i++) if (lines[i] === "---") { end = i; break; }
	const field = StateField.define<DecorationSet>({
		create(state) {
			const b = new RangeSetBuilder<Decoration>();
			if (end > 0) b.add(0, state.doc.line(end + 1).to + 1, Decoration.replace({ block: true }));
			return b.finish();
		},
		update: (d) => d,
		provide: (f) => EditorView.decorations.from(f),
	});
	return field;
}

let EV: EditorView | null = null;

w.driftEditorMount = async (o: { text: string; sidecar: string; keep: string[] | null; font: number; lh: number; paneW: number; paneH: number }) => {
	setPenInk(true);
	setScrollExpansionEnabled(true);
	ids.set(PATH, PAGE_ID);
	sidecars.set(PAGE_ID, sidecarWith(o.sidecar, o.keep));
	const st = document.head.appendChild(document.createElement("style"));
	st.textContent = EDITOR_CSS(o.font, o.lh);
	const pane = document.body.appendChild(document.createElement("div"));
	pane.className = "markdown-source-view mod-cm6 is-readable-line-width is-live-preview";
	pane.style.cssText = `position:relative;width:${o.paneW}px;height:${o.paneH}px;overflow:hidden`;
	const view = new EditorView({ parent: pane, state: EditorState.create({ doc: o.text, extensions: [
		EditorView.lineWrapping,
		editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path: PATH }, editor: {} }) as any),
		hideFrontmatter(o.text),
		inkOverlayExtension() as any[],
		EditorView.theme({ "&": { width: `${o.paneW}px`, height: `${o.paneH}px` }, ".cm-scroller": { overflowY: "auto", overflowX: "hidden" } }),
	] }) });
	// Obsidian's .cm-sizer wrapper (scrollColumnAnchorPage.ts installSizer).
	const content = view.contentDOM;
	const sizer = document.createElement("div");
	sizer.className = "cm-sizer";
	const container = document.createElement("div");
	container.className = "cm-contentContainer";
	content.parentElement!.insertBefore(sizer, content);
	sizer.appendChild(container);
	container.appendChild(content);
	EV = view;
	await settle(30);
	const ov = overlayForPath(PATH) as any;
	if (!ov) return { error: "no overlay" };
	return { mounted: true, strokesInOverlay: (ov.strokes ?? ov.page?.strokes ?? []).length ?? null, ...editorState() };
};

function editorState() {
	const ov = overlayForPath(PATH) as any;
	const sc = EV!.scrollDOM;
	return {
		pinch: r2(ov.pinchScaleNow), cssScale: Math.round(ov.cssScale * 1e4) / 1e4, fontZoom: Math.round(ov.fontZoom * 1e4) / 1e4, scale: Math.round(ov.scale * 1e4) / 1e4,
		refFontPx: ov.refFontPx, canvas: !!ov.canvasModeOn?.(), camera: ov.camera.snapshot,
		scrollLeft: r2(sc.scrollLeft), scrollTop: r2(sc.scrollTop), scrollWidth: sc.scrollWidth, scrollHeight: sc.scrollHeight,
		contentFont: getComputedStyle(EV!.contentDOM).fontSize,
	};
}

function editorToClient(): (x: number, y: number) => Pt {
	const ov = overlayForPath(PATH) as any;
	const cr = (ov.container as HTMLElement).getBoundingClientRect();
	const k = ov.cssScale as number;
	return (x, y) => { const s = ov.camera.worldToScreen(x, y); return { x: cr.left + s.x * k, y: cr.top + s.y * k }; };
}

w.driftEditorRead = async (o: { ids: string[]; pixels?: boolean }) => {
	await settle(6);
	const view = EV!;
	const line = view.domAtPos(view.state.doc.line(4).from).node;
	const lineEl = (line.nodeType === 1 ? line : line.parentElement) as HTMLElement;
	const cm = lineEl.closest(".cm-line") as HTMLElement ?? lineEl;
	const text = firstTextAt(cm, "d");
	if (!text) return { error: "no first text line" };
	const vp = view.scrollDOM.getBoundingClientRect();
	const toClient = editorToClient();
	const rows = rowsFor(o.ids, toClient, text, vp);
	const out: Record<string, unknown> = { state: editorState(), text: { x: r2(text.x), y: r2(text.y) }, viewport: { left: r2(vp.left), top: r2(vp.top), w: r2(vp.width), h: r2(vp.height) }, rows };
	if (o.pixels) out.pixels = rows.map((r) => {
		const s = byId(r.id);
		const pad = 40;
		const p = paintedBox(view.dom, s.color, { x0: r.client.x0! - pad, y0: r.client.y0! - pad, x1: r.client.x1! + pad, y1: r.client.y1! + pad });
		return { id: r.id, painted: p, dcx: p ? r2(p.cx! - r.client.cx!) : null, dcy: p ? r2(p.cy! - r.client.cy!) : null };
	});
	return out;
};

w.driftEditorZoom = async (next: number) => {
	const ov = overlayForPath(PATH) as any;
	const ok = ov.zoomAroundCenter(next);
	await settle(20);
	return { accepted: ok, ...editorState() };
};

/** Scroll so the stroke's centre sits at the viewport's centre (clamped by the scroller). */
w.driftEditorScrollTo = async (id: string) => {
	const s = byId(id);
	for (let i = 0; i < 4; i++) {
		const to = editorToClient();
		const c = to(s.bbox.x + s.bbox.width / 2, s.bbox.y + s.bbox.height / 2);
		const vp = EV!.scrollDOM.getBoundingClientRect();
		EV!.scrollDOM.scrollLeft += c.x - (vp.left + vp.width / 2);
		EV!.scrollDOM.scrollTop += c.y - (vp.top + vp.height / 2);
		await settle(10);
	}
	return editorState();
};

// ---------------------------------------------------------------- Reading view (readingViewJumpPage.ts, copied)

const VIEW_CSS = (font: number, lh: number, paneW: number, paneH: number) => `
body { margin: 0; font-family: sans-serif; }
.markdown-preview-view { font-size: ${font}px; line-height: ${lh}; padding: 32px; position: relative; overflow: auto; box-sizing: border-box; width: ${paneW}px; height: ${paneH}px; }
.markdown-rendered > :first-child { margin-top: 0; }
.markdown-rendered p { margin-block-start: 1rem; margin-block-end: 1rem; }
.markdown-preview-sizer { max-width: 700px; margin: 0 auto; }
.inline-title { font-size: 2em; line-height: 1.2; font-weight: 700; margin-bottom: 0.5em; }
.metadata-container { padding: 8px 0; }
.metadata-property { height: 30px; }
.mod-frontmatter { display: none; }
`;

let RV: HTMLElement | null = null;
let MOUNTED: InkStroke[] = [];

w.driftReadingMount = async (o: { text: string; keep: string[] | null; font: number; lh: number; paneW: number; paneH: number }) => {
	const style = document.head.appendChild(document.createElement("style"));
	style.textContent = VIEW_CSS(o.font, o.lh, o.paneW, o.paneH);
	const lines = splitLines(o.text);
	let fm = -1;
	if (lines[0] === "---") for (let i = 1; i < lines.length; i++) if (lines[i] === "---") { fm = i; break; }
	const root = document.body.createDiv({ cls: "markdown-preview-view markdown-rendered" });
	const sizer = root.createDiv({ cls: "markdown-preview-sizer markdown-preview-section" });
	sizer.createDiv({ cls: "markdown-preview-pusher" });
	const header = sizer.createDiv({ cls: "mod-header" });
	header.createDiv({ cls: "inline-title", text: "Untitled 1" });
	header.createDiv({ cls: "metadata-container" }).createDiv({ cls: "metadata-property", text: "handwriting-page-id" });
	const els: Array<{ el: HTMLElement; lineStart: number; lineEnd: number }> = [];
	if (fm >= 0) {
		const f = sizer.createDiv({ cls: "mod-frontmatter mod-ui" });
		f.createEl("pre", { cls: "frontmatter", text: lines.slice(1, fm).join("\n") });
		els.push({ el: f, lineStart: 0, lineEnd: fm });
	}
	const p = sizer.createDiv({ cls: "el-p" });
	const out: string[] = [];
	for (let i = fm + 1; i < lines.length; i++) out.push(lines[i]!.replace(/^[ \t]+/, ""));
	p.innerHTML = `<p>${out.join("<br>\n")}</p>`;
	els.push({ el: p, lineStart: fm + 1, lineEnd: lines.length - 1 });
	await frame();
	const strokes = o.keep ? STROKES.filter((s) => o.keep!.includes(s.id)) : STROKES;
	MOUNTED = strokes;
	initEmbedInkRefresh(() => strokes);
	initEmbedInkFontRef(() => FONT_REF);
	for (const s of els) attachEmbedInkOnceReady(s.el, sizer, PATH, () => strokes, undefined, false, {
		section: () => ({ text: o.text, lineStart: s.lineStart, lineEnd: s.lineEnd }), cached: () => null,
	});
	await settle(6);
	RV = root;
	return { zoom: r2(inkZoomOf(root, PATH)), scrollWidth: root.scrollWidth, scrollHeight: root.scrollHeight, strokes: strokes.length };
};

function readingToClient(): (x: number, y: number) => Pt {
	const root = RV!;
	const zoom = inkZoomOf(root, PATH);
	const rr = root.getBoundingClientRect();
	const a = embedInkAnchor(root) ?? { left: 0, top: 0 };
	const ox = rr.left + root.clientLeft - root.scrollLeft + a.left, oy = rr.top + root.clientTop - root.scrollTop + a.top;
	return (x, y) => ({ x: ox + x * zoom, y: oy + y * zoom });
}

w.driftReadingRead = async (o: { ids: string[]; pixels?: boolean }) => {
	await settle(6);
	const root = RV!;
	const text = firstTextAt(root.querySelector(".el-p p") as HTMLElement, "d");
	if (!text) return { error: "no first text line" };
	const vp = root.getBoundingClientRect();
	// Where the view shows each stroke: its stored box moved by its line anchor's correction, as the paint path places it
	// (EmbedInk.ts placeStrokes :875, no editor open, so the newest anchored stroke's signature decides).
	const placed = placeStrokes(root, MOUNTED, undefined, inkZoomOf(root, PATH), PATH).strokes;
	const shownById = new Map(placed.map((s) => [s.id, s] as const));
	const rows = rowsFor(o.ids, readingToClient(), text, vp, (id) => shownById.get(id)!);
	const anchor = embedInkAnchor(root);
	const layer = root.querySelector<HTMLCanvasElement>(":scope > canvas.handwriting-embed-ink");
	const out: Record<string, unknown> = {
		state: { zoom: r2(inkZoomOf(root, PATH)), scrollLeft: r2(root.scrollLeft), scrollTop: r2(root.scrollTop), scrollWidth: root.scrollWidth, scrollHeight: root.scrollHeight, anchor, sizerFont: getComputedStyle(root.querySelector(".markdown-preview-sizer")!).fontSize, layerStyle: layer ? { left: layer.style.left, top: layer.style.top, w: layer.style.width, h: layer.style.height } : null },
		text: { x: r2(text.x), y: r2(text.y) }, viewport: { left: r2(vp.left), top: r2(vp.top), w: r2(vp.width), h: r2(vp.height) }, rows,
	};
	if (o.pixels) out.pixels = rows.map((r) => {
		const pad = 40;
		const p = paintedBox(root, null, { x0: r.client.x0! - pad, y0: r.client.y0! - pad, x1: r.client.x1! + pad, y1: r.client.y1! + pad });
		return { id: r.id, painted: p, dcx: p ? r2(p.cx! - r.client.cx!) : null, dcy: p ? r2(p.cy! - r.client.cy!) : null };
	});
	return out;
};

w.driftReadingScrollTo = async (id: string) => {
	const s = byId(id);
	const root = RV!;
	const trace: unknown[] = [];
	for (let i = 0; i < 3; i++) {
		const c = readingToClient()(s.bbox.x + s.bbox.width / 2, s.bbox.y + s.bbox.height / 2);
		const vp = root.getBoundingClientRect();
		const want = { left: root.scrollLeft + c.x - (vp.left + vp.width / 2), top: root.scrollTop + c.y - (vp.top + vp.height / 2) };
		// In 30 steps, one per frame, as a scroll gesture moves: one jump of thousands of px came back to 0 in this rig
		// (driftReadingTrace records it).
		const l0 = root.scrollLeft, t0 = root.scrollTop;
		for (let k = 1; k <= 30; k++) {
			root.scrollLeft = l0 + ((want.left - l0) * k) / 30;
			root.scrollTop = t0 + ((want.top - t0) * k) / 30;
			await frame();
		}
		const now = { left: root.scrollLeft, top: root.scrollTop };
		await settle(6);
		trace.push({ want: { left: r2(want.left), top: r2(want.top) }, now, after: { left: root.scrollLeft, top: root.scrollTop } });
	}
	return { scrollLeft: r2(root.scrollLeft), scrollTop: r2(root.scrollTop), scrollWidth: root.scrollWidth, scrollHeight: root.scrollHeight, clientWidth: root.clientWidth, clientHeight: root.clientHeight, overflow: getComputedStyle(root).overflow, cls: root.className, trace };
};

/** Scroll the view to (left, top) in one jump or in `steps` equal steps, one per frame; every frame's scroll and layer. */
w.driftReadingTrace = async (o: { left: number; top: number; steps: number; after: number }) => {
	const root = RV!;
	const layer = () => root.querySelector<HTMLCanvasElement>(":scope > canvas.handwriting-embed-ink");
	const snap = (tag: string) => {
		const c = layer();
		return { tag, sl: root.scrollLeft, st: root.scrollTop, sw: root.scrollWidth, sh: root.scrollHeight, left: c?.style.left, top: c?.style.top, w: c?.style.width, h: c?.style.height, border: c?.style.borderWidth };
	};
	const rows: unknown[] = [snap("start")];
	const l0 = root.scrollLeft, t0 = root.scrollTop;
	for (let i = 1; i <= o.steps; i++) {
		root.scrollLeft = l0 + ((o.left - l0) * i) / o.steps;
		root.scrollTop = t0 + ((o.top - t0) * i) / o.steps;
		rows.push(snap(`set ${i}`));
		await frame();
		rows.push(snap(`frame ${i}`));
	}
	for (let j = 0; j < o.after; j++) { await frame(); rows.push(snap(`after ${j}`)); }
	return rows;
};

// ---------------------------------------------------------------- both views in one page (ReadingExtent.test.ts)

/** Hide the editor as Reading view hides it (display none), so a Reading view mounted after it is the one on screen. */
w.driftEditorHide = async () => {
	const pane = EV!.dom.closest(".markdown-source-view") as HTMLElement;
	pane.style.display = "none";
	await settle(4);
	return true;
};

/** Scroll a view to the end of its range in `steps` steps, one per frame; the range and where it stopped. */
w.driftScrollMax = async (o: { view: "editor" | "reading"; steps: number }) => {
	const el = o.view === "editor" ? EV!.scrollDOM : RV!;
	for (let k = 1; k <= o.steps; k++) {
		el.scrollLeft = ((el.scrollWidth - el.clientWidth) * k) / o.steps;
		el.scrollTop = ((el.scrollHeight - el.clientHeight) * k) / o.steps;
		await frame();
	}
	await settle(8);
	return { scrollLeft: r2(el.scrollLeft), scrollTop: r2(el.scrollTop), scrollWidth: el.scrollWidth, scrollHeight: el.scrollHeight, clientWidth: el.clientWidth, clientHeight: el.clientHeight };
};

/** The Reading view's extent spacer, if any: its style box. */
w.driftReadingSpacer = () => {
	const s = RV?.querySelector<HTMLElement>(":scope > .handwriting-reading-extent") ?? null;
	return s ? { left: s.style.left, top: s.style.top, visibility: s.style.visibility, position: s.style.position } : null;
};

/** The plugin's teardown of every Reading view root (plugin unload), then the spacer and the range. */
w.driftTeardown = async () => {
	teardownEmbedInk();
	await settle(2);
	return { spacer: (w.driftReadingSpacer as () => unknown)(), scrollHeight: RV!.scrollHeight, scrollWidth: RV!.scrollWidth };
};

/**
 * The Reading view's tab opens another note (the same root, re-keyed as Obsidian's file-open does): `path` with no ink
 * (`ink` false) or with this note's ink (`ink` true). No editor has laid `path` out, so it holds no grant. Then the
 * spacer and the range.
 */
w.driftReadingSwitch = async (o: { path: string; ink: boolean }) => {
	const theirs = o.ink ? MOUNTED : [];
	initEmbedInkRefresh((p) => (p === o.path ? theirs : MOUNTED));
	embedInkFileOpened(document.body, o.path);
	await settle(6);
	return { spacer: (w.driftReadingSpacer as () => unknown)(), scrollHeight: RV!.scrollHeight, scrollWidth: RV!.scrollWidth };
};

/** Infinite Canvas off (the setting; no per-note choice in this rig): the note is not a canvas note. */
w.driftCanvasSetting = (on: boolean) => { setScrollExpansionEnabled(on); return on; };
