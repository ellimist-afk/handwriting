/**
 * WHAT TEN SECONDS OF FAST WRITING ASKS OF THE MAIN THREAD: A RECORD, NOT A CLAIM.
 *
 * What it is for: Alan's trace of fast writing on Orion showed the plugin waking the main thread far more often than
 * it draws (two frame callbacks in one frame, a timer set and cleared on nearly every pen event). This cell counts
 * that work on the real editor mount so a later change can be held to equal or better.
 *
 * It mounts a plain note (a few lines of text, no ink, Infinite Canvas off) in a real EditorView with the plugin's
 * overlay, Alan's font 12, the Minimal theme, at device pixel ratio 1.8257 (Orion's page zoom). There is no recorder of
 * a real pen stream in the repo, so the stream is synthesized: 29 strokes in 10 s, each a looped written shape of 15
 * frames with the pen down and 5 frames hovering before the next. Every frame carries one pointermove and, on nine
 * frames in ten, two pointerrawupdate events (one on the tenth), the intake's 1.9 raw per move. Each raw event carries
 * two coalesced samples, each made after the clock moves so their timestamps rise. A hovering frame sends the same pair with the buttons up and no pressure. Every event goes
 * through the real router as a PointerEvent. Events are sent from a frame callback the counters do not see.
 *
 * The counters are installed before the plugin's code loads: requestAnimationFrame, cancelAnimationFrame, setTimeout,
 * clearTimeout and getComputedStyle are wrapped on the window, and each request is named by the stack that made it (the
 * stroke's frame ticker, the present probe, the snap preview's timer, the hover watchdog, or other). A MutationObserver
 * on the scroller, the content, the pane, the overlay's container and the pen cursor counts attribute writes.
 *
 * It prints, for the ten seconds: frame callbacks per frame and frames with more than one; timer installs and clears per
 * second by source; getComputedStyle calls per second; events sent per type and samples the stroke received;
 * attribute writes per second by element and attribute; the pointerup handler's time, median and 95th percentile; and
 * what is still pending (frame callbacks, timers) 1 s after the last event.
 *
 * THE CLAIM: the replay ran (no page error, 29 strokes on the note, samples reached the stroke), and each check below
 * holds a cut the baseline numbers named: one frame callback per frame while writing; no timer per pen event; no
 * reticle class rewritten per hover sample.
 *
 * Run: HW_POWER_DRAW=1 npx vitest run --config vitest.render.mts test/render/PowerDrawBaseline.test.ts.
 *   HW_PD_OUT=<file> writes the summary and the raw counts as JSON.
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

declare const process: { env: Record<string, string | undefined>; platform: string };

const ENABLED = process.env.HW_POWER_DRAW === "1";
const DPR = Number(process.env.HW_PD_DPR ?? "1.8257");
const STROKES = 29;
const DOWN_FRAMES = 15;
const HOVER_FRAMES = 5;
const NOTE_TEXT = "Power draw baseline\n\nA plain note with a few lines of text.\nThe pen writes below them.\n\n\n\n\n\n\n\n\n\n\n\n";
const MINIMAL_CSS = readFileSync(fileURLToPath(new URL("./fixtures/minimal-9.0.2-theme.css", import.meta.url)), "utf8");

/**
 * Loaded before the plugin bundle, so every reference the plugin takes to these window functions is the counted one.
 * The driver keeps the raw requestAnimationFrame and setTimeout for itself, so its own frames and waits are not counted.
 */
const COUNTERS = `
(() => {
	const raw = { raf: window.requestAnimationFrame.bind(window), caf: window.cancelAnimationFrame.bind(window),
		st: window.setTimeout.bind(window), ct: window.clearTimeout.bind(window), gcs: window.getComputedStyle.bind(window) };
	const pd = { raw, recording: false, frames: new Map(), rafReq: {}, rafPending: new Map(), timers: new Map(),
		timerSet: {}, timerClear: {}, timerFired: {}, gcs: 0, gcsBy: {} };
	const who = (kind) => {
		const s = new Error().stack || "";
		if (kind === "raf") {
			if (/startFrameTicker|\\btick\\b/.test(s)) return "ticker";
			if (/schedulePresentProbe/.test(s)) return "presentProbe";
			if (/scheduleRepaint/.test(s)) return "repaint";
			if (/scheduleViewportStyleRefresh/.test(s)) return "viewportStyle";
			return "other";
		}
		if (kind === "timer") {
			if (/SnapPreview|snapPreview/.test(s)) return "snapPreview";
			if (/HoverWatchdog/.test(s)) return "hoverWatchdog";
			return "other";
		}
		if (/syncGridPaperBox/.test(s)) return "syncGridPaperBox";
		return "other";
	};
	const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
	window.requestAnimationFrame = function (cb) {
		const by = who("raf");
		if (pd.recording) bump(pd.rafReq, by);
		const id = raw.raf((ts) => {
			pd.rafPending.delete(id);
			if (pd.recording) {
				let f = pd.frames.get(ts);
				if (!f) { f = { ts, callbacks: 0, by: {} }; pd.frames.set(ts, f); }
				f.callbacks++; bump(f.by, by);
			}
			return cb(ts);
		});
		pd.rafPending.set(id, by);
		return id;
	};
	window.cancelAnimationFrame = function (id) { pd.rafPending.delete(id); return raw.caf(id); };
	window.setTimeout = function (fn, ms, ...a) {
		const by = who("timer");
		if (pd.recording) bump(pd.timerSet, by);
		const id = raw.st((...b) => {
			pd.timers.delete(id);
			if (pd.recording) bump(pd.timerFired, by);
			return typeof fn === "function" ? fn(...b) : undefined;
		}, ms, ...a);
		pd.timers.set(id, { by, ms });
		return id;
	};
	window.clearTimeout = function (id) {
		const t = pd.timers.get(id);
		if (t) { pd.timers.delete(id); if (pd.recording) bump(pd.timerClear, t.by); }
		return raw.ct(id);
	};
	window.getComputedStyle = function (...a) {
		if (pd.recording) { pd.gcs++; bump(pd.gcsBy, who("gcs")); }
		return raw.gcs(...a);
	};
	window.__pd = pd;
})();
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

installObsidianDom();
Object.assign(Platform, { isMobile: false, isDesktop: true, isIosApp: false, isAndroidApp: false, isDesktopApp: true, isMobileApp: false, isPhone: false, isTablet: false, isWin: true });

const ids = new Map();
inlineInk.attachHost({ readPageId: p => ids.get(p) ?? null, claimId: async (p, id) => { ids.set(p, id); return { pageId: id }; },
	loadSidecar: async () => null, scheduleSidecar: () => {}, scheduleSidecarNow: async () => {}, notify: () => {} });

const pd = window.__pd;
const frame = () => new Promise(r => pd.raw.raf(() => r()));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await frame(); };
const sleep = ms => new Promise(r => pd.raw.st(r, ms));
const PANE_W = 1397.5, PANE_H = 800, HOST_LEFT = 300;
let rig = null;
const step = (what) => console.log("PD-STEP " + what + " " + Math.round(performance.now()));

function installSizer(view) {
	const sizer = document.createElement("div"); sizer.className = "cm-sizer";
	const container = document.createElement("div"); container.className = "cm-contentContainer";
	view.contentDOM.parentElement.insertBefore(sizer, view.contentDOM); sizer.appendChild(container); container.appendChild(view.contentDOM);
	void view.scrollDOM.clientWidth; return sizer;
}

window.powerDraw = {
	async mount(text) {
		setPenInk(true); setScrollExpansionEnabled(false); setInlineTool("pen");
		const path = "Power draw.md";
		const pane = document.body.appendChild(document.createElement("div"));
		pane.className = "markdown-source-view mod-cm6";
		pane.style.cssText = "position:relative;margin-left:" + (HOST_LEFT + 1 / 3) + "px;margin-top:77.5px;width:" + PANE_W + "px;height:" + PANE_H + "px;overflow:hidden";
		document.body.classList.add("handwriting-paper-lines");
		const view = new EditorView({ parent: pane, state: EditorState.create({ doc: text, extensions: [history(), EditorView.lineWrapping,
			editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} })), inkOverlayExtension(),
			EditorView.theme({ "&": { width: PANE_W + "px", height: PANE_H + "px" }, ".cm-scroller": { overflowY: "auto", overflowX: "auto" } })] }) });
		installSizer(view);
		let overlay = null;
		for (let i = 0; i < 200 && !(overlay = overlayForPath(path)); i++) await settle(2);
		if (!overlay) throw new Error("no overlay for " + path);
		await settle(12);
		rig = { pane, view, overlay, path };
		step("mounted");
		return { canvasMode: !!overlay.canvasMode, cssScale: overlay.cssScale, dpr: window.devicePixelRatio };
	},
	async run(strokes, downFrames, hoverFrames) {
		const { pane, view, overlay, path } = rig, sd = view.scrollDOM;
		const r = sd.getBoundingClientRect();
		const target = view.contentDOM;
		const sent = {};
		const upMs = [];
		let down = false;
		const init = (x, y) => ({ bubbles: true, cancelable: true, pointerType: "pen", pointerId: 932, isPrimary: true, clientX: x, clientY: y,
			buttons: down ? 1 : 0, pressure: down ? 0.5 : 0 });
		// An event's timeStamp is taken when it is made, at the browser's timer resolution. Each event waits for the clock to
		// move first, so coalesced samples carry rising stamps as a real pen's do and the router's timestamp gate keeps them.
		const tick = () => { const t = performance.now(); while (performance.now() - t < 0.12) { /* wait for the clock */ } };
		const seen = { raws: 0, coalesced: 0 };
		const send = (type, x, y, coalesced) => {
			const o = init(x, y);
			if (coalesced) o.coalescedEvents = coalesced.map(([cx, cy]) => { tick(); return new PointerEvent(type, init(cx, cy)); });
			tick();
			const ev = new PointerEvent(type, o);
			if (pd.recording && type === "pointerrawupdate" && down) { seen.raws++; seen.coalesced += typeof ev.getCoalescedEvents === "function" ? ev.getCoalescedEvents().length : 0; }
			const t0 = performance.now();
			target.dispatchEvent(ev);
			const ms = performance.now() - t0;
			if (pd.recording) sent[type] = (sent[type] || 0) + 1;
			return ms;
		};
		// The pen's place for frame f of stroke s: strokes written left to right in rows, each a small looped shape.
		const cols = 10, cellW = (r.width - 160) / cols, rowH = 70;
		const at = (s, f) => {
			const ox = r.left + 80 + (s % cols) * cellW, oy = r.top + 260 + Math.floor(s / cols) * rowH;
			const u = f / downFrames, a = u * Math.PI * 4;
			return [ox + u * cellW * 0.7 + 8 * Math.sin(a), oy + 18 * Math.cos(a) - 9];
		};
		let samples = 0;
		const penRaw = overlay.penRaw;
		overlay.penRaw = function (s, e) { if (pd.recording) samples += s.length; return penRaw.call(this, s, e); };
		// A warm-up, not recorded: hovers and one short stroke at the pane's top left pay the first pen's one-time setup.
		{
			const wx = r.left + 30, wy = r.top + 30;
			for (let i = 0; i < 6; i++) { send("pointerrawupdate", wx + 3 * i, wy); send("pointermove", wx + 3 * i, wy); await frame(); }
			send("pointerdown", wx, wy); down = true;
			for (let i = 1; i < 6; i++) { send("pointerrawupdate", wx + 4 * i, wy + 2 * i, [[wx + 4 * i - 2, wy + 2 * i - 1], [wx + 4 * i, wy + 2 * i]]); send("pointermove", wx + 4 * i, wy + 2 * i); await frame(); }
			down = false; send("pointerup", wx + 20, wy + 10);
			await settle(6); await sleep(1200); await settle(4);
		}
		const warmStrokes = inlineInk.strokes(path).length;
		// Attribute writes, from here on.
		const watched = [["scroller", sd], ["content", view.contentDOM], ["pane", pane], ["container", overlay.container], ["cursor", overlay.penCursorEl]];
		const mut = {};
		const observers = [];
		for (const [name, el] of watched) {
			if (!el) { mut[name + ":absent"] = 0; continue; }
			const mo = new MutationObserver(list => { if (!pd.recording) return; for (const m of list) { const k = name + ":" + m.attributeName; mut[k] = (mut[k] || 0) + 1; } });
			mo.observe(el, { attributes: true });
			observers.push(mo);
		}
		pd.recording = true;
		const t0 = performance.now();
		let lastEvent = t0, frameNo = 0;
		const raws = () => (frameNo++ % 10 === 9 ? 1 : 2);
		for (let s = 0; s < strokes; s++) {
			let [x, y] = at(s, 0);
			send("pointerrawupdate", x, y); send("pointermove", x, y);
			await frame();
			send("pointerdown", x, y); down = true;
			for (let f = 1; f <= downFrames; f++) {
				const n = raws();
				for (let k = 1; k <= n; k++) {
					const p0 = at(s, f - 1 + (k - 0.5) / n), p1 = at(s, f - 1 + k / n);
					send("pointerrawupdate", p1[0], p1[1], [p0, p1]);
				}
				[x, y] = at(s, f);
				send("pointermove", x, y);
				await frame();
			}
			down = false;
			upMs.push(send("pointerup", x, y));
			for (let h = 1; h < hoverFrames; h++) {
				const n = raws();
				for (let k = 0; k < n; k++) send("pointerrawupdate", x + 2 * h + k, y - 3 * h);
				send("pointermove", x + 2 * h, y - 3 * h);
				await frame();
			}
			lastEvent = performance.now();
		}
		const seconds = (lastEvent - t0) / 1000;
		// Let the last mutation records arrive before the window closes.
		await sleep(0);
		pd.recording = false;
		for (const mo of observers) mo.disconnect();
		const strokeFrames = [...pd.frames.values()];
		// What is still waiting 1 s after the last event.
		await sleep(Math.max(0, lastEvent + 1000 - performance.now()));
		const pendingRaf = {}, pendingTimers = {};
		for (const by of pd.rafPending.values()) pendingRaf[by] = (pendingRaf[by] || 0) + 1;
		for (const t of pd.timers.values()) { const k = t.by + "@" + t.ms; pendingTimers[k] = (pendingTimers[k] || 0) + 1; }
		overlay.penRaw = penRaw;
		return { seconds, sent, samples, seen, upMs, strokes: inlineInk.strokes(path).length - warmStrokes,
			frames: strokeFrames.map(f => ({ callbacks: f.callbacks, by: f.by })), rafReq: pd.rafReq, timerSet: pd.timerSet,
			timerClear: pd.timerClear, timerFired: pd.timerFired, gcs: pd.gcs, gcsBy: pd.gcsBy, mut, pendingRaf, pendingTimers };
	},
};
`;

let browser: Browser, script: string;
const record: unknown[] = [];
beforeAll(async () => {
	if (!ENABLED) return;
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "powerDrawPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);
afterAll(async () => {
	await browser?.close();
	if (process.env.HW_PD_OUT) writeFileSync(process.env.HW_PD_OUT, JSON.stringify(record, null, 1));
});

const call = (p: Page, method: string, ...args: unknown[]) => p.evaluate(([m, a]) => (window as any).powerDraw[m](...a), [method, args] as const);
const per = (n: number, s: number) => Math.round((n / s) * 10) / 10;
const perAll = (o: Record<string, number>, s: number) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, per(v, s)]));
const pct = (xs: number[], p: number) => {
	const v = [...xs].sort((a, b) => a - b);
	return v.length ? Math.round(v[Math.min(v.length - 1, Math.ceil(p * v.length) - 1)]! * 100) / 100 : null;
};

const gated = ENABLED ? it : it.skip;
gated(`fast writing, ${STROKES} strokes in about 10 s on a plain note: the main thread's frame callbacks, timers, style reads and attribute writes, recorded`, async () => {
	const page = await browser.newPage({ viewport: { width: 1800, height: 900 }, deviceScaleFactor: DPR });
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	page.on("console", m => { if (m.text().startsWith("PD-STEP")) console.log(m.text()); });
	try {
		// getCoalescedEvents exists only in a secure context, which a setContent page is not: the page is served from an
		// https address the test answers itself.
		await page.route("https://power-draw.test/", route => route.fulfill({ contentType: "text/html",
			body: `<!doctype html><body class="theme-dark" style="margin:0; --font-text-size:12px; --background-modifier-border:#777777"></body>` }));
		await page.goto("https://power-draw.test/");
		expect(await page.evaluate(() => window.isSecureContext && typeof PointerEvent.prototype.getCoalescedEvents === "function"), "premise: coalesced events exist").toBe(true);
		await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
		await page.addStyleTag({ content: MINIMAL_CSS });
		await page.addScriptTag({ content: COUNTERS });
		await page.addScriptTag({ content: script });
		const mounted = await call(page, "mount", NOTE_TEXT) as any;
		const r = await call(page, "run", STROKES, DOWN_FRAMES, HOVER_FRAMES) as any;
		const s = r.seconds as number;
		const frames = r.frames as { callbacks: number; by: Record<string, number> }[];
		const callbacks = frames.reduce((n, f) => n + f.callbacks, 0);
		const shared = frames.filter(f => f.callbacks > 1);
		const sharedBy: Record<string, number> = {};
		for (const f of shared) { const k = Object.keys(f.by).sort().join("+"); sharedBy[k] = (sharedBy[k] ?? 0) + 1; }
		const summary = {
			mounted, seconds: Math.round(s * 100) / 100, strokes: r.strokes,
			raf: { frames: frames.length, callbacks, perFrame: frames.length ? Math.round((callbacks / frames.length) * 100) / 100 : null,
				framesWithMoreThanOne: shared.length, sharedBy, requestedBy: r.rafReq },
			timersPerSecond: { set: perAll(r.timerSet, s), cleared: perAll(r.timerClear, s), fired: perAll(r.timerFired, s) },
			getComputedStyle: { calls: r.gcs, perSecond: per(r.gcs, s), by: r.gcsBy },
			events: { sent: r.sent, samplesToStroke: r.samples, contactRaws: r.seen.raws, coalescedSeen: r.seen.coalesced },
			attributeWritesPerSecond: perAll(r.mut, s),
			pointerUpMs: { n: r.upMs.length, p50: pct(r.upMs, 0.5), p95: pct(r.upMs, 0.95), max: pct(r.upMs, 1) },
			pendingOneSecondAfter: { raf: r.pendingRaf, timers: r.pendingTimers },
		};
		record.push({ summary, frames });
		console.log("POWER-DRAW-BASELINE " + JSON.stringify(summary));
		const brief = "\n" + JSON.stringify(summary, null, 1);
		expect(errors, "page errors").toEqual([]);
		expect(mounted.canvasMode, `premise: Infinite Canvas off${brief}`).toBe(false);
		expect(r.strokes, `the replay ran: every stroke landed on the note${brief}`).toBe(STROKES);
		expect(r.samples, `the replay ran: samples reached the stroke${brief}`).toBeGreaterThan(STROKES * DOWN_FRAMES);
		// One frame callback per frame while writing: the present probe rides the stroke's frame ticker, and asks for a
		// frame of its own only for a batch still waiting when the stroke lifts. The "other" row stays at its 29.
		expect(summary.raf.sharedBy["presentProbe+ticker"] ?? 0, `no frame runs the ticker and the present probe both${brief}`).toBe(0);
		expect(r.rafReq.presentProbe ?? 0, `the present probe's own frames, at most one per stroke${brief}`).toBeLessThanOrEqual(STROKES);
		expect(r.rafReq.other ?? 0, `other frame requests stay at the baseline's 29${brief}`).toBeLessThanOrEqual(29);
		// No timer per pen event: the snap dwell and the hover watchdog each keep one timer that re-arms for the rest when
		// it fires, where the baseline set and cleared one on nearly every sample (87.9 and 15 a second). "Other" stays at 9.
		const set = summary.timersPerSecond.set as Record<string, number>;
		expect(set.snapPreview ?? 0, `snap preview timers set per second${brief}`).toBeLessThanOrEqual(10);
		expect(set.hoverWatchdog ?? 0, `hover watchdog timers set per second${brief}`).toBeLessThanOrEqual(5);
		expect(set.other ?? 0, `other timers set per second stay at the baseline's 9${brief}`).toBeLessThanOrEqual(9);
		// A hover sample moves the reticle and writes nothing else: its classes once per mode or shown change, one style
		// property per sample, and the scroller's hover class only when absent (baseline 60, 21.1 and 15.1 a second).
		const writes = summary.attributeWritesPerSecond as Record<string, number>;
		expect(writes["cursor:class"] ?? 0, `cursor class writes per second${brief}`).toBeLessThanOrEqual(1);
		expect(writes["scroller:class"] ?? 0, `scroller class writes per second${brief}`).toBeLessThanOrEqual(7);
		expect(writes["cursor:style"] ?? 0, `cursor style writes per second${brief}`).toBeLessThanOrEqual(21.1);
	} finally { await page.close(); }
}, 300_000);
