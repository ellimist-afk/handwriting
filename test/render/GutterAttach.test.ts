/**
 * THE LINE NUMBERS STAY BESIDE THEIR LINES AT EVERY ZOOM, AND MOVE WITH THE TEXT WHEN THE PAGE SCROLLS SIDEWAYS.
 *
 * Alan, Orion, 2026-10-25, package-3e20b7b1 (Minimal, Readable line length on, line numbers on): "line numbers like,
 * move right towards the text and then overlap it".
 *
 * Two gutter rules, both measured. Minimal makes `.cm-gutters` `position: absolute !important`, out of the flow, and
 * keeps it clear of the text only by the readable-line-length margin; zoomed in, the line grows wider than the column,
 * the margin goes to 0 and the line slides under the numbers (device trace d1-trace/orion-v3: gap 42.5 px at 100%,
 * meeting at k 1.158, 191.4 px covered at k 5.981). CodeMirror's own rule, the one Obsidian's default theme keeps, is
 * an inline `position: sticky`: in the flow, so beside the text at rest, but pinned to the pane's left edge when the
 * page scrolls sideways, so after a zoom the numbers cover scrollLeft x k of every line (rig, READ-arm.md).
 *
 * The page of ZoomOut203.arm.test.ts (two pictures above lines, a word written on the last line), Minimal 9.0.2, 12 px
 * text, a 641 px pane, line numbers hosted in .cm-contentContainer as Obsidian hosts them.
 * - Arm minimal: the pane sits one element below body, so Minimal's `body :not(.canvas-node) .markdown-source-view`
 *   rule matches and the gutter is absolute, as on Alan's device. Pinch to 2.698 about the word, lift, rest; pinch to
 *   5.981, lift, rest; scroll sideways to 71, 81, ... 121 local px (scrollLeft writes: the rig cannot drag with a finger).
 * - Arm sticky: the pane is a child of body, the rule does not match, the gutter keeps CodeMirror's sticky. Pinch to 3
 *   about the word, lift, rest, then one 300 screen px pan right.
 *
 * Bound, every frame of both arms: the gutter's right edge is at or left of every text line's left edge (no tolerance).
 * Lift: across each lift the line, the gutter and the word move by at most 0.5 px (zero snap).
 * Ink: at every rest the ink sits where it was written on its line, the offset from the line's left scaled by k
 * (1.5 px). The 100% samples are written out (HW_L1_OUT) for the reader to compare against the base build.
 * Plants: HW_L1_PLANT=reserve holds the column's gutter reserve at 0 (the minimal arm must red), HW_L1_PLANT=travel
 * makes the gutter travel write a no-op (the sticky arm must red). Each plant counts its hits; a plant that is never
 * reached fails the cell.
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import rawCss from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

declare const process: { env: Record<string, string | undefined> };

const PAGE = `
import { EditorState, StateField, RangeSetBuilder, Compartment } from "@codemirror/state";
import { EditorView, Decoration, WidgetType, lineNumbers } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { inlineInk, inkOverlayExtension, overlayForPath, setScrollExpansionEnabled, setInlineTool, setInkSizeMult } from "../../src/inline/InkOverlay";
import { setInkColorHex } from "../../src/ink/InkColor";
import { setPenInk } from "../../src/inline/PenInk";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField, setBrowserEditorInfo } from "./iphoneObsidianStub";
import { parsePage, serializePage } from "../../src/model/PageData";

installObsidianDom();
const ids = new Map(), sidecars = new Map();
const save = (id, page) => { sidecars.set(id, serializePage(page)); };
inlineInk.attachHost({ readPageId: p => ids.get(p) ?? null, claimId: async (p, id) => { ids.set(p, id); return { pageId: id }; },
	loadSidecar: async id => (sidecars.has(id) ? parsePage(sidecars.get(id), id) : null), scheduleSidecar: save, scheduleSidecarNow: async (id, p) => save(id, p), notify: () => {} });

const frame = () => new Promise(r => requestAnimationFrame(() => r()));
const rendered = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await frame(); };
const PANE_W = 641, PANE_H = 900, HOST_LEFT = 200;
let rig = null;
const frames = [];
const plantHits = { reserve: 0, travel: 0, sticky: 0, switch: 0 };
/** K1: the line numbers in a slot, so an arm can take them off and put them back (CodeMirror rebuilds .cm-gutters). */
const lineNumbersSlot = new Compartment();

class Pic extends WidgetType {
	constructor(src) { super(); this.src = src; }
	eq(o) { return o.src === this.src; }
	toDOM() {
		const d = document.createElement("div"); d.className = "internal-embed media-embed image-embed is-loaded";
		const img = document.createElement("img"); img.src = this.src; img.style.display = "block"; d.appendChild(img); return d;
	}
}
function picField(srcs) {
	const deco = doc => { const b = new RangeSetBuilder(); for (let i = 1; i <= doc.lines; i++) { const l = doc.line(i), m = /^!\\[\\[pic-(\\d)\\.png\\]\\]$/.exec(l.text); if (m) b.add(l.from, l.to, Decoration.replace({ widget: new Pic(srcs[Number(m[1])]) })); } return b.finish(); };
	return StateField.define({ create: s => deco(s.doc), update: (v, tr) => (tr.docChanged ? deco(tr.state.doc) : v), provide: f => EditorView.decorations.from(f) });
}
async function picture(w, h, shade) {
	const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d"); g.fillStyle = shade; g.fillRect(0, 0, w, h);
	const src = c.toDataURL("image/png"), img = new Image(); img.src = src; await img.decode(); return src;
}
function installSizer(view) {
	const sizer = document.createElement("div"); sizer.className = "cm-sizer";
	const container = document.createElement("div"); container.className = "cm-contentContainer";
	view.contentDOM.parentElement.insertBefore(sizer, view.contentDOM); sizer.appendChild(container); container.appendChild(view.contentDOM);
	void view.scrollDOM.clientWidth; return sizer;
}
/** Obsidian hosts the gutters in .cm-contentContainer; stock CM puts them in the scroller (OverscrollBounce.test.ts). */
function nestGutters(view) {
	const gutters = view.scrollDOM.querySelector(":scope > .cm-gutters");
	if (!gutters) throw new Error("missing stock gutters");
	const container = view.contentDOM.parentElement, insert = view.scrollDOM.insertBefore.bind(view.scrollDOM);
	// K1: a .cm-gutters CodeMirror builds later (line numbers off and on) goes to the same host, not only the first one.
	view.scrollDOM.insertBefore = (node, before) => node === gutters || node?.classList?.contains("cm-gutters") ? container.insertBefore(node, before?.parentNode === container ? before : view.contentDOM) : insert(node, before);
	container.insertBefore(gutters, view.contentDOM);
}
const lines = () => [...rig.view.contentDOM.querySelectorAll(".cm-line")];
const inkLine = () => { const all = lines(); return all[all.length - 1]; };
const textBox = el => { const range = document.createRange(); range.selectNodeContents(el); const r = range.getBoundingClientRect(); return { top: r.top, cy: (r.top + r.bottom) / 2, left: r.left, right: r.right }; };
const MAGENTA = (d, i) => d[i + 3] > 200 && d[i] > 200 && d[i + 1] < 60 && d[i + 2] > 200;
function backingInk() {
	const cc = rig.overlay.committedCanvas; if (!cc) return null; const w = cc.width, h = cc.height;
	if (!(w > 0 && h > 0)) return null;
	const d = cc.getContext("2d").getImageData(0, 0, w, h).data;
	let minY = Infinity, minX = Infinity, maxX = -1, maxY = -1, n = 0;
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; if (MAGENTA(d, i)) { n++; if (y < minY) minY = y; if (y > maxY) maxY = y; if (x < minX) minX = x; if (x > maxX) maxX = x; } }
	if (!n) return { n };
	const r = cc.getBoundingClientRect();
	return { n, top: r.top + minY * r.height / h, bottom: r.top + (maxY + 1) * r.height / h, left: r.left + minX * r.width / w, right: r.left + (maxX + 1) * r.width / w };
}
const r2 = v => Math.round(v * 100) / 100;
const box = r => ({ left: r2(r.left), right: r2(r.right), top: r2(r.top), bottom: r2(r.bottom), w: r2(r.width), h: r2(r.height) });
function sample(phase, ink = false) {
	const { view, overlay, pane } = rig, line = inkLine(), lr = line.getBoundingClientRect(), t = textBox(line);
	const pr = pane.getBoundingClientRect(), sd = view.scrollDOM;
	// Every text line with a box on the pane's height: its BOX left (padding included), the edge the bound is on.
	const rows = lines().filter(l => !l.querySelector(".image-embed") && l.textContent.trim()).map(l => l.getBoundingClientRect()).filter(r => r.bottom > pr.top && r.top < pr.bottom);
	const lineLeft = rows.length ? Math.min(...rows.map(r => r.left)) : null;
	const g = view.dom.querySelector(".cm-gutters"), gr = g ? g.getBoundingClientRect() : null;
	const s = { phase, k: overlay.pinchScaleNow, preview: !!overlay.pinchPreview, scrollLeft: r2(sd.scrollLeft),
		gutterPosition: g ? getComputedStyle(g).position : null, gutter: gr ? box(gr) : null, rows: rows.length,
		lineLeft: lineLeft === null ? null : r2(lineLeft), line: box(lr), wordText: { left: r2(t.left), right: r2(t.right), cy: r2(t.cy) },
		gap: gr && lineLeft !== null ? r2(lineLeft - gr.right) : null,
		reserve: overlay.columnGutterReserve ?? null, ownLines: overlay.viewportLayout ? !!overlay.viewportLayout.ownLines : null,
		autoLeft: view.dom.style.getPropertyValue("--handwriting-column-auto-left"), marginLeft: view.dom.style.getPropertyValue("--handwriting-column-margin-left"), lineMargin: getComputedStyle(line).marginLeft };
	if (ink) { const i = backingInk(); s.ink = i && i.n ? { n: i.n, left: r2(i.left), right: r2(i.right), top: r2(i.top), bottom: r2(i.bottom) } : { n: i ? i.n : 0 }; }
	frames.push(s); return s;
}
function plant(kind) {
	const o = rig.overlay;
	if (kind === "reserve") {
		// The reserve is first read at the takeover (the first pinch), so the plant holds the field from mount on; a
		// plant that nothing reads leaves its count at 0 and the cell fails.
		Object.defineProperty(o, "columnGutterReserve", { configurable: true, get() { plantHits.reserve++; return 0; }, set() {} });
	} else if (kind === "travel") {
		if (typeof o.writeGutterTravel !== "function") throw new Error("plant travel: no writeGutterTravel on the overlay");
		o.writeGutterTravel = function () { plantHits.travel++; };
		// K1: mount wrote the host class before the plant went in; take it off so nothing keeps the gutter travelling.
		rig.view.dom.classList.remove("handwriting-gutter-travel");
	} else if (kind === "sticky") {
		// K1: today's k = 1 branch back. The class comes off at 100% whether or not the layout is released, so the sticky shows again.
		const orig = o.writeGutterTravel;
		if (typeof orig !== "function") throw new Error("plant sticky: no writeGutterTravel on the overlay");
		o.writeGutterTravel = function (next, release) { plantHits.sticky++; return orig.call(this, next, release || Math.abs(next - 1) <= 1e-6); };
		// Mount wrote the host class before the plant went in; today's 100% has none, so the plant takes it off (one hit).
		o.writeGutterTravel(1);
	} else if (kind === "switch") {
		// K1 switch: the note switch takes the travel class off again, as when restoreViewportLayout carried the removal.
		const orig = o.restoreViewportLayout;
		if (typeof orig !== "function") throw new Error("plant switch: no restoreViewportLayout on the overlay");
		o.restoreViewportLayout = function (...a) { plantHits.switch++; const r = orig.apply(this, a); this.writeGutterTravel(1, true); return r; };
	}
}

window.l1 = {
	async mount(arm, plantKind) {
		setPenInk(true); setScrollExpansionEnabled(true);
		setInlineTool("pen"); setInkColorHex("pen", "#ff00ff"); setInkSizeMult("pen", 4);
		const path = "gutter-attach-" + arm + ".md";
		const srcs = [await picture(1280, 400, "#406080"), await picture(1280, 400, "#608040")];
		const para = "Two pictures, then lines to write on. " + Array.from({ length: 6 }, (_, i) => "This sentence is " + (i + 1) + " of a paragraph long enough to wrap at every zoom.").join(" ");
		const doc = [para, "![[pic-0.png]]", "line 2 alpha beta gamma", "![[pic-1.png]]",
			...Array.from({ length: 8 }, (_, i) => "line " + (i + 4) + " alpha beta gamma delta")].join("\\n");
		// Minimal's gutter rule is "body :not(.canvas-node) .markdown-source-view.mod-cm6 .cm-gutters": it needs an
		// element between body and the view, as Obsidian's workspace has. The sticky arm leaves it out.
		const parent = arm === "minimal" ? document.body.appendChild(document.createElement("div")) : document.body;
		if (arm === "minimal") parent.className = "workspace-leaf-content";
		const pane = parent.appendChild(document.createElement("div"));
		pane.className = "markdown-source-view mod-cm6 is-readable-line-width";
		pane.style.cssText = "position:relative;margin-left:" + HOST_LEFT + "px;width:" + PANE_W + "px;height:" + PANE_H + "px;overflow:hidden";
		const view = new EditorView({ parent: pane, state: EditorState.create({ doc, extensions: [history(), EditorView.lineWrapping, lineNumbersSlot.of(lineNumbers()), picField(srcs),
			editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} })), inkOverlayExtension(),
			EditorView.theme({ "&": { width: PANE_W + "px", height: PANE_H + "px" }, ".cm-scroller": { overflowY: "auto", overflowX: "hidden" }, ".cm-content": { fontSize: "12px" } })] }) });
		const sizer = installSizer(view);
		nestGutters(view);
		for (let i = 0; i < 60 && [...view.contentDOM.querySelectorAll(".image-embed img")].some(i => !(i.complete && i.naturalWidth > 0)); i++) await frame();
		view.requestMeasure(); await settle(12);
		const overlay = overlayForPath(path);
		if (!overlay) throw new Error("no overlay for " + path);
		rig = { pane, view, overlay, sizer, path };
		const t = textBox(inkLine()), x = t.left + 40, y = t.cy;
		const pen = (type, px, py, buttons) => document.elementFromPoint(px, py)?.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "pen", pointerId: 901, isPrimary: true, clientX: px, clientY: py, buttons, pressure: buttons ? 0.5 : 0 }));
		pen("pointerdown", x, y, 1); for (let i = 1; i <= 4; i++) pen("pointermove", x + 20 * i, y, 1); pen("pointerup", x + 80, y, 0);
		await settle(12);
		if (plantKind) { plant(plantKind); await settle(4); }
		// K1: the rule under test is CodeMirror's own inline position, read apart from the sample so the samples keep their fields;
		// with the host class on from mount the default theme's computed position is relative, not sticky.
		return { strokes: inlineInk.strokes(path).length, natural: sample("natural", true), gutterInline: view.dom.querySelector(".cm-gutters")?.style.position ?? null };
	},
	/** The word's place on screen now: the ink's centre, else the last line's text; off the pane, the pane's middle. */
	word() {
		const pr = rig.pane.getBoundingClientRect(), i = backingInk(), t = textBox(inkLine());
		const p = i && i.n ? { x: (i.left + i.right) / 2, y: (i.top + i.bottom) / 2 } : { x: t.left + 80, y: t.cy };
		const on = p.x > pr.left + 20 && p.x < pr.right - 20 && p.y > pr.top + 20 && p.y < pr.bottom - 20;
		return on ? { ...p, on } : { x: (pr.left + pr.right) / 2, y: Math.min(pr.bottom - 40, Math.max(pr.top + 40, p.y)), on };
	},
	/** The router's two-finger pinch about the word to scale "to", every frame sampled, then the lift sampled. */
	async pinch(to, steps, tag) {
		const { overlay } = rig, router = overlay.router, from = overlay.pinchScaleNow, w = this.word(), cx = w.x, cy = w.y;
		const spread0 = 200, spread1 = 200 * to / from;
		const touch = s => { router.touchPos.set(911, { x: cx - s / 2, y: cy }); router.touchPos.set(912, { x: cx + s / 2, y: cy }); };
		const ev = type => new PointerEvent(type, { pointerId: 912, pointerType: "touch" });
		touch(spread0); router.beginPinch(ev("pointerdown"));
		for (let i = 1; i <= steps; i++) { touch(spread0 + (spread1 - spread0) * i / steps); router.updatePinch(ev("pointermove")); await rendered(); sample(tag + "-move-" + i); }
		router.endPinch(ev("pointerup"), { x: cx, y: cy }); router.touchPos.clear();
		for (let j = 1; j <= 16; j++) { await rendered(); sample(tag + "-lift-" + j); }
		for (let j = 1; j <= 90 && overlay.overscrollBounceReadout && overlay.overscrollBounceReadout().active; j++) { await rendered(); sample(tag + "-bounce-" + j); }
	},
	async rest(ms, phase) {
		await new Promise(r => setTimeout(r, ms));
		for (let i = 0; i < 90 && rig.overlay.overscrollBounceReadout && rig.overlay.overscrollBounceReadout().active; i++) await frame();
		await settle(4); return sample(phase, true);
	},
	/** scrollLeft to an absolute local value (a scrollLeft write: the rig cannot drag with a finger). */
	async scrollTo(left) { rig.view.scrollDOM.scrollLeft = left; await settle(4); return sample("scroll-" + left, true); },
	/** One pan right of px SCREEN px. */
	async panRight(px) { rig.view.scrollDOM.scrollLeft += px / rig.overlay.pinchScaleNow; await settle(4); return sample("pan", true); },
	/** K1 rebuild: line numbers off, then on, by reconfigure, so CodeMirror builds a new .cm-gutters; it is hosted in .cm-contentContainer again, as Obsidian hosts it. */
	async rebuildGutter() {
		const { view } = rig, before = view.dom.querySelector(".cm-gutters");
		view.dispatch({ effects: lineNumbersSlot.reconfigure([]) }); await settle(2);
		view.dispatch({ effects: lineNumbersSlot.reconfigure(lineNumbers()) }); await settle(2);
		const g = view.scrollDOM.querySelector(":scope > .cm-gutters"); if (g) view.contentDOM.parentElement.insertBefore(g, view.contentDOM);
		await settle(4); const after = view.dom.querySelector(".cm-gutters");
		return { rebuilt: !!after && after !== before, inlineSticky: after ? after.style.position === "sticky" : null, ...sample("rebuilt", true) };
	},
	/**
	 * K1 switch: another note opens in the same editor, as Obsidian reuses it: the document is replaced and the editor's file
	 * changes in one transaction (the stub's editor-info effect), so the overlay takes its note-switch path, not a remount.
	 */
	async switchNote() {
		const { view } = rig, before = rig.overlay, next = rig.path.replace(/\.md$/, "-b.md");
		view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: view.state.doc.toString() },
			effects: setBrowserEditorInfo.of({ app: { commands: { executeCommandById: () => false } }, file: { path: next }, editor: {} }) });
		await settle(12);
		rig.path = next;
		return { sameOverlay: overlayForPath(next) === before, path: before.filePath?.() ?? null, hostClass: view.dom.classList.contains("handwriting-gutter-travel"), ...sample("switched", true) };
	},
	/** K1 (a): one two-finger gesture from the current scale to "to" about the word, its centre travelling dx screen px sideways the whole way; every frame sampled, then the lift. */
	async pinchPan(to, steps, dx, tag) {
		const { overlay } = rig, router = overlay.router, from = overlay.pinchScaleNow, w = this.word(), cx = w.x, cy = w.y;
		const spread0 = 200, spread1 = 200 * to / from;
		const touch = (s, x) => { router.touchPos.set(911, { x: x - s / 2, y: cy }); router.touchPos.set(912, { x: x + s / 2, y: cy }); };
		const ev = type => new PointerEvent(type, { pointerId: 912, pointerType: "touch" });
		touch(spread0, cx); router.beginPinch(ev("pointerdown"));
		for (let i = 1; i <= steps; i++) { touch(spread0 + (spread1 - spread0) * i / steps, cx + dx * i / steps); router.updatePinch(ev("pointermove")); await rendered(); sample(tag + "-move-" + i); }
		router.endPinch(ev("pointerup"), { x: cx + dx, y: cy }); router.touchPos.clear();
		for (let j = 1; j <= 16; j++) { await rendered(); sample(tag + "-lift-" + j); }
		for (let j = 1; j <= 90 && overlay.overscrollBounceReadout && overlay.overscrollBounceReadout().active; j++) { await rendered(); sample(tag + "-bounce-" + j); }
	},
	/**
	 * K1 (b): a two-finger drag at the current scale, the centre travelling dx screen px sideways; every frame sampled, then the lift.
	 * The first frame opens the spread to 300 + 14 px, past the router's 12 px slop, so the gesture goes live (ZoomOutStandingPan
	 * dragPath); every later frame holds it back at 300, so the scale returns to where it began. Held at 314 the whole way, the
	 * drag ended at k 1.047, a zoom, where the zoomed rule already carries the numbers, and arm (b) passed at the base.
	 */
	async drag(steps, dx, tag) {
		const { overlay } = rig, router = overlay.router, w = this.word(), cx = w.x, cy = w.y, sp = 314;
		const touch = (x, s) => { router.touchPos.set(911, { x: x - s / 2, y: cy }); router.touchPos.set(912, { x: x + s / 2, y: cy }); };
		const ev = type => new PointerEvent(type, { pointerId: 912, pointerType: "touch" });
		router.touchPos.set(911, { x: cx - 150, y: cy }); router.touchPos.set(912, { x: cx + 150, y: cy }); router.beginPinch(ev("pointerdown"));
		for (let i = 1; i <= steps; i++) { touch(cx + dx * i / steps, i === 1 ? sp : 300); router.updatePinch(ev("pointermove")); await rendered(); sample(tag + "-move-" + i); }
		router.endPinch(ev("pointerup"), { x: cx + dx, y: cy }); router.touchPos.clear();
		for (let j = 1; j <= 16; j++) { await rendered(); sample(tag + "-lift-" + j); }
		for (let j = 1; j <= 90 && overlay.overscrollBounceReadout && overlay.overscrollBounceReadout().active; j++) { await rendered(); sample(tag + "-bounce-" + j); }
	},
	frames: () => frames,
	plantHits: () => plantHits,
};
`;

const THEME_CSS = readFileSync(fileURLToPath(new URL("./fixtures/minimal-9.0.2-theme.css", import.meta.url)), "utf8");
const css = rawCss.replace(/\r\n/g, "\n");
const PLANT = process.env.HW_L1_PLANT ?? "";
const record: Record<string, unknown> = { plant: PLANT };
let browser: Browser;
let script = "";

beforeAll(async () => {
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "gutterAttachPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);
afterAll(async () => {
	await browser?.close();
	if (process.env.HW_L1_OUT) writeFileSync(process.env.HW_L1_OUT, JSON.stringify(record, null, 1));
});

/** The ink where it was written: its offset from its line's left at rest equals the 100% offset times k. */
function inkOnLine(natural: any, rest: any): number | null {
	if (!natural.ink?.n || !rest.ink?.n) return null;
	return Math.round(((rest.ink.left - rest.line.left) - (natural.ink.left - natural.line.left) * rest.k) * 100) / 100;
}

for (const arm of ["minimal", "sticky"] as const) {
	const plantHere = (arm === "minimal" && PLANT === "reserve") || (arm === "sticky" && PLANT === "travel") ? PLANT : "";
	it(`arm ${arm}: ${arm === "minimal" ? "absolute gutter (Minimal's rule), pinch to 2.698 then 5.981, scroll sideways 71 to 121" : "sticky gutter (CodeMirror's rule), pinch to 3, pan 300 px right"}: the line numbers stay at or left of every line's left edge on every frame, and the ink stays on its word`, async () => {
		const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2, hasTouch: true });
		const errors: string[] = [];
		page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
		try {
			await page.setContent('<!doctype html><body class="theme-dark" style="margin:0"></body>');
			await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS + "\n.markdown-source-view img:not([width]) { max-width: 100%; }\n" });
			await page.addStyleTag({ content: THEME_CSS });
			await page.addScriptTag({ content: script });
			const m = await page.evaluate(([a, p]) => (window as any).l1.mount(a, p), [arm, plantHere]) as any;
			expect(m.strokes, "the stroke committed").toBe(1);
			const n = m.natural;
			const rests: any[] = [];
			if (arm === "minimal") {
				await page.evaluate(() => (window as any).l1.pinch(2.698, 30, "in1"));
				rests.push(await page.evaluate(() => (window as any).l1.rest(400, "rest-2.698")));
				await page.evaluate(() => (window as any).l1.pinch(5.981, 30, "in2"));
				rests.push(await page.evaluate(() => (window as any).l1.rest(400, "rest-5.981")));
				for (let left = 71; left <= 121; left += 10) rests.push(await page.evaluate(v => (window as any).l1.scrollTo(v), left));
			} else {
				await page.evaluate(() => (window as any).l1.pinch(3, 30, "in"));
				rests.push(await page.evaluate(() => (window as any).l1.rest(400, "rest-3")));
				rests.push(await page.evaluate(() => (window as any).l1.panRight(300)));
			}
			const frames = await page.evaluate(() => (window as any).l1.frames()) as any[];
			const hits = await page.evaluate(() => (window as any).l1.plantHits()) as any;
			const worst = frames.reduce((a, f) => (f.gap !== null && f.gap < a.gap ? f : a), { gap: Infinity, phase: null } as any);
			const inkErr = rests.map(r => ({ phase: r.phase, k: r.k, err: inkOnLine(n, r) }));
			// Zero snap: across each lift, the last preview frame against the first frame after it.
			const lifts = frames.flatMap((f, i) => (i > 0 && frames[i - 1].phase.includes("-move-") && f.phase.includes("-lift-") ? [{ phase: f.phase, line: Math.round((f.line.left - frames[i - 1].line.left) * 100) / 100, gutter: Math.round((f.gutter.right - frames[i - 1].gutter.right) * 100) / 100, word: Math.round((f.wordText.left - frames[i - 1].wordText.left) * 100) / 100 }] : []));
			record[arm] = { natural: n, rests, worst: { gap: worst.gap, phase: worst.phase }, inkErr, lifts, hits, frames };
			// eslint-disable-next-line no-console
			console.log("L1-" + arm + " " + JSON.stringify({ plant: plantHere, hits, gutterPosition: [n.gutterPosition, rests[rests.length - 1].gutterPosition], natural: { gap: n.gap, gutter: n.gutter, lineLeft: n.lineLeft, ink: n.ink, reserve: n.reserve, ownLines: n.ownLines, autoLeft: n.autoLeft, marginLeft: n.marginLeft, lineMargin: n.lineMargin },
				rests: rests.map(r => [r.phase, r.k, r.scrollLeft, r.gap, r.reserve, r.autoLeft, r.lineMargin]), worst: [worst.gap, worst.phase], inkErr, lifts, frames: frames.length }));
			expect(arm === "minimal" ? n.gutterPosition : m.gutterInline, "premise: the gutter rule under test").toBe(arm === "minimal" ? "absolute" : "sticky");
			expect(n.gap, "premise: at 100% the numbers sit left of the text").toBeGreaterThanOrEqual(0);
			if (plantHere) expect(hits[plantHere], `the ${plantHere} plant was reached`).toBeGreaterThan(0);
			if (arm === "minimal") {
				expect(rests[0].k, "premise: pinched to 2.698").toBeCloseTo(2.698, 2);
				expect(rests[1].k, "premise: pinched to 5.981").toBeCloseTo(5.981, 2);
				expect(rests.slice(2).map(r => r.scrollLeft), "premise: scrolled sideways 71 to 121").toEqual([71, 81, 91, 101, 111, 121]);
			} else {
				expect(rests[0].k, "premise: pinched to 3").toBeCloseTo(3, 2);
				expect(rests[0].scrollLeft, "premise: the lift left the page scrolled sideways").toBeGreaterThan(0);
			}
			expect.soft(worst.gap, `the line numbers never reach a line (worst gap ${worst.gap} px at ${worst.phase})`).toBeGreaterThanOrEqual(0);
			expect(lifts.length, "premise: every pinch has a lift").toBe(arm === "minimal" ? 2 : 1);
			for (const l of lifts) expect.soft(Math.max(Math.abs(l.line), Math.abs(l.gutter), Math.abs(l.word)), `nothing jumps at the lift ${l.phase}: line ${l.line}, gutter ${l.gutter}, word ${l.word} px`).toBeLessThanOrEqual(0.5);
			for (const e of inkErr) expect.soft(e.err === null ? Infinity : Math.abs(e.err), `the ink stays on its word at ${e.phase} (k ${e.k}): ${e.err} px`).toBeLessThanOrEqual(1.5);
			expect(errors).toEqual([]);
		} finally { await page.close(); }
	}, 240_000);
}

/**
 * K1: THE LINE NUMBERS STAY WITH THE TEXT AT 100%. Alan, 2026-10-25: the numbers stay with the text and the text stays put,
 * at 100% as zoomed. Both gutter rules; Infinite Canvas on, so the right room is open.
 * - k1-pinch (a): pinch to 2 about the word, lift, rest; one gesture out to 1.0 with the centre travelling 120 screen px left
 *   (the page scrolls right), lift, rest; one 120 px two-finger drag left at 1.0, lift, rest.
 * - k1-drag (b): never zoomed, one 120 px two-finger drag left, lift, rest; a 60 px drag back, lift, rest.
 * - k1-native (control): never zoomed, native scrollLeft writes to 40 then 80 local px (scrollbar, wheel,
 *   one-finger scroll); the numbers travel with the text, so the gap at each rest equals the natural gap within 0.5 px.
 * - k1-rebuild: never zoomed, line numbers off and on by reconfigure (a new .cm-gutters), a native scroll to
 *   80 local px, then one 120 px two-finger drag left, lift, rest. Red with the class keyed on the gutter element, green with it
 *   on the host: the native scroll is the step that tells them apart, since the drag's own writes reach the new gutter.
 * Bounds: across every lift the line and the word move at most 0.5 px, and the gap from the numbers to the text changes at
 * most 0.5 px; on every frame the numbers sit at or left of every line's left edge. Premise: after the first sideways move
 * scrollLeft is 60 local px or more, else the cell fails (the move did not scroll). Plant: HW_L1_PLANT=sticky puts today's
 * k = 1 branch back (the sticky arms must red; the plant counts its hits). The zoomed arms above are not changed.
 */
for (const shape of ["k1-pinch", "k1-drag", "k1-native", "k1-rebuild", "k1-switch"] as const) for (const rule of ["minimal", "sticky"] as const) {
	const plantHere = rule === "sticky" && (PLANT === "sticky" || (PLANT === "switch" && shape === "k1-switch")) ? PLANT : "";
	it(`${shape}, ${rule} gutter: at 100% the line numbers stay with the text across every lift, and the text stays put`, async () => {
		const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2, hasTouch: true });
		const errors: string[] = [];
		page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
		try {
			await page.setContent('<!doctype html><body class="theme-dark" style="margin:0"></body>');
			await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS + "\n.markdown-source-view img:not([width]) { max-width: 100%; }\n" });
			await page.addStyleTag({ content: THEME_CSS });
			await page.addScriptTag({ content: script });
			const m = await page.evaluate(([a, p]) => (window as any).l1.mount(a, p), [rule, plantHere]) as any;
			expect(m.strokes, "the stroke committed").toBe(1);
			const n = m.natural, rests: any[] = [];
			if (shape === "k1-pinch") {
				await page.evaluate(() => (window as any).l1.pinch(2, 30, "a-in"));
				rests.push(await page.evaluate(() => (window as any).l1.rest(400, "rest-2")));
				await page.evaluate(() => (window as any).l1.pinchPan(1, 30, -120, "a-out"));
				rests.push(await page.evaluate(() => (window as any).l1.rest(400, "rest-1")));
				await page.evaluate(() => (window as any).l1.drag(30, -120, "a-pan"));
				rests.push(await page.evaluate(() => (window as any).l1.rest(400, "rest-1-pan")));
			} else if (shape === "k1-drag") {
				await page.evaluate(() => (window as any).l1.drag(30, -120, "b-d1"));
				rests.push(await page.evaluate(() => (window as any).l1.rest(400, "rest-d1")));
				await page.evaluate(() => (window as any).l1.drag(30, 60, "b-d2"));
				rests.push(await page.evaluate(() => (window as any).l1.rest(400, "rest-d2")));
			} else if (shape === "k1-native") {
				rests.push(await page.evaluate(() => (window as any).l1.scrollTo(40)));
				rests.push(await page.evaluate(() => (window as any).l1.scrollTo(80)));
			} else if (shape === "k1-switch") {
				rests.push(await page.evaluate(() => (window as any).l1.switchNote()));
				// The native scroll first: a gesture's own viewport writes put the class back, so a drag alone cannot show it gone.
				rests.push(await page.evaluate(() => (window as any).l1.scrollTo(80)));
				await page.evaluate(() => (window as any).l1.drag(30, -120, "s-d1"));
				rests.push(await page.evaluate(() => (window as any).l1.rest(400, "rest-s-d1")));
			} else {
				rests.push(await page.evaluate(() => (window as any).l1.rebuildGutter()));
				// Before any gesture: a gesture's own viewport writes reach a rebuilt gutter, so a drag alone cannot tell a class
				// keyed on the gutter from one on the host (measured on the probe 6c6c5c41: green). A native scroll writes nothing.
				rests.push(await page.evaluate(() => (window as any).l1.scrollTo(80)));
				await page.evaluate(() => (window as any).l1.drag(30, -120, "r-d1"));
				rests.push(await page.evaluate(() => (window as any).l1.rest(400, "rest-r-d1")));
			}
			const frames = await page.evaluate(() => (window as any).l1.frames()) as any[];
			const hits = await page.evaluate(() => (window as any).l1.plantHits()) as any;
			const worst = frames.reduce((a, f) => (f.gap !== null && f.gap < a.gap ? f : a), { gap: Infinity, phase: null } as any);
			const d = (a: number, b: number) => Math.round((a - b) * 100) / 100;
			const lifts = frames.flatMap((f, i) => (i > 0 && frames[i - 1].phase.includes("-move-") && f.phase.includes("-lift-") ? [{ phase: f.phase, k: f.k, scrollLeft: f.scrollLeft, line: d(f.line.left, frames[i - 1].line.left), word: d(f.wordText.left, frames[i - 1].wordText.left), gap: f.gap === null || frames[i - 1].gap === null ? null : d(f.gap, frames[i - 1].gap), gutterPosition: f.gutterPosition }] : []));
			record[shape + "-" + rule] = { natural: n, rests, worst: { gap: worst.gap, phase: worst.phase }, lifts, hits, frames };
			// eslint-disable-next-line no-console
			console.log("K1-" + shape + "-" + rule + " " + JSON.stringify({ plant: plantHere, hits, rests: rests.map(r => [r.phase, r.k, r.scrollLeft, r.gap, r.gutterPosition]), worst: [worst.gap, worst.phase], lifts, frames: frames.length }));
			expect(rule === "minimal" ? n.gutterPosition : m.gutterInline, "premise: the gutter rule under test").toBe(rule === "minimal" ? "absolute" : "sticky");
			if (plantHere) expect(hits[plantHere], `the ${plantHere} plant was reached`).toBeGreaterThan(0);
			if (shape === "k1-pinch") {
				expect(rests[0].k, "premise: pinched to 2").toBeCloseTo(2, 2);
				expect(rests[1].k, "premise: the gesture out ended at 100%").toBeCloseTo(1, 6);
			}
			expect(rests[shape === "k1-drag" ? 0 : 1].scrollLeft, "premise: the sideways move scrolled the page").toBeGreaterThanOrEqual(60);
			if (shape === "k1-rebuild") { expect(rests[0].rebuilt, "premise: CodeMirror built a new .cm-gutters").toBe(true); if (rule === "sticky") expect(rests[0].inlineSticky, "premise: CodeMirror wrote sticky inline on the new gutter").toBe(true); }
			if (shape === "k1-switch") {
				expect(rests[0].sameOverlay, "premise: the switch kept the overlay (no remount)").toBe(true);
				expect(rests[0].path, "premise: the overlay now holds note B").toMatch(/-b\.md$/);
				expect.soft(rests[0].hostClass, "after the note switch the editor host carries the travel class").toBe(true);
				expect.soft(Math.abs(rests[1].gap - n.gap), `the numbers travel with a native scroll on note B at ${rests[1].phase} (scrollLeft ${rests[1].scrollLeft}, ${rests[1].gutterPosition}): gap ${rests[1].gap} against ${n.gap} px`).toBeLessThanOrEqual(0.5);
			}
			expect(lifts.length, "premise: every gesture has a lift").toBe(shape === "k1-pinch" ? 3 : shape === "k1-drag" ? 2 : shape === "k1-rebuild" || shape === "k1-switch" ? 1 : 0);
			if (shape === "k1-rebuild") expect.soft(Math.abs(rests[1].gap - n.gap), `the rebuilt gutter travels with a native scroll at ${rests[1].phase} (scrollLeft ${rests[1].scrollLeft}, ${rests[1].gutterPosition}): gap ${rests[1].gap} against ${n.gap} px`).toBeLessThanOrEqual(0.5);
			if (shape === "k1-native") for (const r of rests) expect.soft(Math.abs(r.gap - n.gap), `the numbers travel with a native scroll at ${r.phase} (scrollLeft ${r.scrollLeft}, ${r.gutterPosition}): gap ${r.gap} against ${n.gap} px`).toBeLessThanOrEqual(0.5);
			expect.soft(worst.gap, `the line numbers never reach a line (worst gap ${worst.gap} px at ${worst.phase})`).toBeGreaterThanOrEqual(0);
			for (const l of lifts) {
				expect.soft(Math.max(Math.abs(l.line), Math.abs(l.word)), `the text stays put at the lift ${l.phase} (k ${l.k}): line ${l.line}, word ${l.word} px`).toBeLessThanOrEqual(0.5);
				expect.soft(l.gap === null ? Infinity : Math.abs(l.gap), `the numbers stay with the text at the lift ${l.phase} (k ${l.k}, scrollLeft ${l.scrollLeft}, ${l.gutterPosition}): gap change ${l.gap} px`).toBeLessThanOrEqual(0.5);
			}
			expect(errors).toEqual([]);
		} finally { await page.close(); }
	}, 240_000);
}
