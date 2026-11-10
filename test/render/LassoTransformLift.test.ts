/**
 * THE LASSO'S RESIZE AND ROTATE LANDS WHERE ITS PREVIEW SHOWED IT, ON SCREEN.
 *
 * What it looks like: a lassoed stroke shows four corner squares and a knob above its box. Pulling a corner scales the ink,
 * turning the knob rotates it; while the pen is down the ink is a soft picture, and at the lift it is redrawn crisp from the
 * store. The ink must not jump at the lift (zero snap): the store's points land where the gesture's step, the one the
 * picture is drawn through, puts them, and the crisp frame the lift leaves is the product painter's own picture of them.
 *
 * The page: a plain editor, dark, 20 short lines, font 26, one magenta stroke drawn by real pen events through the router,
 * selected by a real lasso loop. Device scale forced through Chromium's --force-device-scale-factor=2. Each cell grabs a
 * handle with a real pointer and moves it in steps. After the lift, three reads:
 *  - geometry: each stored point against the step the gesture accepted applied to its point before the grab, within 0.1
 *    px (a diagnostic read found the lift exact to the point);
 *  - the frame: the committed layer the lift left against a fresh repaint of the saved strokes by the product painter
 *    (repaintAllInkOverlays), pixel-equal;
 *  - for a corner pull, the ink box's far corner where it was, within 0.1 px.
 * No ink centroid is the measure. The painter's caps and taper grow with the width, so the centroid of the same stroke at
 * points and width x 1.4 sits 1.25 device px off its points' map with no gesture at all (measured); the soft
 * picture differs from the crisp ink by design (Alan 10-21). Both centroids are still logged.
 *
 * Cells:
 *  - a pen pulls the bottom-right corner out by half again: the ink box's top-left corner stays within 0.1 px;
 *  - a mouse turns the knob with Shift held: the turn is a whole number of 15 degree steps;
 *  - a pen pulls the corner, the pane scrolls 40 css px mid-gesture, the pen pulls on: the picture is not made again, as the
 *    lasso drag's is not at the same scroll (measured on the lasso drag before this change and here), and the ink still lands where the step
 *    puts it.
 *
 * Run: npm run test:render -- test/render/LassoTransformLift.test.ts.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

const PAGE = `
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { Platform } from "obsidian";
import { inlineInk, inkOverlayExtension, overlayForPath, repaintAllInkOverlays, setInlineTool, setInkSizeMult } from "../../src/inline/InkOverlay";
import { setInkColorHex } from "../../src/ink/InkColor";
import { setPenInk } from "../../src/inline/PenInk";
import { setMouseInk } from "../../src/inline/MouseInk";
import { setTipMode } from "../../src/inline/TipMode";
import { handlePoints, transformPoint } from "../../src/inline/LassoTransform";
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

const ptr = (type, kind, px, py, buttons, shiftKey = false) => document.elementFromPoint(px, py)?.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true,
	pointerType: kind, pointerId: kind === "mouse" ? 1 : 901, isPrimary: true, clientX: px, clientY: py, buttons, button: 0, shiftKey, pressure: buttons ? 0.5 : 0 }));

/** The alpha centroid of a canvas's magenta pixels, client px, and their count; null with none. */
function centroid(cc) {
	if (!cc || !cc.width || !cc.height) return null;
	const w = cc.width, h = cc.height, d = cc.getContext("2d").getImageData(0, 0, w, h).data;
	let sw = 0, sx = 0, sy = 0, n = 0;
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
		const i = (y * w + x) * 4, a = d[i + 3];
		if (!a || d[i + 1] > 90 || d[i] < 128 || d[i + 2] < 128) continue;
		sw += a; sx += (x + 0.5) * a; sy += (y + 0.5) * a; n++;
	}
	if (!sw) return null;
	const r = cc.getBoundingClientRect();
	return { x: r.left + (sx / sw) * r.width / w, y: r.top + (sy / sw) * r.height / h, n, perPx: w / r.width };
}
/** World point to client px: the camera's screen place plus the router's offset, measured from the stroke's first sample. */
const toClient = (p) => { const s = rig.overlay.camera.worldToScreen(p.x, p.y); return { x: s.x + rig.off.x, y: s.y + rig.off.y }; };

window.lassoTransformLift = {
	async mount() {
		setPenInk(true); setMouseInk(true);
		setInlineTool("pen"); setInkColorHex("pen", "#ff00ff"); setInkSizeMult("pen", 4); setTipMode("nib");
		const path = "lasso-transform-lift.md";
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
		// One stroke: a zigzag over two lines, drawn with the pen.
		const x0 = 400, y0 = 300, pts = Array.from({ length: 24 }, (_, i) => [x0 + i * 8, y0 + (i % 2 ? 26 : 0)]);
		ptr("pointermove", "pen", x0, y0, 0); await frame();
		ptr("pointerdown", "pen", x0, y0, 1);
		for (const [x, y] of pts.slice(1)) { ptr("pointermove", "pen", x, y, 1); await frame(); }
		ptr("pointerup", "pen", pts.at(-1)[0], pts.at(-1)[1], 0);
		await settle(12);
		const st = inlineInk.strokes(path)[0];
		if (!st) throw new Error("no stroke drawn");
		const s = overlay.camera.worldToScreen(st.points[0].x, st.points[0].y);
		rig.off = { x: x0 - s.x, y: y0 - s.y };
		return { strokes: inlineInk.strokes(path).length, dpr: window.devicePixelRatio };
	},
	/**
	 * A lasso loop round the stroke: lasso mode, a real pen loop. The tip stays in lasso mode for the grab, as on the device:
	 * switching it back to the nib dissolves the selection (§5o, InkOverlayToolState.ts).
	 */
	async select() {
		setTipMode("lasso");
		const cx = 492, cy = 313, R = 150, N = 36;
		ptr("pointermove", "pen", cx + R, cy, 0); await frame();
		ptr("pointerdown", "pen", cx + R, cy, 1);
		for (let i = 1; i <= N; i++) { ptr("pointermove", "pen", cx + R * Math.cos(2 * Math.PI * i / N), cy + R * 0.6 * Math.sin(2 * Math.PI * i / N), 1); await frame(); }
		ptr("pointerup", "pen", cx + R, cy, 0);
		await settle(6);
		return rig.overlay.selection.size;
	},
	/**
	 * Grab a handle with a pointer kind, move it by (dx, dy) client px in steps (scrolling the pane by scrollAt.by css px after
	 * step scrollAt.step), read the tail's centroid just before the lift and the committed layer's after it.
	 */
	async transform(o) {
		const { overlay, view } = rig, kind = o.kind, box = overlay.selectionBounds(), cam = overlay.camera.snapshot;
		const at = toClient(handlePoints(box, cam.zoom)[o.handle]);
		const st0 = inlineInk.strokes(rig.path)[0], beforePts = st0.points.map(p => ({ x: p.x, y: p.y })), boxBefore = { ...st0.bbox };
		ptr("pointermove", kind, at.x, at.y, 0);
		await frame();
		ptr("pointerdown", kind, at.x, at.y, 1, o.shift);
		const began = !!(overlay.spaceSnapshot && overlay.spaceSnapshot.transform);
		let scrolled = 0, reRastered = 0, lastAt = null;
		for (let i = 1; i <= o.steps; i++) {
			ptr("pointermove", kind, at.x + o.dx * i / o.steps, at.y + o.dy * i / o.steps, 1, o.shift);
			await frame(); await frame();
			const snap = overlay.spaceSnapshot;
			if (snap && lastAt && (snap.at.x !== lastAt.x || snap.at.y !== lastAt.y)) reRastered++;
			if (snap) lastAt = { ...snap.at };
			if (o.scrollAt && i === o.scrollAt.step) {
				const before = view.scrollDOM.scrollTop;
				view.scrollDOM.scrollTop += o.scrollAt.by;
				await settle(4);
				scrolled = view.scrollDOM.scrollTop - before;
				// The pen holds still on screen; nudge it once at the same place so the gesture reads the moved camera.
				ptr("pointermove", kind, at.x + o.dx * i / o.steps, at.y + o.dy * i / o.steps, 1, o.shift);
				await frame(); await frame();
				const s2 = overlay.spaceSnapshot;
				if (s2 && lastAt && (s2.at.x !== lastAt.x || s2.at.y !== lastAt.y)) reRastered++;
				if (s2) lastAt = { ...s2.at };
			}
		}
		await settle(2);
		const g = overlay.spaceSnapshot && overlay.spaceSnapshot.transform ? overlay.spaceSnapshot.transform.gesture.accepted : null;
		const accepted = g ? { scale: g.scale, angle: g.angle } : null;
		const step = g ? { pivot: { ...g.pivot }, scale: g.scale, angle: g.angle } : null;
		const preview = centroid(overlay.tailCanvas);
		const end = { x: at.x + o.dx, y: at.y + o.dy };
		ptr("pointerup", kind, end.x, end.y, 0, o.shift);
		await settle(12);
		const lifted = centroid(overlay.committedCanvas);
		// Geometry: each stored point against the step applied to its point before the grab, world units (css px at zoom 1).
		let geomErr = null;
		if (step) {
			const st1 = inlineInk.strokes(rig.path)[0];
			geomErr = st1.points.length === beforePts.length ? 0 : Infinity;
			beforePts.forEach((p, i) => { const e = transformPoint(p, step), q = st1.points[i]; if (q) geomErr = Math.max(geomErr, Math.hypot(q.x - e.x, q.y - e.y)); });
		}
		// The frame: the committed layer the lift left against a fresh repaint of the saved strokes by the product painter.
		const pixels = (cc) => (cc && cc.width && cc.height ? { w: cc.width, h: cc.height, d: cc.getContext("2d").getImageData(0, 0, cc.width, cc.height).data } : null);
		const left = pixels(overlay.committedCanvas);
		repaintAllInkOverlays();
		await settle(12);
		const fresh = pixels(overlay.committedCanvas);
		let frameDiff = null;
		if (left && fresh && left.w === fresh.w && left.h === fresh.h) {
			let bytes = 0, max = 0;
			for (let i = 0; i < left.d.length; i++) { const dd = Math.abs(left.d[i] - fresh.d[i]); if (dd) { bytes++; if (dd > max) max = dd; } }
			frameDiff = { bytes, max };
		} else frameDiff = { size: [left && [left.w, left.h], fresh && [fresh.w, fresh.h]] };
		// A corner pull leaves the ink box's far corner where it was: for the se handle, its top-left, world units.
		const boxAfter = inlineInk.strokes(rig.path)[0].bbox, farMove = { x: boxAfter.x - boxBefore.x, y: boxAfter.y - boxBefore.y };
		return { began, accepted, geomErr, frameDiff, farMove, preview, lifted, scrolled, reRastered, strokes: inlineInk.strokes(rig.path).length };
	},
};
`;

const DSF = 2;
/** The most a stored point may sit from where the step puts it, and the far corner from where it was, css px. */
const GEOM_MAX = 0.1;
let browser: Browser | null = null;
let script = "";

beforeAll(async () => {
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "lassoTransformLiftPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true, args: [`--force-device-scale-factor=${DSF}`, "--window-size=1200,900"] });
}, 180_000);
afterAll(async () => {
	if (browser) await browser.close();
});

async function openPage(): Promise<{ page: Page; m: any; errors: string[] }> {
	const page = await (await browser!.newContext({ viewport: null })).newPage();
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	page.on("console", msg => { const t = msg.text(); if (/plugin crashed|isn't allowed during an update/.test(t)) errors.push(("console: " + t).slice(0, 200)); });
	await page.setContent('<!doctype html><body class="theme-dark" style="margin:0"></body>');
	await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
	await page.addScriptTag({ content: script });
	const m = await page.evaluate(() => (window as any).lassoTransformLift.mount());
	return { page, m, errors };
}
const call = (p: Page, method: string, ...args: unknown[]) => p.evaluate(([n, a]) => (window as any).lassoTransformLift[n](...a), [method, args] as const) as Promise<any>;

const CELLS = [
	{ name: "a pen pulls the bottom-right corner out by half again", o: { kind: "pen", handle: "se", dx: 90, dy: 30, steps: 12 } },
	{ name: "a mouse turns the knob with Shift held", o: { kind: "mouse", handle: "rotate", dx: 70, dy: 40, steps: 12, shift: true } },
	{ name: "a pen pulls the corner and the pane scrolls 40 css px mid-gesture", o: { kind: "pen", handle: "se", dx: 90, dy: 30, steps: 12, scrollAt: { step: 6, by: 40 } } },
] as const;

for (const cell of CELLS) it(`${cell.name}: the ink lands where its preview showed it`, async () => {
	const { page, m, errors } = await openPage();
	try {
		const selected = await call(page, "select");
		const r = await call(page, "transform", cell.o);
		const perPx = r.lifted?.perPx ?? DSF;
		const soft = r.preview && r.lifted ? { x: (r.lifted.x - r.preview.x) * perPx, y: (r.lifted.y - r.preview.y) * perPx } : null;
		// eslint-disable-next-line no-console
		console.log(`LASSO TRANSFORM LIFT, ${cell.name}: dpr ${m.dpr}, selected ${selected}, began ${r.began}, accepted ${JSON.stringify(r.accepted)}, ` +
			`geometry max err ${r.geomErr}, frame vs fresh repaint ${JSON.stringify(r.frameDiff)}, far corner moved ${JSON.stringify(r.farMove)}, ` +
			`scrolled ${r.scrolled}, re-rastered ${r.reRastered}, lifted centroid ${JSON.stringify(r.lifted)}, soft picture ${JSON.stringify(r.preview)}, soft shift device px ${JSON.stringify(soft)}`);
		const fails: string[] = [];
		if (errors.length) fails.push(`page errors ${JSON.stringify(errors)}`);
		if (m.strokes !== 1 || r.strokes !== 1) fails.push(`premise: ${m.strokes} strokes at mount, ${r.strokes} after`);
		if (selected !== 1) fails.push(`premise: the lasso selected ${selected}, not the one stroke`);
		if (!r.began) fails.push("the grab on the handle did not start a resize or rotate");
		if (!r.accepted || (r.accepted.scale === 1 && r.accepted.angle === 0)) fails.push(`the gesture's step is ${JSON.stringify(r.accepted)}, no change`);
		if (cell.o.handle === "se" && r.accepted && !(r.accepted.scale > 1.2)) fails.push(`the corner pull scaled by ${r.accepted.scale}, not out`);
		if (cell.o.handle === "se" && (Math.abs(r.farMove.x) > GEOM_MAX || Math.abs(r.farMove.y) > GEOM_MAX))
			fails.push(`the ink box's far corner moved ${r.farMove.x.toFixed(3)}, ${r.farMove.y.toFixed(3)} on a corner pull (bar ${GEOM_MAX})`);
		if ("shift" in cell.o && r.accepted) {
			const steps = r.accepted.angle / (Math.PI / 12);
			if (Math.abs(steps - Math.round(steps)) > 1e-9 || Math.round(steps) === 0) fails.push(`Shift on a mouse turned ${r.accepted.angle} rad, not a whole number of 15 degree steps`);
		}
		if ("scrollAt" in cell.o) {
			if (r.scrolled !== cell.o.scrollAt.by) fails.push(`premise: the pane scrolled ${r.scrolled} css px, not ${cell.o.scrollAt.by}`);
			if (r.reRastered !== 0) fails.push(`the picture was made again ${r.reRastered} times at the moved camera; the lasso drag's is not`);
		}
		if (!r.lifted) fails.push("premise: no ink on the committed layer after the lift");
		if (r.geomErr === null) fails.push("premise: the gesture accepted no step to check the lift against");
		else if (!(r.geomErr <= GEOM_MAX)) fails.push(`the lift moved a point ${r.geomErr} px from where the step puts it (bar ${GEOM_MAX})`);
		if (!r.frameDiff || r.frameDiff.bytes === undefined) fails.push(`the frame and its fresh repaint differ in size: ${JSON.stringify(r.frameDiff)}`);
		else if (r.frameDiff.bytes !== 0)
			fails.push(`the frame the lift left is not the painter's picture of the saved strokes: ${r.frameDiff.bytes} bytes differ, by up to ${r.frameDiff.max}`);
		expect(fails, fails.join("\n")).toEqual([]);
	} finally {
		await page.context().close();
	}
}, 120_000);
