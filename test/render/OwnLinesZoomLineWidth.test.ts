/**
 * A THEME THAT SIZES ITS OWN LINES: ZOOMED IN, THE LINE, ITS PICTURES AND ITS INK GROW TOGETHER.
 *
 * Alan, Orion, 2026-10-24, Minimal, Readable line length on, Infinite Canvas on, a note with two pictures above the
 * ink: zoomed in, the word left its line and stayed off it at rest. The device trace (1.4.24 D1 trace, 2026-10-25)
 * measured the cause. The note zoom is a CSS `zoom` on a host counter-sized to 1/k, so a percentage inside it
 * resolves against the shrunken box and stays the same size on screen. Minimal makes `.cm-content` full width and
 * sizes each line `width: var(--line-width)` (40rem) with `max-width: var(--max-width)` (88%). Above the zoom where
 * 88% of the content is narrower than the zoomed line, the line stops growing, and every width-bound picture in it
 * stops growing too, while the line height and the ink keep scaling with the zoom. Ink below the pictures then lands
 * lower than its line by the pictures' height at 100% times (k minus that ratio): 411 px measured at k 1.661 on the
 * device, 590 px at 1.885.
 *
 * The claim, at rest after a pinch in to 200% about the word: the line box is its 100% width times k; each picture's
 * height is its 100% height times k; the ink sits on its line as it did at 100%, scaled by k.
 *
 * HW_RLL_THEME=Minimal runs the vendored Minimal 9.0.2 (the arm that matters, own-lines premise asserted); unset runs
 * Obsidian's own theme as the control, which pins `.cm-content` and has no percentage term to bind.
 * HW_OWNLINES_PLANT_NO_MIN_WIDTH takes the line's minimum-width rule out of the stylesheet (asserted to match once):
 * the claim must go red with it.
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
const PANE_W = 800, PANE_H = 900, HOST_LEFT = 200;
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
		scrollTop: r2(view.scrollDOM.scrollTop), heightMap: r2(view.contentHeight) };
}

window.ownLinesZoom = {
	async mount() {
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
	async later(ms, phase) {
		await new Promise(r => setTimeout(r, ms));
		for (let i = 0; i < 90 && rig.overlay.overscrollBounceReadout && rig.overlay.overscrollBounceReadout().active; i++) await frame();
		await settle(4); return sample(phase);
	},
};
`;

const THEME = process.env.HW_RLL_THEME || "default";
const THEME_FILES: Record<string, string> = { Minimal: fileURLToPath(new URL("./fixtures/minimal-9.0.2-theme.css", import.meta.url)) };
const THEME_CSS = THEME === "default" ? "" : readFileSync(THEME_FILES[THEME] ?? THEME, "utf8");
/** The line's minimum-width rule; the plant removes exactly this declaration and fails if it is not there once. */
const MIN_WIDTH_RULE = " min-width: var(--handwriting-note-line-width) !important;\n";
const PLANT = !!process.env.HW_OWNLINES_PLANT_NO_MIN_WIDTH;
const css = (() => {
	const text = rawCss.replace(/\r\n/g, "\n");
	if (!PLANT) return text;
	const n = text.split(MIN_WIDTH_RULE).length - 1;
	if (n !== 1) throw new Error(`plant no-min-width: rule found ${n} times, expected 1`);
	return text.replace(MIN_WIDTH_RULE, "");
})();
const DPR = 2;
const K = 2;
const record: unknown[] = [];
let browser: Browser;
let script = "";

beforeAll(async () => {
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "ownLinesZoomPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
	// eslint-disable-next-line no-console
	console.log("OWNLINES-RUN " + JSON.stringify({ theme: THEME, themeCssBytes: THEME_CSS.length, plant: PLANT ? "no-min-width" : null }));
	browser = await chromium.launch({ headless: true });
}, 180_000);
afterAll(async () => {
	await browser?.close();
	if (process.env.HW_OWNLINES_OUT) writeFileSync(process.env.HW_OWNLINES_OUT, JSON.stringify(record, null, 1));
});

const r2 = (v: number) => Math.round(v * 100) / 100;

it(`zoomed in to ${K * 100}% about the word, the line, both pictures and the ink grow together and the ink stays on its line (${THEME})`, async () => {
	const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: DPR, hasTouch: true });
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	try {
		await page.setContent('<!doctype html><body class="theme-dark" style="margin:0"></body>');
		// Obsidian's own picture rule (app.css: an img with no width attribute is held to its box), which the rig's
		// readable-width extract does not carry; Minimal adds its own on top.
		await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS + "\n.markdown-source-view img:not([width]) { max-width: 100%; }\n" });
		if (THEME_CSS) await page.addStyleTag({ content: THEME_CSS });
		await page.addScriptTag({ content: script });
		const m = await page.evaluate(() => (window as any).ownLinesZoom.mount()) as any;
		const n = m.natural;
		expect(m.strokes, "the stroke committed").toBe(1);
		expect(n.pics.length, "premise: two pictures drawn").toBe(2);
		expect(n.pics.every((p: any) => p.done), "premise: both pictures decoded before the ink was written").toBe(true);
		expect(n.inkN, "premise: the stroke is on the committed canvas").toBeGreaterThan(0);
		await page.evaluate(([to, cx, cy]) => (window as any).ownLinesZoom.pinch(to, 30, cx, cy), [K, m.word.x, m.word.y] as const);
		const z = await page.evaluate(() => (window as any).ownLinesZoom.later(400, "rest")) as any;
		record.push({ theme: THEME, plant: PLANT, natural: n, rest: z, errors });
		const lineMiss = r2(z.lineW - n.lineW * z.k);
		const picRatio = z.pics.map((p: any, i: number) => r2(p.h / n.pics[i].h));
		const inkMiss = z.inkTop === null || n.inkTop === null ? null : r2((z.inkTop - z.lineTop) - (n.inkTop - n.lineTop) * z.k);
		// eslint-disable-next-line no-console
		console.log("OWNLINES " + JSON.stringify({ theme: THEME, plant: PLANT, k: z.k, ownLines: z.ownLines, lineW0: n.lineW, lineW: z.lineW, lineMiss, picH0: n.pics.map((p: any) => p.h), picH: z.pics.map((p: any) => p.h), picRatio, inkMiss, lineVar: z.lineVar, columnBox: z.columnBox, lineMinWidth: z.lineMinWidth, lineMaxWidth: z.lineMaxWidth, contentW: z.contentW }));
		expect(errors).toEqual([]);
		expect(z.k, `pinched to ${K * 100}%`).toBeCloseTo(K, 3);
		if (THEME !== "default") {
			expect(z.ownLines, "premise: the overlay measured a theme that sizes its own lines").toBe(true);
			expect(z.ownLinesClass, "premise: the own-lines class is on the host").toBe(true);
			// The theme's percentage term must bind inside this gesture, or the cell asserts nothing: 88% of the content on
			// screen at 100% against the line at 100%.
			const bindAt = r2(0.88 * n.contentW / n.lineW);
			expect(bindAt, `premise: the line's max-width binds below ${K * 100}% (from k ${bindAt})`).toBeLessThan(1.5);
		}
		expect(Math.abs(lineMiss), `the line box is its 100% width x k (${z.lineW} against ${r2(n.lineW * z.k)})`).toBeLessThanOrEqual(1);
		for (const [i, ratio] of picRatio.entries()) expect(Math.abs(ratio - z.k) / z.k, `picture ${i} grows with the zoom (height ratio ${ratio} at k ${r2(z.k)})`).toBeLessThanOrEqual(0.01);
		expect(z.inkN, "the stroke is still on the committed canvas").toBeGreaterThan(0);
		expect(inkMiss, "the stroke reads at rest").not.toBeNull();
		expect(Math.abs(inkMiss!), `the ink sits on its line as at 100%, scaled (off ${inkMiss} px)`).toBeLessThanOrEqual(2);
		// Back to 100% with the host still owned: the line is the width it had before any zoom took the note over.
		await page.evaluate(([cx, cy]) => (window as any).ownLinesZoom.pinch(1, 30, cx, cy), [m.word.x, m.word.y] as const);
		const back = await page.evaluate(() => (window as any).ownLinesZoom.later(400, "back")) as any;
		record.push({ theme: THEME, plant: PLANT, back });
		// eslint-disable-next-line no-console
		console.log("OWNLINES-BACK " + JSON.stringify({ k: back.k, lineW0: n.lineW, lineW: back.lineW, lineVar: back.lineVar }));
		expect(back.k, "pinched back to 100%").toBeCloseTo(1, 3);
		expect(Math.abs(r2(back.lineW - n.lineW)), `at 100% after the takeover the line keeps its width (${back.lineW} against ${n.lineW})`).toBeLessThanOrEqual(0.5);
	} finally { await page.close(); }
}, 180_000);
