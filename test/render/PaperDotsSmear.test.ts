/**
 * DOTS UNDER A FRACTIONAL OFFSET, at DSF 2. The dots take their phase and the text's pan as
 * their tile position, in layout px at 1/64, so a dot can sit a fraction of a device px off the device grid - at rest
 * (the column's left edge and the note's top are rarely whole device px) and on every frame of a pinch. A hard rule
 * smears there; the question for a soft round dot is whether its footprint grows or its peak fades.
 *
 * Read at 50, 30 and 10 percent: the dots as drawn with no pan, then with a pan of half a device px on both axes
 * (the worst fraction), then with a whole device px (the rounded form). Per reading, over every whole dot in the
 * patch: the footprint (device px darker than a quarter of the mark's contrast) and the peak contrast, medians.
 * PASS when the half-px reading's footprint is within 2 device px of the no-pan reading's and its peak within 25
 * percent. Numbers print either way.
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
const DSF = 2, PAGE_GREY = 255, RULE_GREY = 0x77;

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

async function dotStats(p: Page) {
	const r = await p.evaluate(() => { const s = (document.querySelector(".cm-scroller") as HTMLElement).getBoundingClientRect(); return { left: s.left, top: s.top }; });
	const clip = { x: Math.round(r.left + 20), y: Math.round(r.top + 20), width: 240, height: 240 };
	const d = decodePng(await p.screenshot({ clip }));
	const f = new Float32Array(d.width * d.height);
	for (let i = 0; i < f.length; i++) {
		const k = i * d.channels;
		f[i] = Math.max(0, Math.min(1, (PAGE_GREY - (d.px[k]! + d.px[k + 1]! + d.px[k + 2]!) / 3) / (PAGE_GREY - RULE_GREY)));
	}
	const seen = new Uint8Array(f.length), areas: number[] = [], peaks: number[] = [];
	for (let s = 0; s < f.length; s++) {
		if (seen[s] || f[s]! <= 0.25) continue;
		const stack = [s]; seen[s] = 1;
		let n = 0, peak = 0, edge = false;
		while (stack.length) {
			const c = stack.pop()!, cx = c % d.width, cy = (c - cx) / d.width;
			n++; peak = Math.max(peak, f[c]!);
			if (cx === 0 || cy === 0 || cx === d.width - 1 || cy === d.height - 1) edge = true;
			for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]] as const) {
				if (nx < 0 || ny < 0 || nx >= d.width || ny >= d.height) continue;
				const q = ny * d.width + nx;
				if (!seen[q] && f[q]! > 0.25) { seen[q] = 1; stack.push(q); }
			}
		}
		if (edge || n > 400) continue;
		areas.push(n); peaks.push(peak);
	}
	const med = (xs: number[]) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : Number.NaN; };
	return { dots: areas.length, area: med(areas), peak: med(peaks) };
}

it.each([0.5, 0.3, 0.1])("DOTS AT %s: half a device px of offset neither spreads a dot nor fades it", async z => {
	const ctx = await realBrowser.newContext({ viewport: null });
	const p = await ctx.newPage();
	try {
		await p.setContent(`<!doctype html><body class="handwriting-paper-dots" style="margin:0; background:#ffffff; --background-modifier-border:#777777"></body>`);
		await p.addStyleTag({ content: css + OBSIDIAN_CAMERA_CSS });
		await p.addScriptTag({ content: script });
		await p.evaluate(async z => {
			await (window as any).viewportFixture.setup("paper", "far", 1, 1, "x");
			await (window as any).edgeAudit.commit("paper", z);
			(document.querySelector(".cm-scroller") as HTMLElement).scrollTop = 600;
			await (window as any).viewportFixture.settle();
		}, z);
		const zoom = await p.evaluate(() => Number.parseFloat(getComputedStyle(document.querySelector(".cm-editor") as HTMLElement).zoom) || 1);
		const setPan = (devPx: number) => p.evaluate(async ({ v }) => {
			const sc = document.querySelector(".cm-scroller") as HTMLElement;
			if (v === 0) { sc.style.removeProperty("--handwriting-paper-pan-x"); sc.style.removeProperty("--handwriting-paper-pan-y"); }
			else { sc.style.setProperty("--handwriting-paper-pan-x", `${v}px`); sc.style.setProperty("--handwriting-paper-pan-y", `${v}px`); }
			await (window as any).viewportFixture.settle();
		}, { v: devPx / (zoom * DSF) });
		await setPan(0);
		const none = await dotStats(p);
		await setPan(0.5);
		const half = await dotStats(p);
		await setPan(1);
		const whole = await dotStats(p);
		await setPan(0);
		const vars = await p.evaluate(() => ["--handwriting-paper-pitch", "--handwriting-paper-dot", "--handwriting-paper-phase", "--handwriting-paper-phase-x"].map(k => getComputedStyle(document.querySelector(".cm-editor") as HTMLElement).getPropertyValue(k).trim()).join("|"));
		// eslint-disable-next-line no-console
		console.log(`DOTS-SMEAR z=${z} zoom=${zoom} vars=${vars}`, JSON.stringify({ none, half, whole }));
		expect(none.dots, "premise: whole dots in the patch").toBeGreaterThanOrEqual(4);
		expect(half.dots, "premise: whole dots in the patch with the offset").toBeGreaterThanOrEqual(4);
		expect.soft(half.area - none.area, `z ${z}: footprint growth at half a device px, device px (none ${none.area}, half ${half.area}, whole ${whole.area})`).toBeLessThanOrEqual(2);
		expect.soft(half.peak, `z ${z}: peak at half a device px against no offset (none ${none.peak.toFixed(3)}, half ${half.peak.toFixed(3)}, whole ${whole.peak.toFixed(3)})`).toBeGreaterThanOrEqual(none.peak * 0.75);
	} finally {
		await ctx.close();
	}
});

/**
 * RULES UNDER A FRACTIONAL PAN: lined and grid paper carry the pan inside their gradient stops. At 50, 30 and 10
 * percent, a pan of half a device px on both axes against none: the horizontal rules' band thickness (device rows at
 * more than half the rule's contrast, along a strip) and the band count. PASS when the half-px band is at most one
 * device row thicker than the no-pan band (a smear widens a 1-2 row rule to several).
 *
 * The strip is read with the floating toolbar hidden. The rig sets --background-modifier-border to the rule grey, so
 * the toolbar's buttons, over the x strip's top 8 device rows, read as rule there; with grid at 10 percent (pitch 4.8
 * device px, 5 horizontal rules in the 24-row strip) those columns sit at 11 rows of 24, and half a device px of pan
 * moves one rule out from under the toolbar to make 12, the strip median, so a gap reads as rule and two rules join.
 * The shot as the page stands is logged too (shown).
 */
async function toolbarHidden(p: Page, hidden: boolean): Promise<string[]> {
	return await p.evaluate(async (hidden) => {
		document.getElementById("instrument-hide-toolbar")?.remove();
		if (hidden) {
			const s = document.createElement("style");
			s.id = "instrument-hide-toolbar";
			s.textContent = ".handwriting-mobile-tools { visibility: hidden !important; }";
			document.head.appendChild(s);
		}
		await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
		return Array.from(document.querySelectorAll(".handwriting-mobile-tools, .handwriting-mobile-tools-face")).map(e => getComputedStyle(e).visibility);
	}, hidden);
}

async function ruleBands(p: Page, axis: "y" | "x") {
	const r = await p.evaluate(() => { const s = (document.querySelector(".cm-scroller") as HTMLElement).getBoundingClientRect(); return { left: s.left, top: s.top }; });
	const clip = axis === "y" ? { x: Math.round(r.left + 30), y: Math.round(r.top + 20), width: 12, height: 300 } : { x: Math.round(r.left + 20), y: Math.round(r.top + 30), width: 300, height: 12 };
	const shown = await stripBands(p, axis, clip);
	const toolbar = await toolbarHidden(p, true);
	const read = await stripBands(p, axis, clip);
	await toolbarHidden(p, false);
	return { ...read, toolbar, shown };
}

async function stripBands(p: Page, axis: "y" | "x", clip: { x: number; y: number; width: number; height: number }) {
	const d = decodePng(await p.screenshot({ clip }));
	const n = axis === "y" ? d.height : d.width, other = axis === "y" ? d.width : d.height;
	const profile: number[] = [];
	// The MEDIAN across the strip, not the maximum: a crossing rule of the other direction covers a column or two of
	// the strip and would otherwise make every row read as rule.
	for (let i = 0; i < n; i++) {
		const vals: number[] = [];
		for (let j = 0; j < other; j++) {
			const idx = (axis === "y" ? i * d.width + j : j * d.width + i) * d.channels;
			vals.push(Math.max(0, Math.min(1, (PAGE_GREY - (d.px[idx]! + d.px[idx + 1]! + d.px[idx + 2]!) / 3) / (PAGE_GREY - RULE_GREY))));
		}
		vals.sort((a, b) => a - b);
		profile.push(vals[Math.floor(vals.length / 2)]!);
	}
	const widths: number[] = [];
	for (let i = 1; i < n - 1; i++) {
		if (profile[i]! <= 0.5) continue;
		let j = i; while (j + 1 < n && profile[j + 1]! > 0.5) j++;
		if (i > 0 && j < n - 1) widths.push(j - i + 1);
		i = j;
	}
	const s = widths.slice().sort((a, b) => a - b);
	return { bands: widths.length, width: s.length ? s[Math.floor(s.length / 2)]! : Number.NaN, max: s.length ? s[s.length - 1]! : Number.NaN };
}

it.each([["lines", 0.5], ["lines", 0.3], ["lines", 0.1], ["grid", 0.5], ["grid", 0.3], ["grid", 0.1]] as const)("RULES %s AT %s: half a device px of pan does not widen a rule", async (kind, z) => {
	const ctx = await realBrowser.newContext({ viewport: null });
	const p = await ctx.newPage();
	try {
		await p.setContent(`<!doctype html><body class="handwriting-paper-${kind}" style="margin:0; background:#ffffff; --background-modifier-border:#777777"></body>`);
		await p.addStyleTag({ content: css + OBSIDIAN_CAMERA_CSS });
		await p.addScriptTag({ content: script });
		await p.evaluate(async z => {
			await (window as any).viewportFixture.setup("paper", "far", 1, 1, "x");
			await (window as any).edgeAudit.commit("paper", z);
			(document.querySelector(".cm-scroller") as HTMLElement).scrollTop = 600;
			await (window as any).viewportFixture.settle();
		}, z);
		const zoom = await p.evaluate(() => Number.parseFloat(getComputedStyle(document.querySelector(".cm-editor") as HTMLElement).zoom) || 1);
		const setPan = (devPx: number) => p.evaluate(async ({ v }) => {
			const sc = document.querySelector(".cm-scroller") as HTMLElement;
			if (v === 0) { sc.style.removeProperty("--handwriting-paper-pan-x"); sc.style.removeProperty("--handwriting-paper-pan-y"); }
			else { sc.style.setProperty("--handwriting-paper-pan-x", `${v}px`); sc.style.setProperty("--handwriting-paper-pan-y", `${v}px`); }
			await (window as any).viewportFixture.settle();
		}, { v: devPx / (zoom * DSF) });
		const out: Record<string, unknown> = {};
		for (const axis of (kind === "grid" ? ["y", "x"] : ["y"]) as ("y" | "x")[]) {
			await setPan(0);
			const none = await ruleBands(p, axis);
			await setPan(0.5);
			const half = await ruleBands(p, axis);
			await setPan(0);
			out[axis] = { none, half };
			expect(none.bands, `premise: rules found on ${axis}`).toBeGreaterThanOrEqual(3);
			expect([...none.toolbar, ...half.toolbar].every(v => v === "hidden"), `premise: the floating toolbar is hidden for the ${axis} shots (${[...none.toolbar, ...half.toolbar].join(",")})`).toBe(true);
			expect.soft(half.max - none.max, `${kind} z ${z} ${axis}: widest band at half a device px of pan vs none, device rows (none ${JSON.stringify(none)}, half ${JSON.stringify(half)})`).toBeLessThanOrEqual(1);
		}
		// eslint-disable-next-line no-console
		console.log(`RULES-SMEAR ${kind} z=${z}`, JSON.stringify(out));
	} finally {
		await ctx.close();
	}
});
