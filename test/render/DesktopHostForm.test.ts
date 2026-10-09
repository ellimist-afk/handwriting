/**
 * THE DESKTOP HOST FORM PER ZOOM, on the WrappedTitlePinch mount (one-line title, Readable
 * line length on and off, Obsidian's theme and Minimal 9.0.2 with Readable line length off as Alan's test vault runs it
 * (readableLineLength false, cssTheme Minimal), monospace 16/24, a pen stroke on text
 * line 6, a long line that wraps), switched to the desktop app,
 * under the real --force-device-scale-factor flag at ratio 2 and 1.8257 (never deviceScaleFactor emulation).
 *
 * Above 1 the host takes the transform form however the zoom was reached: a 30-frame pinch, a one-step pinch (its
 * first factor is the target itself), the zoom bar's one commit. Before, a pinch-in's form hung on the read-back's
 * six-digit spelling of its first factor and the other two kept the zoom form, where Blink lays the text out again at
 * the zoomed font size with whole-px glyph metrics and the glyphs move against the ink (measured: 0.303 note px,
 * 0.54 CSS px, at 1.79 on a 1.8257 display). A pinch out to 0.5 keeps the zoom form.
 *
 * Per arm: the form on the host; the text term (the text line's centre against .cm-content's rect top, over the zoom,
 * against the 100 percent reading, note px) on every presented frame and settled, which the transform form holds
 * within 0.06; and the column: the long line's wrapped line count, the content's own width and the sizer's margin
 * (host-local px), which must equal the 30-frame pinch's at the same zoom. The inset on screen, which carries the
 * scroll and the pan, is printed only. Everything is printed.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
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
`;

const PAGE = `
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { Platform } from "obsidian";
import { inlineInk, inkOverlayExtension, overlayForPath, setScrollExpansionEnabled, setInlineTool, setInkSizeMult } from "../../src/inline/InkOverlay";
import { setInkColorHex } from "../../src/ink/InkColor";
import { setPenInk } from "../../src/inline/PenInk";
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
const rendered = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await frame(); };
const PANE_W = 1397.5, PANE_H = 800, HOST_LEFT = 300, TEXT_LINE = 6, LONG_LINE = 3;
const LONG = Array.from({ length: 40 }, (_, i) => "word" + i + " amino acid chains").join(" ");
let rig = null;

function installSizer(view) {
	const sizer = document.createElement("div"); sizer.className = "cm-sizer";
	const container = document.createElement("div"); container.className = "cm-contentContainer";
	view.contentDOM.parentElement.insertBefore(sizer, view.contentDOM); sizer.appendChild(container); container.appendChild(view.contentDOM);
	void view.scrollDOM.clientWidth; return sizer;
}
/** By its text, not its index: CodeMirror drops lines above its viewport once the note scrolls, and an index then names another line. */
const lineEl = (view, n) => { const want = n === LONG_LINE ? "word0 " : "line " + n + " "; const el = Array.from(view.contentDOM.querySelectorAll(".cm-line")).find(l => l.textContent.startsWith(want)); if (!el) throw new Error("line " + n + " is not in the DOM"); return el; };
const textBox = view => { const range = document.createRange(); range.selectNodeContents(lineEl(view, TEXT_LINE)); const r = range.getBoundingClientRect(); return { left: r.left, cy: (r.top + r.bottom) / 2 }; };
const wrapped = view => { if (!Array.from(view.contentDOM.querySelectorAll(".cm-line")).some(l => l.textContent.startsWith("word0 "))) return null; const range = document.createRange(); range.selectNodeContents(lineEl(view, LONG_LINE)); return new Set(Array.from(range.getClientRects()).filter(r => r.width > 0).map(r => Math.round(r.top))).size; };

function form() {
	const o = rig.overlay, cs = getComputedStyle(rig.view.dom);
	const zoom = Number.parseFloat(rig.view.dom.style.zoom || "1"), transform = rig.view.dom.style.transform;
	return { name: transform && transform.includes("scale(") ? "transform" : zoom !== 1 || o.pinchScaleNow === 1 ? "zoom" : "none", engine: o.hostZoomSupported(), computedZoom: cs.zoom, transform };
}
function sample(phase) {
	const { view, overlay } = rig, t = textBox(view);
	return { phase, k: overlay.pinchScaleNow, contentTop: view.contentDOM.getBoundingClientRect().top, textCy: t.cy };
}
function column() {
	const { view } = rig, sizer = view.contentDOM.closest(".cm-sizer"), host = view.dom;
	const local = el => el.getBoundingClientRect();
	const k = rig.overlay.cssScale;
	return { wrappedLines: wrapped(view), contentWidth: view.contentDOM.offsetWidth, scrollerClient: view.scrollDOM.clientWidth,
		insetLocal: (local(view.contentDOM).left - local(host).left) / k, sizerMargin: getComputedStyle(sizer).marginLeft,
		autoLeft: host.style.getPropertyValue("--handwriting-column-auto-left"), marginVar: host.style.getPropertyValue("--handwriting-column-margin-left") };
}

window.desktopHostForm = {
	async mount(readable) {
		setPenInk(true); setScrollExpansionEnabled(true);
		setInlineTool("pen"); setInkColorHex("pen", "#ff00ff"); setInkSizeMult("pen", 4);
		const path = "desktop-host-form.md";
		const pane = document.body.appendChild(document.createElement("div"));
		pane.className = "markdown-source-view mod-cm6" + (readable ? " is-readable-line-width" : "");
		pane.style.cssText = "position:relative;margin-left:" + HOST_LEFT + "px;width:" + PANE_W + "px;height:" + PANE_H + "px;overflow:hidden";
		const doc = Array.from({ length: 400 }, (_, i) => i === LONG_LINE ? LONG : "line " + i + " alpha beta gamma delta epsilon zeta").join("\\n");
		const view = new EditorView({ parent: pane, state: EditorState.create({ doc, extensions: [history(), EditorView.lineWrapping,
			editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} })), inkOverlayExtension(),
			EditorView.theme({ "&": { width: PANE_W + "px", height: PANE_H + "px" }, ".cm-scroller": { overflowY: "auto", overflowX: "hidden" }, ".cm-content": { fontFamily: "monospace", fontSize: "16px", lineHeight: "24px" } })] }) });
		const sizer = installSizer(view);
		const title = document.createElement("div"); title.className = "inline-title"; title.setAttribute("contenteditable", "true");
		sizer.insertBefore(title, sizer.firstChild);
		title.textContent = "Amino acids";
		await settle(12);
		const overlay = overlayForPath(path);
		if (!overlay) throw new Error("no overlay for " + path);
		rig = { pane, view, overlay, path };
		const t = textBox(view), x = t.left + 80, y = t.cy;
		const pen = (type, px, py, buttons) => document.elementFromPoint(px, py)?.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "pen", pointerId: 901, isPrimary: true, clientX: px, clientY: py, buttons, pressure: buttons ? 0.5 : 0 }));
		pen("pointerdown", x, y, 1); for (let i = 1; i <= 6; i++) pen("pointermove", x + 30 * i, y, 1); pen("pointerup", x + 180, y, 0);
		await settle(12);
		return { strokes: inlineInk.strokes(path).length, natural: sample("natural"), desktop: !Platform.isMobileApp, column: column() };
	},
	async pinch(to, steps) {
		const { view, overlay } = rig, router = overlay.router, t = textBox(view), from = overlay.pinchScaleNow, cx = t.left + 170 * from, cy = t.cy;
		const spread0 = 300, spread1 = 300 * to / from;
		const touch = s => { router.touchPos.set(911, { x: cx - s / 2, y: cy }); router.touchPos.set(912, { x: cx + s / 2, y: cy }); };
		const ev = type => new PointerEvent(type, { pointerId: 912, pointerType: "touch" });
		const rows = [];
		touch(spread0); router.beginPinch(ev("pointerdown"));
		for (let i = 1; i <= steps; i++) { touch(spread0 + (spread1 - spread0) * i / steps); router.updatePinch(ev("pointermove")); await rendered(); rows.push(sample("move-" + i)); }
		router.endPinch(ev("pointerup"), { x: cx, y: cy }); router.touchPos.clear();
		for (let j = 1; j <= 16; j++) { await rendered(); rows.push(sample("settle-" + j)); }
		return { rows, form: form(), column: column() };
	},
	/** The zoom bar's own commit: one camera commit to the target, no preview. */
	async bar(to) {
		const { overlay } = rig;
		if (!overlay.zoomNoteBy(to / overlay.pinchScaleNow)) throw new Error("zoom bar refused " + to);
		const rows = [];
		for (let j = 1; j <= 16; j++) { await rendered(); rows.push(sample("settle-" + j)); }
		return { rows, form: form(), column: column() };
	},
};
`;

const ODD = 1.8257418870925903;
/** The vendored Minimal 9.0.2, the same file RllColumnFocalHold and MinimalCameraScale load. */
const MINIMAL_CSS = readFileSync(fileURLToPath(new URL("./fixtures/minimal-9.0.2-theme.css", import.meta.url)), "utf8");
const SETTINGS = [
	{ name: "Readable line length on", readable: true, minimal: false },
	{ name: "Readable line length off", readable: false, minimal: false },
	{ name: "Minimal, Readable line length off (Alan's test vault)", readable: false, minimal: true },
];
let script: string;
const browsers = new Map<number, Browser>();
beforeAll(async () => {
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "desktopHostFormPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
}, 180_000);
afterAll(async () => { for (const b of browsers.values()) await b.close(); });

async function pageAt(dsf: number): Promise<Page> {
	let b = browsers.get(dsf);
	if (!b) { b = await chromium.launch({ headless: true, args: [`--force-device-scale-factor=${dsf}`, "--window-size=1900,1000"] }); browsers.set(dsf, b); }
	return (await b.newContext({ viewport: null })).newPage();
}
const call = (p: Page, method: string, ...args: unknown[]) => p.evaluate(([m, a]) => (window as any).desktopHostForm[m](...a), [method, args] as const);

type Row = { phase: string; k: number; contentTop: number; textCy: number };
type Column = { wrappedLines: number | null; contentWidth: number; scrollerClient: number; insetLocal: number; sizerMargin: string; autoLeft: string; marginVar: string };
type Arm = { name: string; to: number; how: "pinch" | "bar"; steps?: number; form: "zoom" | "transform" };
const ARMS: Arm[] = [
	{ name: "pinch in to 1.79, 30 frames", to: 1.79, how: "pinch", steps: 30, form: "transform" },
	{ name: "pinch in to 1.79, one step", to: 1.79, how: "pinch", steps: 1, form: "transform" },
	{ name: "zoom bar to 1.79", to: 1.79, how: "bar", form: "transform" },
	{ name: "pinch in to 3, 30 frames", to: 3, how: "pinch", steps: 30, form: "transform" },
	{ name: "pinch out to 0.5, 30 frames", to: 0.5, how: "pinch", steps: 30, form: "zoom" },
];
const TEXT_BAR = 0.06;

for (const dsf of [2, ODD]) for (const { name: setting, readable, minimal } of SETTINGS) it(`ratio ${dsf}, ${setting}: above 1 the transform form however the zoom was reached, at 0.5 the zoom form; text on its line and the column unchanged above 1`, async () => {
	const results: { arm: Arm; form: string; frameText: number; settledText: number; column: Column; errors: string[] }[] = [];
	for (const arm of ARMS) {
		const page = await pageAt(dsf);
		const errors: string[] = [];
		page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
		try {
			await page.setContent('<!doctype html><body class="theme-dark" style="margin:0"></body>');
			await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS + INLINE_TITLE_CSS });
			if (minimal) await page.addStyleTag({ content: MINIMAL_CSS });
			await page.addScriptTag({ content: script });
			const m = await call(page, "mount", readable) as { strokes: number; natural: Row; desktop: boolean };
			expect(m.desktop, "the rig is still the mobile app").toBe(true);
			expect(m.strokes, "the stroke committed").toBe(1);
			const r = await call(page, arm.how, arm.to, ...(arm.steps ? [arm.steps] : [])) as { rows: Row[]; form: { name: string }; column: Column };
			const t1 = m.natural.textCy - m.natural.contentTop;
			const text = (row: Row) => (row.textCy - row.contentTop) / row.k - t1;
			const frames = r.rows.filter(row => row.phase.startsWith("move-"));
			const last = r.rows.at(-1)!;
			expect(last.k, `${arm.name}: the zoom reached`).toBeCloseTo(arm.to, 6);
			results.push({ arm, form: r.form.name, frameText: frames.length ? Math.max(...frames.map(row => Math.abs(text(row)))) : 0, settledText: text(last), column: r.column, errors });
		} finally {
			await page.context().close();
		}
	}
	for (const x of results) {
		// eslint-disable-next-line no-console
		console.log(`DESKTOP HOST FORM [real flag ${dsf}] ${setting}: ${x.arm.name}: form ${x.form}; text term worst frame ${x.frameText.toFixed(3)}, settled ${x.settledText.toFixed(3)} note px; column ${JSON.stringify(x.column)}`);
	}
	for (const x of results) {
		expect(x.errors, `${x.arm.name}: page errors`).toEqual([]);
		expect(x.form, `${x.arm.name}: the host form`).toBe(x.arm.form);
		if (x.arm.form === "transform") {
			expect(x.frameText, `${x.arm.name}: the text moved against its line on a frame`).toBeLessThanOrEqual(TEXT_BAR);
			expect(Math.abs(x.settledText), `${x.arm.name}: the text moved against its line, settled`).toBeLessThanOrEqual(TEXT_BAR);
		}
	}
	// The centring the box write asked for matches the scroller the host form actually gives: under the transform form
	// the scrollbar is local px scaled with the note, under the zoom form it keeps its screen size (the scrollbar term,
	// appliedColumnMargin and the box write). Readable line length on only: off, the line is not centred. Above 1 only,
	// where this commit moved the form: the zoom form's term below 1 is unchanged and reads 1 px off at 0.5 on a
	// 1.8257 display (an integer clientWidth inside a fractional zoom), printed above.
	if (readable && !minimal) for (const x of results.filter(r => r.arm.to > 1)) {
		const auto = Number.parseFloat(x.column.autoLeft), half = (x.column.scrollerClient - x.column.contentWidth) / 2;
		if (half > 0) expect(Math.abs(auto - half), `${x.arm.name}: the auto term ${auto} against half the scroller's spare width ${half}`).toBeLessThanOrEqual(0.5);
	}
	// The column at 1.79 is the same however 1.79 was reached: wrapped lines, content width, inset.
	const ref = results[0]!.column;
	for (const x of results.slice(1, 3)) {
		expect(x.column.wrappedLines, `${x.arm.name}: the long line wraps differently`).toBe(ref.wrappedLines);
		expect(x.column.contentWidth, `${x.arm.name}: content width`).toBe(ref.contentWidth);
		const margin = (c: Column) => Number.parseFloat(c.sizerMargin);
		expect(Math.abs(margin(x.column) - margin(ref)), `${x.arm.name}: column margin ${x.column.sizerMargin} against ${ref.sizerMargin}`).toBeLessThanOrEqual(0.5);
	}
}, 240_000);
