/**
 * THE RULE FLOOR: lined paper keeps every rule when a rule's stops land on pixel centres, and draws as before wherever
 * a one layout px rule already covers a device px.
 *
 * A rule exactly one device px wide whose top and bottom stops both sit on pixel centres (the stop fraction .5) covers
 * no pixel centre at all, so the rasteriser can paint nothing there: at DSF 2 such a placement lost 3 of 27 rules at 30
 * percent and 12 of 81 at 10 percent in this strip. Where the literal rule falls under one device px it is therefore
 * floored a little over one (`RULE_FLOOR_DEVICE_PX` in PaperPlan.ts), so the band always holds a pixel centre strictly
 * inside it. The cost is a rule painted two rows tall where its bottom stop's fraction lies just past .5, counted below.
 *
 * FLOORED arms, 30 and 10 percent at DSF 2, where rules cycle through sub-pixel fractions down the strip: at f = .5, no
 * rule vanishes or fades, and the two-row count stays at its measured value.
 * EVERYDAY arms, 50 percent at DSF 2 and 100 percent at DSF 1: the literal rule is exactly one device px, the pitch a
 * whole 28 device px, and every rule shares one fraction, so a floor there would double every rule on the page at once
 * on the placements just past .5. The rule stays one device px and no rule paints two rows at f = 0, .5 and three
 * placements inside that window. Disclosed, not asserted: at exactly one device px a rule whose stops tie on pixel
 * centres can still drop (1 of 8 at 100 percent on DSF 1, f = .5, as the 1 px rule always could).
 *
 * Placement: a scroll snaps to whole device px, so the note's origin moves instead - the host's own phase set f device
 * px past the planned one, a value the overlay keeps as the host's. Every rule expected in the strip is found by its
 * own geometry (the bottom stop at phase + m x pitch in the scroller's positioning area, at the painted scale) and read
 * from the pixels: vanished (no row above a tenth of the contrast), rows painted (above a half).
 *
 * Premises, per arm: at least 5 rules in the strip; the phase reads back as set at every placement; at f = 0 the
 * painted rows agree with the rows the stops predict (at least .9), so the reader sees the placement it asked for; at
 * f = .5 on a floored arm, rules on the pixel-centre boundary are present, and the rules off it agree too.
 *
 * SNAP arms, the same two everyday zooms, placed the way a note is: the note's origin moved f device px (the content's
 * top padding), and the paper the overlay plans from it. The at-rest phase is put on the device px grid, so every rule
 * sits on pixel edges: at every f, including .5, none vanishes, fades or paints two rows, every rule's peak is at least
 * .9, and the planned phase is a whole number of device px.
 *
 * Plants: HW_PAPER_FLOOR_PLANT_ONE=1 plans the floor at exactly one device px (the floored arms go red);
 * HW_PAPER_FLOOR_PLANT_EVERYWHERE=1 floors every rule, one device px or not (the everyday arms go red);
 * HW_PAPER_PHASE_PLANT_NO_SNAP=1 leaves the at-rest phase off the device px grid (the snap arms go red).
 * Measurement only: HW_PAPER_FLOOR_VALUE=<n> plans the floor at n device px, and HW_PAPER_FLOOR_PLACES=<f,...> reads
 * those placements too (logged).
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import { decodePng } from "./pngInk";

declare const process: { env: Record<string, string | undefined> };

const browsers = new Map<number, Browser>();
let script: string;
const OBSIDIAN_CAMERA_CSS = readFileSync(fileURLToPath(new URL("./noteViewportCamera.css", import.meta.url)), "utf8");
const PAGE_GREY = 255, RULE_GREY = 0x77;
const FLOOR_LINE = "export const RULE_FLOOR_DEVICE_PX = 1 + 1 / 64;";
const CONDITION_LINE = "return literal * devicePx >= 1 ? literal : RULE_FLOOR_DEVICE_PX / devicePx;";
const SNAP_LINE = "const onGrid = Number.isFinite(devicePx) && devicePx > 0 ? Math.round(folded * devicePx) / devicePx : folded;";
/** The snap arms' origin offsets in device px. */
const ORIGIN_PLACES = [0, 0.25, 0.49, 0.5, 0.51, 0.50462, 0.51385, 0.75];
/** Two-row rules at f = .5 on the floored arms, measured on the floor as planned (DSF@zoom). A rise is red. */
const TWO_ROWS_AT_MOST: Record<string, number> = { "2@0.3": 3, "2@0.1": 0 };
/** The everyday arms' placements past f = 0 and .5: inside the (.5, .5 + 1/64] window a floor would double every rule. */
const WINDOW_PLACES = [0.50462, 0.51, 0.51385];
const EXTRA_PLACES = (process.env.HW_PAPER_FLOOR_PLACES ?? "").split(",").filter(Boolean).map(Number);

const PLANTS: { env: string; from: string; to: (v: string) => string }[] = [
	{ env: "HW_PAPER_FLOOR_PLANT_ONE", from: FLOOR_LINE, to: () => "export const RULE_FLOOR_DEVICE_PX = 1;" },
	{ env: "HW_PAPER_FLOOR_PLANT_EVERYWHERE", from: CONDITION_LINE, to: () => "return Math.max(literal, RULE_FLOOR_DEVICE_PX / devicePx);" },
	{ env: "HW_PAPER_PHASE_PLANT_NO_SNAP", from: SNAP_LINE, to: () => "const onGrid = folded;" },
	{ env: "HW_PAPER_FLOOR_VALUE", from: FLOOR_LINE, to: v => `export const RULE_FLOOR_DEVICE_PX = ${Number(v)};` },
];

beforeAll(async () => {
	const active = PLANTS.filter(pl => process.env[pl.env]);
	if (active.filter(pl => pl.from === FLOOR_LINE).length > 1) throw new Error("one floor value at a time");
	let planted = 0;
	const b = await build({
		entryPoints: [fileURLToPath(new URL("./noteViewportCameraPage.ts", import.meta.url))],
		bundle: true, write: false, format: "iife", platform: "browser",
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
		plugins: active.length ? [{ name: "paper-rule-floor-plants", setup(builder) {
			builder.onLoad({ filter: /src[\\/]inline[\\/]PaperPlan\.ts$/ }, args => {
				let text = readFileSync(args.path, "utf8").replace(/\r\n/g, "\n");
				for (const pl of active) {
					if (text.split(pl.from).length !== 2) throw new Error(`${pl.env}: anchor not found once`);
					text = text.replace(pl.from, pl.to(process.env[pl.env]!));
					planted++;
				}
				return { loader: "ts", contents: text };
			});
		} }] : [],
	});
	if (planted !== active.length) throw new Error(`plants requested ${active.length}, applied ${planted}`);
	script = b.outputFiles[0]!.text;
	for (const dsf of [1, 2]) browsers.set(dsf, await chromium.launch({ headless: true, args: [`--force-device-scale-factor=${dsf}`, "--window-size=900,700"] }));
}, 180_000);

afterAll(async () => { for (const b of browsers.values()) await b.close(); });

const contrast = (r: number, g: number, b: number) => Math.max(0, Math.min(1, (PAGE_GREY - (r + g + b) / 3) / (PAGE_GREY - RULE_GREY)));
const frac = (v: number) => v - Math.floor(v);

/** The median contrast of each device row across a narrow strip. */
async function rowProfile(p: Page, clip: { x: number; y: number; width: number; height: number }): Promise<number[]> {
	const d = decodePng(await p.screenshot({ clip }));
	const out: number[] = [];
	for (let y = 0; y < d.height; y++) {
		const vals: number[] = [];
		for (let x = 0; x < d.width; x++) { const at = (y * d.width + x) * d.channels; vals.push(contrast(d.px[at]!, d.px[at + 1]!, d.px[at + 2]!)); }
		vals.sort((a, b) => a - b);
		out.push(vals[Math.floor(vals.length / 2)]!);
	}
	return out;
}

/** Sets the host's phase f device px past `basePhase` and reads every rule in the strip. */
async function readPlacement(p: Page, dsf: number, z: number, basePhase: number, place: number, setPhase = true) {
	const target = basePhase + place / (z * dsf);
	const g = await p.evaluate(async ({ target, setPhase }) => {
		const sc = document.querySelector(".cm-scroller") as HTMLElement, host = document.querySelector(".cm-editor") as HTMLElement;
		if (setPhase) host.style.setProperty("--handwriting-paper-phase", `${target}px`);
		await (window as any).viewportFixture.settle();
		const r = sc.getBoundingClientRect(), cs = getComputedStyle(host);
		const num = (name: string) => Number.parseFloat(cs.getPropertyValue(name)) || 0;
		return { scrollTop: sc.scrollTop, top: r.top, clientTop: sc.clientTop, left: r.left, k: r.height / sc.offsetHeight,
			pitch: num("--handwriting-paper-pitch"), rule: num("--handwriting-paper-rule"), phase: num("--handwriting-paper-phase") };
	}, { target, setPhase });
	const clip = { x: Math.round(g.left + 2), y: Math.round(g.top + 240), width: 12, height: 230 };
	const prof = await rowProfile(p, clip);
	const t = g.rule * g.k * dsf, y0 = clip.y * dsf;
	// A rule's bottom stop in device rows from the strip's top: phase + m x pitch in the positioning area.
	const E = (m: number) => dsf * (g.top + (g.clientTop + g.phase + m * g.pitch - g.scrollTop) * g.k) - y0;
	const stripTopLayout = (clip.y - g.top) / g.k - g.clientTop + g.scrollTop;
	const m0 = Math.floor((stripTopLayout - g.phase) / g.pitch) - 2, m1 = m0 + Math.ceil(clip.height / (g.k * g.pitch)) + 4;
	const rules: { fracBottom: number; predicted: number[]; painted: number[]; peak: number; vanished: boolean; boundary: boolean }[] = [];
	for (let m = m0; m <= m1; m++) {
		const e = E(m);
		if (e - t < 3 || e > prof.length - 3) continue;
		const predicted: number[] = [];
		for (let n = Math.ceil(e - t - 0.5); n + 0.5 < e; n++) if (n + 0.5 >= e - t) predicted.push(n);
		const painted: number[] = [];
		let peak = 0;
		for (let n = Math.floor(e - t) - 1; n <= Math.ceil(e); n++) { const v = prof[n]!; peak = Math.max(peak, v); if (v > 0.5) painted.push(n); }
		const boundary = Math.abs(frac(e) - 0.5) < 0.02 || Math.abs(frac(e - t) - 0.5) < 0.02;
		rules.push({ fracBottom: Math.round(frac(e) * 1000) / 1000, predicted, painted, peak: Math.round(peak * 100) / 100, vanished: peak <= 0.1, boundary });
	}
	const clear = rules.filter(r => !r.boundary && !r.vanished);
	const agreement = clear.length ? clear.filter(r => r.painted.length === r.predicted.length && r.painted.every((n, i) => n === r.predicted[i])).length / clear.length : Number.NaN;
	const minPeak = rules.length ? Math.min(...rules.map(r => r.peak)) : Number.NaN;
	return { place, target, minPeak, phaseReadBack: g.phase, deviceRule: t, pitchDevice: g.pitch * g.k * dsf, rules: rules.length, boundary: rules.filter(r => r.boundary).length,
		clear: clear.length, agreement, vanished: rules.filter(r => r.vanished).length, faded: rules.filter(r => !r.vanished && r.peak < 0.75).length,
		twoRows: rules.filter(r => r.painted.length >= 2).length, fracs: [...new Set(rules.map(r => r.fracBottom))].slice(0, 6) };
}

const FLOOR_LABEL = process.env.HW_PAPER_FLOOR_VALUE ?? (process.env.HW_PAPER_FLOOR_PLANT_ONE ? "1" : process.env.HW_PAPER_FLOOR_PLANT_EVERYWHERE ? "everywhere" : process.env.HW_PAPER_PHASE_PLANT_NO_SNAP ? "planned, no snap" : "planned");

async function mountLines(dsf: number, z: number) {
	const ctx = await browsers.get(dsf)!.newContext({ viewport: null });
	const p = await ctx.newPage();
	await p.setContent(`<!doctype html><body class="handwriting-paper-lines" style="margin:0; background:#ffffff; --background-modifier-border:#777777"></body>`);
	await p.addStyleTag({ content: css + OBSIDIAN_CAMERA_CSS });
	await p.addScriptTag({ content: script });
	await p.evaluate(async z => {
		await (window as any).viewportFixture.setup("paper", "far", 1, 1, "x");
		await (window as any).edgeAudit.commit("paper", z);
		(document.querySelector(".cm-scroller") as HTMLElement).scrollTop = 600;
		await (window as any).viewportFixture.settle();
	}, z);
	// The page guides' faint line is a screen line over the paper on an Infinite Canvas note, not a rule of it: hidden
	// through the test's own style, after the box is seen up and before any read, and the paper's plan read back unchanged.
	const hide = await p.evaluate(async () => {
		const host = document.querySelector(".cm-editor") as HTMLElement;
		const plan = () => { const cs = getComputedStyle(host); return ["--handwriting-paper-pitch", "--handwriting-paper-rule", "--handwriting-paper-phase"].map(n => cs.getPropertyValue(n)).join("|"); };
		const box = !!document.querySelector(".cm-scroller > .handwriting-page-guides"), before = plan();
		const style = document.createElement("style");
		style.textContent = ".handwriting-page-guides { visibility: hidden !important; }";
		document.head.appendChild(style);
		await (window as any).viewportFixture.settle();
		return { box, before, after: plan() };
	});
	expect(hide.box, `premise: the page guides' box is up before the hide (${dsf}@${z}); none here means the hide proves nothing`).toBe(true);
	expect(hide.after, `premise: hiding the page guides left the paper plan alone (${dsf}@${z})`).toBe(hide.before);
	// The host-set placements count from the note origin itself (the content's top padding at scrollTop's whole pitches),
	// not from the overlay's plan, which puts the phase on the device px grid.
	const basePhase = await p.evaluate(() => Number.parseFloat(getComputedStyle(document.querySelector(".cm-content") as HTMLElement).paddingTop) || 0);
	return { ctx, p, basePhase };
}

type Reading = Awaited<ReturnType<typeof readPlacement>>;

function premises(readings: Reading[]) {
	for (const r of readings) {
		expect(r.rules, `premise: rules expected in the strip at f ${r.place} ${JSON.stringify(r)}`).toBeGreaterThanOrEqual(5);
		expect(Math.abs(r.phaseReadBack - r.target), `premise: the phase reads back as set at f ${r.place}`).toBeLessThanOrEqual(1e-6);
	}
	expect(readings[0]!.agreement, `premise: at f 0 the painted rows are the rows the stops predict ${JSON.stringify(readings[0])}`).toBeGreaterThanOrEqual(0.9);
}

it.each([[2, 0.3], [2, 0.1]] as const)("RULE FLOOR, lined paper at DSF %s, zoom %s: no rule vanishes when the stops sit on pixel centres", async (dsf, z) => {
	const { ctx, p, basePhase } = await mountLines(dsf, z);
	try {
		const readings: Reading[] = [];
		for (const place of [0, 0.5, ...EXTRA_PLACES]) readings.push(await readPlacement(p, dsf, z, basePhase, place));
		// eslint-disable-next-line no-console
		for (const r of readings) console.log(`PAPER-RULE-FLOOR dsf=${dsf} z=${z} floor=${FLOOR_LABEL} place=${r.place}`, JSON.stringify(r));
		premises(readings);
		const half = readings[1]!, arm = `${dsf}@${z}`;
		expect(half.boundary, `premise: rules whose stops sit on pixel centres are present at f .5 ${JSON.stringify(half)}`).toBeGreaterThanOrEqual(1);
		expect(half.agreement, `premise: at f .5 the rules off the boundary paint the rows their stops predict ${JSON.stringify(half)}`).toBeGreaterThanOrEqual(0.9);
		expect.soft(half.vanished, `RULE FLOOR ${arm}: rules that vanished with their stops on pixel centres ${JSON.stringify(half)}`).toBe(0);
		expect.soft(half.faded, `RULE FLOOR ${arm}: rules painted fainter than three quarters of the contrast ${JSON.stringify(half)}`).toBe(0);
		expect.soft(half.twoRows, `RULE FLOOR ${arm}: rules painted two rows tall at f .5, measured on the floor as planned ${JSON.stringify(half)}`).toBeLessThanOrEqual(TWO_ROWS_AT_MOST[arm]!);
	} finally {
		await ctx.close();
	}
}, 180_000);

it.each([[2, 0.5], [1, 1]] as const)("RULE FLOOR, lined paper at DSF %s, zoom %s: a rule that is one device px stays one, and no rule doubles", async (dsf, z) => {
	const { ctx, p, basePhase } = await mountLines(dsf, z);
	try {
		const readings: Reading[] = [];
		for (const place of [0, 0.5, ...WINDOW_PLACES, ...EXTRA_PLACES]) readings.push(await readPlacement(p, dsf, z, basePhase, place));
		// eslint-disable-next-line no-console
		for (const r of readings) console.log(`PAPER-RULE-FLOOR dsf=${dsf} z=${z} floor=${FLOOR_LABEL} place=${r.place}`, JSON.stringify(r));
		premises(readings);
		for (const r of readings.slice(0, 2 + WINDOW_PLACES.length)) {
			expect.soft(r.deviceRule, `EVERYDAY ${dsf}@${z} f ${r.place}: the rule's width in device px`).toBeCloseTo(1, 9);
			expect.soft(r.twoRows, `EVERYDAY ${dsf}@${z} f ${r.place}: rules painted two rows tall ${JSON.stringify(r)}`).toBe(0);
		}
	} finally {
		await ctx.close();
	}
}, 180_000);

it.each([[2, 0.5], [1, 1]] as const)("RULE FLOOR, lined paper at DSF %s, zoom %s: at every note origin the planned rules sit on pixel edges, none vanishes, fades or doubles", async (dsf, z) => {
	const { ctx, p } = await mountLines(dsf, z);
	try {
		const basePad = 0;
		const readings = [];
		for (const place of ORIGIN_PLACES) {
			// The note's origin moves f device px: a top margin on the content, in the zoomed editor's layout px (CodeMirror reads
			// the content's padding as a whole px, so a padding change cannot place a fraction). A measure, then a forced extent
			// update (growing by nothing), captures the origin; either alone left the plan as it was.
			const origin = await p.evaluate(async ({ pad, z }) => {
				const content = document.querySelector(".cm-content") as HTMLElement;
				content.style.marginTop = `${pad}px`;
				await (window as any).viewportFixture.fontPx("paper", 16);
				await (window as any).viewportFixture.growTo("paper", 0, 0);
				const cs = getComputedStyle(document.querySelector(".cm-editor") as HTMLElement);
				return { pad: Number.parseFloat(getComputedStyle(content).marginTop), phase: Number.parseFloat(cs.getPropertyValue("--handwriting-paper-phase")),
					zoom: (window as any).viewportFixture.snap("paper").state.zoom as number };
			}, { pad: basePad + place / (z * dsf), z });
			const r = await readPlacement(p, dsf, z, 0, place, false);
			readings.push({ ...r, pad: origin.pad, zoom: origin.zoom, phaseDevice: r.phaseReadBack * z * dsf });
		}
		// eslint-disable-next-line no-console
		for (const r of readings) console.log(`PAPER-RULE-FLOOR-SNAP dsf=${dsf} z=${z} floor=${FLOOR_LABEL} origin+${r.place}`, JSON.stringify(r));
		const phases = new Set(readings.map(r => r.phaseReadBack));
		expect(phases.size, `premise: the overlay re-planned the phase as the origin moved (distinct planned phases ${JSON.stringify([...phases])})`).toBeGreaterThanOrEqual(2);
		for (const r of readings) expect(r.zoom, `premise: back at zoom ${z} for origin +${r.place}`).toBeCloseTo(z, 6);
		expect(readings[0]!.rules, `premise: rules expected in the strip ${JSON.stringify(readings[0])}`).toBeGreaterThanOrEqual(5);
		expect(readings[0]!.agreement, `premise: at the unmoved origin the painted rows are the rows the stops predict ${JSON.stringify(readings[0])}`).toBeGreaterThanOrEqual(0.9);
		for (const r of readings) expect(Math.abs(r.pad - (basePad + r.place / (z * dsf))), `premise: the origin moved ${r.place} device px`).toBeLessThanOrEqual(1e-3);
		for (const r of readings) {
			const arm = `SNAP ${dsf}@${z} origin +${r.place}`;
			expect.soft(Math.abs(r.phaseDevice - Math.round(r.phaseDevice)), `${arm}: the planned phase is a whole number of device px (${r.phaseDevice})`).toBeLessThanOrEqual(1e-3);
			expect.soft(r.vanished, `${arm}: rules that vanished ${JSON.stringify(r)}`).toBe(0);
			expect.soft(r.faded, `${arm}: rules fainter than three quarters of the contrast ${JSON.stringify(r)}`).toBe(0);
			expect.soft(r.twoRows, `${arm}: rules painted two rows tall ${JSON.stringify(r)}`).toBe(0);
			expect.soft(r.minPeak, `${arm}: the faintest rule's peak ${JSON.stringify(r)}`).toBeGreaterThanOrEqual(0.9);
		}
		// eslint-disable-next-line no-console
		console.log(`PAPER-RULE-FLOOR-SNAP dsf=${dsf} z=${z} distinct planned phases`, JSON.stringify([...phases]));
	} finally {
		await ctx.close();
	}
}, 180_000);
