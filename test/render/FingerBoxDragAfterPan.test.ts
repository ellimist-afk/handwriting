/**
 * A FINGER DRAGS THE LASSO BOX THE WHOLE WAY, RIGHT AFTER A FINGER PAN AND WITH NO PAN FIRST.
 *
 * Reported on a Windows tablet with Infinite Canvas on and the tip in lasso mode: a finger on the box moves it "a little
 * bit" and stops. Unit cells drive the router with script-made pointer events, which no browser can take over as a pan,
 * so they cannot see this. Here every contact is real input through Chromium's own pipeline: the pen through
 * Input.dispatchMouseEvent (pointerType pen), the finger through Input.dispatchTouchEvent. The browser hit-tests, reads
 * touch-action at contact, and may start a native pan and cancel the pointer, as on the device.
 *
 * The page: a real CodeMirror note with the real overlay and pen router, the desktop Windows platform stub, Infinite
 * Canvas on (so the host owns two-finger zoom and the standing guard writes touch-action none), the tip in lasso mode.
 * One stroke is drawn by the pen and selected by a pen lasso loop, then the pen stays away past the palm window.
 *
 *   - after a pan: one finger pans the page on empty text and lifts; 150 ms later one finger lands on the box and drags
 *     it 200 px up, then lifts.
 *   - no pan first: the same drag with nothing before it.
 *
 * The bar for both: the box moved by the whole drag (world delta times zoom within 10% of 200 px), and the browser
 * cancelled no pointer during the drag. Every row also records, at the drag's contact, the scroller's inline and computed
 * touch-action and whether the router held its guard, the touch and pointer events the page saw (trusted, cancelable),
 * and the scroll and pan the drag caused.
 *
 * Obsidian is fingerArmObsidian.ts: the iPhone stub plus a counted displayTooltip the shared stub does not export yet.
 *
 * Capture rows: the page also records every touch gotpointercapture and lostpointercapture with its target, and every
 * row carries the router's activePenId as the event reached the window (before the router saw it). Each real-touch cell
 * prints a CAPTURE line: the capture rows of the drag, and two readings.
 *   - loss reading (unplanted): one lostpointercapture on a cm-line before the lift, after the drag's first move and
 *     before its second; activePenId equals the touch's id at the loss and is null at the second move.
 *   - plant reading (capture plant): no lostpointercapture before the lift, and the box moved the whole drag.
 *
 * Two controls run on the same page, the same box and the same contact point: script-made finger PointerEvents, and the
 * real pen through CDP. Both must move the box the whole 200 px.
 *
 * HW_FINGER_ARM_PLANT=1 writes touch-action none on the scroller after the pan's lift and before the drag's contact,
 * with two frames to commit it. HW_FINGER_ARM_PLANT=capture has the scroller take the pointer capture at the drag's
 * pointerdown, from a window listener that runs before the router's own. HW_FINGER_ARM_OUT=<file> writes every row
 * as JSON.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { chromium, type Browser, type CDPSession, type Page } from "playwright";
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
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField } from "./iphoneObsidianStub";
import { parsePage, serializePage } from "../../src/model/PageData";

Object.assign(Platform, { isMobile: false, isDesktop: true, isIosApp: false, isAndroidApp: false, isDesktopApp: true, isMobileApp: false, isPhone: false, isTablet: false, isWin: true });
installObsidianDom();
const ids = new Map(), sidecars = new Map();
const save = (id, page) => { sidecars.set(id, serializePage(page)); };
inlineInk.attachHost({ readPageId: p => ids.get(p) ?? null, claimId: async (p, id) => { ids.set(p, id); return { pageId: id }; },
	loadSidecar: async id => (sidecars.has(id) ? parsePage(sidecars.get(id), id) : null), scheduleSidecar: save, scheduleSidecarNow: async (id, p) => save(id, p), notify: () => {} });

const frame = () => new Promise(r => requestAnimationFrame(() => r()));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await frame(); };
let rig = null;
let phase = "setup";
const events = [];

let capturePlant = false;
const describe = (t) => t instanceof Element ? t.tagName.toLowerCase() + "." + t.className.toString().slice(0, 60) : String(t);
// Window capture, installed before the plugin: what the page actually received, in order.
for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "gotpointercapture", "lostpointercapture", "touchstart", "touchmove", "touchend", "touchcancel"]) {
	window.addEventListener(type, (e) => {
		const pt = e.pointerType ?? "touch-event";
		if (e instanceof PointerEvent && pt !== "touch") return;
		const p = e.touches ? (e.changedTouches[0] ?? null) : e;
		const row = { phase, type, trusted: e.isTrusted, cancelable: e.cancelable, x: p ? Math.round(p.clientX) : null, y: p ? Math.round(p.clientY) : null, t: Math.round(performance.now()) };
		row.activePenId = rig?.overlay.router?.activePenId ?? null;
		if (e instanceof PointerEvent) row.pointerId = e.pointerId;
		if (type.endsWith("pointercapture")) { row.target = describe(e.target); row.onScroller = !!rig && e.target === rig.view.scrollDOM; }
		if (type === "pointerdown" && rig) {
			const sc = rig.view.scrollDOM;
			row.scrollerInline = sc.style.touchAction;
			row.scrollerComputed = getComputedStyle(sc).touchAction;
			row.targetComputed = e.target instanceof Element ? getComputedStyle(e.target).touchAction : null;
			row.target = e.target instanceof Element ? e.target.className.toString().slice(0, 60) : null;
			row.guardApplied = rig.overlay.router?.guardApplied ?? null;
			row.width = e.width; row.height = e.height;
		}
		events.push(row);
	}, { capture: true });
}
// The capture plant: added after the recorder, so the drag's pointerdown row is written first; on the window, so it
// runs before the router's listener on the scroller.
window.addEventListener("pointerdown", (e) => {
	if (!capturePlant || phase !== "drag" || e.pointerType !== "touch" || !rig) return;
	const sc = rig.view.scrollDOM;
	let ok = "ok";
	try { sc.setPointerCapture(e.pointerId); } catch (err) { ok = String(err).slice(0, 80); }
	events.push({ phase, type: "plant-capture", ok, has: sc.hasPointerCapture(e.pointerId), pointerId: e.pointerId, t: Math.round(performance.now()) });
}, { capture: true });

const read = () => {
	const { overlay, view } = rig;
	const b = overlay.selectionBounds();
	return { box: b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null, size: overlay.selection.size, zoom: overlay.camera.snapshot.zoom,
		scrollTop: view.scrollDOM.scrollTop, pan: { x: overlay.viewportPan.x, y: overlay.viewportPan.y },
		scrollerInline: view.scrollDOM.style.touchAction, scrollerComputed: getComputedStyle(view.scrollDOM).touchAction,
		guardApplied: overlay.router?.guardApplied ?? null, mode: overlay.mode, canvasMode: overlay.canvasMode, tooltipCalls: window.__tooltipCalls ?? 0 };
};

window.fingerArm = {
	async mount() {
		setScrollExpansionEnabled(true);
		setPenInk(true);
		setInlineTool("pen"); setTipMode("nib");
		const path = "finger-box-drag.md";
		const pane = document.body.appendChild(document.createElement("div"));
		pane.className = "markdown-source-view mod-cm6";
		pane.style.cssText = "position:relative;margin-left:60px;margin-top:40px;width:1000px;height:760px;overflow:hidden";
		const text = Array.from({ length: 200 }, (_, i) => "line " + (i + 1) + " some words on the line").join("\\n");
		const view = new EditorView({ parent: pane, state: EditorState.create({ doc: text, extensions: [history(), EditorView.lineWrapping,
			editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} })), inkOverlayExtension(),
			EditorView.theme({ "&": { width: "1000px", height: "760px" }, ".cm-scroller": { overflowY: "auto" }, ".cm-content": { fontSize: "18px", lineHeight: "28px" } })] }) });
		await settle(12);
		const overlay = overlayForPath(path);
		if (!overlay) throw new Error("no overlay for " + path);
		rig = { pane, view, overlay, path };
		const r = pane.getBoundingClientRect();
		return { pane: { left: r.left, top: r.top, width: r.width, height: r.height }, canvasMode: overlay.canvasMode };
	},
	setTip(m) { setTipMode(m); },
	strokes() { return inlineInk.strokes(rig.path).length; },
	/** Client point at the centre of where the router would give a lone finger to the selection; null if nowhere. */
	boxPoint() {
		const router = rig.overlay.router, r = rig.pane.getBoundingClientRect();
		router.refreshRect();
		let n = 0, sx = 0, sy = 0;
		for (let y = r.top + 4; y < r.bottom - 4; y += 8) for (let x = r.left + 4; x < r.right - 4; x += 8) {
			const s = router.sampleFrom({ clientX: x, clientY: y, pressure: 0.5, tiltX: 0, tiltY: 0, timeStamp: performance.now(), pointerType: "touch", width: 8, height: 8 });
			if (router.cb.claimTouch(s)) { n++; sx += x; sy += y; }
		}
		return n ? { x: sx / n, y: sy / n, cells: n } : null;
	},
	setPhase(p) { phase = p; },
	read,
	async plant() {
		rig.view.scrollDOM.style.setProperty("touch-action", "none", "important");
		await settle(2);
		return getComputedStyle(rig.view.scrollDOM).touchAction;
	},
	plantCapture() { capturePlant = true; return "capture"; },
	events() { return events.slice(); },
	async madeDrag(a, to, steps) {
		const mk = (type, x, y) => new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 91, pointerType: "touch", isPrimary: true,
			clientX: x, clientY: y, width: 8, height: 8, pressure: type === "pointerup" ? 0 : 0.5, buttons: type === "pointerup" ? 0 : 1, button: type === "pointermove" ? -1 : 0 });
		const at0 = document.elementFromPoint(a.x, a.y);
		at0.dispatchEvent(mk("pointerdown", a.x, a.y));
		for (let i = 1; i <= steps; i++) {
			await new Promise(r => setTimeout(r, 16));
			const x = a.x + ((to.x - a.x) * i) / steps, y = a.y + ((to.y - a.y) * i) / steps;
			(document.elementFromPoint(x, y) ?? at0).dispatchEvent(mk("pointermove", x, y));
		}
		await new Promise(r => setTimeout(r, 16));
		(document.elementFromPoint(to.x, to.y) ?? at0).dispatchEvent(mk("pointerup", to.x, to.y));
	},
	settle(n) { return settle(n); },
};
`;

const OUT = process.env.HW_FINGER_ARM_OUT;
const PLANT = process.env.HW_FINGER_ARM_PLANT ?? "0";
let browser: Browser;
let script = "";
const record: unknown[] = [];

beforeAll(async () => {
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "fingerBoxDragPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./fingerArmObsidian.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);
afterAll(async () => {
	await browser?.close();
	if (OUT) writeFileSync(OUT, JSON.stringify(record, null, 1));
});

const call = (p: Page, method: string, ...args: unknown[]) => p.evaluate(([m, a]) => (window as any).fingerArm[m](...a), [method, args] as const) as Promise<any>;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const pen = (cdp: CDPSession, type: string, x: number, y: number, buttons: number) =>
	cdp.send("Input.dispatchMouseEvent", { type, x, y, buttons, pointerType: "pen", button: type === "mouseMoved" && buttons === 0 ? "none" : "left",
		clickCount: type === "mouseMoved" ? 0 : 1, force: buttons ? 0.5 : 0 } as never);
const touch = (cdp: CDPSession, type: string, x: number, y: number) =>
	cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 0.5 }] } as never);

async function penStroke(cdp: CDPSession, pts: Array<[number, number]>): Promise<void> {
	await pen(cdp, "mouseMoved", pts[0]![0], pts[0]![1], 0);
	await wait(20);
	await pen(cdp, "mousePressed", pts[0]![0], pts[0]![1], 1);
	for (const [x, y] of pts.slice(1)) { await pen(cdp, "mouseMoved", x, y, 1); await wait(12); }
	const last = pts.at(-1)!;
	await pen(cdp, "mouseReleased", last[0], last[1], 0);
}

/** One finger from a to b in `steps` moves, about a frame apart, then lifts. */
async function fingerDrag(cdp: CDPSession, a: { x: number; y: number }, b: { x: number; y: number }, steps: number): Promise<void> {
	await touch(cdp, "touchStart", a.x, a.y);
	try {
		for (let i = 1; i <= steps; i++) {
			await wait(16);
			await touch(cdp, "touchMove", a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
		}
		await wait(16);
	} finally {
		await touch(cdp, "touchEnd", b.x, b.y);
	}
}

type Ev = Record<string, unknown>;

/** The drag's capture rows and the two readings, each held, failed, or n/a when the run does not test it. */
function captureReading(drag: Ev[], moved: number, real: boolean) {
	const lift = drag.findIndex((e) => e.type === "pointerup" || e.type === "pointercancel");
	const beforeLift = lift < 0 ? drag : drag.slice(0, lift);
	const moves = drag.filter((e) => e.type === "pointermove");
	const losses = beforeLift.filter((e) => e.type === "lostpointercapture");
	const gots = beforeLift.filter((e) => e.type === "gotpointercapture");
	const loss = losses[0];
	const m1 = moves[0], m2 = moves[1];
	const lossAt = loss ? drag.indexOf(loss) : -1;
	const betweenMoves12 = !!(loss && m1 && m2 && drag.indexOf(m1) < lossAt && lossAt < drag.indexOf(m2));
	const lossNoted = {
		oneLoss: losses.length === 1, onCmLine: !!loss && /cm-line/.test(String(loss.target)), betweenMoves12,
		idLiveAtLoss: !!loss && loss.activePenId !== null && loss.activePenId === loss.pointerId,
		idNullAtMove2: !!m2 && m2.activePenId === null,
	};
	const whole = moved >= 180 && moved <= 220;
	const verdict = (on: boolean, ok: boolean) => (on ? (ok ? "held" : "failed") : "n/a");
	const lossHeld = Object.values(lossNoted).every(Boolean);
	return {
		lossReading: verdict(real && PLANT === "0", lossHeld), lossNoted,
		plantReading: verdict(real && PLANT === "capture", losses.length === 0 && whole),
		lossesBeforeLift: losses.length, gotsBeforeLift: gots.length,
		moveIndexOfLoss: loss ? moves.filter((m) => drag.indexOf(m) < lossAt).length : null,
		rows: drag.filter((e) => String(e.type).startsWith("pointer") || String(e.type).endsWith("pointercapture") || e.type === "plant-capture")
			.map((e) => ({ type: e.type, target: e.target ?? null, onScroller: e.onScroller ?? null, pointerId: e.pointerId ?? null, activePenId: e.activePenId ?? null, ok: e.ok, has: e.has, t: e.t })),
	};
}

async function runCell(panFirst: boolean, kind: "real" | "made" | "pen" = "real") {
	const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2, hasTouch: true });
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 200)));
	try {
		await page.setContent('<!doctype html><body style="margin:0"></body>');
		await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
		await page.addScriptTag({ content: script });
		const cdp = await context.newCDPSession(page);
		const m = await call(page, "mount");
		const L = m.pane.left, T = m.pane.top;
		// One stroke by the pen, then a pen lasso loop around it; the tip stays in lasso mode.
		await penStroke(cdp, Array.from({ length: 24 }, (_, i) => [L + 500 + i * 8, T + 420 + (i % 2 ? 24 : 0)] as [number, number]));
		await call(page, "settle", 10);
		const strokes = await call(page, "strokes");
		await call(page, "setTip", "lasso");
		const cx = L + 592, cy = T + 432, R = 150, N = 36;
		await penStroke(cdp, Array.from({ length: N + 1 }, (_, i) => [cx + R * Math.cos((2 * Math.PI * i) / N), cy + R * 0.6 * Math.sin((2 * Math.PI * i) / N)] as [number, number]));
		await call(page, "settle", 6);
		// Past the palm window: no pen near when the finger lands.
		await wait(900);
		const before = await call(page, "read");
		let panRead = null;
		if (panFirst) {
			await call(page, "setPhase", "pan");
			await fingerDrag(cdp, { x: L + 160, y: T + 600 }, { x: L + 160, y: T + 450 }, 15);
			await wait(150);
			panRead = await call(page, "read");
		}
		let planted: string | null = null;
		if (PLANT === "1") planted = await call(page, "plant");
		else if (PLANT === "capture") planted = await call(page, "plantCapture");
		else if (PLANT !== "0") throw new Error("HW_FINGER_ARM_PLANT must be 0, 1 or capture, got " + PLANT);
		const at = await call(page, "boxPoint");
		if (!at) throw new Error("premise: no point on the page takes a finger to the selection");
		const atDown = await call(page, "read");
		await call(page, "setPhase", "drag");
		if (kind === "made") await call(page, "madeDrag", at, { x: at.x, y: at.y - 200 }, 20);
		else if (kind === "pen") await penStroke(cdp, Array.from({ length: 21 }, (_, i) => [at.x, at.y - i * 10] as [number, number]));
		else await fingerDrag(cdp, at, { x: at.x, y: at.y - 200 }, 20);
		await wait(300);
		await call(page, "settle", 6);
		const after = await call(page, "read");
		const events = (await call(page, "events")) as Array<Record<string, unknown>>;
		const drag = events.filter((e) => e.phase === "drag");
		const dragDown = drag.find((e) => e.type === "pointerdown") ?? null;
		const moved = atDown.box && after.box ? { dx: (after.box.x - atDown.box.x) * after.zoom, dy: (after.box.y - atDown.box.y) * after.zoom } : null;
		const movedPx = Math.hypot(moved?.dx ?? 0, moved?.dy ?? 0);
		const cell = (panFirst ? "after a pan" : "no pan first") + (kind === "real" ? "" : " / " + kind);
		const capture = captureReading(drag, movedPx, kind === "real");
		const row = {
			cell, kind, planted, strokes, before, panRead, at, atDown, after, moved, capture,
			dragPointerCancels: drag.filter((e) => e.type === "pointercancel").length,
			dragTouchCancels: drag.filter((e) => e.type === "touchcancel").length,
			dragUncancelableMoves: drag.filter((e) => e.type === "touchmove" && e.cancelable === false).length,
			dragPointerMoves: drag.filter((e) => e.type === "pointermove").length,
			dragDown, errors, events,
		};
		record.push(row);
		// eslint-disable-next-line no-console
		console.log(`FINGER-ARM ${JSON.stringify({ ...row, events: undefined, before: undefined, capture: undefined })}`);
		// eslint-disable-next-line no-console
		console.log(`CAPTURE ${JSON.stringify({ cell, planted, movedPx: Math.round(movedPx * 10) / 10, ...capture })}`);
		return row;
	} finally {
		await context.close();
	}
}

function check(row: Awaited<ReturnType<typeof runCell>>): void {
	expect(row.errors, "page errors").toEqual([]);
	expect(row.strokes, "premise: the pen drew one stroke").toBe(1);
	expect(row.before.size, "premise: the lasso selected it").toBe(1);
	expect(row.before.canvasMode, "premise: Infinite Canvas is on").toBe(true);
	expect(row.dragDown, "premise: the drag's contact reached the page").not.toBeNull();
	expect(row.dragDown!.trusted, "premise: real browser input").toBe(true);
	const moved = Math.hypot(row.moved?.dx ?? 0, row.moved?.dy ?? 0);
	expect.soft(row.dragPointerCancels, `the browser cancelled the finger mid-drag (touch-action at contact ${row.dragDown!.scrollerComputed}, guard ${row.dragDown!.guardApplied})`).toBe(0);
	expect.soft(moved, `the box moved ${moved.toFixed(1)} px of the 200 px drag (${JSON.stringify(row.moved)})`).toBeGreaterThanOrEqual(180);
	expect.soft(moved).toBeLessThanOrEqual(220);
}

it("after a finger pan, a finger drags the selection box the whole 200 px", async () => {
	const row = await runCell(true);
	expect(row.panRead, "premise: the pan ran").not.toBeNull();
	check(row);
}, 120_000);

it("with no pan first, a finger drags the selection box the whole 200 px", async () => {
	check(await runCell(false));
}, 120_000);

function checkControl(row: Awaited<ReturnType<typeof runCell>>, what: string): void {
	expect(row.errors, "page errors").toEqual([]);
	expect(row.before.size, "premise: the lasso selected it").toBe(1);
	const moved = Math.hypot(row.moved?.dx ?? 0, row.moved?.dy ?? 0);
	expect(moved, `${what} moved the box ${moved.toFixed(1)} px (${JSON.stringify(row.moved)})`).toBeGreaterThanOrEqual(180);
	expect(moved).toBeLessThanOrEqual(220);
}

it("control: script-made finger events on the same page drag the box the whole 200 px", async () => {
	checkControl(await runCell(false, "made"), "made finger events");
}, 120_000);

it("control: the real pen drags the box the whole 200 px", async () => {
	checkControl(await runCell(false, "pen"), "the pen");
}, 120_000);
