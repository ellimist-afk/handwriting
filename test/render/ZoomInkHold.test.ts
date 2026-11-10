/**
 * With Infinite Canvas on, a note's text column is held at the width its ink was drawn against (ColumnRef.ts), so a zoom,
 * a window or a sidebar that changes the pane's width no longer re-wraps the text under the ink. With the canvas off, a
 * pane with room for that width shows the column at it; a narrower pane is laid out exactly as it always was.
 *
 * The note: one long paragraph that takes 3 rows at content width 604, 2 at 700 and 4 at 398, then short typed lines with
 * a stroke drawn on the blank line under each. A re-wrap of the paragraph moves every line below it by a row; ink that
 * stays at its page position then sits under the next typed line. Ink is drawn with the pen at 604 and saved; a reload is
 * a fresh page from the saved file.
 *
 * Readout per stroke, in note px, from the anchor it was drawn with: where its line is now (CodeMirror's lineBlockAt, an
 * instrument the overlay does not own) against where the surface shows it (page position plus the overlay's correction).
 * offset = shown - belongs; 0 is the ink on its words.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { appendFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

const FONT_CSS = `
body { --font-text: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", Roboto, "Inter", sans-serif; }
.cm-content { font-family: var(--font-text); }
`;

/** Minimal's readable-width rules, theme.css:1831-1867, as in MinimalResync.test.ts. */
const MINIMAL_CSS = `
body { --line-width: 40rem; --max-width: 88%; }
body { --content-margin: auto; --content-margin-start: max(calc(50% - var(--line-width)/2), calc(50% - var(--max-width)/2)); --content-line-width: min(var(--line-width), var(--max-width)); }
.markdown-source-view.mod-cm6.is-readable-line-width .cm-content,
.markdown-source-view.mod-cm6.is-readable-line-width .cm-sizer { max-width: 100%; width: 100%; }
.markdown-source-view.mod-cm6.is-readable-line-width .cm-contentContainer.cm-contentContainer > .cm-content > div {
  max-width: var(--max-width); width: var(--line-width); margin-inline: var(--content-margin) !important;
}
`;

const TEXT = [
	"Write each line below in ink, by hand, under its typed line. Neat, normal size, one line each. Leave the typed text alone. If a word goes wrong, write it again after it. No erasing needed.",
	"",
	"same length",
	"",
	"aromatic",
	"",
	"resonance",
	"",
	"delocalised, stable, flat ring",
	"",
].join("\n");
/** The blank lines the strokes are drawn on, 1-based. */
const INKED = [4, 6, 8, 10];

const PAGE = `
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
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
const PATH = "notes/held.md", PAGE_ID = "6a1d0c3e-9f0b-4d7e-8a51-2f4c8b9e7d10";
let rig = null, saves = 0, lastSaved = null;
let roLoopErrors = 0;
window.addEventListener("error", e => { if (String(e.message).includes("ResizeObserver loop")) roLoopErrors++; });

const measureOnce = () => new Promise(r => rig.view.requestMeasure({ read: v => [v.scrollDOM.scrollTop, v.contentHeight, v.contentDOM.clientWidth, v.viewport.from, v.viewport.to].join(","), write: m => r(m) }));
async function idleMeasures(max = 40) {
	let prev = null, same = 0;
	for (let i = 0; i < max; i++) { await frame(); const m = await measureOnce(); if (m === prev) { if (++same >= 2) return i; } else same = 0; prev = m; }
	return -1;
}
async function quietAll() { await settle(8); await idleMeasures(); await wait(900); await settle(8); return idleMeasures(); }

/** The top of a document line's element, in editor px from the document's top: the page itself, not the height map. */
function lineTop(n) {
	const { view, overlay } = rig, pos = view.state.doc.line(n).from, at = view.domAtPos(pos).node;
	const el = (at.nodeType === 1 ? at : at.parentElement)?.closest(".cm-line");
	return el ? (el.getBoundingClientRect().top - view.documentTop) / (overlay.pinchScaleNow || 1) : Number.NaN;
}

function read(phase) {
	const { view, overlay, orig, pane } = rig, doc = view.state.doc, layout = overlay.lineLayout(), px = layout ? layout.pxPerWorld : 1;
	const offsets = [];
	for (const s of inlineInk.strokes(PATH)) {
		const o = orig[s.id]; if (!o) continue;
		// Where the line IS, read from the page: CodeMirror's height map is what the overlay reads too, so it cannot judge it.
		const belongs = lineTop(o.line) / px + (s.bbox.y - o.top);
		offsets.push(+((s.bbox.y + overlay.lineAnchorDy(s)) - belongs).toFixed(2));
	}
	const sig = overlay.lineAnchors.sig;
	return { phase, cw: view.contentDOM.clientWidth, sig: sig ? sig.width : null, k: overlay.pinchScaleNow, canvas: overlay.canvasMode,
		held: pane.classList.contains("handwriting-note-column-held"), capped: pane.classList.contains("handwriting-note-column-capped"),
		holdVar: pane.style.getPropertyValue("--handwriting-note-column-hold"),
		strokes: offsets.length, offsets, nonZero: offsets.filter(v => Math.abs(v) > 0.5).length, saves };
}

window.zim = {
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
			editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path: PATH }, editor: {} })), inkOverlayExtension(),
			EditorView.theme({ "&": { width: "100%", height: "700px" }, ".cm-scroller": { overflowY: "auto", overflowX: "hidden" }, ".cm-content": { fontSize: "16px", lineHeight: "1.5" } })] }) });
		const sizer = document.createElement("div"); sizer.className = "cm-sizer";
		const container = document.createElement("div"); container.className = "cm-contentContainer";
		view.contentDOM.parentElement.insertBefore(sizer, view.contentDOM); sizer.appendChild(container); container.appendChild(view.contentDOM);
		let overlay = overlayForPath(PATH);
		for (let i = 0; i < 60 && !overlay; i++) { await frame(); overlay = overlayForPath(PATH); }
		if (!overlay) throw new Error("no overlay");
		rig = { pane, view, overlay, orig: o.orig ?? {} };
		// Every frame from the mount until the ink has been on screen for 30 frames: the open, as it is painted.
		const frames = [];
		for (let i = 0, shown = 0; i < 240 && shown < 30; i++) {
			await frame();
			if (inlineInk.strokes(PATH).length > 0) { shown++; const r = read("frame-" + i); frames.push({ i, cw: r.cw, nonZero: r.nonZero, offsets: r.offsets }); }
		}
		await quietAll();
		return { ...read("mounted"), frames };
	},
	async draw() {
		const { view } = rig, doc = view.state.doc;
		for (const line of ${JSON.stringify(INKED)}) {
			const b = view.lineBlockAt(doc.line(line).from), x0 = view.contentDOM.getBoundingClientRect().left + 20;
			// documentTop is the document's top on screen, so this is the middle of the blank line.
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
	read,
	async resize(paneW, phase) {
		rig.pane.style.width = paneW + "px";
		await frame(); const early = read(phase + "-first-frame");
		await quietAll();
		return [early, read(phase)];
	},
	/**
	 * A pane resize read at the frame it arrives: the second frame's callback runs before anything that frame schedules, so
	 * it reads what the first frame after the change painted. Then the settled read.
	 */
	async resizeArrived(paneW, phase) {
		rig.pane.style.width = paneW + "px";
		await frame(); await frame(); const arrived = { ...read(phase + "-arrived"), sizerW: window.zim.room().sizerW };
		await quietAll();
		return [arrived, { ...read(phase), sizerW: window.zim.room().sizerW }];
	},
	/**
	 * Tune the note to the scroll-bar edge at a wide pane (capped): one last line just narrower than the stored width, so it
	 * takes one row capped and two at any narrower column, then blank lines above it up to one row short of the viewport.
	 */
	async edgeSetup(stored, wideW) {
		const { view } = rig, sd = view.scrollDOM;
		rig.pane.style.width = wideW + "px"; await quietAll();
		// The bar's width on this scroller: its gutter reserved for one read, then given back.
		const gutter0 = sd.style.scrollbarGutter;
		sd.style.scrollbarGutter = "stable"; const sbw = sd.offsetWidth - sd.clientWidth; sd.style.scrollbarGutter = gutter0;
		// A note whose scroller already overflows with nothing added keeps its bar at every width: recorded, not tuned.
		const overflowBefore = sd.scrollHeight - sd.clientHeight;
		const ls = getComputedStyle(view.contentDOM.querySelector(".cm-line"));
		const pad = parseFloat(ls.paddingLeft) + parseFloat(ls.paddingRight);
		const ctx = document.createElement("canvas").getContext("2d");
		ctx.font = ls.fontStyle + " " + ls.fontWeight + " " + ls.fontSize + " " + ls.fontFamily;
		const target = stored - pad - 2;
		let s = "";
		while (ctx.measureText(s + "m").width <= target) s += "m";
		while (ctx.measureText(s + "i").width <= target) s += "i";
		const NL = String.fromCharCode(10);
		view.dispatch({ changes: { from: view.state.doc.length, insert: NL + s } });
		await quietAll();
		let added = 0;
		while (added < 80 && sd.scrollHeight <= sd.clientHeight) { view.dispatch({ changes: { from: view.state.doc.length - s.length, insert: NL } }); added++; await settle(2); }
		if (added > 0 && sd.scrollHeight > sd.clientHeight) { const at = view.state.doc.length - s.length; view.dispatch({ changes: { from: at - 1, to: at } }); added--; }
		await quietAll();
		return { sbw, overflowBefore, contentH: view.contentDOM.offsetHeight, scrollH: sd.scrollHeight, clientH: sd.clientHeight, pad, chars: s.length, lineW: ctx.measureText(s).width, added, overflowY: sd.scrollHeight - sd.clientHeight,
			offset: wideW - sd.clientWidth, capped: rig.pane.classList.contains("handwriting-note-column-capped"), cw: view.contentDOM.clientWidth };
	},
	/** From a settled pane at fromW, resize to edgeW and record 60 frames: cap, column, scroll bar, loop errors. */
	async approach(fromW, edgeW, phase) {
		const { view, pane } = rig, sd = view.scrollDOM;
		pane.style.width = fromW + "px"; await quietAll();
		const start = { capped: pane.classList.contains("handwriting-note-column-capped"), cw: view.contentDOM.clientWidth, sb: sd.offsetWidth - sd.clientWidth };
		const errors0 = roLoopErrors, frames = [];
		pane.style.width = edgeW + "px";
		for (let i = 0; i < 60; i++) { await frame(); frames.push({ capped: pane.classList.contains("handwriting-note-column-capped"), cw: view.contentDOM.clientWidth, sb: sd.offsetWidth - sd.clientWidth }); }
		const last = frames.slice(30), flips = (a) => a.slice(1).filter((f, i) => f.capped !== a[i].capped).length;
		return { phase, fromW, edgeW, start, landed: frames[59], flipsAll: flips(frames), flipsLast30: flips(last),
			settled: last.every(f => f.capped === last[0].capped && f.cw === last[0].cw && f.sb === last[0].sb), roLoopErrors: roLoopErrors - errors0,
			trace: frames.map(f => (f.capped ? "C" : "u") + f.cw + (f.sb ? "s" : "")).join(" ") };
	},
	/** The canvas turned off or on live, the way the setting does it, for every mounted note. */
	async setCanvas(on, phase) {
		setScrollExpansionEnabled(on);
		await frame(); const early = read(phase + "-first-frame");
		await quietAll();
		return [early, read(phase)];
	},
	async type(text, phase) {
		const { view } = rig;
		view.dispatch({ changes: { from: 0, insert: text } });
		await quietAll();
		return read(phase);
	},
	async reach() {
		const { view } = rig, sd = view.scrollDOM;
		const left0 = view.contentDOM.getBoundingClientRect().left - rig.pane.getBoundingClientRect().left;
		sd.scrollLeft = 1e6; await frame(); await frame();
		const right = view.contentDOM.getBoundingClientRect().right - sd.getBoundingClientRect().right;
		sd.scrollLeft = 0; await quietAll();
		return { left0, columnRightPastPane: right };
	},
	/** With the canvas off: the scroller's sideways overflow, the column's left edge in the pane, and the sizer's width. */
	room() {
		const { view, pane } = rig, sd = view.scrollDOM, sizer = view.contentDOM.closest(".cm-sizer");
		return { overflowX: sd.scrollWidth - sd.clientWidth, left0: view.contentDOM.getBoundingClientRect().left - pane.getBoundingClientRect().left,
			sizerW: sizer ? sizer.getBoundingClientRect().width : null };
	},
	/** Attribute writes on the pane and the editor while the note scrolls: the hold reads and writes nothing per frame. */
	async scrollWrites() {
		const { view, pane } = rig, sd = view.scrollDOM;
		let writes = 0;
		const mo = new MutationObserver(list => { writes += list.length; });
		mo.observe(pane, { attributes: true, attributeFilter: ["class", "style"] });
		for (let i = 0; i < 60; i++) { sd.scrollTop = (i % 2) * 24; await frame(); }
		await frame(); mo.disconnect();
		return writes;
	},
};
`;

let script: string;
/** The scroll-bar edge records go to this file when it is named (the log keeps only failing tests' output). */
const RECORD = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.HW_ZIH_RECORD ?? "";
const record = (line: string): void => { console.log(line); if (RECORD) appendFileSync(RECORD, line + String.fromCharCode(10)); };
let browser: Browser;
const PAD = 15, AT = (cw: number) => cw + PAD;

beforeAll(async () => {
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "zoomInkHoldPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true, args: ["--force-device-scale-factor=2", "--window-size=1440,1000"] });
}, 180_000);
afterAll(async () => { await browser?.close(); });

type Mode = { canvas?: boolean; readable?: boolean; minimal?: boolean; gutterAuto?: boolean; sidecar?: string | null; orig?: Record<string, unknown> };
/** A theme that drops Obsidian's stable scroll-bar gutter: the bar then takes its width from the content box when it shows. */
const GUTTER_AUTO_CSS = `\n.markdown-source-view.mod-cm6 .cm-scroller { scrollbar-gutter: auto; }\n`;
async function open(paneW: number, mode: Mode = {}): Promise<{ page: Page; m: any }> {
	const page = await (await browser.newContext({ viewport: null })).newPage();
	await page.setContent('<!doctype html><body class="theme-dark" style="margin:0"></body>');
	await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS + FONT_CSS + (mode.minimal ? MINIMAL_CSS : "") + (mode.gutterAuto ? GUTTER_AUTO_CSS : "") });
	await page.addScriptTag({ content: script });
	const m = await page.evaluate(o => (window as any).zim.mount(o), { text: TEXT, paneW, ...mode });
	return { page, m };
}
const ev = (p: Page, fn: string, ...args: unknown[]): Promise<any> => p.evaluate(([f, a]) => (window as any).zim[f as string](...(a as unknown[])), [fn, args] as const);
const close = (p: Page) => p.context().close();

/** The note inked at content width `cw`: its saved file and each stroke's line as drawn. */
async function inked(cw: number, mode: Mode = {}): Promise<{ sidecar: string; orig: Record<string, unknown>; drawn: any }> {
	const o = await open(AT(cw), mode);
	const d = await ev(o.page, "draw");
	await close(o.page);
	expect(d.cw, "content width the ink was drawn at").toBe(cw);
	expect(d.strokes, "strokes drawn").toBe(INKED.length);
	expect(d.nonZero, "ink on its words where it was drawn").toBe(0);
	expect(d.sidecar, "the ink was saved").not.toBeNull();
	return { sidecar: d.sidecar, orig: d.orig, drawn: d };
}

describe("canvas on: the text column holds the width the ink was drawn at", () => {
	let note: { sidecar: string; orig: Record<string, unknown> };
	beforeAll(async () => { note = await inked(604); }, 180_000);

	it("live: the pane at 700 and at 398 keeps the column at 604 and the ink on its words", async () => {
		const o = await open(AT(604), { sidecar: note.sidecar, orig: note.orig });
		for (const cw of [700, 398]) {
			const [early, s] = await ev(o.page, "resize", AT(cw), "live-" + cw);
			for (const r of [early, s]) {
				expect(r.cw, r.phase + " column").toBe(604);
				expect(r.offsets, r.phase + " offsets").toEqual(INKED.map(() => 0));
			}
		}
		await close(o.page);
	}, 180_000);

	it("reload at 700 and at 398: every frame from the ink's first shows it on its words", async () => {
		for (const cw of [700, 398]) {
			const o = await open(AT(cw), { sidecar: note.sidecar, orig: note.orig });
			expect(o.m.cw, "reload-" + cw + " column").toBe(604);
			expect(o.m.held, "reload-" + cw + " held").toBe(true);
			expect(o.m.offsets, "reload-" + cw + " offsets").toEqual(INKED.map(() => 0));
			const off = o.m.frames.filter((f: any) => f.nonZero > 0).map((f: any) => f.i);
			expect(off, "reload-" + cw + " frames with ink off its words").toEqual([]);
			await close(o.page);
		}
	}, 180_000);

	it("the first frame at open on the note's own width: no snap, nothing written", async () => {
		const o = await open(AT(604), { sidecar: note.sidecar, orig: note.orig });
		expect(o.m.frames.length, "frames with ink").toBeGreaterThan(0);
		expect(o.m.frames.map((f: any) => f.cw), "column every frame").toEqual(o.m.frames.map(() => 604));
		expect(o.m.frames.filter((f: any) => f.nonZero > 0).map((f: any) => f.i), "frames off").toEqual([]);
		expect(o.m.saves, "a mount alone writes nothing").toBe(0);
		await close(o.page);
	}, 180_000);

	it("typing while held does what typing does at the width the ink was drawn at", async () => {
		// Typed text moves and the ink stays where it was drawn; the reference is the same typing at a 604 pane.
		const TYPED = "Typed while held at a narrow pane, long enough to add a row to the paragraph. ";
		const ref = await open(AT(604), { sidecar: note.sidecar, orig: note.orig });
		const want = await ev(ref.page, "type", TYPED, "typed-604");
		await close(ref.page);
		const o = await open(AT(398), { sidecar: note.sidecar, orig: note.orig });
		const r = await ev(o.page, "type", TYPED, "typed");
		expect(r.cw, "column").toBe(604);
		expect(r.offsets, "offsets after typing, against the same typing at 604").toEqual(want.offsets);
		await close(o.page);
	}, 180_000);

	it("the column keeps its left edge and is reachable on the right; scrolling writes nothing", async () => {
		const natural = await open(AT(604), { sidecar: note.sidecar, orig: note.orig });
		const base = await ev(natural.page, "reach");
		await close(natural.page);
		const o = await open(AT(398), { sidecar: note.sidecar, orig: note.orig });
		const r = await ev(o.page, "reach");
		expect(r.left0, "left edge at rest").toBeCloseTo(base.left0, 1);
		expect(r.columnRightPastPane, "column's right edge at the furthest scroll").toBeLessThanOrEqual(0.5);
		expect(await ev(o.page, "scrollWrites"), "pane writes while scrolling").toBe(0);
		await close(o.page);
	}, 180_000);

	it("a save at another width with the canvas off keeps the width the ink was drawn at", async () => {
		// Canvas off at 398: the anchors are re-taken at 398 and an ordinary save (one more stroke) writes them so.
		const off = await open(AT(398), { canvas: false, sidecar: note.sidecar, orig: note.orig });
		expect(off.m.held, "canvas off holds nothing").toBe(false);
		const d = await ev(off.page, "draw");
		await close(off.page);
		const saved = JSON.parse(d.sidecar);
		expect(saved.strokes.filter((s: any) => s.lineAnchor?.width === 398).length, "anchors saved at 398").toBeGreaterThan(INKED.length);
		const o = await open(AT(700), { sidecar: d.sidecar, orig: note.orig });
		expect(o.m.cw, "column").toBe(604);
		expect(o.m.offsets.slice(0, INKED.length), "the first ink, on its words").toEqual(INKED.map(() => 0));
		await close(o.page);
	}, 240_000);
});

describe("the canvas turned off and on live on a held note", () => {
	let note: { sidecar: string; orig: Record<string, unknown> };
	beforeAll(async () => { note = await inked(604); }, 180_000);

	it("at 700: off, the pane has the room and the column keeps 604 with the ink on its words; on again, held", async () => {
		const o = await open(AT(700), { sidecar: note.sidecar, orig: note.orig });
		expect(o.m.cw, "canvas on, column").toBe(604);
		expect(o.m.offsets, "canvas on, offsets").toEqual(INKED.map(() => 0));
		const [, off] = await ev(o.page, "setCanvas", false, "off-700");
		expect(off.canvas, "canvas").toBe(false);
		expect(off.held, "canvas hold with the canvas off").toBe(false);
		expect(off.capped, "capped with the canvas off").toBe(true);
		expect(off.holdVar, "width written").toBe("604px");
		expect(off.cw, "column with the canvas off").toBe(604);
		expect(off.offsets, "offsets with the canvas off").toEqual(INKED.map(() => 0));
		const [, on] = await ev(o.page, "setCanvas", true, "on-again-700");
		expect(on.held, "held again").toBe(true);
		expect(on.capped, "the cap is off with the canvas on").toBe(false);
		expect(on.cw, "column on again").toBe(604);
		expect(on.offsets, "offsets on again").toEqual(INKED.map(() => 0));
		await close(o.page);
	}, 180_000);

	it("at 398: off, the text wraps to the pane and the ink sits a row above its words, as before", async () => {
		const o = await open(AT(398), { sidecar: note.sidecar, orig: note.orig });
		expect(o.m.cw, "canvas on, column").toBe(604);
		const [, off] = await ev(o.page, "setCanvas", false, "off-398");
		expect(off.held, "canvas hold with the canvas off").toBe(false);
		expect(off.capped, "a narrower pane is today's layout: nothing capped").toBe(false);
		expect(off.holdVar, "a narrower pane is today's layout: no width written").toBe("");
		expect(off.cw, "column with the canvas off").toBe(398);
		// The paragraph takes a row more at 398: every line under it moves down a row, and the ink stays at its page position.
		expect(off.offsets, "offsets with the canvas off").toEqual(INKED.map(() => -24));
		await close(o.page);
	}, 180_000);
});

describe("canvas on: other column rules", () => {
	it("Minimal: the ink drawn at a wide pane stays on its words at a narrow one", async () => {
		const note = await inked(885, { minimal: true, readable: true });
		const o = await open(500, { minimal: true, readable: true, sidecar: note.sidecar, orig: note.orig });
		expect(o.m.held, "held").toBe(true);
		expect(o.m.cw, "column").toBe(885);
		expect(o.m.offsets, "offsets").toEqual(INKED.map(() => 0));
		await close(o.page);
	}, 240_000);

	it("readable line length on: the ink drawn at the 700 cap stays on its words at a narrow pane", async () => {
		const note = await inked(700, { readable: true });
		const o = await open(500, { readable: true, sidecar: note.sidecar, orig: note.orig });
		expect(o.m.cw, "column").toBe(700);
		expect(o.m.offsets, "offsets").toEqual(INKED.map(() => 0));
		await close(o.page);
	}, 240_000);
});

describe("canvas off: the column is the smaller of the pane and the width the ink was drawn at", () => {
	let note: { sidecar: string; orig: Record<string, unknown> };
	beforeAll(async () => { note = await inked(604, { canvas: false }); }, 180_000);

	it("reload at 700: the column keeps 604 and every frame from the ink's first shows it on its words", async () => {
		const o = await open(AT(700), { canvas: false, sidecar: note.sidecar, orig: note.orig });
		expect(o.m.held, "canvas hold").toBe(false);
		expect(o.m.capped, "capped").toBe(true);
		expect(o.m.holdVar, "width written").toBe("604px");
		expect(o.m.cw, "column").toBe(604);
		expect(o.m.offsets, "offsets").toEqual(INKED.map(() => 0));
		expect(o.m.frames.filter((f: any) => f.nonZero > 0).map((f: any) => f.i), "frames with ink off its words").toEqual([]);
		expect(o.m.saves, "a mount alone writes nothing").toBe(0);
		await close(o.page);
	}, 180_000);

	it("live: the pane at 700 keeps 604 with the ink on its words; at 398 the text wraps to the pane, as it did", async () => {
		const o = await open(AT(604), { canvas: false, sidecar: note.sidecar, orig: note.orig });
		const [, wide] = await ev(o.page, "resize", AT(700), "off-live-700");
		expect(wide.cw, "column at 700").toBe(604);
		expect(wide.offsets, "offsets at 700").toEqual(INKED.map(() => 0));
		const [, narrow] = await ev(o.page, "resize", AT(398), "off-live-398");
		expect(narrow.cw, "column at 398").toBe(398);
		expect(narrow.capped, "capped at 398").toBe(false);
		expect(narrow.holdVar, "width written at 398").toBe("");
		// The paragraph takes a row more at 398: every line under it moves down a row, and the ink stays at its page position.
		expect(narrow.offsets, "offsets at 398").toEqual(INKED.map(() => -24));
		await close(o.page);
	}, 180_000);

	it("no room is added on the right, the column keeps its left edge, and scrolling writes nothing", async () => {
		const natural = await open(AT(604), { canvas: false, sidecar: note.sidecar, orig: note.orig });
		const base = await ev(natural.page, "room");
		await close(natural.page);
		const o = await open(AT(1000), { canvas: false, sidecar: note.sidecar, orig: note.orig });
		expect(o.m.cw, "column").toBe(604);
		const r = await ev(o.page, "room");
		expect(r.overflowX, "sideways room past the pane").toBeLessThanOrEqual(0);
		expect(r.left0, "left edge").toBeCloseTo(base.left0, 1);
		expect(await ev(o.page, "scrollWrites"), "pane writes while scrolling").toBe(0);
		await close(o.page);
	}, 180_000);

	it("typing at a pane with the room does what typing does at the width the ink was drawn at", async () => {
		// With the canvas off, typed text moves and the ink stays where it was drawn; the reference is the same typing at 604.
		const TYPED = "Typed with the canvas off at a wider pane, long enough to add a row to the paragraph. ";
		const ref = await open(AT(604), { canvas: false, sidecar: note.sidecar, orig: note.orig });
		const want = await ev(ref.page, "type", TYPED, "off-typed-604");
		await close(ref.page);
		const o = await open(AT(700), { canvas: false, sidecar: note.sidecar, orig: note.orig });
		const r = await ev(o.page, "type", TYPED, "off-typed");
		expect(r.cw, "column").toBe(604);
		expect(r.offsets, "offsets after typing, against the same typing at 604").toEqual(want.offsets);
		await close(o.page);
	}, 180_000);

	it("a note with no ink: nothing is written and the text wraps to the pane", async () => {
		const o = await open(AT(700), { canvas: false });
		expect(o.m.capped, "capped").toBe(false);
		expect(o.m.holdVar, "width written").toBe("");
		expect(o.m.cw, "column").toBe(700);
		await close(o.page);
	}, 180_000);
});

describe("canvas off: the vertical scroll bar at the edge of the stored width", () => {
	const notes = new Map<number, Promise<{ sidecar: string; orig: Record<string, unknown> }>>();
	const noteAt = (cw: number) => { if (!notes.has(cw)) notes.set(cw, inked(cw, { canvas: false })); return notes.get(cw)!; };
	for (const c of [{ readable: false, stored: 604 }, { readable: true, stored: 885 }])
		for (const gutterAuto of [false, true])
			it(`readable ${c.readable ? "on" : "off"}, stored ${c.stored}, ${gutterAuto ? "auto" : "stable"} gutter: from wider and from narrower the state settles`, async () => {
				const note = await noteAt(c.stored);
				const mode = { canvas: false, readable: c.readable, gutterAuto, sidecar: note.sidecar, orig: note.orig };
				const o = await open(c.stored + 100, mode);
				const setup = await ev(o.page, "edgeSetup", c.stored, c.stored + 100);
				record("scroll-bar edge setup " + JSON.stringify({ ...c, gutterAuto, ...setup }));
				expect(setup.sbw, "the rig has a classic scroll bar to test with").toBeGreaterThan(6);
				expect(setup.capped, "capped at the wide pane").toBe(true);
				// A scroller that overflows before any tuning keeps its bar at every width; the approaches still run and record.
				if (setup.overflowBefore <= 0) expect(setup.overflowY, "the tuned note is within one row of the viewport, no scroll bar, capped").toBeLessThanOrEqual(0);
				// The scroller's content box 4 px wider than the stored width while no scroll bar shows, under it once one does.
				const edgeW = c.stored + 4 + setup.offset;
				const wider = await ev(o.page, "approach", c.stored + 100, edgeW, "from-wider");
				const narrower = await ev(o.page, "approach", c.stored - 100, edgeW, "from-narrower");
				for (const r of [wider, narrower]) {
					record("scroll-bar edge " + JSON.stringify({ ...c, gutterAuto, ...r }));
					expect(r.roLoopErrors, r.phase + " ResizeObserver loop errors").toBe(0);
					expect(r.flipsLast30, r.phase + " cap flips over the last 30 frames").toBe(0);
					expect(r.settled, r.phase + " settled").toBe(true);
				}
				await close(o.page);
			}, 300_000);
});

describe("canvas off, readable line length on or off: the stored width wins when the pane has the room", () => {
	it("readable on, ink drawn at 604: a wide pane shows 604, not the 700 cap", async () => {
		const note = await inked(604, { canvas: false });
		const o = await open(1000, { canvas: false, readable: true, sidecar: note.sidecar, orig: note.orig });
		expect(o.m.cw, "column").toBe(604);
		expect(o.m.offsets, "offsets").toEqual(INKED.map(() => 0));
		await close(o.page);
	}, 240_000);

	it("readable on, ink drawn at 885 with it off: a wide pane shows 885, past the 700 cap", async () => {
		const note = await inked(885, { canvas: false });
		const o = await open(1000, { canvas: false, readable: true, sidecar: note.sidecar, orig: note.orig });
		expect(o.m.cw, "column").toBe(885);
		expect(o.m.offsets, "offsets").toEqual(INKED.map(() => 0));
		expect((await ev(o.page, "room")).overflowX, "sideways room past the pane").toBeLessThanOrEqual(0);
		await close(o.page);
	}, 240_000);

	it("readable on, ink drawn at 885: a pane of 800 is today's layout exactly, the 700 cap included", async () => {
		const note = await inked(885, { canvas: false });
		const o = await open(800, { canvas: false, readable: true, sidecar: note.sidecar, orig: note.orig });
		const today = await open(800, { canvas: false, readable: true });
		const t = await ev(today.page, "room");
		await close(today.page);
		expect(o.m.cw, "column").toBe(700);
		expect(o.m.cw, "column against the same pane with no ink").toBe(today.m.cw);
		expect(o.m.capped, "capped").toBe(false);
		expect(o.m.holdVar, "width written").toBe("");
		const r = await ev(o.page, "room");
		expect(r.sizerW, "sizer against the same pane with no ink").toBe(t.sizerW);
		expect(r.left0, "left edge against the same pane with no ink").toBeCloseTo(t.left0, 1);
		await close(o.page);
	}, 240_000);

	it("readable on, ink drawn at 885: a live resize across 885 switches at the frame it arrives, both ways", async () => {
		const note = await inked(885, { canvas: false });
		const o = await open(1000, { canvas: false, readable: true, sidecar: note.sidecar, orig: note.orig });
		expect(o.m.cw, "column at 1000").toBe(885);
		const [inA, inS] = await ev(o.page, "resizeArrived", 800, "off-rll-800");
		for (const r of [inA, inS]) {
			expect(r.cw, r.phase + " column").toBe(700);
			expect(r.capped, r.phase + " capped").toBe(false);
		}
		const [outA, outS] = await ev(o.page, "resizeArrived", 1000, "off-rll-1000");
		for (const r of [outA, outS]) {
			expect(r.cw, r.phase + " column").toBe(885);
			expect(r.capped, r.phase + " capped").toBe(true);
			expect(r.offsets, r.phase + " offsets").toEqual(INKED.map(() => 0));
		}
		await close(o.page);
	}, 240_000);

	it("readable off, ink drawn at the 700 cap with it on: a wide pane shows 700", async () => {
		const note = await inked(700, { canvas: false, readable: true });
		const o = await open(1000, { canvas: false, sidecar: note.sidecar, orig: note.orig });
		expect(o.m.cw, "column").toBe(700);
		expect(o.m.offsets, "offsets").toEqual(INKED.map(() => 0));
		await close(o.page);
	}, 240_000);

	it("Minimal, ink drawn at a wide pane: a wider pane keeps the column, a narrow one wraps to the pane", async () => {
		const note = await inked(885, { canvas: false, minimal: true, readable: true });
		const o = await open(1100, { canvas: false, minimal: true, readable: true, sidecar: note.sidecar, orig: note.orig });
		expect(o.m.cw, "column at 1100").toBe(885);
		expect(o.m.offsets, "offsets at 1100").toEqual(INKED.map(() => 0));
		const [, narrow] = await ev(o.page, "resize", 500, "off-minimal-500");
		expect(narrow.cw, "column at 500").toBeLessThan(885);
		await close(o.page);
	}, 240_000);
});
