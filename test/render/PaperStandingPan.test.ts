/**
 * CANVAS OFF, THE PINCH DOES NOTHING. RETIRED FROM THE FITTING-PAGE STANDING-PAN CLAIM.
 *
 * This file used to read the paper through a pan standing at rest after a zoom-out settle on a page that fits the
 * pane (readable line length on and off, the fit-clamp readout). That claim's own regime - reaching a fitting page by
 * a pinch with the canvas off - no longer exists: a later ruling restores the canvas-off pinch gate, so a pinch with the
 * canvas off is refused outright (no preview, scale stays 1, the bar reads busy) and never reaches a settle to stand
 * a pan against. The old arms (RLL on at 75 percent, RLL off at 100 percent) are gone with their subject, not
 * rewritten; the paper-follows-a-live-pan guarantee for a canvas-ON gesture lives in PaperPinchPan and
 * PaperTitleRewrap.
 *
 * The page is ZoomOutStandingPan's (the pane, the pen stroke, the router's pinch), with grid paper, canvas off
 * (unchanged: this rig was never canvas-on). One pin instead of the retired arms: canvas off, a pinch, nothing
 * moves, scale stays 1, the bar reads busy.
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

/**
 * ZoomOutStandingPan's own page, copied verbatim, plus: the paper's body
 * class (set at page.setContent below, not here), and on sample() alone -
 * the geometry a paper-rule read needs that it does not already carry.
 * textLeft/textRight/textCy, panX/panY, rangeX/rangeY, sizerTransform, k and
 * fitReadout are already there.
 */
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
/** After the frame has rendered: its layout, its observer deliveries and its paint have run. */
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
const lineEl = view => view.contentDOM.querySelectorAll(".cm-line")[TEXT_LINE];
const textBox = view => { const range = document.createRange(); range.selectNodeContents(lineEl(view)); const r = range.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, cy: (r.top + r.bottom) / 2 }; };
const MAGENTA = p => p[3] > 200 && p[0] > 200 && p[1] < 60 && p[2] > 200;

/** The committed canvas's magenta pixels, mapped through the canvas's client rect. */
function backingInk() {
	const cc = rig.overlay.committedCanvas, w = cc.width, h = cc.height;
	if (!(w > 0 && h > 0)) return null;
	const d = cc.getContext("2d").getImageData(0, 0, w, h).data;
	let minY = Infinity, maxY = -1, minX = Infinity, maxX = -1, n = 0;
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; if (MAGENTA([d[i], d[i + 1], d[i + 2], d[i + 3]])) { n++; if (y < minY) minY = y; if (y > maxY) maxY = y; if (x < minX) minX = x; if (x > maxX) maxX = x; } }
	if (!n) return { n };
	const r = cc.getBoundingClientRect();
	return { n, cy: r.top + ((minY + maxY + 1) / 2) * r.height / h,
		left: r.left + minX * r.width / w, right: r.left + (maxX + 1) * r.width / w };
}

const r2 = v => Math.round(v * 100) / 100;

function sample(phase) {
	const { view, overlay, pane } = rig, t = textBox(view), ink = backingInk(), k = overlay.pinchScaleNow;
	const s = view.scrollDOM, pr = pane.getBoundingClientRect(), sr = s.getBoundingClientRect(), cr = view.contentDOM.getBoundingClientRect();
	const pan = overlay.viewportPan || { x: 0, y: 0 };
	return { phase, k, preview: !!overlay.pinchPreview, busy: overlay.getNoteViewportState().busy,
		panX: r2(pan.x), panY: r2(pan.y), rasterPanX: r2(overlay.rasterPan ? overlay.rasterPan.x : 0), rasterPanY: r2(overlay.rasterPan ? overlay.rasterPan.y : 0),
		// The scroller's remaining range on each axis: the regime this claim is about.
		rangeX: r2(s.scrollWidth - s.clientWidth), rangeY: r2(s.scrollHeight - s.clientHeight), scrollLeft: r2(s.scrollLeft), scrollTop: r2(s.scrollTop),
		paneLeft: r2(pr.left), paneRight: r2(pr.right), textLeft: r2(t.left), textRight: r2(t.right), textCy: r2(t.cy),
		// The rule bounds the CONTENT's box against the viewport: the scroller is the viewport, .cm-content is the page.
		viewLeft: r2(sr.left), viewRight: r2(sr.right), contentLeft: r2(cr.left), contentRight: r2(cr.right),
		// The overlay's own fit quantity when the build exposes it (the fix's helper), so the cell can cross-check the regime it asserts.
		fitReadout: typeof overlay.panFitReadout === "function" ? overlay.panFitReadout() : null,
		sizerTransform: rig.sizer.style.transform || "",
		inkN: ink ? ink.n : 0, inkLeft: ink && ink.n ? r2(ink.left) : null, inkRight: ink && ink.n ? r2(ink.right) : null,
		dyNote: ink && ink.n ? (ink.cy - t.cy) / k : null };
}

window.standingPan = {
	async mount(readable, tag) {
		setPenInk(true); setScrollExpansionEnabled(false);
		setInlineTool("pen"); setInkColorHex("pen", "#ff00ff"); setInkSizeMult("pen", 4);
		const path = "standing-pan-" + readable + "-" + (tag || "gesture") + ".md";
		const pane = document.body.appendChild(document.createElement("div"));
		pane.className = "markdown-source-view mod-cm6" + (readable ? " is-readable-line-width" : "");
		pane.style.cssText = "position:relative;margin-left:" + HOST_LEFT + "px;width:" + PANE_W + "px;height:" + PANE_H + "px;overflow:hidden";
		const doc = Array.from({ length: 400 }, (_, i) => "line " + i + " alpha beta gamma delta epsilon zeta").join("\\n");
		const view = new EditorView({ parent: pane, state: EditorState.create({ doc, extensions: [history(), EditorView.lineWrapping,
			editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} })), inkOverlayExtension(),
			EditorView.theme({ "&": { width: PANE_W + "px", height: PANE_H + "px" }, ".cm-scroller": { overflowY: "auto", overflowX: "hidden" }, ".cm-content": { fontFamily: "monospace", fontSize: "16px", lineHeight: "24px" } })] }) });
		const sizer = installSizer(view);
		await settle(12);
		const overlay = overlayForPath(path);
		if (!overlay) throw new Error("no overlay for " + path);
		rig = { pane, view, overlay, sizer, path };
		const t = textBox(view), x = t.left + 80, y = t.cy;
		const pen = (type, px, py, buttons) => document.elementFromPoint(px, py)?.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "pen", pointerId: 901, isPrimary: true, clientX: px, clientY: py, buttons, pressure: buttons ? 0.5 : 0 }));
		pen("pointerdown", x, y, 1); for (let i = 1; i <= 6; i++) pen("pointermove", x + 30 * i, y, 1); pen("pointerup", x + 180, y, 0);
		await settle(12);
		return { strokes: inlineInk.strokes(path).length, natural: sample("natural"), inkMiddleX: textBox(view).left + 170, pane: pane.getBoundingClientRect().toJSON() };
	},
	/** The router's two-finger pinch about an EXPLICIT client point, spread 300 -> 300 x to over steps frames, then settle. */
	async pinch(to, steps, cx, cy, tag) {
		const { overlay } = rig, router = overlay.router, from = overlay.pinchScaleNow;
		const spread0 = 300, spread1 = 300 * to / from;
		const touch = s => { router.touchPos.set(911, { x: cx - s / 2, y: cy }); router.touchPos.set(912, { x: cx + s / 2, y: cy }); };
		const ev = type => new PointerEvent(type, { pointerId: 912, pointerType: "touch" });
		const rows = [sample(tag + "-before")];
		touch(spread0); router.beginPinch(ev("pointerdown"));
		for (let i = 1; i <= steps; i++) { touch(spread0 + (spread1 - spread0) * i / steps); router.updatePinch(ev("pointermove")); await rendered(); rows.push(sample(tag + "-move-" + i)); }
		router.endPinch(ev("pointerup"), { x: cx, y: cy }); router.touchPos.clear();
		for (let j = 1; j <= 16; j++) { await rendered(); rows.push(sample(tag + "-settle-" + j)); }
		return rows;
	},
	sample,
	/** After a wait in real time, not frames: a deferred repaint runs on a timer. */
	async later(ms, phase) { await new Promise(r => setTimeout(r, ms));
		for (let i = 0; i < 90 && rig.overlay.overscrollBounceReadout && rig.overlay.overscrollBounceReadout().active; i++) await frame();
		await settle(4); return sample(phase); },
	/** The half-second overscroll glide, waited out: this file reads the pan at rest, never on its way there. */
	async atRest() { for (let i = 0; i < 90 && rig.overlay.overscrollBounceReadout && rig.overlay.overscrollBounceReadout().active; i++) await frame(); await settle(2); return sample("at-rest"); },
};
`;

let browser: Browser, script: string;
const DSF = 2;

beforeAll(async () => {
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "paperStandingPanPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
	// The DSF flag alongside --window-size, as PaperPinchPan launches: without either the screenshots come back at 1x.
	browser = await chromium.launch({ headless: true, args: [`--force-device-scale-factor=${DSF}`, "--window-size=1800,900"] });
}, 180_000);
afterAll(async () => { await browser?.close(); });

const call = (p: Page, method: string, ...args: unknown[]) => p.evaluate(([m, a]) => (window as any).standingPan[m](...a), [method, args] as const);

/**
 * THE PIN: canvas off, a pinch, nothing moves. Same page, same mount (canvas off is this
 * rig's own default, unchanged), one gesture asking for 200 percent about the ink.
 */
it("CANVAS OFF: a two-finger pinch is not a zoom - no preview, the scale stays at 100 percent, the bar reads busy", async () => {
	const page = await browser.newPage({ viewport: { width: 1800, height: 900 }, deviceScaleFactor: DSF, hasTouch: true });
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	try {
		await page.setContent('<!doctype html><body class="handwriting-paper-grid" style="margin:0; background:#ffffff; --background-modifier-border:#777777"></body>');
		await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
		await page.addScriptTag({ content: script });
		const mounted = await call(page, "mount", false, "pin") as any;
		expect(mounted.strokes, "the stroke committed").toBe(1);
		expect(mounted.natural.k, "premise: 100 percent").toBe(1);
		expect(mounted.natural.busy, "premise: the bar reads busy with the canvas off").toBe(true);

		const centre = mounted.inkMiddleX as number, cy = (mounted.natural as any).textCy as number;
		const rows = await call(page, "pinch", 2, 30, centre, cy, "pin") as any[];
		expect(rows.some(r => r.preview), `a preview started with the canvas off: ${JSON.stringify(rows.map(r => r.k))}`).toBe(false);
		for (const r of rows) expect(r.k, `the scale moved with the canvas off: ${JSON.stringify(rows.map(x => x.k))}`).toBe(1);

		const after = await call(page, "sample", "after") as any;
		expect(after.k, "the scale moved after the pinch with the canvas off").toBe(1);
		expect(after.busy, "the bar does not read busy with the canvas off").toBe(true);
		expect(errors).toEqual([]);
	} finally { await page.close(); }
}, 180_000);
