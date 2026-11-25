/**
 * Ink at the 800 percent ceiling, in Chromium: sharp while the pen is down and after the lift.
 *
 * One real pen stroke, level across the pane, on an Infinite Canvas note pinched to 800 percent. The stroke is
 * screenshotted twice, pen down (the wet layers) and after the lift (the committed layer), and each shot is read
 * column by column across the stroke: the ink's coverage (blue's lead over red and green, so text adds nothing)
 * climbs from 10 to 90 percent over its top edge and falls back over its bottom edge. That climb, in device px,
 * is the edge ramp. A raster drawn at the painted size has a ramp of about one device px; a smaller raster
 * stretched to the zoom widens it by the stretch.
 *
 * Arms:
 * - Orion's pane (1322 x 911 css) at ratio 2 and ratio 1.8257, with 200 percent beside each as the control. The
 *   area cap does not bind there, so every live ink canvas must also hold rect x ratio in backing px, within 1.
 * - A maximised 4K pane (1900 x 1000 css at ratio 2), on a DESKTOP Platform: the pane only a desktop has, and the
 *   desktop branch of the area cap, where its 2400 x 1500 band fits the desktop budget, so every live ink canvas must
 *   hold rect x ratio in backing px, within 1, at both zooms. The page proves it ran the desktop
 *   Platform; the Orion rows keep the rig's phone Platform, where the cap does not bind either.
 *
 * Pinned per arm: the note reached its zoom (pinchScaleNow), on enough columns to mean something. At 200 percent,
 * every ramp within CONTROL_RAMP_MAX_DEVICE_PX. At 800 percent, every ramp within the same pane's 200 percent ramp
 * for that layer (worse edge) plus RAMP_MARGIN_DEVICE_PX; the 200 percent arm runs first in each pane and an 800
 * percent arm without its control is red. Printed per arm: the ramps, the bar, the backing, and the pan step
 * (measure only): how far the ink moves on screen, in device px, when the note's scroller moves one px.
 *
 * Device ratio regime: every page runs in a browser launched with the real --force-device-scale-factor flag and no
 * viewport (window-size only), never Playwright's deviceScaleFactor emulation.
 *
 * The text column: every page carries the owned `.cm-content` column rule, read verbatim from styles.css, as the app
 * does. Without it the rig's column is only CodeMirror's memo of its widest line, which it drops past 600 percent on
 * Orion's pane: the text then wraps to the pane and the tear anchor finds no line in the DOM (column probe,
 * 1.5.2/zoom-800/probe/COLUMN-PROBE-READOUT-20261116T0650Z.md, rule-on arm colrule-e6cea614-20261116T064833Z).
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { penPress, penMove, penRelease, linePoints } from "./cdpPen";
import { decodePng, type Decoded } from "./pngInk";

declare const process: { env: Record<string, string | undefined> };
const root = fileURLToPath(new URL("../../", import.meta.url));
let overlayBundle: string;
let desktopBundle: string;
let ownedColumnRule = "";
const browsers = new Map<string, Browser>();
const report: unknown[] = [];

/**
 * The bar, per pane row on medians: each 800 percent ramp
 * is at most that pane's own 200 percent ramp for the same layer, the worse of its two edges, plus this margin.
 * Why 0.25: the smallest stretch measured, 1.2 on the 4K pane, costs 0.26 at 200 percent.
 */
const RAMP_MARGIN_DEVICE_PX = 0.25;
/** Every 200 percent control ramp is at most this, so a soft control excuses nothing. */
const CONTROL_RAMP_MAX_DEVICE_PX = 2.25;
/** The control zoom each pane's 800 percent row is measured against. */
const CONTROL_ZOOM = 2;
/** A read needs at least this many columns with a full-coverage core. */
const MIN_COLUMNS = 40;
/** How far from the pen's row a column's full-coverage row may sit, device px; past it the column does not count. */
const CORE_SEARCH_DEVICE_PX = 12;

async function pageAt(dsf: number, win: { w: number; h: number }): Promise<Page> {
	const key = `${dsf}@${win.w}x${win.h}`;
	let b = browsers.get(key);
	if (!b) {
		b = await chromium.launch({ headless: true, args: [`--force-device-scale-factor=${dsf}`, `--window-size=${win.w},${win.h}`] });
		browsers.set(key, b);
	}
	const ctx = await b.newContext({ viewport: null });
	return ctx.newPage();
}

beforeAll(async () => {
	// The owned column rule as the app loads it: the styles.css block whose first selector is `head`, through its
	// closing brace. Exactly one match, and the width pins present, or the run stops: a renamed rule must not leave
	// the rig silently back on CodeMirror's memo.
	const css = readFileSync(root + "styles.css", "utf8").replace(/\r\n/g, "\n");
	const head = ".cm-editor.handwriting-note-viewport:not(.handwriting-note-viewport-own-lines) > .cm-scroller > .cm-content,\n";
	const at = css.indexOf(head);
	if (at < 0 || css.indexOf(head, at + 1) >= 0) throw new Error("styles.css: the owned column rule must match exactly once");
	ownedColumnRule = css.slice(at, css.indexOf("}", at) + 1);
	if (!ownedColumnRule.includes("min-width: var(--handwriting-note-column-width);") || !ownedColumnRule.includes("max-width: var(--handwriting-note-column-width);")) throw new Error("styles.css: the owned column rule no longer pins the width");
	const bundle = async (plugins: unknown[]) => (await build({
		entryPoints: [root + "test/render/gridFallbackPage.ts"], bundle: true, write: false, format: "iife", platform: "browser", target: "es2022",
		nodePaths: process.env.HW_TAIL_TEST_NODE_MODULES ? [process.env.HW_TAIL_TEST_NODE_MODULES] : undefined,
		alias: { obsidian: root + "test/render/iphoneObsidianStub.ts" },
		plugins: plugins as never,
	})).outputFiles[0]!.text;
	overlayBundle = await bundle([]);
	let desktopLoads = 0;
	desktopBundle = await bundle([desktopPlatform(() => desktopLoads++)]);
	if (desktopLoads !== 1) throw new Error(`the desktop Platform rewrite ran ${desktopLoads} times, want 1`);
}, 180_000);

/**
 * The rig's obsidian stub as a Windows desktop app, in the bundle only: its Platform block rewritten (matched exactly
 * once, or the build stops), plus a page marker the arm reads back, so a desktop row that silently ran the phone
 * Platform is red. Both branches give the same backing wherever the cap does not bind, so the marker is the proof.
 */
const PHONE_PLATFORM = "\tisMobile: true,\n\tisDesktop: false,\n\tisIosApp: true,\n\tisAndroidApp: false,\n\tisDesktopApp: false,\n\tisMobileApp: true,\n\tisPhone: true,\n";
const DESKTOP_PLATFORM = "\tisMobile: false,\n\tisDesktop: true,\n\tisIosApp: false,\n\tisAndroidApp: false,\n\tisDesktopApp: true,\n\tisMobileApp: false,\n\tisPhone: false,\n";
function desktopPlatform(loaded: () => void) {
	return { name: "z3-desktop-platform", setup(b: { onLoad: (o: { filter: RegExp }, cb: (a: { path: string }) => unknown) => void }) {
		b.onLoad({ filter: /[\\/]test[\\/]render[\\/]iphoneObsidianStub\.ts$/ }, (a) => {
			const s = readFileSync(a.path, "utf8").replace(/\r\n/g, "\n");
			const n = s.split(PHONE_PLATFORM).length - 1;
			if (n !== 1) throw new Error(`iphoneObsidianStub.ts: the Platform block matched ${n} times, want 1`);
			const isWin = "\tisWin: false,\n";
			if (s.split(isWin).length - 1 !== 1) throw new Error("iphoneObsidianStub.ts: isWin matched other than once");
			loaded();
			const contents = s.replace(PHONE_PLATFORM, DESKTOP_PLATFORM).replace(isWin, "\tisWin: true,\n") + "\n(globalThis as { z3Platform?: string }).z3Platform = \"desktop\";\n";
			return { contents, loader: "ts", resolveDir: a.path.replace(/[\\/][^\\/]+$/, "") };
		});
	} };
}
afterAll(async () => {
	for (const b of browsers.values()) await b.close();
	if (process.env.HW_Z3_800_REPORT) writeFileSync(process.env.HW_Z3_800_REPORT, JSON.stringify(report, null, 1));
});

const ODD_DPR = 1.8257418870925903;
type Pane = { name: string; dsf: number; pane: { w: number; h: number }; win: { w: number; h: number }; pinBacking: boolean; desktop: boolean };
const PANES: Pane[] = [
	{ name: "orion", dsf: 2, pane: { w: 1322, h: 911 }, win: { w: 1700, h: 1300 }, pinBacking: true, desktop: false },
	{ name: "orion-odd", dsf: ODD_DPR, pane: { w: 1322, h: 911 }, win: { w: 1700, h: 1300 }, pinBacking: true, desktop: false },
	{ name: "4k-max", dsf: 2, pane: { w: 1900, h: 1000 }, win: { w: 1920, h: 1080 }, pinBacking: true, desktop: true },
];
/** Control first: each pane's 800 percent row reads its bar from the 200 percent row run just before it. */
const ZOOMS = [CONTROL_ZOOM, 8] as const;
const controls = new Map<string, { wet: ReturnType<typeof ramps>; committed: ReturnType<typeof ramps> }>();

/** Ink coverage at a device px: blue's lead over red and green, 0..1. Over white this is the ink's alpha. */
function cover(d: Decoded, x: number, y: number): number {
	const i = (y * d.width + x) * d.channels;
	return Math.max(0, d.px[i + 2]! - Math.max(d.px[i]!, d.px[i + 1]!)) / 255;
}

/** Where a profile first reaches `level`, scanning from index 0, linear between samples; null if never. */
function crossing(c: number[], level: number): number | null {
	for (let k = 0; k < c.length; k++) {
		if (c[k]! < level) continue;
		if (k === 0) return 0;
		const a = c[k - 1]!, b = c[k]!;
		return k - 1 + (level - a) / (b - a);
	}
	return null;
}

function median(v: number[]): number {
	const s = [...v].sort((a, b) => a - b);
	return s.length === 0 ? NaN : s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
}

/**
 * The edge ramps of a level stroke, device px: per column in the middle of the stroke's run, the coverage profile
 * of the stroke alone; the top ramp is its 10-to-90 climb from above, the bottom ramp the same from below. The
 * stroke is the run of rows around the full-coverage row nearest `yHint` (the pen's row), bounded on each side by
 * the first row under 0.1, so any other blue on the page (paper lines, other ink) never joins a ramp. Only columns
 * with a row of 0.98 near the pen's row count, so a column that only grazes the stroke never reads as a soft edge.
 */
function ramps(d: Decoded, x0: number, x1: number, yHint: number) {
	const top: number[] = [], bottom: number[] = [], centre: number[] = [];
	const hint = Math.min(d.height - 1, Math.max(0, Math.round(yHint)));
	for (let x = Math.max(0, Math.round(x0)); x < Math.min(d.width, Math.round(x1)); x++) {
		const col: number[] = [];
		for (let y = 0; y < d.height; y++) col.push(cover(d, x, y));
		let core = -1;
		for (let r = 0; r <= CORE_SEARCH_DEVICE_PX && core < 0; r++) {
			if (hint - r >= 0 && col[hint - r]! >= 0.98) core = hint - r;
			else if (hint + r < d.height && col[hint + r]! >= 0.98) core = hint + r;
		}
		if (core < 0) continue;
		let lo = core, hi = core;
		while (lo > 0 && col[lo - 1]! >= 0.1) lo--;
		while (hi < d.height - 1 && col[hi + 1]! >= 0.1) hi++;
		const c = col.slice(Math.max(0, lo - 1), Math.min(d.height, hi + 2));
		const off = Math.max(0, lo - 1);
		const up = [...c].reverse();
		const t10 = crossing(c, 0.1), t90 = crossing(c, 0.9), b10 = crossing(up, 0.1), b90 = crossing(up, 0.9);
		if (t10 === null || t90 === null || b10 === null || b90 === null) continue;
		top.push(t90 - t10); bottom.push(b90 - b10);
		let w = 0, wy = 0;
		c.forEach((v, y) => { w += v; wy += v * (off + y + 0.5); });
		centre.push(wy / w);
	}
	return { columns: top.length, top: median(top), bottom: median(bottom), topMax: Math.max(...top), bottomMax: Math.max(...bottom), centreY: median(centre) };
}

type Layers = { dpr: number; cssScale: number; pinchScaleNow: number; backing: number };
type Backing = { name: string; backing: { w: number; h: number }; expectedBacking: { w: number; h: number }; released?: boolean };

async function arm(p: Pane, zoom: number) {
	const page = await pageAt(p.dsf, p.win);
	try {
		await page.addScriptTag({ content: p.desktop ? desktopBundle : overlayBundle });
		const platform = await page.evaluate(() => (globalThis as { z3Platform?: string }).z3Platform ?? "phone");
		if (platform !== (p.desktop ? "desktop" : "phone")) throw new Error(`${p.name}: the page ran the ${platform} Platform`);
		await page.addStyleTag({ content: ownedColumnRule });
		// The rig's tear widget at 380 px, under the 386 px column, so it cannot widen the column at the lift and move
		// the ink: at 400 px it does, and the rig, not the app, then moves the stroke under the shot.
		await page.addStyleTag({ content: ".hw-tear-text { width: 380px !important; }" });
		const read = await page.evaluate(([pane, k]) => (window as any).scrollColumnAnchor.runTearMount(k, 0, pane, true, { fx: 0.5, fy: 0.5 }), [p.pane, zoom] as const);
		// The rule resolved on this page's DOM: `.cm-content`'s min-width is the column the overlay wrote.
		const column = await page.evaluate(() => {
			const host = document.querySelector(".cm-editor") as HTMLElement, content = document.querySelector(".cm-content") as HTMLElement;
			return { want: host.style.getPropertyValue("--handwriting-note-column-width").trim(), minWidth: getComputedStyle(content).minWidth, width: content.offsetWidth };
		});
		if (!column.want || column.minWidth !== column.want) throw new Error(`the owned column rule did not resolve: ${JSON.stringify(column)}`);
		const layers = await page.evaluate(() => (window as any).gridFallback.layers()) as Layers;
		const r = read.rects.pane as { l: number; t: number; w: number; h: number };
		const cdp = await page.context().newCDPSession(page);
		const y = Math.round(r.t + r.h * 0.4), xa = Math.round(r.l + 80), xb = Math.round(r.l + Math.min(r.w - 80, 680));
		const points = linePoints({ x: xa, y }, { x: xb, y }, 80);
		const clip = { x: Math.round(r.l), y: Math.round(r.t), width: Math.round(r.w), height: Math.round(r.h) };
		// The middle half of the run, in the clip's device px: away from the round caps at both ends.
		const run = { x0: (xa - clip.x + (xb - xa) * 0.25) * p.dsf, x1: (xa - clip.x + (xb - xa) * 0.75) * p.dsf };
		// The pen's row in the clip's device px: the stroke's centre, where its full-coverage core sits.
		const penRow = (y - clip.y) * p.dsf;
		const shot = async () => decodePng(await page.screenshot({ clip }));
		const frames = () => page.evaluate(() => new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res))));

		await penPress(cdp, points[0]!.x, points[0]!.y, { pressure: 0.6 });
		let wet: ReturnType<typeof ramps>;
		try {
			for (const q of points.slice(1)) await penMove(cdp, q.x, q.y, { pressure: 0.6 });
			await frames();
			wet = ramps(await shot(), run.x0, run.x1, penRow);
		} finally {
			await penRelease(cdp, points.at(-1)!.x, points.at(-1)!.y);
		}
		await frames();
		// The lift stores the stroke and the committed layer paints it on the next frames; read the store, then two frames.
		const stored = await page.evaluate(() => (window as any).scrollColumnAnchor.runTearRead().strokes) as number;
		if (stored !== 1) throw new Error(`premise: the lift stored one stroke, got ${stored}`);
		await frames();
		const committed = ramps(await shot(), run.x0, run.x1, penRow);
		const backing = await page.evaluate(() => (window as any).scrollColumnAnchor.runTearBacking()) as Backing[];

		// Pan step, measure only: the scroller one px down, the ink's centre row before and after.
		const before = await page.evaluate(() => (window as any).scrollColumnAnchor.runTearRead().scroll) as { left: number; top: number };
		const moved = await page.evaluate(([l, t]) => (window as any).scrollColumnAnchor.runTearScrollTo(l, t), [before.left, before.top + 1] as const) as { top: number };
		await frames();
		// The pen's row after the move, to seed the search only: the centre itself is read from the pixels.
		const after = ramps(await shot(), run.x0, run.x1, committed.centreY - (moved.top - before.top) * layers.pinchScaleNow * p.dsf);
		const panStep = { scrollerPx: moved.top - before.top, inkDevicePx: committed.centreY - after.centreY };

		await page.evaluate(() => (window as any).scrollColumnAnchor.runTearTeardown());
		return { layers, wet, committed, backing, panStep };
	} finally {
		await page.context().close();
	}
}

for (const p of PANES) for (const zoom of ZOOMS) it(`${p.name} pane, ratio ${p.dsf}, note zoom ${zoom}: ink edges are sharp pen down and after the lift`, async () => {
	const { layers, wet, committed, backing, panStep } = await arm(p, zoom);
	const row = { pane: p.name, dsf: p.dsf, zoom, layers, wet, committed, backing, panStep };
	report.push(row);
	// Kept before any pin, so a control that reds still hands its numbers to its 800 percent row.
	if (zoom === CONTROL_ZOOM) controls.set(p.name, { wet, committed });
	// eslint-disable-next-line no-console
	console.log(`Z3-800 ${p.name} dsf ${p.dsf} zoom ${zoom}: pinch ${layers.pinchScaleNow} backing ${layers.backing} (ratio x zoom ${p.dsf * zoom}) ` +
		`wet ramp top ${wet.top.toFixed(3)} bottom ${wet.bottom.toFixed(3)} (max ${wet.topMax.toFixed(3)}/${wet.bottomMax.toFixed(3)}, ${wet.columns} cols) ` +
		`committed ramp top ${committed.top.toFixed(3)} bottom ${committed.bottom.toFixed(3)} (max ${committed.topMax.toFixed(3)}/${committed.bottomMax.toFixed(3)}, ${committed.columns} cols) ` +
		`Z8 pan step: scroller ${panStep.scrollerPx} px -> ink ${panStep.inkDevicePx.toFixed(3)} device px`);
	expect(layers.dpr, "the rig does not hold the device ratio").toBe(p.dsf);
	expect(layers.pinchScaleNow, `the note did not reach ${zoom * 100} percent`).toBeCloseTo(zoom, 9);
	expect(wet.columns, "too few pen-down columns with a full-coverage core: the ramp below proves nothing").toBeGreaterThanOrEqual(MIN_COLUMNS);
	expect(committed.columns, "too few committed columns with a full-coverage core: the ramp below proves nothing").toBeGreaterThanOrEqual(MIN_COLUMNS);
	if (zoom === CONTROL_ZOOM) {
		for (const [name, v] of [["pen-down top", wet.top], ["pen-down bottom", wet.bottom], ["committed top", committed.top], ["committed bottom", committed.bottom]] as const)
			expect.soft(v, `200 percent control ${name} edge ramp, device px, vs the ${CONTROL_RAMP_MAX_DEVICE_PX} ceiling`).toBeLessThanOrEqual(CONTROL_RAMP_MAX_DEVICE_PX);
	} else {
		const ctl = controls.get(p.name);
		expect(ctl, `${p.name}: the ${CONTROL_ZOOM * 100} percent control did not run first, so this row has no bar`).toBeDefined();
		const wetBar = Math.max(ctl!.wet.top, ctl!.wet.bottom) + RAMP_MARGIN_DEVICE_PX;
		const committedBar = Math.max(ctl!.committed.top, ctl!.committed.bottom) + RAMP_MARGIN_DEVICE_PX;
		// eslint-disable-next-line no-console
		console.log(`Z3-800 ${p.name} bar: pen-down ${wetBar.toFixed(3)}, committed ${committedBar.toFixed(3)} device px (control worse edge + ${RAMP_MARGIN_DEVICE_PX})`);
		expect.soft(wet.top, `pen-down top edge ramp, device px, vs ${p.name} control + margin`).toBeLessThanOrEqual(wetBar);
		expect.soft(wet.bottom, `pen-down bottom edge ramp, device px, vs ${p.name} control + margin`).toBeLessThanOrEqual(wetBar);
		expect.soft(committed.top, `committed top edge ramp, device px, vs ${p.name} control + margin`).toBeLessThanOrEqual(committedBar);
		expect.soft(committed.bottom, `committed bottom edge ramp, device px, vs ${p.name} control + margin`).toBeLessThanOrEqual(committedBar);
	}
	if (!p.pinBacking) return;
	for (const c of backing) {
		if (c.backing.w === 0 && c.backing.h === 0) continue; // a deferred or released layer holds no backing
		expect.soft(Math.abs(c.backing.w - c.expectedBacking.w), `${c.name} backing width vs rect x ratio`).toBeLessThanOrEqual(1);
		expect.soft(Math.abs(c.backing.h - c.expectedBacking.h), `${c.name} backing height vs rect x ratio`).toBeLessThanOrEqual(1);
	}
}, 180_000);
