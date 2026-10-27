/**
 * A THEME THAT SIZES ITS OWN LINES, ZOOMED IN: A NARROWED PANE RE-SIZES THE LINE.
 *
 * One cell on the page of OwnLinesZoomLineWidth.test.ts (the same note: two pictures above eight lines, a word written on
 * the last), under the vendored Minimal 9.0.2 with Readable line length on. See the cell for its claim.
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
import { EditorState, StateField, RangeSetBuilder } from "@codemirror/state";
import { EditorView, Decoration, WidgetType } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { inlineInk, inkOverlayExtension, overlayForPath, setScrollExpansionEnabled, setInlineTool, setInkSizeMult } from "../../src/inline/InkOverlay";
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
const rendered = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await frame(); };
// 800 px of pane: Minimal's .cm-content is the whole pane, so 88% of it is about 704 px against a 640 px line, and
// that term binds from about k 1.1. Obsidian's own theme pins the content at its readable width instead.
let PANE_W = 800;
const PANE_H = 900, HOST_LEFT = 200;
let rig = null;

/** A picture as Obsidian draws one in a line: the line holds an .internal-embed.image-embed holding the img. */
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
const lines = () => [...rig.view.contentDOM.querySelectorAll(".cm-line")];
const inkLine = () => { const all = lines(); return all[all.length - 1]; };
const textBox = el => { const range = document.createRange(); range.selectNodeContents(el); const r = range.getBoundingClientRect(); return { top: r.top, cy: (r.top + r.bottom) / 2, left: r.left }; };
const MAGENTA = (d, i) => d[i + 3] > 200 && d[i] > 200 && d[i + 1] < 60 && d[i + 2] > 200;
function backingInk() {
	const cc = rig.overlay.committedCanvas, w = cc.width, h = cc.height;
	if (!(w > 0 && h > 0)) return null;
	const d = cc.getContext("2d").getImageData(0, 0, w, h).data;
	let minY = Infinity, minX = Infinity, maxX = -1, n = 0;
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; if (MAGENTA(d, i)) { n++; if (y < minY) minY = y; if (x < minX) minX = x; if (x > maxX) maxX = x; } }
	if (!n) return { n };
	const r = cc.getBoundingClientRect();
	return { n, top: r.top + minY * r.height / h, left: r.left + minX * r.width / w, right: r.left + (maxX + 1) * r.width / w };
}
const r2 = v => Math.round(v * 100) / 100;
function sample(phase) {
	const { view, overlay } = rig, line = inkLine(), lr = line.getBoundingClientRect(), t = textBox(line), ink = backingInk();
	const pics = [...view.contentDOM.querySelectorAll(".image-embed img")].map(i => { const r = i.getBoundingClientRect(); return { w: r2(r.width), h: r2(r.height), done: i.complete && i.naturalWidth > 0 }; });
	const picLines = [...view.contentDOM.querySelectorAll(".cm-line")].filter(l => l.querySelector(".image-embed")).map(l => r2(l.getBoundingClientRect().width));
	const cr = view.contentDOM.getBoundingClientRect();
	return { phase, k: overlay.pinchScaleNow, preview: !!overlay.pinchPreview,
		ownLines: overlay.viewportLayout ? !!overlay.viewportLayout.ownLines : null,
		ownLinesClass: view.dom.classList.contains("handwriting-note-viewport-own-lines"),
		lineVar: view.dom.style.getPropertyValue("--handwriting-note-line-width"),
		columnBox: overlay.viewportLayout ? r2(overlay.viewportLayout.columnBox) : null,
		contentW: r2(cr.width), lineW: r2(lr.width), lineTop: r2(lr.top), textTop: r2(t.top), textCy: r2(t.cy), textLeft: r2(t.left),
		lineMaxWidth: getComputedStyle(line).maxWidth, lineMinWidth: getComputedStyle(line).minWidth, lineWidthCss: getComputedStyle(line).width,
		pics, picLines,
		inkN: ink ? ink.n : 0, inkTop: ink && ink.n ? r2(ink.top) : null, inkLeft: ink && ink.n ? r2(ink.left) : null, inkRight: ink && ink.n ? r2(ink.right) : null,
		scrollTop: r2(view.scrollDOM.scrollTop), heightMap: r2(view.contentHeight),
		scrollLeft: r2(view.scrollDOM.scrollLeft), scrollWidth: view.scrollDOM.scrollWidth, clientWidth: view.scrollDOM.clientWidth,
		lineLeft: r2(lr.left), lineRight: r2(lr.right), paneLeft: r2(rig.pane.getBoundingClientRect().left), paneRight: r2(rig.pane.getBoundingClientRect().right),
		lineContentPx: r2(lr.width - parseFloat(getComputedStyle(line).paddingLeft) - parseFloat(getComputedStyle(line).paddingRight)) };
}

window.ownLinesZoom = {
	async mount(cfg) {
		if (cfg && cfg.paneW) PANE_W = cfg.paneW;
		setPenInk(true); setScrollExpansionEnabled(true);
		setInlineTool("pen"); setInkColorHex("pen", "#ff00ff"); setInkSizeMult("pen", 4);
		const path = "own-lines-zoom.md";
		// Two pictures wider than any line, so each is held to its line's width: 1280 x 400, 200 px tall in a 640 px line.
		const srcs = [await picture(1280, 400, "#406080"), await picture(1280, 400, "#608040")];
		const doc = ["line 0 alpha beta gamma", "![[pic-0.png]]", "line 2 alpha beta gamma", "![[pic-1.png]]",
			...Array.from({ length: 8 }, (_, i) => "line " + (i + 4) + " alpha beta gamma delta")].join("\\n");
		const pane = document.body.appendChild(document.createElement("div"));
		pane.className = "markdown-source-view mod-cm6 is-readable-line-width";
		pane.style.cssText = "position:relative;margin-left:" + HOST_LEFT + "px;width:" + PANE_W + "px;height:" + PANE_H + "px;overflow:hidden";
		const view = new EditorView({ parent: pane, state: EditorState.create({ doc, extensions: [history(), EditorView.lineWrapping, picField(srcs),
			editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} })), inkOverlayExtension(),
			EditorView.theme({ "&": { width: PANE_W + "px", height: PANE_H + "px" }, ".cm-scroller": { overflowY: "auto", overflowX: "hidden" }, ".cm-content": { fontFamily: "monospace", fontSize: "16px", lineHeight: "24px" } })] }) });
		const sizer = installSizer(view);
		// The pictures are drawn, and the editor has measured them, before any ink is written.
		for (let i = 0; i < 60 && [...view.contentDOM.querySelectorAll(".image-embed img")].some(i => !(i.complete && i.naturalWidth > 0)); i++) await frame();
		view.requestMeasure(); await settle(12);
		const overlay = overlayForPath(path);
		if (!overlay) throw new Error("no overlay for " + path);
		rig = { pane, view, overlay, sizer, path };
		const t = textBox(inkLine()), x = t.left + 40, y = t.cy;
		const pen = (type, px, py, buttons) => document.elementFromPoint(px, py)?.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "pen", pointerId: 901, isPrimary: true, clientX: px, clientY: py, buttons, pressure: buttons ? 0.5 : 0 }));
		pen("pointerdown", x, y, 1); for (let i = 1; i <= 4; i++) pen("pointermove", x + 20 * i, y, 1); pen("pointerup", x + 80, y, 0);
		await settle(12);
		return { strokes: inlineInk.strokes(path).length, natural: sample("natural"), word: { x: x + 40, y }, pane: pane.getBoundingClientRect().toJSON() };
	},
	/** The router's two-finger pinch about a client point, spread 300 -> 300 x to over steps frames, then the settle. */
	async pinch(to, steps, cx, cy) {
		const { overlay } = rig, router = overlay.router, from = overlay.pinchScaleNow;
		const spread0 = 300, spread1 = 300 * to / from;
		const touch = s => { router.touchPos.set(911, { x: cx - s / 2, y: cy }); router.touchPos.set(912, { x: cx + s / 2, y: cy }); };
		const ev = type => new PointerEvent(type, { pointerId: 912, pointerType: "touch" });
		touch(spread0); router.beginPinch(ev("pointerdown"));
		for (let i = 1; i <= steps; i++) { touch(spread0 + (spread1 - spread0) * i / steps); router.updatePinch(ev("pointermove")); await rendered(); }
		router.endPinch(ev("pointerup"), { x: cx, y: cy }); router.touchPos.clear();
		for (let j = 1; j <= 16; j++) await rendered();
		for (let j = 1; j <= 90 && overlay.overscrollBounceReadout && overlay.overscrollBounceReadout().active; j++) await rendered();
	},
	/** The pane narrowed to w with the note zoomed; the resize observer is left to see it. */
	async narrow(w, phase) {
		rig.pane.style.width = w + "px"; PANE_W = w;
		for (let i = 0; i < 16; i++) await rendered();
		return this.later(300, phase);
	},
	async later(ms, phase) {
		await new Promise(r => setTimeout(r, ms));
		for (let i = 0; i < 90 && rig.overlay.overscrollBounceReadout && rig.overlay.overscrollBounceReadout().active; i++) await frame();
		await settle(4); return sample(phase);
	},
};
`;

const THEME_CSS = readFileSync(fileURLToPath(new URL("./fixtures/minimal-9.0.2-theme.css", import.meta.url)), "utf8");
const css = rawCss.replace(/\r\n/g, "\n");
const DPR = 2;
const record: unknown[] = [];
let browser: Browser;
let script = "";

beforeAll(async () => {
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "ownLinesZoomEdgesPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);
afterAll(async () => {
	await browser?.close();
	if (process.env.HW_OWNLINES_EDGES_OUT) writeFileSync(process.env.HW_OWNLINES_EDGES_OUT, JSON.stringify(record, null, 1));
});

const r2 = (v: number) => Math.round(v * 100) / 100;

async function open(paneW: number) {
	const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: DPR, hasTouch: true });
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	await page.setContent('<!doctype html><body class="theme-dark" style="margin:0"></body>');
	await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS + "\n.markdown-source-view img:not([width]) { max-width: 100%; }\n" });
	await page.addStyleTag({ content: THEME_CSS });
	await page.addScriptTag({ content: script });
	const m = await page.evaluate(cfg => (window as any).ownLinesZoom.mount(cfg), { paneW }) as any;
	expect(m.strokes, "the stroke committed").toBe(1);
	return { page, m, errors };
}
const pinch = (page: any, m: any, to: number) => page.evaluate(([t, cx, cy]: number[]) => (window as any).ownLinesZoom.pinch(t, 30, cx, cy), [to, m.word.x, m.word.y]);
// Same theme, zoomed to 200% in an 800 px pane, then the pane narrowed to 641 px. The line's natural width at 641 px is
// read from a second note opened at that width at 100%. The claim, at rest: the line-width variable is that content
// width, and the line is that box width times the zoom.
it("zoomed in under a theme that sizes its own lines, a narrowed pane gives the line its new width (Minimal, 800 to 641 px)", async () => {
	const fresh = await open(641);
	const want = fresh.m.natural;
	await fresh.page.close();
	const { page, m, errors } = await open(800);
	try {
		await pinch(page, m, 2);
		const z = await page.evaluate(() => (window as any).ownLinesZoom.later(400, "rest")) as any;
		const w = await page.evaluate(() => (window as any).ownLinesZoom.narrow(641, "narrowed")) as any;
		record.push({ cell: "narrow", want, rest: z, narrowed: w });
		// eslint-disable-next-line no-console
		console.log("EDGES-NARROW " + JSON.stringify({ k: w.k, ownLines: w.ownLines, lineVar800: z.lineVar, lineVar: w.lineVar, wantContent: want.lineContentPx, wantBox: want.lineW, lineW: w.lineW, wantLineW: r2(want.lineW * w.k), paneLeft: w.paneLeft, paneRight: w.paneRight }));
		expect(z.ownLines, "premise: the overlay measured a theme that sizes its own lines").toBe(true);
		expect(w.k, "still at 200%").toBeCloseTo(2, 3);
		expect(w.paneRight - w.paneLeft, "premise: the pane is 641 px").toBeCloseTo(641, 0);
		expect(Math.abs(want.lineW - m.natural.lineW), "premise: the line's natural width differs between the two panes").toBeGreaterThan(20);
		expect.soft(Math.abs(parseFloat(w.lineVar) - want.lineContentPx), `the line-width variable follows the pane (${w.lineVar} against ${want.lineContentPx}px)`).toBeLessThanOrEqual(1);
		expect.soft(Math.abs(w.lineW - want.lineW * w.k), `the line is its new natural width x k (${w.lineW} against ${r2(want.lineW * w.k)})`).toBeLessThanOrEqual(1);
		expect(errors).toEqual([]);
	} finally { await page.close(); }
}, 180_000);
