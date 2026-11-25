/**
 * A FINGER RESTING ON A SELECTION THROUGH A WHEEL OR TOUCHPAD ZOOM KEEPS THE SELECTION AND DRAGS IT WITH NO JUMP.
 *
 * A finger that lands alone on the selection waits on the tap limit; past it the selection claims the finger from where
 * it landed. A ctrl+wheel or touchpad zoom can run in between, with the other hand. The claim ends the run, and that end
 * commits the zoom, which can write the scroll and move the overlay band. The finger never moved off the selection the
 * user touched, so the selection must stay taken, the finger must never ink, and the drag must follow the finger from
 * the claim: the selection moves by the finger's travel through the page as it stands after the commit.
 *
 * Every contact is a script-made PointerEvent dispatched at the element under the point, through the real router on a
 * real CodeMirror note with the real overlay and Infinite Canvas on; every wheel event is a real WheelEvent with ctrlKey
 * on the scroller, one per frame. The page records, without changing what it records: the hook's run state, scroll and
 * band place on both sides; what the surface was handed at the claim and its mode then; the world point under the
 * landing point and under the move point through the band's place as it stands after the surface took the contact;
 * and the selected stroke's stored points before and after.
 *
 *   C5a: land, then a small zoom (dy -10: scale 1.05, settle scroll 34, 25), then past the tap limit. Kept, no jump.
 *   C5b: the same with a larger zoom (dy -90: scale 1.57, scroll 254, 187, the band moves). Kept, no jump.
 *   C5c: no run. The claim and the drag's first step are today's (pin).
 *   C6:  the run is live when the finger lands, at the point where the selection shows on screen. Kept, no jump.
 *   C5d: C5b held about a point away from the finger, so the page under the resting finger moves. Kept, no jump.
 *   F3:  C5b with the lasso tip mode on. Kept, no jump.
 *   F5:  the selection cleared during the wait: the finger is swallowed, no loop, no ink, nothing moves (pin).
 *   F6:  C5b's claim, then a pen lands mid-drag: the selection goes back where it started.
 *   F7:  no run, the page scrolled under the resting finger: the claim and the first step are today's (pin).
 *   (The F-cells are numbered as in the read of this code before the fix; C5a to C5d as first measured.)
 *
 * R70-A1: the run ends by itself first. The finger waits 400 ms after the last wheel event, past the run's quiet time,
 * so the run's own timer commits the zoom before the finger passes the tap limit and the claim's hook has nothing to end.
 * The wait moves the page's clock on and fires the timers that fall due (installClock), never a real sleep.
 *   C5a-w, C5b-w, C5d-w: C5a, C5b and C5d with the wait. Kept, no jump.
 *   C6-w, C6s-w: C6 both ways (the finger lands during the live run) with the wait. Kept, no jump.
 *   C5c-w: no run, the same wait: the claim and the drag's first step are today's (pin).
 *   F7-w: F7 with a zero-travel run (dy 0, 3 events) that ends by itself in the wait and leaves the camera where it
 *         was: the claim and the drag's first step are today's (pin).
 *
 * Each premise is its own expect, so a throw or a missing row cannot pass a cell. HW_SELFINGER_OUT=<file> writes every
 * row as JSON. Run: npm run test:render. Not in `npx vitest run`.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

declare const process: { env: Record<string, string | undefined> };

const PAGE = `
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { Platform } from "obsidian";
import { inlineInk, inkOverlayExtension, overlayForPath, setInlineTool, setScrollExpansionEnabled } from "../../src/inline/InkOverlay";
import { setPenInk } from "../../src/inline/PenInk";
import { setTipMode, tipMode } from "../../src/inline/TipMode";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField } from "./iphoneObsidianStub";
import { parsePage, serializePage } from "../../src/model/PageData";

Object.assign(Platform, { isMobile: false, isDesktop: true, isIosApp: false, isAndroidApp: false, isDesktopApp: true, isMobileApp: false, isPhone: false, isTablet: false, isWin: true });
installObsidianDom();
const ids = new Map(), sidecars = new Map();
const save = (id, page) => { sidecars.set(id, serializePage(page)); };
inlineInk.attachHost({ readPageId: p => ids.get(p) ?? null, claimId: async (p, id) => { ids.set(p, id); return { pageId: id }; },
	loadSidecar: async id => (sidecars.has(id) ? parsePage(sidecars.get(id), id) : null), scheduleSidecar: save, scheduleSidecarNow: async (id, p) => save(id, p), notify: () => {} });

const PATH = "selection-finger.md";
const frame = () => new Promise(r => requestAnimationFrame(() => r()));
const frames = (n) => (n <= 0 ? Promise.resolve() : frame().then(() => frames(n - 1)));
const realRect = Element.prototype.getBoundingClientRect;
let rig = null;
let stamp = 0;

/**
 * A wait with no real time (R70-A1 cells only). installClock puts the page's clock ahead by \`skew\` and keeps every
 * timer armed after it; advance(ms) moves the clock on by ms and fires, in their order, the timers that fall due by then,
 * including any a fired one arms. Nothing else changes: a timer not fired by advance still fires on its own real time.
 */
let skew = 0;
let clock = null;
function installClock() {
	if (clock) return;
	const realNow = performance.now.bind(performance), realSet = window.setTimeout.bind(window), realClear = window.clearTimeout.bind(window);
	const due = new Map();
	performance.now = () => realNow() + skew;
	window.setTimeout = (fn, ms = 0, ...a) => {
		const id = realSet(() => { due.delete(id); fn(...a); }, ms);
		due.set(id, { at: performance.now() + ms, fn: () => fn(...a) });
		return id;
	};
	window.clearTimeout = (id) => { due.delete(id); realClear(id); };
	clock = { due, realClear };
}
function advance(ms) {
	skew += ms;
	const until = performance.now();
	let fired = 0;
	const next = () => [...clock.due].filter(([, t]) => t.at <= until).sort((p, q) => p[1].at - q[1].at)[0];
	let n = next();
	while (n) {
		clock.due.delete(n[0]);
		clock.realClear(n[0]);
		n[1].fn();
		fired += 1;
		n = next();
	}
	return fired;
}

const ev = (type, pointerType, id, x, y, buttons) => {
	const touch = pointerType === "touch";
	const e = new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerType, pointerId: id, isPrimary: true,
		clientX: x, clientY: y, buttons, button: type === "pointermove" ? -1 : 0, pressure: buttons ? 0.5 : 0, width: touch ? 8 : 1, height: touch ? 8 : 1 });
	stamp = Math.max(e.timeStamp + skew, stamp + 1);
	Object.defineProperty(e, "timeStamp", { value: stamp });
	return e;
};
const send = (e) => {
	const t = document.elementFromPoint(e.clientX, e.clientY);
	if (!t || !rig.view.scrollDOM.contains(t)) throw new Error("contact misses the scroller at " + e.clientX + "," + e.clientY);
	t.dispatchEvent(e);
};
const wheel = (dy, x, y) => {
	const e = new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: dy, deltaMode: 0, clientX: x, clientY: y });
	rig.view.scrollDOM.dispatchEvent(e);
	return e.defaultPrevented;
};
const wheelRun = (dy, steps, x, y, prevented, i = 0) =>
	i >= steps ? Promise.resolve() : (prevented.push(wheel(dy / steps, x, y)), frame().then(() => wheelRun(dy, steps, x, y, prevented, i + 1)));
const pt = (p) => ({ x: p.x, y: p.y });

/** The world point under a client point through the band's place as it stands now, by the router's own mapping. */
function worldAt(x, y) {
	const o = rig.overlay, router = o.router, saved = router.rect;
	router.rect = realRect.call(router.rectEl);
	try {
		const m = router.sampleFrom({ clientX: x, clientY: y, pointerType: "touch", pressure: 0.5, tiltX: 0, tiltY: 0, timeStamp: performance.now() });
		return pt(o.camera.screenToWorld(m.x, m.y));
	} finally { router.rect = saved; }
}
/** The client point over a world point now: the mapping is affine per axis, so two reads solve it. */
function clientOf(w) {
	const a = worldAt(0, 0), b = worldAt(100, 100);
	return { x: (w.x - a.x) * 100 / (b.x - a.x), y: (w.y - a.y) * 100 / (b.y - a.y) };
}

function instrument() {
	const o = rig.overlay, router = o.router, band = router.rectEl, sc = rig.view.scrollDOM;
	const proto = Object.getPrototypeOf(o);
	const st = (rig.st = { hook: null, syncs: null, down: null, want: [] });
	const box = () => { const r = realRect.call(band); return { left: r.left, top: r.top, width: r.width, height: r.height }; };
	o.syncBand = function (...a) { const r = proto.syncBand.apply(this, a); if (st.syncs) st.syncs.push(r); return r; };
	o.beforePenDown = function () {
		const cam = () => { const c = o.camera.snapshot; return { x: c.x, y: c.y, zoom: c.zoom }; };
		const pan = () => { const p = router.originPan?.(); return p ? { x: p.x, y: p.y } : null; };
		const h = { live: !!this.wheelZoomRun?.isLive, preview: !!this.pinchPreview, k0: router.scaleProvider(), scroll0: [sc.scrollLeft, sc.scrollTop], band0: box(), cam0: cam(), pan0: pan(), cached0: [router.rect.left, router.rect.top], syncs: [] };
		st.syncs = h.syncs;
		try { proto.beforePenDown.call(this); } finally { st.syncs = null; }
		Object.assign(h, { k1: router.scaleProvider(), scroll1: [sc.scrollLeft, sc.scrollTop], band1: box(), cam1: cam(), pan1: pan() });
		// The finger's claim is the first hook; a pen landing later runs its own.
		if (!st.hook) st.hook = h;
	};
	const cb = router.cb, realDown = cb.onPenDown;
	cb.onPenDown = function (s, e) {
		const r = realDown.call(this, s, e);
		// The claimed contact is the first down; a pen landing later is its own.
		if (!st.down) st.down = { type: e.pointerType, handed: pt(s), handedWorld: pt(o.camera.screenToWorld(s.x, s.y)), k: router.scaleProvider(),
			expected: st.want.map(([x, y]) => worldAt(x, y)), mode: o.mode, onSelection: !!o.fingerOnSelection, lassoActive: !!o.lassoActive,
			dragFrom: o.dragFrom ? pt(o.dragFrom) : null, selected: o.selection.size,
			transformFrom: o.spaceSnapshot?.transform ? pt(o.spaceSnapshot.transform.gesture.from) : null, handle: o.spaceSnapshot?.transform?.gesture.handle ?? null };
		return r;
	};
}

/** One pen stroke through (ax, ay), selected. Returns its id and stored points. */
async function selectedStroke(ax, ay) {
	const o = rig.overlay, router = o.router;
	send(ev("pointerdown", "pen", 41, ax - 60, ay, 1));
	send(ev("pointermove", "pen", 41, ax, ay + 6, 1));
	send(ev("pointermove", "pen", 41, ax + 60, ay, 1));
	send(ev("pointerup", "pen", 41, ax + 60, ay, 0));
	await frames(4);
	const all = inlineInk.strokes(PATH);
	const stroke = all[all.length - 1];
	o.selection.selectExactly([stroke.id]);
	o.redrawSelectionUI?.();
	// The pen stays away: the palm gate's tails after the pen are taken as past, as a real wait past them would leave them.
	router.gate.lastPenContactEnd = -Infinity;
	router.gate.lastPenHover = -Infinity;
	await frames(2);
	router.refreshRect();
	return { id: stroke.id, pts: stroke.points.map(pt), count: all.length };
}

window.selFinger = {
	async mount(opts = {}) {
		setScrollExpansionEnabled(true);
		setPenInk(true);
		setInlineTool("pen"); setTipMode("nib");
		const pane = document.body.appendChild(document.createElement("div"));
		pane.className = "markdown-source-view mod-cm6";
		pane.style.cssText = "position:relative;margin-left:60px;margin-top:40px;width:1000px;height:760px;overflow:hidden";
		const text = Array.from({ length: 200 }, (_, i) => "line " + (i + 1) + " some words on the line").join("\\n");
		const view = new EditorView({ parent: pane, state: EditorState.create({ doc: text, extensions: [history(), EditorView.lineWrapping,
			editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path: PATH }, editor: {} })), inkOverlayExtension(),
			EditorView.theme({ "&": { width: "1000px", height: "760px" }, ".cm-scroller": { overflowY: "auto" }, ".cm-content": { fontSize: "18px", lineHeight: "28px" } })] }) });
		// Obsidian's shape: the content inside .cm-sizer, which a zoom preview pans so it shows the page as its commit will.
		// Without it the preview is scale-only and the commit's scroll moves the page (InkOverlayPanSettle.ts anchorPanTo).
		if (opts.sizer) {
			const sizer = document.createElement("div"); sizer.className = "cm-sizer";
			const container = document.createElement("div"); container.className = "cm-contentContainer";
			view.contentDOM.parentElement.insertBefore(sizer, view.contentDOM); sizer.appendChild(container); container.appendChild(view.contentDOM);
			void view.scrollDOM.clientWidth;
		}
		await frames(12);
		const overlay = overlayForPath(PATH);
		if (!overlay) throw new Error("no overlay for " + PATH);
		rig = { pane, view, overlay };
		instrument();
		const r = pane.getBoundingClientRect();
		return { pane: { left: r.left, top: r.top, width: r.width, height: r.height }, canvasMode: overlay.canvasMode, k: overlay.router.scaleProvider(), sizer: !!view.dom.querySelector(".cm-sizer") };
	},

	/**
	 * A stroke selected, a finger landing at (lx, ly) on it (with landOnShown, where the selection shows after a run that
	 * comes first), a wheel run about (wx, wy) before or after the landing, the finger moving by (dx, dyy) past the tap
	 * limit, and the lift there.
	 */
	async run({ dy, steps, ax, ay, lx = ax, ly = ay, wx = ax, wy = ay, dx, dyy, order, tip = "nib", clearDuringWait = false, scrollDuringWait = 0, penAfterMove = false, landOnShown = false, onHandle = false, waitMs = 0 }) {
		const o = rig.overlay, st = rig.st, router = o.router;
		// Before the run arms its quiet timer, so the wait can fire it.
		if (waitMs) installClock();
		const sel = await selectedStroke(ax, ay);
		const w0 = worldAt(ax, ay);
		let handleAt = null;
		if (onHandle) {
			// A point on the bottom-right corner's handle (a finger's hit square), off the padded box's inside.
			const b = o.selectionBounds();
			for (let r = 0; r <= 30 && !handleAt; r += 1) {
				const w = { x: b.x + b.width + r, y: b.y + b.height + r };
				if (o.transformHandleAt(w, "touch") !== null) handleAt = w;
			}
			if (!handleAt) throw new Error("no handle found by the corner");
			const c = clientOf(handleAt); lx = c.x; ly = c.y;
		}
		setTipMode(tip);
		// Lighting the eraser lets go of the selection (the tip listener's dissolve), as on a device; select it again with the
		// eraser lit, as a pasted or tapped selection stands then.
		if (tip === "eraser" && o.selection.isEmpty) { o.selection.selectExactly([sel.id]); o.redrawSelectionUI?.(); await frames(2); }
		const fingerInk = !!router.cb.fingerInk?.();
		const claimsBefore = !!router.cb.claimTouch?.(router.sampleFrom({ clientX: lx, clientY: ly, pointerType: "touch", pressure: 0.5, tiltX: 0, tiltY: 0, timeStamp: performance.now() }));
		const k0 = router.scaleProvider();
		const prevented = [];
		if (order === "run-then-land") await wheelRun(dy, steps, wx, wy, prevented);
		// The point where the selection shows now, through the frame the ink is painted in (the router's own mapping, the
		// preview's pan included): the world point first under (ax, ay).
		let shown = null;
		if (landOnShown) { const c = clientOf(w0); lx = c.x; ly = c.y; shown = { client: c, back: worldAt(c.x, c.y), w0 }; }
		const liveAtLand = !!o.wheelZoomRun?.isLive;
		st.hook = null; st.down = null; st.want = [[lx, ly], [lx + dx, ly + dyy]];
		const landCam = (() => { const c = o.camera.snapshot; return { x: c.x, y: c.y, zoom: c.zoom, k: router.scaleProvider(), rect: [router.rect.left, router.rect.top], fresh: (() => { const r = realRect.call(router.rectEl); return [r.left, r.top]; })(), pan: { ...(router.originPan?.() ?? {}) }, world: worldAt(lx, ly),
			vp: o.viewportPan ? { ...o.viewportPan } : null, rp: o.rasterPan ? { ...o.rasterPan } : null, pio: [o.previewInkOffset, o.previewInkOffsetY], panXY: [o.panX?.(), o.panY?.()], inkPan: [o.inkPanX?.(), o.inkPanY?.()],
			scroll: [rig.view.scrollDOM.scrollLeft, rig.view.scrollDOM.scrollTop], engaged: o.previewPanEngaged }; })();
		send(ev("pointerdown", "touch", 91, lx, ly, 1));
		const claimedAtLand = st.down !== null;
		if (clearDuringWait) { o.selection.clear(); o.redrawSelectionUI?.(); await frames(1); }
		let scrolledBy = 0;
		if (scrollDuringWait) { const sc = rig.view.scrollDOM, t0 = sc.scrollTop; sc.scrollTop = t0 + scrollDuringWait; await frames(6); scrolledBy = sc.scrollTop - t0; }
		if (order === "land-then-run") await wheelRun(dy, steps, wx, wy, prevented);
		// The finger rests past the run's quiet time: the run's own timer ends it, then a few frames run as they would.
		let wait = null;
		if (waitMs) {
			const sc = rig.view.scrollDOM, cam = () => { const c = o.camera.snapshot; return { x: c.x, y: c.y, zoom: c.zoom }; };
			const w = { ms: waitMs, liveBefore: !!o.wheelZoomRun?.isLive, cam0: cam(), scroll0: [sc.scrollLeft, sc.scrollTop], k0: router.scaleProvider() };
			w.fired = advance(waitMs);
			w.liveAfterFire = !!o.wheelZoomRun?.isLive;
			await frames(6);
			wait = Object.assign(w, { cam1: cam(), scroll1: [sc.scrollLeft, sc.scrollTop], k1: router.scaleProvider() });
		}
		const liveBeforeMove = !!o.wheelZoomRun?.isLive;
		send(ev("pointermove", "touch", 91, lx + dx, ly + dyy, 1));
		const atMove = { swallowed: router.swallowedTouches?.has(91) ?? null, active: router.activePenId, mode: o.mode, lassoActive: !!o.lassoActive };
		let afterPen = null;
		if (penAfterMove) {
			// A pen landing away from the selection while the finger holds it: the finger's drag is cancelled.
			router.gate.lastPenContactEnd = -Infinity;
			send(ev("pointerdown", "pen", 42, lx - 200, ly - 150, 1));
			const mid = inlineInk.strokes(PATH).find(s => s.id === sel.id);
			afterPen = { mode: o.mode, selected: o.selection.size, pts: mid ? mid.points.map(pt) : null };
			send(ev("pointerup", "pen", 42, lx - 200, ly - 150, 0));
		}
		send(ev("pointerup", "touch", 91, lx + dx, ly + dyy, 0));
		await frames(4);
		const all = inlineInk.strokes(PATH);
		const after = all.find(s => s.id === sel.id);
		return { order, tip, fingerInk, landCam, shown, handleAt, claimsBefore, k0, prevented, liveAtLand, liveBeforeMove, claimedAtLand, scrolledBy, wait, atMove, afterPen, hook: st.hook, down: st.down,
			before: sel.pts, after: after ? after.points.map(pt) : null, strokesAdded: all.length - sel.count, selectedAfter: o.selection.size, tipAfter: tipMode() };
	},
};
`;

const OUT = process.env.HW_SELFINGER_OUT;
/** World px. Stored points are rounded to hundredths. */
const TOL = 0.02;

let browser: Browser;
let script = "";
const rows: unknown[] = [];

beforeAll(async () => {
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "selFingerPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./fingerArmObsidian.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);

afterAll(async () => {
	await browser?.close();
	if (OUT) writeFileSync(OUT, JSON.stringify(rows, null, 1));
});

type Pt = { x: number; y: number };
type Box = { left: number; top: number; width: number; height: number };
type Hook = { live: boolean; preview: boolean; k0: number; k1: number; scroll0: number[]; scroll1: number[]; band0: Box; band1: Box; syncs: string[] };
type Down = { type: string; handed: Pt; handedWorld: Pt; k: number; expected: Pt[]; mode: string; onSelection: boolean; lassoActive: boolean; dragFrom: Pt | null; selected: number; transformFrom: Pt | null; handle: string | null };
type Row = {
	order: string; tip: string; fingerInk: boolean; claimsBefore: boolean; k0: number; prevented: boolean[]; liveAtLand: boolean; liveBeforeMove: boolean; claimedAtLand: boolean; scrolledBy: number;
	atMove: { swallowed: boolean | null; active: number | null; mode: string; lassoActive: boolean }; afterPen: { mode: string; selected: number; pts: Pt[] | null } | null;
	hook: Hook | null; down: Down | null; before: Pt[]; after: Pt[] | null; strokesAdded: number; selectedAfter: number;
	wait: Wait | null; tipAfter: string;
};
type Cam = { x: number; y: number; zoom: number };
type Wait = { ms: number; liveBefore: boolean; fired: number; liveAfterFire: boolean; cam0: Cam; cam1: Cam; scroll0: number[]; scroll1: number[]; k0: number; k1: number };
type Mount = { pane: { left: number; top: number; width: number; height: number }; canvasMode: boolean; k: number; sizer: boolean };

const call = (p: Page, method: string, ...args: unknown[]) => p.evaluate(([m, a]) => (window as any).selFinger[m](...a), [method, args] as const) as Promise<any>;

async function withPage<T>(fn: (page: Page, m: Mount) => Promise<T>, sizer = false): Promise<T> {
	const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 });
	try {
		await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
		await page.addScriptTag({ content: script });
		const m = (await call(page, "mount", { sizer })) as Mount;
		expect(m.canvasMode, "premise: Infinite Canvas on").toBe(true);
		return await fn(page, m);
	} finally {
		await page.close();
	}
}

function log(cell: string, row: unknown): void {
	rows.push({ cell, row });
	console.log(`SELFINGER ${cell} ${JSON.stringify(row)}`);
}

const scrolled = (h: Hook) => Math.max(Math.abs(h.scroll1[0]! - h.scroll0[0]!), Math.abs(h.scroll1[1]! - h.scroll0[1]!));
const bandMoved = (h: Hook) => h.syncs.includes("moved");
const at = (m: Mount, fx: number, fy: number) => ({ x: m.pane.left + m.pane.width * fx, y: m.pane.top + m.pane.height * fy });
/** The finger's travel past the tap limit, client px. */
const D = { dx: 20, dyy: -30 };
const SMALL = { dy: -10, steps: 3, fx: 0.7, fy: 0.68 };
const LARGE = { dy: -90, steps: 3, fx: 0.7, fy: 0.68 };

/**
 * The selection stays taken, the finger never inks, and the stroke moves by the finger's travel over the scale the
 * page stands at after the claim: every stored point shifted by d / k, the same for each point.
 */
function expectKeptNoJump(row: Row, label: string): void {
	expect(row.fingerInk, `premise (${label}): finger ink is off (a Surface)`).toBe(false);
	expect(row.claimedAtLand, `premise (${label}): nothing claimed the finger at the landing`).toBe(false);
	expect(row.down, `${label}: the surface took the finger past the tap limit`).not.toBeNull();
	expect(row.down!.type, `premise (${label}): the surface took a finger`).toBe("touch");
	expect(row.down!.mode, `${label}: the finger takes the selection (mode at the claim)`).toBe("lasso");
	expect(row.down!.onSelection, `${label}: the finger is on the selection at the claim`).toBe(true);
	expect(row.down!.selected, `${label}: the selection is kept at the claim`).toBe(1);
	expect(row.down!.lassoActive, `${label}: no new lasso loop at the claim`).toBe(false);
	expect(row.down!.dragFrom, `${label}: a drag starts at the claim`).not.toBeNull();
	expect(row.atMove.lassoActive, `${label}: no lasso loop after the first move`).toBe(false);
	expect(row.selectedAfter, `${label}: the selection is still there after the lift`).toBe(1);
	expect(row.strokesAdded, `${label}: no stroke drawn`).toBe(0);
	expect(row.after, `premise (${label}): the selected stroke is still stored`).not.toBeNull();
	expect(row.after!.length, `premise (${label}): same point count`).toBe(row.before.length);
	const k = row.down!.k;
	for (let i = 0; i < row.before.length; i++) {
		const b = row.before[i]!, a = row.after![i]!;
		expect(Math.abs(a.x - b.x - D.dx / k), `${label}: point ${i} moved by the finger's travel over the scale, x (no jump)`).toBeLessThanOrEqual(TOL);
		expect(Math.abs(a.y - b.y - D.dyy / k), `${label}: point ${i} moved by the finger's travel over the scale, y (no jump)`).toBeLessThanOrEqual(TOL);
	}
}

function expectSettled(row: Row, label: string): void {
	if (row.order === "land-then-run") expect(row.claimsBefore, `premise (${label}): the selection takes a finger at the landing point before any run`).toBe(true);
	expect(row.prevented.every(Boolean), `premise (${label}): every wheel event was the zoom's`).toBe(true);
	expect(row.hook?.live, `premise (${label}): the claim's hook ended a live run`).toBe(true);
	expect(scrolled(row.hook!), `premise (${label}): the commit wrote the scroll`).toBeGreaterThan(0.5);
}

it("C5a: a finger resting on the selection through a small wheel zoom keeps it and drags it with no jump", async () => {
	await withPage(async (page, m) => {
		const a = at(m, SMALL.fx, SMALL.fy);
		const row = (await call(page, "run", { dy: SMALL.dy, steps: SMALL.steps, ax: a.x, ay: a.y, ...D, order: "land-then-run" })) as Row;
		log("C5a", row);
		expect(row.liveAtLand, "premise: no run at the landing").toBe(false);
		expect(row.liveBeforeMove, "premise: the run is live when the finger passes the tap limit").toBe(true);
		expectSettled(row, "C5a");
		expect(bandMoved(row.hook!), "premise: the band's last step left it in place").toBe(false);
		expectKeptNoJump(row, "C5a");
	});
});

it("C5b: the same through a larger zoom that moves the band keeps the selection and drags it with no jump", async () => {
	await withPage(async (page, m) => {
		const a = at(m, LARGE.fx, LARGE.fy);
		const row = (await call(page, "run", { dy: LARGE.dy, steps: LARGE.steps, ax: a.x, ay: a.y, ...D, order: "land-then-run" })) as Row;
		log("C5b", row);
		expect(row.liveAtLand, "premise: no run at the landing").toBe(false);
		expect(row.liveBeforeMove, "premise: the run is live when the finger passes the tap limit").toBe(true);
		expectSettled(row, "C5b");
		expect(bandMoved(row.hook!), "premise: the commit moved the band").toBe(true);
		expectKeptNoJump(row, "C5b");
	});
});

it("C5c: with no run, a finger on the selection takes it and drags it by its travel, as today (pin)", async () => {
	await withPage(async (page, m) => {
		const a = at(m, SMALL.fx, SMALL.fy);
		const row = (await call(page, "run", { dy: 0, steps: 0, ax: a.x, ay: a.y, ...D, order: "land-then-run" })) as Row;
		log("C5c", row);
		expect(row.claimsBefore, "premise: the selection takes a finger at the landing point").toBe(true);
		expect(row.liveBeforeMove, "premise: no run").toBe(false);
		expect(row.hook?.live, "premise: the hook had nothing to end").toBe(false);
		expect(row.down?.k, "premise: the scale is the mount's").toBe(m.k);
		expectKeptNoJump(row, "C5c");
	});
});

for (const sizer of [false, true]) {
	const tag = sizer ? " (Obsidian's sizer: the preview pans)" : " (no sizer: the preview only scales)";
	it(`C6: a finger landing during a live run where the selection shows keeps it and drags it with no jump${tag}`, async () => {
		await withPage(async (page, m) => {
			expect(m.sizer, "premise: the host shape").toBe(sizer);
			const v = sizer ? LARGE : SMALL, a = at(m, v.fx, v.fy);
			const row = (await call(page, "run", { dy: v.dy, steps: v.steps, ax: a.x, ay: a.y, ...D, order: "run-then-land", landOnShown: true })) as Row;
			log(sizer ? "C6s" : "C6", row);
			const shown = (row as unknown as { shown: { client: Pt; back: Pt; w0: Pt } }).shown;
			expect(Math.abs(shown.back.x - shown.w0.x) + Math.abs(shown.back.y - shown.w0.y), "premise: the solved client point maps back").toBeLessThanOrEqual(TOL);
			expect(row.liveAtLand, "premise: the run is live at the landing").toBe(true);
			expect(row.down, "C6: the selection as the preview shows it took the finger (claimed past the tap limit)").not.toBeNull();
			expectSettled(row, "C6");
			expectKeptNoJump(row, "C6");
		}, sizer);
	});
}

it("C6e (ERASER-FINGER): C6 with the eraser lit: the finger takes the selection as with the nib, erases nothing and drags it with no jump; the eraser stays lit", async () => {
	// C6's claim cell with the eraser lit; want the same first step as with the nib.
	await withPage(async (page, m) => {
		const a = at(m, SMALL.fx, SMALL.fy);
		const row = (await call(page, "run", { dy: SMALL.dy, steps: SMALL.steps, ax: a.x, ay: a.y, ...D, order: "run-then-land", landOnShown: true, tip: "eraser" })) as Row;
		log("C6e", row);
		expect(row.tip, "premise: the eraser is lit").toBe("eraser");
		expect(row.claimsBefore, "premise: the selection stands with the eraser lit").toBe(true);
		expect(row.liveAtLand, "premise: the run is live at the landing").toBe(true);
		expect(row.after, "C6e: the selected stroke is kept (a finger never erases)").not.toBeNull();
		expectSettled(row, "C6e");
		expectKeptNoJump(row, "C6e");
		expect(row.tipAfter, "C6e: the eraser stays lit").toBe("eraser");
	});
});

it("C5b with Obsidian's sizer: the preview pans, the selection is kept and dragged with no jump", async () => {
	await withPage(async (page, m) => {
		expect(m.sizer, "premise: the host has a sizer").toBe(true);
		const a = at(m, LARGE.fx, LARGE.fy);
		const row = (await call(page, "run", { dy: LARGE.dy, steps: LARGE.steps, ax: a.x, ay: a.y, ...D, order: "land-then-run" })) as Row;
		log("C5bs", row);
		expect(row.liveBeforeMove, "premise: the run is live when the finger passes the tap limit").toBe(true);
		expectSettled(row, "C5bs");
		expectKeptNoJump(row, "C5bs");
	}, true);
});

it("C5d: the larger zoom held about a point away from the finger keeps the selection and drags it with no jump", async () => {
	await withPage(async (page, m) => {
		const a = at(m, LARGE.fx, LARGE.fy), w = at(m, 0.35, 0.3);
		const row = (await call(page, "run", { dy: LARGE.dy, steps: LARGE.steps, ax: a.x, ay: a.y, wx: w.x, wy: w.y, ...D, order: "land-then-run" })) as Row;
		log("C5d", row);
		expect(row.liveBeforeMove, "premise: the run is live when the finger passes the tap limit").toBe(true);
		expectSettled(row, "C5d");
		const e = row.down?.expected[0], l = (row as unknown as { landCam: { world: Pt } }).landCam.world;
		expect(e && Math.hypot(e.x - l.x, e.y - l.y), "premise: the page under the resting finger moved").toBeGreaterThan(20);
		expectKeptNoJump(row, "C5d");
	});
});

it("C5h: a finger resting on a corner handle through a zoom held away from it resizes from where it rests (no jump)", async () => {
	await withPage(async (page, m) => {
		const a = at(m, LARGE.fx, LARGE.fy), w = at(m, 0.35, 0.3);
		const row = (await call(page, "run", { dy: LARGE.dy, steps: LARGE.steps, ax: a.x, ay: a.y, wx: w.x, wy: w.y, ...D, order: "land-then-run", onHandle: true })) as Row;
		log("C5h", row);
		expectSettled(row, "C5h");
		expect(row.fingerInk, "premise: finger ink is off (a Surface)").toBe(false);
		expect(row.down, "C5h: the surface took the finger past the tap limit").not.toBeNull();
		expect(row.down!.mode, "C5h: the finger takes the selection (mode at the claim)").toBe("lasso");
		expect(row.down!.selected, "C5h: the selection is kept at the claim").toBe(1);
		expect(row.down!.lassoActive, "C5h: no new lasso loop at the claim").toBe(false);
		expect(row.down!.handle, "C5h: the contact is the handle it landed on").not.toBeNull();
		const e = row.down!.expected[0]!, f = row.down!.transformFrom!;
		expect(Math.hypot(e.x - (row as unknown as { landCam: { world: Pt } }).landCam.world.x, e.y - (row as unknown as { landCam: { world: Pt } }).landCam.world.y), "premise: the page under the resting finger moved").toBeGreaterThan(20);
		expect(Math.abs(f.x - e.x), "C5h: the resize counts from where the finger rests now, x (no jump)").toBeLessThanOrEqual(TOL);
		expect(Math.abs(f.y - e.y), "C5h: the resize counts from where the finger rests now, y (no jump)").toBeLessThanOrEqual(TOL);
		expect(row.strokesAdded, "C5h: no stroke drawn").toBe(0);
		expect(row.selectedAfter, "C5h: the selection is still there after the lift").toBe(1);
	});
});

it("F3d: C5d with the lasso tip mode on keeps the selection and drags it with no jump", async () => {
	await withPage(async (page, m) => {
		const a = at(m, LARGE.fx, LARGE.fy), w = at(m, 0.35, 0.3);
		const row = (await call(page, "run", { dy: LARGE.dy, steps: LARGE.steps, ax: a.x, ay: a.y, wx: w.x, wy: w.y, ...D, order: "land-then-run", tip: "lasso" })) as Row;
		log("F3d", row);
		expect(row.tip, "premise: the lasso tip mode is on").toBe("lasso");
		expectSettled(row, "F3d");
		const e = row.down?.expected[0], l = (row as unknown as { landCam: { world: Pt } }).landCam.world;
		expect(e && Math.hypot(e.x - l.x, e.y - l.y), "premise: the page under the resting finger moved").toBeGreaterThan(20);
		expectKeptNoJump(row, "F3d");
	});
});

it("F3: C5b with the lasso tip mode on keeps the selection and drags it with no jump", async () => {
	await withPage(async (page, m) => {
		const a = at(m, LARGE.fx, LARGE.fy);
		const row = (await call(page, "run", { dy: LARGE.dy, steps: LARGE.steps, ax: a.x, ay: a.y, ...D, order: "land-then-run", tip: "lasso" })) as Row;
		log("F3", row);
		expect(row.tip, "premise: the lasso tip mode is on").toBe("lasso");
		expectSettled(row, "F3");
		expect(bandMoved(row.hook!), "premise: the commit moved the band").toBe(true);
		expectKeptNoJump(row, "F3");
	});
});

it("F5: a selection cleared during the wait, then the zoom: the finger is swallowed, no loop, no ink, nothing moves (pin)", async () => {
	await withPage(async (page, m) => {
		const a = at(m, LARGE.fx, LARGE.fy);
		const row = (await call(page, "run", { dy: LARGE.dy, steps: LARGE.steps, ax: a.x, ay: a.y, ...D, order: "land-then-run", clearDuringWait: true })) as Row;
		log("F5", row);
		expect(row.liveBeforeMove, "premise: the run is live when the finger passes the tap limit").toBe(true);
		expect(row.down, "F5: the surface never took the finger").toBeNull();
		expect(row.atMove.swallowed, "F5: the finger is swallowed").toBe(true);
		expect(row.atMove.lassoActive, "F5: no lasso loop").toBe(false);
		expect(row.strokesAdded, "F5: no stroke drawn").toBe(0);
		expect(row.after, "F5: the stroke is stored where it was").toEqual(row.before);
	});
});

it("F6: C5b's claim, then a pen lands mid-drag: the selection goes back where it started", async () => {
	await withPage(async (page, m) => {
		const a = at(m, LARGE.fx, LARGE.fy);
		const row = (await call(page, "run", { dy: LARGE.dy, steps: LARGE.steps, ax: a.x, ay: a.y, ...D, order: "land-then-run", penAfterMove: true })) as Row;
		log("F6", row);
		expectSettled(row, "F6");
		expect(row.down?.mode, "F6: the finger took the selection").toBe("lasso");
		expect(row.down?.onSelection, "F6: the finger's drag is marked the finger's").toBe(true);
		expect(row.afterPen, "premise: the pen landed").not.toBeNull();
		expect(row.after, "F6: the stroke is stored where it started").toEqual(row.before);
	});
});

it("F7: no run, the page scrolled under the resting finger: the claim and the drag's first step are today's (pin)", async () => {
	await withPage(async (page, m) => {
		const a = at(m, SMALL.fx, SMALL.fy);
		const row = (await call(page, "run", { dy: 0, steps: 0, ax: a.x, ay: a.y, ...D, order: "land-then-run", scrollDuringWait: 40 })) as Row;
		log("F7", row);
		expect(row.scrolledBy, "premise: the page scrolled under the finger").toBeGreaterThan(30);
		expect(row.hook?.live, "premise: no run").toBe(false);
		const l = (row as unknown as { landCam: { world: Pt } }).landCam.world;
		// Today: the drag counts from the world point the finger landed on, so the first step carries the scroll.
		expect(row.down?.mode, "F7: the finger took the selection").toBe("lasso");
		expect(row.down?.dragFrom, "F7: the drag counts from the landing's world point, x").toEqual({ x: expect.closeTo(l.x, 2), y: expect.closeTo(l.y, 2) });
		const q = row.down!.expected[1]!;
		expect(Math.abs(row.after![0]!.x - row.before[0]!.x - (q.x - l.x)), "F7: the first step moves by the move's world point less the landing's, x").toBeLessThanOrEqual(TOL);
		expect(Math.abs(row.after![0]!.y - row.before[0]!.y - (q.y - l.y)), "F7: the first step moves by the move's world point less the landing's, y").toBeLessThanOrEqual(TOL);
	});
});

/** R70-A1: past the run's quiet time (WheelZoom.ts WHEEL_ZOOM_QUIET_MS, 150), so the run ends by itself first. */
const WAIT = 400;

/** The run was live, the wait's clock fired its quiet timer, and that end committed the zoom before the finger moved. */
function expectEndedByItself(row: Row, label: string): void {
	const w = row.wait;
	expect(w, `premise (${label}): the finger waited`).not.toBeNull();
	if (row.order === "land-then-run") expect(row.claimsBefore, `premise (${label}): the selection takes a finger at the landing point before any run`).toBe(true);
	expect(row.prevented.every(Boolean), `premise (${label}): every wheel event was the zoom's`).toBe(true);
	expect(w!.ms, `premise (${label}): the wait is past the quiet time`).toBe(WAIT);
	expect(w!.liveBefore, `premise (${label}): the run is live when the wait starts`).toBe(true);
	expect(w!.fired, `premise (${label}): the wait fired a timer`).toBeGreaterThan(0);
	expect(w!.liveAfterFire, `premise (${label}): the run's own timer ended it`).toBe(false);
	expect(row.liveBeforeMove, `premise (${label}): no run when the finger passes the tap limit`).toBe(false);
	expect(Math.abs(w!.k1 - w!.k0), `premise (${label}): the end kept the zoom's scale`).toBeLessThanOrEqual(1e-6);
	expect(Math.max(Math.abs(w!.scroll1[0]! - w!.scroll0[0]!), Math.abs(w!.scroll1[1]! - w!.scroll0[1]!)), `premise (${label}): the run's own end wrote the scroll`).toBeGreaterThan(0.5);
	expect(Math.hypot(w!.cam1.x - w!.cam0.x, w!.cam1.y - w!.cam0.y), `premise (${label}): the run's own end moved the camera`).toBeGreaterThan(0.5);
	// The claim's hook, when the surface took the finger, found no run to end.
	expect(row.hook?.live ?? false, `premise (${label}): the claim's hook had no run to end`).toBe(false);
}

it("C5a-w: C5a with the finger resting past the run's quiet time keeps the selection and drags it with no jump", async () => {
	await withPage(async (page, m) => {
		const a = at(m, SMALL.fx, SMALL.fy);
		const row = (await call(page, "run", { dy: SMALL.dy, steps: SMALL.steps, ax: a.x, ay: a.y, ...D, order: "land-then-run", waitMs: WAIT })) as Row;
		log("C5a-w", row);
		expect(row.liveAtLand, "premise: no run at the landing").toBe(false);
		expectEndedByItself(row, "C5a-w");
		expect(row.atMove.swallowed, "C5a-w: the finger is not swallowed").toBe(false);
		expectKeptNoJump(row, "C5a-w");
	});
});

it("C5b-w: C5b with the finger resting past the run's quiet time keeps the selection and drags it with no jump", async () => {
	await withPage(async (page, m) => {
		const a = at(m, LARGE.fx, LARGE.fy);
		const row = (await call(page, "run", { dy: LARGE.dy, steps: LARGE.steps, ax: a.x, ay: a.y, ...D, order: "land-then-run", waitMs: WAIT })) as Row;
		log("C5b-w", row);
		expect(row.liveAtLand, "premise: no run at the landing").toBe(false);
		expectEndedByItself(row, "C5b-w");
		expect(row.atMove.swallowed, "C5b-w: the finger is not swallowed").toBe(false);
		expectKeptNoJump(row, "C5b-w");
	});
});

it("C5d-w: C5d with the finger resting past the run's quiet time keeps the selection and drags it with no jump", async () => {
	await withPage(async (page, m) => {
		const a = at(m, LARGE.fx, LARGE.fy), w = at(m, 0.35, 0.3);
		const row = (await call(page, "run", { dy: LARGE.dy, steps: LARGE.steps, ax: a.x, ay: a.y, wx: w.x, wy: w.y, ...D, order: "land-then-run", waitMs: WAIT })) as Row;
		log("C5d-w", row);
		expectEndedByItself(row, "C5d-w");
		expect(row.atMove.swallowed, "C5d-w: the finger is not swallowed").toBe(false);
		expectKeptNoJump(row, "C5d-w");
		const e = row.down!.expected[0]!, l = (row as unknown as { landCam: { world: Pt } }).landCam.world;
		expect(Math.hypot(e.x - l.x, e.y - l.y), "premise: the page under the resting finger moved").toBeGreaterThan(20);
	});
});

for (const sizer of [false, true]) {
	const tag = sizer ? " (Obsidian's sizer: the preview pans)" : " (no sizer: the preview only scales)";
	it(`C6${sizer ? "s" : ""}-w: C6 with the finger resting past the run's quiet time keeps the selection and drags it with no jump${tag}`, async () => {
		await withPage(async (page, m) => {
			expect(m.sizer, "premise: the host shape").toBe(sizer);
			const v = sizer ? LARGE : SMALL, a = at(m, v.fx, v.fy);
			const row = (await call(page, "run", { dy: v.dy, steps: v.steps, ax: a.x, ay: a.y, ...D, order: "run-then-land", landOnShown: true, waitMs: WAIT })) as Row;
			const label = sizer ? "C6s-w" : "C6-w";
			log(label, row);
			const shown = (row as unknown as { shown: { client: Pt; back: Pt; w0: Pt } }).shown;
			expect(Math.abs(shown.back.x - shown.w0.x) + Math.abs(shown.back.y - shown.w0.y), "premise: the solved client point maps back").toBeLessThanOrEqual(TOL);
			expect(row.liveAtLand, "premise: the run is live at the landing").toBe(true);
			expectEndedByItself(row, label);
			expect(row.atMove.swallowed, `${label}: the finger is not swallowed`).toBe(false);
			expectKeptNoJump(row, label);
		}, sizer);
	});
}

it("C5c-w: no run, the finger resting as long: the claim and the drag's first step are today's (pin)", async () => {
	await withPage(async (page, m) => {
		const a = at(m, SMALL.fx, SMALL.fy);
		const row = (await call(page, "run", { dy: 0, steps: 0, ax: a.x, ay: a.y, ...D, order: "land-then-run", waitMs: WAIT })) as Row;
		log("C5c-w", row);
		expect(row.claimsBefore, "premise: the selection takes a finger at the landing point").toBe(true);
		expect(row.wait?.ms, "premise: the finger waited").toBe(WAIT);
		expect(row.wait?.liveBefore, "premise: no run").toBe(false);
		expect(row.wait?.cam1, "premise: nothing moved the camera in the wait").toEqual(row.wait?.cam0);
		expect(row.hook?.live, "premise: the hook had nothing to end").toBe(false);
		expect(row.down?.k, "premise: the scale is the mount's").toBe(m.k);
		expectKeptNoJump(row, "C5c-w");
	});
});

it("F7-w: F7 with a run that ends by itself and leaves the camera where it was: the claim and the drag's first step are today's (pin)", async () => {
	await withPage(async (page, m) => {
		const a = at(m, SMALL.fx, SMALL.fy);
		const row = (await call(page, "run", { dy: 0, steps: 3, ax: a.x, ay: a.y, ...D, order: "land-then-run", scrollDuringWait: 40, waitMs: WAIT })) as Row;
		log("F7-w", row);
		expect(row.scrolledBy, "premise: the page scrolled under the finger").toBeGreaterThan(30);
		expect(row.hook?.live, "premise: no run at the claim's hook").toBe(false);
		expect(row.prevented.length, "premise: the wheel events were sent").toBe(3);
		expect(row.prevented.every(Boolean), "premise: every wheel event was the zoom's").toBe(true);
		const w = row.wait!;
		expect(w.ms, "premise: the wait is past the quiet time").toBe(WAIT);
		expect(w.liveBefore, "premise: the run is live when the wait starts").toBe(true);
		expect(w.fired, "premise: the wait fired a timer").toBeGreaterThan(0);
		expect(w.liveAfterFire, "premise: the run's own timer ended it").toBe(false);
		expect(row.liveBeforeMove, "premise: no run when the finger passes the tap limit").toBe(false);
		expect(w.cam1, "premise: the run's end left the camera where it was").toEqual(w.cam0);
		const l = (row as unknown as { landCam: { world: Pt } }).landCam.world;
		expect(row.down?.mode, "F7-w: the finger took the selection").toBe("lasso");
		expect(row.down?.dragFrom, "F7-w: the drag counts from the landing's world point, x").toEqual({ x: expect.closeTo(l.x, 2), y: expect.closeTo(l.y, 2) });
		const q = row.down!.expected[1]!;
		expect(Math.abs(row.after![0]!.x - row.before[0]!.x - (q.x - l.x)), "F7-w: the first step moves by the move's world point less the landing's, x").toBeLessThanOrEqual(TOL);
		expect(Math.abs(row.after![0]!.y - row.before[0]!.y - (q.y - l.y)), "F7-w: the first step moves by the move's world point less the landing's, y").toBeLessThanOrEqual(TOL);
	});
});
