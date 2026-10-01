/**
 * MEASUREMENT ONLY: what grid paper actually paints at a pinch-left zoom.
 *
 * Alan, Orion, vault test 2, c978650e: "background kinda messed up on grid background at 50% zoom", screenshot at
 * Alan's Orion screenshot alan-orion-grid-50pct.png, zoom 51.8 percent. This file measures; it rules
 * nothing and fixes nothing. It reads every rule the grid paints on both axes and reports position, width, peak
 * contrast and mass, so the table can say where the rules are uneven and whether the pitch is a whole number of
 * device px there.
 *
 * WHY BOTH AXES SEPARATELY: the screenshot's vertical rules are fainter and less even than its horizontal ones, and
 * the two axes take their phase from different origins (`--handwriting-paper-phase` from the note's top,
 * `--handwriting-paper-phase-x` from the text column's left edge) but share one pitch and one rule width. A single
 * profile would average the difference away.
 *
 * THE INSTRUMENT, and its two known ways of lying:
 *  - a row profile of a GRID crosses every vertical rule, so a mean would read the verticals as a floor under the
 *    horizontals. The profile is the MEDIAN across the strip, which a rule one device px wide in a strip tens of px
 *    wide cannot move.
 *  - the text itself is ink on the page the profile would read as paper. The text is hidden with `visibility` (which
 *    keeps its layout, and so the origin the phase is planned from) and the paper properties are read back before and
 *    after hiding it: `textHidingMovedThePlan` in each reading says whether that premise held.
 *
 * Bands, not predicted stops: the reader finds what is painted (runs of rows above a tenth of the contrast) instead of
 * looking only where a rule is expected, so a rule that has moved, split or vanished is still counted and reported.
 *
 * Output: one JSON line per arm on stdout (this config prints stdout for failing tests only), and the whole set to
 * HW_GRID_OUT if set - the arms are the evidence, and a passing measurement must not be invisible.
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import { decodePng } from "./pngInk";

declare const process: { env: Record<string, string | undefined> };

const browsers = new Map<number, Browser>();
let script: string;
const OBSIDIAN_CAMERA_CSS = readFileSync(fileURLToPath(new URL("./noteViewportCamera.css", import.meta.url)), "utf8");
const PAGE_GREY = 255, RULE_GREY = 0x77;
const DSFS = [1, 1.25, 1.5, 2] as const;
/** Orion's arm first: 2880x1920 at Windows 200 percent, so DSF 2, and the screenshot's own 51.8 percent. */
const PRIORITY = { dsf: 2, zoom: 0.518 } as const;
const ZOOMS = [0.5, 0.518, 0.373] as const;
const FONTS = [16, 18, 20] as const;
const OUT = process.env.HW_GRID_OUT;
/** Measurement aid: keeps the raw profiles in the output, for reading a stretch the bands say is empty. */
const RAW = process.env.HW_GRID_RAW === "1";
/** Measurement aid: saves each arm's whole scroller as a PNG, to look at what a profile reports. */
const PNG = process.env.HW_GRID_PNG;
/**
 * THE GATE'S PLANT: both layers put back on the scroller, and the vertical box emptied, so the page paints the grid
 * the way it did at the parent. The gate cells below have to redden with it, or they are asserting nothing about
 * where the layers live.
 */
const PLANT_BOTH_ON_SCROLLER = process.env.HW_GRID_PLANT_BOTH_ON_SCROLLER === "1";
const readings: Reading[] = [];

beforeAll(async () => {
	const b = await build({
		entryPoints: [fileURLToPath(new URL("./noteViewportCameraPage.ts", import.meta.url))],
		bundle: true, write: false, format: "iife", platform: "browser",
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
	});
	script = b.outputFiles[0]!.text;
	for (const dsf of DSFS) browsers.set(dsf, await chromium.launch({ headless: true, args: [`--force-device-scale-factor=${dsf}`, "--window-size=1100,900"] }));
}, 240_000);

afterAll(async () => {
	for (const b of browsers.values()) await b.close();
	if (OUT && readings.length) {
		mkdirSync(OUT.replace(/[\/][^\/]+$/, ""), { recursive: true });
		writeFileSync(OUT, JSON.stringify(readings, null, 1));
	}
});

const contrast = (r: number, g: number, b: number) => Math.max(0, Math.min(1, (PAGE_GREY - (r + g + b) / 3) / (PAGE_GREY - RULE_GREY)));
const round = (v: number, n = 3) => Math.round(v * 10 ** n) / 10 ** n;

/** The median contrast of every device row (axis "y") or every device column (axis "x") of one screenshot. */
async function profile(p: Page, clip: { x: number; y: number; width: number; height: number }, axis: "x" | "y", stat: "median" | "max" = "median"): Promise<number[]> {
	const d = decodePng(await p.screenshot({ clip }));
	const outer = axis === "y" ? d.height : d.width, inner = axis === "y" ? d.width : d.height;
	const out: number[] = [];
	for (let i = 0; i < outer; i++) {
		const vals: number[] = [];
		for (let j = 0; j < inner; j++) {
			const at = ((axis === "y" ? i * d.width + j : j * d.width + i)) * d.channels;
			vals.push(contrast(d.px[at]!, d.px[at + 1]!, d.px[at + 2]!));
		}
		vals.sort((a, b) => a - b);
		out.push(stat === "max" ? vals[vals.length - 1]! : vals[Math.floor(vals.length / 2)]!);
	}
	return out;
}

interface Band { at: number; width: number; peak: number; mass: number }

/** One axis of one arm, as the table prints it. */
interface AxisSummary {
	count: number; spreadPct: number; peakMin: number; peakMax: number; absent: number; periodSeen: number; widths: number[]; massMin: number; massMax: number;
}

/** One arm: the geometry the overlay planned, and what the pixels hold on both axes. */
interface Reading {
	arm: string; variant: string; paper: string; scrollHeight: number; scrollWidth: number; clientHeight: number; clientWidth: number;
	dsf: number; zoom: number; fontPx: number; zoomSeen: number;
	pitchLayout: number; ruleLayout: number; k: number; pitchDevice: number; ruleDevice: number; pitchDeviceWhole: boolean;
	phase: number; phaseX: number; phaseDevice: number; phaseXDevice: number; textHidingMovedThePlan: boolean;
	/** Every painted rule against where the plan puts it, in device px: the largest miss, and the first and last one. */
	driftMax: number; driftSpan: number; driftFirst: number; driftLast: number; ruleToFirstLine: number; scrollTop: number;
	periodsRows: number; periodsCols: number; rows: AxisSummary; rowsMid: AxisSummary; cols: AxisSummary; sameRowsBothStrips: boolean;
	rowBands: Band[]; colBands: Band[]; rawRows?: number[]; rawCols?: number[];
}

/** Every painted run in a profile: where it is, how many device rows it covers, its darkest row and its total ink. */
function bands(prof: number[], floor = 0.1): Band[] {
	const out: Band[] = [];
	let run: number[] = [], start = 0;
	const close = (): void => {
		if (!run.length) return;
		const mass = run.reduce((a, b) => a + b, 0);
		out.push({ at: round(start + run.reduce((a, v, i) => a + v * i, 0) / mass, 2), width: run.length, peak: round(Math.max(...run), 3), mass: round(mass, 3) });
		run = [];
	};
	for (let i = 0; i < prof.length; i++) {
		const v = prof[i]!;
		if (v > floor) { if (!run.length) start = i; run.push(v); }
		else close();
	}
	close();
	// The strip's two ends cut whatever rule sits there, so their width and mass are not a rule's.
	return out.filter(b => b.at > 1 && b.at < prof.length - 2);
}

/** What the arm did to the rules on one axis. */
function summary(bs: Band[], periodDevice: number): AxisSummary {
	if (bs.length < 2) return { count: bs.length, spreadPct: Number.NaN, peakMin: Number.NaN, peakMax: Number.NaN, absent: Number.NaN, periodSeen: Number.NaN, widths: [] as number[], massMin: Number.NaN, massMax: Number.NaN };
	const gaps = bs.slice(1).map((b, i) => b.at - bs[i]!.at).sort((a, b) => a - b);
	const periodSeen = gaps[Math.floor(gaps.length / 2)]!;
	const peaks = bs.map(b => b.peak), masses = bs.map(b => b.mass);
	const peakMin = Math.min(...peaks), peakMax = Math.max(...peaks);
	// A gap of about two periods is a rule that was not painted at all.
	const absent = bs.slice(1).reduce((n, b, i) => n + Math.max(0, Math.round((b.at - bs[i]!.at) / periodDevice) - 1), 0);
	return { count: bs.length, spreadPct: round(((peakMax - peakMin) / peakMax) * 100, 1), peakMin: round(peakMin, 3), peakMax: round(peakMax, 3),
		absent, periodSeen: round(periodSeen, 2), widths: [...new Set(bs.map(b => b.width))].sort(), massMin: round(Math.min(...masses), 3), massMax: round(Math.max(...masses), 3) };
}

/**
 * One arm's departure from the default: which paper, how long and wide the scrolled area is, and whether the rule or
 * the gradient itself is replaced before the pixels are read. The ruling's E1 to E5, and nothing else changes.
 */
interface Variant {
	/** What the line in the table is called. "" is the default arm. */
	readonly name: string;
	/** The fixture's ink, which is what makes the scrolled area short, long or very long. */
	readonly kind?: string;
	readonly paper?: "grid" | "lines" | "dots";
	/** A minimum width on the content, so the gradient's positioning area is wide as well as tall. */
	readonly wide?: number;
	/** Force `--handwriting-paper-rule` to exactly this many device px, replacing the plan's thickness. */
	readonly ruleDevicePx?: number;
	/** Replace the scroller's background with the same stops written as literal px: no var(), calc() or @property. */
	readonly literalStops?: boolean;
	/** With `literalStops`, keep only the horizontal layer ("h") or only the vertical one ("v"). */
	readonly onlyLayer?: "h" | "v";
	/** With `literalStops`, paint the vertical layer FIRST and the horizontal one second. */
	readonly reverseLayers?: boolean;
	/** The ruling's direction: the grid as ONE conic-gradient tile, a pitch square, applied over the shipped CSS. */
	readonly tile?: boolean;
	/** Scroll to the end of the scrolled area before reading, for the drift arms. */
	readonly atBottom?: boolean;
	/** The note's text. The default is one character; the drift arms need many line boxes to compare the paper to. */
	readonly doc?: string;
	/** Scroll to the END OF THE TEXT rather than the end of the scrolled area, so line boxes are still on screen. */
	readonly atTextEnd?: boolean;
	/** G1: a layer that paints nothing, listed FIRST, ahead of the two real ones. */
	readonly sacrificial?: "plain" | "stops";
	/** G2: the vertical layer moved onto a second box inside the scroller, the horizontal one left on the scroller. */
	readonly twoBoxes?: boolean;
	/** G3: one axis as a repeating gradient, the other as a tiled plain one. "h-repeats" keeps the shipped order. */
	readonly mixed?: "h-repeats" | "v-repeats";
	/** G4: both shipped layers on a preview-shaped box - pane size plus one pitch margin, no local attachment. */
	readonly previewBox?: boolean;
	/** G5: a minimum height on the content, to walk the scrolled area's size. */
	readonly tall?: number;
	/** The ruling's plant: both layers back on the scroller, the vertical box emptied. */
	readonly plantBothOnScroller?: boolean;
}

async function mountGrid(dsf: number, zoom: number, fontPx: number, v: Variant) {
	const ctx = await browsers.get(dsf)!.newContext({ viewport: null });
	const p = await ctx.newPage();
	await p.setContent(`<!doctype html><body class="handwriting-paper-${v.paper ?? "grid"}" style="margin:0; background:#ffffff; --background-modifier-border:#777777"></body>`);
	await p.addStyleTag({ content: css + OBSIDIAN_CAMERA_CSS });
	await p.addScriptTag({ content: script });
	await p.evaluate(async ({ zoom, fontPx, kind, wide, tall, doc }) => {
		await (window as any).viewportFixture.setup("paper", kind, 1, 1, doc);
		await (window as any).viewportFixture.fontPx("paper", fontPx);
		if (wide) (document.querySelector(".cm-content") as HTMLElement).style.minWidth = `${wide}px`;
		if (tall) (document.querySelector(".cm-content") as HTMLElement).style.minHeight = `${tall}px`;
		await (window as any).edgeAudit.commit("paper", zoom);
		(document.querySelector(".cm-scroller") as HTMLElement).scrollTop = 600;
		await (window as any).viewportFixture.settle();
	}, { zoom, fontPx, kind: v.kind ?? "far", wide: v.wide ?? 0, tall: v.tall ?? 0, doc: v.doc ?? "x" });
	return { ctx, p };
}

async function readArm(dsf: number, zoom: number, fontPx: number, v: Variant = { name: "" }): Promise<Reading> {
	const { ctx, p } = await mountGrid(dsf, zoom, fontPx, v);
	try {
		const before = await p.evaluate(() => {
			const host = document.querySelector(".cm-editor") as HTMLElement, cs = getComputedStyle(host);
			const num = (n: string): number => Number.parseFloat(cs.getPropertyValue(n)) || 0;
			return { pitch: num("--handwriting-paper-pitch"), rule: num("--handwriting-paper-rule"), phase: num("--handwriting-paper-phase"), phaseX: num("--handwriting-paper-phase-x") };
		});
		const g = await p.evaluate(async ({ v, dsf }) => {
			// The text is ink the profile would read as paper. `visibility` keeps its layout, so the note origin the
			// phase is planned from does not move - the plan is read back below to say so.
			const style = document.createElement("style");
			style.textContent = ".cm-line, .cm-widgetBuffer { visibility: hidden !important; }";
			document.head.appendChild(style);
			// The plugin's own furniture is ink, not paper: the pen strip, the zoom chip and every ink canvas sit over
			// the scroller and a profile would read their boxes as rules. Hidden, not removed, so nothing relayouts.
			for (const el of Array.from(document.querySelectorAll("canvas"))) (el as HTMLElement).style.visibility = "hidden";
			for (const el of Array.from(document.body.querySelectorAll<HTMLElement>("*"))) {
				if (el.closest(".cm-editor")) continue;
				if (/pen-tools|zoom|chip|toolbar|strip|tools/i.test(el.className || "")) el.style.visibility = "hidden";
			}
			await (window as any).viewportFixture.settle();
			const sc = document.querySelector(".cm-scroller") as HTMLElement, host = document.querySelector(".cm-editor") as HTMLElement;
			const k0 = sc.getBoundingClientRect().height / sc.offsetHeight;
			// Since the fix, grid paper paints its VERTICAL rules on a box inside the scroller
			// (.handwriting-paper-grid-column), not on the scroller itself. Every arm below that REPLACES the scroller's
			// background is asking what one box paints, so the plugin's own box is emptied first - left painting, it adds
			// a perfect set of vertical rules underneath the arm's own, and an arm built to paint one axis reads two.
			// The arms that measure the SHIPPED paper (the gate's seven, and every default arm) touch nothing here.
			if (v.literalStops || v.mixed || v.tile || v.previewBox || v.sacrificial || v.twoBoxes || v.plantBothOnScroller) {
				const column = document.querySelector(".handwriting-paper-grid-column") as HTMLElement | null;
				if (column) column.style.backgroundImage = "none";
			}
			// E2: the rule set to a whole number of device px, in the layout px the property is written in. The overlay
			// leaves a value it did not write alone, so this holds for the rest of the arm.
			if (v.ruleDevicePx) host.style.setProperty("--handwriting-paper-rule", `${v.ruleDevicePx / (k0 * dsf)}px`);
			// F1: the grid as ONE layer - a pitch-square conic tile, phase carried by the tile position exactly as the
			// dots carry it (styles.css :603-:611). Written over the shipped rules on the element, nothing in src.
			if (v.tile) {
				const c0 = getComputedStyle(host), n0 = (name: string): number => Number.parseFloat(c0.getPropertyValue(name)) || 0;
				const pitch = n0("--handwriting-paper-pitch"), rule = n0("--handwriting-paper-rule");
				const ph = n0("--handwriting-paper-phase"), phx = n0("--handwriting-paper-phase-x");
				const corner = `${pitch - rule}px`;
				sc.style.backgroundImage = `conic-gradient(from 270deg at ${corner} ${corner}, transparent 0 90deg, rgb(119, 119, 119) 90deg)`;
				sc.style.backgroundSize = `${pitch}px ${pitch}px`;
				sc.style.backgroundPosition = `${phx}px ${ph}px`;
				sc.style.backgroundAttachment = "local";
			}
			// G3: one axis as the shipped repeating gradient, the other as a plain gradient TILED to the pitch, the way
			// the dots are tiled. Both on the one box, so this asks whether the kind of layer matters or only the count.
			if (v.mixed) {
				const c2 = getComputedStyle(host), n2 = (name: string): number => Number.parseFloat(c2.getPropertyValue(name)) || 0;
				const pitch = n2("--handwriting-paper-pitch"), rule = n2("--handwriting-paper-rule");
				const ph = n2("--handwriting-paper-phase"), phx = n2("--handwriting-paper-phase-x");
				const ink = "rgb(119, 119, 119)";
				const repeating = (dir: string, start: number): string =>
					`repeating-linear-gradient(${dir}, transparent ${start}px, transparent ${start + pitch - rule}px, ${ink} ${start + pitch - rule}px, ${ink} ${start + pitch}px)`;
				const tiled = (dir: string): string => `linear-gradient(${dir}, transparent ${pitch - rule}px, ${ink} 0)`;
				if (v.mixed === "h-repeats") {
					sc.style.backgroundImage = `${repeating("to bottom", ph)}, ${tiled("to right")}`;
					sc.style.backgroundSize = `auto, ${pitch}px 100%`;
					sc.style.backgroundPosition = `0 0, ${phx}px 0`;
				} else {
					sc.style.backgroundImage = `${repeating("to right", phx)}, ${tiled("to bottom")}`;
					sc.style.backgroundSize = `auto, 100% ${pitch}px`;
					sc.style.backgroundPosition = `0 0, 0 ${ph}px`;
				}
				sc.style.backgroundAttachment = "local, local";
			}
			// G4: the shape the pinch preview paints on - one element the size of the pane plus a pitch of margin
			// (InkOverlay.movePreviewPaper), carrying the resolved background, and NOT locally attached.
			if (v.previewBox) {
				const c3 = getComputedStyle(host), n3 = (name: string): number => Number.parseFloat(c3.getPropertyValue(name)) || 0;
				const pitch = n3("--handwriting-paper-pitch"), rule = n3("--handwriting-paper-rule");
				const ph = n3("--handwriting-paper-phase"), phx = n3("--handwriting-paper-phase-x");
				const ink = "rgb(119, 119, 119)";
				const layer = (dir: string, start: number): string =>
					`repeating-linear-gradient(${dir}, transparent ${start}px, transparent ${start + pitch - rule}px, ${ink} ${start + pitch - rule}px, ${ink} ${start + pitch}px)`;
				sc.style.backgroundImage = "none";
				if (getComputedStyle(sc).position === "static") sc.style.position = "relative";
				const box = document.createElement("div");
				box.setAttribute("data-preview-paper-box", "");
				box.style.cssText = `position:absolute; left:${-pitch}px; top:${-pitch}px; width:${sc.clientWidth + 2 * pitch}px; height:${sc.clientHeight + 2 * pitch}px; pointer-events:none; z-index:0; background-image:${layer("to bottom", ph)}, ${layer("to right", phx)}; background-attachment:scroll, scroll; background-position:0 0, 0 0;`;
				sc.insertBefore(box, sc.firstChild);
			}
			// G1 and G2 are built from the same literal stops E3 showed reproduce the shipped grid to the digit.
			if (v.sacrificial || v.twoBoxes) {
				const c1 = getComputedStyle(host), n1 = (name: string): number => Number.parseFloat(c1.getPropertyValue(name)) || 0;
				const pitch = n1("--handwriting-paper-pitch"), rule = n1("--handwriting-paper-rule");
				const ph = n1("--handwriting-paper-phase"), phx = n1("--handwriting-paper-phase-x");
				const ink = "rgb(119, 119, 119)";
				const layer = (dir: string, start: number, colour: string): string =>
					`repeating-linear-gradient(${dir}, transparent ${start}px, transparent ${start + pitch - rule}px, ${colour} ${start + pitch - rule}px, ${colour} ${start + pitch}px)`;
				const horizontal = layer("to bottom", ph, ink), vertical = layer("to right", phx, ink);
				if (v.sacrificial) {
					// (a) a plain two-stop transparent gradient, (b) the horizontal layer's own stops with nothing to
					// paint. Either way it is FIRST, which is the position that loses its rules.
					const dead = v.sacrificial === "plain" ? "linear-gradient(transparent, transparent)" : layer("to bottom", ph, "transparent");
					sc.style.backgroundImage = `${dead}, ${horizontal}, ${vertical}`;
					sc.style.backgroundAttachment = "local, local, local";
					sc.style.backgroundSize = "auto, auto, auto";
					sc.style.backgroundPosition = "0 0, 0 0, 0 0";
				} else {
					// G2: one real layer per box. The second box is a child of the scroller, covering the scrolled
					// area, so it moves with the content exactly as a local background does.
					sc.style.backgroundImage = horizontal;
					sc.style.backgroundAttachment = "local";
					sc.style.backgroundSize = "auto";
					sc.style.backgroundPosition = "0 0";
					if (getComputedStyle(sc).position === "static") sc.style.position = "relative";
					const box = document.createElement("div");
					box.setAttribute("data-grid-second-box", "");
					box.style.cssText = `position:absolute; left:0; top:0; width:${sc.scrollWidth}px; height:${sc.scrollHeight}px; pointer-events:none; z-index:0; background-image:${vertical}; background-repeat:repeat; background-position:0 0;`;
					sc.insertBefore(box, sc.firstChild);
				}
			}
			// plant: the two layers back on the one box, as they were at the parent, and the vertical box left with
			// nothing to paint. The stops are the element's own resolved values, which E3 measured to reproduce the
			// shipped grid to the digit.
			if (v.plantBothOnScroller) {
				const c4 = getComputedStyle(host), n4 = (name: string): number => Number.parseFloat(c4.getPropertyValue(name)) || 0;
				const pitch = n4("--handwriting-paper-pitch"), rule = n4("--handwriting-paper-rule");
				const ph = n4("--handwriting-paper-phase"), phx = n4("--handwriting-paper-phase-x");
				const ink = "rgb(119, 119, 119)";
				const layer = (dir: string, start: number): string =>
					`repeating-linear-gradient(${dir}, transparent ${start}px, transparent ${start + pitch - rule}px, ${ink} ${start + pitch - rule}px, ${ink} ${start + pitch}px)`;
				sc.style.backgroundImage = `${layer("to bottom", ph)}, ${layer("to right", phx)}`;
				sc.style.backgroundAttachment = "local, local";
				sc.style.backgroundSize = "auto";
				sc.style.backgroundPosition = "0 0";
			}
			// E3: the same stops, resolved to literal px by hand. No var(), no calc(), nothing a custom property feeds.
			if (v.literalStops) {
				const c = getComputedStyle(host), n = (name: string): number => Number.parseFloat(c.getPropertyValue(name)) || 0;
				const pitch = n("--handwriting-paper-pitch"), rule = n("--handwriting-paper-rule"), ph = n("--handwriting-paper-phase"), phx = n("--handwriting-paper-phase-x");
				const ink = "rgb(119, 119, 119)";
				const layer = (dir: string, start: number): string =>
					`repeating-linear-gradient(${dir}, transparent ${start}px, transparent ${start + pitch - rule}px, ${ink} ${start + pitch - rule}px, ${ink} ${start + pitch}px)`;
				const one = v.paper === "lines" || v.onlyLayer;
				sc.style.backgroundImage = v.onlyLayer === "v" ? layer("to right", phx)
					: one ? layer("to bottom", ph)
					: v.reverseLayers ? `${layer("to right", phx)}, ${layer("to bottom", ph)}`
					: `${layer("to bottom", ph)}, ${layer("to right", phx)}`;
				sc.style.backgroundAttachment = one ? "local" : "local, local";
				sc.style.backgroundSize = "auto";
				sc.style.backgroundPosition = "0 0";
			}
			// The rig's own snapshot walks the first hundred document positions through coordsAtPos, which returns null
			// for a position scrolled out of the rendered range: read the zoom BEFORE any scroll, or a long note's arm
			// dies with "Cannot read properties of null (reading 'left')".
			const zoomSeen = (window as any).viewportFixture.snap("paper").state.zoom as number;
			// F2: the far end of a very long area, to read the same rules a whole note away from where they started.
			if (v.atBottom) { sc.scrollTop = sc.scrollHeight - sc.clientHeight - 40; }
			// Far down the TEXT rather than the end of the scrolled area, so line boxes are still on screen to compare
			// the paper against. A fixed distance, not the last line: scrolling to the very last line tears the rig's
			// measure down ("Cannot read properties of null").
			if (v.atTextEnd) sc.scrollTop = 6000;
			await (window as any).viewportFixture.settle();
			const r = sc.getBoundingClientRect(), cs = getComputedStyle(host);
			const num = (n: string): number => Number.parseFloat(cs.getPropertyValue(n)) || 0;
			return { top: r.top, left: r.left, height: r.height, width: r.width, k: r.height / sc.offsetHeight, zoom: zoomSeen,
				scrollHeight: sc.scrollHeight, scrollWidth: sc.scrollWidth, clientHeight: sc.clientHeight, clientWidth: sc.clientWidth,
				scrollTop: sc.scrollTop, clientTop: sc.clientTop,
				// The first line box INSIDE the viewport, not the first in the document: the document's is far above
				// the rect once the note is scrolled, and a distance to it says nothing about what is on screen.
				lineTops: Array.from(document.querySelectorAll(".cm-line")).map(l => l.getBoundingClientRect().top).filter(t => t > r.top && t < r.bottom),
				pitch: num("--handwriting-paper-pitch"), rule: num("--handwriting-paper-rule"), phase: num("--handwriting-paper-phase"), phaseX: num("--handwriting-paper-phase-x") };
		}, { v, dsf });
		const periodCss = g.pitch * g.k, periodDevice = periodCss * dsf;
		// Twenty periods where the rect holds them, and whatever it holds where it does not; `periodsRows` says which.
		const rowsHigh = Math.min(Math.floor(g.height) - 8, Math.ceil(periodCss * 21));
		const colsWide = Math.min(Math.floor(g.width) - 8, Math.ceil(periodCss * 21));
		const rowClip = { x: Math.round(g.left + 6), y: Math.round(g.top + 4), width: 24, height: rowsHigh };
		const colClip = { x: Math.round(g.left + 4), y: Math.round(g.top + 4), width: colsWide, height: 24 };
		if (process.env.HW_GRID_STACK === "1") {
			const stack = await p.evaluate(({ top, left }) => {
				const out: unknown[] = [];
				for (const dy of [30, 80, 140, 200, 260, 320]) {
					const els = document.elementsFromPoint(left + 10, top + dy) as HTMLElement[];
					out.push({ dy, stack: els.slice(0, 4).map(e => {
						const cs = getComputedStyle(e), r = e.getBoundingClientRect();
						return `${e.className || e.tagName}|bg=${cs.backgroundColor}|img=${cs.backgroundImage.slice(0, 40)}|top=${Math.round(r.top)}|h=${Math.round(r.height)}`;
					}) });
				}
				const sc = document.querySelector(".cm-scroller") as HTMLElement, content = document.querySelector(".cm-content") as HTMLElement;
				const scs = getComputedStyle(sc);
				return { points: out, scroller: { bgPos: scs.backgroundPosition, bgSize: scs.backgroundSize, bgAttach: scs.backgroundAttachment, scrollTop: sc.scrollTop, scrollHeight: sc.scrollHeight, clientHeight: sc.clientHeight },
					content: { top: Math.round(content.getBoundingClientRect().top), height: Math.round(content.getBoundingClientRect().height), bg: getComputedStyle(content).backgroundColor } };
			}, { top: g.top, left: g.left });
			// eslint-disable-next-line no-console
			console.log("PAPER-GRID-STACK", JSON.stringify(stack));
		}
		if (PNG) {
			mkdirSync(PNG.replace(/[\/][^\/]+$/, ""), { recursive: true });
			await p.screenshot({ path: `${PNG}/grid-dsf${dsf}-z${zoom}-${fontPx}px${v.name ? `-${v.name}` : ""}.png`, clip: { x: Math.round(g.left), y: Math.round(g.top), width: Math.floor(g.width), height: Math.floor(g.height) } });
		}
		// A second row strip, half the scroller away from the first: a stretch with no rule in BOTH is the paper, not
		// something sitting over one strip.
		const midClip = { ...rowClip, x: Math.round(g.left + g.width / 2) };
		// Dots are one mark per cell: a median across the strip reads the page between them, so those arms take the
		// darkest pixel in each row instead. Rules span the strip and keep the median, which no single mark can move.
		const stat = v.paper === "dots" ? "max" : "median";
		const rowProf = await profile(p, rowClip, "y", stat), midProf = await profile(p, midClip, "y", stat), colProf = await profile(p, colClip, "x", stat);
		const rowBands = bands(rowProf), midBands = bands(midProf), colBands = bands(colProf);
		const pitchDevice = g.pitch * g.k * dsf, ruleDevice = g.rule * g.k * dsf;
		// Where the plan says each rule's CENTRE is, in the row strip's own device rows: the bottom stop is
		// phase + m x pitch in the scroller's positioning area, and the rule is `ruleDevice` tall above it.
		const y0 = rowClip.y * dsf;
		const centreOf = (m: number): number => dsf * (g.top + (g.clientTop + g.phase + m * g.pitch - g.scrollTop) * g.k) - y0 - ruleDevice / 2;
		const drifts = rowBands.map(b => {
			const m = Math.round((b.at + y0 + ruleDevice / 2 - dsf * g.top) / dsf / g.k + g.scrollTop - g.clientTop - g.phase) / g.pitch;
			const near = [Math.floor(m), Math.ceil(m)].map(centreOf).reduce((a, c) => Math.abs(c - b.at) < Math.abs(a - b.at) ? c : a);
			return round(b.at - near, 3);
		});
		const driftMax = drifts.length ? round(Math.max(...drifts.map(Math.abs)), 3) : Number.NaN;
		// The same residuals with their mean taken out: a constant offset between the reader's idea of the grid and the
		// rasteriser's is not drift, and this is the number that only moves when the period itself does.
		const mean = drifts.length ? drifts.reduce((a, b) => a + b, 0) / drifts.length : Number.NaN;
		const driftSpan = drifts.length ? round(Math.max(...drifts.map(d => Math.abs(d - mean))), 3) : Number.NaN;
		// The paper against the TEXT, which is what a drifting tile would pull apart: the first line box's top, in the
		// strip's device rows, minus the nearest painted rule.
		const lineTop = g.lineTops.length ? (g.lineTops[0]! - rowClip.y) * dsf : Number.NaN;
		const nearestBand = rowBands.length ? rowBands.reduce((a, b) => Math.abs(b.at - lineTop) < Math.abs(a.at - lineTop) ? b : a) : null;
		const ruleToFirstLine = nearestBand ? round(lineTop - nearestBand.at, 3) : Number.NaN;
		const reading: Reading = {
			arm: `dsf${dsf}@${zoom}/${fontPx}px${v.name ? ` ${v.name}` : ""}`, variant: v.name, paper: v.paper ?? "grid",
			scrollHeight: g.scrollHeight, scrollWidth: g.scrollWidth, clientHeight: g.clientHeight, clientWidth: g.clientWidth,
			dsf, zoom, fontPx, zoomSeen: round(g.zoom, 6),
			pitchLayout: g.pitch, ruleLayout: g.rule, k: round(g.k, 6), pitchDevice: round(pitchDevice, 4), ruleDevice: round(ruleDevice, 4),
			pitchDeviceWhole: Math.abs(pitchDevice - Math.round(pitchDevice)) <= 1e-3,
			phase: g.phase, phaseX: g.phaseX, phaseDevice: round(g.phase * g.k * dsf, 4), phaseXDevice: round(g.phaseX * g.k * dsf, 4),
			// The E2 arms overwrite the rule themselves, so only the properties this arm did not set are compared.
			textHidingMovedThePlan: before.pitch !== g.pitch || (!v.ruleDevicePx && before.rule !== g.rule) || before.phase !== g.phase || before.phaseX !== g.phaseX,
			driftMax, driftSpan, driftFirst: drifts[0] ?? Number.NaN, driftLast: drifts[drifts.length - 1] ?? Number.NaN, ruleToFirstLine, scrollTop: g.scrollTop,
			periodsRows: round(rowsHigh * dsf / periodDevice, 1), periodsCols: round(colsWide * dsf / periodDevice, 1),
			rows: summary(rowBands, periodDevice), rowsMid: summary(midBands, periodDevice), cols: summary(colBands, periodDevice),
			sameRowsBothStrips: rowBands.length === midBands.length && rowBands.every((b, i) => Math.abs(b.at - midBands[i]!.at) <= 1),
			rowBands: rowBands.slice(0, 24), colBands: colBands.slice(0, 24),
			...(RAW ? { rawRows: rowProf.map(v => round(v, 2)), rawCols: colProf.map(v => round(v, 2)) } : {}),
		};
		readings.push(reading);
		// eslint-disable-next-line no-console
		console.log(`PAPER-GRID ${reading.arm}`, JSON.stringify(reading));
		return reading;
	} finally {
		await ctx.close();
	}
}

/** The premises a reading has to meet before its numbers mean anything. */
function premises(r: Reading): void {
	expect(r.zoomSeen, `premise: the arm is at zoom ${r.zoom} (${r.arm})`).toBeCloseTo(r.zoom, 4);
	expect(r.pitchLayout, `premise: the pitch follows the text size (${r.arm})`).toBeCloseTo((28 * r.fontPx) / 16, 2);
	expect(r.textHidingMovedThePlan, `premise: hiding the text left the paper plan alone (${r.arm})`).toBe(false);
	// A count under eight is a RESULT on the arms that set out to break the axis, not a broken instrument: the E1 and E7
	// long arms are named by how little they paint. Everywhere else, too few rules means the reader missed them.
	// The shipped grid's own arms are the ones under investigation: too few rules there is the defect, not the reader.
	const breaking = /E1-verylong|E7-reversed|F2-shipped|G1[ab]-verylong/.test(r.variant);
	if (r.variant === "E6-v-only") expect(r.rows.count, `premise: a vertical-only layer paints no horizontal rule (${r.arm})`).toBe(0);
	else if (!breaking) expect(r.rows.count, `premise: horizontal rules were found (${r.arm}) ${JSON.stringify(r.rows)}`).toBeGreaterThanOrEqual(8);
	else expect(r.rows.count, `premise: the arm painted something to read (${r.arm}) ${JSON.stringify(r.rows)}`).toBeGreaterThanOrEqual(1);
	if (r.paper !== "lines" && r.variant !== "E6-h-only" && !breaking) expect(r.cols.count, `premise: vertical rules were found (${r.arm}) ${JSON.stringify(r.cols)}`).toBeGreaterThanOrEqual(8);
	else if (r.paper === "lines" || r.variant === "E6-h-only") expect(r.cols.count, `premise: one horizontal layer paints no vertical rule (${r.arm}) ${JSON.stringify(r.cols)}`).toBe(0);
	// Twenty periods where the rect holds them. At 100 percent it holds seventeen, and that is the arm, not a fault.
	expect(r.periodsRows, `premise: enough periods down the strip to read (${r.arm})`).toBeGreaterThanOrEqual(r.zoom === 1 ? 12 : 20);
	// A rule is one or two device px. A band several px wide is furniture the hiding missed, and every number on that
	// axis would be reading it instead of the paper.
	if (r.paper === "dots") {
		// Dots are one mark per cell with a soft edge, several device px across by design. Nothing here is a rule.
		expect(r.rows.count, `premise: the dots arm painted marks to read (${r.arm}) ${JSON.stringify(r.rows)}`).toBeGreaterThanOrEqual(8);
	} else if (!breaking) {
		expect(Math.max(...r.rows.widths, ...r.cols.widths), `premise: no band wider than 6 device px, so the strips hold paper only (${r.arm}) rows ${JSON.stringify(r.rows.widths)} cols ${JSON.stringify(r.cols.widths)}`).toBeLessThanOrEqual(6);
	} else {
		// These arms are the ones under investigation, and a wide soft band is their finding rather than a fault. The
		// guard that stays is "it is paper, not furniture": a chip or a strip is wide AND at full contrast.
		for (const axis of [r.rows, r.cols]) {
			if (!axis.count || !axis.widths.length) continue;
			if (Math.max(...axis.widths) > 6) {
				expect(axis.peakMax, `premise: a wide band is a softened rule, not a solid box (${r.arm}) ${JSON.stringify(axis)}`).toBeLessThan(1);
			}
		}
	}
	expect(r.periodsRows, `premise: enough periods down the strip to read (${r.arm})`).toBeGreaterThanOrEqual(r.zoom === 1 ? 12 : 20);
	// A rule is one or two device px. A band several px wide is furniture the hiding missed, and every number on that
	// axis would be reading it instead of the paper.
	if (r.paper === "dots") {
		// Dots are one mark per cell with a soft edge, several device px across by design. Nothing here is a rule.
		expect(r.rows.count, `premise: the dots arm painted marks to read (${r.arm}) ${JSON.stringify(r.rows)}`).toBeGreaterThanOrEqual(8);
	} else if (!breaking) {
		expect(Math.max(...r.rows.widths, ...r.cols.widths), `premise: no band wider than 6 device px, so the strips hold paper only (${r.arm}) rows ${JSON.stringify(r.rows.widths)} cols ${JSON.stringify(r.cols.widths)}`).toBeLessThanOrEqual(6);
	} else {
		// These arms are the ones under investigation: a wide soft band, or almost nothing painted, is their finding
		// rather than a fault. The guard that stays is "what IS painted is paper, not furniture" - a chip or a strip
		// is wide AND at full contrast, while a smeared rule loses contrast as it spreads. Per axis, because these
		// arms break one axis and leave the other one perfect.
		for (const axis of [r.rows, r.cols]) {
			if (!axis.count || !axis.widths.length) continue;
			if (Math.max(...axis.widths) > 6) {
				expect(axis.peakMax, `premise: a wide band is a softened rule, not a solid box (${r.arm}) ${JSON.stringify(axis)}`).toBeLessThan(1);
			}
		}
	}
}

it.each(FONTS.map(f => [f] as const))(`PRIORITY ARM, Orion: grid at DSF ${PRIORITY.dsf}, zoom ${PRIORITY.zoom}, text %s px`, async fontPx => {
	const r = await readArm(PRIORITY.dsf, PRIORITY.zoom, fontPx);
	premises(r);
}, 240_000);

const SWEEP = DSFS.flatMap(dsf => ZOOMS.flatMap(zoom => [16, 20].map(fontPx => [dsf, zoom, fontPx] as const)))
	.filter(([dsf, zoom, fontPx]) => !(dsf === PRIORITY.dsf && zoom === PRIORITY.zoom && (fontPx === 16 || fontPx === 20)));

it.each(SWEEP)("grid at DSF %s, zoom %s, text %s px", async (dsf, zoom, fontPx) => {
	const r = await readArm(dsf, zoom, fontPx);
	premises(r);
}, 240_000);

/**
 * E1 TO E5. The pitch read is withdrawn; these arms ask what else could select a bad one. All at the
 * priority arm - dpr 2, zoom 0.518, 18 px text - unless the line says otherwise, and all measure only.
 *
 * E1 asks whether the bad axis follows the gradient's LENGTH: the same arm with a short scrolled area, the current
 * long one, a very long one, and one made wide as well as tall (Alan's note has Infinite Canvas on, where the scroller
 * is both).
 * E2 takes the plan's thickness out of it: the rule forced to exactly one device px, then two.
 * E3 takes the custom properties out of it: the same stops written as literal px on the element.
 * E4 asks whether one gradient layer behaves as two do: lined paper against the grid.
 * E5 is the text size the Paladin copy of vault test 2 is set to.
 */
const E_ARMS: { label: string; fontPx?: number; v: Variant }[] = [
	{ label: "E0 default (long)", v: { name: "" } },
	{ label: "E1 short scroll", v: { name: "E1-short", kind: "point" } },
	{ label: "E1 very long scroll", v: { name: "E1-verylong", kind: "former-far" } },
	{ label: "E1 wide and tall", v: { name: "E1-wide", wide: 6000 } },
	{ label: "E2 rule exactly 1 device px", v: { name: "E2-rule1", ruleDevicePx: 1 } },
	{ label: "E2 rule exactly 2 device px", v: { name: "E2-rule2", ruleDevicePx: 2 } },
	{ label: "E3 literal px stops", v: { name: "E3-literal", literalStops: true } },
	{ label: "E4 lined paper alone", v: { name: "E4-lines", paper: "lines" } },
	{ label: "E5 text 10 px", fontPx: 10, v: { name: "E5-10px" } },
	{ label: "E6 lined paper, very long scroll", v: { name: "E6-lines-verylong", paper: "lines", kind: "former-far" } },
	{ label: "E6 one literal layer, horizontal only", v: { name: "E6-h-only", literalStops: true, onlyLayer: "h" } },
	{ label: "E6 one literal layer, vertical only", v: { name: "E6-v-only", literalStops: true, onlyLayer: "v" } },
	{ label: "E7 two literal layers, vertical painted first", v: { name: "E7-reversed", literalStops: true, reverseLayers: true } },
	{ label: "E7 two literal layers, vertical first, very long scroll", v: { name: "E7-reversed-verylong", literalStops: true, reverseLayers: true, kind: "former-far" } },
];

it.each(E_ARMS.map(a => [a.label, a] as const))("E-ARM %s", async (_label, a) => {
	const r = await readArm(PRIORITY.dsf, PRIORITY.zoom, a.fontPx ?? 18, a.v);
	premises(r);
}, 240_000);

/**
 * F1 TO F6. The direction under test: the grid as ONE layer - a pitch-square conic tile carrying its
 * phase in the tile position, exactly as the dots do - against the shipped two-layer grid and against the shipped
 * dots, which are the control for tiles. CSS override on the element only; src is untouched.
 */
/** A note with line boxes all the way down, so the paper can be compared to the text rather than to one stub line. */
const LONG_DOC = Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join(String.fromCharCode(10));

/** The ruling's arms, run against G1(a), G1(b) and G2. */
const G_SHAPES: { key: string; v: Variant }[] = [
	{ key: "G1a", v: { name: "G1a", sacrificial: "plain" } },
	{ key: "G1b", v: { name: "G1b", sacrificial: "stops" } },
	{ key: "G2", v: { name: "G2", twoBoxes: true } },
];
const G_ARMS = G_SHAPES.flatMap(({ key, v }) => [
	{ label: `${key} 18 px`, v: { ...v, name: `${key}-18` } as Variant, fontPx: 18, dsf: 2, zoom: 0.518 },
	{ label: `${key} 10 px`, v: { ...v, name: `${key}-10` } as Variant, fontPx: 10, dsf: 2, zoom: 0.518 },
	{ label: `${key} very long area`, v: { ...v, name: `${key}-verylong`, kind: "former-far" } as Variant, fontPx: 18, dsf: 2, zoom: 0.518 },
	{ label: `${key} 100 percent, dpr 1`, v: { ...v, name: `${key}-100-dpr1` } as Variant, fontPx: 18, dsf: 1, zoom: 1 },
	{ label: `${key} 100 percent, dpr 2`, v: { ...v, name: `${key}-100-dpr2` } as Variant, fontPx: 18, dsf: 2, zoom: 1 },
]);

it.each(G_ARMS.map(a => [a.label, a] as const))("G-ARM %s", async (_label, a) => {
	const r = await readArm(a.dsf, a.zoom, a.fontPx, a.v);
	premises(r);
}, 240_000);

const F_ARMS: { label: string; dsf?: number; zoom?: number; fontPx?: number; v: Variant }[] = [
	{ label: "F1 tile, 18 px", v: { name: "F1-tile-18", tile: true } },
	{ label: "F1 tile, 16 px", fontPx: 16, v: { name: "F1-tile-16", tile: true } },
	{ label: "F1 tile, 10 px", fontPx: 10, v: { name: "F1-tile-10", tile: true } },
	{ label: "F2 tile, very long area, at the top", v: { name: "F2-tile-verylong-top", tile: true, kind: "former-far", doc: LONG_DOC } },
	{ label: "F2 tile, very long area, at the far end", v: { name: "F2-tile-verylong-bottom", tile: true, kind: "former-far", atBottom: true, doc: LONG_DOC } },
	{ label: "F2 shipped grid, very long area, at the far end", v: { name: "F2-shipped-verylong-bottom", kind: "former-far", atBottom: true, doc: LONG_DOC } },
	{ label: "F2 tile, long note, at the top", v: { name: "F2-tile-doc-top", tile: true, doc: LONG_DOC } },
	{ label: "F2 tile, long note, at the last line", v: { name: "F2-tile-doc-end", tile: true, doc: LONG_DOC, atTextEnd: true } },
	{ label: "F2 shipped grid, long note, at the last line", v: { name: "F2-shipped-doc-end", doc: LONG_DOC, atTextEnd: true } },
	{ label: "F2 shipped grid, long note, at the top", v: { name: "F2-shipped-doc-top", doc: LONG_DOC } },
	{ label: "F2 lined alone, long note, at the top", v: { name: "F2-lines-doc-top", paper: "lines", doc: LONG_DOC } },
	{ label: "F2 lined alone, long note, at the last line", v: { name: "F2-lines-doc-end", paper: "lines", doc: LONG_DOC, atTextEnd: true } },
	{ label: "F3 tile, wide and tall", v: { name: "F3-tile-wide", tile: true, wide: 6000 } },
	{ label: "F4 dots as shipped, 18 px", v: { name: "F4-dots-18", paper: "dots" } },
	{ label: "F4 dots as shipped, very long area", v: { name: "F4-dots-verylong", paper: "dots", kind: "former-far" } },
	{ label: "F4 dots as shipped, wide and tall", v: { name: "F4-dots-wide", paper: "dots", wide: 6000 } },
	{ label: "F5 tile at 100 percent, dpr 1", dsf: 1, zoom: 1, v: { name: "F5-tile-100-dpr1", tile: true } },
	{ label: "F5 shipped grid at 100 percent, dpr 1", dsf: 1, zoom: 1, v: { name: "F5-shipped-100-dpr1" } },
	{ label: "F5 tile at 100 percent, dpr 2", dsf: 2, zoom: 1, v: { name: "F5-tile-100-dpr2", tile: true } },
	{ label: "F5 shipped grid at 100 percent, dpr 2", dsf: 2, zoom: 1, v: { name: "F5-shipped-100-dpr2" } },
	{ label: "F6 lined alone, 10 px", fontPx: 10, v: { name: "F6-lines-10", paper: "lines" } },
];

it.each(F_ARMS.map(a => [a.label, a] as const))("F-ARM %s", async (_label, a) => {
	const r = await readArm(a.dsf ?? PRIORITY.dsf, a.zoom ?? PRIORITY.zoom, a.fontPx ?? 18, a.v);
	premises(r);
}, 240_000);

/**
 * G3 TO G5. G3 asks whether the KIND of the second layer matters or only that a second layer paints; G4 paints
 * the pinch preview's shape - one box the size of the pane plus a pitch of margin, not locally attached - to say
 * whether that path needs changing at all; G5 walks the scrolled area's size to find the edge where the shipped grid
 * starts losing rules.
 */
const G345_ARMS: { label: string; dsf: number; zoom: number; fontPx: number; v: Variant }[] = [
	{ label: "G3 horizontal repeats, vertical tiled, 18 px", dsf: 2, zoom: 0.518, fontPx: 18, v: { name: "G3-hrep-18", mixed: "h-repeats" } },
	{ label: "G3 horizontal repeats, vertical tiled, 10 px", dsf: 2, zoom: 0.518, fontPx: 10, v: { name: "G3-hrep-10", mixed: "h-repeats" } },
	{ label: "G3 horizontal repeats, vertical tiled, 100 percent dpr 1", dsf: 1, zoom: 1, fontPx: 18, v: { name: "G3-hrep-100-dpr1", mixed: "h-repeats" } },
	{ label: "G3 vertical repeats, horizontal tiled, 18 px", dsf: 2, zoom: 0.518, fontPx: 18, v: { name: "G3-vrep-18", mixed: "v-repeats" } },
	{ label: "G3 vertical repeats, horizontal tiled, 10 px", dsf: 2, zoom: 0.518, fontPx: 10, v: { name: "G3-vrep-10", mixed: "v-repeats" } },
	{ label: "G3 vertical repeats, horizontal tiled, 100 percent dpr 1", dsf: 1, zoom: 1, fontPx: 18, v: { name: "G3-vrep-100-dpr1", mixed: "v-repeats" } },
	{ label: "G4 preview-shaped box, 18 px", dsf: 2, zoom: 0.518, fontPx: 18, v: { name: "G4-preview-18", previewBox: true } },
	{ label: "G4 preview-shaped box, 10 px", dsf: 2, zoom: 0.518, fontPx: 10, v: { name: "G4-preview-10", previewBox: true } },
	{ label: "G4 preview-shaped box, very long area", dsf: 2, zoom: 0.518, fontPx: 18, v: { name: "G4-preview-verylong", previewBox: true, kind: "former-far" } },
	{ label: "G5 area 2021 tall, 1729 wide", dsf: 2, zoom: 0.518, fontPx: 18, v: { name: "G5-h2021", kind: "point" } },
	{ label: "G5 area 2500 tall, 1729 wide", dsf: 2, zoom: 0.518, fontPx: 18, v: { name: "G5-h2500", kind: "point", tall: 2500 } },
	{ label: "G5 area 3000 tall, 1729 wide", dsf: 2, zoom: 0.518, fontPx: 18, v: { name: "G5-h3000", kind: "point", tall: 3000 } },
	{ label: "G5 area 3500 tall, 1729 wide", dsf: 2, zoom: 0.518, fontPx: 18, v: { name: "G5-h3500", kind: "point", tall: 3500 } },
	{ label: "G5 area 2021 tall, 3457 wide", dsf: 2, zoom: 0.518, fontPx: 18, v: { name: "G5-h2021-w3457", kind: "point", wide: 3457 } },
	{ label: "G5 area 3500 tall, 3457 wide", dsf: 2, zoom: 0.518, fontPx: 18, v: { name: "G5-h3500-w3457", kind: "point", tall: 3500, wide: 3457 } },
];

it.each(G345_ARMS.map(a => [a.label, a] as const))("H-ARM %s", async (_label, a) => {
	const r = await readArm(a.dsf, a.zoom, a.fontPx, a.v);
	premises(r);
}, 240_000);

/**
 * THE GATE. Everything above measures; this asserts, on the SHIPPED stylesheet with no override on the element.
 * One cell per arm, each reading both axes of the paper the plugin actually paints.
 *
 * THE THREE NUMBERS, and why these and not a pixel-for-pixel compare: a rule that is missing, a rule that is fainter
 * than its neighbours, and a rule smeared over several device rows are the three ways Alan's screenshot is wrong
 * (Alan's Orion screenshot alan-orion-grid-50pct.png). `absent` counts rules the reader found a two-period
 * gap in place of; `spreadPct` is the peak contrast range across the rules of one axis; `widths` is how many device
 * rows each band covers. A grid that paints every rule, each one crisp and all of them alike, passes all three at any
 * zoom a pinch can leave.
 *
 * THE ARMS. The priority arm is Orion's own: 2880x1920 at Windows 200 percent (DSF 2) and the screenshot's 51.8
 * percent, at three text sizes, because the pitch follows the text and 10 px text packs the rules tightest. The very
 * long and wide arms are the area the measurement found the defect scales with (2021 x 1729 clean,
 * 4613 x 1729 loses five rules). The fixture mounts with the Infinite Canvas ON, so the wide arm is the canvas case.
 * The two 100 percent arms are the promise that the fix changes nothing where nothing was wrong.
 *
 * RED at 67e864bf on the 18 px, 10 px and very long arms; green at the fix.
 */
const GATE_ARMS: { label: string; dsf: number; zoom: number; fontPx: number; v: Variant }[] = [
	{ label: "priority arm, 18 px text", dsf: 2, zoom: 0.518, fontPx: 18, v: { name: "GATE-18" } },
	{ label: "priority arm, 16 px text", dsf: 2, zoom: 0.518, fontPx: 16, v: { name: "GATE-16" } },
	{ label: "priority arm, 10 px text", dsf: 2, zoom: 0.518, fontPx: 10, v: { name: "GATE-10" } },
	{ label: "very long area", dsf: 2, zoom: 0.518, fontPx: 18, v: { name: "GATE-verylong", kind: "former-far" } },
	{ label: "wide area, canvas on", dsf: 2, zoom: 0.518, fontPx: 18, v: { name: "GATE-wide", wide: 6000 } },
	{ label: "100 percent, dpr 1", dsf: 1, zoom: 1, fontPx: 18, v: { name: "GATE-100-dpr1" } },
	{ label: "100 percent, dpr 2", dsf: 2, zoom: 1, fontPx: 18, v: { name: "GATE-100-dpr2" } },
];

/** One axis of one arm against the three numbers. Named per axis, so a failure says which one broke. */
function gateAxis(r: Reading, axis: "rows" | "cols"): void {
	const a = axis === "rows" ? r.rows : r.cols;
	const where = `${axis === "rows" ? "horizontal" : "vertical"} rules, ${r.arm}`;
	expect(a.count, `${where}: the strip holds rules to read ${JSON.stringify(a)}`).toBeGreaterThanOrEqual(8);
	expect(a.absent, `${where}: every rule of the grid is painted, none skipped ${JSON.stringify(a)}`).toBe(0);
	expect(a.spreadPct, `${where}: the rules are all as dark as each other, within 10 percent ${JSON.stringify(a)}`).toBeLessThanOrEqual(10);
	expect(Math.max(...a.widths), `${where}: each rule is one crisp line, 2 device px or less ${JSON.stringify(a)}`).toBeLessThanOrEqual(2);
}

it.each(GATE_ARMS.map(a => [a.label, a] as const))("GATE: grid paints every rule on both axes - %s", async (_label, a) => {
	const r = await readArm(a.dsf, a.zoom, a.fontPx, PLANT_BOTH_ON_SCROLLER ? { ...a.v, plantBothOnScroller: true } : a.v);
	expect(r.zoomSeen, `premise: the arm is at zoom ${r.zoom} (${r.arm})`).toBeCloseTo(r.zoom, 4);
	expect(r.textHidingMovedThePlan, `premise: hiding the text left the paper plan alone (${r.arm})`).toBe(false);
	gateAxis(r, "rows");
	gateAxis(r, "cols");
}, 240_000);
