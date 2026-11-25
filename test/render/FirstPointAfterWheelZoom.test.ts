/**
 * A STROKE STARTED JUST AFTER A WHEEL OR TOUCHPAD ZOOM STARTS AT THE NIB.
 *
 * A ctrl+wheel or touchpad zoom has no lift: its run ends on a quiet timer, or when a contact lands first. The router's
 * claim ends it through the pre-down hook, and that end commits the zoom, which can write the scroll and move the
 * overlay band. The first point of the stroke is mapped through the band's place on screen. Read before the hook, that
 * place is the one from before the commit, and every later sample is mapped through the place after it, so the stroke
 * is saved with a straight line from the old place into the real one.
 *
 * Every contact here is a script-made PointerEvent dispatched at the element under the point, through the real router
 * on a real CodeMirror note with the real overlay, Infinite Canvas on, and every wheel event a real WheelEvent with
 * ctrlKey on the scroller, one per frame, the last one under the quiet time when the contact lands. The page records,
 * without changing what it records: whether the run was live at the contact; the scroll, the band's place and the
 * router's cached rect on both sides of the hook; what syncBand returned inside the hook; the sample the surface was
 * handed; and, right after the surface took it, the world point under each client point through the band's place as
 * it stands then. The stored points are read off the saved stroke.
 *
 *   C1: pen down at P inside the run's quiet time, one move by d. The commit writes the scroll and its last band step
 *       leaves the band where its first step put it, so nothing in the hook re-reads the router's rect. The first
 *       stored point is P through the place after the commit, and the last minus the first is d over the scale.
 *   C2: the same with a zoom whose commit moves the band (syncBand inside the hook). Green before the fix: the band's
 *       move re-reads the rect.
 *   C3: no run. The first point is today's mapping, and the band's rect is read as many times across the claim as
 *       today (READS_NO_RUN).
 *   C4: iPhone finger ink, the same as C1 with a finger.
 *
 * Each premise is its own expect, so a throw or a missing row cannot pass a cell. HW_FIRST_POINT_OUT=<file> writes
 * every row as JSON. HW_FIRST_POINT_PROBE=1 runs only the probes: the sweep that sized C1 and C2, and a finger on a
 * selection with the run live (it lands and waits on the tap limit while the run starts, or lands while the run is
 * live), which records the sample the surface is handed against the world point under the landing point. Not a cell.
 *
 * Run: npm run test:render. Not in `npx vitest run`.
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
import { setTipMode } from "../../src/inline/TipMode";
import { markToolPicked } from "../../src/inline/MouseInk";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField } from "./iphoneObsidianStub";
import { parsePage, serializePage } from "../../src/model/PageData";

Object.assign(Platform, { isMobile: false, isDesktop: true, isIosApp: false, isAndroidApp: false, isDesktopApp: true, isMobileApp: false, isPhone: false, isTablet: false, isWin: true });
installObsidianDom();
const ids = new Map(), sidecars = new Map();
const save = (id, page) => { sidecars.set(id, serializePage(page)); };
inlineInk.attachHost({ readPageId: p => ids.get(p) ?? null, claimId: async (p, id) => { ids.set(p, id); return { pageId: id }; },
	loadSidecar: async id => (sidecars.has(id) ? parsePage(sidecars.get(id), id) : null), scheduleSidecar: save, scheduleSidecarNow: async (id, p) => save(id, p), notify: () => {} });

const PATH = "first-point.md";
const frame = () => new Promise(r => requestAnimationFrame(() => r()));
const frames = (n) => (n <= 0 ? Promise.resolve() : frame().then(() => frames(n - 1)));
const realRect = Element.prototype.getBoundingClientRect;
let rig = null;
let stamp = 0;

const ev = (type, pointerType, id, x, y, buttons) => {
	const touch = pointerType === "touch";
	const e = new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerType, pointerId: id, isPrimary: true,
		clientX: x, clientY: y, buttons, button: type === "pointermove" ? -1 : 0, pressure: buttons ? 0.5 : 0, width: touch ? 8 : 1, height: touch ? 8 : 1 });
	// Same-task events can share a quantized stamp, and the feed drops a sample stamped at or before the down.
	stamp = Math.max(e.timeStamp, stamp + 1);
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
/** One wheel event per frame, the last one a frame before the contact: well inside the quiet time. */
const wheelRun = (dy, steps, x, y, prevented, i = 0) =>
	i >= steps ? Promise.resolve() : (prevented.push(wheel(dy / steps, x, y)), frame().then(() => wheelRun(dy, steps, x, y, prevented, i + 1)));
const pt = (p) => ({ x: p.x, y: p.y });

function instrument() {
	const o = rig.overlay, router = o.router, band = router.rectEl, sc = rig.view.scrollDOM;
	const proto = Object.getPrototypeOf(o);
	const st = (rig.st = { reads: 0, hook: null, syncs: null, down: null, want: [] });
	const box = () => { const r = realRect.call(band); return { left: r.left, top: r.top, width: r.width, height: r.height }; };
	// Counts the band's layout reads; the recorder's own reads go through realRect and are not counted.
	band.getBoundingClientRect = function () { st.reads++; return realRect.call(this); };
	o.syncBand = function (...a) { const r = proto.syncBand.apply(this, a); if (st.syncs) st.syncs.push(r); return r; };
	o.beforePenDown = function () {
		const h = { live: !!this.wheelZoomRun?.isLive, preview: !!this.pinchPreview, k0: router.scaleProvider(), scroll0: [sc.scrollLeft, sc.scrollTop],
			band0: box(), cached0: [router.rect.left, router.rect.top], syncs: [] };
		st.syncs = h.syncs;
		try { proto.beforePenDown.call(this); } finally { st.syncs = null; }
		Object.assign(h, { k1: router.scaleProvider(), scroll1: [sc.scrollLeft, sc.scrollTop], band1: box(), cached1: [router.rect.left, router.rect.top] });
		st.hook = h;
	};
	const cb = router.cb, realDown = cb.onPenDown;
	cb.onPenDown = function (s, e) {
		// Whether the pen tools strip stood before the surface took the contact, and after: one built inside the down is
		// built after the first point was mapped, and the expected points below are read through the band's place after it.
		const stripBefore = !!o.mobileTools;
		const r = realDown.call(this, s, e);
		// The world point under a client point through the band's place as it stands now, by the router's own mapping.
		const at = (x, y) => {
			const saved = router.rect;
			router.rect = realRect.call(band);
			try {
				const m = router.sampleFrom({ clientX: x, clientY: y, pointerType: e.pointerType, pressure: 0.5, tiltX: 0, tiltY: 0, timeStamp: e.timeStamp });
				return pt(o.camera.screenToWorld(m.x, m.y));
			} finally { router.rect = saved; }
		};
		st.down = { type: e.pointerType, handed: pt(s), handedWorld: pt(o.camera.screenToWorld(s.x, s.y)), k: router.scaleProvider(),
			expected: st.want.map(([x, y]) => at(x, y)), mode: o.mode, onSelection: !!o.fingerOnSelection, strip: [stripBefore, !!o.mobileTools] };
		return r;
	};
}

window.firstPoint = {
	async mount() {
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
		await frames(12);
		const overlay = overlayForPath(PATH);
		if (!overlay) throw new Error("no overlay for " + PATH);
		rig = { pane, view, overlay };
		instrument();
		const r = pane.getBoundingClientRect();
		return { pane: { left: r.left, top: r.top, width: r.width, height: r.height }, canvasMode: overlay.canvasMode, k: overlay.router.scaleProvider() };
	},

	/** A wheel run (none when steps is 0), then one contact at p, one move by d, and the lift. */
	async stroke({ dy, steps, cx, cy, px, py, dx, dyy, finger, scrollTop = 0 }) {
		const o = rig.overlay, st = rig.st;
		if (scrollTop) { rig.view.scrollDOM.scrollTop = scrollTop; await frames(8); }
		if (finger) { Object.assign(Platform, { isIosApp: true, isPhone: true }); markToolPicked(); }
		const fingerInk = !!o.router.cb.fingerInk?.();
		const before = inlineInk.strokes(PATH).length;
		st.hook = null; st.down = null; st.want = [[px, py], [px + dx, py + dyy]];
		const k0 = o.router.scaleProvider();
		const prevented = [];
		await wheelRun(dy, steps, cx, cy, prevented);
		const liveAtDown = !!o.wheelZoomRun?.isLive;
		const type = finger ? "touch" : "pen", id = finger ? 71 : 41;
		st.reads = 0;
		send(ev("pointerdown", type, id, px, py, 1));
		const readsDown = st.reads;
		send(ev("pointermove", type, id, px + dx, py + dyy, 1));
		send(ev("pointerup", type, id, px + dx, py + dyy, 0));
		await frames(4);
		const all = inlineInk.strokes(PATH);
		const added = all.length - before;
		const pts = added > 0 ? all[all.length - 1].points.map(pt) : [];
		return { k0, prevented, fingerInk, liveAtDown, readsDown, hook: st.hook, down: st.down, added, pts };
	},

	/** A stroke selected, a wheel run about a point on it, a finger landing there and passing the tap limit. */
	async selectionFinger({ dy, steps, ax, ay, dx, dyy, order = "land-then-run" }) {
		const o = rig.overlay, st = rig.st, router = o.router;
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
		const claims = !!router.cb.claimTouch?.(router.sampleFrom({ clientX: ax, clientY: ay, pointerType: "touch", pressure: 0.5, tiltX: 0, tiltY: 0, timeStamp: performance.now() }));
		const selected = o.selection.size;
		const k0 = router.scaleProvider();
		const prevented = [];
		// "run-then-land": the run is live when the finger lands. "land-then-run": the finger lands and waits on the tap
		// limit, the run starts with the other hand, the finger passes the limit inside the quiet time.
		if (order === "run-then-land") await wheelRun(dy, steps, ax, ay, prevented);
		st.hook = null; st.down = null; st.want = [[ax, ay]];
		// What the router's own landing test will answer, through a fresh rect as it takes one, without keeping it.
		const saved = router.rect;
		router.rect = realRect.call(router.rectEl);
		const landSample = pt(router.sampleFrom({ clientX: ax, clientY: ay, pointerType: "touch", pressure: 0.5, tiltX: 0, tiltY: 0, timeStamp: performance.now() }));
		const claimsLive = !!router.cb.claimTouch?.(landSample);
		router.rect = saved;
		send(ev("pointerdown", "touch", 91, ax, ay, 1));
		const claimedAtLand = st.down !== null;
		const atLand = { swallowed: router.swallowedTouches?.has(91) ?? null, touches: router.touchPos?.size ?? null, assist: router.assistPointerId ?? null, active: router.activePenId };
		if (order === "land-then-run") await wheelRun(dy, steps, ax, ay, prevented);
		const liveBeforeMove = !!o.wheelZoomRun?.isLive;
		send(ev("pointermove", "touch", 91, ax + dx, ay + dyy, 1));
		const atMove = { swallowed: router.swallowedTouches?.has(91) ?? null, active: router.activePenId, live: !!o.wheelZoomRun?.isLive };
		send(ev("pointerup", "touch", 91, ax + dx, ay + dyy, 0));
		await frames(4);
		return { order, claims, claimsLive, landSample, atLand, atMove, selected, k0, prevented, liveBeforeMove, claimedAtLand, hook: st.hook, down: st.down,
			strokesAfter: inlineInk.strokes(PATH).length - all.length, selectedAfter: o.selection.size };
	},
};
`;

const OUT = process.env.HW_FIRST_POINT_OUT;
const PROBE = process.env.HW_FIRST_POINT_PROBE === "1";
/** Layout reads of the band across a pen claim with no run, measured at the base. */
const READS_NO_RUN = 3;
/** World px. Stored points are rounded to hundredths. */
const TOL = 0.02;

let browser: Browser;
let script = "";
const rows: unknown[] = [];

beforeAll(async () => {
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "firstPointPage.ts" },
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
type Hook = { live: boolean; preview: boolean; k0: number; k1: number; scroll0: number[]; scroll1: number[]; band0: Box; band1: Box; cached0: number[]; cached1: number[]; syncs: string[] };
type Down = { type: string; handed: Pt; handedWorld: Pt; k: number; expected: Pt[]; mode: string; onSelection: boolean; strip: boolean[] };
type StrokeRow = { k0: number; prevented: boolean[]; fingerInk: boolean; liveAtDown: boolean; readsDown: number; hook: Hook | null; down: Down | null; added: number; pts: Pt[] };
type Mount = { pane: { left: number; top: number; width: number; height: number }; canvasMode: boolean; k: number };

const call = (p: Page, method: string, ...args: unknown[]) => p.evaluate(([m, a]) => (window as any).firstPoint[m](...a), [method, args] as const) as Promise<any>;

async function withPage<T>(fn: (page: Page, m: Mount) => Promise<T>): Promise<T> {
	const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 });
	try {
		await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
		await page.addScriptTag({ content: script });
		const m = (await call(page, "mount")) as Mount;
		expect(m.canvasMode, "premise: Infinite Canvas on").toBe(true);
		return await fn(page, m);
	} finally {
		await page.close();
	}
}

function log(cell: string, row: unknown): void {
	rows.push({ cell, row });
	console.log(`FIRSTPOINT ${cell} ${JSON.stringify(row)}`);
}

const scrolled = (h: Hook) => Math.max(Math.abs(h.scroll1[0]! - h.scroll0[0]!), Math.abs(h.scroll1[1]! - h.scroll0[1]!));
/** The band's last step in the commit moved it (syncBand inside the hook). */
const bandMoved = (h: Hook) => h.syncs.includes("moved");
/** How far the router's cached rect stands off the band's real place when the hook returns, client px. */
const staleBy = (h: Hook) => Math.max(Math.abs(h.cached1[0]! - h.band1.left), Math.abs(h.cached1[1]! - h.band1.top));

/**
 * The stroke's first and last stored points against the post-commit mapping of P and P + d. The stroke keeps a point
 * between the two that the pipeline places itself (measured at the base), so the move's own sample is the last stored
 * point here, and the lift is at the same place.
 */
function expectStartsAtNib(row: StrokeRow, label: string): void {
	expect(row.added, `premise (${label}): one stroke saved`).toBe(1);
	expect(row.pts.length, `premise (${label}): two points stored`).toBeGreaterThanOrEqual(2);
	expect(row.down, `premise (${label}): the surface took the contact`).not.toBeNull();
	const first = row.pts[0]!, last = row.pts[row.pts.length - 1]!;
	const [p, q] = row.down!.expected as [Pt, Pt];
	expect(Math.abs(last.x - q.x), `premise (${label}): the move's sample is stored through the place after the commit, x`).toBeLessThanOrEqual(TOL);
	expect(Math.abs(last.y - q.y), `premise (${label}): the move's sample is stored through the place after the commit, y`).toBeLessThanOrEqual(TOL);
	expect(Math.abs(first.x - p.x), `${label}: first point x is P through the place after the commit`).toBeLessThanOrEqual(TOL);
	expect(Math.abs(first.y - p.y), `${label}: first point y is P through the place after the commit`).toBeLessThanOrEqual(TOL);
	expect(Math.abs(last.x - first.x - D.dx / row.down!.k), `${label}: last minus first x is d over the scale`).toBeLessThanOrEqual(TOL);
	expect(Math.abs(last.y - first.y - D.dyy / row.down!.k), `${label}: last minus first y is d over the scale`).toBeLessThanOrEqual(TOL);
}

// P sits well right of and below the page's top-left, so a zoom held about it scrolls the page under the band.
const at = (m: Mount, fx: number, fy: number) => ({ x: m.pane.left + m.pane.width * fx, y: m.pane.top + m.pane.height * fy });
const D = { dx: 40, dyy: 24 };

// Sized by the probe at the base: a small zoom in writes about 34 px of scroll and leaves the band where the commit's
// first step put it; a larger one scrolls past the band's margin and the band moves.
const C1 = { dy: -10, steps: 3, fx: 0.7, fy: 0.68 };
const C2 = { dy: -90, steps: 3, fx: 0.7, fy: 0.68 };

it.skipIf(PROBE)("C1: a pen down inside a wheel run's quiet time starts the stroke at the nib", async () => {
	await withPage(async (page, m) => {
		const p = at(m, C1.fx, C1.fy);
		const row = (await call(page, "stroke", { dy: C1.dy, steps: C1.steps, cx: p.x, cy: p.y, px: p.x, py: p.y, ...D, finger: false })) as StrokeRow;
		log("C1", row);
		expect(row.prevented.every(Boolean), "premise: every wheel event was the zoom's").toBe(true);
		expect(row.liveAtDown, "premise: the run is live at the pen down").toBe(true);
		expect(row.hook?.live, "premise: the hook ended a live run").toBe(true);
		expect(scrolled(row.hook!), "premise: the commit wrote the scroll").toBeGreaterThan(0.5);
		expect(bandMoved(row.hook!), "premise: the band's last step left it in place").toBe(false);
		expect(staleBy(row.hook!), "premise: the hook left the router's rect off the band's place").toBeGreaterThan(0.5);
		// The first pen contact builds the pen tools strip inside the down, after the first point is mapped; the
		// expected points are read after it, so the strip moving the band would fail the first point (pin).
		expect(row.down?.strip, "premise: the strip is built inside the pen down").toEqual([false, true]);
		expectStartsAtNib(row, "C1");
	});
});

it.skipIf(PROBE)("C2: the same when the commit moves the band starts at the nib (pin)", async () => {
	await withPage(async (page, m) => {
		const p = at(m, C2.fx, C2.fy);
		const row = (await call(page, "stroke", { dy: C2.dy, steps: C2.steps, cx: p.x, cy: p.y, px: p.x, py: p.y, ...D, finger: false })) as StrokeRow;
		log("C2", row);
		expect(row.liveAtDown, "premise: the run is live at the pen down").toBe(true);
		expect(row.hook?.live, "premise: the hook ended a live run").toBe(true);
		expect(bandMoved(row.hook!), "premise: the commit moved the band").toBe(true);
		expect(staleBy(row.hook!), "premise: the band's move re-read the router's rect").toBeLessThanOrEqual(0.01);
		expectStartsAtNib(row, "C2");
	});
});

it.skipIf(PROBE)("C3: a pen down with no run stores today's first point and reads layout no more often (pin)", async () => {
	await withPage(async (page, m) => {
		const p = at(m, C1.fx, C1.fy);
		const row = (await call(page, "stroke", { dy: 0, steps: 0, cx: p.x, cy: p.y, px: p.x, py: p.y, ...D, finger: false })) as StrokeRow;
		log("C3", row);
		expect(row.liveAtDown, "premise: no run").toBe(false);
		expect(row.hook?.live, "premise: the hook had nothing to end").toBe(false);
		expect(row.down?.strip, "premise: the strip is built inside the pen down").toEqual([false, true]);
		expectStartsAtNib(row, "C3");
		expect(row.readsDown, "C3: band layout reads across the claim").toBe(READS_NO_RUN);
	});
});

it.skipIf(PROBE)("C4: iPhone finger ink inside a wheel run's quiet time starts at the finger", async () => {
	await withPage(async (page, m) => {
		const p = at(m, C1.fx, C1.fy);
		const row = (await call(page, "stroke", { dy: C1.dy, steps: C1.steps, cx: p.x, cy: p.y, px: p.x, py: p.y, ...D, finger: true })) as StrokeRow;
		log("C4", row);
		expect(row.fingerInk, "premise: finger ink is on").toBe(true);
		expect(row.liveAtDown, "premise: the run is live at the finger down").toBe(true);
		expect(row.hook?.live, "premise: the hook ended a live run").toBe(true);
		expect(row.down?.type, "premise: the surface took a finger").toBe("touch");
		expect(scrolled(row.hook!), "premise: the commit wrote the scroll").toBeGreaterThan(0.5);
		expect(staleBy(row.hook!), "premise: the hook left the router's rect off the band's place").toBeGreaterThan(0.5);
		expectStartsAtNib(row, "C4");
	});
});

it.runIf(PROBE)("probe: a finger on the selection with the run live", async () => {
	for (const [order, v] of [["land-then-run", C1], ["land-then-run", C2], ["run-then-land", C1], ["run-then-land", C2]] as const) {
		await withPage(async (page, m) => {
			const a = at(m, v.fx, v.fy);
			const row = await call(page, "selectionFinger", { dy: v.dy, steps: v.steps, ax: a.x, ay: a.y, dx: 0, dyy: -30, order });
			const w = row.down?.handedWorld, e = row.down?.expected?.[0];
			log(`probe ${order} dy=${v.dy}`, { ...row, handedOffBy: w && e ? { x: w.x - e.x, y: w.y - e.y } : null });
		});
	}
}, 120_000);

it.runIf(PROBE)("probe: what each zoom's commit does to the scroll and the band", async () => {
	for (const v of [
		{ dy: -10, fx: 0.1, fy: 0.1, s: 0 }, { dy: -20, fx: 0.1, fy: 0.1, s: 0 }, { dy: -30, fx: 0.2, fy: 0.2, s: 0 }, { dy: -15, fx: 0.3, fy: 0.3, s: 0 },
		{ dy: -10, fx: 0.7, fy: 0.68, s: 0 }, { dy: 30, fx: 0.5, fy: 0.5, s: 2000 }, { dy: 60, fx: 0.5, fy: 0.5, s: 2000 }, { dy: -30, fx: 0.5, fy: 0.5, s: 2000 },
	]) {
		await withPage(async (page, m) => {
			const p = at(m, v.fx, v.fy);
			const row = (await call(page, "stroke", { dy: v.dy, steps: 3, cx: p.x, cy: p.y, px: p.x, py: p.y, ...D, finger: false, scrollTop: v.s })) as StrokeRow;
			log(`probe dy=${v.dy} fx=${v.fx} fy=${v.fy} s=${v.s}`, row);
		});
	}
}, 240_000);
