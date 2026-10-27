/**
 * Grid paper stays on the text through a pinch mid-page and at the lift, under Alan's settings.
 *
 * Alan on Orion: the grid lines move very slightly while he pinches in and out mid-page, then jump more right after he
 * lets go. The product rule: at the lift the page stays where the last preview frame painted it, the paper included.
 *
 * Setup mirrors Orion: grid paper, Readable line length on, Infinite Canvas on (the rig's scroll expansion), scrolled
 * mid-page (scrollTop 1200), outer scale 0.913 and 1 (a CSS transform on the editor's host, read by the plugin as the
 * external scale), device scale 1.8257 and 2. Regime: the device scale is forced with Chromium's
 * --force-device-scale-factor launch flag, never a page deviceScaleFactor; every log line says which.
 *
 * Each arm pinches 100 to 30 percent and, from a committed 30 percent, 30 back to 100 percent, without a pause at the
 * end. The paper's lattice origin is read on every preview frame, then 14 times after the lift: in the lift's own
 * task, after each of the next 12 rendered frames (logged, not asserted: a settle ease may be gliding), and 300 ms later. One vertical rule against the text column's left edge and one
 * horizontal rule against the first line's top, modulo the pitch, in device px at that reading's own zoom. Two
 * invariants, each within 1 device px: the rules sit on the text (the column's left edge and the first line's top are
 * lattice lines) on every reading; and the lift moves nothing, so every reading after it equals the last preview frame.
 * Not "equal to the value at rest before the gesture": the paper's phase is put on the device px grid at the committed
 * zoom, so at 30 percent the rest reading may sit up to half a device px off the text, which the preview carries back out
 * and which reads as 1.67 device px once the zoom is back at 100 percent. The lattice origin comes from what the stylesheet reads (the rig's
 * paperOrigin: the preview element during a preview, the scroller's own background at rest); it is checked against
 * real screenshot pixels at rest and on the last live frame first, so it cannot be a model of something else.
 *
 * Plants, each built into the page by an exact source substitution, the count applied asserted:
 *   HW_GRID_PINCH_PLANT_DRIFT=1   the column's re-centring handed to the paper carries a quarter pitch more painted px
 *                                 (a drift error: the vertical rules leave the column on live frames; a whole pitch
 *                                 would be invisible modulo the pitch);
 *   HW_GRID_PINCH_PLANT_SLOW_AFTER=1    a 150 ms main-thread block in the first task after the settle task, as Orion's
 *                                       raster repaint of 4313 strokes blocks it (a slow landing, not a defect plant);
 *   HW_GRID_PINCH_PLANT_SLOW_MEASURE=1  a 150 ms main-thread block before the settle's first measure attempt (same).
 * The two slow plants change no product logic: green under them clears the slow landing, red names the frame and layer.
 * Under either slow plant every arm asserts that the first read after the lift came at least 100 ms after it.
 *   HW_GRID_PINCH_PLANT_SCROLL_OUTSIDE=1  the scroll taken under the fingers is put back outside the multiplication by
 *                                 the scale, not inside it: reds the scrolled-sideways arms (about 3 device px on the
 *                                 tenth, where the scroll is taken at scale 0.5).
 *   HW_GRID_PINCH_PLANT_FORM_NO_OUTER=1  the scroll taken under the fingers is put back without the outer scale: reds
 *                                 the nudged twin (outer 0.913, 20 px at scale 0.5), where only the outer scale tells
 *                                 the two forms apart; at outer 1 the forms are equal.
 *   HW_GRID_PINCH_TRACE=1  not a plant: diagnostics on and every probe extent line copied to the console, so each arm
 *                          logs its "settle paper" lines and asserts the settle, measure and 12 frame stages printed.
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import { decodePng } from "./pngInk";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

declare const process: { env: Record<string, string | undefined> };

const OBSIDIAN_CAMERA_CSS = readFileSync(fileURLToPath(new URL("./noteViewportCamera.css", import.meta.url)), "utf8");
const PITCH = 28, TOL_DEV = 1, SCROLL_TOP = 1200;
const PAGE_GREY = 255, RULE_GREY = 0x77;
const SETUPS = [
	{ dsf: 1.8257, outer: 0.913 },
	{ dsf: 1.8257, outer: 1 },
	{ dsf: 2, outer: 0.913 },
	{ dsf: 2, outer: 1 },
] as const;
const ARMS = [
	{ name: "zoom out 100 to 30 percent", from: 1, to: 0.3 },
	{ name: "zoom in 30 to 100 percent", from: 0.3, to: 1 },
] as const;

const PLANTS: { env: string; from: string; to: string; file?: RegExp }[] = [
	{ env: "HW_GRID_PINCH_PLANT_DRIFT", file: /InkOverlayPanSettle\.ts$/, from: "const drift = columnLocal === null || a.columnLocal === null ? 0 : (columnLocal - a.columnLocal + (nativeLeft - a.scrollLeft) * outer) * next;", to: "const drift = columnLocal === null || a.columnLocal === null ? 0 : (columnLocal - a.columnLocal + (nativeLeft - a.scrollLeft) * outer) * next + 7 * next;" },
	{ env: "HW_GRID_PINCH_PLANT_SCROLL_OUTSIDE", file: /InkOverlayPanSettle\.ts$/, from: "const drift = columnLocal === null || a.columnLocal === null ? 0 : (columnLocal - a.columnLocal + (nativeLeft - a.scrollLeft) * outer) * next;", to: "const drift = columnLocal === null || a.columnLocal === null ? 0 : (columnLocal - a.columnLocal) * next + (nativeLeft - a.scrollLeft) * outer;" },
	{ env: "HW_GRID_PINCH_PLANT_FORM_NO_OUTER", file: /InkOverlayPanSettle\.ts$/, from: "const drift = columnLocal === null || a.columnLocal === null ? 0 : (columnLocal - a.columnLocal + (nativeLeft - a.scrollLeft) * outer) * next;", to: "const drift = columnLocal === null || a.columnLocal === null ? 0 : (columnLocal - a.columnLocal + (nativeLeft - a.scrollLeft)) * next;" },
	{ env: "HW_GRID_PINCH_PLANT_SLOW_AFTER", file: /InkOverlayPinch\.ts$/, from: "else this.endPreviewPaper(\"settle\");", to: "else this.endPreviewPaper(\"settle\"); setTimeout(() => { const t0 = performance.now(); while (performance.now() - t0 < 150) { /* block */ } }, 0);" },
	{ env: "HW_GRID_PINCH_TRACE", file: /DiagSwitch\.ts$/, from: "let enabled = false;", to: "let enabled = true;" },
	{ env: "HW_GRID_PINCH_TRACE", file: /ScrollProbe\.ts$/, from: "push({ kind: \"extent\", t: performance.now(), what });", to: "push({ kind: \"extent\", t: performance.now(), what }); console.log(`PROBE ${what}`);" },
	{ env: "HW_GRID_PINCH_PLANT_SLOW_MEASURE", file: /InkOverlayZoomApi\.ts$/, from: "const measure={key:this,read:()=>owns()&&matchesScroll()?geometry():null,write:(before:number[]|null)=>{", to: "const measure={key:this,read:()=>owns()&&matchesScroll()?geometry():null,write:(before:number[]|null)=>{if(hold&&hold.attempts===0){const t0=performance.now();while(performance.now()-t0<150){/* block */}}" },
];

let script: string;
const browsers = new Map<number, Browser>();
beforeAll(async () => {
	const active = PLANTS.filter(pl => process.env[pl.env]);
	let planted = 0;
	const b = await build({
		entryPoints: [fileURLToPath(new URL("./noteViewportCameraPage.ts", import.meta.url))],
		bundle: true, write: false, format: "iife", platform: "browser",
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
		plugins: active.length ? [{ name: "grid-pinch-plants", setup(builder) {
			builder.onLoad({ filter: /src[\\/](inline[\\/](InkOverlay|InkOverlayPanSettle|InkOverlayZoomApi|InkOverlayPinch|ScrollProbe)|diag[\\/]DiagSwitch)\.ts$/ }, args => {
				let text = readFileSync(args.path, "utf8").replace(/\r\n/g, "\n");
				for (const pl of active.filter(pl => (pl.file ?? /InkOverlay\.ts$/).test(args.path))) {
					if (text.split(pl.from).length !== 2) throw new Error(`${pl.env}: anchor not found once`);
					text = text.replace(pl.from, pl.to);
					planted++;
				}
				return { loader: "ts", contents: text };
			});
		} }] : [],
	});
	if (planted !== active.length) throw new Error(`plants requested ${active.length}, applied ${planted}`);
	script = b.outputFiles[0]!.text;
	for (const dsf of new Set(SETUPS.map(s => s.dsf)))
		browsers.set(dsf, await chromium.launch({ headless: true, args: [`--force-device-scale-factor=${dsf}`, "--window-size=900,700"] }));
}, 180_000);
afterAll(async () => { for (const b of browsers.values()) await b.close(); });

/** Grid paper, Readable line length on with a 320 px column in the 640 px editor, outer scale on the host, mid-page. */
async function mount(p: Page, outer: number, zoom: number, left = 0) {
	await p.setContent(`<!doctype html><body class="handwriting-paper-grid" style="margin:0; background:#ffffff; --background-modifier-border:#777777"></body>`);
	await p.addStyleTag({ content: css + OBSIDIAN_CAMERA_CSS });
	await p.addStyleTag({ content: `${REAL_OBSIDIAN_CSS}\nbody { --file-line-width: 320px; }` });
	await p.evaluate(() => {
		new MutationObserver(recs => { for (const r of recs) r.addedNodes.forEach(n => { if (n instanceof HTMLElement && n.classList.contains("camera-proof")) n.classList.add("mod-cm6", "is-readable-line-width"); }); })
			.observe(document.body, { childList: true });
	});
	await p.addScriptTag({ content: script });
	await p.evaluate(async ({ outer, zoom, top, left }) => {
		const vf = (window as any).viewportFixture;
		await vf.setup("paper", "far", 1, outer, "x");
		const content = document.querySelector(".cm-content") as HTMLElement;
		const sizer = document.createElement("div"); sizer.className = "cm-sizer";
		const container = document.createElement("div"); container.className = "cm-contentContainer";
		content.parentElement!.insertBefore(sizer, content); sizer.appendChild(container); container.appendChild(content);
		await vf.settle();
		await (window as any).edgeAudit.commit("paper", zoom);
		(document.querySelector(".cm-scroller") as HTMLElement).scrollTop = top;
		if (left) (document.querySelector(".cm-scroller") as HTMLElement).scrollLeft = left;
		await vf.settle();
		await vf.rest();
		(window as any).__gridModel = (dsf: number) => {
			const line = (document.querySelector(".cm-line") as HTMLElement).getBoundingClientRect(), sc = document.querySelector(".cm-scroller") as HTMLElement;
			const o = vf.paperOrigin("paper") as { source: string; x: number; y: number; k: number; pitch: number };
			const mod = (v: number) => ((v % o.pitch) + o.pitch) % o.pitch;
			return { k: o.k, source: o.source, sx: mod((line.left - o.x) / o.k), sy: mod((line.top - o.y) / o.k), dsf,
				scrollLeft: sc.scrollLeft, scrollTop: sc.scrollTop, preview: !!vf.preview("paper"), sizer: (document.querySelector(".cm-sizer") as HTMLElement).style.transform };
		};
	}, { outer, zoom, top: SCROLL_TOP, left });
}

type Reading = { k: number; source: string; sx: number; sy: number; dsf: number; scrollLeft: number; scrollTop: number; preview: boolean; sizer: string; at?: string; t?: number };
const model = (p: Page, dsf: number): Promise<Reading> => p.evaluate(d => (window as any).__gridModel(d), dsf);

/** Weighted band centres along one projection: runs above a quarter of the projection's range. */
function bandCentres(profile: number[]): number[] {
	const lo = Math.min(...profile), hi = Math.max(...profile);
	if (hi - lo < 0.03) return [];
	const cut = lo + (hi - lo) / 4, out: number[] = [];
	for (let i = 0; i < profile.length; i++) {
		if (profile[i]! <= cut) continue;
		let j = i, w = 0, m = 0;
		while (j < profile.length && profile[j]! > cut) { const v = profile[j]! - cut; w += v; m += v * (j + 0.5); j++; }
		out.push(m / w);
		i = j;
	}
	return out;
}

/**
 * The instrument: the screenshot's rule positions against the model's lattice origin, device px, modulo the pitch.
 * A rule's centre sits half a rule width before the lattice line (the rule is drawn just before the pitch boundary).
 */
async function pixelVsModel(p: Page, dsf: number) {
	const g = await p.evaluate(() => {
		const sc = (document.querySelector(".cm-scroller") as HTMLElement).getBoundingClientRect();
		const o = (window as any).viewportFixture.paperOrigin("paper");
		const rule = Number.parseFloat(getComputedStyle(document.querySelector(".cm-editor") as HTMLElement).getPropertyValue("--handwriting-paper-rule")) || 1;
		return { left: sc.left, top: sc.top, width: sc.width, height: sc.height, ox: o.x as number, oy: o.y as number, k: o.k as number, pitch: o.pitch as number, rule };
	});
	const clip = { x: Math.round(g.left + 20), y: Math.round(g.top + 20), width: Math.min(220, Math.floor(g.width - 40)), height: Math.min(220, Math.floor(g.height - 40)) };
	const d = decodePng(await p.screenshot({ clip }));
	const rows: number[] = new Array(d.height).fill(0), cols: number[] = new Array(d.width).fill(0);
	for (let y = 0; y < d.height; y++) for (let x = 0; x < d.width; x++) {
		const i = (y * d.width + x) * d.channels;
		const f = Math.max(0, Math.min(1, (PAGE_GREY - (d.px[i]! + d.px[i + 1]! + d.px[i + 2]!) / 3) / (PAGE_GREY - RULE_GREY)));
		rows[y] = rows[y]! + f / d.width; cols[x] = cols[x]! + f / d.height;
	}
	const pDev = g.pitch * g.k * dsf, ruleDev = g.rule * g.k * dsf;
	const lattice = (cs: number[]) => cs.filter(c => cs.some(o => { const dd = Math.abs(o - c); const n = Math.round(dd / pDev); return n >= 1 && Math.abs(dd - n * pDev) <= 2; }));
	const circ = (a: number, q: number) => { const r = ((a % q) + q) % q; return Math.min(r, q - r); };
	const off = (cs: number[], origin: number) => cs.length ? Math.max(...cs.slice(0, 6).map(c => circ(c - (origin - ruleDev / 2), pDev))) : Number.NaN;
	const cx = lattice(bandCentres(cols)), cy = lattice(bandCentres(rows));
	return { x: off(cx, (g.ox - clip.x) * dsf), y: off(cy, (g.oy - clip.y) * dsf), counts: [cx.length, cy.length], pDev };
}

/** Circular distance in layout px between two places modulo the pitch, converted to device px at zoom k. */
const offDev = (a: number, b: number, k: number, dsf: number) => { const r = (((a - b) % PITCH) + PITCH) % PITCH; return Math.min(r, PITCH - r) * k * dsf; };
const r2 = (v: number) => Math.round(v * 100) / 100;

for (const setup of SETUPS) for (const arm of ARMS) {
	it(`${arm.name} mid-page, grid paper, Readable line length on, Infinite Canvas on, outer scale ${setup.outer}, forced dpr ${setup.dsf}: the rules stay on the text on every frame and at the lift, within ${TOL_DEV} device px`, async () => {
		const context = await browsers.get(setup.dsf)!.newContext({ viewport: null });
		const p = await context.newPage();
		const errors: string[] = [];
		p.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
		const trace: string[] = [];
		p.on("console", m => { const t = m.text(); if (t.startsWith("PROBE settle")) trace.push(t.slice(6)); });
		try {
			await mount(p, setup.outer, arm.from);
			const dpr = await p.evaluate(() => devicePixelRatio);
			expect(dpr, `premise: regime forced --force-device-scale-factor=${setup.dsf}`).toBeCloseTo(setup.dsf, 3);
			const rest = await model(p, setup.dsf);
			expect(rest.source, "premise: at rest the paper is the scroller's own background").toBe("scroller");
			expect(rest.k / setup.outer, `premise: the committed zoom is ${arm.from}`).toBeCloseTo(arm.from, 3);
			expect(rest.scrollTop, "premise: mid-page, scrolled well below the top").toBeGreaterThan(300);
			const restPx = await pixelVsModel(p, setup.dsf);
			expect(Math.min(...restPx.counts), `premise: rules found at rest on both axes ${JSON.stringify(restPx)}`).toBeGreaterThanOrEqual(3);
			expect(Math.max(restPx.x, restPx.y), `instrument: at rest the model's lattice agrees with the pixels within 1.5 device px ${JSON.stringify(restPx)}`).toBeLessThanOrEqual(1.5);

			// Fingers down mid-pane; one move per rendered frame, read after the overlay's own frame ran.
			const steps = 16, ratio = arm.to / arm.from, cx = Math.round(300 * setup.outer), cy = Math.round(220 * setup.outer);
			const spread0 = ratio < 1 ? 300 : 90;
			const live = await p.evaluate(async ({ steps, ratio, cx, cy, spread0, dsf }) => {
				const send = (type: string, pid: number, x: number, y: number) => {
					const target = document.elementFromPoint(x, y);
					if (!target) throw new Error(`pinch point (${x},${y}) outside the page`);
					target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "touch", pointerId: pid, isPrimary: pid === 701, clientX: x, clientY: y, buttons: type === "pointerup" ? 0 : 1, width: 8, height: 8 }));
				};
				const raf = () => new Promise<void>(r => requestAnimationFrame(() => r()));
				const read = (window as any).__gridModel as (d: number) => any;
				const out: any[] = [];
				send("pointerdown", 701, cx - spread0 / 2, cy);
				send("pointerdown", 702, cx + spread0 / 2, cy);
				await raf();
				let half = spread0 / 2;
				for (let i = 1; i <= steps; i++) {
					half = (spread0 / 2) * ratio ** (i / steps);
					send("pointermove", 701, cx - half, cy);
					send("pointermove", 702, cx + half, cy);
					await raf();
					out.push({ ...read(dsf), at: `frame ${i}` });
				}
				(window as any).__lift = () => { send("pointerup", 701, cx - half, cy); send("pointerup", 702, cx + half, cy); };
				return out;
			}, { steps, ratio, cx, cy, spread0, dsf: setup.dsf }) as Reading[];
			const last = live.at(-1)!;
			expect(last.preview, "frame identity: the preview is live on the last move frame").toBe(true);
			expect(last.k / setup.outer, `premise: the preview reached ${arm.to}`).toBeCloseTo(arm.to, 1);
			const livePx = await pixelVsModel(p, setup.dsf);
			expect(Math.max(livePx.x, livePx.y), `instrument: on the last live frame the model's lattice agrees with the pixels within 1.5 device px ${JSON.stringify(livePx)}`).toBeLessThanOrEqual(1.5);

			const after = await p.evaluate(async (dsf) => {
				const read = (window as any).__gridModel as (d: number) => any;
				const rendered = () => new Promise<void>(r => requestAnimationFrame(() => setTimeout(r, 0)));
				const t0 = performance.now();
				(window as any).__lift();
				const out: any[] = [{ ...read(dsf), at: "lift task", t: Math.round(performance.now() - t0) }];
				for (let f = 1; f <= 12; f++) { await rendered(); out.push({ ...read(dsf), at: `after frame ${f}`, t: Math.round(performance.now() - t0) }); }
				await new Promise(r => setTimeout(r, 300)); out.push({ ...read(dsf), at: "300 ms", t: Math.round(performance.now() - t0) });
				return out;
			}, setup.dsf) as Reading[];
			expect(after.at(-1)!.preview, "frame identity: 300 ms after the lift the preview has ended").toBe(false);

			// x, y: the rules against the text, absolute. lx, ly: against the last preview frame (readings after the lift only).
			const rows = [...live, ...after].map((r, i) => ({ at: r.at, ...(r.t === undefined ? {} : { t: r.t }), source: r.source, k: Math.round(r.k * 1e4) / 1e4,
				x: r2(offDev(r.sx, 0, r.k, setup.dsf)), y: r2(offDev(r.sy, 0, r.k, setup.dsf)),
				vsRestX: r2(offDev(r.sx, rest.sx, r.k, setup.dsf)), vsRestY: r2(offDev(r.sy, rest.sy, r.k, setup.dsf)),
				...(i >= live.length ? { lx: r2(offDev(r.sx, last.sx, r.k, setup.dsf)), ly: r2(offDev(r.sy, last.sy, r.k, setup.dsf)) } : {}),
				scroll: [Math.round(r.scrollLeft * 10) / 10, Math.round(r.scrollTop * 10) / 10] }));
			// eslint-disable-next-line no-console
			console.log(`GRID-PINCH regime=forced-dsf ${setup.dsf} outer ${setup.outer} ${arm.name}`, JSON.stringify({ rest: { sx: rest.sx, sy: rest.sy, k: rest.k, x: r2(offDev(rest.sx, 0, rest.k, setup.dsf)), y: r2(offDev(rest.sy, 0, rest.k, setup.dsf)) }, restPx, livePx, rows }));
			const liveRows = rows.slice(0, live.length), liftRows = rows.slice(live.length).filter(r => r.at === "lift task" || r.at === "300 ms");
			if (process.env.HW_GRID_PINCH_PLANT_SLOW_AFTER || process.env.HW_GRID_PINCH_PLANT_SLOW_MEASURE)
				expect(after[1]!.t ?? 0, `slow plant: the first read after the lift came at least 100 ms after it ${JSON.stringify(after.map(r => [r.at, r.t]))}`).toBeGreaterThanOrEqual(100);
			expect.soft(liftRows.filter(r => (r.lx ?? 0) > TOL_DEV || (r.ly ?? 0) > TOL_DEV), `THE LIFT MOVES NOTHING: the lift task and 300 ms reads where the paper stands more than ${TOL_DEV} device px from the last preview frame ${JSON.stringify(liftRows)}`).toEqual([]);
			expect.soft(liveRows.filter(r => r.x > TOL_DEV), `LIVE x: frames where the vertical rules left the column's edge by more than ${TOL_DEV} device px ${JSON.stringify(liveRows)}`).toEqual([]);
			expect.soft(liveRows.filter(r => r.y > TOL_DEV), `LIVE y: frames where the horizontal rules left the line's top by more than ${TOL_DEV} device px ${JSON.stringify(liveRows)}`).toEqual([]);
			expect.soft(liftRows.filter(r => r.x > TOL_DEV), `LIFT x: the lift task and 300 ms reads where the vertical rules left the column's edge by more than ${TOL_DEV} device px ${JSON.stringify(liftRows)}`).toEqual([]);
			expect.soft(liftRows.filter(r => r.y > TOL_DEV), `LIFT y: the lift task and 300 ms reads where the horizontal rules left the line's top by more than ${TOL_DEV} device px ${JSON.stringify(liftRows)}`).toEqual([]);
			if (process.env.HW_GRID_PINCH_TRACE) {
				// eslint-disable-next-line no-console
				console.log(`GRID-PINCH-TRACE dsf ${setup.dsf} outer ${setup.outer} ${arm.name}\n${trace.join("\n")}`);
				const stages = ["settle paper settle before commit", "settle paper settle after commit", "settle paper measure commit", "settle paper measure attempt 1", "settle paper frame 12 "];
				expect(stages.filter(st => !trace.some(l => l.startsWith(st))), "trace: every settle paper stage printed").toEqual([]);
			}
			expect(errors).toEqual([]);
		} finally { await context.close(); }
	}, 120_000);
}

/**
 * NINTH ARM: scrolled sideways as well as down, one gesture from 100 to 30 percent and back to 100 with
 * no commit between the legs, as Alan's probes show (scrollLeft 1299 to 1300 moved by touch while he pinched). The eight
 * arms above hold scrollLeft at 0 on every preview frame, so they cannot see a term that follows a scroll moving under the
 * fingers. scrollLeft is logged on every frame, and the arm's premise is that it moved: an arm where it stays put is not a
 * test of that term. dpr 2, outer 1 is the test; dpr 1.8257, outer 0.913 is its twin, run as a probe.
 * The tenth arm is the test arm with the fingers down and, at scale about 0.5 on the way out,
 * the scroller scrolled 3 px right by the rig, as Alan's probe shows touch scroll events while he pinches. A scroll taken
 * away from scale 1 separates a term that scales with the zoom from one that does not. Every row carries rx, the vertical
 * rules' signed offset from the column's edge in device px.
 * The nudged twin is the tenth arm at dpr 1.8257, outer 0.913 with a 20 px scroll: the outer scale
 * converts the scroll's layout px into the column's outer px, and only an outer scale other than 1 tests that factor.
 */
const ONE_GESTURE = [
	{ dsf: 2, outer: 1, role: "test", nudge: 0 },
	{ dsf: 2, outer: 1, role: "test, scroller scrolled 3 px right at scale 0.5", nudge: 3 },
	{ dsf: 1.8257, outer: 0.913, role: "probe", nudge: 0 },
	{ dsf: 1.8257, outer: 0.913, role: "test, scroller scrolled 20 px right at scale 0.5", nudge: 20 },
] as const;
const SCROLL_LEFT = 600;

for (const setup of ONE_GESTURE) {
	it(`one gesture 100 to 30 to 100 percent, scrolled sideways (scrollLeft ${SCROLL_LEFT}) and mid-page, grid paper, Readable line length on, Infinite Canvas on, outer scale ${setup.outer}, forced dpr ${setup.dsf} (${setup.role}): the rules stay on the text on every frame and at the lift, within ${TOL_DEV} device px`, async () => {
		const context = await browsers.get(setup.dsf)!.newContext({ viewport: null });
		const p = await context.newPage();
		const errors: string[] = [];
		p.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
		try {
			await mount(p, setup.outer, 1, SCROLL_LEFT);
			const dpr = await p.evaluate(() => devicePixelRatio);
			expect(dpr, `premise: regime forced --force-device-scale-factor=${setup.dsf}`).toBeCloseTo(setup.dsf, 3);
			const rest = await model(p, setup.dsf);
			expect(rest.source, "premise: at rest the paper is the scroller's own background").toBe("scroller");
			expect(rest.scrollLeft, "premise: scrolled sideways before the gesture").toBeGreaterThan(SCROLL_LEFT - 50);
			expect(rest.scrollTop, "premise: mid-page, scrolled well below the top").toBeGreaterThan(300);
			const restPx = await pixelVsModel(p, setup.dsf);
			expect(Math.max(restPx.x, restPx.y), `instrument: at rest the model's lattice agrees with the pixels within 1.5 device px ${JSON.stringify(restPx)}`).toBeLessThanOrEqual(1.5);

			const steps = 18, cx = Math.round(300 * setup.outer), cy = Math.round(220 * setup.outer), half0 = 120;
			const live = await p.evaluate(async ({ steps, cx, cy, half0, dsf, nudge }) => {
				const send = (type: string, pid: number, x: number, y: number) => {
					const target = document.elementFromPoint(x, y);
					if (!target) throw new Error(`pinch point (${x},${y}) outside the page`);
					target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "touch", pointerId: pid, isPrimary: pid === 701, clientX: x, clientY: y, buttons: type === "pointerup" ? 0 : 1, width: 8, height: 8 }));
				};
				const raf = () => new Promise<void>(r => requestAnimationFrame(() => r()));
				const read = (window as any).__gridModel as (d: number) => any;
				const out: any[] = [];
				send("pointerdown", 701, cx - half0, cy);
				send("pointerdown", 702, cx + half0, cy);
				await raf();
				let ratio = 1;
				for (const [to, tag] of [[0.3, "out"], [1, "in"]] as const) {
					const from = ratio;
					for (let i = 1; i <= steps; i++) {
						ratio = from * (to / from) ** (i / steps);
						send("pointermove", 701, cx - half0 * ratio, cy);
						send("pointermove", 702, cx + half0 * ratio, cy);
						await raf();
						out.push({ ...read(dsf), at: `${tag} ${i}` });
						// Scale 0.3 ** (10 / 18) = 0.512 on the way out: the touch scroll lands with the fingers still down.
						if (nudge && tag === "out" && i === 10) {
							(document.querySelector(".cm-scroller") as HTMLElement).scrollLeft += nudge;
							await raf();
							out.push({ ...read(dsf), at: `${tag} ${i} scrolled ${nudge}` });
						}
					}
				}
				(window as any).__lift = () => { send("pointerup", 701, cx - half0 * ratio, cy); send("pointerup", 702, cx + half0 * ratio, cy); };
				return out;
			}, { steps, cx, cy, half0, dsf: setup.dsf, nudge: setup.nudge }) as Reading[];
			const last = live.at(-1)!;
			expect(last.preview, "frame identity: the preview is live on the last move frame").toBe(true);
			expect(last.k / setup.outer, "premise: the gesture came back to 100 percent").toBeCloseTo(1, 1);
			const livePx = await pixelVsModel(p, setup.dsf);
			expect(Math.max(livePx.x, livePx.y), `instrument: on the last live frame the model's lattice agrees with the pixels within 1.5 device px ${JSON.stringify(livePx)}`).toBeLessThanOrEqual(1.5);

			const after = await p.evaluate(async (dsf) => {
				const read = (window as any).__gridModel as (d: number) => any;
				const rendered = () => new Promise<void>(r => requestAnimationFrame(() => setTimeout(r, 0)));
				const t0 = performance.now();
				(window as any).__lift();
				const out: any[] = [{ ...read(dsf), at: "lift task", t: Math.round(performance.now() - t0) }];
				for (let f = 1; f <= 12; f++) { await rendered(); out.push({ ...read(dsf), at: `after frame ${f}`, t: Math.round(performance.now() - t0) }); }
				await new Promise(r => setTimeout(r, 300)); out.push({ ...read(dsf), at: "300 ms", t: Math.round(performance.now() - t0) });
				return out;
			}, setup.dsf) as Reading[];
			expect(after.at(-1)!.preview, "frame identity: 300 ms after the lift the preview has ended").toBe(false);

			const signed = (v: number, k: number) => { const m = ((v % PITCH) + PITCH) % PITCH; return (m > PITCH / 2 ? m - PITCH : m) * k * setup.dsf; };
			const rows = [...live, ...after].map((r, i) => ({ at: r.at, ...(r.t === undefined ? {} : { t: r.t }), source: r.source, k: Math.round(r.k * 1e4) / 1e4,
				x: r2(offDev(r.sx, 0, r.k, setup.dsf)), y: r2(offDev(r.sy, 0, r.k, setup.dsf)), rx: r2(signed(r.sx, r.k)),
				...(i >= live.length ? { lx: r2(offDev(r.sx, last.sx, r.k, setup.dsf)), ly: r2(offDev(r.sy, last.sy, r.k, setup.dsf)) } : {}),
				scroll: [Math.round(r.scrollLeft * 100) / 100, Math.round(r.scrollTop * 100) / 100] }));
			const liveLeft = live.map(r => r.scrollLeft), moved = Math.max(...liveLeft) - Math.min(...liveLeft);
			// eslint-disable-next-line no-console
			console.log(`GRID-PINCH-ONE-GESTURE regime=forced-dsf ${setup.dsf} outer ${setup.outer} ${setup.role} scrollLeft moved ${r2(moved)} (${r2(Math.min(...liveLeft))} to ${r2(Math.max(...liveLeft))})`, JSON.stringify({ rest: { sx: rest.sx, sy: rest.sy, k: rest.k, scrollLeft: rest.scrollLeft }, restPx, livePx, rows }));
			expect(moved, "premise: scrollLeft moved under the fingers during the gesture; an arm where it does not is not a test of the scroll term").toBeGreaterThan(0.5);
			const liveRows = rows.slice(0, live.length), liftRows = rows.slice(live.length).filter(r => r.at === "lift task" || r.at === "300 ms");
			if (process.env.HW_GRID_PINCH_PLANT_SLOW_AFTER || process.env.HW_GRID_PINCH_PLANT_SLOW_MEASURE)
				expect(after[1]!.t ?? 0, `slow plant: the first read after the lift came at least 100 ms after it ${JSON.stringify(after.map(r => [r.at, r.t]))}`).toBeGreaterThanOrEqual(100);
			expect.soft(liftRows.filter(r => (r.lx ?? 0) > TOL_DEV || (r.ly ?? 0) > TOL_DEV), `THE LIFT MOVES NOTHING: the lift task and 300 ms reads where the paper stands more than ${TOL_DEV} device px from the last preview frame ${JSON.stringify(liftRows)}`).toEqual([]);
			expect.soft(liveRows.filter(r => r.x > TOL_DEV), `LIVE x: frames where the vertical rules left the column's edge by more than ${TOL_DEV} device px ${JSON.stringify(liveRows)}`).toEqual([]);
			expect.soft(liveRows.filter(r => r.y > TOL_DEV), `LIVE y: frames where the horizontal rules left the line's top by more than ${TOL_DEV} device px ${JSON.stringify(liveRows)}`).toEqual([]);
			expect.soft(liftRows.filter(r => r.x > TOL_DEV), `LIFT x: the lift task and 300 ms reads where the vertical rules left the column's edge by more than ${TOL_DEV} device px ${JSON.stringify(liftRows)}`).toEqual([]);
			expect.soft(liftRows.filter(r => r.y > TOL_DEV), `LIFT y: the lift task and 300 ms reads where the horizontal rules left the line's top by more than ${TOL_DEV} device px ${JSON.stringify(liftRows)}`).toEqual([]);
			expect(errors).toEqual([]);
		} finally { await context.close(); }
	}, 120_000);
}
