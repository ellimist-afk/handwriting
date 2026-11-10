/**
 * A capped text column (Infinite Canvas off, a pane with room for the width the note's ink was drawn at) whose
 * line-number gutter changes while it is capped, on the real stylesheet in Chromium.
 *
 * Layout as Obsidian builds it (obsidian-1.15.0.asar, read-only): the gutter and the content side by side inside
 * .cm-sizer > .cm-contentContainer, with Obsidian's own gutter rule (flex 0 0 auto, margin-inline-end
 * var(--file-folding-offset)) and its readable-width rules (obsidianReadableWidth.ts). The npm CodeMirror build inserts
 * its gutter into the scroller; the mount moves it into the container beside the content, as Obsidian's editor view
 * does. Line numbers turned on is modelled by showing a gutter that was display: none, since the npm build cannot
 * insert a gutter beside content that sits inside the container.
 *
 * The note: a short paragraph and typed lines with a stroke drawn on the blank line under each, then filler lines up
 * to line 99. Ink is drawn at content width 604 with no gutter and saved; each cell opens the saved note at a wide pane
 * with the canvas off. Readout: the text column's width (contentDOM.clientWidth) and each stroke's offset from its line
 * in note px (0 is the ink on its words), as in ZoomInkHold.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

const FONT_CSS = `
body { --font-text: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", Roboto, "Inter", sans-serif; --font-ui-smaller: 12px; --file-folding-offset: 24px; }
.cm-content { font-family: var(--font-text); }
`;
/** Obsidian's gutter rule, verbatim from obsidian-1.15.0.asar (the colour and border declarations kept as they are). */
const OBSIDIAN_GUTTER_CSS = `
.markdown-source-view.mod-cm6 .cm-gutters{flex:0 0 auto;background-color:transparent;color:var(--text-faint)!important;border-right:none!important;margin-inline-end:var(--file-folding-offset);font-size:var(--font-ui-smaller);z-index:1;font-variant:tabular-nums}
`;

const HEAD = [
	"Write each line below in ink, by hand, under its typed line. Neat, normal size, one line each. Leave the typed text alone.",
	"",
	"same length",
	"",
	"aromatic",
	"",
	"resonance",
	"",
	"delocalised, stable, flat ring",
	"",
];
const FILLER = Array.from({ length: 99 - HEAD.length }, (_, i) => "filler " + (HEAD.length + i + 1));
/** 99 lines: one more line takes the line-number gutter from two digits to three. */
const TEXT = [...HEAD, ...FILLER].join("\n");
/** The blank lines the strokes are drawn on, 1-based. */
const INKED = [4, 6, 8, 10];
const DRAWN = 604;

const PAGE = `
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { Platform } from "obsidian";
import { inlineInk, inkOverlayExtension, overlayForPath, setScrollExpansionEnabled, setInlineTool } from "../../src/inline/InkOverlay";
import { setPenInk } from "../../src/inline/PenInk";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField } from "./iphoneObsidianStub";
import { parsePage, serializePage } from "../../src/model/PageData";

Object.assign(Platform, { isMobile: false, isDesktop: true, isIosApp: false, isDesktopApp: true, isMobileApp: false, isPhone: false, isWin: true });
installObsidianDom();
const frame = () => new Promise(r => requestAnimationFrame(() => r()));
const wait = ms => new Promise(r => setTimeout(r, ms));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await frame(); };
const PATH = "notes/gutter.md", PAGE_ID = "3c1f7a20-5b8e-4d2a-9e61-7a0b4c2d9f31";
let rig = null, saves = 0, lastSaved = null;
let roLoopErrors = 0, otherErrors = [];
window.addEventListener("error", e => { if (String(e.message).includes("ResizeObserver loop")) roLoopErrors++; else otherErrors.push(String(e.message)); });

const measureOnce = () => new Promise(r => rig.view.requestMeasure({ read: v => [v.scrollDOM.scrollTop, v.contentHeight, v.contentDOM.clientWidth, v.viewport.from, v.viewport.to].join(","), write: m => r(m) }));
async function idleMeasures(max = 40) {
	let prev = null, same = 0;
	for (let i = 0; i < max; i++) { await frame(); const m = await measureOnce(); if (m === prev) { if (++same >= 2) return i; } else same = 0; prev = m; }
	return -1;
}
async function quietAll() { await settle(8); await idleMeasures(); await wait(900); await settle(8); return idleMeasures(); }

function lineTop(n) {
	const { view, overlay } = rig, pos = view.state.doc.line(n).from, at = view.domAtPos(pos).node;
	const el = (at.nodeType === 1 ? at : at.parentElement)?.closest(".cm-line");
	return el ? (el.getBoundingClientRect().top - view.documentTop) / (overlay.pinchScaleNow || 1) : Number.NaN;
}

function read(phase) {
	const { view, overlay, orig, pane } = rig, layout = overlay.lineLayout(), px = layout ? layout.pxPerWorld : 1;
	const offsets = [];
	for (const s of inlineInk.strokes(PATH)) {
		const o = orig[s.id]; if (!o) continue;
		const belongs = lineTop(o.line) / px + (s.bbox.y - o.top);
		offsets.push(+((s.bbox.y + overlay.lineAnchorDy(s)) - belongs).toFixed(2));
	}
	const g = pane.querySelector(".cm-gutters"), sizer = view.contentDOM.closest(".cm-sizer");
	return { phase, cw: view.contentDOM.clientWidth, lines: view.state.doc.lines,
		capped: pane.classList.contains("handwriting-note-column-capped"), held: pane.classList.contains("handwriting-note-column-held"),
		holdVar: pane.style.getPropertyValue("--handwriting-note-column-hold"), capSizerVar: pane.style.getPropertyValue("--handwriting-note-column-cap-sizer"),
		gutterW: g && g.style.display !== "none" ? g.getBoundingClientRect().width : 0, gutterInContainer: !!g && g.parentElement === view.contentDOM.parentElement,
		sizerW: sizer ? sizer.getBoundingClientRect().width : null,
		strokes: offsets.length, offsets, nonZero: offsets.filter(v => Math.abs(v) > 0.5).length, saves, roLoopErrors, otherErrors: otherErrors.slice() };
}

window.ccg = {
	async mount(o) {
		setPenInk(true); setScrollExpansionEnabled(o.canvas !== false); setInlineTool("pen");
		saves = 0; lastSaved = o.sidecar ?? null;
		const ids = new Map([[PATH, PAGE_ID]]);
		inlineInk.attachHost({ readPageId: p => ids.get(p) ?? null, claimId: async (p, id) => ({ pageId: ids.get(p) ?? id }),
			loadSidecar: async () => (lastSaved === null ? null : parsePage(lastSaved, PAGE_ID)),
			scheduleSidecar: (id, page) => { saves++; lastSaved = serializePage(page); }, scheduleSidecarNow: async (id, page) => { saves++; lastSaved = serializePage(page); }, notify: () => {} });
		const pane = document.body.appendChild(document.createElement("div"));
		pane.className = "markdown-source-view mod-cm6" + (o.readable ? " is-readable-line-width" : "");
		pane.style.cssText = "position:relative;margin-left:244px;margin-top:76px;width:" + o.paneW + "px;height:700px;overflow:hidden";
		const view = new EditorView({ parent: pane, state: EditorState.create({ doc: o.text, extensions: [EditorView.lineWrapping,
			...(o.gutter === "none" ? [] : [lineNumbers()]),
			editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path: PATH }, editor: {} })), inkOverlayExtension(),
			EditorView.theme({ "&": { width: "100%", height: "700px" }, ".cm-scroller": { overflowY: "auto", overflowX: "hidden" }, ".cm-content": { fontSize: "16px", lineHeight: "1.5" } })] }) });
		// Obsidian's editor view: the sizer and the container, the gutter moved in beside the content.
		const sizer = document.createElement("div"); sizer.className = "cm-sizer";
		const container = document.createElement("div"); container.className = "cm-contentContainer";
		view.contentDOM.parentElement.insertBefore(sizer, view.contentDOM); sizer.appendChild(container);
		const g = view.scrollDOM.querySelector(".cm-gutters");
		if (g) { if (o.gutter === "hidden") g.style.display = "none"; container.appendChild(g); }
		container.appendChild(view.contentDOM);
		let overlay = overlayForPath(PATH);
		for (let i = 0; i < 60 && !overlay; i++) { await frame(); overlay = overlayForPath(PATH); }
		if (!overlay) throw new Error("no overlay");
		rig = { pane, view, overlay, orig: o.orig ?? {} };
		await quietAll();
		return read("mounted");
	},
	async draw() {
		const { view } = rig, doc = view.state.doc;
		for (const line of ${JSON.stringify(INKED)}) {
			const b = view.lineBlockAt(doc.line(line).from), x0 = view.contentDOM.getBoundingClientRect().left + 20;
			const yy = view.documentTop + b.top + b.height / 2;
			const pen = (type, x, buttons) => document.elementFromPoint(x, yy)?.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "pen", pointerId: 7, isPrimary: true, clientX: x, clientY: yy, buttons, pressure: buttons ? 0.5 : 0 }));
			pen("pointermove", x0, 0); await frame(); pen("pointerdown", x0, 1);
			for (let k = 1; k <= 12; k++) { pen("pointermove", x0 + k * 8, 1); await frame(); }
			pen("pointerup", x0 + 96, 0); await quietAll();
		}
		const orig = {};
		for (const s of inlineInk.strokes(PATH)) if (s.lineAnchor) orig[s.id] = { line: s.lineAnchor.line, top: s.lineAnchor.top };
		rig.orig = orig;
		await quietAll();
		return { ...read("drawn"), orig, sidecar: lastSaved };
	},
	/** Line 100: one short line typed at the end, so the line-number gutter takes a third digit. */
	async line100(phase) {
		const { view } = rig;
		view.dispatch({ changes: { from: view.state.doc.length, insert: String.fromCharCode(10) + "line 100" } });
		await quietAll();
		return read(phase);
	},
	/** Line numbers turned on: the gutter that was display: none is shown beside the content. */
	async showGutter(phase) {
		rig.pane.querySelector(".cm-gutters").style.display = "";
		await quietAll();
		return read(phase);
	},
};
`;

let script: string;
let browser: Browser;
const PAD = 15;

beforeAll(async () => {
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "columnCapGutterPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true, args: ["--force-device-scale-factor=2", "--window-size=1440,1000"] });
}, 180_000);
afterAll(async () => { await browser?.close(); });

type Mode = { canvas?: boolean; readable?: boolean; gutter?: "none" | "shown" | "hidden"; sidecar?: string | null; orig?: Record<string, unknown> };
async function open(paneW: number, mode: Mode = {}): Promise<{ page: Page; m: any }> {
	const page = await (await browser.newContext({ viewport: null })).newPage();
	await page.setContent('<!doctype html><body class="theme-dark" style="margin:0"></body>');
	await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS + OBSIDIAN_GUTTER_CSS + FONT_CSS });
	await page.addScriptTag({ content: script });
	const m = await page.evaluate(o => (window as any).ccg.mount(o), { text: TEXT, paneW, gutter: "none", ...mode });
	return { page, m };
}
const ev = (p: Page, fn: string, ...args: unknown[]): Promise<any> => p.evaluate(([f, a]) => (window as any).ccg[f as string](...(a as unknown[])), [fn, args] as const);
const close = (p: Page) => p.context().close();

describe("canvas off, a capped column: the line-number gutter changes and the text keeps the width the ink was drawn at", () => {
	let note: { sidecar: string; orig: Record<string, unknown> };
	beforeAll(async () => {
		const o = await open(DRAWN + PAD, { canvas: false });
		const d = await ev(o.page, "draw");
		await close(o.page);
		expect(d.cw, "content width the ink was drawn at").toBe(DRAWN);
		expect(d.strokes, "strokes drawn").toBe(INKED.length);
		expect(d.nonZero, "ink on its words where it was drawn").toBe(0);
		expect(d.sidecar, "the ink was saved").not.toBeNull();
		note = { sidecar: d.sidecar, orig: d.orig };
	}, 180_000);

	it("readable line length on: line 99 to line 100 widens the gutter and the text stays at 604 with the ink on its words", async () => {
		const o = await open(1200, { canvas: false, readable: true, gutter: "shown", sidecar: note.sidecar, orig: note.orig });
		console.log("readable on, line 100, mounted " + JSON.stringify(o.m));
		expect(o.m.gutterInContainer, "the gutter sits beside the content").toBe(true);
		expect(o.m.capped, "capped").toBe(true);
		expect(o.m.cw, "column at the start").toBe(DRAWN);
		const r = await ev(o.page, "line100", "line-100");
		console.log("readable on, line 100, after " + JSON.stringify(r));
		expect(r.lines, "the note has 100 lines").toBe(100);
		expect(r.gutterW, "the gutter widened").toBeGreaterThan(o.m.gutterW);
		expect(r.capped, "still capped").toBe(true);
		expect(r.cw, "column after the gutter widened").toBe(DRAWN);
		expect(r.offsets, "ink on its words").toEqual(INKED.map(() => 0));
		expect(r.roLoopErrors, "observer loop errors").toBe(0);
		expect(r.otherErrors, "page errors").toEqual([]);
		await close(o.page);
	}, 180_000);

	it("readable line length on: line numbers turned on while capped and the text stays at 604 with the ink on its words", async () => {
		const o = await open(1200, { canvas: false, readable: true, gutter: "hidden", sidecar: note.sidecar, orig: note.orig });
		console.log("readable on, gutter shown, mounted " + JSON.stringify(o.m));
		expect(o.m.capped, "capped").toBe(true);
		expect(o.m.gutterW, "no gutter at the start").toBe(0);
		expect(o.m.cw, "column at the start").toBe(DRAWN);
		const r = await ev(o.page, "showGutter", "gutter-shown");
		console.log("readable on, gutter shown, after " + JSON.stringify(r));
		expect(r.gutterW, "the gutter is shown").toBeGreaterThan(0);
		expect(r.capped, "still capped").toBe(true);
		expect(r.cw, "column after line numbers came on").toBe(DRAWN);
		expect(r.offsets, "ink on its words").toEqual(INKED.map(() => 0));
		expect(r.roLoopErrors, "observer loop errors").toBe(0);
		expect(r.otherErrors, "page errors").toEqual([]);
		await close(o.page);
	}, 180_000);

	it("readable line length off: line 99 to line 100 and nothing changes but the gutter", async () => {
		const o = await open(1200, { canvas: false, readable: false, gutter: "shown", sidecar: note.sidecar, orig: note.orig });
		console.log("readable off, line 100, mounted " + JSON.stringify(o.m));
		expect(o.m.capped, "capped").toBe(true);
		expect(o.m.cw, "column at the start").toBe(DRAWN);
		const r = await ev(o.page, "line100", "line-100");
		console.log("readable off, line 100, after " + JSON.stringify(r));
		expect(r.gutterW, "the gutter widened").toBeGreaterThan(o.m.gutterW);
		expect(r.cw, "column after the gutter widened").toBe(DRAWN);
		expect({ capped: r.capped, held: r.held, holdVar: r.holdVar, capSizerVar: r.capSizerVar, sizerW: r.sizerW },
			"the classes, widths written and the sizer are as before").toEqual({ capped: o.m.capped, held: o.m.held, holdVar: o.m.holdVar, capSizerVar: o.m.capSizerVar, sizerW: o.m.sizerW });
		expect(r.offsets, "ink on its words").toEqual(INKED.map(() => 0));
		expect(r.roLoopErrors, "observer loop errors").toBe(0);
		expect(r.otherErrors, "page errors").toEqual([]);
		await close(o.page);
	}, 180_000);
});
