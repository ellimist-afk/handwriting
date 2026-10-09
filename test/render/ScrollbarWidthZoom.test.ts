/**
 * THE SCROLLBAR KEEPS ITS 100 PERCENT WIDTH AT EVERY NOTE ZOOM (Alan, 2026-10-02: "it looks kinda thick zoomed in";
 * then "yes, do the 15 minute fix"). On desktop Obsidian paints the scroller's bar from
 * `body.styled-scrollbars ::-webkit-scrollbar { width: var(--scrollbar-width) }` (12 px, every platform but macOS),
 * and the note's host scales it with the note: measured 26.8 CSS px at 1.79 and 45 at 3 under the transform form.
 *
 * The rig: the WrappedTitlePinch-style mount, desktop app, real --force-device-scale-factor flag at ratio 2 and
 * 1.8257, Obsidian's own scrollbar rules (copied below from app.css 1.13.7) under the default theme and under Minimal
 * 9.0.2. Per zoom (0.5 by pinch, 1, 1.79 and 3 by the zoom bar) the painted width of the vertical bar, in screen
 * CSS px: the scroller's rect width less its client width at the rect's own scale, less the border. It must be within
 * 1 px of the reading at 100 percent. Everything is printed.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

/** Obsidian 1.13.7 app.css: the styled-scrollbars rules as shipped; the size variables are its values, the colours stand-ins. */
const OBSIDIAN_SCROLLBAR_CSS = `
body { --scrollbar-width: 12px; --scrollbar-height: 12px; --scrollbar-border-width: 3px 3px 3px 2px; --scrollbar-radius: 12px;
  --scrollbar-bg: transparent; --scrollbar-thumb-bg: rgba(255,255,255,0.1); --scrollbar-active-thumb-bg: rgba(255,255,255,0.2); --scrollbar-native-width: auto; }
* { scrollbar-width: var(--scrollbar-native-width); }
body:not(.styled-scrollbars) { scrollbar-color: var(--scrollbar-thumb-bg) var(--scrollbar-bg); }
body.styled-scrollbars ::-webkit-scrollbar { background-color: var(--scrollbar-bg); width: var(--scrollbar-width); height: var(--scrollbar-height);
  -webkit-border-radius: var(--scrollbar-radius); background-color: transparent; }
body.styled-scrollbars ::-webkit-scrollbar-track { background-color: transparent; }
body.styled-scrollbars ::-webkit-scrollbar-thumb { background-color: var(--scrollbar-thumb-bg); -webkit-border-radius: var(--scrollbar-radius);
  background-clip: padding-box; border: 2px solid transparent; border-width: var(--scrollbar-border-width); min-height: 45px; }
body.styled-scrollbars ::-webkit-scrollbar-corner { background: transparent; }
`;

const PAGE = `
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { Platform } from "obsidian";
import { inlineInk, inkOverlayExtension, overlayForPath, setScrollExpansionEnabled, setInlineTool } from "../../src/inline/InkOverlay";
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
const PANE_W = 1397.5, PANE_H = 800, HOST_LEFT = 300;
let rig = null;

function installSizer(view) {
	const sizer = document.createElement("div"); sizer.className = "cm-sizer";
	const container = document.createElement("div"); container.className = "cm-contentContainer";
	view.contentDOM.parentElement.insertBefore(sizer, view.contentDOM); sizer.appendChild(container); container.appendChild(view.contentDOM);
	void view.scrollDOM.clientWidth; return sizer;
}
/**
 * The vertical bar as painted, screen CSS px, from fractional rects: the scroller's border box less a probe pinned to
 * its client box (absolute, left 0 right 0), less the borders at the rect's own scale. offsetWidth - clientWidth is
 * whole local px and read the bar up to half a local px wrong (12.53 for 11.76 at 1.79 on ratio 1.8257).
 */
function bar() {
	const sc = rig.view.scrollDOM, r = sc.getBoundingClientRect(), s = getComputedStyle(sc);
	const scale = r.width / sc.offsetWidth;
	const border = (Number.parseFloat(s.borderLeftWidth) || 0) + (Number.parseFloat(s.borderRightWidth) || 0);
	if (s.position === "static") sc.style.position = "relative";
	const probe = sc.appendChild(document.createElement("div"));
	probe.style.cssText = "position:absolute;left:0;right:0;top:0;height:1px;pointer-events:none";
	const inner = probe.getBoundingClientRect().width;
	probe.remove();
	const host = rig.view.dom;
	// The centring term the box write put on the host against half the scroller's spare client width, host-local px.
	const autoLeft = Number.parseFloat(host.style.getPropertyValue("--handwriting-column-auto-left"));
	const half = (inner / scale - rig.view.contentDOM.offsetWidth) / 2;
	return { k: rig.overlay.pinchScaleNow, painted: r.width - inner - border * scale, local: sc.offsetWidth - sc.clientWidth - border, scale, autoLeft, half,
		form: host.style.transform.includes("scale(") ? "transform" : "zoom", unscale: host.style.getPropertyValue("--handwriting-scrollbar-unscale") };
}

window.scrollbarWidthZoom = {
	async mount() {
		setPenInk(true); setScrollExpansionEnabled(true); setInlineTool("pen");
		document.body.classList.add("styled-scrollbars");
		const path = "scrollbar-width-zoom.md";
		const pane = document.body.appendChild(document.createElement("div"));
		pane.className = "markdown-source-view mod-cm6 is-readable-line-width";
		pane.style.cssText = "position:relative;margin-left:" + HOST_LEFT + "px;width:" + PANE_W + "px;height:" + PANE_H + "px;overflow:hidden";
		const doc = Array.from({ length: 400 }, (_, i) => "line " + i + " alpha beta gamma delta epsilon zeta").join("\\n");
		const view = new EditorView({ parent: pane, state: EditorState.create({ doc, extensions: [history(), EditorView.lineWrapping,
			editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} })), inkOverlayExtension(),
			EditorView.theme({ "&": { width: PANE_W + "px", height: PANE_H + "px" }, ".cm-scroller": { overflowY: "auto", overflowX: "hidden" }, ".cm-content": { fontFamily: "monospace", fontSize: "16px", lineHeight: "24px" } })] }) });
		installSizer(view);
		await settle(12);
		const overlay = overlayForPath(path);
		if (!overlay) throw new Error("no overlay for " + path);
		rig = { pane, view, overlay, path };
		// A stroke makes the note a Handwriting page, as on the device.
		const line = view.contentDOM.querySelectorAll(".cm-line")[6], lr = line.getBoundingClientRect(), x = lr.left + 80, y = (lr.top + lr.bottom) / 2;
		const pen = (type, px, py, buttons) => document.elementFromPoint(px, py)?.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "pen", pointerId: 901, isPrimary: true, clientX: px, clientY: py, buttons, pressure: buttons ? 0.5 : 0 }));
		pen("pointerdown", x, y, 1); for (let i = 1; i <= 6; i++) pen("pointermove", x + 30 * i, y, 1); pen("pointerup", x + 180, y, 0);
		await settle(12);
		return { strokes: inlineInk.strokes(path).length, desktop: !Platform.isMobileApp, bar: bar() };
	},
	async pinch(to, steps) {
		const { view, overlay } = rig, router = overlay.router, r = view.contentDOM.getBoundingClientRect(), from = overlay.pinchScaleNow, cx = r.left + 170, cy = r.top + 200;
		const spread0 = 300, spread1 = 300 * to / from;
		const touch = s => { router.touchPos.set(911, { x: cx - s / 2, y: cy }); router.touchPos.set(912, { x: cx + s / 2, y: cy }); };
		const ev = type => new PointerEvent(type, { pointerId: 912, pointerType: "touch" });
		touch(spread0); router.beginPinch(ev("pointerdown"));
		for (let i = 1; i <= steps; i++) { touch(spread0 + (spread1 - spread0) * i / steps); router.updatePinch(ev("pointermove")); await rendered(); }
		router.endPinch(ev("pointerup"), { x: cx, y: cy }); router.touchPos.clear();
		for (let j = 1; j <= 16; j++) await rendered();
		return bar();
	},
	async bar(to) {
		const { overlay } = rig;
		if (Math.abs(to / overlay.pinchScaleNow - 1) > 1e-9 && !overlay.zoomNoteBy(to / overlay.pinchScaleNow)) throw new Error("zoom bar refused " + to);
		for (let j = 1; j <= 16; j++) await rendered();
		return bar();
	},
};
`;

const ODD = 1.8257418870925903;
const MINIMAL_CSS = readFileSync(fileURLToPath(new URL("./fixtures/minimal-9.0.2-theme.css", import.meta.url)), "utf8");
const THEMES = [{ name: "default theme", minimal: false }, { name: "Minimal 9.0.2", minimal: true }];
const ARMS = [
	{ name: "pinch out to 0.5", to: 0.5, how: "pinch" },
	{ name: "zoom bar to 1.79", to: 1.79, how: "bar" },
	{ name: "zoom bar to 3", to: 3, how: "bar" },
] as const;
const WIDTH_BAR = 1;

let script: string;
const browsers = new Map<number, Browser>();
beforeAll(async () => {
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "scrollbarWidthZoomPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
}, 180_000);
afterAll(async () => { for (const b of browsers.values()) await b.close(); });

async function pageAt(dsf: number): Promise<Page> {
	let b = browsers.get(dsf);
	if (!b) { b = await chromium.launch({ headless: true, args: [`--force-device-scale-factor=${dsf}`, "--window-size=1900,1000"] }); browsers.set(dsf, b); }
	return (await b.newContext({ viewport: null })).newPage();
}
const call = (p: Page, method: string, ...args: unknown[]) => p.evaluate(([m, a]) => (window as any).scrollbarWidthZoom[m](...a), [method, args] as const);
type Bar = { k: number; painted: number; local: number; scale: number; autoLeft: number; half: number; form: string; unscale: string };

for (const dsf of [2, ODD]) for (const { name: theme, minimal } of THEMES) it(`ratio ${dsf}, ${theme}: the scroller's bar paints at its 100 percent width at 0.5, 1, 1.79 and 3`, async () => {
	const rows: { name: string; to: number; rest: Bar; at: Bar; errors: string[] }[] = [];
	for (const arm of ARMS) {
		const page = await pageAt(dsf);
		const errors: string[] = [];
		page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
		try {
			await page.setContent('<!doctype html><body class="theme-dark" style="margin:0"></body>');
			await page.addStyleTag({ content: OBSIDIAN_SCROLLBAR_CSS + css + REAL_OBSIDIAN_CSS });
			if (minimal) await page.addStyleTag({ content: MINIMAL_CSS });
			await page.addScriptTag({ content: script });
			const m = await call(page, "mount") as { strokes: number; desktop: boolean; bar: Bar };
			expect(m.desktop, "the rig is still the mobile app").toBe(true);
			expect(m.strokes, "the stroke committed").toBe(1);
			const at = await call(page, arm.how, arm.to, ...(arm.how === "pinch" ? [30] : [])) as Bar;
			expect(at.k, `${arm.name}: the zoom reached`).toBeCloseTo(arm.to, 6);
			rows.push({ name: arm.name, to: arm.to, rest: m.bar, at, errors });
		} finally {
			await page.context().close();
		}
	}
	for (const x of rows) {
		// eslint-disable-next-line no-console
		console.log(`SCROLLBAR WIDTH [real flag ${dsf}] ${theme}: 100 percent ${x.rest.painted.toFixed(2)} (local ${x.rest.local}); ${x.name}: painted ${x.at.painted.toFixed(2)} CSS px, local ${x.at.local}, rect scale ${x.at.scale.toFixed(4)}, form ${x.at.form}, unscale "${x.at.unscale}"; centring term ${x.at.autoLeft.toFixed(2)} against half the spare client width ${x.at.half.toFixed(2)} local px`);
	}
	for (const x of rows) {
		expect(x.errors, `${x.name}: page errors`).toEqual([]);
		expect(x.rest.painted, "the bar exists at 100 percent").toBeGreaterThan(4);
		expect(Math.abs(x.at.painted - x.rest.painted), `${x.name}: painted ${x.at.painted} against ${x.rest.painted} at 100 percent`).toBeLessThanOrEqual(WIDTH_BAR);
		// The column centring subtracts the bar at the width it now paints (scrollbarLocalAt). Default theme only:
		// Minimal centres its own lines, with no centring term. Half a local px above 1, as DesktopHostForm; 1 at 0.5,
		// where the 100 percent bar is read as whole px (measureColumnAuto) and reads 11 for 11.5 on ratio 1.8257.
		if (!minimal && x.at.half > 0) expect(Math.abs(x.at.autoLeft - x.at.half), `${x.name}: centring term ${x.at.autoLeft} against ${x.at.half}`).toBeLessThanOrEqual(x.to > 1 ? 0.5 : 1);
	}
}, 240_000);
