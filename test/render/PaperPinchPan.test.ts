/**
 * The paper rides the pinch's focal pan, as the text and the ink do.
 *
 * A pinch holds the note under the fingers with a translate on the scroller's
 * children (`.cm-sizer` for the text, the ink layer for the ink), never on the
 * scroller: moving the scroller takes the pen's hit surface off the pane. The
 * lined, grid and dotted paper is the scroller's OWN local background, which a
 * transform on a child does not move. So while the fingers are down the text
 * and ink slide over a paper that stays put, and the two line up again only
 * when the settle spends the pan into native scroll: on the device, the rules
 * visibly moved behind the letters for as long as the fingers were down.
 *
 * The invariant read here is the one the AT REST cell in PaperZoomHost reads,
 * taken on more frames: a rule's bottom edge sits on the note origin modulo the
 * pitch. The origin is the first `.cm-line`'s top on screen, which includes the
 * pan; the rules are read from real compositor pixels (DSF 2 via the launch
 * flag, see PaperZoomHost's header), in device rows, never collapsed.
 *
 * Tolerance: 2 device rows. Premise for every preview reading: the pan, in
 * device rows, sits at least 4 rows away from a whole pitch, so a pan-less paper
 * cannot pass by landing on the next rule.
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import { decodePng } from "./pngInk";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";
import { MAX_PINCH_SCALE } from "../../src/inline/PinchScale";

let realBrowser: Browser, script: string;
const OBSIDIAN_CAMERA_CSS = readFileSync(fileURLToPath(new URL("./noteViewportCamera.css", import.meta.url)), "utf8");
const DSF = 2, PITCH = 28, TOL_DEV = 2, PAN_CLEAR_DEV = 4;
/** On a preview frame the paper is the preview element, whose rules land on whole device px: half a device px more. */
const TOL_PREVIEW_DEV = TOL_DEV + 0.5;
const PAGE_GREY = 255, RULE_GREY = 0x77;

declare const process: { env: Record<string, string | undefined> };

/**
 * Plants, each built into the page by an exact source substitution in the named file, the count applied asserted:
 *   HW_PAPER_PAN_PLANT_OLD_ORIGIN=1  the paper's origin reads CodeMirror's documentTop again (the empty-note settles go red);
 *   HW_PAPER_PAN_PLANT_NO_PAN=1      the pan writer never hands the pan to the paper (every live reading goes red);
 *   HW_PAPER_PAN_PLANT_NO_WRAP=1     the pan properties are written unfolded (the fold assertions go red; the painted paper does not change, a repeating pattern wraps both ways);
 *   HW_PAPER_PAN_PLANT_NO_DRIFT=1    the paper never takes the column's re-centring (the zoom-in readable-width arms go red);
 *   HW_PAPER_PAN_PLANT_SNAP_TWICE=1  the snap's residual is applied a second time at rest (the off-grid lift jump goes red).
 * A plant whose anchor is not in the source throws rather than passing unplanted.
 */
const PLANTS: { env: string; file: RegExp; from: string; to: string }[] = [
	{ env: "HW_PAPER_PAN_PLANT_OLD_ORIGIN", file: /src[\\/]inline[\\/]InkOverlay\.ts$/, from: "return anchorTop(this.view, this.contentStyle?.paddingTop, this.cssScale) - this.panY();", to: "return this.view.documentTop - this.panY();" },
	{ env: "HW_PAPER_PAN_PLANT_NO_PAN", file: /src[\\/]inline[\\/]InkOverlay\.ts$/, from: "\t\tthis.writePaperPan();\n\t\tthis.writeInkLayerTransform();\n", to: "\t\tthis.writeInkLayerTransform();\n" },
	{ env: "HW_PAPER_PAN_PLANT_NO_WRAP", file: /src[\\/]inline[\\/]PaperPan\.ts$/, from: "\tif (!Number.isFinite(pitch) || pitch <= 0) return Math.round(v * 64) / 64;", to: "\treturn Math.round(v * 64) / 64;" },
	{ env: "HW_PAPER_PAN_PLANT_NO_DRIFT", file: /src[\\/]inline[\\/]InkOverlay\.ts$/, from: "const drift = columnLocal === null || a.columnLocal === null ? 0 : (columnLocal - a.columnLocal) * next;", to: "const drift = 0;" },
	{ env: "HW_PAPER_PAN_PLANT_SNAP_TWICE", file: /src[\\/]inline[\\/]InkOverlay\.ts$/, from: "\t\tconst carry = this.pinchPreview ? this.paperSnapResidual : null;\n", to: "\t\tconst carry = this.pinchPreview ? this.paperSnapResidual : { x: -this.paperSnapResidual.x, y: -this.paperSnapResidual.y };\n" },
];

beforeAll(async () => {
	const active = PLANTS.filter(pl => process.env[pl.env]);
	let planted = 0;
	const b = await build({
		entryPoints: [fileURLToPath(new URL("./noteViewportCameraPage.ts", import.meta.url))],
		bundle: true, write: false, format: "iife", platform: "browser",
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
		plugins: active.length ? [{ name: "paper-pan-plants", setup(builder) {
			builder.onLoad({ filter: /src[\\/]inline[\\/](InkOverlay|PaperPan)\.ts$/ }, args => {
				let text = readFileSync(args.path, "utf8").replace(/\r\n/g, "\n");
				for (const pl of active.filter(x => x.file.test(args.path))) {
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
	realBrowser = await chromium.launch({ headless: true, args: [`--force-device-scale-factor=${DSF}`, "--window-size=900,700"] });
}, 180_000);

afterAll(async () => { await realBrowser?.close(); });

async function realPage(): Promise<Page> {
	const ctx = await realBrowser.newContext({ viewport: null });
	return ctx.newPage();
}

/**
 * One glyph, scrolled far out of every pixel read, one far ink stroke, white page and a mid-grey rule. The pan lands on
 * `.cm-sizer`, which Obsidian wraps around CodeMirror's content and bare CodeMirror does not create, so it is
 * installed the way ZoomOutStandingPan installs it: without it the text would never take the pan here at all.
 */
async function mountPaper(p: Page, kind: "lines" | "grid" | "dots" = "lines", doc = "x", readable = false, ink = "far", note: "lines" | "grid" | "dots" | "" = "") {
	await p.setContent(`<!doctype html><body class="handwriting-paper-${kind}" style="margin:0; background:#ffffff; --background-modifier-border:#777777"></body>`);
	await p.addStyleTag({ content: pageCss() + OBSIDIAN_CAMERA_CSS });
	if (readable) {
		// Obsidian's readable-width rules (verbatim, obsidianReadableWidth.ts) with a 320 px line width, so the 640 px editor
		// shows a centred column that re-centres under a zoom-in. The classes go on the fixture's host as it is inserted.
		await p.addStyleTag({ content: `${REAL_OBSIDIAN_CSS}\nbody { --file-line-width: 320px; }` });
		await p.evaluate(() => {
			new MutationObserver(recs => { for (const r of recs) r.addedNodes.forEach(n => { if (n instanceof HTMLElement && n.classList.contains("camera-proof")) n.classList.add("mod-cm6", "is-readable-line-width"); }); })
				.observe(document.body, { childList: true });
		});
	}
	await p.addScriptTag({ content: script });
	await p.evaluate(async ({ doc, ink }) => {
		// One glyph, not an empty doc: the pan holds x only with a text column to measure (an empty line has none), and at
		// scrollTop 1200 the glyph is far above every pixel read.
		await (window as any).viewportFixture.setup("paper", ink, 1, 1, doc);
		const content = document.querySelector(".cm-content") as HTMLElement;
		const sizer = document.createElement("div"); sizer.className = "cm-sizer";
		const container = document.createElement("div"); container.className = "cm-contentContainer";
		content.parentElement!.insertBefore(sizer, content); sizer.appendChild(container); container.appendChild(content);
		await (window as any).viewportFixture.settle();
	}, { doc, ink });
	// A note's own paper setting sits on an ancestor of the view: the rig's host is wrapped in one.
	if (note) await p.evaluate(async note => {
		const host = document.querySelector('[data-rig="paper"]')!;
		const wrap = document.createElement("div"); wrap.dataset.handwritingPaper = note;
		host.before(wrap); wrap.appendChild(host);
		await (window as any).viewportFixture.settle();
	}, note);
}

/** Average grey per DEVICE row of a narrow strip, from a real screenshot. */
async function deviceRowGreys(p: Page, clip: { x: number; y: number; width: number; height: number }): Promise<number[]> {
	const d = decodePng(await p.screenshot({ clip }));
	const rows: number[] = [];
	for (let row = 0; row < d.height; row++) {
		let sum = 0;
		for (let col = 0; col < d.width; col++) {
			const i = (row * d.width + col) * d.channels;
			sum += (d.px[i]! + d.px[i + 1]! + d.px[i + 2]!) / 3;
		}
		rows.push(sum / d.width);
	}
	return rows;
}

/** Rule bands in device rows: runs whose rule fraction exceeds one half; `end` is the band's bottom edge. */
function ruleEnds(greys: number[]): number[] {
	const frac = greys.map(g => Math.max(0, Math.min(1, (PAGE_GREY - g) / (PAGE_GREY - RULE_GREY))));
	const ends: number[] = [];
	for (let i = 0; i < frac.length; i++) {
		if (frac[i]! <= 0.5) continue;
		let j = i;
		while (j + 1 < frac.length && frac[j + 1]! > 0.5) j++;
		ends.push(j + 1);
		i = j;
	}
	return ends;
}

const circ = (a: number, p: number) => { const r = ((a % p) + p) % p; return Math.min(r, p - r); };

type Geo = { scrollerTop: number; scrollerLeft: number; scrollerHeight: number; lineTop: number; zoom: number; sizer: string; scrollTop: number; scrollLeft: number; vars: string; hostZoom: string; padTop: number; preview: boolean };

const readGeo = (p: Page): Promise<Geo> => p.evaluate(() => {
	const sc = document.querySelector(".cm-scroller") as HTMLElement, line = document.querySelector(".cm-line") as HTMLElement;
	const sizer = document.querySelector(".cm-sizer") as HTMLElement;
	const r = sc.getBoundingClientRect();
	return { scrollerTop: r.top, scrollerLeft: r.left, scrollerHeight: r.height, lineTop: line.getBoundingClientRect().top,
		zoom: (window as any).viewportFixture.snap("paper").state.zoom, sizer: sizer.style.transform, scrollTop: sc.scrollTop, scrollLeft: sc.scrollLeft,
		vars: ["--handwriting-paper-pitch", "--handwriting-paper-rule", "--handwriting-paper-phase"].map(k => getComputedStyle(sc).getPropertyValue(k).trim()).join("|"),
		hostZoom: getComputedStyle(document.querySelector(".cm-editor") as HTMLElement).zoom, padTop: Number.parseFloat(getComputedStyle(document.querySelector(".cm-content") as HTMLElement).paddingTop),
		preview: (window as any).viewportFixture.preview("paper") as boolean };
});

type PreviewPaperState = { present: boolean; all: number; previewing: boolean; tx: number; ty: number; marginX: number; marginY: number; pitch: number; panX: number; panY: number };
const previewPaper = (p: Page): Promise<PreviewPaperState> => p.evaluate(() => (window as any).viewportFixture.previewPaper("paper"));

/**
 * THE FOLD on a live frame: the preview element carries the pan as a translate, folded into one pitch and put on whole
 * device px, so it lies in [-1 device px, margin]; and a live frame has exactly one element, with the scroller's paper off.
 */
async function expectFoldedPreview(p: Page, axis: "x" | "y", zoom: number) {
	const e = await previewPaper(p);
	expect(e.present && e.all === 1 && e.previewing, `premise: the live frame's paper is the one preview element ${JSON.stringify(e)}`).toBe(true);
	const t = axis === "x" ? e.tx : e.ty, margin = axis === "x" ? e.marginX : e.marginY, dev = 1 / (zoom * DSF);
	expect(t >= -dev - 1e-9 && t <= margin + 1e-9, `THE FOLD: the preview paper's ${axis} translate lies in [-1 device px, margin]: ${t} (margin ${margin}, pitch ${e.pitch})`).toBe(true);
}

/** The sizer's translate in layout px, 0 when there is none. */
const panY = (sizer: string) => { const m = /translate\(\s*(-?[\d.e+-]+)px\s*,\s*(-?[\d.e+-]+)px\s*\)/.exec(sizer); return m ? Number(m[2]) : 0; };

/** One reading: where the rules' bottom edges sit against the note origin, in device rows. */
async function readLines(p: Page, label: string) {
	const before = await readGeo(p);
	const clip = { x: Math.round(before.scrollerLeft + 4), y: Math.round(before.scrollerTop), width: 8, height: Math.min(420, Math.max(80, Math.floor(before.scrollerHeight - 10))) };
	const pDev = PITCH * before.zoom * DSF;
	// Only bands on the pitch lattice count: a band with another band one pitch away.
	const allEnds = ruleEnds(await deviceRowGreys(p, clip));
	const ends = allEnds.filter(e => allEnds.some(f => f !== e && Math.abs(Math.abs(f - e) - pDev) <= 2));
	const after = await readGeo(p);
	const originDev = (before.lineTop - clip.y) * DSF;
	const gaps = ends.slice(1).map((e, i) => e - ends[i]!);
	const measuredPitch = gaps.length ? gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)]! : Number.NaN;
	const offs = ends.map(e => circ(e - originDev, pDev));
	const panDev = panY(before.sizer) * before.zoom * DSF;
	return { label, geo: before, stable: JSON.stringify(before) === JSON.stringify(after), pDev, measuredPitch, originDev, ends: ends.slice(0, 6), off: offs.length ? Math.max(...offs.slice(0, 6)) : Number.NaN, panDev, panOffPitch: circ(panDev, pDev) };
}

/**
 * Two touch pointers pinching about (cx, cy) from spread `spread0` to `spread0` x ratio, one
 * animation frame per step. `spread0` defaults to 300 (every caller before MAXZOOM-6 got exactly
 * that): a 6x zoom-IN target from a 300 px starting spread needs an 1800 px spread at the peak,
 * which walks both touch points off a 900 px window - passing a smaller starting spread keeps the
 * whole gesture on-screen while reaching the same ratio (and so the same zoom).
 */
async function pinchTo(p: Page, ratio: number, cx: number, cy: number, steps = 24, spread0 = 300) {
	await p.evaluate(async ({ ratio, cx, cy, steps, spread0 }) => {
		const send = (type: string, pid: number, x: number, y: number) => {
			const target = document.elementFromPoint(x, y);
			if (!target) throw new Error(`pinch point (${x},${y}) outside the page`);
			target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "touch", pointerId: pid, isPrimary: pid === 701, clientX: x, clientY: y, buttons: type === "pointerup" ? 0 : 1, width: 8, height: 8 }));
		};
		const raf = () => new Promise<void>(r => requestAnimationFrame(() => r()));
		const spread = (i: number) => spread0 * ratio ** (i / (steps - 1));
		send("pointerdown", 701, cx - spread(0) / 2, cy);
		send("pointerdown", 702, cx + spread(0) / 2, cy);
		await raf();
		for (let i = 1; i < steps; i++) {
			send("pointermove", 701, cx - spread(i) / 2, cy);
			send("pointermove", 702, cx + spread(i) / 2, cy);
			await raf();
		}
		(window as any).__pinchEnd = { x1: cx - spread(steps - 1) / 2, x2: cx + spread(steps - 1) / 2, y: cy, send };
	}, { ratio, cx, cy, steps, spread0 });
}

async function release(p: Page) {
	await p.evaluate(async () => {
		const e = (window as any).__pinchEnd;
		e.send("pointerup", 701, e.x1, e.y);
		e.send("pointerup", 702, e.x2, e.y);
		await (window as any).viewportFixture.settle();
	});
}

/**
 * LINES, PREVIEW FRAME: 100 -> 60 percent about a focal point 230 px down the
 * pane, fingers still down. The text has moved by the focal pan; the rules must
 * have moved with it. Also read at rest before the gesture and once it settles.
 */
it("LINES: on a live pinch frame the rules keep their place under the text, and again once the pinch settles", async () => {
	const p = await realPage();
	try {
		await mountPaper(p, "lines");
		await p.evaluate(async () => {
			await (window as any).edgeAudit.commit("paper", 1);
			const sc = document.querySelector(".cm-scroller") as HTMLElement;
			sc.scrollTop = 1200;
			await (window as any).viewportFixture.settle();
		});
		const rest = await readLines(p, "at rest before the pinch");
		expect(rest.geo.zoom, "premise: at 100 percent").toBeCloseTo(1, 6);
		expect(rest.ends.length, `premise: rules found at rest ${JSON.stringify(rest)}`).toBeGreaterThanOrEqual(4);
		expect(rest.off, `control, at rest: rule bottom edges vs the note origin, device rows ${JSON.stringify(rest)}`).toBeLessThanOrEqual(TOL_DEV);

		await pinchTo(p, 0.6, 300, 230);
		const live = await readLines(p, "live pinch frame");
		expect(live.geo.preview, "frame identity: the pinch preview is still live for this reading").toBe(true);
		expect(live.stable, `premise: the preview did not move while it was read ${JSON.stringify(live)}`).toBe(true);
		await expectFoldedPreview(p, "y", live.geo.zoom);
		expect(live.geo.zoom, `premise: the preview reached 60 percent ${JSON.stringify(live.geo)}`).toBeCloseTo(0.6, 2);
		expect(Math.abs(live.measuredPitch - live.pDev), `premise: the rules read at 28 x z x dsf device rows ${JSON.stringify(live)}`).toBeLessThanOrEqual(1);
		expect(live.panOffPitch, `premise: the focal pan is not a whole number of pitches ${JSON.stringify(live)}`).toBeGreaterThanOrEqual(PAN_CLEAR_DEV);
		expect.soft(live.off, `LIVE PINCH: rule bottom edges vs the note origin, device rows (pan ${live.panDev.toFixed(1)} rows) ${JSON.stringify(live)}`).toBeLessThanOrEqual(TOL_PREVIEW_DEV);

		await release(p);
		const settled = await readLines(p, "after the settle");
		expect(settled.geo.preview, "frame identity: the preview has ended for the settled reading").toBe(false);
		expect.soft(settled.off, `SETTLED: rule bottom edges vs the note origin, device rows (standing pan ${settled.panDev.toFixed(1)} rows) ${JSON.stringify(settled)}`).toBeLessThanOrEqual(TOL_DEV);
		// eslint-disable-next-line no-console
		console.log("PAPER-PAN LINES", JSON.stringify({ rest, live, settled }));
	} finally {
		await p.close();
	}
});

/**
 * MAXZOOM-6 (Fleet 3 c3, candidate 5): the ceiling moved from 4 to 6 tonight (PinchScale.ts's
 * MAX_PINCH_SCALE) - this is the LINES invariant above, proven zooming IN to the new ceiling
 * instead of out to 60 percent, on the same focal point. The x-anchor (the paper riding the
 * pinch's focal pan the same way the text does) is the whole claim; nothing here scales the
 * tolerance or the pan-clearance premise, both of which are already in device rows, independent
 * of which direction or how far the pinch goes.
 */
it("LINES AT 600%: on a live pinch frame the rules keep their place under the text, and again once the pinch settles", async () => {
	// A literal target, not the imported constant: the gesture below asks for 600% on its own
	// terms, so a regression that left MAX_PINCH_SCALE itself at 4 (not only a stray call site)
	// still reddens the "reached the new ceiling" premise a few lines down, rather than the test
	// silently retargeting itself to whatever the constant currently says.
	expect(MAX_PINCH_SCALE, "premise: this pin targets the real ceiling").toBe(6);
	const p = await realPage();
	try {
		await mountPaper(p, "lines");
		await p.evaluate(async () => {
			await (window as any).edgeAudit.commit("paper", 1);
			const sc = document.querySelector(".cm-scroller") as HTMLElement;
			sc.scrollTop = 1200;
			await (window as any).viewportFixture.settle();
		});
		const rest = await readLines(p, "at rest before the pinch");
		expect(rest.geo.zoom, "premise: at 100 percent").toBeCloseTo(1, 6);
		expect(rest.ends.length, `premise: rules found at rest ${JSON.stringify(rest)}`).toBeGreaterThanOrEqual(4);
		expect(rest.off, `control, at rest: rule bottom edges vs the note origin, device rows ${JSON.stringify(rest)}`).toBeLessThanOrEqual(TOL_DEV);

		// A smaller starting spread (see pinchTo): 300 x 6 would walk both touch points off a
		// 900 px window; 60 keeps the whole gesture on-screen at the same ratio.
		await pinchTo(p, 6, 300, 230, 24, 60);
		const live = await readLines(p, "live pinch frame");
		expect(live.geo.preview, "frame identity: the pinch preview is still live for this reading").toBe(true);
		expect(live.stable, `premise: the preview did not move while it was read ${JSON.stringify(live)}`).toBe(true);
		// THE PLANT CATCHES HERE FIRST (leave the ceiling at 4 anywhere): the pinch settles at
		// 400%, not 600%, and this premise reddens on its own.
		expect(live.geo.zoom, `premise: the preview reached the new ceiling, not the old one ${JSON.stringify(live.geo)}`).toBeCloseTo(6, 2);
		expect(Math.abs(live.measuredPitch - live.pDev), `premise: the rules read at 28 x z x dsf device rows ${JSON.stringify(live)}`).toBeLessThanOrEqual(1);
		expect(live.panOffPitch, `premise: the focal pan is not a whole number of pitches ${JSON.stringify(live)}`).toBeGreaterThanOrEqual(PAN_CLEAR_DEV);
		expect.soft(live.off, `LIVE PINCH AT 600%: rule bottom edges vs the note origin, device rows (pan ${live.panDev.toFixed(1)} rows) ${JSON.stringify(live)}`).toBeLessThanOrEqual(TOL_DEV);

		await release(p);
		const settled = await readLines(p, "after the settle");
		expect(settled.geo.preview, "frame identity: the preview has ended for the settled reading").toBe(false);
		// A refused commit (e.g. a stray literal ceiling below 600%) would leave the scale short of
		// the target while the rule-vs-origin geometry stays self-consistent against whatever zoom
		// actually landed - so the commit's own target is pinned explicitly, not only the preview's.
		expect(settled.geo.zoom, "premise: the settle actually committed the new ceiling").toBeCloseTo(6, 2);
		expect.soft(settled.off, `SETTLED AT 600%: rule bottom edges vs the note origin, device rows (standing pan ${settled.panDev.toFixed(1)} rows) ${JSON.stringify(settled)}`).toBeLessThanOrEqual(TOL_DEV);
		// eslint-disable-next-line no-console
		console.log("PAPER-PAN LINES-600", JSON.stringify({ rest, live, settled }));
	} finally {
		await p.close();
	}
});

/**
 * THE SAME INVARIANT ON BOTH AXES, for grid and dots. A patch of the pane is
 * read in device pixels, projected onto rows (horizontal rules, dot rows) and
 * onto columns (vertical rules, dot columns), and each band's weighted centre is
 * one lattice position. What must hold on every frame is the lattice's place
 * relative to the text's own box, in layout px: (position - `.cm-sizer` edge) / k
 * modulo the pitch. The sizer's box carries the pan and the scroll exactly as the
 * text does, so this keeps its at-rest value on every frame when the paper rides
 * with the text, and moves by the pan when it does not. Compared against the
 * reading taken at rest before the gesture, converted to device px at the frame's
 * own zoom; tolerance 2 device px.
 */
type Axis = "x" | "y";
const AXES: readonly Axis[] = ["x", "y"];
const PATCH = { dx: 20, dy: 20, w: 200, h: 200 };
/** HW_PAPER_PAN_SHOTS=<path prefix>: every patch screenshot is also written there, numbered, for a look. */
let shotCount = 0;

/**
 * Weighted band centres (device px) along one projection: runs above a quarter of the projection's own range. A quarter,
 * not a half: a rule that falls across two device rows paints each at about half contrast, and a half-way cut drops it.
 */
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

const panXY = (sizer: string) => { const m = /translate\(\s*(-?[\d.e+-]+)px\s*,\s*(-?[\d.e+-]+)px\s*\)/.exec(sizer); return m ? { x: Number(m[1]), y: Number(m[2]) } : { x: 0, y: 0 }; };

/**
 * `patch` defaults to the module-level PATCH (every caller before MAXZOOM-6 got exactly that): a
 * higher zoom needs a wider window to still catch several pitches in one read (the 200x200 default
 * holds about 7 pitches at 100% but only about 1 at 600%, too few for the lattice-fit below).
 */
async function readPatch(p: Page, dots = false, patch = PATCH) {
	const g = () => p.evaluate(() => {
		const sc = document.querySelector(".cm-scroller") as HTMLElement, sizer = document.querySelector(".cm-sizer") as HTMLElement;
		const r = sc.getBoundingClientRect(), s = sizer.getBoundingClientRect();
		const line = (document.querySelector(".cm-line") as HTMLElement).getBoundingClientRect();
		return { scrollerLeft: r.left, scrollerTop: r.top, zoom: (window as any).viewportFixture.snap("paper").state.zoom as number, sizerLeft: s.left, sizerTop: s.top,
			lineLeft: line.left, lineTop: line.top, rule: Number.parseFloat(getComputedStyle(document.querySelector(".cm-editor") as HTMLElement).getPropertyValue("--handwriting-paper-rule")) || 1,
			sizer: sizer.style.transform, scrollLeft: sc.scrollLeft, scrollTop: sc.scrollTop, preview: (window as any).viewportFixture.preview("paper") as boolean,
			vars: ["--handwriting-paper-pitch", "--handwriting-paper-rule", "--handwriting-paper-dot", "--handwriting-paper-phase"].map(k => getComputedStyle(sc).getPropertyValue(k).trim()).join("|") };
	});
	const before = await g();
	const clip = { x: Math.round(before.scrollerLeft + patch.dx), y: Math.round(before.scrollerTop + patch.dy), width: patch.w, height: patch.h };
	const shot = await p.screenshot({ clip });
	if (process.env.HW_PAPER_PAN_SHOTS) writeFileSync(`${process.env.HW_PAPER_PAN_SHOTS}-${++shotCount}.png`, shot);
	const d = decodePng(shot);
	const rows: number[] = new Array(d.height).fill(0), cols: number[] = new Array(d.width).fill(0);
	for (let y = 0; y < d.height; y++) for (let x = 0; x < d.width; x++) {
		const i = (y * d.width + x) * d.channels;
		const f = Math.max(0, Math.min(1, (PAGE_GREY - (d.px[i]! + d.px[i + 1]! + d.px[i + 2]!) / 3) / (PAGE_GREY - RULE_GREY)));
		rows[y] = rows[y]! + f / d.width; cols[x] = cols[x]! + f / d.height;
	}
	const after = await g();
	const k = before.zoom;
	const centres: Record<Axis, number[]> = { x: bandCentres(cols), y: bandCentres(rows) };
	if (dots) {
		// A dot is too small a share of a row for a projection: each dot is its own blob, and its weighted centre is one
		// lattice position on both axes. Blobs larger than a dot (anything that is not paper) are dropped.
		const f = new Float32Array(d.width * d.height);
		for (let y = 0; y < d.height; y++) for (let x = 0; x < d.width; x++) {
			const i = (y * d.width + x) * d.channels;
			f[y * d.width + x] = Math.max(0, Math.min(1, (PAGE_GREY - (d.px[i]! + d.px[i + 1]! + d.px[i + 2]!) / 3) / (PAGE_GREY - RULE_GREY)));
		}
		const seen = new Uint8Array(f.length);
		centres.x = []; centres.y = [];
		for (let s = 0; s < f.length; s++) {
			if (seen[s] || f[s]! <= 0.25) continue;
			const stack = [s]; seen[s] = 1;
			let w = 0, mx = 0, my = 0, n = 0, edgeTouch = false;
			while (stack.length) {
				const c = stack.pop()!, cx = c % d.width, cy = (c - cx) / d.width;
				w += f[c]!; mx += f[c]! * (cx + 0.5); my += f[c]! * (cy + 0.5); n++;
				if (cx === 0 || cy === 0 || cx === d.width - 1 || cy === d.height - 1) edgeTouch = true;
				for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]] as const) {
					if (nx < 0 || ny < 0 || nx >= d.width || ny >= d.height) continue;
					const q = ny * d.width + nx;
					if (!seen[q] && f[q]! > 0.25) { seen[q] = 1; stack.push(q); }
				}
			}
			if (edgeTouch || n > 80) continue;
			centres.x.push(mx / w); centres.y.push(my / w);
		}
	}
	// Only positions on the pitch lattice count: one with another position a whole number of pitches away along the axis.
	const pLattice = PITCH * k * DSF;
	for (const a of ["x", "y"] as const) {
		const all = centres[a];
		centres[a] = all.filter(c => all.some(o => { const d = Math.abs(o - c); const n = Math.round(d / pLattice); return n >= 1 && Math.abs(d - n * pLattice) <= 2; }));
	}
	const edge: Record<Axis, number> = { x: (before.sizerLeft - clip.x) * DSF, y: (before.sizerTop - clip.y) * DSF };
	/** Circular mean of (centre - sizer edge) / (k dsf) modulo the pitch, layout px. */
	const rel = (a: Axis) => {
		const c = centres[a];
		if (!c.length) return Number.NaN;
		const ang = c.map(v => 2 * Math.PI * (((((v - edge[a]) / (k * DSF)) % PITCH) + PITCH) % PITCH) / PITCH);
		const m = Math.atan2(ang.reduce((s, v) => s + Math.sin(v), 0), ang.reduce((s, v) => s + Math.cos(v), 0));
		return (((m / (2 * Math.PI)) * PITCH) + PITCH) % PITCH;
	};
	/** How tightly the positions agree modulo the pitch (1 = one lattice exactly, 0 = no lattice at this pitch). */
	const tight = (a: Axis) => {
		const c = centres[a];
		if (!c.length) return 0;
		const ang = c.map(v => 2 * Math.PI * (((((v - edge[a]) / (k * DSF)) % PITCH) + PITCH) % PITCH) / PITCH);
		return Math.hypot(ang.reduce((s, v) => s + Math.sin(v), 0), ang.reduce((s, v) => s + Math.cos(v), 0)) / c.length;
	};
	const medianGap = (xs: number[]) => { const gs = xs.slice(1).map((v, i) => v - xs[i]!).sort((a, b) => a - b); return gs.length ? gs[Math.floor(gs.length / 2)]! : Number.NaN; };
	const pan = panXY(before.sizer);
	// THE CONTRACT, absolutely: the vertical rules' right edges and the dot columns' centres on the text column's left edge
	// (plus half a pitch for a dot), the horizontal rules' bottom edges and the dot rows' centres on the note's top, modulo
	// the pitch. The largest distance over the marks read, in device px.
	const pDevHere = PITCH * k * DSF, ruleDev = before.rule * k * DSF;
	const anchor: Record<Axis, number> = { x: (before.lineLeft - clip.x) * DSF, y: (before.lineTop - clip.y) * DSF };
	const markOffset = dots ? pDevHere / 2 : -ruleDev / 2;
	const abs = (a: Axis) => centres[a].length ? Math.max(...centres[a].slice(0, 6).map(c => circ(c - (anchor[a] + markOffset), pDevHere))) : Number.NaN;
	return { geo: before, stable: JSON.stringify(before) === JSON.stringify(after), abs: { x: abs("x"), y: abs("y") } as Record<Axis, number>,
		centres: { x: centres.x.slice(0, 5).map(v => Math.round(v * 10) / 10), y: centres.y.slice(0, 5).map(v => Math.round(v * 10) / 10) },
		rel: { x: rel("x"), y: rel("y") } as Record<Axis, number>, tight: { x: tight("x"), y: tight("y") } as Record<Axis, number>, count: { x: centres.x.length, y: centres.y.length } as Record<Axis, number>, pitchDev: { x: medianGap(centres.x), y: medianGap(centres.y) } as Record<Axis, number>,
		pan: { x: pan.x * k * DSF, y: pan.y * k * DSF } as Record<Axis, number> };
}

/** Distance in device px, at zoom k, between two layout-px places modulo the pitch. */
const relOffDev = (a: number, b: number, k: number) => circ(a - b, PITCH) * k * DSF;

/**
 * `scale`/`spread0` default to the original 150%/300 (every caller before MAXZOOM-6 got exactly
 * that); a higher scale needs a smaller starting spread to keep the gesture on-screen (see
 * `pinchTo`) and a wider read patch to still catch several pitches at once (see `readPatch`'s
 * `patch` argument - the default 200x200 CSS px window holds about 7 pitches at 100% but only
 * about 1 at 600%, too few for the lattice-fit to read at all).
 */
async function bothAxesArm(kind: "grid" | "dots", scale = 1.5, spread0 = 300, patch = PATCH) {
	const p = await realPage();
	try {
		await mountPaper(p, kind);
		await p.evaluate(async () => {
			await (window as any).edgeAudit.commit("paper", 1);
			const sc = document.querySelector(".cm-scroller") as HTMLElement;
			sc.scrollTop = 1200; sc.scrollLeft = 600;
			await (window as any).viewportFixture.settle();
		});
		const rest = await readPatch(p, kind === "dots", patch);
		expect(rest.geo.zoom, "premise: at 100 percent").toBeCloseTo(1, 6);
		expect(rest.geo.scrollLeft, `premise: the note scrolls sideways, so the x pan has a scroll to spend into ${JSON.stringify(rest.geo)}`).toBeGreaterThan(0);
		for (const a of AXES) {
			expect(rest.count[a], `premise: the ${kind} lattice is found on ${a} at rest ${JSON.stringify(rest)}`).toBeGreaterThanOrEqual(4);
			expect(rest.tight[a], `premise: the ${kind} ${a} positions form one lattice at 28 x dsf at rest ${JSON.stringify(rest)}`).toBeGreaterThanOrEqual(0.9);
		}

		// A pinch IN: zooming out spends the x pan into the column and the scroll on this fixture (measured: translate(0px, 155px)
		// at 60 percent), so only a zoom-in carries a pan on both axes here.
		await pinchTo(p, scale, 320, 230, 24, spread0);
		const live = await readPatch(p, kind === "dots", patch);
		const k = live.geo.zoom, pDev = PITCH * k * DSF;
		expect(live.geo.preview, "frame identity: the pinch preview is still live for this reading").toBe(true);
		expect(live.stable, `premise: the preview did not move while it was read ${JSON.stringify(live.geo)}`).toBe(true);
		// THE PLANT CATCHES HERE FIRST (leave the ceiling at 4 anywhere): the pinch settles at
		// 400%, not 600%, and this premise reddens on its own.
		expect(k, `premise: the preview reached the target scale, not a lower ceiling ${JSON.stringify(live.geo)}`).toBeCloseTo(scale, 2);
		for (const a of AXES) {
			expect(live.count[a], `premise: the ${kind} lattice is found on ${a} on the live frame ${JSON.stringify(live)}`).toBeGreaterThanOrEqual(3);
			expect(live.tight[a], `premise: the ${kind} ${a} positions form one lattice at 28 x z x dsf on the live frame ${JSON.stringify(live)}`).toBeGreaterThanOrEqual(0.9);
			expect(circ(live.pan[a], pDev), `premise: the ${a} pan is not a whole number of pitches ${JSON.stringify(live)}`).toBeGreaterThanOrEqual(PAN_CLEAR_DEV);
			expect.soft(relOffDev(live.rel[a], rest.rel[a], k), `LIVE PINCH ${kind} ${a}: the lattice against the text's box, device px from its at-rest place (pan ${live.pan[a].toFixed(1)} px); rest ${rest.rel[a].toFixed(3)} live ${live.rel[a].toFixed(3)} ${JSON.stringify(live)}`).toBeLessThanOrEqual(TOL_PREVIEW_DEV);
		}

		await release(p);
		const settled = await readPatch(p, kind === "dots", patch);
		expect(settled.geo.preview, "frame identity: the preview has ended for this reading").toBe(false);
		// A refused commit (e.g. a stray literal ceiling below the target) would leave the scale
		// short of what was asked for while the geometry checks below stay self-consistent against
		// WHATEVER zoom actually landed - so the commit's own target is pinned explicitly here too.
		expect(settled.geo.zoom, "premise: the settle actually committed the target scale").toBeCloseTo(scale, 2);
		for (const a of AXES) {
			expect.soft(relOffDev(settled.rel[a], rest.rel[a], settled.geo.zoom), `SETTLED ${kind} ${a}: the lattice against the text's box, device px from its at-rest place (standing pan ${settled.pan[a].toFixed(1)} px); rest ${rest.rel[a].toFixed(3)} settled ${settled.rel[a].toFixed(3)} ${JSON.stringify(settled)}`).toBeLessThanOrEqual(TOL_DEV);
		}
		// eslint-disable-next-line no-console
		console.log(`PAPER-PAN ${kind.toUpperCase()}`, JSON.stringify({ rest, live, settled }));
	} finally {
		await p.close();
	}
}

it("GRID: on a live pinch frame both rule directions keep their place under the text, and again once the pinch settles", () => bothAxesArm("grid"));

it("DOTS: on a live pinch frame the dots keep their place under the text on both axes, and again once the pinch settles", () => bothAxesArm("dots"));

/**
 * MAXZOOM-6 (Fleet 3 c3, candidate 5): the ceiling moved from 4 to 6 tonight (PinchScale.ts's
 * MAX_PINCH_SCALE) - the GRID both-axes invariant above, proven at the new ceiling instead of
 * 150%. This is the x-anchor holding at 6x: both rule directions keep their place under the text
 * on a live 600% frame and again once it settles, same tolerance, same pan-clearance premise.
 */
it("GRID AT 600%: on a live pinch frame both rule directions keep their place under the text, and again once the pinch settles", () => {
	// A literal 6, not the imported constant - see the LINES AT 600% arm's own note above.
	expect(MAX_PINCH_SCALE, "premise: this pin targets the real ceiling").toBe(6);
	return bothAxesArm("grid", 6, 60, { dx: 20, dy: 20, w: 600, h: 600 });
});

/**
 * AN EMPTY NOTE, SETTLED: the same lined pinch on a note with no text at all. On 27cc50dd this settle re-plans the
 * paper phase (4px -> 6.65625px) while the text origin stays at 4 layout px, so the rules land about 1.6 screen px off
 * the text at release; with one glyph in the note the same settle keeps the phase (the LINES arm). The live frame is
 * read too, with the same premises; no x pan exists here (an empty line has no column to hold).
 */
it("EMPTY NOTE: after a pinch settles the rules are still on the note origin, as on a note with text", async () => {
	const p = await realPage();
	try {
		await mountPaper(p, "lines", "");
		await p.evaluate(async () => {
			await (window as any).edgeAudit.commit("paper", 1);
			const sc = document.querySelector(".cm-scroller") as HTMLElement;
			sc.scrollTop = 1200;
			await (window as any).viewportFixture.settle();
		});
		const rest = await readLines(p, "empty note at rest");
		expect(rest.off, `control, at rest: rule bottom edges vs the note origin, device rows ${JSON.stringify(rest)}`).toBeLessThanOrEqual(TOL_DEV);
		await pinchTo(p, 0.6, 300, 230);
		const live = await readLines(p, "empty note, live pinch frame");
		expect(live.geo.preview, "frame identity: the pinch preview is still live for this reading").toBe(true);
		expect(live.geo.zoom, `premise: the preview reached 60 percent ${JSON.stringify(live.geo)}`).toBeCloseTo(0.6, 2);
		expect(live.panOffPitch, `premise: the focal pan is not a whole number of pitches ${JSON.stringify(live)}`).toBeGreaterThanOrEqual(PAN_CLEAR_DEV);
		expect.soft(live.off, `EMPTY NOTE LIVE PINCH: rule bottom edges vs the note origin, device rows (pan ${live.panDev.toFixed(1)} rows) ${JSON.stringify(live)}`).toBeLessThanOrEqual(TOL_PREVIEW_DEV);
		await release(p);
		const settled = await readLines(p, "empty note after the settle");
		expect(settled.geo.preview, "frame identity: the preview has ended for this reading").toBe(false);
		expect(settled.panDev, `premise: the settle spent the pan ${JSON.stringify(settled)}`).toBeCloseTo(0, 3);
		expect.soft(settled.off, `EMPTY NOTE SETTLED: rule bottom edges vs the note origin, device rows (phase ${settled.geo.vars}) ${JSON.stringify(settled)}`).toBeLessThanOrEqual(TOL_DEV);
		// eslint-disable-next-line no-console
		console.log("PAPER-PAN EMPTY", JSON.stringify({ rest, live, settled }));
	} finally {
		await p.close();
	}
});

/**
 * THE SETTLE PLANS THE PHASE FROM THE TEXT'S TOP, AT EVERY ZOOM (defect 2's discriminator). An empty note with lined
 * paper, a pinch from 100 percent to k and a release: the note origin is the content's 4 px top padding, so the phase
 * is 4px after every settle. On 27cc50dd CodeMirror's unscaled padding planned 4 / k instead: 8px at 0.5, 5px at 0.8,
 * and 40 mod 28 = 12px at 0.1.
 */
it.each([0.5, 0.8, 0.1])("EMPTY NOTE, SETTLE AT %s: the paper's phase is planned from the text's top", async k => {
	const p = await realPage();
	try {
		await mountPaper(p, "lines", "");
		await p.evaluate(async () => {
			await (window as any).edgeAudit.commit("paper", 1);
			(document.querySelector(".cm-scroller") as HTMLElement).scrollTop = 1200;
			await (window as any).viewportFixture.settle();
		});
		const phase = () => p.evaluate(() => getComputedStyle(document.querySelector(".cm-editor") as HTMLElement).getPropertyValue("--handwriting-paper-phase").trim());
		const pad = await p.evaluate(() => Number.parseFloat(getComputedStyle(document.querySelector(".cm-content") as HTMLElement).paddingTop));
		expect(pad, "premise: the content's top padding, the origin the phase must carry").toBe(4);
		expect(await phase(), "control: at rest at 100 percent").toBe("4px");
		await pinchTo(p, k, 300, 230);
		expect((await readGeo(p)).zoom, "premise: the pinch reached k").toBeCloseTo(k, 2);
		await release(p);
		expect((await readGeo(p)).zoom, "premise: the settle kept k").toBeCloseTo(k, 2);
		// The text's top on the settled zoom's device px grid (DSF 2): 4 px itself where 4 x k x 2 is whole.
		const onGrid = Math.round(4 * k * DSF) / (k * DSF);
		expect(await phase(), `SETTLED AT ${k}: the phase after the settle, the text's top on the device px grid (27cc50dd planned ${(4 / k) % 28}px)`).toBe(`${Math.round(onGrid * 64) / 64}px`);
	} finally {
		await p.close();
	}
});

/** A staged two-finger pinch: start about (cx, cy) at `spread`, move the spread through ratios, release. */
async function pinchStart(p: Page, cx: number, cy: number, spread = 300) {
	await p.evaluate(({ cx, cy, spread }) => {
		const send = (type: string, pid: number, x: number, y: number) => {
			const target = document.elementFromPoint(x, y);
			if (!target) throw new Error(`pinch point (${x},${y}) outside the page`);
			target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "touch", pointerId: pid, isPrimary: pid === 701, clientX: x, clientY: y, buttons: type === "pointerup" ? 0 : 1, width: 8, height: 8 }));
		};
		send("pointerdown", 701, cx - spread / 2, cy);
		send("pointerdown", 702, cx + spread / 2, cy);
		(window as any).__staged = { cx, cy, ratio: 1, half0: spread / 2, send };
	}, { cx, cy, spread });
}

async function pinchStage(p: Page, to: number, steps = 12) {
	await p.evaluate(async ({ to, steps }) => {
		const st = (window as any).__staged;
		const raf = () => new Promise<void>(r => requestAnimationFrame(() => r()));
		const from = st.ratio;
		for (let i = 1; i <= steps; i++) {
			const ratio = from * (to / from) ** (i / steps), half = st.half0 * ratio;
			st.send("pointermove", 701, st.cx - half, st.cy);
			st.send("pointermove", 702, st.cx + half, st.cy);
			await raf();
		}
		st.ratio = to;
	}, { to, steps });
}

async function stagedRelease(p: Page) {
	await p.evaluate(async () => {
		const st = (window as any).__staged, half = st.half0 * st.ratio;
		st.send("pointerup", 701, st.cx - half, st.cy);
		st.send("pointerup", 702, st.cx + half, st.cy);
		await (window as any).viewportFixture.rest(); // The reading after a release is the page at rest; the patch reader pairs a screenshot with a later rect, which a playing ease skews
	});
}

/** The re-centring of the text column against the scroller since `rest`, device px: the sizer's box less its own pan. */
const recentring = (now: Awaited<ReturnType<typeof readPatch>>, rest: Awaited<ReturnType<typeof readPatch>>) =>
	((now.geo.sizerLeft - now.geo.scrollerLeft) - panXY(now.geo.sizer).x * now.geo.zoom - ((rest.geo.sizerLeft - rest.geo.scrollerLeft) - panXY(rest.geo.sizer).x * rest.geo.zoom)) * DSF;

/**
 * AT REST, THE CONTRACT: grid's vertical rules and the dots sit on the text column's left edge, and the dots and the
 * horizontal rules on the note's top, Readable line length on and off. On 27cc50dd the vertical rules and the dots
 * sit on the scroller's edge and the dots on the scroller's top instead; the premise requires the column to be clear of
 * a whole pitch from the scroller's edge, or the arm could not tell the two apart.
 */
it.each([["grid", true], ["grid", false], ["dots", true], ["dots", false]] as const)("AT REST %s, readable line length %s: the paper sits on the text column's left edge and the note's top", async (kind, readable) => {
	const p = await realPage();
	try {
		await mountPaper(p, kind, "x", readable);
		await p.evaluate(async () => {
			await (window as any).edgeAudit.commit("paper", 1);
			(document.querySelector(".cm-scroller") as HTMLElement).scrollTop = 1200;
			await (window as any).viewportFixture.settle();
		});
		const rest = await readPatch(p, kind === "dots");
		const pDev = PITCH * rest.geo.zoom * DSF;
		const columnFromEdge = (rest.geo.lineLeft - rest.geo.scrollerLeft) * DSF;
		expect(rest.tight.x, `premise: one lattice on x ${JSON.stringify(rest)}`).toBeGreaterThanOrEqual(0.9);
		// eslint-disable-next-line no-console
		console.log(`PAPER-PAN AT-REST ${kind} RLL=${readable}`, JSON.stringify({ columnFromEdge, abs: rest.abs, rest }));
		if (circ(columnFromEdge, pDev) >= PAN_CLEAR_DEV) {
			expect.soft(rest.abs.x, `AT REST ${kind} RLL=${readable} x: marks vs the column's left edge, device px (column ${columnFromEdge.toFixed(1)} px from the scroller's edge)`).toBeLessThanOrEqual(TOL_DEV);
		}
		expect.soft(rest.abs.y, `AT REST ${kind} RLL=${readable} y: marks vs the note's top, device px`).toBeLessThanOrEqual(TOL_DEV);
	} finally {
		await p.close();
	}
});

/**
 * READABLE LINE LENGTH, ZOOM IN, the x contract through a gesture: 100 -> 180 percent in three stages about a focal
 * point low and to the right, the column re-centring as the zoom grows. Read at each stage with the fingers down and
 * once the pinch settles: the lattice against the text's box and against the column's left edge, both axes. Premise at
 * the last stage: the column really re-centred (RLL on), or really did not (RLL off, the control).
 */
it.each([["grid", true], ["dots", true], ["grid", false]] as const)("ZOOM IN %s, readable line length %s: the paper stays on the text column through a re-centring pinch and its settle", async (kind, readable) => {
	const p = await realPage();
	try {
		await mountPaper(p, kind, "x", readable);
		await p.evaluate(async () => {
			await (window as any).edgeAudit.commit("paper", 1);
			(document.querySelector(".cm-scroller") as HTMLElement).scrollTop = 1200;
			await (window as any).viewportFixture.settle();
		});
		const rest = await readPatch(p, kind === "dots");
		const readings: { label: string; r: Awaited<ReturnType<typeof readPatch>> }[] = [];
		await pinchStart(p, 400, 380, 200);
		for (const [label, to] of [["stage 1", 1.22], ["stage 2", 1.48], ["stage 3", 1.8]] as const) {
			await pinchStage(p, to);
			const r = await readPatch(p, kind === "dots");
			expect(r.geo.preview, `frame identity: the pinch preview is still live at ${label}`).toBe(true);
			readings.push({ label, r });
		}
		if (readable) {
			await expectFoldedPreview(p, "x", readings.at(-1)!.r.geo.zoom);
		}
		const last = readings.at(-1)!.r;
		expect(last.geo.zoom, `premise: the preview reached 180 percent ${JSON.stringify(last.geo)}`).toBeCloseTo(1.8, 1);
		const moved = recentring(last, rest);
		if (readable) expect(Math.abs(moved), `premise: the column re-centred against the scroller (device px) ${JSON.stringify(last.geo)}`).toBeGreaterThanOrEqual(PAN_CLEAR_DEV);
		else expect(Math.abs(moved), `premise, control: without readable line length the column does not re-centre ${JSON.stringify(last.geo)}`).toBeLessThan(1);
		await stagedRelease(p);
		readings.push({ label: "settled", r: await readPatch(p, kind === "dots") });
		expect(readings.at(-1)!.r.geo.preview, "frame identity: the preview has ended for this reading").toBe(false);
		// Grid's horizontal layer is not read above 100 percent: headless Chromium paints it soft and drops every other
		// rule there, on 27cc50dd as on this tree (patch screenshots kept with the evidence), so a y reading of it
		// measures the raster, not the position. The x contract is this arm's claim; y above 100 percent is read on the
		// dots arm and on the lined paper of PaperTitleRewrap.
		const axesRead: readonly Axis[] = kind === "grid" ? ["x"] : AXES;
		for (const { label, r } of readings) {
			expect(r.stable, `premise: ${label} did not move while it was read`).toBe(true);
			for (const a of axesRead) {
				expect.soft(relOffDev(r.rel[a], rest.rel[a], r.geo.zoom), `ZOOM IN ${kind} RLL=${readable} ${label} ${a}: the lattice against the text's box, device px from its at-rest place`).toBeLessThanOrEqual(label === "settled" ? TOL_DEV : TOL_PREVIEW_DEV);
				expect.soft(r.abs[a], `ZOOM IN ${kind} RLL=${readable} ${label} ${a}: the marks against the column's left edge / the note's top, device px`).toBeLessThanOrEqual(label === "settled" ? TOL_DEV : TOL_PREVIEW_DEV);
			}
		}
		// eslint-disable-next-line no-console
		console.log(`PAPER-PAN ZOOM-IN ${kind} RLL=${readable}`, JSON.stringify({ moved, rest, readings }));
	} finally {
		await p.close();
	}
});

/**
 * READABLE LINE LENGTH, ZOOM OUT: the column's margin holds in host units below 100 percent, so there is no
 * re-centring to follow; the paper still keeps the column and the note's top through the pan and the settle.
 */
it("ZOOM OUT grid, readable line length on: no re-centring, and the paper stays on the column and the note's top", async () => {
	const p = await realPage();
	try {
		await mountPaper(p, "grid", "x", true);
		await p.evaluate(async () => {
			await (window as any).edgeAudit.commit("paper", 1);
			(document.querySelector(".cm-scroller") as HTMLElement).scrollTop = 1200;
			await (window as any).viewportFixture.settle();
		});
		const rest = await readPatch(p);
		await pinchStart(p, 480, 380);
		await pinchStage(p, 0.6, 24);
		const live = await readPatch(p);
		expect(live.geo.preview, "frame identity: the pinch preview is still live for this reading").toBe(true);
		expect(live.geo.zoom, "premise: the preview reached 60 percent").toBeCloseTo(0.6, 1);
		await stagedRelease(p);
		const settled = await readPatch(p);
		expect(settled.geo.preview, "frame identity: the preview has ended for this reading").toBe(false);
		for (const [label, r] of [["live", live], ["settled", settled]] as const) {
			for (const a of AXES) {
				expect.soft(relOffDev(r.rel[a], rest.rel[a], r.geo.zoom), `ZOOM OUT ${label} ${a}: the lattice against the text's box, device px`).toBeLessThanOrEqual(label === "live" ? TOL_PREVIEW_DEV : TOL_DEV);
				expect.soft(r.abs[a], `ZOOM OUT ${label} ${a}: the marks against the column's left edge / the note's top, device px`).toBeLessThanOrEqual(label === "live" ? TOL_PREVIEW_DEV : TOL_DEV);
			}
		}
		// eslint-disable-next-line no-console
		console.log("PAPER-PAN ZOOM-OUT grid RLL=true", JSON.stringify({ moved: recentring(live, rest), rest, live, settled }));
	} finally {
		await p.close();
	}
});

/*
 * A STANDING PAN AT REST is not read in this file: this fixture's note always has scroll range (scroll expansion is on
 * in its setup), so every settle measured here spent its whole pan into the scroll (an in-then-out pinch about two
 * points settled at translate(-0.05px, 0px) with scrollLeft 106.5). The pan writer is the same call at rest as in a
 * preview (writeViewportPan); a paper reading of the fitting-page settle belongs on ZoomOutStandingPan's page.
 */

/**
 * THE SETTLE FRAME AND THE FRAMES AFTER IT: nothing a screenshot can time. The paper's lattice origin is computed from
 * what the stylesheet reads, on every rendered frame from the last preview frame through twelve after the release:
 * the scroller's box and scroll, the host's phases and pitch and the scroller's pan properties, against the first
 * line's box. The same computation is checked against the pixels at rest first, so it cannot be a model of something
 * else. A frame where the paper moves against the text for even one frame (a pan cleared before the origin is
 * re-planned, or re-planned before the pan is cleared) reads above the tolerance.
 */
it("SETTLE FRAMES: the paper does not move against the text on the settle frame or any frame after it", async () => {
	const p = await realPage();
	try {
		await mountPaper(p, "grid", "x", true);
		await p.evaluate(async () => {
			await (window as any).edgeAudit.commit("paper", 1);
			(document.querySelector(".cm-scroller") as HTMLElement).scrollTop = 1200;
			await (window as any).viewportFixture.settle();
		});
		// The paper's lattice origin from whichever element draws it this frame (the scroller's background at rest, the
		// preview element during a preview and a bounce), against the first line.
		await p.evaluate(() => {
			(window as any).__paperModel = () => {
				const line = (document.querySelector(".cm-line") as HTMLElement).getBoundingClientRect(), sc = document.querySelector(".cm-scroller") as HTMLElement;
				const o = (window as any).viewportFixture.paperOrigin("paper") as { source: string; x: number; y: number; k: number; pitch: number };
				const wrap = (v: number) => { const m = ((v % o.pitch) + o.pitch) % o.pitch; return Math.min(m, o.pitch - m); };
				return { k: o.k, source: o.source, offY: wrap((line.top - o.y) / o.k) * o.k * 2, offX: wrap((line.left - o.x) / o.k) * o.k * 2, scrollTop: sc.scrollTop, scrollLeft: sc.scrollLeft, sizer: (document.querySelector(".cm-sizer") as HTMLElement).style.transform };
			};
		});
		const modelNow = () => p.evaluate(() => (window as any).__paperModel() as { k: number; source: string; offX: number; offY: number });
		const rest = await readPatch(p), restModel = await modelNow();
		expect(restModel.source, "premise: at rest the paper is the scroller's own background").toBe("scroller");
		expect(Math.abs(restModel.offX - rest.abs.x) <= 1.5 && Math.abs(restModel.offY - rest.abs.y) <= 1.5, `instrument: the frame computation agrees with the pixels at rest ${JSON.stringify({ restModel, abs: rest.abs })}`).toBe(true);
		await pinchStart(p, 400, 380, 200);
		await pinchStage(p, 1.6, 24);
		const live = await readPatch(p), liveModel = await modelNow();
		expect(live.geo.preview, "frame identity: the pinch preview is still live for this reading").toBe(true);
		expect(liveModel.source, "premise: on a live frame the paper is the preview element, so the computation reads the element").toBe("element");
		expect(Math.abs(liveModel.offX - live.abs.x) <= 1.5 && Math.abs(liveModel.offY - live.abs.y) <= 1.5, `instrument: the frame computation agrees with the pixels on a live frame ${JSON.stringify({ liveModel, abs: live.abs })}`).toBe(true);
		const frames = await p.evaluate(async () => {
			const st = (window as any).__staged, half = st.half0 * st.ratio;
			const rendered = () => new Promise<void>(r => requestAnimationFrame(() => setTimeout(r, 0)));
			const read = (window as any).__paperModel as () => unknown;
			const out: unknown[] = [read()];
			st.send("pointerup", 701, st.cx - half, st.cy);
			st.send("pointerup", 702, st.cx + half, st.cy);
			out.push(read());
			for (let i = 0; i < 12; i++) { await rendered(); out.push(read()); }
			return out;
		}).catch(() => null);
		expect(frames, "the per-frame reader ran").not.toBeNull();
		const rows = frames as { offX: number; offY: number; source: string }[];
		const worst = rows.map((f, i) => ({ i, source: f.source, off: Math.max(f.offX, f.offY) })).filter(f => f.off > (f.source === "element" ? TOL_PREVIEW_DEV : TOL_DEV));
		expect(worst, `SETTLE FRAMES: frames where the paper stood off the text by more than ${TOL_DEV} device px (${TOL_PREVIEW_DEV} on the preview element) ${JSON.stringify(rows)}`).toEqual([]);
		expect(rows[0]?.source, "frame identity: the first frame read is the last preview frame, on the preview element").toBe("element");
		expect(rows.at(-1)?.source, "frame identity: twelve frames after the release the paper is the scroller's own again").toBe("scroller");
	} finally {
		await p.close();
	}
});

/**
 * REGISTERED, NOT INHERITED, AND READ BY THE PAPER. Before any other reading leans on the pan properties: unset, the
 * scroller resolves the registered initial value (an unregistered property resolves to nothing); set on the scroller,
 * a child of the scroller still resolves the initial value (it is not inherited, so a write restyles no descendant);
 * and a write on the scroller moves the painted rules by exactly that much, removing it puts them back. The pixels
 * are the receipt, not a computed background-image string, which need not change its serialization when a registered
 * value inside it does.
 */
it("REGISTERED: a pan written on the scroller moves the painted rules by its value, and nothing inside the scroller inherits it", async () => {
	const p = await realPage();
	try {
		await mountPaper(p, "lines", "x");
		await p.evaluate(async () => {
			await (window as any).edgeAudit.commit("paper", 1);
			(document.querySelector(".cm-scroller") as HTMLElement).scrollTop = 1200;
			await (window as any).viewportFixture.settle();
		});
		const registration = await p.evaluate(() => {
			const sc = document.querySelector(".cm-scroller") as HTMLElement, child = document.querySelector(".cm-sizer") as HTMLElement;
			const unset = getComputedStyle(sc).getPropertyValue("--handwriting-paper-pan-y").trim();
			sc.style.setProperty("--handwriting-paper-pan-y", "10px");
			const onScroller = getComputedStyle(sc).getPropertyValue("--handwriting-paper-pan-y").trim();
			const onChild = getComputedStyle(child).getPropertyValue("--handwriting-paper-pan-y").trim();
			sc.style.removeProperty("--handwriting-paper-pan-y");
			return { unset, onScroller, onChild };
		});
		expect(registration, "registered (unset reads the initial value) and not inherited (a child reads the initial value)").toEqual({ unset: "0px", onScroller: "10px", onChild: "0px" });
		const rest = await readLines(p, "rest, no pan property");
		expect(rest.off, `control: at rest the rules sit on the note origin ${JSON.stringify(rest)}`).toBeLessThanOrEqual(TOL_DEV);
		await p.evaluate(async () => { (document.querySelector(".cm-scroller") as HTMLElement).style.setProperty("--handwriting-paper-pan-y", "10px"); await (window as any).viewportFixture.settle(); });
		const moved = await readLines(p, "pan-y 10px on the scroller");
		const expected = circ(10 * moved.geo.zoom * DSF, moved.pDev);
		expect(Math.abs(moved.off - expected), `WRITTEN: the rules moved by the written 10 layout px (${expected} device rows) ${JSON.stringify(moved)}`).toBeLessThanOrEqual(TOL_DEV);
		await p.evaluate(async () => { (document.querySelector(".cm-scroller") as HTMLElement).style.removeProperty("--handwriting-paper-pan-y"); await (window as any).viewportFixture.settle(); });
		const back = await readLines(p, "pan-y removed");
		expect(back.off, `REMOVED: the rules are back on the note origin ${JSON.stringify(back)}`).toBeLessThanOrEqual(TOL_DEV);
	} finally {
		await p.close();
	}
});

/**
 * A GESTURE WITH NO PAN, the control: a pinch in and back to its starting scale about one point, fingers down, leaves
 * no pan, so the fix has nothing to add and the paper reads as it does without the fix. (A focal point on the note's
 * own top-left corner cannot be reached with two fingers inside this editor; a pinch that returns to its scale about
 * one point is the same no-pan case.)
 *
 * KNOWN, DISCLOSED, NOT FIXED - `it.fails` under the ruling, which PARKED the router fix
 * post-1.4.20. The defect: InlinePenRouter emits the pinch "start" from inside the pointermove
 * that crosses the slop, and Chromium delivers one pointermove PER CONTACT for a single
 * two-finger sample, so that centroid is made of one contact's new position and the other's
 * previous one. Measured here: the sizer holds `translate(1.34999px, -5.3e-05px)` where a no-pan
 * gesture must leave zero, and the premise assertion reads 2.69998 (twice 1.34999) against its
 * bound of 2. User effect: the focal point sits about 1.35 css px off at pinch start. Nobody has
 * reported that screen; it costs two bounds to close, so 1.4.20 ships it disclosed.
 *
 * THE ONE ASSERTION THIS CELL IS EXPECTED TO FAIL ON is the x-pan premise ("premise: no x pan is
 * left, device px"). `it.fails` passes on ANY error, a broken fixture included, so if this cell
 * ever fails somewhere else it is passing for the wrong reason and the disclosure is stale.
 *
 * The fix exists and is parked on its own branch at 4e44534a
 * (`pinch-start-coherent-1420`): the start is held until every live contact has reported for the
 * sample. Restoring this cell to a plain `it` belongs to that branch's landing commit, not here.
 * Its remaining reds are about the render fixtures' single-pointer-id model of two contacts, not
 * about the product.
 */
it.fails("NO-PAN CONTROL: a pinch in and back about one point, fingers down, carries no pan and the paper reads as at rest", async () => {
	const p = await realPage();
	try {
		await mountPaper(p, "grid", "x");
		await p.evaluate(async () => {
			await (window as any).edgeAudit.commit("paper", 1);
			(document.querySelector(".cm-scroller") as HTMLElement).scrollTop = 1200;
			await (window as any).viewportFixture.settle();
		});
		const rest = await readPatch(p);
		await pinchStart(p, 400, 380, 200);
		await pinchStage(p, 1.5, 16);
		await pinchStage(p, 1, 16);
		const live = await readPatch(p);
		expect(live.geo.preview, "frame identity: the pinch preview is still live for this reading").toBe(true);
		expect(live.geo.zoom, `premise: back at its starting scale ${JSON.stringify(live.geo)}`).toBeCloseTo(1, 2);
		for (const a of AXES) {
			expect(Math.abs(live.pan[a]), `premise: no ${a} pan is left, device px ${JSON.stringify(live.geo)}`).toBeLessThanOrEqual(TOL_DEV);
			expect.soft(relOffDev(live.rel[a], rest.rel[a], live.geo.zoom), `NO-PAN CONTROL ${a}: the lattice against the text's box, device px`).toBeLessThanOrEqual(TOL_PREVIEW_DEV);
		}
		await stagedRelease(p);
	} finally {
		await p.close();
	}
});

/**
 * A NOTE'S OWN PAPER UNDER A DIFFERENT GLOBAL PAPER. The dots position their tile on the text's origin plus the pan;
 * lined and grid paper carry both in their stops instead. A note set to lines or grid under global dots takes its
 * background image from its own rule, and must take its position from it too, or the dots' tile position moves its
 * rules a second time. Read at rest and on a live pinch frame; the reverse (a note set to dots under global lines)
 * is the control.
 * Plant: HW_PAPER_PAN_PLANT_NO_POSITION_RESET=1 loads the stylesheet without the lined and grid rules' own position.
 */
function pageCss(): string {
	if (!process.env.HW_PAPER_PAN_PLANT_NO_POSITION_RESET) return css;
	const decl = "\tbackground-position: 0 0;\n", text = css.replace(/\r\n/g, "\n");
	if (text.split(decl).length !== 3) throw new Error("position reset plant: expected the declaration twice");
	return text.split(decl).join("");
}

it.each([["lines", "dots"], ["grid", "dots"], ["dots", "lines"]] as const)("A NOTE SET TO %s UNDER GLOBAL %s: its paper sits on the text at rest and on a live pinch frame", async (note, global) => {
	const p = await realPage();
	try {
		await mountPaper(p, global, "x", false, "far", note);
		await p.evaluate(async () => {
			await (window as any).edgeAudit.commit("paper", 1);
			(document.querySelector(".cm-scroller") as HTMLElement).scrollTop = 1200;
			await (window as any).viewportFixture.settle();
		});
		const position = await p.evaluate(() => getComputedStyle(document.querySelector(".cm-scroller") as HTMLElement).backgroundPosition);
		const read = async () => note === "lines" ? await readLines(p, `${note} under ${global}`) : await readPatch(p, note === "dots");
		const offOf = (r: Awaited<ReturnType<typeof read>>): Record<Axis, number> => "off" in r ? { x: 0, y: r.off } : r.abs;
		const rest = await read();
		expect(rest.geo.preview, "frame identity: the preview has ended for this reading").toBe(false);
		// eslint-disable-next-line no-console
		console.log(`PAPER-PAN NOTE ${note} under ${global}`, JSON.stringify({ position, rest }));
		for (const a of note === "lines" ? (["y"] as const) : AXES) {
			expect.soft(offOf(rest)[a], `REST, a note set to ${note} under global ${global}, ${a}: marks against the text, device px (position ${position})`).toBeLessThanOrEqual(TOL_DEV);
		}
		await pinchStart(p, 400, 380, 200);
		await pinchStage(p, 1.5, 16);
		const live = await read();
		expect(live.geo.preview, "frame identity: the pinch preview is still live for this reading").toBe(true);
		expect(live.geo.zoom, "premise: the preview reached 150 percent").toBeCloseTo(1.5, 1);
		for (const a of note === "lines" ? (["y"] as const) : AXES) {
			expect.soft(offOf(live)[a], `LIVE, a note set to ${note} under global ${global}, ${a}: marks against the text, device px`).toBeLessThanOrEqual(TOL_PREVIEW_DEV);
		}
		await stagedRelease(p);
	} finally {
		await p.close();
	}
});

/**
 * LIFT JUMP: the at-rest phase sits on the device px grid, and a preview carries that snap's residual back out so the
 * paper tracks the text through the gesture; at the settle the paper lands on the new grid. So the settle may move the
 * paper against the text by at most half a device px at the settled scale, and by nothing where the note's origin is on
 * the device grid at both scales. Two notes: the origin at 4 layout px (on the grid at 100 and 150 percent, DSF 2), and
 * at 4 + 10/64 (off it: its residual at 150 percent is -15/32 device px). A pinch from 100 to 150 percent about the
 * middle, read with the fingers still down and again after the settle. The paper's place against the text is the
 * validated model (PaperTitleRewrap.test.ts): the text's top in the scroller's layout px, from the rects, against the
 * paper's phase plus its pan, modulo the pitch.
 * HW_PAPER_PAN_PLANT_SNAP_TWICE applies the residual a second time at rest: the off-grid note's settle goes red.
 */
it.each([[0, "on the device grid"], [10 / 64, "off the device grid"]] as const)("LIFT JUMP, origin +%s layout px (%s): the settle moves the paper against the text by at most half a device px", async (margin, _label) => {
	const p = await realPage();
	try {
		await mountPaper(p, "lines", "x");
		await p.evaluate(async margin => {
			await (window as any).edgeAudit.commit("paper", 1);
			(document.querySelector(".cm-content") as HTMLElement).style.marginTop = `${margin}px`;
			await (window as any).viewportFixture.fontPx("paper", 16);
			await (window as any).viewportFixture.growTo("paper", 0, 0);
		}, margin);
		const read = () => p.evaluate(() => {
			const content = document.querySelector(".cm-content") as HTMLElement;
			const k = (window as any).viewportFixture.snap("paper").state.zoom as number;
			// The paper's lattice origin from whichever element draws it this frame, against the text's top on screen: the
			// content's padding edge, the pan included.
			const o = (window as any).viewportFixture.paperOrigin("paper") as { source: string; y: number; pitch: number; phase: number };
			const textY = content.getBoundingClientRect().top + Number.parseFloat(getComputedStyle(content).paddingTop) * k;
			return { k, pitch: o.pitch, phase: o.phase, source: o.source, paperY: o.y, textY, preview: (window as any).viewportFixture.preview("paper") as boolean };
		});
		const offDev = (g: Awaited<ReturnType<typeof read>>) => {
			const raw = ((((g.paperY - g.textY) / g.k) % g.pitch) + g.pitch) % g.pitch;
			return (raw > g.pitch / 2 ? raw - g.pitch : raw) * g.k * DSF;
		};
		const rest = await read();
		expect(rest.k, "premise: at rest at 100 percent").toBeCloseTo(1, 6);
		await pinchStart(p, 320, 240, 200);
		await pinchStage(p, 1.5);
		const live = await read();
		expect(live.preview, "premise: the fingers are still down").toBe(true);
		expect(live.source, "premise: mid-gesture the paper read is the preview element").toBe("element");
		expect(live.k, "premise: the preview reached 150 percent").toBeCloseTo(1.5, 1);
		await stagedRelease(p);
		const settled = await read();
		expect(settled.preview, "premise: the settle has ended the preview").toBe(false);
		expect(settled.source, "premise: settled, the paper read is the scroller's own").toBe("scroller");
		expect(Math.abs(settled.phase * settled.k * DSF - Math.round(settled.phase * settled.k * DSF)), "premise: the settled phase is on the settled zoom's device px grid, so a paper landed on whole device px at the text's nearest px is where the settle puts it").toBeLessThanOrEqual(1e-6);
		expect(settled.k, "premise: the settle kept 150 percent").toBeCloseTo(1.5, 1);
		const jump = offDev(settled) - offDev(live);
		// eslint-disable-next-line no-console
		console.log("PAPER-LIFT-JUMP", JSON.stringify({ margin, rest: { ...rest, offDev: offDev(rest) }, live: { ...live, offDev: offDev(live) }, settled: { ...settled, offDev: offDev(settled) }, jump }));
		expect.soft(Math.abs(offDev(live)), `LIFT JUMP +${margin}: mid-gesture the paper lands on the whole device px nearest the text, device px`).toBeLessThanOrEqual(0.55);
		expect.soft(Math.abs(jump), `LIFT JUMP +${margin}: the paper's move against the text at the settle, device px at 150 percent`).toBeLessThanOrEqual(margin === 0 ? 0.05 : 0.5);
	} finally {
		await p.close();
	}
});
