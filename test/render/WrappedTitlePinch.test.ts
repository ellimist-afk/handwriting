/**
 * WRAPPED TITLE, PINCH IN: does the ink move against the text?
 *
 * Alan, 2026-09-14, seen on trunk: on a note whose title wraps to two lines,
 * pinching in pushes all the ink down, and zooming back out moves it back up.
 * This reads that on the 1.4.x line, on the mounted overlay: a real two-line
 * inline title (Obsidian's own `.inline-title` rules, verbatim below) above the
 * text, a stroke drawn across one text line at 100%, then the router's
 * two-finger pinch from 100% to 300% over the ink and back, one frame per step.
 * 300% and not 200%: with readable line length on the column is 700 px, and the
 * pane only drops under that (1397.5 / 2 = 699 layout px) by a pixel at 200%, so
 * the title would not rewrap there and that arm would read nothing.
 *
 * WHAT IS MEASURED, per presented frame and after each settle: the vertical
 * distance from the centre of the painted ink to the centre of the text line it
 * was drawn on, in screen px and divided by the live scale (note px). The ink is
 * read from the committed canvas's own pixels mapped through its client rect
 * (every frame) and from a real screenshot (at 100% and after each settle, scanned
 * only in a band around the text line: the toolbar's colour swatch is magenta too); the
 * text from a Range over that line. A shift that follows the zoom shows as a
 * note-px change against the 100% reading.
 *
 * ARMS: readable line length on and off, each with a two-line title and with a
 * one-line title beside it (the same note without the wrap). A positive control
 * moves the committed canvas down by a known 10 px and must read it back on both
 * readers, so a zero is a measurement rather than a silence.
 *
 * Numbers go to HW_WRAPPED_TITLE_OUT when set.
 *
 * Z15 (the fix): a ResizeObserver on the blocks above the content moves the reused preview raster by each delivered height change. Its
 * delivery comes after the frame's layout and before its paint, so a PRESENTED frame is read after the frame has rendered, never inside
 * the rAF callback (there the title has already rewrapped and the delivery has not run: that reading is not what is painted).
 * The zoom-out goes back to 150 percent, not 100: it crosses the rewraps back to two lines, and whether text and ink are on the pane after
 * a settle at 100 percent is the standing-pan claim, carried by ZoomOutStandingPan.test.ts.
 * Plant: HW_Z15_PLANT_NO_OBSERVER=1 builds the overlay with the observer never observing.
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

declare const process: { env: Record<string, string | undefined> };

/** Obsidian 1.13.7 app.css, verbatim: :2321 (--h1-line-height), :2327 (--h1-size), :2002 (--h1-weight), :2383-2390 (--inline-title-*), :4420-4432 (.inline-title). */
const INLINE_TITLE_CSS = `
body { --h1-line-height: 1.2; --h1-size: 1.618em; --h1-weight: 700; --h1-font: inherit; --h1-style: normal; --h1-variant: normal; --h1-color: inherit;
  --inline-title-color: var(--h1-color); --inline-title-font: var(--h1-font); --inline-title-line-height: var(--h1-line-height);
  --inline-title-size: var(--h1-size); --inline-title-style: var(--h1-style); --inline-title-variant: var(--h1-variant);
  --inline-title-weight: var(--h1-weight); --inline-title-margin-bottom: 0.5em; }
.inline-title { color: var(--inline-title-color); white-space: pre-wrap; margin-block-end: var(--inline-title-margin-bottom); }
.inline-title:not([data-level]) { font-size: var(--inline-title-size); font-weight: var(--inline-title-weight); line-height: var(--inline-title-line-height);
  font-style: var(--inline-title-style); font-variant: var(--inline-title-variant); font-family: var(--inline-title-font); letter-spacing: -0.015em; }
`;

/** The page: the same mount as scrollColumnAnchorPage (pane offset 300 px, monospace 16/24, Obsidian's sizer), plus the title, the stroke and the readers. */
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
const PANE_W = 1397.5, PANE_H = 800, HOST_LEFT = 300, TEXT_LINE = 6;
let rig = null;

function installSizer(view) {
	const sizer = document.createElement("div"); sizer.className = "cm-sizer";
	const container = document.createElement("div"); container.className = "cm-contentContainer";
	view.contentDOM.parentElement.insertBefore(sizer, view.contentDOM); sizer.appendChild(container); container.appendChild(view.contentDOM);
	void view.scrollDOM.clientWidth; return sizer;
}
const words = "Handwriting notes on the lecture about amino acids and the structure of proteins in living cells across several weeks of the semester".split(" ");
const titleLines = title => { const range = document.createRange(); range.selectNodeContents(title); return new Set(Array.from(range.getClientRects()).filter(r => r.width > 0).map(r => Math.round(r.top))).size; };
const lineEl = view => view.contentDOM.querySelectorAll(".cm-line")[TEXT_LINE];
const textBox = view => { const range = document.createRange(); range.selectNodeContents(lineEl(view)); const r = range.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, cy: (r.top + r.bottom) / 2 }; };
const MAGENTA = p => p[3] > 200 && p[0] > 200 && p[1] < 60 && p[2] > 200;

/** The committed canvas's magenta pixels, mapped through the canvas's client rect (every frame). */
function backingInk(extraTranslateY = 0) {
	const cc = rig.overlay.committedCanvas, w = cc.width, h = cc.height;
	if (!(w > 0 && h > 0)) return null;
	const d = cc.getContext("2d").getImageData(0, 0, w, h).data;
	let minY = Infinity, maxY = -1, minX = Infinity, maxX = -1, n = 0;
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; if (MAGENTA([d[i], d[i + 1], d[i + 2], d[i + 3]])) { n++; if (y < minY) minY = y; if (y > maxY) maxY = y; if (x < minX) minX = x; if (x > maxX) maxX = x; } }
	if (!n) return { n };
	const r = cc.getBoundingClientRect();
	return { n, cy: r.top + ((minY + maxY + 1) / 2) * r.height / h, cx: r.left + ((minX + maxX + 1) / 2) * r.width / w, rect: [r.left, r.top, r.width, r.height], backing: [w, h] };
}

function sample(phase) {
	const { view, overlay, title } = rig, t = textBox(view), ink = backingInk(), k = overlay.pinchScaleNow;
	return { phase, k, preview: !!overlay.pinchPreview, titleLines: title ? titleLines(title) : 0, titleHeight: title ? title.getBoundingClientRect().height : 0, titleWidth: title ? title.getBoundingClientRect().width : 0, sizerWidth: title && title.parentElement ? title.parentElement.getBoundingClientRect().width : 0, strokes: inlineInk.strokes(rig.path).length,
		contentTop: view.contentDOM.getBoundingClientRect().top, scrollTop: view.scrollDOM.scrollTop, scrollLeft: view.scrollDOM.scrollLeft,
		textCy: t.cy, textTop: t.top, inkCy: ink && ink.n ? ink.cy : null, inkN: ink ? ink.n : 0,
		dyScreen: ink && ink.n ? ink.cy - t.cy : null, dyNote: ink && ink.n ? (ink.cy - t.cy) / k : null,
		shifts: overlay.aboveContentShifts ?? 0 };
}

window.wrappedTitle = {
	async mount(readable, twoLine) {
		// Alan, 2026-09-20: the pinch zoom exists only under the Infinite Canvas now, so a
		// rig that pinches mounts with the canvas ON. The canvas-on settle laws apply here: the
		// page stays where the fingers left it, no centring and no fit window.
		setPenInk(true); setScrollExpansionEnabled(true);
		setInlineTool("pen"); setInkColorHex("pen", "#ff00ff"); setInkSizeMult("pen", 4);
		const path = "wrapped-title-" + readable + "-" + twoLine + ".md";
		const pane = document.body.appendChild(document.createElement("div"));
		pane.className = "markdown-source-view mod-cm6" + (readable ? " is-readable-line-width" : "");
		pane.style.cssText = "position:relative;margin-left:" + HOST_LEFT + "px;width:" + PANE_W + "px;height:" + PANE_H + "px;overflow:hidden";
		const doc = Array.from({ length: 400 }, (_, i) => "line " + i + " alpha beta gamma delta epsilon zeta").join("\\n");
		const view = new EditorView({ parent: pane, state: EditorState.create({ doc, extensions: [history(), EditorView.lineWrapping,
			editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} })), inkOverlayExtension(),
			EditorView.theme({ "&": { width: PANE_W + "px", height: PANE_H + "px" }, ".cm-scroller": { overflowY: "auto", overflowX: "hidden" }, ".cm-content": { fontFamily: "monospace", fontSize: "16px", lineHeight: "24px" } })] }) });
		const sizer = installSizer(view);
		const title = document.createElement("div"); title.className = "inline-title"; title.setAttribute("contenteditable", "true");
		sizer.insertBefore(title, sizer.firstChild);
		// Grow the title word by word to exactly two lines at 100% (one line for the control), on the pane as mounted.
		let count = 0; title.textContent = "";
		if (twoLine) { while (count < words.length * 4 && titleLines(title) < 2) { title.textContent = (title.textContent ? title.textContent + " " : "") + words[count % words.length]; count++; } }
		else title.textContent = "Amino acids";
		await settle(12);
		const overlay = overlayForPath(path);
		if (!overlay) throw new Error("no overlay for " + path);
		rig = { pane, view, overlay, title, path };
		const t = textBox(view), x = t.left + 80, y = t.cy;
		const pen = (type, px, py, buttons) => document.elementFromPoint(px, py)?.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "pen", pointerId: 901, isPrimary: true, clientX: px, clientY: py, buttons, pressure: buttons ? 0.5 : 0 }));
		pen("pointerdown", x, y, 1); for (let i = 1; i <= 6; i++) pen("pointermove", x + 30 * i, y, 1); pen("pointerup", x + 180, y, 0);
		await settle(12);
		return { titleText: title.textContent, titleLines: titleLines(title), strokes: inlineInk.strokes(path).length, natural: sample("natural"), pane: pane.getBoundingClientRect().toJSON() };
	},
	/** Known 10 px down on the committed canvas; both readers must see it. Removed before returning. */
	async plant(on) { rig.overlay.committedCanvas.style.translate = on ? "0 10px" : ""; await settle(2); return sample(on ? "plant-on" : "plant-off"); },
	/**
	 * The router's two-finger pinch, centred on the ink, spread 300 -> 300 x to over steps frames, then settle. The centre is the stroke's
	 * middle, 170 note px from the text line's left, scaled by the live scale: at 300 percent a fixed 170 client px would sit 340 note px
	 * left of the ink, and the gesture back out would carry the text line and the ink off the pane's left edge.
	 */
	async pinch(to, steps, tag) {
		const { view, overlay } = rig, router = overlay.router, t = textBox(view), from = overlay.pinchScaleNow, cx = t.left + 170 * from, cy = t.cy;
		const spread0 = 300, spread1 = 300 * to / from;
		const touch = s => { router.touchPos.set(911, { x: cx - s / 2, y: cy }); router.touchPos.set(912, { x: cx + s / 2, y: cy }); };
		const ev = type => new PointerEvent(type, { pointerId: 912, pointerType: "touch" });
		const rows = [sample(tag + "-before")];
		touch(spread0); router.beginPinch(ev("pointerdown"));
		for (let i = 1; i <= steps; i++) { touch(spread0 + (spread1 - spread0) * i / steps); router.updatePinch(ev("pointermove")); await rendered(); rows.push(sample(tag + "-move-" + i)); }
		router.endPinch(ev("pointerup"), { x: cx, y: cy }); router.touchPos.clear(); rows.push(sample(tag + "-lift"));
		for (let j = 1; j <= 16; j++) { await rendered(); rows.push(sample(tag + "-settle-" + j)); }
		return rows;
	},
	sample,
	/** After a wait in real time, not frames: the deferred repaint runs on a timer. */
	async later(ms, phase) { await new Promise(r => setTimeout(r, ms)); await settle(4); return sample(phase); },
	/** Screenshot pixels (PNG as base64 from the test), magenta centre in client px, inside the pane and within 120 px of the text line; whole counts magenta anywhere in the pane. */
	async screenInk(b64) {
		const img = await createImageBitmap(await (await fetch("data:image/png;base64," + b64)).blob());
		const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const g = c.getContext("2d"); g.drawImage(img, 0, 0);
		const d = g.getImageData(0, 0, c.width, c.height).data; let minY = Infinity, maxY = -1, n = 0;
		const dpr = c.width / window.innerWidth, t = textBox(rig.view), k = rig.overlay.pinchScaleNow, pr = rig.pane.getBoundingClientRect();
		const y0 = Math.max(0, Math.floor((t.cy - 120) * dpr)), y1 = Math.min(c.height, Math.ceil((t.cy + 120) * dpr)), x0 = Math.max(0, Math.floor(pr.left * dpr)), x1 = Math.min(c.width, Math.ceil(pr.right * dpr));
		for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * c.width + x) * 4; if (MAGENTA([d[i], d[i + 1], d[i + 2], d[i + 3]])) { n++; if (y < minY) minY = y; if (y > maxY) maxY = y; } }
		let whole = 0; for (let y = Math.max(0, Math.floor(pr.top * dpr)); y < Math.min(c.height, Math.ceil(pr.bottom * dpr)); y++) for (let x = x0; x < x1; x++) { const i = (y * c.width + x) * 4; if (MAGENTA([d[i], d[i + 1], d[i + 2], d[i + 3]])) whole++; }
		if (!n) return { n, k, dpr, whole };
		const cy = (minY + maxY + 1) / 2 / dpr;
		return { n, k, dpr, whole, inkCy: cy, textCy: t.cy, dyScreen: cy - t.cy, dyNote: (cy - t.cy) / k };
	},
};
`;

let browser: Browser, script: string;
const DPR = 2;
const record: unknown[] = [];

beforeAll(async () => {
	let planted = 0;
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "wrappedTitlePinchPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
		plugins: process.env.HW_Z15_PLANT_NO_OBSERVER ? [{ name: "z15-no-observer", setup(builder) {
			builder.onLoad({ filter: /src[\\/]inline[\\/]InkOverlay\.ts$/ }, args => {
				const from = "for (const block of blocks) observer.observe(block);";
				const text = readFileSync(args.path, "utf8");
				if (text.split(from).length !== 2) throw new Error("z15 plant: anchor not found once");
				planted++;
				return { loader: "ts", contents: text.replace(from, "void blocks;") };
			});
		} }] : [] });
	if (process.env.HW_Z15_PLANT_NO_OBSERVER && !planted) throw new Error("z15 plant requested but never applied");
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);
afterAll(async () => {
	await browser?.close();
	if (process.env.HW_WRAPPED_TITLE_OUT) writeFileSync(process.env.HW_WRAPPED_TITLE_OUT, JSON.stringify(record, null, 1));
});

const call = (p: Page, method: string, ...args: unknown[]) => p.evaluate(([m, a]) => (window as any).wrappedTitle[m](...a), [method, args] as const);
async function screen(p: Page) {
	const b64 = (await p.screenshot({ type: "png" })).toString("base64");
	return call(p, "screenInk", b64);
}

/**
 * NOTE PX, the ink against its own text line relative to the 100 percent reading. Measured on the fixed tree (Z1, after render): at most
 * 0.052 on every frame and after each settle, in every cell, the same value the unfixed tree shows where nothing rewraps (a sub-pixel
 * residual present before Z15, named Z16-minor). One title line is 25.2 note px. The bar sits above the residual and two hundred times
 * under a line.
 */
const SHIFT_BAR_NOTE_PX = 1 / 8;
/**
 * The screenshot reader's own resolution: it finds the ink's centre from device rows, in half-row steps, so its note-px quantum is
 * 0.5 / DPR / k (0.167 at 150 percent, 0.083 at 300). Its bar is one device px in note px, never finer than the committed-canvas bar.
 */
const screenBar = (k: number) => Math.max(SHIFT_BAR_NOTE_PX, 1 / (DPR * k));

for (const readable of [true, false]) for (const twoLine of [true, false]) {
	it(`wrapped title pinch: the ink stays on its text line through the title's rewraps: RLL=${readable} title=${twoLine ? "two lines" : "one line"}`, async () => {
		const page = await browser.newPage({ viewport: { width: 1800, height: 900 }, deviceScaleFactor: DPR, hasTouch: true });
		const errors: string[] = [];
		page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
		try {
			await page.setContent('<!doctype html><body style="margin:0"></body>');
			await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS + INLINE_TITLE_CSS });
			await page.addScriptTag({ content: script });
			const mounted = await call(page, "mount", readable, twoLine) as any;
			expect(mounted.strokes, "the stroke committed").toBe(1);
			expect(mounted.titleLines, "the title wraps as set up").toBe(twoLine ? 2 : 1);
			const natural = { dom: mounted.natural, screen: await screen(page) as any };
			// Positive control on both readers.
			const plantOn = { dom: await call(page, "plant", true) as any, screen: await screen(page) as any };
			await call(page, "plant", false);
			const zoomIn = await call(page, "pinch", 3, 30, "in") as any[];
			const inSettled = { dom: zoomIn.at(-1), screen: await screen(page) as any };
			const zoomOut = await call(page, "pinch", 1.5, 30, "out") as any[];
			const outSettled = { dom: zoomOut.at(-1), screen: await screen(page) as any };
			const cell = { readable, twoLine, titleText: mounted.titleText, pane: mounted.pane, natural, plantOn, zoomIn, inSettled, zoomOut, outSettled, errors };
			record.push(cell);

			const base = natural.dom.dyNote as number, baseScreen = natural.screen.dyNote as number;
			const shift = (r: any) => r.dyNote == null ? null : Math.round((r.dyNote - base) * 1000) / 1000;
			const presented = (rows: any[]) => rows.filter(r => !r.phase.endsWith("-lift"));
			const transitions = (rows: any[]) => rows.slice(1).filter((r, i) => r.titleLines !== rows[i].titleLines).length;
			const linesIn = [...new Set(zoomIn.map(r => r.titleLines))], linesOut = [...new Set(zoomOut.map(r => r.titleLines))];
			const shiftsIn = zoomIn.at(-1).shifts - zoomIn[0].shifts, shiftsOut = zoomOut.at(-1).shifts - zoomOut[0].shifts;
			// eslint-disable-next-line no-console
			console.log("WRAPPEDTITLE " + JSON.stringify({ readable, twoLine, base, baseScreen, linesIn, linesOut, transitionsIn: transitions(zoomIn), transitionsOut: transitions(zoomOut), shiftsIn, shiftsOut,
				maxFrameShiftIn: Math.max(...presented(zoomIn).map(r => Math.abs(shift(r) ?? 0))), maxFrameShiftOut: Math.max(...presented(zoomOut).map(r => Math.abs(shift(r) ?? 0))),
				inSettledShiftDom: shift(inSettled.dom), inSettledShiftScreen: Math.round((inSettled.screen.dyNote - baseScreen) * 1000) / 1000,
				outSettledShiftDom: shift(outSettled.dom), outSettledScreenN: outSettled.screen.n, outSettledShiftScreen: outSettled.screen.n ? Math.round((outSettled.screen.dyNote - baseScreen) * 1000) / 1000 : null }));

			expect(errors).toEqual([]);
			// The instrument is live on both readers: a known 10 px move reads back.
			expect(plantOn.dom.dyScreen - natural.dom.dyScreen).toBeCloseTo(10, 0);
			expect(plantOn.screen.dyScreen - natural.screen.dyScreen).toBeCloseTo(10, 0);
			expect(inSettled.dom.k, "the pinch reached 300%").toBeCloseTo(3, 6);
			expect(outSettled.dom.k, "the pinch came back to 150%").toBeCloseTo(1.5, 6);
			// THE REGIME, read rather than assumed. Readable line length off, two-line title: the narrowing host rewraps the title on the way
			// in and back on the way out. Every other cell is a control where nothing rewraps (measured: with it on, the 700 px column keeps a
			// two-line title at two lines all the way to 300 percent).
			if (!readable && twoLine) {
				expect(transitions(zoomIn), `the title rewrapped on the way in: ${linesIn}`).toBeGreaterThan(0);
				expect(transitions(zoomOut), `the title rewrapped back on the way out: ${linesOut}`).toBeGreaterThan(0);
			} else {
				expect(transitions(zoomIn) + transitions(zoomOut), `no rewrap in a control cell: ${linesIn} / ${linesOut}`).toBe(0);
			}
			// THE CLAIM: the ink against its text line, in note px, on every presented frame and after each settle, on both readers.
			for (const r of presented(zoomIn)) expect(r.dyNote, `${r.phase}: ink read`).not.toBeNull();
			for (const r of presented(zoomOut)) expect(r.dyNote, `${r.phase}: ink read`).not.toBeNull();
			for (const r of presented(zoomIn)) expect.soft(Math.abs(shift(r)!), `${r.phase} (k ${r.k}, title lines ${r.titleLines})`).toBeLessThan(SHIFT_BAR_NOTE_PX);
			for (const r of presented(zoomOut)) expect.soft(Math.abs(shift(r)!), `${r.phase} (k ${r.k}, title lines ${r.titleLines})`).toBeLessThan(SHIFT_BAR_NOTE_PX);
			expect(Math.abs(inSettled.dom.dyNote - base), "settled at 300%, committed-canvas reader").toBeLessThan(SHIFT_BAR_NOTE_PX);
			expect(Math.abs(inSettled.screen.dyNote - baseScreen), "settled at 300%, screenshot reader").toBeLessThanOrEqual(screenBar(3));
			expect(Math.abs(outSettled.dom.dyNote - base), "settled at 150%, committed-canvas reader").toBeLessThan(SHIFT_BAR_NOTE_PX);
			expect(outSettled.screen.n, "the screenshot reader found the ink at 150%").toBeGreaterThan(0);
			expect(Math.abs(outSettled.screen.dyNote - baseScreen), "settled at 150%, screenshot reader").toBeLessThanOrEqual(screenBar(1.5));
			// After the claim, so a tree without the correction reports the shift itself before this count.
			// The observer applied one shift per rewrap, never one per frame: each gesture's count equals the rewraps in it.
			expect(shiftsIn, `shifts on the way in against ${transitions(zoomIn)} rewraps`).toBe(transitions(zoomIn));
			expect(shiftsOut, `shifts on the way out against ${transitions(zoomOut)} rewraps`).toBe(transitions(zoomOut));
		} finally { await page.close(); }
	}, 180_000);
}
