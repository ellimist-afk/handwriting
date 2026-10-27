/**
 * ZOOM SETTLE BASELINE (measurement, no bar): what one zoom settle costs on a real note.
 *
 * Before any change to the settle, measure it on a real note (one of Alan's own notes):
 * whole repaints per zoom commit, by-path settle ms, the longest task, and the swap placement with the stand-in forced on.
 *
 * Arms, each from 25 percent with the whole raster held (the state Alan's trace started in):
 *   - pinch: a two-finger pinch to 10 percent over 12 frames, then the lift (the settle Alan's trace shows).
 *   - bar: a zoom commit to 10 percent as the zoom bar makes it (zoomAroundCenter).
 * HW_ZSB_STANDIN=1 bundles the overlay with ZOOM_STAND_IN_ENABLED true (a rewrite of the bundle's copy of the constant; the source
 * is untouched) and adds the placement read: the soft frame's ink against the path draw at its camera, with the pieces held.
 *
 * Inputs: HW_ZSB_SIDECAR=<path to the ink copy>, HW_ZSB_PAGE=<its page id>, HW_ZSB_OUT=<json path>. Without the sidecar the cell skips.
 * The cell asserts premises (the note loaded, the zoom committed) and, with the stand-in on, the pinch arm's lift:
 * the stand-in held at the settle, its ink within 0.1 device px of the path draw, no whole paint by path in the lift's task. The rest is recorded.
 *
 * Run: npx vitest run --config vitest.render.mts test/render/ZoomSettleBaseline.test.ts
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build, type Plugin } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

declare const process: { env: Record<string, string | undefined> };
const SIDECAR = process.env.HW_ZSB_SIDECAR ?? "";
const PAGE_ID = process.env.HW_ZSB_PAGE ?? "51d26371-71e5-4107-a62e-f621ce8c080d";
const OUT = process.env.HW_ZSB_OUT ?? "";
const STANDIN = process.env.HW_ZSB_STANDIN === "1";
// The stand-in is on in the source since commit 2 (75780d1c); the forced bundle is then the same build, and the readouts run either way.
const SOURCE_ON = readFileSync(fileURLToPath(new URL("../../src/inline/InkOverlayConstants.ts", import.meta.url)), "utf8").includes("export const ZOOM_STAND_IN_ENABLED: boolean = true;");
const STANDIN_ON = STANDIN || SOURCE_ON;
// HW_ZSB_TIMING=1: time the settle as the app runs it. The recorder's per-copy check is off, the pieces are not held, and the
// placement read and the pinch asserts that need it are skipped.
const TIMING = process.env.HW_ZSB_TIMING === "1";
const READ = STANDIN_ON && !TIMING;
const MINIMAL_CSS = readFileSync(fileURLToPath(new URL("./fixtures/minimal-9.0.2-theme.css", import.meta.url)), "utf8");
const PANE = { w: 1184, h: 824 };
const DSF = 2;
const FROM = 0.25, TO = 0.10, STEPS = 12;

/** The stand-in switch turned on in the bundle's copy of InkOverlayConstants.ts, for the forced arm only. */
const standInOn: Plugin = {
	name: "zsb-stand-in-on",
	setup(b) {
		b.onLoad({ filter: /InkOverlayConstants\.ts$/ }, args => {
			const src = readFileSync(args.path, "utf8");
			const out = src.replace("export const ZOOM_STAND_IN_ENABLED: boolean = false;", "export const ZOOM_STAND_IN_ENABLED: boolean = true;");
			if (out === src) throw new Error("zsb: ZOOM_STAND_IN_ENABLED line not found");
			return { contents: out, loader: "ts" };
		});
	},
};

let browser: Browser, script: string;
const report: unknown[] = [];
beforeAll(async () => {
	const b = await build({ entryPoints: [fileURLToPath(new URL("./zoomSettleBaselinePage.ts", import.meta.url))], bundle: true, write: false, format: "iife", platform: "browser",
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) }, plugins: STANDIN && !SOURCE_ON ? [standInOn] : [] });
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true, args: [`--force-device-scale-factor=${DSF}`, "--window-size=1700,1000"] });
}, 180_000);
afterAll(async () => {
	await browser?.close();
	if (OUT) writeFileSync(OUT, JSON.stringify({ standIn: STANDIN, from: FROM, to: TO, steps: STEPS, arms: report }, null, 1));
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const call = <T>(page: Page, obj: "panBake" | "zsb", name: string, ...a: unknown[]) =>
	page.evaluate(([o, n, args]) => (window as any)[o as string][n as string](...(args as unknown[])), [obj, name, a] as const) as Promise<T>;

for (const arm of ["pinch", "bar"] as const) it.skipIf(!SIDECAR)(`${arm}: a zoom settle from ${FROM * 100} to ${TO * 100} percent on the ink copy${STANDIN ? ", stand-in forced on" : ""}, measured`, async () => {
	const context = await browser.newContext({ viewport: null, hasTouch: true });
	const page = await context.newPage();
	const errors: string[] = [], warnings: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	page.on("console", m => { if (m.type() === "warning" || m.type() === "error") warnings.push(m.text().slice(0, 200)); });
	try {
		const sidecar = readFileSync(SIDECAR, "utf8");
		const want = (JSON.parse(sidecar).strokes as unknown[]).length;
		await page.setContent(`<!doctype html><body class="theme-dark" style="margin:0; --font-text-size:19px; --background-modifier-border:#777777"></body>`);
		await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
		await page.addStyleTag({ content: MINIMAL_CSS });
		await page.addScriptTag({ content: script });
		const mounted = await call<any>(page, "panBake", "mount", FROM, sidecar, PAGE_ID, PANE.w, PANE.h, want);
		expect(errors).toEqual([]);
		expect(mounted.strokes, "premise: every stroke loaded").toBe(want);
		expect(mounted.zoomCommitted, "premise: the start zoom committed").toBe(true);
		await sleep(600);
		const whole0 = await call<{ pending: boolean; ext: any }>(page, "panBake", "awaitWhole");
		expect(whole0.pending, "premise: the mount's build finished").toBe(false);
		await call(page, "panBake", "record");
		if (TIMING) await call(page, "panBake", "checksOff");
		await call(page, "zsb", "watch");
		await call(page, "zsb", "clearTasks");
		if (READ) await call(page, "panBake", "holdPieces", true);
		const g = arm === "pinch" ? await call<any>(page, "zsb", "pinch", TO / FROM, STEPS) : await call<any>(page, "zsb", "commit", TO);
		let place: unknown = null, held: unknown = null;
		if (READ) {
			await sleep(300);
			held = await call(page, "panBake", "standIn");
			// At 10 percent the note's ink is a small patch: the window is the layer less the read's 3 px reach and a margin, not the default 600 px.
			const size = await call<{ w: number; h: number }>(page, "zsb", "layerSize"), n = Math.max(0, Math.min(size.w, size.h) - 16);
			place = (held as any)?.held ? await call(page, "panBake", "placeVsPath", n) : null;
			await call(page, "panBake", "holdPieces", false);
		}
		const s = await call<any>(page, "zsb", "settled", g.t0);
		const reallocs = await call(page, "zsb", "reallocs");
		// The recorder's own whole rows after the gesture: copies from the raster, copies it refused and why, stand-in copies, path points.
		const copyRows = (await call<any[]>(page, "panBake", "rows")).filter(r => r.t >= g.t0 - 1 && r.painted && r.work === "all")
			.map(r => ({ at: Math.round(r.t - g.t0), pts: r.pts, copies: r.copies ?? 0, copyMiss: r.copyMiss ?? 0, missWhy: r.copyMiss ? r.missWhy : undefined, stand: r.standCopies ?? 0, ext: r.ext }));
		await call(page, "zsb", "unwatch");
		await call(page, "panBake", "stop");
		const row = {
			arm, standIn: STANDIN_ON, timing: TIMING, strokes: mounted.strokes, extentAtStart: whole0.ext ? { count: whole0.ext.count } : null, gesture: g,
			wholePaints: s.paints.length, wholeInTask: s.paints.filter((p: any) => p.inTask).length, wholeOnBounce: s.paints.filter((p: any) => p.bounce).length,
			wholeMs: s.paints.map((p: any) => Math.round(p.ms * 10) / 10), wholeAt: s.paints.map((p: any) => Math.round(p.at)),
			byPathMs: Math.round(s.paints.reduce((a: number, p: any) => a + p.ms, 0) * 10) / 10,
			longest: Math.round(s.longest * 10) / 10, tasks: s.tasks.map((t: any) => [Math.round(t.at), Math.round(t.ms)]),
			lastPaintEnd: Math.round(s.lastPaintEnd), sawBounce: s.sawBounce, sharpAt: Math.round(s.sharpAt), heldAfter: s.held, buildingAfter: s.building, timedOut: s.timedOut,
			paintRows: s.paints.map((p: any) => ({ at: Math.round(p.at), ms: Math.round(p.ms * 10) / 10, inTask: p.inTask, bounce: p.bounce, mayBuild: p.mayBuild, ext: p.ext,
				heldBefore: p.heldBefore, heldAfter: p.heldAfter, buildAfter: p.buildAfter, deferrals: p.deferrals, copies: p.copies, pts: p.pts })),
			fates: s.fates, copyRows,
			pieceRuns: s.pieceRuns.map((r: any) => ({ at: Math.round(r.at), ms: Math.round(r.ms * 10) / 10, drew: r.drew, bounce: r.bounce })),
			bounceGaps: s.bounceGaps.map((g: number) => Math.round(g * 10) / 10),
			perBounceFrame: s.perBounceFrame, bounceEndAt: Math.round(s.bounceEndAt),
			placeVsPath: place, standInAtSettle: held, reallocs, errors, warnings: warnings.slice(0, 5),
		};
		console.log(`ZSB ${JSON.stringify(row)}`);
		report.push(row);
		expect(g.scale, "premise: the zoom settled at the target").toBeCloseTo(TO, 3);
		// In timing mode the pinch's crisp layer is whole under 1000 ms, its live frames write no
		// backing, no whole paint goes by path, at most one piece runs between two consecutive bounce frames, and every piece is under 5 ms.
		if (TIMING && STANDIN_ON && arm === "pinch") {
			expect(s.sawBounce, "premise: a bounce played after the lift").toBe(true);
			expect(s.sharpAt >= 0 && s.sharpAt < 1000, `pinch: crisp under 1000 ms (${s.sharpAt} ms)`).toBe(true);
			expect(g.live, "pinch: no backing write on the live frames").toBe(0);
			expect(s.perBounceFrame.length, "premise: bounce frames read").toBeGreaterThan(0);
			expect(Math.max(...s.perBounceFrame), `pinch: at most one piece between two bounce frames (${JSON.stringify(s.perBounceFrame)})`).toBeLessThanOrEqual(1);
			const slow = s.pieceRuns.filter((r: any) => r.ms >= 5).map((r: any) => ({ piece: Math.round(r.at), ms: r.ms }));
			expect(slow, "pinch: every piece under 5 ms").toEqual([]);
			expect(s.paints.filter((p: any) => p.pts > 0).length, "pinch: no whole paint by path").toBe(0);
		}
		// The pinch's lift takes the stand-in as the bar does. Held at the settle, placed at the path draw,
		// and the lift's own task paints nothing by path.
		if (READ && arm === "pinch") {
			const st = held as any, pl = place as any;
			expect(st?.held, `pinch: the stand-in held at the settle (${JSON.stringify(st)})`).toBe(true);
			expect(pl?.inked, "premise: path ink in the placement window").toBeGreaterThan(0);
			expect(Math.abs(pl.dx) < 0.1 && Math.abs(pl.dy) < 0.1, `pinch: the stand-in's ink within 0.1 device px of the path draw (${JSON.stringify(pl)})`).toBe(true);
			const inTask = s.paints.filter((p: any) => p.inTask && p.pts > 0).map((p: any) => ({ at: Math.round(p.at), ms: Math.round(p.ms), pts: p.pts }));
			expect(inTask, "pinch: no whole paint by path in the lift's own task").toEqual([]);
		}
		expect(errors, "no page errors").toEqual([]);
	} finally { await context.close(); }
}, 300_000);
