/**
 * Render cells for the lined and grid paper background on the zoom host. The
 * paper scales with the text, like graph paper: the host's CSS zoom scales the
 * gradient with the note, so zooming out packs the rules together at 28 x z
 * screen px, and no pinch moves the pitch or the phase. The rules stay at least
 * one device px thick: a commit may re-plan their thickness, and nothing else,
 * and no preview frame writes a paper property at all.
 * The cells that measured the previous design's power-of-two levels were
 * revised to this contract or withdrawn with it.
 *
 * Reuses the existing camera fixture (`noteViewportCameraPage.ts`) rather
 * than building a second one: `viewportFixture.setup`/`edgeAudit.commit`/`fit`
 * drive the real overlay, real CodeMirror view and real `.cm-scroller`
 * background - nothing here reimplements the camera.
 *
 * DPR: the pixel cells read real compositor pixels, so they need the actual
 * rasterization path. Playwright's `deviceScaleFactor` context option does
 * NOT reach Blink's layout-zoom pixel snapping under a CSS `zoom` host
 * (measured, playwright-dsf-emulation-is-not-layout-zoom); only the real
 * `--force-device-scale-factor` launch flag does. This harness emulates DPR 2
 * via that flag. The cells that read CSS custom properties, JS geometry and
 * write counts, not raster pixels, run on the ordinary (unflagged) browser.
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import { decodePng } from "./pngInk";

let browser: Browser, realBrowser: Browser, script: string;
const OBSIDIAN_CAMERA_CSS = readFileSync(fileURLToPath(new URL("./noteViewportCamera.css", import.meta.url)), "utf8");

declare const process: { env: Record<string, string | undefined> };

/** HW_PAPER_PAN_PLANT_UNCONDITIONAL=1: the paper pan writer writes on every call, changed or not (ZERO WRITES goes red). */
const UNCONDITIONAL = { from: "\t\tif (last ? last.x === ax && last.y === ay : !ax && !ay) return;\n", to: "" };

beforeAll(async () => {
	let planted = 0;
	const b = await build({
		entryPoints: [fileURLToPath(new URL("./noteViewportCameraPage.ts", import.meta.url))],
		bundle: true, write: false, format: "iife", platform: "browser",
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
		plugins: process.env.HW_PAPER_PAN_PLANT_UNCONDITIONAL ? [{ name: "paper-pan-unconditional", setup(builder) {
			builder.onLoad({ filter: /src[\\/]inline[\\/]InkOverlay\.ts$/ }, args => {
				const text = readFileSync(args.path, "utf8").replace(/\r\n/g, "\n");
				if (text.split(UNCONDITIONAL.from).length !== 2) throw new Error("unconditional plant: anchor not found once");
				planted++;
				return { loader: "ts", contents: text.replace(UNCONDITIONAL.from, UNCONDITIONAL.to) };
			});
		} }] : [],
	});
	if (process.env.HW_PAPER_PAN_PLANT_UNCONDITIONAL && !planted) throw new Error("unconditional plant requested but never applied");
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);

afterAll(async () => { await browser?.close(); await realBrowser?.close(); });

/** Real device-scale-factor page: own browser, launched with the flag (see
 * file header). One instance, reused by every CRISPNESS sub-case. */
async function realPage(): Promise<Page> {
	if (!realBrowser) realBrowser = await chromium.launch({ headless: true, args: ["--force-device-scale-factor=2", "--window-size=900,700"] });
	const ctx = await realBrowser.newContext({ viewport: null });
	return ctx.newPage();
}

/** Blank text (no glyphs to confound a pixel read) plus one far ink stroke so
 * Fit has something to frame. White page, mid-grey rule so a screenshot's
 * channels separate cleanly. `kind` selects the body class - "lines" (the
 * three earlier cells) or "grid", which paints the SAME two custom
 * properties (styles.css:527-546) through two gradient layers, "to bottom"
 * and "to right", so a grid arm exercises the identical write path from the
 * other axis. */
async function mountPaper(p: Page, id = "paper", kind: "lines" | "grid" | "dots" = "lines") {
	await p.setContent(`<!doctype html><body class="handwriting-paper-${kind}" style="margin:0; background:#ffffff; --background-modifier-border:#777777"></body>`);
	await p.addStyleTag({ content: css + OBSIDIAN_CAMERA_CSS });
	await p.addScriptTag({ content: script });
	await p.evaluate(id => (window as any).viewportFixture.setup(id, "far", 1, 1, ""), id);
}

const PAGE_GREY = 255, RULE_GREY = 0x77;

/** Average grey (0..255) per DEVICE row of a narrow strip, from a real
 * screenshot decoded with the plugin's own PNG inflate (pngInk.ts) - the
 * compositor's actual output, not a canvas backing store. */
async function deviceRowGreys(p: Page, clip: { x: number; y: number; width: number; height: number }): Promise<number[]> {
	const buf = await p.screenshot({ clip });
	const d = decodePng(buf);
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

/** Same reader, transposed: average grey per DEVICE column of a wide, short
 * strip - the grid's "to right" layer paints vertical rules, so its spacing
 * shows up across columns the way the "to bottom" layer's shows up across
 * rows. Same instrument, same decode, no new claim about the compositor. */
async function deviceColGreys(p: Page, clip: { x: number; y: number; width: number; height: number }): Promise<number[]> {
	const buf = await p.screenshot({ clip });
	const d = decodePng(buf);
	const cols: number[] = [];
	for (let col = 0; col < d.width; col++) {
		let sum = 0;
		for (let row = 0; row < d.height; row++) {
			const i = (row * d.width + col) * d.channels;
			sum += (d.px[i]! + d.px[i + 1]! + d.px[i + 2]!) / 3;
		}
		cols.push(sum / d.height);
	}
	return cols;
}

/** Collapse device rows into SCREEN (css-px) rows by averaging each dsf-sized
 * group - the invariant is stated in screen px, so it must hold independent
 * of which DPR rasterized it (1/64 here, 1/128 on Orion). */
function collapseToScreenRows(deviceGreys: number[], dsf: number): number[] {
	const rows: number[] = [];
	for (let i = 0; i + dsf <= deviceGreys.length; i += dsf) {
		let sum = 0;
		for (let k = 0; k < dsf; k++) sum += deviceGreys[i + k]!;
		rows.push(sum / dsf);
	}
	return rows;
}

/** 0 (page colour) .. 1 (rule colour), clamped - same shape as KnobAndDots's
 * `accentAt`. */
const fracRule = (grey: number): number => Math.max(0, Math.min(1, (PAGE_GREY - grey) / (PAGE_GREY - RULE_GREY)));

interface RuleCluster { start: number; length: number; peak: number }
function findRuleClusters(screenRowGreys: number[]): RuleCluster[] {
	const fracs = screenRowGreys.map(fracRule);
	const clusters: RuleCluster[] = [];
	let i = 0;
	while (i < fracs.length) {
		if (fracs[i]! > 0.5) {
			let j = i, peak = fracs[i]!;
			while (j + 1 < fracs.length && fracs[j + 1]! > 0.5) { j++; peak = Math.max(peak, fracs[j]!); }
			clusters.push({ start: i, length: j - i + 1, peak });
			i = j + 1;
		} else i++;
	}
	return clusters;
}

/**
 * CRISPNESS is not a cell: it could not be made red on the shipped code in
 * this harness, so it would prove nothing either way.
 *
 * Measured (this file's history, real `--force-device-scale-factor=2`
 * browser, decoded via pngInk's own PNG inflate - not a canvas round-trip):
 * on the shipped formula at z=0.1 (pitch_screen 44.8, non-integral) every rule band
 * still rendered as EXACTLY two device rows at the border colour (119) with
 * clean 255 neighbours on both sides - never a partial/blended value - in
 * three regimes: plain, with a 0.25 CSS px fractional top offset (models
 * a non-integral absolute top the way Orion's chrome would produce), and
 * after a 7-layout-px scroll at z 0.1. Raw device-row values around a
 * transition (plain case): [...,255,255,119,119,255,255,...], never e.g. 187
 * or 220. Headless Chromium's rasterizer is snapping this axis-aligned
 * repeating-linear-gradient's hard stops to whole device pixels regardless of
 * the CSS-px fractional position of the stop or of the element's own origin,
 * in this minimal harness (styles.css + noteViewportCamera.css only, no full
 * app chrome, no real GPU compositor). That is a finding about what this
 * reproduction method can show, not about the shipped code. Levers not tried
 * here: a real GPU or non-headless Chromium, and the app's own stylesheet
 * and chrome instead of the minimal harness. EVENNESS below carries the
 * crispness acceptance.
 */

/**
 * SPACING: the rules are the note's 28 px grid, scaled by the zoom and nothing
 * else: 28 x z screen px at every zoom, never re-levelled, and anchored to the
 * note origin (each rule's bottom edge on it). Read in device rows on the real
 * DSF 2 browser at 100, 50 and 25 percent, where 28 x z x 2 is a whole number
 * of device rows; the rule is at least one device row at every zoom.
 */
it("SPACING: the rules' screen pitch is 28 x z at 100, 50 and 25 percent, anchored to the note origin", async () => {
	const p = await realPage();
	const dsf = 2;
	try {
		await mountPaper(p);
		for (const z of [1, 0.5, 0.25]) {
			const expectedPeriod = 28 * z * dsf;
			await p.evaluate(z => (window as any).edgeAudit.commit("paper", z), z);
			const geo = await p.evaluate(() => {
				const r = document.querySelector(".cm-scroller")!.getBoundingClientRect();
				const line = (document.querySelector(".cm-line") as HTMLElement).getBoundingClientRect();
				return { scrollerTop: r.top, scrollerLeft: r.left, scrollerHeight: r.height, lineTop: line.top };
			});
			const clip = { x: Math.round(geo.scrollerLeft + 4), y: Math.round(geo.scrollerTop), width: 8, height: Math.min(400, Math.max(60, Math.floor(geo.scrollerHeight - 10))) };
			const clusters = findRuleClusters(await deviceRowGreys(p, clip));
			const note = `[z=${z}] expectedPeriod=${expectedPeriod} device rows clip=${JSON.stringify(clip)} clusters=${JSON.stringify(clusters.slice(0, 6))}`;
			expect(clusters.length, `${note} - fewer than 3 rules found to measure spacing`).toBeGreaterThanOrEqual(3);
			const diffs = clusters.slice(1).map((c, i) => c.start - clusters[i]!.start);
			const measured = diffs.reduce((a, b) => a + b, 0) / diffs.length;
			expect(measured, `${note} - measured device-row pitch ${measured}, diffs ${JSON.stringify(diffs)}`).toBeCloseTo(expectedPeriod, 0);
			// The note origin in device rows from the clip's top; the rule's END is its bottom edge.
			const originRow = (geo.lineTop - clip.y) * dsf;
			const end = clusters[0]!.start + clusters[0]!.length;
			const raw = (((end - originRow) % expectedPeriod) + expectedPeriod) % expectedPeriod;
			const off = Math.min(raw, expectedPeriod - raw);
			expect(off, `${note} - rule end at device row ${end} vs note origin at ${originRow}, off by ${off} rows`).toBeLessThanOrEqual(1);
		}
	} finally {
		await p.close();
	}
});

/**
 * Drives a REAL two-finger touch pinch as many small steps (never one big
 * jump), the same shape production input takes. Reads the four paper
 * properties after every step and counts how many times their combined value
 * changed from gesture start up to pointerup (`previewWrites`), then, over the
 * eight frames after the lift, which carry the commit, how many times the pitch
 * changed (`commitPitchPhase`, the pitch alone), how many times the phase did
 * (`commitPhase`; a commit may put it once on the new zoom's device px grid) with
 * the phase it ends on (`phaseAfter`), and how many times the rule or dot
 * thickness did (`commitThickness`). `plant` writes the pitch directly, before
 * the lift ("preview") or after it ("commit") - the positive control that
 * proves each counter can see an addition, not just report zero forever.
 * Self-contained (page.evaluate serialises the callback - no outer closure).
 */
async function pinchWriteProbe(p: Page, id: string, ratios: number[], plant: "none" | "preview" | "commit"): Promise<{ previewWrites: number; commitPitchPhase: number; commitPhase: number; phaseAfter: number; commitThickness: number; finalZoom: number; elementWriteFrames: number; elementWritesMax: number; panWriteFrames: number; panCallsMax: number; panWritesUnchanged: number }> {
	// The probe counts writes on ITS pinch. A lift eases for up to 500 ms under the canvas, and a pinch begun inside that
	// window cancels the ease, which is one pan write at the gesture's start and not a per-frame cost. Start from rest.
	await p.evaluate(() => (window as any).viewportFixture.rest());
	return p.evaluate(({ id, ratios, plant }) => {
		const host = document.querySelector(".cm-editor") as HTMLElement;
		// Old rule: no paper write of any kind on a preview frame. Now: pitch, phase, phase-x,
		// rule and dot stay zero-write on the host; the text's pan is the one per-frame write, on the preview paper element
		// (its transform, and its box where the zoom moves its margin), and the scroller's own pan properties are not
		// written on a preview frame at all.
		const KEYS = ["--handwriting-paper-pitch", "--handwriting-paper-rule", "--handwriting-paper-dot", "--handwriting-paper-phase", "--handwriting-paper-phase-x"];
		const scroller = document.querySelector(".cm-scroller") as HTMLElement, sst = scroller.style;
		// The text half of a pinch's pan lands on `.cm-sizer`, which Obsidian wraps around the content and this fixture
		// does not create; without it the pan never engages and there is no pan write to count.
		if (!document.querySelector(".cm-sizer")) {
			const content = document.querySelector(".cm-content") as HTMLElement;
			const sizer = document.createElement("div"); sizer.className = "cm-sizer";
			const container = document.createElement("div"); container.className = "cm-contentContainer";
			content.parentElement!.insertBefore(sizer, content); sizer.appendChild(container); container.appendChild(content);
		}
		let panCalls = 0;
		const realSet = sst.setProperty.bind(sst), realRemove = sst.removeProperty.bind(sst);
		(sst as any).setProperty = (name: string, value: string, priority?: string) => { if (name.startsWith("--handwriting-paper-pan-")) panCalls++; return realSet(name, value, priority ?? ""); };
		(sst as any).removeProperty = (name: string) => { if (name.startsWith("--handwriting-paper-pan-")) panCalls++; return realRemove(name); };
		const panNow = () => ["--handwriting-paper-pan-x", "--handwriting-paper-pan-y"].map(k => sst.getPropertyValue(k)).join("|");
		// Style writes on the preview paper element, delivered before this frame's read resumes.
		let elementRecords = 0;
		const elementWrites = new MutationObserver(records => { for (const rec of records) if ((rec.target as HTMLElement).classList?.contains("handwriting-paper-preview")) elementRecords++; });
		elementWrites.observe(host, { attributes: true, attributeFilter: ["style"], subtree: true });
		const read = () => KEYS.map(k => host.style.getPropertyValue(k)).join("|");
		const pitchPhase = () => host.style.getPropertyValue("--handwriting-paper-pitch");
		const phaseNow = () => host.style.getPropertyValue("--handwriting-paper-phase");
		const thickness = () => ["--handwriting-paper-rule", "--handwriting-paper-dot"].map(k => host.style.getPropertyValue(k)).join("|");
		const cx = 300, cy = 250, baseSpread = 300;
		const send = (type: string, pid: number, x: number, y: number) => {
			const target = document.elementFromPoint(x, y);
			if (!target) throw new Error(`pinch point (${x},${y}) outside editor`);
			target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "touch", pointerId: pid, isPrimary: pid === 701, clientX: x, clientY: y, buttons: type === "pointerup" ? 0 : 1, width: 8, height: 8 }));
		};
		const raf = () => new Promise<void>(r => requestAnimationFrame(() => r()));
		return (async () => {
			const spreadAt = (ratio: number) => baseSpread * ratio;
			send("pointerdown", 701, cx - spreadAt(ratios[0]!) / 2, cy);
			send("pointerdown", 702, cx + spreadAt(ratios[0]!) / 2, cy);
			await raf();
			let last = read(), previewWrites = 0, commitPitchPhase = 0, commitPhase = 0, commitThickness = 0;
			let lastPan = panNow(), panWriteFrames = 0, panCallsMax = 0, panWritesUnchanged = 0, elementWriteFrames = 0, elementWritesMax = 0;
			for (let i = 1; i < ratios.length; i++) {
				const s = spreadAt(ratios[i]!);
				panCalls = 0; elementRecords = 0;
				send("pointermove", 701, cx - s / 2, cy);
				send("pointermove", 702, cx + s / 2, cy);
				await raf();
				const now = read();
				if (now !== last) previewWrites++;
				last = now;
				const pan = panNow();
				// Two calls (x and y) make one write of the pair; more than two in a frame is a second write.
				if (panCalls > 0) panWriteFrames++;
				panCallsMax = Math.max(panCallsMax, panCalls);
				if (panCalls > 0 && pan === lastPan) panWritesUnchanged++;
				lastPan = pan;
				// The swap-in frame writes the element's background copy once; after it, a frame writes its box and its transform at most.
				if (i > 1) { if (elementRecords > 0) elementWriteFrames++; elementWritesMax = Math.max(elementWritesMax, elementRecords); }
			}
			if (plant === "preview") {
				host.style.setProperty("--handwriting-paper-pitch", "999px");
				const now = read();
				if (now !== last) previewWrites++;
				last = now;
			}
			const finalSpread = spreadAt(ratios.at(-1)!);
			// Read before the lift: the commit can write inside the pointerup handler itself.
			let lastPitchPhase = pitchPhase(), lastPhase = phaseNow(), lastThickness = thickness();
			send("pointerup", 701, cx - finalSpread / 2, cy);
			send("pointerup", 702, cx + finalSpread / 2, cy);
			if (plant === "commit") host.style.setProperty("--handwriting-paper-pitch", "998px");
			for (let i = 0; i < 8; i++) {
				if (i > 0) await raf();
				const nowPitchPhase = pitchPhase(), nowPhase = phaseNow(), nowThickness = thickness();
				if (nowPitchPhase !== lastPitchPhase) commitPitchPhase++;
				if (nowPhase !== lastPhase) commitPhase++;
				lastPhase = nowPhase;
				if (nowThickness !== lastThickness) commitThickness++;
				lastPitchPhase = nowPitchPhase;
				lastThickness = nowThickness;
			}
			(sst as any).setProperty = realSet; (sst as any).removeProperty = realRemove;
			elementWrites.disconnect();
			return { previewWrites, commitPitchPhase, commitPhase, phaseAfter: Number.parseFloat(phaseNow()), commitThickness, finalZoom: (window as any).viewportFixture.snap(id).state.zoom, elementWriteFrames, elementWritesMax, panWriteFrames, panCallsMax, panWritesUnchanged };
		})();
	}, { id, ratios, plant });
}

/** Geometric ratio steps from 1 (current scale) to `target`. */
function geometricRatios(target: number, steps = 48): number[] {
	return Array.from({ length: steps }, (_, i) => target ** (i / (steps - 1)));
}

it("ZERO WRITES: a pinch writes no paper property on any preview frame, and its commit keeps the pitch and puts the phase on the new zoom's device px grid", async () => {
	const p = await browser.newPage();
	try {
		await mountPaper(p);
		const cases: { label: string; ref: number; endRatio: number }[] = [
			{ label: "1.0 -> 0.1", ref: 1, endRatio: 0.1 },
			{ label: "0.3 -> 0.2", ref: 0.3, endRatio: 0.2 / 0.3 },
			{ label: "0.9 -> 0.85", ref: 0.9, endRatio: 0.85 / 0.9 },
		];
		for (const { label, ref, endRatio } of cases) {
			await p.evaluate(ref => (window as any).edgeAudit.commit("paper", ref), ref);
			const r = await pinchWriteProbe(p, "paper", geometricRatios(endRatio), "none");
			expect.soft(r.previewWrites, `[${label}] finalZoom=${r.finalZoom} - pitch, phase, phase-x, rule or dot writes during the preview`).toBe(0);
			expect.soft(r.panWriteFrames, `[${label}] no scroller pan property write on a preview frame: the preview paper carries the pan`).toBe(0);
			expect.soft(r.panWritesUnchanged, `[${label}] no pan write on a frame whose pan values did not change`).toBe(0);
			expect.soft(r.elementWritesMax, `[${label}] the preview paper takes at most its box and its transform on a preview frame`).toBeLessThanOrEqual(2);
			// The 100 -> 10 percent gesture engages a pan on this fixture; the two short ones from a zoomed-out rest are clamped
			// to no pan at scroll zero, so there they read the zero-write caps alone.
			if (label === "1.0 -> 0.1") expect(r.elementWriteFrames, `[${label}] premise: the pinch's pan engaged, so there were preview paper writes to count`).toBeGreaterThan(0);
			expect.soft(r.commitPitchPhase, `[${label}] finalZoom=${r.finalZoom} - pitch changes at and after the commit (thickness changes: ${r.commitThickness})`).toBe(0);
			expect.soft(r.commitPhase, `[${label}] finalZoom=${r.finalZoom} - phase changes at and after the commit`).toBeLessThanOrEqual(1);
			expect.soft(Math.abs(r.phaseAfter * r.finalZoom - Math.round(r.phaseAfter * r.finalZoom)), `[${label}] the phase after the commit (${r.phaseAfter}) on the device px grid at ${r.finalZoom}`).toBeLessThanOrEqual(r.finalZoom / 128 + 1e-6);
		}
		// Positive controls: the same instrument, one planted direct write in each window.
		for (const plant of ["preview", "commit"] as const) {
			await p.evaluate(() => (window as any).edgeAudit.commit("paper", 0.9));
			const planted = await pinchWriteProbe(p, "paper", geometricRatios(0.85 / 0.9), plant);
			expect(plant === "preview" ? planted.previewWrites : planted.commitPitchPhase, `positive control: the planted ${plant} write was not counted (finalZoom=${planted.finalZoom})`).toBe(1);
		}
	} finally {
		await p.close();
	}
});

/**
 * PREVIEW ARM: the same stepped, no-commit gesture from 100 to 10 percent,
 * reading the paper properties on every frame. They stay the planned 28 px
 * pitch and 1 px rule throughout, so the screen spacing is 28 x z and the rule
 * z screen px on every frame: the gradient zooms with the note, unwritten.
 */
it("PREVIEW ARM: 1.0 -> 0.1 with no commit - the paper properties stay the planned ones on every frame", async () => {
	const p = await browser.newPage();
	try {
		await mountPaper(p);
		await p.evaluate(() => (window as any).edgeAudit.commit("paper", 1));
		const ratios = geometricRatios(0.1, 60);
		const result = await p.evaluate(({ id, ratios }) => {
			const host = document.querySelector(".cm-editor") as HTMLElement;
			const KEYS = ["--handwriting-paper-pitch", "--handwriting-paper-rule", "--handwriting-paper-dot", "--handwriting-paper-phase"];
			const readKeys = () => KEYS.map(k => host.style.getPropertyValue(k)).join("|");
			const cx = 300, cy = 250, baseSpread = 300;
			const send = (type: string, pid: number, x: number, y: number) => {
				const target = document.elementFromPoint(x, y);
				if (!target) throw new Error(`pinch point (${x},${y}) outside editor`);
				target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "touch", pointerId: pid, isPrimary: pid === 701, clientX: x, clientY: y, buttons: type === "pointerup" ? 0 : 1, width: 8, height: 8 }));
			};
			const raf = () => new Promise<void>(r => requestAnimationFrame(() => r()));
			return (async () => {
				const spreadAt = (ratio: number) => baseSpread * ratio;
				send("pointerdown", 701, cx - spreadAt(ratios[0]!) / 2, cy);
				send("pointerdown", 702, cx + spreadAt(ratios[0]!) / 2, cy);
				await raf();
				let lastKeys = readKeys(), writes = 0;
				const samples: { zoom: number; pitch: string; rule: string }[] = [];
				for (let i = 1; i < ratios.length; i++) {
					const s = spreadAt(ratios[i]!);
					send("pointermove", 701, cx - s / 2, cy);
					send("pointermove", 702, cx + s / 2, cy);
					await raf();
					const now = readKeys();
					if (now !== lastKeys) writes++;
					lastKeys = now;
					samples.push({ zoom: (window as any).viewportFixture.snap(id).state.zoom, pitch: host.style.getPropertyValue("--handwriting-paper-pitch"), rule: host.style.getPropertyValue("--handwriting-paper-rule") });
				}
				// NO pointerup: this is the point of the cell - a preview with no commit.
				return { writes, samples };
			})();
		}, { id: "paper", ratios });
		const off = result.samples.filter(s => s.pitch !== "28px" || s.rule !== "1px");
		expect(result.samples.at(-1)!.zoom, "premise: the preview reached 10 percent").toBeCloseTo(0.1, 2);
		expect(off.length, `frames whose paper properties were not the planned 28px / 1px: ${JSON.stringify(off.slice(0, 5))}`).toBe(0);
		expect(result.writes, "paper-property writes across the whole 1.0 -> 0.1 preview (no commit)").toBe(0);
	} finally {
		await p.close();
	}
});

/**
 * CALIBRATION: before the CRISPNESS
 * negative stands as a finding about the shipped code's snapping rather than
 * about this reader, the reader itself must be shown able to see a soft
 * transition. Same browser, same instrument (deviceRowGreys/decodePng), a
 * DELIBERATELY soft, fractionally-positioned stop (a 0.75 css px ramp
 * straddling a non-integral device row) - not the paper fixture at all, a
 * plain styled div, because the claim under test is about the reader, not
 * about `.cm-scroller`. If this cell is red (no intermediate value found),
 * the CRISPNESS negative is void and must be re-opened; if green, the
 * negative stands.
 */
it("CALIBRATION: the pixel reader sees a soft, fractionally-positioned transition", async () => {
	const p = await realPage();
	try {
		await p.setContent(
			'<!doctype html><body style="margin:0;background:#ffffff">' +
			'<div style="position:absolute;left:0;top:0;width:20px;height:200px;' +
			'background-image:linear-gradient(to bottom, #ffffff 0px, #ffffff 49.625px, #777777 50.375px, #777777 200px);"></div>' +
			'</body>'
		);
		const deviceGreys = await deviceRowGreys(p, { x: 4, y: 40, width: 8, height: 30 });
		const intermediate = deviceGreys.filter(g => g > RULE_GREY + 15 && g < PAGE_GREY - 15);
		expect(intermediate.length, `no intermediate grey found in a deliberately soft transition - rows=${JSON.stringify(deviceGreys)} - the reader cannot see a blend and the CRISPNESS negative is VOID`).toBeGreaterThan(0);
	} finally {
		await p.close();
	}
});

/**
 * EVENNESS: at the zooms where 28 x z x dsf is a whole number of device rows,
 * every consecutive rule spacing is that same count, and every arm shows at
 * least 10 rules: the rule is never under one device row, so none drops out.
 */
const EVENNESS_ARMS: { dsf: number; z: number; page: () => Promise<Page> }[] = [
	{ dsf: 1, z: 1, page: () => browser.newPage() },
	{ dsf: 1, z: 0.5, page: () => browser.newPage() },
	{ dsf: 1, z: 0.25, page: () => browser.newPage() },
	{ dsf: 2, z: 1, page: () => realPage() },
	{ dsf: 2, z: 0.5, page: () => realPage() },
	{ dsf: 2, z: 0.25, page: () => realPage() },
];

it("EVENNESS: at 100, 50 and 25 percent every consecutive rule spacing is the same 28 x z x dsf device rows", async () => {
	for (const { dsf, z, page } of EVENNESS_ARMS) {
		const expectedPeriod = 28 * z * dsf;
		const p = await page();
		try {
			await mountPaper(p);
			await p.evaluate(z => (window as any).edgeAudit.commit("paper", z), z);
			const geo = await p.evaluate(() => {
				const r = document.querySelector(".cm-scroller")!.getBoundingClientRect();
				return { left: r.left, top: r.top, height: r.height };
			});
			const clip = { x: Math.round(geo.left + 4), y: Math.round(geo.top + 8), width: 8, height: Math.max(60, Math.floor(geo.height - 16)) };
			const clusters = findRuleClusters(await deviceRowGreys(p, clip));
			const diffs = clusters.slice(1).map((c, i) => c.start - clusters[i]!.start);
			const note = `[dsf=${dsf} z=${z}] expectedPeriod=${expectedPeriod} clip=${JSON.stringify(clip)} clusterStarts=${JSON.stringify(clusters.map(c => c.start))} lengths=${JSON.stringify(clusters.map(c => c.length))} diffs=${JSON.stringify(diffs)}`;
			console.log(note);
			expect(clusters.length, `${note} - fewer than 10 rules found to compare`).toBeGreaterThanOrEqual(10);
			const uneven = diffs.filter(d => d !== expectedPeriod);
			expect(uneven.length, `${note} - ${uneven.length}/${diffs.length} consecutive spacings are not the constant ${expectedPeriod} device rows`).toBe(0);
		} finally {
			await p.close();
		}
	}
});

/**
 * GRID PAPER: the grid rule in styles.css paints its "to bottom" AND "to right"
 * layers off the same custom properties as lines. The preview arm confirms the
 * grid takes the same no-write path; EVENNESS's grid arm reads real pixels
 * across BOTH axes, because "to right" rasterizing a horizontal repeat is a
 * different code path in the compositor than "to bottom".
 */
it("PREVIEW ARM (GRID): the to-right layer shares the vars - no write on any frame of a 1.0 -> 0.1 preview", async () => {
	const p = await browser.newPage();
	try {
		await mountPaper(p, "paper", "grid");
		await p.evaluate(() => (window as any).edgeAudit.commit("paper", 1));
		const r = await pinchWriteProbe(p, "paper", geometricRatios(0.1, 60), "none");
		expect(r.finalZoom, "premise: the gesture reached 10 percent").toBeCloseTo(0.1, 2);
		expect(r.previewWrites, "[grid] paper-property writes during the 1.0 -> 0.1 preview").toBe(0);
		expect(r.commitPitchPhase, "[grid] pitch changes at and after its commit").toBe(0);
		expect(r.commitPhase, "[grid] phase changes at and after its commit").toBeLessThanOrEqual(1);
	} finally {
		await p.close();
	}
});

it("EVENNESS (GRID): both axes - horizontal rules' y-gaps AND vertical rules' x-gaps are the same 28 x z x dsf count", async () => {
	const p = await realPage();
	const dsf = 2;
	// z 0.25: 7 screen px = 14 device rows, the rule floored at one device row.
	const ARMS = [1, 0.5, 0.25];
	try {
		await mountPaper(p, "paper", "grid");
		for (const z of ARMS) {
			const expectedPeriod = 28 * z * dsf;
			await p.evaluate(z => (window as any).edgeAudit.commit("paper", z), z);
			const geo = await p.evaluate(() => {
				const r = document.querySelector(".cm-scroller")!.getBoundingClientRect();
				return { left: r.left, top: r.top, width: r.width, height: r.height };
			});
			const colClip = { x: Math.round(geo.left + 4), y: Math.round(geo.top + 8), width: 8, height: Math.max(60, Math.floor(geo.height - 16)) };
			const yClusters = findRuleClusters(await deviceRowGreys(p, colClip));
			const yDiffs = yClusters.slice(1).map((c, i) => c.start - yClusters[i]!.start);
			const rowClip = { x: Math.round(geo.left + 8), y: Math.round(geo.top + 4), width: Math.max(60, Math.floor(geo.width - 16)), height: 8 };
			const xClusters = findRuleClusters(await deviceColGreys(p, rowClip));
			const xDiffs = xClusters.slice(1).map((c, i) => c.start - xClusters[i]!.start);
			const noteY = `[grid z=${z}, y-gaps] expectedPeriod=${expectedPeriod} dsf=${dsf} clip=${JSON.stringify(colClip)} clusterStarts=${JSON.stringify(yClusters.map(c => c.start))} lengths=${JSON.stringify(yClusters.map(c => c.length))} diffs=${JSON.stringify(yDiffs)}`;
			const noteX = `[grid z=${z}, x-gaps] expectedPeriod=${expectedPeriod} dsf=${dsf} clip=${JSON.stringify(rowClip)} clusterStarts=${JSON.stringify(xClusters.map(c => c.start))} lengths=${JSON.stringify(xClusters.map(c => c.length))} diffs=${JSON.stringify(xDiffs)}`;
			console.log(noteY);
			console.log(noteX);
			expect(yClusters.length, `${noteY} - fewer than 10 rules found`).toBeGreaterThanOrEqual(10);
			expect(xClusters.length, `${noteX} - fewer than 10 rules found`).toBeGreaterThanOrEqual(10);
			expect(yDiffs.filter(d => d !== expectedPeriod).length, `${noteY} - y-gaps not constant`).toBe(0);
			expect(xDiffs.filter(d => d !== expectedPeriod).length, `${noteX} - x-gaps not constant`).toBe(0);
		}
	} finally {
		await p.close();
	}
});

/**
 * SCROLL AT REST: the phase is planned from the note origin updateExtent
 * measures on every scrolled frame. That origin is read through rects, so a
 * compare on the raw number could re-plan the phase on frames where nothing
 * about the paper moved. At z 0.1 and 0.37, 60 uneven scroll steps with no
 * zoom change must leave all three paper properties exactly as they were.
 */
it("SCROLL AT REST: scrolling without a zoom change writes no paper property and keeps the phase", async () => {
	const p = await browser.newPage();
	try {
		await mountPaper(p);
		for (const z of [0.1, 0.37]) {
			await p.evaluate(z => (window as any).edgeAudit.commit("paper", z), z);
			const r = await p.evaluate(async () => {
				const host = document.querySelector(".cm-editor") as HTMLElement, sc = document.querySelector(".cm-scroller") as HTMLElement;
				const KEYS = ["--handwriting-paper-pitch", "--handwriting-paper-rule", "--handwriting-paper-dot", "--handwriting-paper-phase"];
				const read = () => KEYS.map(k => host.style.getPropertyValue(k)).join("|");
				const frames = () => new Promise<void>(res => requestAnimationFrame(() => requestAnimationFrame(() => res())));
				await frames();
				const start = read(), firstTop = sc.scrollTop, seen = new Set([start]);
				let changes = 0, prev = start;
				for (let i = 0; i < 60; i++) {
					// Uneven steps, so the origin read lands at many sub-px offsets.
					sc.scrollTop += 7 + (i % 5);
					await frames();
					const now = read();
					if (now !== prev) changes++;
					prev = now;
					seen.add(now);
				}
				return { start, changes, values: [...seen], moved: sc.scrollTop - firstTop };
			});
			expect(r.start.split("|")[3], `z=${z}: a phase was planned before the scroll`).toMatch(/px$/);
			expect(r.moved, `z=${z}: the scroller moved`).toBeGreaterThan(300);
			expect(r.changes, `z=${z}: paper property changes over 60 scroll steps at rest; values ${JSON.stringify(r.values)}`).toBe(0);
		}
	} finally {
		await p.close();
	}
});

/**
 * FAR-DOWN DRIFT (GRID): at 17.6 px text 28 x the text scale is 30.8 px, no
 * whole number of the engine's 1/64 px layout unit. A background tile's size is
 * stored in that unit, so a grid layer tiled one pitch tall put each rule
 * 0.003 px higher than the one before: 10 px off by 100000 px down the note.
 * The grid is untiled, and a repeating gradient keeps its period exactly (the
 * pitch itself is planned on a whole 1/64 px, 30.796875, for the dots). At
 * 100 percent on the real DSF 2 browser, with the note grown to 131072 px,
 * every rule's end must sit on phase + k x pitch within one device row near
 * the top and 100000 px down. The calibration reads the same rules against a
 * pitch 0.01 px longer, and far down its residual must exceed that bound: the
 * reader can see a drift of that size.
 */
it("FAR-DOWN DRIFT (GRID): at 17.6 px text the rules 100000 px down the note still sit on phase + k x pitch", async () => {
	const p = await realPage();
	const dsf = 2, bound = 1 / dsf;
	try {
		await mountPaper(p, "paper", "grid");
		await p.evaluate(async () => { await (window as any).viewportFixture.fontPx("paper", 17.6); await (window as any).viewportFixture.growTo("paper", 2000, 131072); });
		const vars = await p.evaluate(() => {
			const host = document.querySelector(".cm-editor") as HTMLElement;
			return { pitch: host.style.getPropertyValue("--handwriting-paper-pitch"), phase: host.style.getPropertyValue("--handwriting-paper-phase"), zoom: (window as any).viewportFixture.snap("paper").state.zoom as number };
		});
		expect(Number.parseFloat(vars.pitch), `premise: the pitch at 17.6 px text; ${JSON.stringify(vars)}`).toBeCloseTo(30.8, 1);
		expect(vars.zoom, "premise: at 100 percent").toBeCloseTo(1, 6);
		const pitch = Number.parseFloat(vars.pitch), phase = Number.parseFloat(vars.phase) || 0;
		const residual = (y: number, period: number) => { const raw = (((y - phase) % period) + period) % period; return Math.min(raw, period - raw); };
		const reads: { target: number; scrollTop: number; ends: number[]; residuals: number[]; calibration: number[] }[] = [];
		for (const target of [0, 20000, 100000]) {
			const geo = await p.evaluate(async target => {
				const sc = document.querySelector(".cm-scroller") as HTMLElement;
				sc.scrollTop = target;
				await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
				const r = sc.getBoundingClientRect();
				return { top: r.top, left: r.left, scrollTop: sc.scrollTop, clientTop: sc.clientTop };
			}, target);
			const clip = { x: Math.round(geo.left + 4), y: Math.round(geo.top + 8), width: 8, height: 200 };
			const clusters = findRuleClusters(await deviceRowGreys(p, clip));
			// A rule's end in the gradient's positioning area (the scroller's padding box, layout px at zoom 1).
			const ends = clusters.map(c => (c.start + c.length) / dsf + (clip.y - geo.top - geo.clientTop) + geo.scrollTop);
			reads.push({ target, scrollTop: geo.scrollTop, ends, residuals: ends.map(y => residual(y, pitch)), calibration: ends.map(y => residual(y, pitch + 0.01)) });
		}
		const report = JSON.stringify({ vars, reads });
		console.log(report);
		for (const read of reads) {
			expect(read.scrollTop, `premise: the scroller reached ${read.target}; ${report}`).toBeCloseTo(read.target, 0);
			expect(read.ends.length, `[scrollTop ${read.target}] fewer than 4 rules found; ${report}`).toBeGreaterThanOrEqual(4);
			expect.soft(Math.max(...read.residuals), `[scrollTop ${read.target}] largest rule end off phase + k x pitch, layout px; ${report}`).toBeLessThanOrEqual(bound);
		}
		expect(Math.max(...reads.at(-1)!.calibration), `calibration: against a pitch 0.01 px longer the far rules must read off by more than ${bound}; ${report}`).toBeGreaterThan(bound);
	} finally {
		await p.close();
	}
});

/**
 * FAR-DOWN DRIFT (DOTS): dots cannot be untiled - a dot is one radial gradient
 * per tile - so their tile is the pitch square, and each dot is centred in its
 * tile. At 17.6 px text a pitch of 30.8 px, stored as a 30.796875 px tile, put
 * each dot row 0.003 px above where the pitch said: 10 px off by 100000 px
 * down. The pitch is planned on a whole 1/64 px, so the tile is exactly the
 * pitch. Same note, reads and bound as the grid's cell; the strip runs down the
 * dots' own column (the tile's middle), and each dot's centre must sit on
 * phase + pitch / 2 + k x pitch. The calibration is again a pitch 0.01 px longer,
 * over the bound far down. Revised on record when the paper's origin became the
 * text's on both axes: the old rule measured from the scroller's content
 * top (pitch / 2 + k x pitch) and ran the strip down the scroller's first tile; the
 * dots now sit on the note's top (phase) and the text column's left edge (phase-x).
 */
it("FAR-DOWN DRIFT (DOTS): at 17.6 px text the dot rows 100000 px down the note still sit on phase + pitch / 2 + k x pitch", async () => {
	const p = await realPage();
	const dsf = 2, bound = 1 / dsf;
	try {
		await mountPaper(p, "paper", "dots");
		await p.evaluate(async () => { await (window as any).viewportFixture.fontPx("paper", 17.6); await (window as any).viewportFixture.growTo("paper", 2000, 131072); });
		const vars = await p.evaluate(() => {
			const host = document.querySelector(".cm-editor") as HTMLElement;
			const read = (k: string) => Number.parseFloat(host.style.getPropertyValue(k));
			return { pitch: read("--handwriting-paper-pitch"), phase: read("--handwriting-paper-phase") || 0, phaseX: read("--handwriting-paper-phase-x") || 0, rule: read("--handwriting-paper-rule"), zoom: (window as any).viewportFixture.snap("paper").state.zoom as number };
		});
		expect(vars.pitch, `premise: the pitch at 17.6 px text; ${JSON.stringify(vars)}`).toBeCloseTo(30.8, 1);
		expect(vars.zoom, "premise: at 100 percent").toBeCloseTo(1, 6);
		const centreLine = vars.phase + vars.pitch / 2;
		const residual = (y: number, period: number) => { const raw = (((y - centreLine) % period) + period) % period; return Math.min(raw, period - raw); };
		const reads: { target: number; scrollTop: number; centres: number[]; residuals: number[]; calibration: number[] }[] = [];
		for (const target of [0, 20000, 100000]) {
			const geo = await p.evaluate(async target => {
				const sc = document.querySelector(".cm-scroller") as HTMLElement;
				sc.scrollTop = target;
				await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
				const r = sc.getBoundingClientRect();
				return { top: r.top, left: r.left, scrollTop: sc.scrollTop, clientTop: sc.clientTop, clientLeft: sc.clientLeft };
			}, target);
			// Two css px wide, centred on the first dot column: the column's left edge (phase-x) plus half a pitch.
			const clip = { x: Math.round(geo.left + geo.clientLeft + vars.phaseX + vars.pitch / 2 - 1), y: Math.round(geo.top + 8), width: 2, height: 200 };
			const clusters = findRuleClusters(await deviceRowGreys(p, clip));
			const centres = clusters.map(c => (c.start + c.length / 2) / dsf + (clip.y - geo.top - geo.clientTop) + geo.scrollTop);
			reads.push({ target, scrollTop: geo.scrollTop, centres, residuals: centres.map(y => residual(y, vars.pitch)), calibration: centres.map(y => residual(y, vars.pitch + 0.01)) });
		}
		const report = JSON.stringify({ vars, reads });
		console.log(report);
		for (const read of reads) {
			expect(read.scrollTop, `premise: the scroller reached ${read.target}; ${report}`).toBeCloseTo(read.target, 0);
			expect(read.centres.length, `[scrollTop ${read.target}] fewer than 4 dots found; ${report}`).toBeGreaterThanOrEqual(4);
			expect.soft(Math.max(...read.residuals), `[scrollTop ${read.target}] largest dot centre off phase + pitch / 2 + k x pitch, layout px; ${report}`).toBeLessThanOrEqual(bound);
		}
		expect(Math.max(...reads.at(-1)!.calibration), `calibration: against a pitch 0.01 px longer the far dots must read off by more than ${bound}; ${report}`).toBeGreaterThan(bound);
	} finally {
		await p.close();
	}
});

/**
 * WIDE NOTE (GRID): a note grown very wide and tall (500000 x 600000 px, as
 * far-out ink grows it) still paints its grid. A grid layer tiled at the whole
 * scroll area's width painted nothing there, rules or none; lined paper, never
 * tiled, painted. Down a strip and across one, at the top of the note and far
 * down it, on the real DSF 2 browser at 100 percent.
 */
it("WIDE NOTE (GRID): a grid on a 500000 x 600000 px note still paints its rules, down and across", async () => {
	const p = await realPage();
	const dsf = 2, expectedPeriod = 28 * dsf;
	try {
		await mountPaper(p, "paper", "grid");
		await p.evaluate(() => (window as any).viewportFixture.growEmpty("paper"));
		for (const target of [0, 20000]) {
			const geo = await p.evaluate(async target => {
				const sc = document.querySelector(".cm-scroller") as HTMLElement;
				sc.scrollTop = target;
				await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
				const r = sc.getBoundingClientRect();
				return { left: r.left, top: r.top, width: r.width, height: r.height, scrollTop: sc.scrollTop, scrollWidth: sc.scrollWidth, scrollHeight: sc.scrollHeight };
			}, target);
			const down = findRuleClusters(await deviceRowGreys(p, { x: Math.round(geo.left + 4), y: Math.round(geo.top + 8), width: 8, height: Math.max(60, Math.floor(geo.height - 16)) }));
			const across = findRuleClusters(await deviceColGreys(p, { x: Math.round(geo.left + 8), y: Math.round(geo.top + 4), width: Math.max(60, Math.floor(geo.width - 16)), height: 8 }));
			const gaps = (cs: RuleCluster[]) => [...new Set(cs.slice(1).map((c, i) => c.start - cs[i]!.start))];
			const note = `[scrollTop ${geo.scrollTop}] scroll ${geo.scrollWidth} x ${geo.scrollHeight}; down ${down.length} gaps ${JSON.stringify(gaps(down))}; across ${across.length} gaps ${JSON.stringify(gaps(across))}`;
			expect(geo.scrollWidth, `premise: the note is wide; ${note}`).toBeGreaterThan(400000);
			expect(geo.scrollTop, `premise: the scroller reached ${target}; ${note}`).toBeCloseTo(target, 0);
			expect.soft(down.length, `${note} - horizontal rules found`).toBeGreaterThanOrEqual(10);
			expect.soft(across.length, `${note} - vertical rules found`).toBeGreaterThanOrEqual(10);
			expect.soft(gaps(down), `${note} - horizontal rule gaps`).toEqual([expectedPeriod]);
		}
	} finally {
		await p.close();
	}
});

/**
 * FRESH MOUNT: a note that has just opened has not taken the viewport over,
 * and its first pinch does so in its first preview frame. That first pinch
 * writes no paper property on a preview frame either, and its commit moves
 * neither pitch nor phase, a short one (1.0 -> 0.86) or a longer one (1.0 -> 0.8). Each arm on its own freshly mounted page, with no
 * commit before it.
 */
it("FRESH MOUNT: the first pinch after a note opens writes no paper property on a preview frame, and its commit keeps the pitch and puts the phase on the new grid", async () => {
	const arms: { label: string; endRatio: number }[] = [
		{ label: "1.0 -> 0.86", endRatio: 0.86 },
		{ label: "1.0 -> 0.8", endRatio: 0.8 },
	];
	for (const { label, endRatio } of arms) {
		const p = await browser.newPage();
		try {
			await mountPaper(p);
			const taken = await p.evaluate(() => (document.querySelector(".cm-editor") as HTMLElement).classList.contains("handwriting-note-viewport"));
			expect(taken, `[${label}] the note has not taken the viewport over before its first pinch`).toBe(false);
			const r = await pinchWriteProbe(p, "paper", geometricRatios(endRatio), "none");
			expect.soft(r.previewWrites, `[${label}] finalZoom=${r.finalZoom} - paper-property writes during the first pinch after mount`).toBe(0);
			expect.soft(r.commitPitchPhase, `[${label}] finalZoom=${r.finalZoom} - pitch changes at its commit`).toBe(0);
			expect.soft(r.commitPhase, `[${label}] finalZoom=${r.finalZoom} - phase changes at its commit`).toBeLessThanOrEqual(1);
		} finally {
			await p.close();
		}
	}
});

/**
 * AT REST: the rules are anchored to the note origin at 100 percent in the
 * states a note is most often seen in, not only right after a zoom commit: (A) freshly
 * opened and never zoomed; (B) zoomed to 10 percent, then Reset to 100
 * percent (Reset commits at 1 and keeps the viewport taken over); (C) the same
 * view switching to another note, which releases the viewport. Each arm
 * asserts the state it names before it reads. The phase reads are soft, so
 * one run reports every arm. Rule END vs the note origin, as SPACING reads it.
 */
it("AT REST: the rules are anchored to the note origin at 100 percent when fresh, after Reset, and after the view switches notes", async () => {
	const p = await realPage();
	const dsf = 2, pitch = 28;
	try {
		await mountPaper(p);
		const read = async (label: string) => {
			await p.evaluate(async () => { for (let i = 0; i < 4; i++) await (window as any).viewportFixture.settle(); });
			const geo = await p.evaluate(() => {
				const host = document.querySelector(".cm-editor") as HTMLElement, sc = document.querySelector(".cm-scroller")!, line = document.querySelector(".cm-line") as HTMLElement;
				const r = sc.getBoundingClientRect();
				return {
					scrollerTop: r.top, scrollerLeft: r.left, scrollerHeight: r.height, lineTop: line.getBoundingClientRect().top,
					taken: host.classList.contains("handwriting-note-viewport"), zoom: (window as any).viewportFixture.snap("paper").state.zoom,
					vars: ["--handwriting-paper-pitch", "--handwriting-paper-rule", "--handwriting-paper-phase"].map(k => host.style.getPropertyValue(k)).join("|"),
				};
			});
			const clip = { x: Math.round(geo.scrollerLeft + 4), y: Math.round(geo.scrollerTop), width: 8, height: Math.min(400, Math.max(60, Math.floor(geo.scrollerHeight - 10))) };
			const clusters = findRuleClusters(collapseToScreenRows(await deviceRowGreys(p, clip), dsf));
			const origin = geo.lineTop - geo.scrollerTop;
			const expected = ((origin % pitch) + pitch) % pitch;
			const end = clusters.length ? (((clusters[0]!.start + clusters[0]!.length) % pitch) + pitch) % pitch : Number.NaN;
			const raw = Math.abs(end - expected), off = Math.min(raw, pitch - raw);
			return { label, geo, clusters: clusters.slice(0, 4), expected, end, off };
		};

		const a = await read("fresh");
		expect(a.geo.taken, "A premise: a freshly opened note has not taken the viewport over").toBe(false);
		expect(a.geo.zoom, "A premise: at 100 percent").toBeCloseTo(1, 6);
		expect.soft(a.off, `A fresh, never zoomed: rule end ${a.end} vs note origin ${a.expected}; ${JSON.stringify(a)}`).toBeLessThanOrEqual(0.5);

		await p.evaluate(() => (window as any).edgeAudit.commit("paper", 0.1));
		await p.getByRole("button", { name: "Reset note zoom to 100%", exact: true }).click();
		const b = await read("after Reset");
		expect(b.geo.zoom, "B premise: Reset returned to 100 percent").toBeCloseTo(1, 6);
		expect(b.geo.taken, "B premise: Reset commits at 1 and keeps the viewport taken over (no release)").toBe(true);
		expect.soft(b.off, `B after Reset: rule end ${b.end} vs note origin ${b.expected}; ${JSON.stringify(b)}`).toBeLessThanOrEqual(0.5);

		await p.evaluate(() => (window as any).viewportFixture.switchPath("paper", "paper-switched.md"));
		const c = await read("after switching notes");
		expect(c.geo.taken, "C premise: switching notes released the viewport").toBe(false);
		expect.soft(c.off, `C after the view switched notes: rule end ${c.end} vs note origin ${c.expected}; ${JSON.stringify(c)}`).toBeLessThanOrEqual(0.5);
	} finally {
		await p.close();
	}
});

type PaperVars = { taken: boolean; pitch: string; rule: string; phase: string };

/** The paper properties as the host's style resolves them (inline, else
 * inherited, else "" for the stylesheet's own fallback), and whether the
 * viewport is taken over. Runs in the page; `host` is the editor root. */
const readPaperVars = (host: HTMLElement): PaperVars => {
	const cs = getComputedStyle(host);
	return {
		taken: host.classList.contains("handwriting-note-viewport"),
		pitch: cs.getPropertyValue("--handwriting-paper-pitch").trim(),
		rule: cs.getPropertyValue("--handwriting-paper-rule").trim(),
		phase: cs.getPropertyValue("--handwriting-paper-phase").trim(),
	};
};

/**
 * AFTER A RELEASE, FIRST FRAME: a note switch hands the viewport back and takes
 * the overlay's own paper values off the editor. The note it opens must still
 * paint its first frame with the paper at the text's size at rest, not the
 * stylesheet's 28 px fallback: at 24 px text a 42 px pitch before and after,
 * and the rule the 1.5 px literal at 100 percent (10 px at the 10 percent the
 * previous note was left at, the one-device-px floor on this dpr 1 browser). Read inside the first animation
 * frame after the switch, and again once that frame's remaining work has run,
 * before the next frame.
 */
it("AFTER A RELEASE: the first frame after a note switch paints the paper at the text's size, not the fallback", async () => {
	const p = await browser.newPage();
	try {
		await mountPaper(p);
		await p.evaluate(async () => { await (window as any).viewportFixture.fontPx("paper", 24); await (window as any).edgeAudit.commit("paper", 0.1); });
		const before = await p.evaluate(`(${readPaperVars})(document.querySelector(".cm-editor"))`) as PaperVars;
		expect(before.taken, `premise: the commit took the viewport over; ${JSON.stringify(before)}`).toBe(true);
		expect([before.pitch, before.rule], `premise: the paper at 24 px text, 10 percent; ${JSON.stringify(before)}`).toEqual(["42px", "10.15625px"]);
		const frames = await p.evaluate(`(async () => {
			const read = ${readPaperVars};
			const host = document.querySelector(".cm-editor");
			const switched = window.viewportFixture.switchPath("paper", "paper-switched.md");
			const first = await new Promise(resolve => requestAnimationFrame(() => {
				const inFrame = read(host);
				const channel = new MessageChannel();
				channel.port1.onmessage = () => resolve({ inFrame, afterFrame: read(host) });
				channel.port2.postMessage(0);
			}));
			await switched;
			return { ...first, settled: read(host) };
		})()`) as { inFrame: PaperVars; afterFrame: PaperVars; settled: PaperVars };
		const report = JSON.stringify({ before, ...frames });
		expect(frames.settled.taken, `premise: switching notes released the viewport; ${report}`).toBe(false);
		for (const at of ["inFrame", "afterFrame"] as const) {
			expect.soft(frames[at].pitch, `${at}: pitch in the switched note's first frame; ${report}`).toBe("42px");
			expect.soft(frames[at].rule, `${at}: rule in the switched note's first frame, at rest at 100 percent; ${report}`).toBe("1.5px");
		}
	} finally {
		await p.close();
	}
});

/**
 * AFTER A RELOAD: the paper properties live on the editor, which outlives the
 * overlay. A plugin reload destroys the overlay and mounts a new one on the
 * same editor. Four arms, each on its own page:
 * - reloaded at 20 px text: the new overlay plans 28 x 20 / 16 = 35 px, from
 *   the text's size, not from the size it happened to mount at;
 * - the text changed from 20 px back to 16 px while the overlay was away: the
 *   new overlay plans 28 px, not the 35 px the old one left behind as if the
 *   host had set it;
 * - a host's own pitch (inline, with a priority), reloaded at rest, and
 * - the same, reloaded while zoomed to 10 percent: the host's value survives
 *   byte for byte, so taking the overlay's values off never takes the host's.
 */
it("AFTER A RELOAD: a new overlay on the same editor plans the paper at the text's size, and a host's own paper value survives", async () => {
	const HOST_PITCH = "31px";
	const arms: { label: string; fontPx: number; fontPxWhileAway?: number; hostOwned: boolean; zoomed: boolean; pitch: string; rule: string }[] = [
		{ label: "reloaded at 20 px text", fontPx: 20, hostOwned: false, zoomed: false, pitch: "35px", rule: "1.25px" },
		{ label: "text back to 16 px while the overlay was away", fontPx: 20, fontPxWhileAway: 16, hostOwned: false, zoomed: false, pitch: "28px", rule: "1px" },
		{ label: "host-owned pitch, reloaded at rest", fontPx: 16, hostOwned: true, zoomed: false, pitch: HOST_PITCH, rule: "1px" },
		{ label: "host-owned pitch, reloaded while zoomed", fontPx: 16, hostOwned: true, zoomed: true, pitch: HOST_PITCH, rule: "1px" },
	];
	for (const { label, fontPx, fontPxWhileAway, hostOwned, zoomed, pitch, rule } of arms) {
		const p = await browser.newPage();
		try {
			await mountPaper(p);
			if (fontPx !== 16) await p.evaluate(px => (window as any).viewportFixture.fontPx("paper", px), fontPx);
			if (hostOwned) await p.evaluate(pitch => { (document.querySelector(".cm-editor") as HTMLElement).style.setProperty("--handwriting-paper-pitch", pitch, "important"); }, HOST_PITCH);
			if (zoomed) await p.evaluate(() => (window as any).edgeAudit.commit("paper", 0.1));
			const before = await p.evaluate(`(${readPaperVars})(document.querySelector(".cm-editor"))`) as PaperVars;
			const reloaded = await p.evaluate(async away => {
				const r = await (window as any).viewportFixture.reloadOverlay("paper", away ?? undefined);
				for (let i = 0; i < 4; i++) await (window as any).viewportFixture.settle();
				const host = document.querySelector(".cm-editor") as HTMLElement;
				return {
					newInstance: r.newInstance as boolean,
					zoom: (window as any).viewportFixture.snap("paper").state.zoom as number,
					inlinePitch: host.style.getPropertyValue("--handwriting-paper-pitch"),
					inlinePitchPriority: host.style.getPropertyPriority("--handwriting-paper-pitch"),
				};
			}, fontPxWhileAway ?? null);
			const after = await p.evaluate(`(${readPaperVars})(document.querySelector(".cm-editor"))`) as PaperVars;
			const report = JSON.stringify({ label, before, reloaded, after });
			// Premises are soft, so one arm's failed premise cannot hide the other arms' results.
			if (!hostOwned) expect.soft(before.pitch, `[${label}] premise: the paper at ${fontPx} px text before the reload; ${report}`).toBe(`${28 * fontPx / 16}px`);
			expect.soft(reloaded.newInstance, `[${label}] premise: a new overlay instance is mounted on the same editor; ${report}`).toBe(true);
			expect.soft(reloaded.zoom, `[${label}] premise: the new overlay is at 100 percent; ${report}`).toBeCloseTo(1, 6);
			expect.soft(after.taken, `[${label}] premise: the new overlay has not taken the viewport over; ${report}`).toBe(false);
			if (hostOwned) expect.soft([reloaded.inlinePitch, reloaded.inlinePitchPriority], `[${label}] the host's own pitch and its priority survive the reload; ${report}`).toEqual([HOST_PITCH, "important"]);
			else expect.soft(after.pitch, `[${label}] pitch after the reload; ${report}`).toBe(pitch);
			expect.soft(after.rule, `[${label}] rule after the reload; ${report}`).toBe(rule);
		} finally {
			await p.close();
		}
	}
});
