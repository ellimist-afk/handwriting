/**
 * THE PAPER THROUGH A TITLE REWRAP: a pinch that rewraps the inline title above the text moves every text line by the
 * title's change in height at once, and the paper must move with them, on every frame of the gesture, as the ink does.
 *
 * The page is WrappedTitlePinch's: a real two-line `.inline-title` with Obsidian's own rules above the text, the
 * router's two-finger pinch from 100 to 300 percent (Readable line length off, the regime where a two-line title
 * rewraps on the way in), plus lined paper. A one-line title that never rewraps is the control.
 *
 * Zoom mechanics, not the canvas-off refusal itself - mounted canvas ON so the pinch still reaches
 * 300 percent once the canvas-off gate is restored; the ruling's canvas-on settle laws apply (no centring, no fit
 * window), which this file never asserted against in the first place.
 *
 * WHAT IS READ, PER FRAME, INSIDE THE FRAME: the lined paper's lattice origin as the stylesheet places it - the
 * scroller's box, its scroll, the phase the host carries and the pan the scroller carries, scaled by the painted scale
 * - against the first `.cm-line`'s top, modulo the pitch, in device rows. A gesture of 30 steps and 16 settle frames
 * runs inside one page call, so a screenshot taken afterwards shows only the final frame; the per-frame reading has
 * to come from the frame itself. It is checked against real DSF-2 pixels where pixels and frame agree in time: at rest
 * before the gesture and after the settle. The pixel reader keeps only bands that sit on the pitch lattice (a band
 * with another band exactly one pitch away), so a glyph of a long text line that strays into the strip is not read as
 * a rule.
 *
 * Plants: HW_PAPER_TITLE_PLANT_NO_SNAP_CARRY=1 (a preview no longer carries the at-rest snap's residual out of the
 * paper: the one-line control goes red once the zoom grows the residual past the tolerance),
 * HW_PAPER_TITLE_PLANT_NO_PAN=1 (the pan writer never hands the pan to the paper: both arms red) and
 * HW_PAPER_TITLE_PLANT_NO_REWRAP=1 (the paper never takes the title's height change: the two-line arm red from its
 * first rewrap on, the one-line arm green).
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

/** Obsidian 1.13.7 app.css, verbatim, as WrappedTitlePinch.test.ts carries it. */
const INLINE_TITLE_CSS = `
body { --h1-line-height: 1.2; --h1-size: 1.618em; --h1-weight: 700; --h1-font: inherit; --h1-style: normal; --h1-variant: normal; --h1-color: inherit;
  --inline-title-color: var(--h1-color); --inline-title-font: var(--h1-font); --inline-title-line-height: var(--h1-line-height);
  --inline-title-size: var(--h1-size); --inline-title-style: var(--h1-style); --inline-title-variant: var(--h1-variant);
  --inline-title-weight: var(--h1-weight); --inline-title-margin-bottom: 0.5em; }
.inline-title { color: var(--inline-title-color); white-space: pre-wrap; margin-block-end: var(--inline-title-margin-bottom); }
.inline-title:not([data-level]) { font-size: var(--inline-title-size); font-weight: var(--inline-title-weight); line-height: var(--inline-title-line-height);
  font-style: var(--inline-title-style); font-variant: var(--inline-title-variant); font-family: var(--inline-title-font); letter-spacing: -0.015em; }
`;

const PAGE = `
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
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
/** After the frame has rendered: its layout, its ResizeObserver deliveries and its paint have run. */
const rendered = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await frame(); };
const PANE_W = 1397.5, PANE_H = 800, HOST_LEFT = 300;
let rig = null;

function installSizer(view) {
	const sizer = document.createElement("div"); sizer.className = "cm-sizer";
	const container = document.createElement("div"); container.className = "cm-contentContainer";
	view.contentDOM.parentElement.insertBefore(sizer, view.contentDOM); sizer.appendChild(container); container.appendChild(view.contentDOM);
	void view.scrollDOM.clientWidth; return sizer;
}
const words = "Handwriting notes on the lecture about amino acids and the structure of proteins in living cells across several weeks of the semester".split(" ");
const titleLines = title => { const range = document.createRange(); range.selectNodeContents(title); return new Set(Array.from(range.getClientRects()).filter(r => r.width > 0).map(r => Math.round(r.top))).size; };

/** The paper's lattice against the first line, as the stylesheet places it, in this frame; and the geometry a pixel strip needs. */
function read(tag) {
	const { view, overlay, title } = rig;
	const sc = view.scrollDOM, firstLine = view.contentDOM.querySelector(".cm-line");
	const num = (v, d) => { const n = Number.parseFloat(v); return Number.isFinite(n) ? n : d; };
	const cs = getComputedStyle(sc), r = sc.getBoundingClientRect();
	const k = r.height / sc.offsetHeight, pitch = num(cs.getPropertyValue("--handwriting-paper-pitch"), 28);
	const phase = num(cs.getPropertyValue("--handwriting-paper-phase"), 0), panY = num(cs.getPropertyValue("--handwriting-paper-pan-y"), 0);
	const lineTop = firstLine.getBoundingClientRect().top;
	// During a preview (and a bounce) the paper is the preview element: its lattice origin is its own box plus the phase.
	const element = view.dom.querySelector(":scope > .handwriting-paper-preview");
	const paperY = element ? element.getBoundingClientRect().top + phase * k : r.top + (sc.clientTop + phase + panY - sc.scrollTop) * k;
	const rel = ((((lineTop - paperY) / k) % pitch) + pitch) % pitch;
	return { tag, k, pinch: overlay.pinchScaleNow, titleLines: title ? titleLines(title) : 0, shifts: overlay.aboveContentShifts ?? 0, source: element ? "element" : "scroller",
		pitch, phase, panY, scrollTop: sc.scrollTop, offDev: Math.min(rel, pitch - rel) * k * 2, sizer: document.querySelector(".cm-sizer").style.transform,
		strip: { left: r.left, top: r.top, width: r.width, height: r.height, lineTop } };
}

window.titleRewrap = {
	async mount(twoLine) {
		setPenInk(true); setScrollExpansionEnabled(true);
		setInlineTool("pen"); setInkColorHex("pen", "#ff00ff"); setInkSizeMult("pen", 4);
		const path = "title-rewrap-" + twoLine + ".md";
		const pane = document.body.appendChild(document.createElement("div"));
		pane.className = "markdown-source-view mod-cm6";
		pane.style.cssText = "position:relative;margin-left:" + HOST_LEFT + "px;width:" + PANE_W + "px;height:" + PANE_H + "px;overflow:hidden";
		// Blank lines, not text: nothing but paper in the pixel strip.
		const doc = Array.from({ length: 400 }, () => "").join("\\n");
		const view = new EditorView({ parent: pane, state: EditorState.create({ doc, extensions: [history(), EditorView.lineWrapping,
			editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} })), inkOverlayExtension(),
			EditorView.theme({ "&": { width: PANE_W + "px", height: PANE_H + "px" }, ".cm-scroller": { overflowY: "auto", overflowX: "hidden" }, ".cm-content": { fontFamily: "monospace", fontSize: "16px", lineHeight: "24px" } })] }) });
		const sizer = installSizer(view);
		const title = document.createElement("div"); title.className = "inline-title"; title.setAttribute("contenteditable", "true");
		sizer.insertBefore(title, sizer.firstChild);
		let count = 0; title.textContent = "";
		if (twoLine) { while (count < words.length * 4 && titleLines(title) < 2) { title.textContent = (title.textContent ? title.textContent + " " : "") + words[count % words.length]; count++; } }
		else title.textContent = "Amino acids";
		await settle(12);
		const overlay = overlayForPath(path);
		if (!overlay) throw new Error("no overlay for " + path);
		rig = { pane, view, overlay, title, path };
		await settle(12);
		return { titleLines: titleLines(title), rest: read("rest") };
	},
	async pinch(to, steps) {
		const { view, overlay } = rig, router = overlay.router, from = overlay.pinchScaleNow;
		const r = view.scrollDOM.getBoundingClientRect(), cx = r.left + 400, cy = r.top + 300;
		const spread0 = 300, spread1 = 300 * to / from;
		const touch = s => { router.touchPos.set(911, { x: cx - s / 2, y: cy }); router.touchPos.set(912, { x: cx + s / 2, y: cy }); };
		const ev = type => new PointerEvent(type, { pointerId: 912, pointerType: "touch" });
		const rows = [read("before")];
		touch(spread0); router.beginPinch(ev("pointerdown"));
		for (let i = 1; i <= steps; i++) { touch(spread0 + (spread1 - spread0) * i / steps); router.updatePinch(ev("pointermove")); await rendered(); rows.push(read("move-" + i)); }
		router.endPinch(ev("pointerup"), { x: cx, y: cy }); router.touchPos.clear(); rows.push(read("lift"));
		for (let j = 1; j <= 16; j++) { await rendered(); rows.push(read("settle-" + j)); }
		return rows;
	},
	read,
};
`;

const PLANTS: { env: string; from: string; to: string }[] = [
	{ env: "HW_PAPER_TITLE_PLANT_NO_PAN", from: "\t\tthis.writePaperPan();\n\t\tthis.writeInkLayerTransform();\n", to: "\t\tthis.writeInkLayerTransform();\n" },
	{ env: "HW_PAPER_TITLE_PLANT_NO_REWRAP", from: "\t\t\tthis.paperRewrapY += dH;\n", to: "" },
	{ env: "HW_PAPER_TITLE_PLANT_NO_SNAP_CARRY", from: "\t\tconst carry = this.pinchPreview ? this.paperSnapResidual : null;\n", to: "\t\tconst carry = null as { x: number; y: number } | null;\n" },
];

let browser: Browser, script: string;
const DSF = 2, TOL_DEV = 2, PAGE_GREY = 255, RULE_GREY = 0x77;
/** On the preview element the rules land on whole device px: half a device px more. */
const TOL_PREVIEW_DEV = TOL_DEV + 0.5;

beforeAll(async () => {
	const active = PLANTS.filter(pl => process.env[pl.env]);
	let planted = 0;
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "paperTitleRewrapPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
		plugins: active.length ? [{ name: "paper-title-plants", setup(builder) {
			builder.onLoad({ filter: /src[\\/]inline[\\/]InkOverlay\.ts$/ }, args => {
				let text = readFileSync(args.path, "utf8").replace(/\r\n/g, "\n");
				for (const pl of active) {
					if (text.split(pl.from).length !== 2) throw new Error(`${pl.env}: anchor not found once`);
					text = text.replace(pl.from, pl.to);
					planted++;
				}
				return { loader: "ts", contents: text };
			});
		} }] : [] });
	if (planted !== active.length) throw new Error(`plants requested ${active.length}, applied ${planted}`);
	script = b.outputFiles[0]!.text;
	// The launch flag and no viewport override keep DSF 2 (a page-level viewport resets the device scale to 1).
	browser = await chromium.launch({ headless: true, args: [`--force-device-scale-factor=${DSF}`, "--window-size=1800,900"] });
}, 180_000);
afterAll(async () => { await browser?.close(); });

const call = (p: Page, method: string, ...args: unknown[]) => p.evaluate(([m, a]) => (window as any).titleRewrap[m](...a), [method, args] as const);

type Row = { tag: string; k: number; pinch: number; titleLines: number; shifts: number; source: "element" | "scroller"; pitch: number; phase: number; panY: number; scrollTop: number; offDev: number; sizer: string;
	strip: { left: number; top: number; width: number; height: number; lineTop: number } };

/** Rule bottom edges in device rows from a strip in the blank note, kept only where another edge sits one pitch away. */
async function pixelOff(p: Page, row: Row) {
	const clip = { x: Math.round(row.strip.left + 700), y: Math.max(0, Math.round(row.strip.top)), width: 8, height: Math.min(400, Math.floor(row.strip.height - 10)) };
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
	const lattice = ends.filter(e => ends.some(f => f !== e && Math.abs(Math.abs(f - e) - pDev) <= 2));
	const origin = (row.strip.lineTop - clip.y) * DSF;
	const circ = (a: number) => { const m = ((a % pDev) + pDev) % pDev; return Math.min(m, pDev - m); };
	return { kept: lattice.length, ends: ends.slice(0, 8), off: lattice.length ? Math.max(...lattice.map(e => circ(e - origin))) : Number.NaN };
}

for (const twoLine of [true, false]) {
	it(`TITLE ${twoLine ? "REWRAPS (two lines)" : "DOES NOT REWRAP (one line, control)"}: the paper stays on the text on every frame of a pinch to 300 percent and its settle`, async () => {
		const page = await browser.newPage({ viewport: null });
		try {
			await page.setContent('<!doctype html><body class="handwriting-paper-lines" style="margin:0; background:#ffffff; --background-modifier-border:#777777"></body>');
			await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS + INLINE_TITLE_CSS });
			await page.addScriptTag({ content: script });
			const mounted = await call(page, "mount", twoLine) as { titleLines: number; rest: Row };
			expect(mounted.titleLines, "premise: the title wraps as set up").toBe(twoLine ? 2 : 1);
			const restPixels = await pixelOff(page, mounted.rest);
			expect(restPixels.kept, `premise: rules found at rest ${JSON.stringify(restPixels)}`).toBeGreaterThanOrEqual(3);
			expect(Math.abs(restPixels.off - mounted.rest.offDev), `instrument: the frame reading agrees with the pixels at rest ${JSON.stringify({ restPixels, rest: mounted.rest })}`).toBeLessThanOrEqual(1.5);

			const rows = await call(page, "pinch", 3, 30) as Row[];
			expect(rows.at(-1)!.pinch, "premise: the pinch reached 300 percent").toBeCloseTo(3, 6);
			const transitions = rows.slice(1).filter((r, i) => r.titleLines !== rows[i]!.titleLines).length;
			if (twoLine) expect(transitions, `premise: the title rewrapped on the way in ${rows.map(r => r.titleLines)}`).toBeGreaterThan(0);
			else expect(transitions, `premise, control: no rewrap ${rows.map(r => r.titleLines)}`).toBe(0);

			const settledPixels = await pixelOff(page, rows.at(-1)!);
			expect(settledPixels.kept, `premise: rules found after the settle ${JSON.stringify(settledPixels)}`).toBeGreaterThanOrEqual(3);
			expect(Math.abs(settledPixels.off - rows.at(-1)!.offDev), `instrument: the frame reading agrees with the pixels after the settle ${JSON.stringify({ settledPixels, settled: rows.at(-1) })}`).toBeLessThanOrEqual(1.5);

			const moves = rows.filter(r => r.tag.startsWith("move-"));
			expect(moves.filter(r => r.source !== "element").map(r => r.tag), "premise: every frame with the fingers down reads the preview element").toEqual([]);
			expect(rows.at(-1)!.source, "premise: sixteen frames after the lift the paper is the scroller's own").toBe("scroller");
			const off = rows.filter(r => r.offDev > (r.source === "element" ? TOL_PREVIEW_DEV : TOL_DEV)).map(r => ({ tag: r.tag, source: r.source, k: Math.round(r.k * 1000) / 1000, titleLines: r.titleLines, shifts: r.shifts, offDev: Math.round(r.offDev * 100) / 100 }));
			// eslint-disable-next-line no-console
			console.log(`PAPER-TITLE twoLine=${twoLine} transitions=${transitions} maxOff=${Math.max(...rows.map(r => r.offDev)).toFixed(2)} settledSizer=${rows.at(-1)!.sizer} settledPanY=${rows.at(-1)!.panY} restPixels=${JSON.stringify(restPixels)} settledPixels=${JSON.stringify(settledPixels)}`);
			expect(off, `frames where the paper stood off the text by more than ${TOL_DEV} device rows (${TOL_PREVIEW_DEV} on the preview element)`).toEqual([]);
		} finally { await page.close(); }
	}, 180_000);
}
