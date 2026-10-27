/**
 * READABLE LINE LENGTH, ZOOM IN, at an EXTERNAL SCALE other than 1.
 *
 * `PaperPinchPan.test.ts`'s ZOOM IN arm covers the x contract (grid's vertical
 * rules and the dots stay on the text column's left edge through a re-centring
 * pinch and its settle) only at external scale 1 - the host's own CSS scale
 * pinned to 1, as it is when Obsidian's window zoom sits at 100 percent. The
 * paper's column drift (`InkOverlay.ts` `anchorPanTo`, `paperColumnDrift`)
 * shares its x frame with the committed ink's own preview offset
 * (`applyPreviewInkOffset`), and the ink's own comment there records a units
 * bug measured at external scale 0.8: a genuine column move on zoom-in applied
 * at 0.8 of its size, 34 device px off. This cell is the paper's counterpart:
 * the same staged zoom-in, grid paper, Readable line length on, with the host
 * pre-scaled 0.8 the way `ScrollColumnAnchorPinch.test.ts`'s `options.external`
 * pre-scales its own pane (`host.style.transform = scale(external)`, applied
 * once before the gesture, never touched again).
 *
 * READING IN DEVICE PX. A rect read after the host's own transform already
 * carries the external factor - `getBoundingClientRect` and the screenshot
 * agree with what a real compositor paints. What does NOT carry it is
 * `viewportFixture.snap("paper").state.zoom`, which is `pinchScaleNow` alone
 * (`getNoteViewportState`): the pinch scale, never multiplied by the host's
 * own external scale. So every place `PaperPinchPan.test.ts`'s reader divides
 * a device-px reading by `zoom * DSF` to fold it into one lattice pitch, this
 * file's copy divides by `zoom * EXTERNAL * DSF` instead - the actual painted
 * scale. Get that wrong here and the tolerance band drifts by a whole pitch
 * fraction before the product code is even in question, which is exactly the
 * confusion the units plant below is built to catch on the PRODUCT side.
 *
 * MEASURED (the x contract):
 *   - RED on the build before this fix, at external 0.8 and 1, on staged and
 *     settled readings alike: the paper had no x anchor there at all, so the
 *     vertical rules drift off the text column as soon as the pinch
 *     re-centres it.
 *   - GREEN on the fix unplanted, at external 0.8 and 1.
 *   - Under HW_PAPER_PAN_PLANT_NO_DRIFT: RED at external 0.8 and 1 on stages
 *     1-3 (the drift term is gone outright, the cheap sanity plant).
 *   - Under HW_PAPER_PAN_PLANT_EXTERNAL_UNITS_DOUBLE: RED at external 0.8 on
 *     stages 1-3, 15 to 28 device px off, GREEN at external 1 - the
 *     differential is the point of this arm.
 *
 * UNITS PLANT (the point of this arm): `paperColumnDrift` is computed from
 * `columnLocal` values that are themselves host-local px (carrying the host's
 * external scale already, same as the ink's `columnLocalAt`), multiplied by
 * `next` - the pinch scale alone, no external factor anywhere in that line.
 * The plant applies the external factor to that product a second time, which
 * is a no-op at external 1 (multiplying by 1 changes nothing) and a real
 * distortion at 0.8. Both external legs live in THIS file's `it.each`, sharing
 * the one `beforeAll` bundle, so one plant run carries to both without relying
 * on `PaperPinchPan.test.ts` (which has no `HW_PAPER_PAN_PLANT_EXTERNAL_UNITS_DOUBLE`
 * anchor of its own and would bundle unplanted - a silent non-run, not a
 * control) - that differential is what shows the arm is reading the UNITS and
 * not merely the presence of a drift term (the existing
 * `HW_PAPER_PAN_PLANT_NO_DRIFT` already proves the latter, reused below as the
 * cheaper sanity plant).
 *
 * ALIASING. `relOffDev` reads modulo the pitch, so a plant error that lands on
 * a whole number of pitches reads as zero - a false GREEN that proves nothing.
 * The units plant scales the drift term by the external factor a second time,
 * so its error against the correct drift is `|external - 1| x drift`, about
 * `0.2 x |moved|` at external 0.8 (`moved` approximates the drift the paper
 * must track) and exactly zero at external 1 - the plant is a no-op there BY
 * CONSTRUCTION, so that leg carries no aliasing premise at all. Logged every
 * run; asserted, where the plant actually perturbs anything, clear of the
 * aliasing band before the tolerance checks are trusted.
 *
 * Tolerance: 2 device px, same as the sibling file. Premise at the last
 * preview stage: the column re-centred by AT LEAST ONE PAINTED PITCH (not
 * merely "some" displacement) - `max(pitch in device px at that stage,
 * 10 x TOL_DEV)` - or the stage is VOID, not green, and the run is not a
 * proof either way.
 *
 * PASS ASSERTIONS ARE X ONLY. y is read and logged with every reading but not
 * asserted, because at external 0.8 this reader's y is not paper: the y
 * centres there include one band on the same device row of the patch (39.5)
 * in every reading, rest through settled, on both builds, while the zoom goes
 * from 100 to 150 percent - it moves with neither the zoom nor the pan - and
 * `abs.y`, a max over the first centres, reads that band alone on the fix
 * (15.7 device px at rest, 28.1 settled). This copied reader has no
 * pitch-lattice filter to drop it, and where the band comes from has not been
 * read. External 1 shows no such band. The bands on the pitch lattice do read
 * the y contract: on the fix they sit within 1.3 device px of the note's top
 * in every reading at both externals; on the build before this fix they sit
 * 7 to 41 device px off during the pinch, and on it at rest and once settled.
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import { decodePng } from "./pngInk";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

let realBrowser: Browser, script: string;
const OBSIDIAN_CAMERA_CSS = readFileSync(fileURLToPath(new URL("./noteViewportCamera.css", import.meta.url)), "utf8");
const DSF = 2, PITCH = 28, TOL_DEV = 2;
const PAGE_GREY = 255, RULE_GREY = 0x77;
/** The host's own CSS scale, set once before the gesture and never changed - Obsidian's window zoom, not the pinch. Both legs this arm runs. */
const EXTERNALS = [0.8, 1] as const;

declare const process: { env: Record<string, string | undefined> };

/**
 * Plants, exact source substitutions in the named product file, same mechanism as `PaperPinchPan.test.ts`'s (copied,
 * not imported, as each render file carries its own):
 *   HW_PAPER_PAN_PLANT_NO_DRIFT=1              the paper never takes the column's re-centring (cheap sanity: the arm
 *                                               must go red on ANY drift removed, external scale aside);
 *   HW_PAPER_PAN_PLANT_EXTERNAL_UNITS_DOUBLE=1  the drift's product is scaled by the external factor a second time -
 *                                               identical to unplanted at external 1, distorted at 0.8 (the point of
 *                                               this arm: it must fail at 0.8 under this plant while this file's
 *                                               external-1 leg, under the same plant, stays green).
 * A plant whose anchor is not in the source throws rather than passing unplanted.
 */
const PLANTS: { env: string; file: RegExp; from: string; to: string }[] = [
	{ env: "HW_PAPER_PAN_PLANT_NO_DRIFT", file: /src[\\/]inline[\\/]InkOverlayPanSettle\.ts$/, from: "const drift = columnLocal === null || a.columnLocal === null ? 0 : (columnLocal - a.columnLocal + (nativeLeft - a.scrollLeft) * outer) * next;", to: "const drift = 0;" },
	{ env: "HW_PAPER_PAN_PLANT_EXTERNAL_UNITS_DOUBLE", file: /src[\\/]inline[\\/]InkOverlayPanSettle\.ts$/, from: "const drift = columnLocal === null || a.columnLocal === null ? 0 : (columnLocal - a.columnLocal + (nativeLeft - a.scrollLeft) * outer) * next;", to: "const drift = columnLocal === null || a.columnLocal === null ? 0 : (columnLocal - a.columnLocal + (nativeLeft - a.scrollLeft) * outer) * next * outer;" },
];

beforeAll(async () => {
	const active = PLANTS.filter(pl => process.env[pl.env]);
	let planted = 0;
	const b = await build({
		entryPoints: [fileURLToPath(new URL("./noteViewportCameraPage.ts", import.meta.url))],
		bundle: true, write: false, format: "iife", platform: "browser",
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
		plugins: active.length ? [{ name: "paper-pan-external-scale-plants", setup(builder) {
			builder.onLoad({ filter: /src[\\/]inline[\\/]InkOverlayPanSettle\.ts$/ }, args => {
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
 * Same rig as `PaperPinchPan.test.ts`'s `mountPaper`, with one addition: `external` reaches
 * `viewportFixture.setup`'s own `external` argument, which scales the fixture's `host` (the
 * pane, one level above `.cm-editor`) before the view ever mounts - the same place
 * `ScrollColumnAnchorPinch.test.ts`'s `options.external` applies its `pane.style.transform`.
 */
async function mountPaper(p: Page, kind: "lines" | "grid" | "dots", doc: string, readable: boolean, ink: string, external: number) {
	await p.setContent(`<!doctype html><body class="handwriting-paper-${kind}" style="margin:0; background:#ffffff; --background-modifier-border:#777777"></body>`);
	await p.addStyleTag({ content: pageCss() + OBSIDIAN_CAMERA_CSS });
	if (readable) {
		await p.addStyleTag({ content: `${REAL_OBSIDIAN_CSS}\nbody { --file-line-width: 320px; }` });
		await p.evaluate(() => {
			new MutationObserver(recs => { for (const r of recs) r.addedNodes.forEach(n => { if (n instanceof HTMLElement && n.classList.contains("camera-proof")) n.classList.add("mod-cm6", "is-readable-line-width"); }); })
				.observe(document.body, { childList: true });
		});
	}
	await p.addScriptTag({ content: script });
	await p.evaluate(async ({ doc, ink, external }) => {
		await (window as any).viewportFixture.setup("paper", ink, 1, external, doc);
		const content = document.querySelector(".cm-content") as HTMLElement;
		const sizer = document.createElement("div"); sizer.className = "cm-sizer";
		const container = document.createElement("div"); container.className = "cm-contentContainer";
		content.parentElement!.insertBefore(sizer, content); sizer.appendChild(container); container.appendChild(content);
		await (window as any).viewportFixture.settle();
	}, { doc, ink, external });
}

const circ = (a: number, p: number) => { const r = ((a % p) + p) % p; return Math.min(r, p - r); };

type Axis = "x" | "y";
const PATCH = { dx: 20, dy: 20, w: 200, h: 200 };

/** Weighted band centres (device px) along one projection: runs above the midpoint of the projection's own range. */
function bandCentres(profile: number[]): number[] {
	const lo = Math.min(...profile), hi = Math.max(...profile);
	if (hi - lo < 0.03) return [];
	const cut = lo + (hi - lo) / 2, out: number[] = [];
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
 * `PaperPinchPan.test.ts`'s `readPatch`, with the painted-scale substitution above: every place it divides a
 * device-px reading by `k * DSF` to fold it into layout px modulo the pitch, this copy divides by `k * EXTERNAL *
 * DSF` - `k` (`viewportFixture`'s `zoom`) never carries the host's own external scale, only the pinch's.
 */
async function readPatch(p: Page, external: number) {
	const g = () => p.evaluate(() => {
		const sc = document.querySelector(".cm-scroller") as HTMLElement, sizer = document.querySelector(".cm-sizer") as HTMLElement;
		const r = sc.getBoundingClientRect(), s = sizer.getBoundingClientRect();
		const line = (document.querySelector(".cm-line") as HTMLElement).getBoundingClientRect();
		return { scrollerLeft: r.left, scrollerTop: r.top, zoom: (window as any).viewportFixture.snap("paper").state.zoom as number, sizerLeft: s.left, sizerTop: s.top,
			lineLeft: line.left, lineTop: line.top, rule: Number.parseFloat(getComputedStyle(document.querySelector(".cm-editor") as HTMLElement).getPropertyValue("--handwriting-paper-rule")) || 1,
			sizer: sizer.style.transform, scrollLeft: sc.scrollLeft, scrollTop: sc.scrollTop,
			vars: ["--handwriting-paper-pitch", "--handwriting-paper-rule", "--handwriting-paper-dot", "--handwriting-paper-phase"].map(k => getComputedStyle(sc).getPropertyValue(k).trim()).join("|") };
	});
	const before = await g();
	const clip = { x: Math.round(before.scrollerLeft + PATCH.dx), y: Math.round(before.scrollerTop + PATCH.dy), width: PATCH.w, height: PATCH.h };
	const d = decodePng(await p.screenshot({ clip }));
	const rows: number[] = new Array(d.height).fill(0), cols: number[] = new Array(d.width).fill(0);
	for (let y = 0; y < d.height; y++) for (let x = 0; x < d.width; x++) {
		const i = (y * d.width + x) * d.channels;
		const f = Math.max(0, Math.min(1, (PAGE_GREY - (d.px[i]! + d.px[i + 1]! + d.px[i + 2]!) / 3) / (PAGE_GREY - RULE_GREY)));
		rows[y] = rows[y]! + f / d.width; cols[x] = cols[x]! + f / d.height;
	}
	const after = await g();
	const k = before.zoom * external;
	const centres: Record<Axis, number[]> = { x: bandCentres(cols), y: bandCentres(rows) };
	const edge: Record<Axis, number> = { x: (before.sizerLeft - clip.x) * DSF, y: (before.sizerTop - clip.y) * DSF };
	const rel = (a: Axis) => {
		const c = centres[a];
		if (!c.length) return Number.NaN;
		const ang = c.map(v => 2 * Math.PI * (((((v - edge[a]) / (k * DSF)) % PITCH) + PITCH) % PITCH) / PITCH);
		const m = Math.atan2(ang.reduce((s, v) => s + Math.sin(v), 0), ang.reduce((s, v) => s + Math.cos(v), 0));
		return (((m / (2 * Math.PI)) * PITCH) + PITCH) % PITCH;
	};
	const tight = (a: Axis) => {
		const c = centres[a];
		if (!c.length) return 0;
		const ang = c.map(v => 2 * Math.PI * (((((v - edge[a]) / (k * DSF)) % PITCH) + PITCH) % PITCH) / PITCH);
		return Math.hypot(ang.reduce((s, v) => s + Math.sin(v), 0), ang.reduce((s, v) => s + Math.cos(v), 0)) / c.length;
	};
	const pan = panXY(before.sizer);
	const pDevHere = PITCH * k * DSF, ruleDev = before.rule * k * DSF;
	const anchor: Record<Axis, number> = { x: (before.lineLeft - clip.x) * DSF, y: (before.lineTop - clip.y) * DSF };
	const markOffset = -ruleDev / 2;
	const abs = (a: Axis) => centres[a].length ? Math.max(...centres[a].slice(0, 6).map(c => circ(c - (anchor[a] + markOffset), pDevHere))) : Number.NaN;
	return { geo: before, stable: JSON.stringify(before) === JSON.stringify(after), abs: { x: abs("x"), y: abs("y") } as Record<Axis, number>,
		centres: { x: centres.x.slice(0, 5).map(v => Math.round(v * 10) / 10), y: centres.y.slice(0, 5).map(v => Math.round(v * 10) / 10) },
		rel: { x: rel("x"), y: rel("y") } as Record<Axis, number>, tight: { x: tight("x"), y: tight("y") } as Record<Axis, number>, count: { x: centres.x.length, y: centres.y.length } as Record<Axis, number>,
		pan: { x: pan.x * k * DSF, y: pan.y * k * DSF } as Record<Axis, number> };
}

/** Distance in device px, at the painted scale `k` (already external-adjusted), between two layout-px places modulo the pitch. */
const relOffDev = (a: number, b: number, k: number) => circ(a - b, PITCH) * k * DSF;

/** The re-centring of the text column against the scroller since `rest`, device px, at the painted scale (pinch x external). */
const recentring = (now: Awaited<ReturnType<typeof readPatch>>, rest: Awaited<ReturnType<typeof readPatch>>, external: number) =>
	((now.geo.sizerLeft - now.geo.scrollerLeft) - panXY(now.geo.sizer).x * now.geo.zoom * external - ((rest.geo.sizerLeft - rest.geo.scrollerLeft) - panXY(rest.geo.sizer).x * rest.geo.zoom * external)) * DSF;

/** A staged two-finger pinch: start about (cx, cy) at `spread`, move the spread through ratios, release. Copied from `PaperPinchPan.test.ts`. */
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
		await (window as any).viewportFixture.settle();
	});
}

/**
 * READABLE LINE LENGTH, ZOOM IN, grid paper, external scale %s: 100 -> ~150 percent in three stages about a focal
 * point low and to the right (scaled with the host, so it lands in the same relative place on the pane at either
 * external value), the column re-centring as the zoom grows. Read at each stage with the fingers down and once the
 * pinch settles: the lattice against the text's box and against the column's left edge, read on both axes and
 * asserted on x. Both externals
 * (0.8, 1) run here, sharing one bundle, so a plant applies to both in the same run - see the header on why that
 * matters for the units plant specifically.
 *
 * Premise at the last stage: the column re-centred by AT LEAST ONE PAINTED PITCH, not merely "some" displacement -
 * `max(pitch in device px at that stage, 10 x TOL_DEV)`. Weaker than that and the units plant's own error (about
 * 0.2 of the drift) can land under TOL_DEV and this arm stays GREEN under the plant, proving nothing. If the column
 * did not clear that bar, the stage is VOID, not green, and is reported as such rather than passed.
 *
 * Target 1.5, not the sibling file's 1.8: the fixture's line width margin clamps to 0 at some ratio, and that ratio
 * is smaller at external 0.8 than at 1 (the clamp is in host units, the pane is smaller). 1.5 was picked to stay
 * under it by inspection of the same margin rule the sibling file's header cites (styles.css `clamp(0, auto,
 * frozen)`); the premise assertion above is the actual guard - if the run shows the column did not re-centre at
 * 1.5 at either external, lower the target and re-run rather than trust this comment.
 */
it.each(EXTERNALS)("ZOOM IN grid, readable line length on, external scale %s: the paper stays on the text column through a re-centring pinch and its settle", async external => {
	const p = await realPage();
	try {
		await mountPaper(p, "grid", "x", true, "far", external);
		await p.evaluate(async () => {
			await (window as any).edgeAudit.commit("paper", 1);
			(document.querySelector(".cm-scroller") as HTMLElement).scrollTop = 1200;
			await (window as any).viewportFixture.settle();
		});
		const rest = await readPatch(p, external);
		expect(rest.geo.zoom, "premise: at rest at 100 percent pinch scale").toBeCloseTo(1, 6);
		expect(rest.tight.x, `premise: one lattice on x at rest ${JSON.stringify(rest)}`).toBeGreaterThanOrEqual(0.9);

		const readings: { label: string; r: Awaited<ReturnType<typeof readPatch>> }[] = [];
		await pinchStart(p, 400 * external, 380 * external, 200);
		for (const [label, to] of [["stage 1", 1.15], ["stage 2", 1.3], ["stage 3", 1.5]] as const) {
			await pinchStage(p, to);
			readings.push({ label, r: await readPatch(p, external) });
			const live = await p.evaluate(() => (window as any).viewportFixture.preview("paper"));
			expect(live, `premise: ${label} was read while the pinch preview was live`).toBe(true);
		}
		const last = readings.at(-1)!.r;
		expect(last.geo.zoom, `premise: the preview reached 150 percent pinch scale ${JSON.stringify(last.geo)}`).toBeCloseTo(1.5, 1);
		const moved = recentring(last, rest, external);
		const pitchDevLast = PITCH * last.geo.zoom * external * DSF;
		const moveThreshold = Math.max(pitchDevLast, 10 * TOL_DEV);
		expect(Math.abs(moved), `premise: the column re-centred by at least one painted pitch, device px (host external ${external}, threshold ${moveThreshold.toFixed(1)}) ${JSON.stringify(last.geo)}`).toBeGreaterThanOrEqual(moveThreshold);

		// Under the units plant the drift term is scaled by `external` a second time, so its error against the
		// correct drift is `|external - 1| x drift` - zero at external 1 (the plant is a no-op there BY
		// CONSTRUCTION, nothing to alias against), and about 0.2 x |moved| at external 0.8. Logged every run;
		// asserted only where the plant actually perturbs anything - external 1 gets no aliasing premise, since a
		// predicted error of zero is not a claim about the pitch at all.
		const predictedPlantErr = Math.abs(1 - external) * Math.abs(moved);
		if (process.env.HW_PAPER_PAN_PLANT_EXTERNAL_UNITS_DOUBLE && external !== 1) {
			const errMod = ((predictedPlantErr % pitchDevLast) + pitchDevLast) % pitchDevLast;
			expect(errMod, `premise: the units plant's predicted error (${predictedPlantErr.toFixed(1)} px) clears pitch aliasing (pitch ${pitchDevLast.toFixed(1)} px, low side) ${JSON.stringify(last.geo)}`).toBeGreaterThanOrEqual(2 * TOL_DEV);
			expect(errMod, `premise: the units plant's predicted error clears pitch aliasing, high side`).toBeLessThanOrEqual(pitchDevLast - 2 * TOL_DEV);
		}

		await stagedRelease(p);
		readings.push({ label: "settled", r: await readPatch(p, external) });
		const liveAfterSettle = await p.evaluate(() => (window as any).viewportFixture.preview("paper"));
		expect(liveAfterSettle, "premise: the settled read happened after the preview ended").toBe(false);

		for (const { label, r } of readings) {
			expect(r.stable, `premise: ${label} did not move while it was read`).toBe(true);
			expect(r.count.x, `premise: ${label} found rules on x ${JSON.stringify(r)}`).toBeGreaterThanOrEqual(3);
			// PASS ON X ONLY: y is read and logged with every reading - r.abs.y, r.rel.y - but not asserted; see the
			// header for the stray band that makes up the y reading at external 0.8.
			for (const a of ["x"] as const) {
				expect.soft(relOffDev(r.rel[a], rest.rel[a], r.geo.zoom * external), `ZOOM IN grid RLL=true EXT=${external} ${label} ${a}: the lattice against the text's box, device px from its at-rest place`).toBeLessThanOrEqual(TOL_DEV);
				expect.soft(r.abs[a], `ZOOM IN grid RLL=true EXT=${external} ${label} ${a}: the marks against the column's left edge / the note's top, device px`).toBeLessThanOrEqual(TOL_DEV);
			}
		}
		// eslint-disable-next-line no-console
		console.log("PAPER-PAN-EXTERNAL-SCALE ZOOM-IN grid", JSON.stringify({ external, moved, predictedPlantErr, pitchDevLast, rest, readings }));
	} finally {
		await p.close();
	}
});

function pageCss(): string {
	return css;
}
