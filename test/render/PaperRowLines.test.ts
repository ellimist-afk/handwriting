/**
 * PAPER LINES ON THE TEXT ROWS, on the real engine with Obsidian's own rules: the lined paper's pitch is one plain body
 * row, so every plain row's top and bottom edge sits on a rule's bottom edge. Headings and pictures break the match
 * below them; the paper does not bend, and the text never moves.
 *
 * The page is PaperTitleRewrap's mount without the title: a real `.markdown-source-view.mod-cm6` pane with Obsidian
 * 1.13.7's app.css slices (obsidianReadableWidth.ts; the scroller's `line-height: var(--line-height-normal)`, 1.5),
 * and no line height of the fixture's own: the text size is set on the pane, and the row height is whatever the
 * engine makes of it. DSF 2.
 *
 * WHAT IS READ: the lined paper's lattice as the stylesheet places it (the scroller's box, its scroll, the phase and
 * pan the host carries, scaled by the painted scale), against each rendered `.cm-line` box's top and bottom, modulo
 * the pitch, in device rows. At rest the reading is checked against DSF-2 pixels in a blank strip (rules kept only
 * where another sits one pitch away). Dots are read from pixels only: dot centres against a row's middle.
 *
 * Cells:
 * - C2: plain rows (text, blank lines, a wrapped paragraph) on the rules at 16 px; after the text goes to 20 px; after
 *   a pinch to 200 percent and its settle. Each within one device row.
 * - C3: dots at a 25.6 px row (line height 1.6): row 1000's dot centre against row 1000's middle, within one device
 *   row; row 2 the control.
 * - C4: a heading on line 1 does not set the pitch: the pitch with a heading there equals the pitch without.
 * - C5: the line height moves with the text size unchanged (Obsidian's `--line-height-normal` 1.5 to 1.75): rows on
 *   the rules again after the settle. The change is followed by what Obsidian runs on any theme, snippet or font
 *   change: css-change to the plugin, then CodeMirror's measure (lineHeight in the page script cites the app lines).
 *
 * Plants (each an env var; the bundle's source edited at load, anchor found exactly once):
 * HW_PAPER_ROW_PLANT_FONT_RATIO=1 (the pitch from 28 x font / 16: C2, C3, C5 red),
 * HW_PAPER_ROW_PLANT_DEFAULT_FIRST=1 (CodeMirror's measured default line height before the computed one: C4 red when
 * CodeMirror measures the heading), HW_PAPER_ROW_PLANT_NO_TRIGGER=1 (a line height change alone runs no refresh: C5
 * red), HW_PAPER_ROW_PLANT_CAMERA_NO_ROW=1 (no row read at the camera's font change: red only if the refresh path does
 * not also catch the font step).
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";
import { decodePng } from "./pngInk";

declare const process: { env: Record<string, string | undefined> };

/** A heading line as Obsidian draws it: its own size and line height (the h1 variables PaperTitleRewrap carries). */
const HEADING_CSS = `
body { --h1-line-height: 1.2; --h1-size: 1.618em; }
.markdown-source-view.mod-cm6 .cm-line.HyperMD-header-1 { font-size: var(--h1-size); line-height: var(--h1-line-height); font-weight: 700; }
`;

const PAGE = `
import { EditorState } from "@codemirror/state";
import { EditorView, Decoration } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { inlineInk, inkOverlayExtension, overlayForPath, paperCssChangeAll, repaintAllInkOverlays, setScrollExpansionEnabled } from "../../src/inline/InkOverlay";
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
// A task after the frame's callbacks (a message, not a timer): a read there sees the frame the overlay synced.
const rendered = () => new Promise(r => requestAnimationFrame(() => { const c = new MessageChannel(); c.port1.onmessage = () => { c.port1.close(); r(); }; c.port2.postMessage(0); }));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await frame(); };
const PANE_W = 1397.5, PANE_H = 800, HOST_LEFT = 300;
let rig = null;

function installSizer(view) {
	const sizer = document.createElement("div"); sizer.className = "cm-sizer";
	const container = document.createElement("div"); container.className = "cm-contentContainer";
	view.contentDOM.parentElement.insertBefore(sizer, view.contentDOM); sizer.appendChild(container); container.appendChild(view.contentDOM);
	void view.scrollDOM.clientWidth; return sizer;
}

const LONG = "Handwriting notes on the lecture about amino acids and the structure of proteins in living cells across several weeks of the semester, written out at length so that this one paragraph wraps onto several rows of the column";
/** Short rows that never reach the pixel strip, blank lines, list items, then a wrapped paragraph below the strip. */
function textDoc(heading) {
	const rows = [];
	if (heading) rows.push("# Heading");
	for (let i = 0; i < 24; i++) rows.push(i % 3 === 1 ? "" : i % 3 === 2 ? "- item " + i : "row " + i);
	rows.push(LONG, LONG, "", "after");
	for (let i = 0; i < 40; i++) rows.push("tail " + i);
	return rows.join("\\n");
}

/** The paper's lattice origin in client px and the painted scale, as the stylesheet places it, in this frame. */
function lattice() {
	const { view } = rig, sc = view.scrollDOM;
	const num = (v, d) => { const n = Number.parseFloat(v); return Number.isFinite(n) ? n : d; };
	const cs = getComputedStyle(sc), r = sc.getBoundingClientRect();
	const k = r.height / sc.offsetHeight, pitch = num(cs.getPropertyValue("--handwriting-paper-pitch"), 28);
	const phase = num(cs.getPropertyValue("--handwriting-paper-phase"), 0), panY = num(cs.getPropertyValue("--handwriting-paper-pan-y"), 0);
	const element = view.dom.querySelector(":scope > .handwriting-paper-preview");
	const paperY = element ? element.getBoundingClientRect().top + phase * k : r.top + (sc.clientTop + phase + panY - sc.scrollTop) * k;
	return { k, pitch, phase, panY, paperY, source: element ? "element" : "scroller", rect: { left: r.left, top: r.top, width: r.width, height: r.height } };
}

/** Every rendered plain line inside the scroller: its top and bottom edge against the nearest rule, in device rows. */
function read(tag, dsf, skipHeading) {
	const L = lattice(), { view, overlay } = rig;
	const off = y => { const rel = ((((y - L.paperY) / L.k) % L.pitch) + L.pitch) % L.pitch; return Math.min(rel, L.pitch - rel) * L.k * dsf; };
	const lines = Array.from(view.contentDOM.querySelectorAll(".cm-line"));
	const rows = [];
	let firstTop = null;
	for (const [i, el] of lines.entries()) {
		const b = el.getBoundingClientRect();
		if (b.bottom < L.rect.top || b.top > L.rect.top + L.rect.height) continue;
		if (firstTop === null) firstTop = b.top;
		if (skipHeading && el.classList.contains("HyperMD-header-1")) continue;
		rows.push({ i, top: off(b.top), bottom: off(b.bottom), h: b.height / L.k, wrapped: b.height / L.k > L.pitch * 1.5 });
	}
	const cs = getComputedStyle(view.contentDOM);
	return { tag, k: L.k, pinch: overlay.pinchScaleNow, pitch: L.pitch, phase: L.phase, source: L.source, rows, maxOff: Math.max(0, ...rows.flatMap(r => [r.top, r.bottom])),
		fontSize: cs.fontSize, lineHeight: cs.lineHeight, defaultLineHeight: view.defaultLineHeight, firstTop, strip: { ...L.rect, firstTop } };
}

window.paperRows = {
	async mount(opts) {
		setPenInk(true); setScrollExpansionEnabled(true);
		const path = "paper-rows-" + opts.id + ".md";
		const pane = document.body.appendChild(document.createElement("div"));
		pane.className = "markdown-source-view mod-cm6";
		pane.style.cssText = "position:relative;margin-left:" + HOST_LEFT + "px;width:" + PANE_W + "px;height:" + PANE_H + "px;overflow:hidden;font-size:" + opts.font + "px";
		const doc = opts.blank ? Array.from({ length: opts.blank }, () => "").join("\\n") : textDoc(opts.heading);
		const deco = opts.heading ? [EditorView.decorations.of(Decoration.set([Decoration.line({ class: "HyperMD-header HyperMD-header-1" }).range(0)]))] : [];
		const view = new EditorView({ parent: pane, state: EditorState.create({ doc, extensions: [history(), EditorView.lineWrapping, ...deco,
			editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} })), inkOverlayExtension(),
			EditorView.theme({ "&": { width: PANE_W + "px", height: PANE_H + "px" }, ".cm-scroller": { overflowY: "auto", overflowX: "hidden" }, ".cm-content": { fontFamily: "monospace" } })] }) });
		installSizer(view);
		await settle(12);
		const overlay = overlayForPath(path);
		if (!overlay) throw new Error("no overlay for " + path);
		rig = { pane, view, overlay, path, geometryUpdates: 0 };
		// Probe (C5): count the overlay's CodeMirror updates that carry a geometry change, the route a line height re-read takes.
		const ownUpdate = overlay.update;
		overlay.update = function (u) { if (u.geometryChanged) rig.geometryUpdates++; return ownUpdate.call(this, u); };
		await settle(12);
		return read("rest", opts.dsf, opts.heading);
	},
	async font(px, dsf) { rig.pane.style.fontSize = px + "px"; await settle(16); return read("font-" + px, dsf, false); },
	async lineHeight(v, dsf) {
		rig.geometryUpdates = 0;
		document.body.style.setProperty("--line-height-normal", String(v));
		// What Obsidian does after a theme, snippet or font change (obsidian-1.15.1.asar app.js): the workspace fires
		// "css-change" (:245, :670); the plugin's own handler runs (PluginOnload.ts, css-change); every Markdown view's
		// onCssChange (:581, :585) runs the editor's refresh (:525), which is CodeMirror's requestMeasure (:509, :521).
		repaintAllInkOverlays(); paperCssChangeAll();
		rig.view.requestMeasure();
		await settle(16);
		const r = read("line-height-" + v, dsf, false), { view, overlay } = rig;
		r.probe = { geometryUpdates: rig.geometryUpdates, defaultLineHeight: view.defaultLineHeight, lastLineHeightStr: overlay.lastLineHeightStr, paperRowPx: overlay.paperRowPx, pitch: lattice().pitch };
		return r;
	},
	async pinch(to, steps, dsf) {
		const { view, overlay } = rig, router = overlay.router, from = overlay.pinchScaleNow;
		const r = view.scrollDOM.getBoundingClientRect(), cx = r.left + 400, cy = r.top + 300;
		const spread0 = 300, spread1 = 300 * to / from;
		const touch = s => { router.touchPos.set(911, { x: cx - s / 2, y: cy }); router.touchPos.set(912, { x: cx + s / 2, y: cy }); };
		const ev = type => new PointerEvent(type, { pointerId: 912, pointerType: "touch" });
		touch(spread0); router.beginPinch(ev("pointerdown"));
		for (let i = 1; i <= steps; i++) { touch(spread0 + (spread1 - spread0) * i / steps); router.updatePinch(ev("pointermove")); await rendered(); }
		router.endPinch(ev("pointerup"), { x: cx, y: cy }); router.touchPos.clear();
		for (let j = 1; j <= 24; j++) await rendered();
		return read("pinch-" + to, dsf, false);
	},
	/** Brings line n (1-based) into view and returns its box and the lattice, for a pixel read of the dots. */
	async showLine(n) {
		const { view } = rig, line = view.state.doc.line(n);
		view.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: "center" }) });
		await settle(16);
		const node = view.domAtPos(line.from).node, el = (node.nodeType === 1 ? node : node.parentElement).closest(".cm-line");
		const b = el.getBoundingClientRect(), L = lattice();
		return { top: b.top, bottom: b.bottom, k: L.k, pitch: L.pitch, left: L.rect.left };
	},
};
`;

const SRC = /src[\\/]inline[\\/](PaperPlan|InkOverlayCamera|InkOverlayReload)\.ts$/;
const PLANTS: { env: string; file: RegExp; from: string; to: string }[] = [
	{ env: "HW_PAPER_ROW_PLANT_FONT_RATIO", file: /PaperPlan\.ts$/, from: "toLayoutUnit(Number.isFinite(textRowPx) && textRowPx > 0 ? textRowPx : BASE_PITCH * scale)", to: "toLayoutUnit(BASE_PITCH * scale)" },
	{ env: "HW_PAPER_ROW_PLANT_DEFAULT_FIRST", file: /PaperPlan\.ts$/, from: "\tif (Number.isFinite(px) && px > 0) return px;\n", to: "\tif (defaultLineHeight !== undefined && defaultLineHeight > 0) return defaultLineHeight;\n\tif (Number.isFinite(px) && px > 0) return px;\n" },
	{ env: "HW_PAPER_ROW_PLANT_NO_TRIGGER", file: /InkOverlayReload\.ts$/, from: "(this.contentStyle.fontSize !== this.lastFontStr || this.contentStyle.lineHeight !== this.lastLineHeightStr)", to: "this.contentStyle.fontSize !== this.lastFontStr" },
	{ env: "HW_PAPER_ROW_PLANT_CAMERA_NO_ROW", file: /InkOverlayCamera\.ts$/, from: "\t\t\tthis.paperRowPx = paperRowPx(this.contentStyle?.lineHeight, this.view.defaultLineHeight);\n", to: "" },
];

let browser: Browser, script: string;
const DSF = 2, TOL_DEV = 1, PAGE_GREY = 255, RULE_GREY = 0x77;

beforeAll(async () => {
	const active = PLANTS.filter(pl => process.env[pl.env]);
	let planted = 0;
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "paperRowLinesPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
		plugins: active.length ? [{ name: "paper-row-plants", setup(builder) {
			builder.onLoad({ filter: SRC }, args => {
				let text = readFileSync(args.path, "utf8").replace(/\r\n/g, "\n");
				for (const pl of active.filter(x => x.file.test(args.path))) {
					if (text.split(pl.from).length !== 2) throw new Error(`${pl.env}: anchor not found once`);
					text = text.replace(pl.from, pl.to);
					planted++;
				}
				return { loader: "ts", contents: text };
			});
		} }] : [] });
	if (planted !== active.length) throw new Error(`plants requested ${active.length}, applied ${planted}`);
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true, args: [`--force-device-scale-factor=${DSF}`, "--window-size=1800,900"] });
}, 180_000);
afterAll(async () => { await browser?.close(); });

const call = (p: Page, method: string, ...args: unknown[]) => p.evaluate(([m, a]) => (window as any).paperRows[m](...a), [method, args] as const);

type Read = { tag: string; k: number; pinch: number; pitch: number; phase: number; source: string; maxOff: number; fontSize: string; lineHeight: string; defaultLineHeight: number;
	rows: { i: number; top: number; bottom: number; h: number; wrapped: boolean }[]; strip: { left: number; top: number; width: number; height: number; firstTop: number }; probe?: unknown };

async function open(kind: "lines" | "dots", font: number, opts: { heading?: boolean; blank?: number; lineHeight?: number } = {}) {
	const page = await browser.newPage({ viewport: null });
	await page.setContent(`<!doctype html><body class="handwriting-paper-${kind}" style="margin:0; background:#ffffff; --background-modifier-border:#777777${opts.lineHeight ? `; --line-height-normal:${opts.lineHeight}` : ""}"></body>`);
	await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS + HEADING_CSS + (opts.lineHeight ? `body { --line-height-normal: ${opts.lineHeight} !important; }` : "") });
	await page.addScriptTag({ content: script });
	const rest = await call(page, "mount", { id: `${kind}-${font}-${opts.heading ? "h" : "p"}-${opts.blank ?? 0}`, font, heading: !!opts.heading, blank: opts.blank ?? 0, dsf: DSF }) as Read;
	return { page, rest };
}

/** Rule bottom edges in device rows from a blank strip right of the short rows, kept where another edge sits one pitch away. */
async function pixelOff(p: Page, row: Read) {
	const clip = { x: Math.round(row.strip.left + 1000), y: Math.max(0, Math.round(row.strip.top)), width: 8, height: Math.min(400, Math.floor(row.strip.height - 10)) };
	const d = decodePng(await p.screenshot({ clip }));
	const frac: number[] = [];
	for (let y = 0; y < d.height; y++) {
		let sum = 0;
		for (let x = 0; x < d.width; x++) { const i = (y * d.width + x) * d.channels; sum += (d.px[i]! + d.px[i + 1]! + d.px[i + 2]!) / 3; }
		frac.push(Math.max(0, Math.min(1, (PAGE_GREY - sum / d.width) / (PAGE_GREY - RULE_GREY))));
	}
	const ends: number[] = [];
	for (let i = 0; i < frac.length; i++) { if (frac[i]! <= 0.5) continue; let j = i; while (j + 1 < frac.length && frac[j + 1]! > 0.5) j++; ends.push(j + 1); i = j; }
	const pDev = row.pitch * row.k * DSF;
	const kept = ends.filter(e => ends.some(f => f !== e && Math.abs(Math.abs(f - e) - pDev) <= 2));
	const origin = (row.strip.firstTop - clip.y) * DSF;
	const circ = (a: number) => { const m = ((a % pDev) + pDev) % pDev; return Math.min(m, pDev - m); };
	return { kept: kept.length, ends: ends.slice(0, 8), off: kept.length ? Math.max(...kept.map(e => circ(e - origin))) : Number.NaN };
}

/** Dot centres (device rows) in a clip around one row, and that row's middle in the same rows. */
async function dotsAt(p: Page, at: { top: number; bottom: number; k: number; pitch: number; left: number }) {
	const pitchCss = at.pitch * at.k;
	const clip = { x: Math.round(at.left + 200), y: Math.max(0, Math.round(at.top - pitchCss * 1.5)), width: Math.ceil(pitchCss * 3), height: Math.ceil(pitchCss * 4) };
	const d = decodePng(await p.screenshot({ clip }));
	const dark: boolean[] = [];
	for (let y = 0; y < d.height; y++) {
		let min = 255;
		for (let x = 0; x < d.width; x++) { const i = (y * d.width + x) * d.channels; min = Math.min(min, (d.px[i]! + d.px[i + 1]! + d.px[i + 2]!) / 3); }
		dark.push(min < 0xc8);
	}
	const centres: number[] = [];
	for (let y = 0; y < dark.length; y++) { if (!dark[y]) continue; let j = y; while (j + 1 < dark.length && dark[j + 1]) j++; centres.push((y + j + 1) / 2); y = j; }
	const middle = ((at.top + at.bottom) / 2 - clip.y) * DSF;
	const nearest = centres.length ? centres.reduce((a, c) => (Math.abs(c - middle) < Math.abs(a - middle) ? c : a)) : Number.NaN;
	return { centres, middle, off: Math.abs(nearest - middle), spacing: centres.slice(1).map((c, i) => c - centres[i]!) };
}

const offRows = (r: Read) => r.rows.filter(x => x.top > TOL_DEV || x.bottom > TOL_DEV).map(x => ({ i: x.i, top: Math.round(x.top * 100) / 100, bottom: Math.round(x.bottom * 100) / 100, h: x.h }));
const log = (r: Read) => `${r.tag}: pitch ${r.pitch} font ${r.fontSize} line-height ${r.lineHeight} cm-default ${r.defaultLineHeight} k ${r.k.toFixed(3)} rows ${r.rows.length} wrapped ${r.rows.filter(x => x.wrapped).length} maxOff ${r.maxOff.toFixed(2)}`;

it("C2: plain rows sit on the rules at 16 px, after the text goes to 20 px, and after a pinch to 200 percent", async () => {
	const { page, rest } = await open("lines", 16);
	try {
		// eslint-disable-next-line no-console
		console.log(`PAPER-ROWS ${log(rest)}`);
		expect(rest.rows.length, "premise: rows read at rest").toBeGreaterThanOrEqual(20);
		expect(rest.rows.some(r => r.wrapped), "premise: a wrapped paragraph is on screen").toBe(true);
		const px = await pixelOff(page, rest);
		expect(px.kept, `premise: rules found at rest ${JSON.stringify(px)}`).toBeGreaterThanOrEqual(3);
		expect(Math.abs(px.off - Math.min(rest.rows[0]!.top, 99)), `instrument: the frame reading agrees with the pixels at rest ${JSON.stringify({ px, row0: rest.rows[0] })}`).toBeLessThanOrEqual(1.5);
		expect(offRows(rest), `rows off the rules at 16 px (${log(rest)})`).toEqual([]);

		const twenty = await call(page, "font", 20, DSF) as Read;
		// eslint-disable-next-line no-console
		console.log(`PAPER-ROWS ${log(twenty)}`);
		expect(twenty.fontSize, "premise: the text is at 20 px").toBe("20px");
		expect(offRows(twenty), `rows off the rules at 20 px (${log(twenty)})`).toEqual([]);

		const pinched = await call(page, "pinch", 2, 20, DSF) as Read;
		// eslint-disable-next-line no-console
		console.log(`PAPER-ROWS ${log(pinched)}`);
		expect(pinched.pinch, "premise: the pinch reached 200 percent").toBeCloseTo(2, 6);
		expect(pinched.source, "premise: after the settle the paper is the scroller's own").toBe("scroller");
		expect(offRows(pinched), `rows off the rules at 200 percent (${log(pinched)})`).toEqual([]);
	} finally { await page.close(); }
}, 180_000);

it("C3: dots at a 25.6 px row: row 1000's dot is on row 1000's middle, as row 2's is", async () => {
	const { page, rest } = await open("dots", 16, { blank: 1100, lineHeight: 1.6 });
	try {
		// eslint-disable-next-line no-console
		console.log(`PAPER-ROWS dots ${log(rest)}`);
		expect(rest.lineHeight, "premise: the row is 25.6 px").toBe("25.6px");
		const near = await dotsAt(page, await call(page, "showLine", 2) as { top: number; bottom: number; k: number; pitch: number; left: number });
		const far = await dotsAt(page, await call(page, "showLine", 1000) as { top: number; bottom: number; k: number; pitch: number; left: number });
		// eslint-disable-next-line no-console
		console.log(`PAPER-ROWS dots row 2 ${JSON.stringify(near)} row 1000 ${JSON.stringify(far)}`);
		expect(near.centres.length, `premise: dots found at row 2 ${JSON.stringify(near)}`).toBeGreaterThanOrEqual(3);
		expect(far.centres.length, `premise: dots found at row 1000 ${JSON.stringify(far)}`).toBeGreaterThanOrEqual(3);
		expect(near.off, `control: row 2's dot against its middle, device rows ${JSON.stringify(near)}`).toBeLessThanOrEqual(TOL_DEV);
		expect(far.off, `row 1000's dot against its middle, device rows ${JSON.stringify(far)}`).toBeLessThanOrEqual(TOL_DEV);
	} finally { await page.close(); }
}, 180_000);

it("C4: a heading on line 1 does not set the pitch", async () => {
	const plain = await open("lines", 16);
	const headed = await open("lines", 16, { heading: true });
	try {
		// eslint-disable-next-line no-console
		console.log(`PAPER-ROWS plain ${log(plain.rest)} | heading ${log(headed.rest)}`);
		expect(headed.rest.pitch, `the pitch with a heading on line 1 (CodeMirror's default line height ${headed.rest.defaultLineHeight})`).toBe(plain.rest.pitch);
	} finally { await plain.page.close(); await headed.page.close(); }
}, 180_000);

it("C5: the line height moves with the text size unchanged, and the rows are on the rules again after the settle", async () => {
	const { page, rest } = await open("lines", 16);
	try {
		expect(offRows(rest), `premise: rows on the rules at rest (${log(rest)})`).toEqual([]);
		const moved = await call(page, "lineHeight", 1.75, DSF) as Read;
		// eslint-disable-next-line no-console
		console.log(`PAPER-ROWS ${log(rest)} -> ${log(moved)}`);
		expect(moved.fontSize, "premise: the text size did not change").toBe("16px");
		expect(moved.lineHeight, "premise: the line height moved").toBe("28px");
		// eslint-disable-next-line no-console
		console.log(`PAPER-ROWS C5 PROBE ${JSON.stringify(moved.probe)}`);
		expect(offRows(moved), `rows off the rules after the line height moved (${log(moved)}) probe ${JSON.stringify(moved.probe)}`).toEqual([]);
	} finally { await page.close(); }
}, 180_000);
