/**
 * SMEAR, READ ON CRITERIA THAT CAN FAIL, at DSF 2. The paper's pinch pan moves lined and grid rules inside their gradient
 * stops and dots through their tile position, so on most frames a mark sits a fraction of a device px off the device
 * grid. This cell reads whether that fraction degrades the marks, and shows its own criteria turn red on real
 * degradations.
 *
 * RULES (lined and grid, 100 / 50 / 30 / 10 percent). Bands are runs of device rows (columns for grid's vertical rules)
 * above a tenth of the rule's contrast, kept only on the pitch lattice (another band one pitch away, within 2 device px),
 * and counted only inside a window the no-pan geometry sets: from the first to the last whole rule inside the strip,
 * each edge half a pitch past it. A pan of up to half a device px cannot move a band across an edge, so a rule at the
 * strip's crop edge never changes the count, whatever phase the note's origin gives the paper.
 * Against the no-pan reading, a pan PASSES when:
 *   - the lattice band count is equal;
 *   - every band's peak is at least .75 (a two-row split at half contrast is a degradation);
 *   - the median band mass (summed contrast) is within 15 percent.
 * NOT COVERED: grid's horizontal layer at 10 percent. In this headless engine it already draws soft with no pan (two
 * background layers on one element; about 9-10 of 81 rules lost, median peak near .75, a band count that moves with
 * placement), while the device draws every one of those rules, so a headless read of that layer does not predict the
 * device. And a real smear there cannot be told from its baseline: lined paper moved half a device px through
 * background-position at 10 percent reads exactly like that layer at rest (72 bands, minimum peak .551, median .779,
 * mass 1.103). That axis is read and printed, never asserted. Grid's vertical rules at 10 percent, and its horizontal
 * rules at 100, 50 and 30 percent, are asserted.
 * The pan is a quarter of a device px, which keeps every stop more than .02 device px from a pixel centre. At exactly
 * half a device px a rule whose two stops both land on pixel centres can paint no row at all (a rasterisation boundary
 * that also exists with no pan at such a placement). That reading is bounded separately: every lost rule must be a
 * boundary rule, and no more rules may be lost than sit on the boundary.
 *
 * DOTS (50 / 30 / 10 percent, 20 px text so the pitch, the text's 30 px row, makes a tile a whole number of device px,
 * the tile placed on the device grid first). Half a device px of pan must move the dots by 0.4-0.75 device px on both axes (the pan reached
 * them). It PASSES when the median dot mass is within 15 percent and the median peak at least .75 of the no-pan reading.
 *
 * POSITIVE CONTROLS, each of which must read RED on the same criteria:
 *   - rules: the same half device px carried by background-position on lined paper, which rasterises the rules through
 *     a resampled image;
 *   - dots: a CSS blur of one device px on the scroller. A blur of half a device px was expected to read red too, but in
 *     this engine it changed no pixel at any zoom (the same dots, peak and mass as no blur), so it is not a degradation
 *     and is not used.
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import { decodePng } from "./pngInk";

let realBrowser: Browser, script: string;
const OBSIDIAN_CAMERA_CSS = readFileSync(fileURLToPath(new URL("./noteViewportCamera.css", import.meta.url)), "utf8");
const DSF = 2, PAGE_GREY = 255, RULE_GREY = 0x77, BAND_CUT = 0.1, BOUNDARY = 0.02;

beforeAll(async () => {
	const b = await build({
		entryPoints: [fileURLToPath(new URL("./noteViewportCameraPage.ts", import.meta.url))],
		bundle: true, write: false, format: "iife", platform: "browser",
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
	});
	script = b.outputFiles[0]!.text;
	realBrowser = await chromium.launch({ headless: true, args: [`--force-device-scale-factor=${DSF}`, "--window-size=900,700"] });
}, 180_000);

afterAll(async () => { await realBrowser?.close(); });

type Clip = { x: number; y: number; width: number; height: number };
type Geo = { left: number; top: number; clientLeft: number; clientTop: number; scrollLeft: number; scrollTop: number; k: number; pitch: number; rule: number; phase: number; phaseX: number; row: number };

const readGeo = (p: Page): Promise<Geo> => p.evaluate(() => {
	const sc = document.querySelector(".cm-scroller") as HTMLElement, host = document.querySelector(".cm-editor") as HTMLElement;
	const r = sc.getBoundingClientRect(), cs = getComputedStyle(host);
	const num = (name: string) => Number.parseFloat(cs.getPropertyValue(name)) || 0;
	const zoom = Number.parseFloat(cs.zoom);
	// One plain body row in layout px, read the way the overlay plans the pitch: the content's px line height, else a
	// plain line box's height, to 1/64 px.
	const content = document.querySelector(".cm-content") as HTMLElement, lh = getComputedStyle(content).lineHeight;
	const line = content.querySelector(".cm-line") as HTMLElement | null;
	const row = /px$/.test(lh.trim()) ? Number.parseFloat(lh) : line ? line.offsetHeight : Number.NaN;
	return { left: r.left, top: r.top, clientLeft: sc.clientLeft, clientTop: sc.clientTop, scrollLeft: sc.scrollLeft, scrollTop: sc.scrollTop,
		k: Number.isFinite(zoom) && zoom > 0 ? zoom : r.height / sc.offsetHeight, pitch: num("--handwriting-paper-pitch"), rule: num("--handwriting-paper-rule"),
		phase: num("--handwriting-paper-phase"), phaseX: num("--handwriting-paper-phase-x"), row: Math.round(row * 64) / 64 };
});

async function mount(p: Page, kind: "lines" | "grid" | "dots", z: number, textPx = 0): Promise<Geo> {
	await p.setContent(`<!doctype html><body class="handwriting-paper-${kind}" style="margin:0; background:#ffffff; --background-modifier-border:#777777"></body>`);
	await p.addStyleTag({ content: css + OBSIDIAN_CAMERA_CSS });
	await p.addScriptTag({ content: script });
	await p.evaluate(async ({ z, textPx }) => {
		const fx = (window as any).viewportFixture;
		await fx.setup("paper", "far", 1, 1, "x");
		if (textPx) await fx.fontPx("paper", textPx);
		await (window as any).edgeAudit.commit("paper", z);
		(document.querySelector(".cm-scroller") as HTMLElement).scrollTop = 600;
		await fx.settle();
	}, { z, textPx });
	return readGeo(p);
}

const setPan = (p: Page, x: number, y: number) => p.evaluate(async ({ x, y }) => {
	const sc = document.querySelector(".cm-scroller") as HTMLElement;
	for (const [name, v] of [["--handwriting-paper-pan-x", x], ["--handwriting-paper-pan-y", y]] as const) {
		if (v === 0) sc.style.removeProperty(name); else sc.style.setProperty(name, `${v}px`);
	}
	await (window as any).viewportFixture.settle();
}, { x, y });

const setControl = (p: Page, rule: string) => p.evaluate(async rule => {
	let el = document.getElementById("smear-control") as HTMLStyleElement | null;
	if (!rule) el?.remove();
	else { if (!el) { el = document.createElement("style"); el.id = "smear-control"; document.head.appendChild(el); } el.textContent = rule; }
	await (window as any).viewportFixture.settle();
}, rule);

const contrast = (r: number, g: number, b: number) => Math.max(0, Math.min(1, (PAGE_GREY - (r + g + b) / 3) / (PAGE_GREY - RULE_GREY)));
const median = (xs: number[]) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : Number.NaN; };
const frac = (v: number) => v - Math.floor(v);

async function profile(p: Page, clip: Clip, axis: "x" | "y"): Promise<number[]> {
	const d = decodePng(await p.screenshot({ clip }));
	const n = axis === "y" ? d.height : d.width, across = axis === "y" ? d.width : d.height, out: number[] = [];
	for (let i = 0; i < n; i++) {
		const vals: number[] = [];
		for (let j = 0; j < across; j++) { const at = (axis === "y" ? i * d.width + j : j * d.width + i) * d.channels; vals.push(contrast(d.px[at]!, d.px[at + 1]!, d.px[at + 2]!)); }
		out.push(median(vals));
	}
	return out;
}

/**
 * Where bands are counted: from the first to the last whole rule the no-pan geometry puts inside the strip, with each
 * edge half a pitch past that rule, so it sits midway between two rules. A pan of up to half a device px moves a band
 * by that much, never across an edge; a band at the strip's own crop edge is never counted, whatever the note's phase.
 */
type CountWindow = { lo: number; hi: number; rules: number };
function countWindow(g: Geo, clip: Clip, axis: "x" | "y"): CountWindow {
	const t = g.rule * g.k * DSF, pitchDev = g.pitch * g.k * DSF, screen = axis === "y" ? g.top : g.left, client = axis === "y" ? g.clientTop : g.clientLeft;
	const phase = axis === "y" ? g.phase : g.phaseX, scroll = axis === "y" ? g.scrollTop : g.scrollLeft, origin = (axis === "y" ? clip.y : clip.x) * DSF, span = axis === "y" ? clip.height : clip.width;
	const centre = (m: number) => DSF * (screen + (client + phase + m * g.pitch - scroll) * g.k) - origin - t / 2;
	const start = ((axis === "y" ? clip.y : clip.x) - screen) / g.k - client + scroll;
	const m0 = Math.floor((start - phase) / g.pitch) - 2, m1 = m0 + Math.ceil(span / (g.k * g.pitch)) + 4;
	let lo = Number.NaN, hi = Number.NaN, rules = 0;
	for (let m = m0; m <= m1; m++) {
		const c = centre(m);
		if (c - pitchDev / 2 < 2 || c + pitchDev / 2 > span * DSF - 2) continue;
		if (Number.isNaN(lo)) lo = c - pitchDev / 2;
		hi = c + pitchDev / 2;
		rules++;
	}
	return { lo, hi, rules };
}
const inWindow = (w: CountWindow, v: number) => v >= w.lo && v < w.hi;

/** Every band above a tenth of the contrast, not cut by the strip's ends, with its centroid in device px. */
function bandsOf(prof: number[]) {
	const bands: { centre: number; peak: number; mass: number }[] = [];
	for (let i = 0; i < prof.length; i++) {
		if (prof[i]! <= BAND_CUT) continue;
		let j = i, peak = 0, mass = 0, moment = 0;
		while (j < prof.length && prof[j]! > BAND_CUT) { peak = Math.max(peak, prof[j]!); mass += prof[j]!; moment += prof[j]! * (j + 0.5); j++; }
		if (i > 0 && j < prof.length) bands.push({ centre: moment / mass, peak, mass });
		i = j;
	}
	return bands;
}

/** Bands on the pitch lattice (another band one pitch away anywhere in the strip), counted inside the window. */
function latticeBands(prof: number[], pitchDev: number, w: CountWindow) {
	const bands = bandsOf(prof);
	return bands.filter(b => inWindow(w, b.centre) && bands.some(o => o !== b && Math.abs(Math.abs(o.centre - b.centre) - pitchDev) <= 2));
}

type RuleRead = { count: number; minPeak: number; medianPeak: number; medianMass: number };
const summarise = (bands: { peak: number; mass: number }[]): RuleRead => ({ count: bands.length, minPeak: bands.length ? Math.min(...bands.map(b => b.peak)) : Number.NaN,
	medianPeak: median(bands.map(b => b.peak)), medianMass: median(bands.map(b => b.mass)) });

/** The rules' criteria against the no-pan reading. */
function ruleVerdict(none: RuleRead, other: RuleRead) {
	const countEqual = other.count === none.count;
	const peakOk = other.minPeak >= 0.75;
	const massOk = Math.abs(other.medianMass - none.medianMass) <= 0.15 * none.medianMass;
	return { pass: countEqual && peakOk && massOk, countEqual, peakOk, massOk };
}

/** Every band in the window, with no lattice filter: a lost rule must not also cost its neighbour's place. */
const allBandCount = (prof: number[], w: CountWindow) => bandsOf(prof).filter(b => inWindow(w, b.centre)).length;

/** The rules in the window (by their no-pan centre) and how many of them sit on the boundary after a pan of `panDev` device px. */
function boundaryRules(g: Geo, clip: Clip, axis: "x" | "y", panDev: number, w: CountWindow) {
	const t = g.rule * g.k * DSF, screen = axis === "y" ? g.top : g.left, client = axis === "y" ? g.clientTop : g.clientLeft;
	const phase = axis === "y" ? g.phase : g.phaseX, scroll = axis === "y" ? g.scrollTop : g.scrollLeft, origin = (axis === "y" ? clip.y : clip.x) * DSF, span = axis === "y" ? clip.height : clip.width;
	const stop = (m: number) => DSF * (screen + (client + phase + m * g.pitch - scroll) * g.k) - origin;
	const start = ((axis === "y" ? clip.y : clip.x) - screen) / g.k - client + scroll;
	const m0 = Math.floor((start - phase) / g.pitch) - 2, m1 = m0 + Math.ceil(span / (g.k * g.pitch)) + 4;
	let rules = 0, boundary = 0;
	for (let m = m0; m <= m1; m++) {
		if (!inWindow(w, stop(m) - t / 2)) continue;
		const e = stop(m) + panDev;
		rules++;
		if (Math.abs(frac(e) - 0.5) < BOUNDARY || Math.abs(frac(e - t) - 0.5) < BOUNDARY) boundary++;
	}
	return { rules, boundary };
}

const STRIP_Y = (g: Geo): Clip => ({ x: Math.round(g.left + 2), y: Math.round(g.top + 240), width: 12, height: 230 });
const STRIP_X = (g: Geo): Clip => ({ x: Math.round(g.left + 20), y: Math.round(g.top + 250), width: 300, height: 12 });

it.each([["lines", 1], ["lines", 0.5], ["lines", 0.3], ["lines", 0.1], ["grid", 1], ["grid", 0.5], ["grid", 0.3], ["grid", 0.1]] as const)("RULES %s AT %s: a quarter device px of pan keeps every rule, its peak and its mass; half a device px loses only boundary rules", async (kind, z) => {
	const ctx = await realBrowser.newContext({ viewport: null });
	const p = await ctx.newPage();
	try {
		const g = await mount(p, kind, z), dev = 1 / (g.k * DSF);
		const out: unknown[] = [];
		for (const axis of (kind === "grid" ? ["y", "x"] : ["y"]) as ("x" | "y")[]) {
			const clip = axis === "y" ? STRIP_Y(g) : STRIP_X(g), pitchDev = g.pitch * g.k * DSF, w = countWindow(g, clip, axis);
			const read = async () => { const prof = await profile(p, clip, axis); return { ...summarise(latticeBands(prof, pitchDev, w)), all: allBandCount(prof, w) }; };
			// Not covered (see the header): grid's horizontal layer at 10 percent is read and printed, never asserted.
			const notCovered = kind === "grid" && axis === "y" && z === 0.1;
			await setPan(p, 0, 0);
			const none = await read();
			await setPan(p, 0.25 * dev, 0.25 * dev);
			const quarter = await read();
			await setPan(p, 0.5 * dev, 0.5 * dev);
			const half = await read();
			await setPan(p, 0, 0);
			const quarterBoundary = boundaryRules(g, clip, axis, 0.25, w), halfBoundary = boundaryRules(g, clip, axis, 0.5, w), noneBoundary = boundaryRules(g, clip, axis, 0, w);
			out.push({ axis, notCovered, window: w, none, quarter, half, verdictQuarter: ruleVerdict(none, quarter), noneBoundary, quarterBoundary, halfBoundary, lostAtHalf: none.all - half.all });
		}
		// eslint-disable-next-line no-console
		console.log(`SMEAR-CRITERIA RULES ${kind} z=${z}`, JSON.stringify({ geo: g, out }));
		type Reading = RuleRead & { all: number };
		for (const r of out as { axis: string; notCovered: boolean; window: CountWindow; none: Reading; quarter: Reading; half: Reading; verdictQuarter: ReturnType<typeof ruleVerdict>; noneBoundary: { boundary: number }; quarterBoundary: { boundary: number }; halfBoundary: { rules: number; boundary: number }; lostAtHalf: number }[]) {
			if (r.notCovered) continue;
			expect(r.window.rules, `premise: ${kind} ${r.axis} whole rules inside the counting window`).toBeGreaterThanOrEqual(3);
			expect(r.none.count, `premise: ${kind} ${r.axis} lattice bands with no pan`).toBeGreaterThanOrEqual(3);
			expect(r.noneBoundary.boundary + r.quarterBoundary.boundary, `premise: ${kind} ${r.axis} no stop within ${BOUNDARY} of a pixel centre with no pan or a quarter px`).toBe(0);
			expect(r.none.minPeak, `premise: ${kind} ${r.axis} rules draw hard with no pan`).toBeGreaterThanOrEqual(0.75);
			expect.soft(r.verdictQuarter.pass, `${kind} z ${z} ${r.axis}: a quarter device px of pan against none ${JSON.stringify({ none: r.none, quarter: r.quarter, verdict: r.verdictQuarter })}`).toBe(true);
			// The half-px bound: rules lost there are the rasterisation boundary, never more than sit on it.
			expect.soft(r.lostAtHalf, `${kind} z ${z} ${r.axis}: rules lost at half a device px (bands ${r.none.all} -> ${r.half.all}) against the ${r.halfBoundary.boundary} rules on the boundary`).toBeLessThanOrEqual(r.halfBoundary.boundary);
			expect.soft(r.lostAtHalf, `${kind} z ${z} ${r.axis}: no rule is gained at half a device px`).toBeGreaterThanOrEqual(0);
		}
	} finally {
		await ctx.close();
	}
});

it.each([1, 0.5, 0.3, 0.1])("POSITIVE CONTROL, RULES AT %s: half a device px through background-position reads RED on lined paper", async z => {
	const ctx = await realBrowser.newContext({ viewport: null });
	const p = await ctx.newPage();
	try {
		const g = await mount(p, "lines", z), clip = STRIP_Y(g), pitchDev = g.pitch * g.k * DSF, w = countWindow(g, clip, "y");
		const read = async () => summarise(latticeBands(await profile(p, clip, "y"), pitchDev, w));
		const none = await read();
		await setControl(p, `body .markdown-source-view .cm-scroller { background-position: 0 ${0.5 / (g.k * DSF)}px !important; }`);
		const position = await read();
		await setControl(p, "");
		const back = await read();
		const verdict = ruleVerdict(none, position), backVerdict = ruleVerdict(none, back);
		// eslint-disable-next-line no-console
		console.log(`SMEAR-CRITERIA CONTROL RULES z=${z}`, JSON.stringify({ geo: g, window: w, none, position, back, verdict, backVerdict }));
		expect(none.minPeak, "premise: the rules draw hard with no offset").toBeGreaterThanOrEqual(0.75);
		expect(backVerdict.pass, "premise: removing the control reads as before").toBe(true);
		expect(verdict.pass, `CONTROL z ${z}: background-position's half device px must read RED ${JSON.stringify({ none, position, verdict })}`).toBe(false);
	} finally {
		await ctx.close();
	}
});

type Dot = { cx: number; cy: number; peak: number; mass: number };

async function dotsIn(p: Page, clip: Clip): Promise<Dot[]> {
	const d = decodePng(await p.screenshot({ clip }));
	const f = new Float32Array(d.width * d.height);
	for (let i = 0; i < f.length; i++) { const at = i * d.channels; f[i] = contrast(d.px[at]!, d.px[at + 1]!, d.px[at + 2]!); }
	const seen = new Uint8Array(f.length), out: Dot[] = [];
	for (let s = 0; s < f.length; s++) {
		if (seen[s] || f[s]! <= BAND_CUT) continue;
		const stack = [s]; seen[s] = 1;
		let n = 0, peak = 0, mass = 0, mx = 0, my = 0, edge = false;
		while (stack.length) {
			const c = stack.pop()!, x = c % d.width, y = (c - x) / d.width, v = f[c]!;
			n++; peak = Math.max(peak, v); mass += v; mx += (x + 0.5) * v; my += (y + 0.5) * v;
			if (x === 0 || y === 0 || x === d.width - 1 || y === d.height - 1) edge = true;
			for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as const) {
				if (nx < 0 || ny < 0 || nx >= d.width || ny >= d.height) continue;
				const q = ny * d.width + nx;
				if (!seen[q] && f[q]! > BAND_CUT) { seen[q] = 1; stack.push(q); }
			}
		}
		if (edge || n > 400) continue;
		out.push({ cx: clip.x * DSF + mx / mass, cy: clip.y * DSF + my / mass, peak, mass });
	}
	return out;
}

function medianShift(from: Dot[], to: Dot[]) {
	const xs: number[] = [], ys: number[] = [];
	for (const a of from) {
		let best: Dot | null = null, bestD = 2;
		for (const b of to) { const dd = Math.hypot(b.cx - a.cx, b.cy - a.cy); if (dd < bestD) { bestD = dd; best = b; } }
		if (best) { xs.push(best.cx - a.cx); ys.push(best.cy - a.cy); }
	}
	return { matched: xs.length, x: median(xs), y: median(ys) };
}

type DotRead = { dots: number; peak: number; mass: number };
const dotRead = (dots: Dot[]): DotRead => ({ dots: dots.length, peak: median(dots.map(d => d.peak)), mass: median(dots.map(d => d.mass)) });
const dotVerdict = (none: DotRead, other: DotRead) => {
	const massOk = Math.abs(other.mass - none.mass) <= 0.15 * none.mass, peakOk = other.peak >= 0.75 * none.peak;
	return { pass: massOk && peakOk, massOk, peakOk };
};

/**
 * The text size for the dots arms. The pitch is the text's row, and fontPx sets the row to 1.5 x the text, so 20 px text
 * is a 30 px row: a whole number of device px at every dots zoom here (30, 18 and 6 at DSF 2), as 120/7 px text gave
 * under the old 28 x font / 16 pitch.
 */
const DOTS_TEXT_PX = 20;

/** Dots at a whole-number device pitch with the tile on the device grid; returns the pan that placed it. */
async function dotsOnGrid(p: Page, z: number) {
	const g = await mount(p, "dots", z, DOTS_TEXT_PX), dev = 1 / (g.k * DSF);
	const corner = (screen: number, client: number, phase: number, scroll: number) => DSF * (screen + (client + phase - scroll) * g.k);
	const fill = (v: number) => { const r = Math.ceil(v - 1e-6) - v; return r < 1e-3 ? 0 : r; };
	const base = { x: fill(corner(g.left, g.clientLeft, g.phaseX, g.scrollLeft)) * dev, y: fill(corner(g.top, g.clientTop, g.phase, g.scrollTop)) * dev };
	await setPan(p, base.x, base.y);
	return { g, dev, base, patch: { x: Math.round(g.left + 20), y: Math.round(g.top + 240), width: 200, height: 200 } as Clip };
}

it.each([0.5, 0.3, 0.1])("DOTS AT %s: half a device px of pan moves the dots and keeps their mass and peak", async z => {
	const ctx = await realBrowser.newContext({ viewport: null });
	const p = await ctx.newPage();
	try {
		const { g, dev, base, patch } = await dotsOnGrid(p, z);
		const noneDots = await dotsIn(p, patch);
		await setPan(p, base.x + 0.5 * dev, base.y + 0.5 * dev);
		const halfDots = await dotsIn(p, patch);
		const none = dotRead(noneDots), half = dotRead(halfDots), moved = medianShift(noneDots, halfDots), verdict = dotVerdict(none, half);
		// eslint-disable-next-line no-console
		console.log(`SMEAR-CRITERIA DOTS z=${z}`, JSON.stringify({ geo: g, base, none, half, moved, verdict }));
		expect(g.pitch, `premise: the pitch at ${DOTS_TEXT_PX} px text is its row (${g.row} px)`).toBeCloseTo(g.row, 3);
		const pitchDev = g.pitch * g.k * DSF;
		expect(Math.abs(pitchDev - Math.round(pitchDev)), `premise: the tile is a whole number of device px (${pitchDev})`).toBeLessThanOrEqual(1e-3);
		expect(none.dots, "premise: whole dots in the patch").toBeGreaterThanOrEqual(4);
		expect(Math.min(moved.x, moved.y), `premise: the pan reached the dots ${JSON.stringify(moved)}`).toBeGreaterThanOrEqual(0.4);
		expect(Math.max(moved.x, moved.y), `premise: by half a device px, not more ${JSON.stringify(moved)}`).toBeLessThanOrEqual(0.75);
		expect.soft(verdict.pass, `DOTS z ${z}: half a device px against none ${JSON.stringify({ none, half, verdict })}`).toBe(true);
	} finally {
		await ctx.close();
	}
});

it.each([0.5, 0.3, 0.1])("POSITIVE CONTROL, DOTS AT %s: a one device px blur reads RED", async z => {
	const ctx = await realBrowser.newContext({ viewport: null });
	const p = await ctx.newPage();
	try {
		const { g, patch } = await dotsOnGrid(p, z);
		const none = dotRead(await dotsIn(p, patch));
		await setControl(p, `body .markdown-source-view .cm-scroller { filter: blur(${1 / (g.k * DSF)}px) !important; }`);
		const blurOne = dotRead(await dotsIn(p, patch));
		await setControl(p, "");
		const back = dotRead(await dotsIn(p, patch));
		const verdictOne = dotVerdict(none, blurOne), backVerdict = dotVerdict(none, back);
		// eslint-disable-next-line no-console
		console.log(`SMEAR-CRITERIA CONTROL DOTS z=${z}`, JSON.stringify({ geo: g, none, blurOne, back, verdictOne, backVerdict }));
		expect(none.dots, "premise: whole dots in the patch").toBeGreaterThanOrEqual(4);
		expect(backVerdict.pass, "premise: removing the control reads as before").toBe(true);
		expect(verdictOne.pass, `CONTROL z ${z}: a one device px blur must read RED ${JSON.stringify({ none, blurOne, verdictOne })}`).toBe(false);
	} finally {
		await ctx.close();
	}
});
