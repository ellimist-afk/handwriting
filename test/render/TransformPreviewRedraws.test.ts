/**
 * HOW MANY TIMES THE LASSO'S RESIZE, ROTATE AND DRAG PREVIEW IS REDRAWN PER SHOWN FRAME, WITH A 240 HZ PEN.
 *
 * What it costs: while a lassoed selection is resized, rotated or dragged, every pen sample redraws the whole selection
 * layer (clear, picture, box, handles, attach chrome). A 240 Hz pen sends a raw sample every 4.17 ms, so a 60 Hz screen
 * would show one of about four redraws and throw the rest away. Measured, not fixed: this file counts.
 *
 * The page is LassoTransformLift.test.ts's (a plain editor, dark, font 26, one magenta stroke drawn by real pen events
 * through the router and selected by a real lasso loop; device scale 2). The gesture: a real pen-down on the handle (or
 * inside the box for the drag), then pen samples the way Chromium delivers a 240 Hz pen while a contact is claimed: a
 * pointerrawupdate every 4.17 ms (the router binds that listener at the claim) and one pointermove per animation frame
 * at the newest place; then the lift. The moves are timed off performance.now in a message-channel loop, so the timer
 * clamp does not stretch them.
 *
 * Read per gesture, over the move window only:
 *  - raw samples sent, animation frames shown, redrawSelectionUI calls, and the redraws in each frame (max, mean, and
 *    how many frames held more than one);
 *  - the selection layer's own timers (spaceTime): sel.clear and sel.box calls and their total and largest ms.
 * Each line is printed as TF-SPEED-S1 and, with HW_TFS_OUT=<file>, written as JSON.
 *
 * Off unless HW_TF_SPEED=1: a measure, not a gate. With HW_TFS_BOUND=1 the cell asserts at most one redraw per shown
 * frame (the fix's bar).
 * Run: HW_TF_SPEED=1 npx vitest run --config vitest.render.mts test/render/TransformPreviewRedraws.test.ts
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { appendFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

declare module "node:fs" { export function appendFileSync(path: string, data: string): void; }
declare const process: { env: Record<string, string | undefined> };

const ENABLED = process.env.HW_TF_SPEED === "1";
const BOUND = process.env.HW_TFS_BOUND === "1";
const OUT = process.env.HW_TFS_OUT ?? "";

const PAGE = `
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { Platform } from "obsidian";
import { inlineInk, inkOverlayExtension, overlayForPath, setInlineTool, setInkSizeMult } from "../../src/inline/InkOverlay";
import { setInkColorHex } from "../../src/ink/InkColor";
import { setPenInk } from "../../src/inline/PenInk";
import { setMouseInk } from "../../src/inline/MouseInk";
import { setTipMode } from "../../src/inline/TipMode";
import { handlePoints } from "../../src/inline/LassoTransform";
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
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await frame(); };
let rig = null;

const ptr = (type, px, py, buttons) => document.elementFromPoint(px, py)?.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true,
	pointerType: "pen", pointerId: 901, isPrimary: true, clientX: px, clientY: py, buttons, button: type === "pointerdown" || type === "pointerup" ? 0 : -1, pressure: buttons ? 0.5 : 0 }));
const toClient = (p) => { const s = rig.overlay.camera.worldToScreen(p.x, p.y); return { x: s.x + rig.off.x, y: s.y + rig.off.y }; };

window.tfSpeed = {
	async mount() {
		setPenInk(true); setMouseInk(true);
		setInlineTool("pen"); setInkColorHex("pen", "#ff00ff"); setInkSizeMult("pen", 4); setTipMode("nib");
		const path = "transform-preview-redraws.md";
		const pane = document.body.appendChild(document.createElement("div"));
		pane.className = "markdown-source-view mod-cm6";
		pane.style.cssText = "position:relative;margin-left:120px;margin-top:60px;width:900px;height:700px;overflow:hidden";
		const text = Array.from({ length: 40 }, (_, i) => "line " + (i + 1) + " words").join("\\n");
		const view = new EditorView({ parent: pane, state: EditorState.create({ doc: text, extensions: [history(), EditorView.lineWrapping,
			editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} })), inkOverlayExtension(),
			EditorView.theme({ "&": { width: "900px", height: "700px" }, ".cm-scroller": { overflowY: "auto" }, ".cm-content": { fontSize: "26px", lineHeight: "39px" } })] }) });
		await settle(12);
		const overlay = overlayForPath(path);
		if (!overlay) throw new Error("no overlay for " + path);
		rig = { pane, view, overlay, path, off: { x: 0, y: 0 } };
		const x0 = 400, y0 = 300, pts = Array.from({ length: 24 }, (_, i) => [x0 + i * 8, y0 + (i % 2 ? 26 : 0)]);
		ptr("pointermove", x0, y0, 0); await frame();
		ptr("pointerdown", x0, y0, 1);
		for (const [x, y] of pts.slice(1)) { ptr("pointermove", x, y, 1); await frame(); }
		ptr("pointerup", pts.at(-1)[0], pts.at(-1)[1], 0);
		await settle(12);
		const st = inlineInk.strokes(path)[0];
		if (!st) throw new Error("no stroke drawn");
		const s = overlay.camera.worldToScreen(st.points[0].x, st.points[0].y);
		rig.off = { x: x0 - s.x, y: y0 - s.y };
		return { strokes: inlineInk.strokes(path).length, dpr: window.devicePixelRatio };
	},
	async select() {
		setTipMode("lasso");
		const cx = 492, cy = 313, R = 150, N = 36;
		ptr("pointermove", cx + R, cy, 0); await frame();
		ptr("pointerdown", cx + R, cy, 1);
		for (let i = 1; i <= N; i++) { ptr("pointermove", cx + R * Math.cos(2 * Math.PI * i / N), cy + R * 0.6 * Math.sin(2 * Math.PI * i / N), 1); await frame(); }
		ptr("pointerup", cx + R, cy, 0);
		await settle(6);
		return rig.overlay.selection.size;
	},
	/** One gesture: grab, o.samples raw samples 4.17 ms apart along (dx, dy), one pointermove per frame, lift. */
	async measure(o) {
		const { overlay } = rig, box = overlay.selectionBounds(), cam = overlay.camera.snapshot;
		const at = o.gesture === "drag" ? toClient({ x: box.x + box.width / 2, y: box.y + box.height / 2 }) : toClient(handlePoints(box, cam.zoom)[o.gesture === "rotate" ? "rotate" : "se"]);
		ptr("pointermove", at.x, at.y, 0);
		await frame();
		ptr("pointerdown", at.x, at.y, 1);
		await frame();
		const snap = overlay.spaceSnapshot;
		const began = o.gesture === "drag" ? !!(snap && snap.kind === "lasso" && !snap.transform) : !!(snap && snap.transform);
		// Counters armed for the move window only.
		let redraws = 0, inFrame = 0;
		const perFrame = [];
		const timers = {};
		const own = overlay.redrawSelectionUI;
		overlay.redrawSelectionUI = function (...a) { redraws++; inFrame++; return own.apply(this, a); };
		overlay.spaceTime = (part, ms) => { const t = timers[part] ??= { n: 0, ms: 0, max: 0 }; t.n++; t.ms += ms; t.max = Math.max(t.max, ms); };
		let ticking = true;
		const tick = () => { if (!ticking) return; perFrame.push(inFrame); inFrame = 0; requestAnimationFrame(tick); };
		requestAnimationFrame(tick);
		const PERIOD = 1000 / 240;
		let sent = 0, moves = 0, last = at;
		const place = (i) => ({ x: at.x + o.dx * i / o.samples, y: at.y + o.dy * i / o.samples });
		// pointermove once per frame, at the newest place, as Chromium aligns it.
		const moveTick = () => { if (!ticking) return; ptr("pointermove", last.x, last.y, 1); moves++; requestAnimationFrame(moveTick); };
		requestAnimationFrame(moveTick);
		const t0 = performance.now();
		await new Promise(done => {
			const ch = new MessageChannel();
			ch.port1.onmessage = () => {
				const now = performance.now();
				while (sent < o.samples && now - t0 >= (sent + 1) * PERIOD) { sent++; last = place(sent); ptr("pointerrawupdate", last.x, last.y, 1); }
				if (sent < o.samples) ch.port2.postMessage(0); else done();
			};
			ch.port2.postMessage(0);
		});
		const window_ms = performance.now() - t0;
		await frame();
		ticking = false;
		overlay.redrawSelectionUI = own;
		overlay.spaceTime = null;
		ptr("pointerup", last.x, last.y, 0);
		await settle(8);
		// The first entry counts the time before the first frame of the window; frames are the callbacks after it.
		const frames = perFrame.slice(1);
		const max = Math.max(0, ...frames), over1 = frames.filter(n => n > 1).length;
		const mean = frames.length ? frames.reduce((s, n) => s + n, 0) / frames.length : 0;
		const r = (x) => Math.round(x * 1000) / 1000;
		const t = {};
		for (const [k, v] of Object.entries(timers)) t[k] = { n: v.n, ms: r(v.ms), max: r(v.max) };
		return { gesture: o.gesture, began, samples: sent, moves, window_ms: r(window_ms), frames: frames.length, redraws, redrawsPerFrame: { max, mean: r(mean), framesOver1: over1 }, perFrame: frames, timers: t };
	},
};
`;

let browser: Browser | null = null;
let script = "";

beforeAll(async () => {
	if (!ENABLED) return;
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "transformPreviewRedrawsPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true, args: ["--force-device-scale-factor=2", "--window-size=1200,900"] });
}, 180_000);
afterAll(async () => {
	if (browser) await browser.close();
});

async function openPage(): Promise<{ page: Page; m: { strokes: number; dpr: number }; errors: string[] }> {
	const page = await (await browser!.newContext({ viewport: null })).newPage();
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	await page.setContent('<!doctype html><body class="theme-dark" style="margin:0"></body>');
	await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
	await page.addScriptTag({ content: script });
	const m = await page.evaluate(() => (window as any).tfSpeed.mount());
	return { page, m, errors };
}
const call = (p: Page, method: string, ...args: unknown[]) => p.evaluate(([n, a]) => (window as any).tfSpeed[n](...a), [method, args] as const) as Promise<any>;

const GESTURES = [
	{ gesture: "resize", dx: 90, dy: 30, samples: 120 },
	{ gesture: "rotate", dx: 70, dy: 40, samples: 120 },
	{ gesture: "drag", dx: 60, dy: 80, samples: 120 },
] as const;

const gated = ENABLED ? it : it.skip;
for (const g of GESTURES) gated(`${g.gesture}: preview redraws per shown frame with a 240 Hz pen`, async () => {
	const { page, m, errors } = await openPage();
	try {
		const selected = await call(page, "select");
		const r = await call(page, "measure", g);
		const { perFrame, ...line } = r;
		// eslint-disable-next-line no-console
		console.log(`TF-SPEED-S1 ${JSON.stringify({ dpr: m.dpr, selected, ...line })} perFrame ${perFrame.join(",")}`);
		expect(errors, "page errors").toEqual([]);
		expect(m.strokes, "premise: one stroke").toBe(1);
		expect(selected, "premise: the lasso selected the stroke").toBe(1);
		expect(r.began, `premise: the grab started the ${g.gesture}`).toBe(true);
		expect(r.samples, "premise: every raw sample was sent").toBe(g.samples);
		expect(r.frames, "premise: frames were shown during the moves").toBeGreaterThan(5);
		// A counter that missed every redraw would read as the fix's bar; zero redraws voids the line.
		expect(r.redraws, "premise: the preview redraws were counted").toBeGreaterThan(0);
		// Written after the premises and before the bound, so every line in the file is one whose premises held, and a bound red keeps its numbers.
		if (OUT) appendFileSync(OUT, JSON.stringify({ dpr: m.dpr, selected, ...r }) + "\n");
		if (BOUND) expect(r.redrawsPerFrame.max, "redraws in one shown frame").toBeLessThanOrEqual(1);
	} finally {
		await page.context().close();
	}
}, 120_000);
