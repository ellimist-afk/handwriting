/**
 * A GIVE BACK AT ZERO BEFORE THE LIFT leaves the preview paper up (releaseOverscrollGive returns early on x === y === 0).
 *
 * Infinite Canvas on, page at its top-left. A finger pulls the page past its origin edge (holdOverscrollGive puts the
 * preview paper up), the give then returns to exactly zero, and the finger lifts. The paper must be down after the lift,
 * as it is for a pull released while still held out.
 *
 * Drives:
 *   "direct"   the router's two callbacks in order: pull (0, 40), pull (0, 0), release.
 *   "fast:y" / "fast:x"  the router's own pointer handlers: pull 60 px past the top (left), come back, then drag the
 *              other way 600 (400) px per frame. The scroller's far end refuses a step before Infinite Canvas grows the
 *              room, the router's pull flips to -96, holdOverscrollGive clamps the give to exactly 0 (origin side only),
 *              and the lift calls releaseOverscrollGive with a non-zero router pull and a zero give.
 *   "normal:y" / "normal:x"  control: pull 60 px and lift while held out; the paper must ride the spring and come down
 *              at bounce-end.
 *
 * Run:   npx vitest run --config vitest.render.mts test/render/OverscrollGiveZeroLift.test.ts
 * Plant: HW_ZERO_LIFT_PLANT=1, with the fix applied, removes the fix again: the zero-lift cells go red.
 */
import { beforeAll, afterAll, it, expect, describe } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

declare const process: { env: Record<string, string | undefined> };

const PAGE = `
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { inlineInk, inkOverlayExtension, overlayForPath, setScrollExpansionEnabled, setInlineTool } from "../../src/inline/InkOverlay";
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
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await frame(); };
let rig = null;

const state = () => {
	const { view, overlay } = rig, router = overlay.router, b = overlay.overscrollBounceReadout(), sd = view.scrollDOM;
	return { paper: overlay.previewPaperReadout(), inDom: !!view.dom.querySelector(":scope > .handwriting-paper-preview"),
		previewing: sd.classList.contains("handwriting-paper-previewing"), bounce: b.active, fling: router.flingRaf !== 0,
		offsetX: b.x, offsetY: b.y, pullX: router.overscrollPullX, pullY: router.overscrollPullY, scrollLeft: sd.scrollLeft, scrollTop: sd.scrollTop };
};

window.zl = {
	async mount(paper) {
		setPenInk(false); setScrollExpansionEnabled(true); setInlineTool("pen");
		document.body.classList.add("handwriting-paper-" + paper);
		const path = "zero-lift-" + paper + ".md";
		const pane = document.body.appendChild(document.createElement("div"));
		pane.className = "markdown-source-view mod-cm6";
		pane.style.cssText = "position:relative;margin-left:100px;width:900px;height:600px;overflow:hidden";
		const doc = Array.from({ length: 10 }, (_, i) => "line " + i + " alpha beta gamma").join("\\n");
		const view = new EditorView({ parent: pane, state: EditorState.create({ doc, extensions: [history(), EditorView.lineWrapping,
			editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} })), inkOverlayExtension(),
			EditorView.theme({ "&": { width: "900px", height: "600px" }, ".cm-scroller": { overflowY: "auto", overflowX: "hidden" }, ".cm-content": { fontFamily: "monospace", fontSize: "16px", lineHeight: "24px" } })] }) });
		await settle(12);
		const overlay = overlayForPath(path);
		if (!overlay) throw new Error("no overlay for " + path);
		rig = { pane, view, overlay };
		view.scrollDOM.scrollTop = 0; view.scrollDOM.scrollLeft = 0;
		await settle(8);
		// The assist gate re-arms a second after the last lift, on a real timer.
		await new Promise(res => setTimeout(res, 1200));
		await settle(4);
		const r = view.scrollDOM.getBoundingClientRect();
		return { allowance: overlay.router.cb.overscrollAllowancePx(), pane: { x: r.left, y: r.top, w: r.width, h: r.height } };
	},
	async drive(kind) {
		const { view, overlay } = rig, router = overlay.router, sd = view.scrollDOM;
		const trail = [];
		if (kind === "direct") {
			router.cb.onOverscrollPull(0, 40); await settle(2); trail.push(["held", state()]);
			router.cb.onOverscrollPull(0, 0); await settle(2); trail.push(["zero", state()]);
			router.cb.onOverscrollRelease(); trail.push(["lift", state()]);
		} else {
			const [mode, axis] = kind.split(":");
			const r = sd.getBoundingClientRect(), x0 = r.left + 200, y0 = r.top + 40;
			const at = d => axis === "x" ? [x0 + d, y0] : [x0, y0 + d];
			const ev = (type, d, buttons) => { const [px, py] = at(d); return { type, pointerType: "touch", pointerId: 941, isPrimary: true, clientX: px, clientY: py,
				pressure: buttons ? 0.5 : 0, buttons, button: 0, timeStamp: performance.now(), tiltX: 0, tiltY: 0, width: 0, height: 0,
				target: sd, preventDefault() {}, stopPropagation() {} }; };
			const finger = (type, d, buttons) => { const e = ev(type, d, buttons);
				if (type === "pointerdown") router.pointerDown(e); else if (type === "pointermove") router.pointerMove(e); else router.pointerUpOrCancel(e); };
			finger("pointerdown", 0, 1);
			for (let i = 1; i <= 6; i++) { finger("pointermove", 10 * i, 1); await frame(); }
			trail.push(["held", state()]);
			let end = 60;
			if (mode === "fast") {
				for (let i = 5; i >= 0; i--) { finger("pointermove", 10 * i, 1); await frame(); }
				const step = axis === "x" ? 400 : 600, far = axis === "x" ? -1200 : -1800;
				for (let d = -step; d >= far; d -= step) { finger("pointermove", d, 1); await frame(); }
				end = far;
				trail.push(["zero", state()]);
			}
			finger("pointerup", end, 0);
			trail.push(["lift", state()]);
		}
		for (let j = 0; j < 240; j++) { await frame(); const s = state(); if (!s.bounce && !s.fling) break; }
		await settle(6);
		trail.push(["rest", state()]);
		return trail;
	},
	state,
	/** Hide or show the preview element: the screenshot pair that says whether the paper on screen is that element. */
	hidePreview(on) { let s = document.getElementById("zl-hide"); if (!s) { s = document.head.appendChild(document.createElement("style")); s.id = "zl-hide"; }
		s.textContent = on ? ".handwriting-paper-preview{visibility:hidden !important}" : ""; },
	focusEditor() { rig.view.focus(); rig.view.dispatch({ selection: { anchor: 0 } }); },
	async setScroll(left, top) { rig.view.scrollDOM.scrollLeft = left; rig.view.scrollDOM.scrollTop = top; await settle(6); return state(); },
	/** Take a stuck paper down the one way the product does, for a same-scroll reference frame. */
	async endPaper() { rig.overlay.endPreviewPaper("bounce-end"); await settle(4); return state(); },
};
`;

let browser: Browser, script: string;
const FIX = "\t\tif (x === 0 && y === 0) {\n\t\t\tif (!this.bounceState && !this.pinchPreview) this.endPreviewPaper(\"bounce-end\");\n\t\t\treturn;\n\t\t}\n";
const PLANT = { from: FIX, to: "\t\tif (x === 0 && y === 0) return;\n" };

beforeAll(async () => {
	const plant = !!process.env.HW_ZERO_LIFT_PLANT;
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "zeroLiftPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
		plugins: plant ? [{ name: "zero-lift-plant", setup(builder) {
			builder.onLoad({ filter: /src[\\/]inline[\\/]InkOverlay\.ts$/ }, args => {
				const text = readFileSync(args.path, "utf8").replace(/\r\n/g, "\n");
				if (text.split(PLANT.from).length !== 2) throw new Error("HW_ZERO_LIFT_PLANT: fix anchor not found once (is the fix applied?)");
				return { loader: "ts", contents: text.replace(PLANT.from, PLANT.to) };
			});
		} }] : [] });
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);
afterAll(async () => { await browser?.close(); });

const call = (p: Page, m: string, ...a: unknown[]) => p.evaluate(([m, a]) => (window as any).zl[m](...a), [m, a] as const);
async function open(paper: string, dpr: number) {
	const page = await browser.newPage({ viewport: { width: 1100, height: 700 }, deviceScaleFactor: dpr, hasTouch: true });
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	await page.setContent('<!doctype html><body style="margin:0; background:#ffffff; --background-modifier-border:#777777"></body>');
	await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
	await page.addScriptTag({ content: script });
	const mounted = await call(page, "mount", paper) as any;
	return { page, errors, mounted };
}
const show = (v: unknown) => JSON.stringify(v);
type Png = Awaited<ReturnType<Page["screenshot"]>>;
/** Screenshot pixels that differ (sum of RGB deltas > 24) between two PNGs of the same clip. */
async function diffPixels(page: Page, a: Png, b: Png): Promise<number> {
	return page.evaluate(async ([a, b]) => {
		const load = async (s: string) => { const img = new Image(); img.src = "data:image/png;base64," + s; await img.decode();
			const c = new OffscreenCanvas(img.width, img.height), x = c.getContext("2d")!; x.drawImage(img, 0, 0); return x.getImageData(0, 0, img.width, img.height).data; };
		const da = await load(a), db = await load(b);
		if (da.length !== db.length) return -1;
		let n = 0; for (let i = 0; i < da.length; i += 4) if (Math.abs(da[i]! - db[i]!) + Math.abs(da[i + 1]! - db[i + 1]!) + Math.abs(da[i + 2]! - db[i + 2]!) > 24) n++;
		return n;
	}, [a.toString("base64"), b.toString("base64")] as const);
}
const clipOf = (m: any) => ({ x: m.pane.x, y: m.pane.y, width: m.pane.w - 20, height: m.pane.h });

for (const paper of ["lines", "grid", "dots"]) for (const dpr of [1, 2]) describe(`${paper} paper, dpr ${dpr}`, () => {
	for (const kind of ["direct", "fast:y", "fast:x"]) it(`${kind}: pulled past the origin edge, give back to exactly 0, lift - the preview paper comes down`, async () => {
		const { page, errors, mounted } = await open(paper, dpr);
		try {
			expect(mounted.allowance, "premise: Infinite Canvas on, so the origin edge gives").toBeGreaterThan(0);
			const trail = await call(page, "drive", kind) as [string, any][];
			const at = (l: string) => trail.find(t => t[0] === l)![1];
			expect(at("held").paper.present, `premise: the held pull put the preview paper up ${show(trail)}`).toBe(true);
			expect(Math.abs(at("held").offsetX) + Math.abs(at("held").offsetY), `premise: the page was held out ${show(trail)}`).toBeGreaterThan(0);
			expect([at("zero").offsetX, at("zero").offsetY], `premise: the give is back at exactly zero before the lift ${show(trail)}`).toEqual([0, 0]);
			const rest = at("rest");
			// SCREENSHOT PAIR: the pane as the user sees it, and the same with any preview element hidden. While the stuck
			// element is up the scroller's own paper is off, so hiding the element takes the ruling off the screen.
			const seen = await page.screenshot({ clip: clipOf(mounted) });
			await call(page, "hidePreview", true);
			const hidden = await page.screenshot({ clip: clipOf(mounted) });
			await call(page, "hidePreview", false);
			const fromPreview = await diffPixels(page, seen, hidden);
			expect(errors).toEqual([]);
			expect(rest.paper.present, `preview paper still up after the lift, readout ${show(rest.paper)}; trail ${show(trail)}`).toBe(false);
			expect(rest.previewing, "the scroller is still in previewing mode (its own paper off)").toBe(false);
			expect(fromPreview, `screen pixels painted by a preview element after the lift: ${fromPreview}`).toBe(0);
		} finally { await page.close(); }
	});

	for (const kind of ["normal:y", "normal:x"]) it(`${kind}: pull and lift while held out - the paper rides the spring and comes down at bounce-end`, async () => {
		const { page, errors, mounted } = await open(paper, dpr);
		try {
			expect(mounted.allowance).toBeGreaterThan(0);
			const trail = await call(page, "drive", kind) as [string, any][];
			const held = trail.find(t => t[0] === "held")![1], rest = trail.at(-1)![1];
			expect(held.paper.present, `premise: paper up while held ${show(trail)}`).toBe(true);
			expect(Math.abs(held.offsetX) + Math.abs(held.offsetY)).toBeGreaterThan(0);
			expect(rest.paper.present, `the paper came down ${show(trail)}`).toBe(false);
			expect(rest.paper.ended, show(trail)).toBe("bounce-end");
			expect([rest.offsetX, rest.offsetY]).toEqual([0, 0]);
			const seen = await page.screenshot({ clip: clipOf(mounted) });
			await call(page, "hidePreview", true);
			const hidden = await page.screenshot({ clip: clipOf(mounted) });
			expect(await diffPixels(page, seen, hidden), "preview pixels after the spring").toBe(0);
			expect(errors).toEqual([]);
		} finally { await page.close(); }
	});
});

/** The vertical shift (device px, -8..8) that best lines up column x (fraction of width) of b onto a. */
async function colShift(page: Page, a: Png, b: Png, xFrac = 0.6): Promise<number> {
	return page.evaluate(async ([a, b, xf]) => {
		const col = async (s: string) => { const img = new Image(); img.src = "data:image/png;base64," + s; await img.decode();
			const c = new OffscreenCanvas(img.width, img.height), g = c.getContext("2d")!; g.drawImage(img, 0, 0);
			const d = g.getImageData(Math.round(img.width * (xf as number)), 0, 1, img.height).data, out: number[] = [];
			for (let y = 0; y < img.height; y++) out.push(d[y * 4]! + d[y * 4 + 1]! + d[y * 4 + 2]!); return out; };
		const ca = await col(a as string), cb = await col(b as string);
		let best = 0, bestCost = Infinity;
		for (let s = -8; s <= 8; s++) { let cost = 0; for (let y = 8; y < ca.length - 8; y++) cost += Math.abs((ca[y] ?? 0) - (cb[y + s] ?? 0)); if (cost < bestCost) { bestCost = cost; best = s; } }
		return best;
	}, [a.toString("base64"), b.toString("base64"), xFrac] as const);
}

/**
 * (3) THE STUCK PAPER UNDER A SCROLL. The paper is left up ("fast:y"), then the note is scrolled by the keyboard
 * (PageUp x3, ArrowDown) and by a scrollbar-equivalent scrollLeft/scrollTop write. Each frame is compared with the same
 * scroll after the paper is taken down (the scroller's own paper). FROZEN: a ruling that did not follow the scroll lines
 * up with the reference at a different vertical shift at each scroll position. PIXELS: what is on screen differs at all.
 */
for (const paper of ["lines", "grid", "dots"]) for (const dpr of [1, 2]) it(`${paper} dpr ${dpr}: scroll with the paper left up - ruling not frozen, and pixel-identical to the scroller's own paper`, async () => {
	const { page, errors, mounted } = await open(paper, dpr);
	try {
		await call(page, "drive", "fast:y");
		const lift = await call(page, "state") as any, stuck = lift.paper.present;
		const liftShot = await page.screenshot({ clip: clipOf(mounted) });
		await call(page, "focusEditor");
		for (const k of ["PageUp", "PageUp", "PageUp", "ArrowDown"]) await page.keyboard.press(k);
		for (let i = 0; i < 10; i++) await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));
		const keys = await call(page, "state") as any;
		const keysShot = await page.screenshot({ clip: clipOf(mounted) });
		const bar = await call(page, "setScroll", keys.scrollLeft + 13, keys.scrollTop + 37) as any;
		const barShot = await page.screenshot({ clip: clipOf(mounted) });
		await call(page, "endPaper");
		await call(page, "setScroll", lift.scrollLeft, lift.scrollTop);
		const refLift = await page.screenshot({ clip: clipOf(mounted) });
		await call(page, "setScroll", bar.scrollLeft, bar.scrollTop);
		const refBar = await page.screenshot({ clip: clipOf(mounted) });
		await call(page, "setScroll", keys.scrollLeft, keys.scrollTop);
		const refKeys = await page.screenshot({ clip: clipOf(mounted) });
		expect(errors).toEqual([]);
		expect(keys.scrollTop, "premise: the keyboard moved the note").not.toBe(lift.scrollTop);
		const where = `stuck=${stuck} lift at ${lift.scrollLeft},${lift.scrollTop} keys at ${keys.scrollLeft},${keys.scrollTop} bar at ${bar.scrollLeft},${bar.scrollTop}`;
		const shifts = [await colShift(page, liftShot, refLift), await colShift(page, keysShot, refKeys), await colShift(page, barShot, refBar)];
		expect(new Set(shifts).size, `FROZEN: ruling-vs-reference shift (device px) at lift / keyboard / scrollbar ${show(shifts)} (${where})`).toBe(1);
		const dKeys = await diffPixels(page, keysShot, refKeys), dBar = await diffPixels(page, barShot, refBar);
		expect([dKeys, dBar], `PIXELS: differing from the scroller's own paper at the same scroll, keyboard / scrollbar; ruling shift ${show(shifts)} device px (${where})`).toEqual([0, 0]);
	} finally { await page.close(); }
});
