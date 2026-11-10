/**
 * ZOOMED OUT, THIN INK LANDS AT THE WEIGHT ITS PREVIEW SHOWED.
 *
 * What it looks like: below 100 percent zoom, committed ink is never drawn thinner than one device px (the width floor,
 * WidthFloor.ts). A lassoed line resized there shows a soft picture while the pen is down; at the lift it is redrawn crisp
 * from the store. A held shape shows a faint preview of the shape before the lift commits it. In both cases the weight on
 * screen must not change at the lift: the preview is drawn with the same floor the commit uses, at the scale it is shown.
 *
 * The page: a plain editor, 40 short lines, device scale 2, zoomed out to 12.5 percent through the zoom buttons' path, the
 * pen at size 1 so the line is under one device px before the floor. Ink drawn by real pen events through the router.
 *
 * The measure is ink mass: the summed alpha of the magenta pixels, in device px squared. The preview and the lift carry the
 * same line (the geometry is checked to the point by LassoTransformLift), so the mass ratio is the width ratio.
 *
 * Cells:
 *  - a lassoed line shrunk to half by the bottom-right corner: the soft picture's mass against the lift's;
 *  - the same line doubled: the same read;
 *  - the same line shrunk to half, held, then doubled: the picture follows the second scale step;
 *  - a straight line held until its shape shows: the shape preview's mass against the committed shape's.
 *
 * Cost cells: the picture's rasters after the first, counted per shown frame. Zoomed out, a corner pull rasters it at most
 * once a frame; a turn of the knob alone never does; at 100 percent a corner pull never does.
 *
 * Run: npm run test:render -- test/render/PictureFloor.test.ts.
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
import { inlineInk, inkOverlayExtension, overlayForPath, setInlineTool, setInkSizeMult, setScrollExpansionEnabled } from "../../src/inline/InkOverlay";
import { setInkColorHex } from "../../src/ink/InkColor";
import { setPenInk } from "../../src/inline/PenInk";
import { setMouseInk } from "../../src/inline/MouseInk";
import { setTipMode } from "../../src/inline/TipMode";
import { setShapeSnap } from "../../src/inline/InkOverlayToolState";
import { handlePoints } from "../../src/inline/LassoTransform";
import { flooredHalfWidth } from "../../src/ink/WidthFloor";
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
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let rig = null;

const ptr = (type, px, py, buttons) => document.elementFromPoint(px, py)?.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true,
	pointerType: "pen", pointerId: 901, isPrimary: true, clientX: px, clientY: py, buttons, button: 0, pressure: buttons ? 0.5 : 0 }));

/** Summed alpha of a canvas's magenta pixels in device px squared (canvas px scaled by its shown size), and the pixel count. */
function mass(cc) {
	if (!cc || !cc.width || !cc.height) return null;
	const w = cc.width, h = cc.height, d = cc.getContext("2d").getImageData(0, 0, w, h).data;
	let sum = 0, n = 0;
	for (let i = 0; i < d.length; i += 4) {
		const a = d[i + 3];
		if (!a || d[i + 1] > 90 || d[i] < 128 || d[i + 2] < 128) continue;
		sum += a / 255; n++;
	}
	const r = cc.getBoundingClientRect(), perPx = r.width > 0 ? w / r.width : 0;
	if (!(perPx > 0)) return { raw: sum, n, perPx, device: null };
	const dev = window.devicePixelRatio / perPx;
	return { raw: sum, n, perPx, device: sum * dev * dev };
}

/** A pen stroke through client points, one frame per sample, lifted unless hold is set. */
async function penLine(pts, hold) {
	ptr("pointermove", pts[0][0], pts[0][1], 0); await frame();
	ptr("pointerdown", pts[0][0], pts[0][1], 1);
	for (const [x, y] of pts.slice(1)) { ptr("pointermove", x, y, 1); await frame(); }
	if (!hold) { ptr("pointerup", pts.at(-1)[0], pts.at(-1)[1], 0); await settle(12); }
}

window.pictureFloor = {
	async mount(zoomOut = true) {
		setPenInk(true); setMouseInk(true); setShapeSnap(true); setScrollExpansionEnabled(true);
		setInlineTool("pen"); setInkColorHex("pen", "#ff00ff"); setInkSizeMult("pen", 1); setTipMode("nib");
		const path = "picture-floor.md";
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
		for (let i = 0; i < 40 && overlay.getNoteViewportState().busy; i++) await frame();
		const before = overlay.getNoteViewportState();
		let steps = 0;
		while (zoomOut && overlay.pinchScaleNow > 0.125 * 1.0001 && steps < 20) { overlay.zoomNoteBy(0.5); await settle(); steps++; }
		await settle(8);
		rig = { pane, view, overlay, path };
		return { viewport: before, canvasMode: overlay.canvasMode, steps, dpr: window.devicePixelRatio, pinch: overlay.pinchScaleNow, cssScale: overlay.cssScale, backing: overlay.committedBacking, overlayDpr: overlay.dpr };
	},
	/** A zigzag over two lines, then a lasso loop round it. */
	async drawAndSelect() {
		const { overlay, path } = rig;
		const x0 = 400, y0 = 300, pts = Array.from({ length: 24 }, (_, i) => [x0 + i * 8, y0 + (i % 2 ? 26 : 0)]);
		await penLine(pts, false);
		const st = inlineInk.strokes(path)[0];
		if (!st) throw new Error("no stroke drawn");
		rig.c0 = { x: x0, y: y0 }; rig.p0 = { x: st.points[0].x, y: st.points[0].y };
		setTipMode("lasso");
		const cx = 492, cy = 313, R = 150, N = 36;
		const loop = [[cx + R, cy]];
		for (let i = 1; i <= N; i++) loop.push([cx + R * Math.cos(2 * Math.PI * i / N), cy + R * 0.6 * Math.sin(2 * Math.PI * i / N)]);
		await penLine(loop, false);
		await settle(6);
		return { strokes: inlineInk.strokes(path).length, selected: overlay.selection.size, width: st.width };
	},
	/**
	 * Grab a handle and move it one sample per shown frame. For the se handle each leg ends where the nw handle plus the leg's
	 * scale times the nw-to-se span puts it, with two still frames between legs; for the knob, one leg of (dx, dy) client px.
	 * The picture's rasters after the first are counted per frame (its canvas's getContext, called once per raster), and so are
	 * the times the picture's canvas is a new object (a raster into a fresh canvas calls getContext before it can be counted).
	 * The tail's mass is read just before the lift, the committed layer's after it.
	 */
	async transform(o) {
		const { overlay, path } = rig, box = overlay.selectionBounds(), cam = overlay.camera.snapshot, k = overlay.cssScale;
		// World to client: the camera's screen place scaled by the pinch, from the stroke's first sample.
		const s0 = overlay.camera.worldToScreen(rig.p0.x, rig.p0.y);
		const toClient = (p) => { const s = overlay.camera.worldToScreen(p.x, p.y); return { x: rig.c0.x + (s.x - s0.x) * k, y: rig.c0.y + (s.y - s0.y) * k }; };
		const hp = handlePoints(box, cam.zoom, overlay.cssScale), handle = o.handle ?? "se";
		const at = toClient(hp[handle]), nw = toClient(hp.nw);
		const targets = handle === "rotate" ? [{ x: at.x + o.turn.dx, y: at.y + o.turn.dy, steps: o.turn.steps }]
			: o.legs.map(l => ({ x: nw.x + (at.x - nw.x) * l.scale, y: nw.y + (at.y - nw.y) * l.scale, steps: l.steps }));
		const width = inlineInk.strokes(path)[0].width;
		ptr("pointermove", at.x, at.y, 0); await frame();
		ptr("pointerdown", at.x, at.y, 1);
		const began = !!(overlay.spaceSnapshot && overlay.spaceSnapshot.transform);
		let rasters = 0, frames = 0, maxPerFrame = 0, swaps = 0, spied = null, from = at, last = at;
		const watch = async () => {
			const before = rasters;
			await frame(); frames++;
			const pic = overlay.spaceSnapshot ? overlay.spaceSnapshot.canvas : null;
			if (pic && pic !== spied) {
				if (spied) swaps++;
				const own = pic.getContext.bind(pic);
				pic.getContext = (...a) => { rasters++; return own(...a); };
				spied = pic;
			}
			maxPerFrame = Math.max(maxPerFrame, rasters - before);
		};
		for (const t of targets) {
			for (let i = 1; i <= t.steps; i++) {
				last = { x: from.x + (t.x - from.x) * i / t.steps, y: from.y + (t.y - from.y) * i / t.steps };
				ptr("pointermove", last.x, last.y, 1);
				await watch();
			}
			await watch(); await watch();
			from = last;
		}
		const g = overlay.spaceSnapshot && overlay.spaceSnapshot.transform ? overlay.spaceSnapshot.transform.gesture.accepted : null;
		const accepted = g ? { scale: g.scale, angle: g.angle } : null;
		const preview = mass(overlay.tailCanvas);
		ptr("pointerup", last.x, last.y, 0);
		await settle(12);
		const lifted = mass(overlay.committedCanvas);
		const b = overlay.committedBacking, dpr = overlay.dpr, hw = width / 2;
		// The floor at the lift: the landed half-width floored, against it unfloored, device px.
		const s = accepted ? accepted.scale : 1;
		const floorAtLift = { hw: hw * s, floored: flooredHalfWidth(hw * s, b, dpr), atScale1: flooredHalfWidth(hw, b, dpr) };
		return { began, accepted, preview, lifted, floorAtLift, rasters, frames, maxPerFrame, swaps, spied: !!spied, strokes: inlineInk.strokes(path).length };
	},
	/** A straight pen line held still until its shape preview shows; the preview's mass, then the committed shape's after the lift. */
	async snapHold() {
		const { overlay, path } = rig;
		const pts = Array.from({ length: 28 }, (_, i) => [300 + i * 8, 300 + i * 1.2]);
		await penLine(pts, true);
		let shown = null;
		for (let i = 0; i < 40 && !shown; i++) { await wait(50); shown = rig.pane.ownerDocument.querySelector(".handwriting-snap-preview"); }
		await settle(2);
		const preview = mass(shown);
		ptr("pointerup", pts.at(-1)[0], pts.at(-1)[1], 0);
		await settle(12);
		const lifted = mass(overlay.committedCanvas);
		const st = inlineInk.strokes(path)[0];
		const b = overlay.committedBacking, dpr = overlay.dpr, hw = st ? st.width / 2 : 0;
		return { shown: !!shown, preview, lifted, strokes: inlineInk.strokes(path).length, width: st ? st.width : null,
			floorAtLift: { hw, floored: flooredHalfWidth(hw, b, dpr) } };
	},
};
`;

const DSF = 2;
/** The soft picture is resampled through the step's matrix; its mass may differ from the crisp lift's by this fraction. */
const PICTURE_BAR = 0.15;
/** The shape preview and the commit draw the same shape with the same painter; this fraction covers anti-aliasing only. */
const SNAP_BAR = 0.1;
let browser: Browser | null = null;
let script = "";

beforeAll(async () => {
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "pictureFloorPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true, args: [`--force-device-scale-factor=${DSF}`, "--window-size=1200,900"] });
}, 180_000);
afterAll(async () => {
	if (browser) await browser.close();
});

async function openPage(zoomOut = true): Promise<{ page: Page; m: any; errors: string[] }> {
	const page = await (await browser!.newContext({ viewport: null })).newPage();
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	page.on("console", msg => { const t = msg.text(); if (/plugin crashed|isn't allowed during an update/.test(t)) errors.push(("console: " + t).slice(0, 200)); });
	await page.setContent('<!doctype html><body class="theme-dark" style="margin:0"></body>');
	await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
	await page.addScriptTag({ content: script });
	const m = await page.evaluate((z) => (window as any).pictureFloor.mount(z), zoomOut);
	return { page, m, errors };
}
const call = (p: Page, method: string, ...args: unknown[]) => p.evaluate(([n, a]) => (window as any).pictureFloor[n](...a), [method, args] as const) as Promise<any>;

function premiseZoom(m: any, fails: string[]): void {
	if (!(m.backing > 0 && m.backing < m.overlayDpr)) fails.push(`premise: the committed backing ${m.backing} is not below the device ratio ${m.overlayDpr}`);
}

const TRANSFORM_CELLS = [
	{ name: "a lassoed line shrunk to half by its corner", scale: 0.5, o: { legs: [{ scale: 0.5, steps: 12 }] } },
	{ name: "a lassoed line doubled by its corner", scale: 2, o: { legs: [{ scale: 2, steps: 12 }] } },
	{ name: "a lassoed line shrunk to half, held, then doubled by its corner", scale: 2, o: { legs: [{ scale: 0.5, steps: 10 }, { scale: 2, steps: 10 }] } },
] as const;

for (const cell of TRANSFORM_CELLS) it(`zoomed out, ${cell.name}: the lift lands at the weight the picture showed`, async () => {
	const { page, m, errors } = await openPage();
	try {
		const d = await call(page, "drawAndSelect");
		const r = await call(page, "transform", cell.o);
		const ratio = r.preview?.device && r.lifted?.device ? r.preview.device / r.lifted.device : null;
		// eslint-disable-next-line no-console
		console.log(`PICTURE FLOOR, ${cell.name}: mount ${JSON.stringify(m)}, drawn ${JSON.stringify(d)}, began ${r.began}, accepted ${JSON.stringify(r.accepted)}, ` +
			`floor at the lift ${JSON.stringify(r.floorAtLift)}, picture mass ${JSON.stringify(r.preview)}, lift mass ${JSON.stringify(r.lifted)}, picture over lift ${ratio}`);
		const fails: string[] = [];
		if (errors.length) fails.push(`page errors ${JSON.stringify(errors)}`);
		premiseZoom(m, fails);
		if (d.strokes !== 1 || r.strokes !== 1) fails.push(`premise: ${d.strokes} strokes drawn, ${r.strokes} after`);
		if (d.selected !== 1) fails.push(`premise: the lasso selected ${d.selected}, not the one stroke`);
		if (!r.began) fails.push("premise: the grab on the corner did not start a resize");
		if (!r.accepted || Math.abs(r.accepted.scale - cell.scale) > 0.15 * cell.scale) fails.push(`premise: the step's scale is ${JSON.stringify(r.accepted)}, not near ${cell.scale}`);
		if (!(r.floorAtLift.floored > r.floorAtLift.hw) && !(r.floorAtLift.atScale1 > r.floorAtLift.hw / (r.accepted?.scale ?? 1)))
			fails.push(`premise: the floor engages neither at scale 1 nor at the lift: ${JSON.stringify(r.floorAtLift)}`);
		if (!r.preview?.device) fails.push("premise: no ink in the picture before the lift");
		if (!r.lifted?.device) fails.push("premise: no ink on the committed layer after the lift");
		if (ratio !== null && Math.abs(ratio - 1) > PICTURE_BAR)
			fails.push(`the picture's weight is ${ratio.toFixed(3)} times the lift's (bar ${PICTURE_BAR}): the weight changes at the lift`);
		expect(fails, fails.join("\n")).toEqual([]);
	} finally {
		await page.context().close();
	}
}, 120_000);

const COST_CELLS = [
	{ name: "zoomed out, a corner pull", zoomOut: true, o: { legs: [{ scale: 0.5, steps: 12 }] }, most: 1 },
	{ name: "zoomed out, a turn of the knob alone", zoomOut: true, o: { handle: "rotate", turn: { dx: 80, dy: 40, steps: 12 } }, most: 0 },
	{ name: "at 100 percent, a corner pull", zoomOut: false, o: { legs: [{ scale: 0.5, steps: 12 }] }, most: 0 },
] as const;

for (const cell of COST_CELLS) it(`${cell.name}: the picture is rastered again at most ${cell.most} time per shown frame`, async () => {
	const { page, m, errors } = await openPage(cell.zoomOut);
	try {
		const d = await call(page, "drawAndSelect");
		const r = await call(page, "transform", cell.o);
		// eslint-disable-next-line no-console
		console.log(`PICTURE FLOOR COST, ${cell.name}: mount ${JSON.stringify(m)}, drawn ${JSON.stringify(d)}, began ${r.began}, accepted ${JSON.stringify(r.accepted)}, ` +
			`rasters after the first ${r.rasters} over ${r.frames} frames, most in one frame ${r.maxPerFrame}, canvas swaps ${r.swaps}, picture watched ${r.spied}`);
		const fails: string[] = [];
		if (errors.length) fails.push(`page errors ${JSON.stringify(errors)}`);
		if (cell.zoomOut) premiseZoom(m, fails);
		else if (m.backing !== m.overlayDpr) fails.push(`premise: at 100 percent the backing ${m.backing} is not the device ratio ${m.overlayDpr}`);
		if (d.selected !== 1) fails.push(`premise: the lasso selected ${d.selected}, not the one stroke`);
		if (!r.began) fails.push("premise: the grab did not start a resize or rotate");
		if (!r.spied) fails.push("premise: no picture was made to watch");
		if (r.swaps !== 0) fails.push(`premise: the picture's canvas was a new object ${r.swaps} times in the gesture; a raster into a fresh canvas is not counted`);
		if (!r.accepted || (r.accepted.scale === 1 && r.accepted.angle === 0)) fails.push(`premise: the step is ${JSON.stringify(r.accepted)}, no change`);
		if ("turn" in cell.o && r.accepted && r.accepted.scale !== 1) fails.push(`premise: the turn scaled by ${r.accepted.scale}`);
		if (r.maxPerFrame > cell.most) fails.push(`the picture was rastered ${r.maxPerFrame} times in one shown frame (at most ${cell.most})`);
		if (cell.most === 0 && r.rasters !== 0) fails.push(`the picture was rastered again ${r.rasters} times (none expected)`);
		expect(fails, fails.join("\n")).toEqual([]);
	} finally {
		await page.context().close();
	}
}, 120_000);

it("zoomed out, a thin line held until its shape shows: the shape lands at the weight its preview showed", async () => {
	const { page, m, errors } = await openPage();
	try {
		const r = await call(page, "snapHold");
		const ratio = r.preview?.device && r.lifted?.device ? r.preview.device / r.lifted.device : null;
		// eslint-disable-next-line no-console
		console.log(`PICTURE FLOOR, snap hold: mount ${JSON.stringify(m)}, shown ${r.shown}, width ${r.width}, floor at the lift ${JSON.stringify(r.floorAtLift)}, ` +
			`preview mass ${JSON.stringify(r.preview)}, lift mass ${JSON.stringify(r.lifted)}, preview over lift ${ratio}`);
		const fails: string[] = [];
		if (errors.length) fails.push(`page errors ${JSON.stringify(errors)}`);
		premiseZoom(m, fails);
		if (!r.shown) fails.push("premise: the held line showed no shape preview");
		if (r.strokes !== 1) fails.push(`premise: ${r.strokes} strokes after the lift, not one`);
		if (!(r.floorAtLift.floored > r.floorAtLift.hw)) fails.push(`premise: the floor does not engage on the committed shape: ${JSON.stringify(r.floorAtLift)}`);
		if (!r.preview?.device) fails.push("premise: no ink in the shape preview");
		if (!r.lifted?.device) fails.push("premise: no ink on the committed layer after the lift");
		if (ratio !== null && Math.abs(ratio - 1) > SNAP_BAR)
			fails.push(`the shape preview's weight is ${ratio.toFixed(3)} times the committed shape's (bar ${SNAP_BAR}): a thin shape lands wider than shown`);
		expect(fails, fails.join("\n")).toEqual([]);
	} finally {
		await page.context().close();
	}
}, 120_000);
