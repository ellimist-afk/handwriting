/**
 * WHAT GRABBING A LASSO HANDLE DRAWS, AGAINST WHAT GRABBING THE SELECTION TO DRAG IT DRAWS, ON A NOTE TALLER THAN THE PANE.
 *
 * A resize or rotate grab makes the gesture's picture: every selected stroke drawn into one canvas covering the whole
 * selection box, the off-screen strokes too, and that picture is made again whenever the camera, the backing or the tail's
 * size changes. A drag grab draws only the rows the pane shows and draws more rows as the drag reaches them. Measured, not
 * fixed: this file counts.
 *
 * The page is TransformPreviewRedraws.test.ts's (a plain editor, dark, font 26, device scale 2), with the note's ink loaded
 * from a sidecar: STROKES strokes of 12 points in a grid down 120 lines of text, most of them below the pane. All are
 * selected. The gesture: a real pen-down on the ne handle (resize), on the rotate knob, or inside the box near its top
 * (drag), a frame, then MOVES pen moves one per frame, then the lift.
 *
 * Read per gesture: the picture canvas's size, and on that canvas, for the grab frame and for the move window apart, the
 * whole clears (a picture made) and the fill calls (each stroke drawn is at least one); whole repaints of the note; strokes
 * on the note and on screen; in the move window, the shown frames, the redraws' attach chrome reads (the sel.bounds part,
 * once per redraw) and the free list's calls, holds and builds. A second cell runs the resize with 40 strokes attached to
 * the text in groups of four. Each line is printed as GRAB-RASTER and, with HW_GRAB_OUT=<file>, written as JSON.
 *
 * Off unless HW_GRAB_RASTER=1. With HW_GRAB_BOUND=1 a resize or rotate grab must draw no more fills than the drag grab
 * (the picture culled to what the pane shows, as the drag does), no gesture makes its picture again during moves that
 * leave the camera alone, and the attach chrome is read at most once per shown frame.
 * With HW_GRAB_TIME=1 as well, a timing arm: five resize grabs, each on a fresh page, the grab
 * frame's time read as the pen-down handler's own time plus the selection box drawn after it (picture included) up to the
 * next frame; the five and their median printed as GRAB-TIME and written to HW_GRAB_OUT. No bar: the number is evidence.
 * Run: HW_GRAB_RASTER=1 npx vitest run --config vitest.render.mts test/render/TransformGrabRaster.test.ts
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

const ENABLED = process.env.HW_GRAB_RASTER === "1";
const BOUND = process.env.HW_GRAB_BOUND === "1";
const OUT = process.env.HW_GRAB_OUT ?? "";
const STROKES = 600;
const MOVES = 20;

const PAGE = `
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { Platform } from "obsidian";
import { inlineInk, inkOverlayExtension, overlayForPath, setInlineTool } from "../../src/inline/InkOverlay";
import { setPenInk } from "../../src/inline/PenInk";
import { setMouseInk } from "../../src/inline/MouseInk";
import { setTipMode } from "../../src/inline/TipMode";
import { handlePoints } from "../../src/inline/LassoTransform";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField } from "./iphoneObsidianStub";
import { emptyPage, parsePage, serializePage } from "../../src/model/PageData";
import { computeBBox } from "../../src/ink/Stroke";

Object.assign(Platform, { isMobile: false, isDesktop: true, isIosApp: false, isDesktopApp: true, isMobileApp: false, isPhone: false, isWin: true });
installObsidianDom();
const ids = new Map(), sidecars = new Map();
const save = (id, page) => { sidecars.set(id, serializePage(page)); };
inlineInk.attachHost({ readPageId: p => ids.get(p) ?? null, claimId: async (p, id) => { ids.set(p, id); return { pageId: id }; },
	loadSidecar: async id => (sidecars.has(id) ? parsePage(sidecars.get(id), id) : null), scheduleSidecar: save, scheduleSidecarNow: async (id, p) => save(id, p), notify: () => {} });

const frame = () => new Promise(r => requestAnimationFrame(() => r()));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await frame(); };
let rig = null;

// Per canvas: whole clears (clearRect from 0, 0 over the canvas) and fill calls.
const byCanvas = new Map();
const tally = (c) => { let t = byCanvas.get(c); if (!t) byCanvas.set(c, t = { clears: 0, fills: 0 }); return t; };
const P = CanvasRenderingContext2D.prototype, clearRect = P.clearRect, fill = P.fill;
P.clearRect = function (x, y, w, h) { if (x === 0 && y === 0 && w >= this.canvas.width && h >= this.canvas.height) tally(this.canvas).clears++; return clearRect.call(this, x, y, w, h); };
P.fill = function (...a) { tally(this.canvas).fills++; return fill.apply(this, a); };
const read = (c) => ({ ...(byCanvas.get(c) ?? { clears: 0, fills: 0 }) });

const ptr = (type, px, py, buttons) => document.elementFromPoint(px, py)?.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true,
	pointerType: "pen", pointerId: 902, isPrimary: true, clientX: px, clientY: py, buttons, button: type === "pointerdown" || type === "pointerup" ? 0 : -1, pressure: buttons ? 0.5 : 0 }));

window.grabRaster = {
	async mount(n) {
		setPenInk(true); setMouseInk(true); setInlineTool("pen"); setTipMode("lasso");
		const path = "transform-grab-raster.md", pageId = "transform-grab-raster-page";
		const page = emptyPage(pageId);
		page.surface = "inline";
		page.strokes = Array.from({ length: n }, (_, i) => {
			const x = 120 + (i % 20) * 30, y = 120 + Math.floor(i / 20) * 120;
			const points = Array.from({ length: 12 }, (_, k) => ({ x: x + k * 2, y: y + (k % 3) * 3, pressure: 0.5, t: k * 8 }));
			return { id: "g" + i, tool: "pen", color: "#ff00ff", width: 3, points, bbox: computeBBox(points, 3), createdAt: 1 };
		});
		ids.set(path, pageId); sidecars.set(pageId, serializePage(page));
		const pane = document.body.appendChild(document.createElement("div"));
		pane.className = "markdown-source-view mod-cm6";
		pane.style.cssText = "position:relative;margin-left:120px;margin-top:60px;width:900px;height:700px;overflow:hidden";
		const text = Array.from({ length: 120 }, (_, i) => "line " + (i + 1) + " words").join("\\n");
		const view = new EditorView({ parent: pane, state: EditorState.create({ doc: text, extensions: [history(), EditorView.lineWrapping,
			editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} })), inkOverlayExtension(),
			EditorView.theme({ "&": { width: "900px", height: "700px" }, ".cm-scroller": { overflowY: "auto" }, ".cm-content": { fontSize: "26px", lineHeight: "39px" } })] }) });
		await settle(12);
		const overlay = overlayForPath(path);
		if (!overlay) throw new Error("no overlay for " + path);
		for (let i = 0; i < 60 && inlineInk.strokes(path).length < n; i++) await frame();
		await settle(6);
		const r = overlay.container.getBoundingClientRect();
		rig = { pane, view, overlay, path, off: { x: r.left, y: r.top } };
		return { strokes: inlineInk.strokes(path).length, dpr: window.devicePixelRatio };
	},
	select() {
		const { overlay, path } = rig;
		overlay.selection.selectExactly(inlineInk.strokes(path).map(s => s.id));
		overlay.redrawSelectionUI();
		return overlay.selection.size;
	},
	async measure(gesture) {
		const { overlay, path } = rig, box = overlay.selectionBounds(), cam = overlay.camera.snapshot;
		const toClient = (p) => { const s = overlay.camera.worldToScreen(p.x, p.y); return { x: s.x + rig.off.x, y: s.y + rig.off.y }; };
		const h = handlePoints(box, cam.zoom, overlay.cssScale);
		const at = gesture === "drag" ? toClient({ x: box.x + 40, y: box.y + 20 }) : toClient(h[gesture === "rotate" ? "rotate" : "ne"]);
		const onScreen = inlineInk.strokes(path).filter(s => { const a = toClient({ x: s.bbox.x, y: s.bbox.y }); return a.y >= rig.off.y && a.y < rig.off.y + 700; }).length;
		ptr("pointermove", at.x, at.y, 0);
		await frame();
		const paints0 = overlay.wholePaints ?? 0;
		// The grab frame's time: the pen-down's own handler, and the selection box drawn (picture included) after it, to the frame.
		let dispatched = false, boxAfter = 0;
		overlay.spaceTime = (part, ms) => { if (dispatched && part === "sel.box") boxAfter += ms ?? 0; };
		const tg = performance.now();
		ptr("pointerdown", at.x, at.y, 1);
		const dispatchMs = performance.now() - tg;
		dispatched = true;
		await frame();
		overlay.spaceTime = null;
		const grabTime = { dispatchMs, boxAfterMs: boxAfter, ms: dispatchMs + boxAfter };
		const snap = overlay.spaceSnapshot, pic = snap?.canvas ?? null;
		const began = gesture === "drag" ? !!(snap && snap.kind === "lasso" && !snap.transform) : !!(snap && snap.transform);
		const grab = read(pic), paintsGrab = (overlay.wholePaints ?? 0) - paints0;
		const size = pic ? { w: pic.width, h: pic.height, px: pic.width * pic.height } : null;
		// The move window: redraws (sel.bounds runs once in each, around the attach chrome) and the free list's calls and holds.
		const timers = {}, fc = overlay.lineAnchors?.freeCounts ?? overlay.lineAnchorState?.freeCounts ?? null, fc0 = fc ? { ...fc } : null;
		overlay.spaceTime = (part) => { timers[part] = (timers[part] ?? 0) + 1; };
		let last = at, frames = 0;
		for (let i = 1; i <= ${MOVES}; i++) { last = { x: at.x + (gesture === "drag" ? i * 2 : i * 1.5), y: at.y + i }; ptr("pointermove", last.x, last.y, 1); await frame(); frames++; }
		overlay.spaceTime = null;
		const after = read(snap?.canvas ?? null);
		const moves = { clears: after.clears - grab.clears, fills: after.fills - grab.fills, frames, bounds: timers["sel.bounds"] ?? 0,
			freeCalls: fc ? fc.calls - fc0.calls : null, freeHeld: fc ? fc.held - fc0.held : null, freeBuilds: fc ? fc.builds - fc0.builds : null };
		ptr("pointerup", last.x, last.y, 0);
		await settle(8);
		return { gesture, began, strokes: inlineInk.strokes(path).length, attached: inlineInk.attachments(path).length, onScreen, picture: size, grab, grabTime, moves, wholePaintsGrab: paintsGrab };
	},
	/** Attach the first k strokes on screen to the text, in groups of 4, so the note carries attached groups. */
	async attach(k) {
		const { overlay, path } = rig;
		const list = inlineInk.strokes(path).slice(0, k);
		for (let i = 0; i < list.length; i += 4) {
			overlay.selection.selectExactly(list.slice(i, i + 4).map(s => s.id));
			overlay.redrawSelectionUI();
			const before = inlineInk.attachments(path).length;
			overlay.attachSelected();
			for (let j = 0; j < 60 && inlineInk.attachments(path).length === before; j++) await frame();
		}
		await settle(6);
		return inlineInk.attachments(path).length;
	},
};
`;

let browser: Browser | null = null;
let script = "";

beforeAll(async () => {
	if (!ENABLED) return;
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "transformGrabRasterPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true, args: ["--force-device-scale-factor=2", "--window-size=1200,900"] });
}, 180_000);
afterAll(async () => {
	if (browser) await browser.close();
});

const call = (p: Page, method: string, ...args: unknown[]) => p.evaluate(([n, a]) => (window as any).grabRaster[n](...a), [method, args] as const) as Promise<any>;

async function run(gesture: string, attach = 0) {
	const page = await (await browser!.newContext({ viewport: null })).newPage();
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	try {
		await page.setContent('<!doctype html><body class="theme-dark" style="margin:0"></body>');
		await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
		await page.addScriptTag({ content: script });
		const m = await call(page, "mount", STROKES);
		const groups = attach ? await call(page, "attach", attach) : 0;
		const selected = await call(page, "select");
		const r = await call(page, "measure", gesture);
		const line = { dpr: m.dpr, selected, groups, ...r };
		// eslint-disable-next-line no-console
		console.log(`GRAB-RASTER ${JSON.stringify(line)}`);
		expect(errors, "page errors").toEqual([]);
		expect(m.strokes, "premise: the note's ink loaded").toBe(STROKES);
		expect(selected, "premise: every stroke is selected").toBe(STROKES);
		expect(r.began, `premise: the grab started the ${gesture}`).toBe(true);
		expect(r.onScreen, "premise: most of the ink is below the pane").toBeLessThan(STROKES / 2);
		expect(r.grab.fills, "premise: the grab frame drew the picture").toBeGreaterThan(0);
		expect(r.moves.bounds, "premise: the move window's redraws were counted").toBeGreaterThan(0);
		if (attach) expect(groups, "premise: the note carries attached groups").toBeGreaterThan(0);
		if (OUT) appendFileSync(OUT, JSON.stringify(line) + "\n");
		return r;
	} finally {
		await page.context().close();
	}
}

const gated = ENABLED ? it : it.skip;
gated("a resize grab, a rotate grab and a drag grab: pictures made and fills drawn, grab frame and moves", async () => {
	const drag = await run("drag");
	const resize = await run("resize");
	const rotate = await run("rotate");
	if (BOUND) {
		expect(resize.grab.fills, "a resize grab draws no more than a drag grab").toBeLessThanOrEqual(drag.grab.fills);
		expect(rotate.grab.fills, "a rotate grab draws no more than a drag grab").toBeLessThanOrEqual(drag.grab.fills);
		for (const r of [drag, resize, rotate]) expect(r.moves.clears, `${r.gesture}: pictures made again during moves`).toBe(0);
	}
}, 240_000);

gated("a resize with attached groups on the note: attach chrome reads per redraw and per shown frame", async () => {
	const r = await run("resize", 40);
	if (BOUND) expect(r.moves.bounds, "attach chrome reads in the move window, at most one per shown frame").toBeLessThanOrEqual(r.moves.frames + 1);
}, 240_000);

const timed = ENABLED && process.env.HW_GRAB_TIME === "1" ? it : it.skip;
timed("timing arm: a resize grab frame, median of five", async () => {
	const runs: Array<{ ms: number; dispatchMs: number; boxAfterMs: number; px: number }> = [];
	for (let i = 0; i < 5; i++) {
		const r = await run("resize");
		runs.push({ ...r.grabTime, px: r.picture?.px ?? 0 });
	}
	const sorted = runs.map(r => r.ms).sort((a, b) => a - b);
	const line = { gesture: "resize", strokes: STROKES, runs, medianMs: sorted[2] };
	// eslint-disable-next-line no-console
	console.log(`GRAB-TIME ${JSON.stringify(line)}`);
	if (OUT) appendFileSync(OUT, JSON.stringify({ grabTime: line }) + "\n");
	expect(runs.every(r => r.px > 0), "premise: every grab made its picture").toBe(true);
}, 600_000);
