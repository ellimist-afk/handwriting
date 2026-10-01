/**
 * WHAT A SCROLL EVENT COSTS ON ALAN'S INKED NOTE, AND WHICH STATE MAKES IT COST.
 *
 * What it looks like: on Orion (package-ba6957e8, vault test 2's Untitled 1, 1527 strokes) the scroll probe read 4 to 8 ms
 * on every scroll repaint with ink in view and about 2 ms with none, where the same build and note read 0.4 to 1.8 ms
 * between band moves the run before. An empty note scrolls smooth. The scale sat at 1.1176426850344592 for the whole slow
 * run; the clean value is 19/17 = 1.1176470588235294 (font 19 over the note's fontRefPx 17).
 *
 * It mounts the note's real sidecar (fixtures/alan-ink-75d1627a.json, a copy of
 * the vault file), canvas on as its frontmatter says, a desktop platform with diagnostics recording as on the device, and
 * drives one horizontal touch fling from the top-left corner, where the ink is. For every repaint in the fling it reads:
 *   - probeWait: the scroll probe's own number, from the first repaint request to the probe's repaint record. The probe
 *     writes that record after the committed paint, so it includes the paint;
 *   - the time inside syncBand, syncCamera, paintCommittedWork and updateExtent, the stroke index rebuilds, the
 *     getImageData readbacks, the wet canvas size writes;
 *   - the probe's performance mark ("hw:repaint work=<all | n rect> band=<moved | still>"), which names the work kind;
 *   - the camera the frame painted against, against the one it last painted;
 *   - whether a band move carried its pixels (the overlay's diagnostic flag, set at the syncBand carry site).
 *
 * THE CLAIMS. Every arm, with ink in view: a repaint that does not move the band paints no "all" (the camera is still
 * while the band is still, so only damage is drawn; the readback arm is exempt, its heal frame paints "all" by design),
 * its camera equals the last painted camera, and the median paint of those repaints is under 1 ms.
 * The clean arm and both host-zoom arms, the carry: every band move carries its pixels and keeps them (the flag set and
 * the work a rect count, not "all"), and paints in under 3 ms, the first move included (its strip can meet many strokes). At the device's build a band move loses its carry on some
 * moves at the clean scale and on every move under the host zoom, so these two are red there; they are what a carry fix
 * has to turn green. The frame-time bounds belong to ScrollCost.test.ts, not here.
 *
 * Arms, one condition each against the clean state:
 *   clean        scale 19/17, wet canvas released when idle (arm W), purge readback unarmed (desktop), extent pass on;
 *   epsilon      the overlay's believed css scale set to 0.9999960866097792, so the scale is 1.1176426850344592 as on the device;
 *   wet-held     window.HW_ARM_W_OFF: the wet canvas keeps its backing through the scroll;
 *   readback     Platform.isMobileApp after mount: the purge probe is armed and reads back on scroll-only frames;
 *   no-extent    epsilon, with updateExtent and the stroke index rebuild stubbed out of the frame (the extent/index pass);
 *   zoom-clean   the plugin's zoom host engaged at 1 (commitCameraScale(1)): a real transform host, clean scale;
 *   hostzoom-f17 css zoom 19/17 on the host pane (not the plugin's zoom), font 17: the scale 19/17 arrives through the
 *                measured rect path (band rect width over offsetWidth), as on the device;
 *   hostzoom-f19 the same css zoom with Alan's font 19: the measured path at (19/17)^2.
 * A still frame is also red when its camera differs from the last painted camera (full precision) with no band move.
 * HW_SCROLLINK_ARMS=<a,b,...> runs the named arms only.
 *
 * Run: npx vitest run --config vitest.render.mts test/render/ScrollCostInk.test.ts
 * HW_SCROLLINK_OUT=<file> writes every arm's rows as JSON.
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";
import { timingBound } from "../ciBounds";

declare const process: { env: Record<string, string | undefined>; platform: string };

const MINIMAL_CSS = readFileSync(fileURLToPath(new URL("./fixtures/minimal-9.0.2-theme.css", import.meta.url)), "utf8");
/** Alan's note's sidecar, copied from vault test 2/.handwriting/75d1627a-c4d7-4a11-947d-bc26b7f83c20.json (sha256 2a9d3992...). */
const SIDECAR = readFileSync(fileURLToPath(new URL("./fixtures/alan-ink-75d1627a.json", import.meta.url)), "utf8");
const PAGE_ID = "75d1627a-c4d7-4a11-947d-bc26b7f83c20";

const PAGE = `
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { Platform } from "obsidian";
import { inlineInk, inkOverlayExtension, overlayForPath, setScrollExpansionEnabled, setInlineTool } from "../../src/inline/InkOverlay";
import { setDiagnosticsEnabled } from "../../src/diag/DiagSwitch";
import { setPenInk } from "../../src/inline/PenInk";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField } from "./iphoneObsidianStub";
import { parsePage, serializePage } from "../../src/model/PageData";

installObsidianDom();
// Orion runs the desktop app.
Object.assign(Platform, { isMobile: false, isDesktop: true, isIosApp: false, isAndroidApp: false, isDesktopApp: true, isMobileApp: false, isPhone: false, isTablet: false, isWin: true });

// getImageData, timed: the purge readback is one.
const img = { n: 0, ms: 0 };
const origGID = CanvasRenderingContext2D.prototype.getImageData;
CanvasRenderingContext2D.prototype.getImageData = function (...a) { const t0 = performance.now(); try { return origGID.apply(this, a); } finally { img.n++; img.ms += performance.now() - t0; } };
// Canvas size writes, by canvas.
const sizes = new Map();
for (const dim of ["width", "height"]) {
	const d = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, dim);
	Object.defineProperty(HTMLCanvasElement.prototype, dim, { configurable: true, enumerable: d.enumerable, get: d.get,
		set(v) { sizes.set(this, (sizes.get(this) || 0) + 1); d.set.call(this, v); } });
}

const ids = new Map(), sidecars = new Map();
const save = (id, page) => { sidecars.set(id, serializePage(page)); };
inlineInk.attachHost({ readPageId: p => ids.get(p) ?? null, claimId: async (p, id) => { ids.set(p, id); return { pageId: id }; },
	loadSidecar: async id => (sidecars.has(id) ? parsePage(sidecars.get(id), id) : null), scheduleSidecar: save, scheduleSidecarNow: async (id, p) => save(id, p), notify: () => {} });

const frame = () => new Promise(r => requestAnimationFrame(() => r()));
const rendered = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await frame(); };
const mark = n => { try { performance.mark(n); } catch {} };
const PANE_W = 1397.5, PANE_H = 800, HOST_LEFT = 300;
let rig = null;

function installSizer(view) {
	const sizer = document.createElement("div"); sizer.className = "cm-sizer";
	const container = document.createElement("div"); container.className = "cm-contentContainer";
	view.contentDOM.parentElement.insertBefore(sizer, view.contentDOM); sizer.appendChild(container); container.appendChild(view.contentDOM);
	void view.scrollDOM.clientWidth; return sizer;
}

/** Painted pixels of the committed canvas inside the scroller's viewport: the "ink in view" premise. */
function inkInView() {
	const { overlay, view } = rig, c = overlay.committedCanvas, sd = view.scrollDOM;
	const cr = c.getBoundingClientRect(), vr = sd.getBoundingClientRect();
	const l = Math.max(cr.left, vr.left), t = Math.max(cr.top, vr.top), r = Math.min(cr.right, vr.right), b = Math.min(cr.bottom, vr.bottom);
	if (!(r > l && b > t) || !(c.width > 0)) return 0;
	const kx = c.width / cr.width, ky = c.height / cr.height;
	const x0 = Math.floor((l - cr.left) * kx), y0 = Math.floor((t - cr.top) * ky), w = Math.floor((r - l) * kx), h = Math.floor((b - t) * ky);
	const data = origGID.call(c.getContext("2d"), x0, y0, w, h).data;
	let n = 0;
	for (let i = 3; i < data.length; i += 4) if (data[i] > 0) n++;
	return n;
}

window.scrollInk = {
	async mount(arm, sidecar, pageId) {
		if (arm === "wet-held") window.HW_ARM_W_OFF = true;
		setDiagnosticsEnabled(true);
		setPenInk(true); setScrollExpansionEnabled(true); setInlineTool("pen");
		const path = "Untitled 1.md";
		sidecars.set(pageId, sidecar); ids.set(path, pageId);
		const pane = document.body.appendChild(document.createElement("div"));
		pane.className = "markdown-source-view mod-cm6";
		pane.style.cssText = "position:relative;margin-left:" + (HOST_LEFT + 1 / 3) + "px;margin-top:77.5px;width:" + PANE_W + "px;height:" + PANE_H + "px;overflow:hidden";
		if (arm.startsWith("hostzoom-")) pane.style.zoom = String(19 / 17);
		document.body.classList.add("handwriting-paper-lines");
		const doc = ["", "", "", ""].join("\\n");
		const view = new EditorView({ parent: pane, state: EditorState.create({ doc, extensions: [history(), EditorView.lineWrapping,
			editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} })), inkOverlayExtension(),
			EditorView.theme({ "&": { width: PANE_W + "px", height: PANE_H + "px" }, ".cm-scroller": { overflowY: "auto", overflowX: "hidden" } })] }) });
		installSizer(view);
		for (let i = 0; i < 40 && inlineInk.strokes(path).length === 0; i++) await settle(2);
		await settle(12);
		const overlay = overlayForPath(path);
		if (!overlay) throw new Error("no overlay for " + path);
		rig = { pane, view, overlay, path };
		overlay.updateExtent(true);
		await settle(12);
		if (arm === "epsilon" || arm === "no-extent") {
			// The device's state: the believed css scale sits a hair under 1, inside SCALE_EPSILON of every later measure,
			// so syncCamera keeps it. The scale is that times the font zoom 19/17.
			overlay.cssScale = 0.9999960866097792;
			overlay.scheduleRepaint("other");
			await settle(8);
		}
		// The plugin's own zoom transaction, at 1.
		if (arm === "zoom-clean") {
			if (!overlay.commitCameraScale(1, { left: 0, top: 0 })) throw new Error("zoom refused");
			await settle(12);
			overlay.scheduleRepaint("other");
			await settle(8);
		}
		if (arm === "readback") Platform.isMobileApp = true;
		await settle(4);
		return { strokes: inlineInk.strokes(path).length, canvasMode: !!overlay.canvasMode, scale: overlay.scale, pinchScaleNow: overlay.pinchScaleNow, zoomHost: !!overlay.viewportLayout, cssScale: overlay.cssScale, fontZoom: overlay.fontZoom,
			refFontPx: overlay.refFontPx, scrollWidth: view.scrollDOM.scrollWidth, clientWidth: view.scrollDOM.clientWidth, scrollHeight: view.scrollDOM.scrollHeight,
			clientHeight: view.scrollDOM.clientHeight, dpr: window.devicePixelRatio, wetW: overlay.wetCanvas.width, wetReleaseOff: !!overlay.wetReleaseOff,
			inkPx: inkInView(), committed: [overlay.committedCanvas.width, overlay.committedCanvas.height] };
	},
	/** One finger from the corner: sixteen moves of 18.75 px to the left (scrollLeft rises), 16 ms apart, a lift at speed, every frame until the fling ends plus four. */
	async fling(arm) {
		const { view, overlay } = rig, router = overlay.router, sd = view.scrollDOM;
		setPenInk(false);
		sd.scrollTop = 0; sd.scrollLeft = 0;
		await settle(8);
		await new Promise(res => setTimeout(res, 800));
		await settle(4);
		const inkPxStart = inkInView();
		const r = sd.getBoundingClientRect(), x0 = r.left + r.width / 2, y0 = r.top + r.height / 2;
		const finger = (type, d, buttons) => {
			const e = { type, pointerType: "touch", pointerId: 961, isPrimary: true, clientX: x0 + d, clientY: y0,
				pressure: buttons === 0 ? 0 : 0.5, buttons, button: 0, timeStamp: performance.now(), tiltX: 0, tiltY: 0, width: 0, height: 0,
				target: sd, preventDefault() {}, stopPropagation() {} };
			if (type === "pointerdown") router.pointerDown(e); else if (type === "pointermove") router.pointerMove(e); else router.pointerUpOrCancel(e);
		};
		const rows = [], scrolls = [];
		let phase = "down", pendingAt = null, cur = null;
		const wraps = [];
		const timeOn = (obj, name, key, stub) => {
			const orig = obj[name];
			wraps.push([obj, name, orig]);
			obj[name] = function (...a) {
				const t0 = performance.now();
				try { return stub ? undefined : orig.apply(this, a); } finally { if (cur) cur[key] += performance.now() - t0; }
			};
		};
		const origRepaint = overlay.repaint, origSchedule = overlay.scheduleRepaint;
		overlay.scheduleRepaint = function (...a) { if (pendingAt === null) pendingAt = performance.now(); return origSchedule.apply(this, a); };
		const noExtent = arm === "no-extent";
		timeOn(overlay, "syncBand", "bandMs");
		timeOn(overlay, "syncCamera", "camMs");
		timeOn(overlay, "paintCommittedWork", "paintMs");
		timeOn(overlay, "updateExtent", "extentMs", noExtent);
		timeOn(overlay, "redrawSelectionUI", "selMs");
		const idx = overlay.strokeIndex, origRebuild = idx.rebuild;
		idx.rebuild = function (...a) { const t0 = performance.now(); try { return noExtent ? undefined : origRebuild.apply(this, a); } finally { if (cur) { cur.rebuilds++; cur.rebuildMs += performance.now() - t0; } } };
		timeOn(overlay, "releaseWetIfIdle", "releaseMs");
		overlay.repaint = function (...a) {
			const t0 = performance.now();
			const last = overlay.lastPaintCam ? { ...overlay.lastPaintCam } : null;
			cur = { phase, t: t0, requested: pendingAt, waited: pendingAt === null ? 0 : t0 - pendingAt, ms: 0, bandMs: 0, camMs: 0, paintMs: 0, extentMs: 0, selMs: 0, releaseMs: 0,
				rebuilds: 0, rebuildMs: 0, imgN: img.n, imgMs: img.ms, wetSizes: sizes.get(overlay.wetCanvas) || 0, scale: 0, last, cam: null, scrollLeft: 0, scrollTop: 0 };
			pendingAt = null;
			const row = cur;
			try { return origRepaint.apply(this, a); } finally {
				row.ms = performance.now() - t0;
				row.end = performance.now();
				row.imgN = img.n - row.imgN; row.imgMs = img.ms - row.imgMs;
				row.wetSizes = (sizes.get(overlay.wetCanvas) || 0) - row.wetSizes;
				row.scale = overlay.scale; row.cam = overlay.lastPaintCam ? { ...overlay.lastPaintCam } : null;
				row.scrollLeft = sd.scrollLeft; row.scrollTop = sd.scrollTop;
				row.carried = !!overlay.bandCarriedThisFrame;
				rows.push(row); cur = null;
			}
		};
		// The scroll handler's own pre-repaint work (releaseWetIfIdle) lands in a pseudo-row per event.
		const onScroll = () => scrolls.push({ phase, t: performance.now(), left: sd.scrollLeft, top: sd.scrollTop });
		sd.addEventListener("scroll", onScroll);
		const read = () => { const b = overlay.overscrollBounceReadout(); return { active: b.active, fling: router.flingRaf !== 0 }; };
		performance.clearMarks();
		const begin = performance.now();
		mark("si:down");
		finger("pointerdown", 0, 1);
		phase = "drag";
		for (let i = 1; i <= 16; i++) { await new Promise(res => setTimeout(res, 16)); finger("pointermove", -18.75 * i, 1); }
		mark("si:lift");
		phase = "coast";
		finger("pointerup", -300, 0);
		let ended = -1;
		for (let j = 0; j < 160; j++) {
			await rendered();
			const f = read();
			if (!f.active && !f.fling) { ended = j; break; }
		}
		phase = "tail";
		for (let i = 0; i < 4; i++) await rendered();
		mark("si:end");
		sd.removeEventListener("scroll", onScroll);
		overlay.repaint = origRepaint; overlay.scheduleRepaint = origSchedule; idx.rebuild = origRebuild;
		for (const [o, n, f] of wraps.reverse()) o[n] = f;
		// The probe's marks, matched to the repaint they were written inside.
		const marks = performance.getEntriesByType("mark").filter(m => m.name.startsWith("hw:")).map(m => ({ name: m.name, t: m.startTime }));
		for (const row of rows) {
			const m = marks.find(k => k.name.startsWith("hw:repaint") && k.t >= row.t && k.t <= row.end);
			row.mark = m ? m.name : null;
			row.probeWait = m && row.requested !== null ? m.t - row.requested : null;
			const w = m ? /work=([^ ]+(?: rect)?)/.exec(m.name) : null;
			row.work = w ? w[1] : null;
			row.band = m ? (/band=(\\w+)/.exec(m.name) || [])[1] || null : null;
			row.t -= begin; row.end -= begin; if (row.requested !== null) row.requested -= begin;
		}
		await settle(4);
		const inkPxEnd = inkInView();
		return { arm, rows, scrolls: scrolls.map(s => ({ ...s, t: s.t - begin })), ended, inkPxStart, inkPxEnd, end: { left: sd.scrollLeft, top: sd.scrollTop },
			hwScrollMarks: marks.filter(m => m.name.startsWith("hw:scroll")).length, hwRepaintMarks: marks.filter(m => m.name.startsWith("hw:repaint")).length };
	},
};
`;

/** The lag rig's flags (LazyHighlightPairTrace.test.ts): a GPU canvas, the kind the device draws with. */
const GPU_ARGS = process.platform === "win32" ? ["--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--use-angle=d3d11"] : [];
let browser: Browser, script: string;
const record: unknown[] = [];

beforeAll(async () => {
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "scrollInkPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true, args: GPU_ARGS });
}, 180_000);
afterAll(async () => {
	await browser?.close();
	if (process.env.HW_SCROLLINK_OUT) writeFileSync(process.env.HW_SCROLLINK_OUT, JSON.stringify(record, null, 1));
});

const call = (p: Page, method: string, ...args: unknown[]) => p.evaluate(([m, a]) => (window as any).scrollInk[m](...a), [method, args] as const);

type Row = { phase: string; t: number; waited: number; probeWait: number | null; ms: number; bandMs: number; camMs: number; paintMs: number; extentMs: number;
	selMs: number; releaseMs: number; rebuilds: number; rebuildMs: number; imgN: number; imgMs: number; wetSizes: number; scale: number; mark: string | null; work: string | null; band: string | null; carried: boolean;
	scrollLeft: number; scrollTop: number; last: { x: number; y: number; zoom: number } | null; cam: { x: number; y: number; zoom: number } | null };

const f2 = (n: number | null) => n === null ? "-" : String(Math.round(n * 100) / 100);
const camDelta = (r: Row) => !r.last || !r.cam ? "first" : `dx ${r.cam.x - r.last.x} dy ${r.cam.y - r.last.y} dz ${r.cam.zoom - r.last.zoom}`;
function table(rows: Row[]) {
	return rows.map((r, i) => `${String(i).padStart(2)} ${r.phase.padEnd(5)} ${f2(r.t).padStart(7)} x=${Math.round(r.scrollLeft)} y=${Math.round(r.scrollTop)} work=${r.work} band=${r.band}${r.band === "moved" ? (r.carried ? " carried" : " bare") : ""}` +
		` probeWait ${f2(r.probeWait)} (wait ${f2(r.waited)} + own ${f2(r.ms)}): paint ${f2(r.paintMs)} cam ${f2(r.camMs)} band ${f2(r.bandMs)} extent ${f2(r.extentMs)} sel ${f2(r.selMs)}` +
		` rebuild ${r.rebuilds}/${f2(r.rebuildMs)} readback ${r.imgN}/${f2(r.imgMs)} wetSize ${r.wetSizes} scale ${r.scale} ${camDelta(r)}`).join("\n");
}
const SCROLL_PHASES = ["down", "drag", "coast", "tail"];

const ALL_ARMS = ["clean", "epsilon", "wet-held", "readback", "no-extent", "zoom-clean", "hostzoom-f17", "hostzoom-f19"] as const;
/** The arms whose band moves must carry: the clean scale, and the scale the host zoom produces by itself. */
const CARRY_ARMS: readonly string[] = ["clean", "hostzoom-f17", "hostzoom-f19"];
const PICK = process.env.HW_SCROLLINK_ARMS ? process.env.HW_SCROLLINK_ARMS.split(",") : null;
if (PICK) for (const a of PICK) if (!(ALL_ARMS as readonly string[]).includes(a)) throw new Error("unknown arm " + a);
const ARMS = PICK ? ALL_ARMS.filter(a => PICK.includes(a)) : ALL_ARMS;
for (const arm of ARMS) {
	it(`${arm}: with ink in view, a still band paints damage only, under 1 ms median` + (CARRY_ARMS.includes(arm) ? ", and every band move carries its pixels and paints under 3 ms" : ""), async () => {
		const page = await browser.newPage({ viewport: { width: 1800, height: 900 }, deviceScaleFactor: 2, hasTouch: true });
		const errors: string[] = [];
		page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
		try {
			const fontPx = arm === "hostzoom-f17" ? 17 : 19;
			await page.setContent(`<!doctype html><body class="theme-dark" style="margin:0; --font-text-size:${fontPx}px; --background-modifier-border:#777777"></body>`);
			await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
			await page.addStyleTag({ content: MINIMAL_CSS });
			await page.addScriptTag({ content: script });
			const mounted = await call(page, "mount", arm, SIDECAR, PAGE_ID) as any;
			const r = await call(page, "fling", arm) as any;
			const rows = (r.rows as Row[]).filter(x => SCROLL_PHASES.includes(x.phase));
			const moved = (x: Row) => x.band === "moved";
			const still = rows.filter(x => !moved(x));
			const allStill = still.filter(x => x.work === "all");
			const camMoved = (x: Row) => !!x.last && !!x.cam && (x.cam.x !== x.last.x || x.cam.y !== x.last.y || x.cam.zoom !== x.last.zoom);
			const movedStill = still.filter(camMoved);
			const moves = rows.filter(moved);
			const bare = moves.filter(x => !x.carried || x.work === "all");
			const slowMoves = moves.filter(x => x.paintMs >= timingBound(3));
			const med = (a: number[]) => { const s = [...a].sort((p, q) => p - q); return s.length ? s[Math.floor(s.length / 2)]! : 0; };
			const summary = { arm, scale: mounted.scale, cssScale: mounted.cssScale, repaints: rows.length, scrollEvents: r.scrolls.length, stillAll: allStill.length, stillCamMoved: movedStill.length, still: still.length,
				moves: moves.length, bareMoves: bare.length, slowMoves: slowMoves.length, medianProbeWaitStill: f2(med(still.map(x => x.probeWait ?? 0))), medianPaintStill: f2(med(still.map(x => x.paintMs))),
				medianCamStill: f2(med(still.map(x => x.camMs))), medianExtentStill: f2(med(still.map(x => x.extentMs))), readbacks: rows.reduce((s, x) => s + x.imgN, 0),
				wetSizes: rows.reduce((s, x) => s + x.wetSizes, 0), inkPxStart: r.inkPxStart, inkPxEnd: r.inkPxEnd };
			record.push({ summary, mounted, ended: r.ended, end: r.end, hwScrollMarks: r.hwScrollMarks, hwRepaintMarks: r.hwRepaintMarks, rows: r.rows, scrolls: r.scrolls });
			const brief = `\nSUMMARY ${JSON.stringify(summary)}\nMOUNTED ${JSON.stringify(mounted)}\n${table(r.rows as Row[])}`;
			console.log(brief);
			expect(errors).toEqual([]);
			// PREMISES: the note's 1527 strokes; canvas on; the arm's scale; the fling moved the scroller; repaints ran with marks; ink in view.
			expect(mounted.strokes, "premise: 1527 strokes").toBe(1527);
			expect(mounted.canvasMode, "premise: canvas on").toBe(true);
			expect(mounted.refFontPx, "premise: the note's reference font").toBe(17);
			if (arm === "hostzoom-f17") expect(Math.abs(mounted.scale - 19 / 17), `premise: 19/17 through the measured path${brief}`).toBeLessThan(1e-3);
			else if (arm === "hostzoom-f19") expect(Math.abs(mounted.scale - (19 / 17) ** 2), `premise: (19/17)^2 through the measured path${brief}`).toBeLessThan(1e-3);
			else expect(mounted.scale, `premise: the arm's scale${brief}`).toBe(arm === "epsilon" || arm === "no-extent" ? 1.1176426850344592 : 19 / 17);
			if (arm === "zoom-clean") expect(mounted.zoomHost, "premise: the zoom host is engaged").toBe(true);
			expect(mounted.wetReleaseOff, "premise: the arm's wet switch").toBe(arm === "wet-held");
			expect(Math.abs(r.end.left), `premise: the fling moved the scroller${brief}`).toBeGreaterThan(100);
			expect(r.scrolls.length, `premise: scroll events fired${brief}`).toBeGreaterThanOrEqual(10);
			expect(rows.length, `premise: the fling repainted${brief}`).toBeGreaterThanOrEqual(5);
			expect(rows.every(x => x.mark !== null), `premise: every repaint wrote its probe mark${brief}`).toBe(true);
			expect(Math.min(r.inkPxStart, r.inkPxEnd), `premise: ink in view at both ends of the fling${brief}`).toBeGreaterThan(1000);
			// THE CLAIMS. A still band paints damage only, at the camera it last painted, and cheaply.
			if (arm !== "readback") expect(allStill.map(x => `t ${f2(x.t)} x=${Math.round(x.scrollLeft)} probeWait ${f2(x.probeWait)} paint ${f2(x.paintMs)} ${camDelta(x)}`),
				`still-band repaints that painted "all"${brief}`).toEqual([]);
			expect(movedStill.map(x => `t ${f2(x.t)} x=${x.scrollLeft} y=${x.scrollTop} last ${JSON.stringify(x.last)} cam ${JSON.stringify(x.cam)}`),
				`still-band repaints whose camera moved${brief}`).toEqual([]);
			expect(med(still.map(x => x.paintMs)), `median paint of the still-band repaints, ms${brief}`).toBeLessThan(1);
			if (CARRY_ARMS.includes(arm)) {
				expect(moves.length, `premise: the fling moved the band at least three times${brief}`).toBeGreaterThanOrEqual(3);
				// THE CARRY: every band move carries its pixels and keeps them, and so paints only the strips it uncovers.
				expect(bare.map(x => `t ${f2(x.t)} x=${Math.round(x.scrollLeft)} ${x.carried ? "carried, then painted" : "bare move, painted"} ${x.work} in ${f2(x.paintMs)} ms ${camDelta(x)}`),
					`band moves that lost the carry${brief}`).toEqual([]);
				expect(slowMoves.map(x => `t ${f2(x.t)} x=${Math.round(x.scrollLeft)} work=${x.work} paint ${f2(x.paintMs)} ms`),
					`band moves that painted for 3 ms or more${brief}`).toEqual([]);
			}
		} finally { await page.close(); }
	}, 240_000);
}
