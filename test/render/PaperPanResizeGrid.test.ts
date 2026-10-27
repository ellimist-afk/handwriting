/**
 * A WINDOW RESIZE WITH GRID PAPER: the paper stays on the text column through
 * a resize, not only through a pinch. `PaperPinchPan.test.ts` (this fixture's
 * source) covers the paper against LINES/GRID/DOTS live pinch frames, AT
 * REST, ZOOM IN/OUT and SETTLE FRAMES, but every one of those reads a
 * gesture; none of them changes the editor pane's width and reads the paper
 * against the column afterward.
 *
 * THE RESIZE TARGET: `.cm-editor` is the
 * zoom host, and once the note viewport owns it (`edgeAudit.commit` below),
 * its OWN width is one of the properties `applyViewportBox` (InkOverlay.ts)
 * writes every time `handleResize` fires - so writing it from the test races
 * the plugin's own writes and skips the path a real window resize actually
 * takes: the CONTAINER resizes (`.cm-editor`'s `parentElement`, i.e. the
 * `[data-rig]` host `viewportFixture.setup` creates) -> that element's
 * ResizeObserver -> `handleResize` -> `applyViewportBox`, which then re-lays
 * `.cm-editor` out to match. This arm resizes the CONTAINER only. Both terms
 * of the column's margin follow a resize (the live "auto" term and the
 * "frozen" term `applyViewportBox` re-measures), so the natural column moves;
 * premises 1 and 2 below check that the plugin took the resize and that the
 * column moved before anything downstream of them is trusted.
 *
 * THE PAPER'S OWN FOLLOWING MECHANISM is separate from the column's margin:
 * `capturePaperOrigin` (InkOverlay.ts) re-measures the text origin's left
 * edge on every extent update (resize included, via `handleResize` ->
 * `updateExtent`) and re-plans the paper's phase-x only when that edge
 * really moved. A resize is a path into that same function that no existing
 * cell drives; this arm does.
 *
 * READING: the grid lattice against the text column's left edge, in device
 * px (`readPatch`'s `abs.x`, copied from PaperPinchPan.test.ts - see below).
 * The contract: that offset stays within 1 device px of its value before
 * the first resize, on every stage, whether or not that particular stage's
 * resize actually moved the column.
 *
 * Y IS LOGGED, NOT ASSERTED: at 520px the y reading finds one band more than
 * at rest (count.y 7 -> 8), loses its lattice (tight.y .80) and reads
 * 20.006017157234055 device px off its rest value - identically, to fifteen
 * significant figures, on the build before this fix and on the fix. A reading
 * that cannot tell the two apart is not a guard. This reader has no
 * pitch-lattice filter and logs no band centres, so which band that is has
 * not been read; the same signature in PaperPanExternalScaleZoomIn.test.ts is
 * a band that moves with neither the zoom nor the pan, not paper. y is still
 * read and logged every run.
 *
 * PREMISES (checked before anything is asserted; none of these is certain
 * going in - all logged, none trusted from a worked guess alone):
 * 1. THE PLUGIN TOOK THE RESIZE: after each stage, the scroller's clientWidth
 *    moved by the container's own width delta (within 2 css px) and
 *    `.cm-editor`'s inline width was rewritten (not left stale) - or the test
 *    resized a container the plugin never measured from.
 * 2. THE COLUMN ACTUALLY MOVED: the text column's left edge (against the
 *    scroller) moved by at least one painted pitch, vs rest, on some stage -
 *    otherwise a resize cell that never resized anything meaningful would
 *    pass by doing nothing.
 * 3. THE MOVE CLEARS THE READER'S OWN ALIASING FLOOR: `abs.x` is a circular
 *    mean modulo the pitch, so a move that lands close to a whole number of
 *    pitches would look like no change even on a broken build. For the
 *    stage that satisfies premise 2, `d = circ(move in layout px, PITCH) x
 *    DSF x zoom` must clear `2 x RESIZE_TOL_DEV + 1` device px, logged
 *    either way; a stage that cannot clear this is VOID for this arm's
 *    contract regardless of premise 2, and the fix is a different stage
 *    width, not a looser threshold.
 *
 * MEASURED: both stages (900, 520) clear premises 2 and 3. On the build
 * before this fix, which anchors the grid to the scroller's edge rather than
 * the text column, the offset reads 25 device px at rest and moves by the
 * column's move modulo the pitch - 20 at 900px, 8 at 520px - failing the
 * contract on both stages. On the fix both stages stay within 1 device px,
 * and under the plant below they fail by the same 20 and 8.
 *
 * PLANT: HW_PAPER_RESIZE_PLANT_NO_XREPLAN=1 makes `capturePaperOrigin`'s
 * commit of a detected leftward move conditional on a TEST-CONTROLLED flag
 * (`(globalThis as any).__hwFreezePaperX`), not on "is this the first call".
 * Freezing after the first call would catch the WRONG first:
 * `capturePaperOrigin` already fires once during ordinary mount, before
 * `edgeAudit.commit` below takes the viewport over, so `paperOriginLeft` is
 * already non-null by the time commit's own readable-line-length centring
 * jump needs to land - a freeze keyed on "already set" swallows that jump too
 * and reddens AT REST, before any resize. This plant freezes nothing until
 * the test says so: it sets
 * `window.__hwFreezePaperX = true` AFTER reading `rest` and BEFORE the first
 * resize (below), so every capture up to and including the commit-triggered
 * one still lands normally - AT REST reads ~0 under the plant exactly as
 * unplanted (asserted below, gated on the plant env var only: the build
 * before this fix has no x anchor at all, so its own rest reading is unrelated
 * to this plant and must not be asserted against it). Only resize-triggered captures, which
 * all happen after the flag is set, are skipped - the exact failure mode
 * this arm exists to catch. Unplanted, the planted line does not exist, so
 * setting the flag from the test does nothing either way.
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

let realBrowser: Browser, script: string;
const OBSIDIAN_CAMERA_CSS = readFileSync(fileURLToPath(new URL("./noteViewportCamera.css", import.meta.url)), "utf8");
const DSF = 2, PITCH = 28;
const PAGE_GREY = 255, RULE_GREY = 0x77;
/** The contract's own tolerance, within 1 device px of the pre-resize reading, distinct from the AT REST family's 2 px absolute-to-anchor tolerance. */
const RESIZE_TOL_DEV = 1;
/** Premise 3's aliasing floor: a move whose mod-pitch remainder cannot clear this could pass green by aliasing back near zero, not by the paper truly following the column. */
const ALIAS_FLOOR_DEV = 2 * RESIZE_TOL_DEV + 1;

/**
 * The one plant this arm needs, same mechanism as PaperPinchPan.test.ts's
 * `HW_PAPER_PAN_PLANT_*` family (copied here rather than imported, as each
 * render file carries its own). A plant whose anchor is not in
 * the source throws rather than passing unplanted. The freeze is gated on a
 * test-controlled flag, not on "is this the first call" - see the header.
 */
const PLANTS: { env: string; file: RegExp; from: string; to: string }[] = [
	{ env: "HW_PAPER_RESIZE_PLANT_NO_XREPLAN", file: /src[\\/]inline[\\/]InkOverlayZoomApi\.ts$/, from: "  if(leftMoved)this.paperOriginLeft=left;", to: "  if(leftMoved&&!(globalThis as any).__hwFreezePaperX)this.paperOriginLeft=left;" },
];

beforeAll(async () => {
	const active = PLANTS.filter(pl => process.env[pl.env]);
	let planted = 0;
	const b = await build({
		entryPoints: [fileURLToPath(new URL("./noteViewportCameraPage.ts", import.meta.url))],
		bundle: true, write: false, format: "iife", platform: "browser",
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
		plugins: active.length ? [{ name: "paper-resize-grid-plants", setup(builder) {
			builder.onLoad({ filter: /src[\\/]inline[\\/](InkOverlay|InkOverlayZoomApi|PaperPan)\.ts$/ }, args => {
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
 * Copied from PaperPinchPan.test.ts's `mountPaper` with one addition: the rig
 * host (`[data-rig]`, `.cm-editor`'s own parentElement - the container
 * `applyViewportBox` measures from) is pinned to a known 640px width before
 * the camera takes the viewport over, so the arm's own "640 -> 900 -> 520"
 * stages start from a controlled, reported value rather than whatever the
 * browser's own window happens to give an unconstrained block div.
 */
async function mountPaper(p: Page, kind: "lines" | "grid" | "dots" = "grid", doc = "x", readable = true) {
	await p.setContent(`<!doctype html><body class="handwriting-paper-${kind}" style="margin:0; background:#ffffff; --background-modifier-border:#777777"></body>`);
	await p.addStyleTag({ content: css + OBSIDIAN_CAMERA_CSS });
	if (readable) {
		await p.addStyleTag({ content: `${REAL_OBSIDIAN_CSS}\nbody { --file-line-width: 320px; }` });
		await p.evaluate(() => {
			new MutationObserver(recs => { for (const r of recs) r.addedNodes.forEach(n => { if (n instanceof HTMLElement && n.classList.contains("camera-proof")) n.classList.add("mod-cm6", "is-readable-line-width"); }); })
				.observe(document.body, { childList: true });
		});
	}
	await p.addScriptTag({ content: script });
	await p.evaluate(async ({ doc }) => {
		await (window as any).viewportFixture.setup("paper", "far", 1, 1, doc);
		const content = document.querySelector(".cm-content") as HTMLElement;
		const sizer = document.createElement("div"); sizer.className = "cm-sizer";
		const container = document.createElement("div"); container.className = "cm-contentContainer";
		content.parentElement!.insertBefore(sizer, content); sizer.appendChild(container); container.appendChild(content);
		(document.querySelector('[data-rig="paper"]') as HTMLElement).style.width = "640px";
		await (window as any).viewportFixture.settle();
	}, { doc });
}

const circ = (a: number, p: number) => { const r = ((a % p) + p) % p; return Math.min(r, p - r); };

type Axis = "x" | "y";
const AXES: readonly Axis[] = ["x", "y"];
const PATCH = { dx: 20, dy: 20, w: 200, h: 200 };

/** Weighted band centres (device px) along one projection: runs above the midpoint of the projection's own range. Copied from an earlier PaperPinchPan.test.ts reader, which now cuts at a quarter of the range. */
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

/** Copied from an earlier PaperPinchPan.test.ts grid/dots patch reader, without its pitch-lattice filter. */
async function readPatch(p: Page) {
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
	const k = before.zoom;
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
	const medianGap = (xs: number[]) => { const gs = xs.slice(1).map((v, i) => v - xs[i]!).sort((a, b) => a - b); return gs.length ? gs[Math.floor(gs.length / 2)]! : Number.NaN; };
	const pan = panXY(before.sizer);
	const pDevHere = PITCH * k * DSF, ruleDev = before.rule * k * DSF;
	const anchor: Record<Axis, number> = { x: (before.lineLeft - clip.x) * DSF, y: (before.lineTop - clip.y) * DSF };
	const markOffset = -ruleDev / 2;
	const abs = (a: Axis) => centres[a].length ? Math.max(...centres[a].slice(0, 6).map(c => circ(c - (anchor[a] + markOffset), pDevHere))) : Number.NaN;
	return { geo: before, stable: JSON.stringify(before) === JSON.stringify(after), abs: { x: abs("x"), y: abs("y") } as Record<Axis, number>,
		rel: { x: rel("x"), y: rel("y") } as Record<Axis, number>, tight: { x: tight("x"), y: tight("y") } as Record<Axis, number>, count: { x: centres.x.length, y: centres.y.length } as Record<Axis, number>, pitchDev: { x: medianGap(centres.x), y: medianGap(centres.y) } as Record<Axis, number>,
		pan: { x: pan.x * k * DSF, y: pan.y * k * DSF } as Record<Axis, number> };
}

/** The column's left edge against the scroller's, device px - the same quantity PaperPinchPan.test.ts's AT REST arm reads. */
const columnFromEdge = (r: Awaited<ReturnType<typeof readPatch>>) => (r.geo.lineLeft - r.geo.scrollerLeft) * DSF;

/** One rendered frame. */
const frame = (p: Page) => p.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => r())));

/**
 * Waits until the column's left edge (against the scroller) is unchanged
 * across 2 consecutive rendered frames, up to `maxFrames`; throws if it
 * never settles, rather than reading a frame still in motion.
 */
async function settleColumn(p: Page, maxFrames = 60): Promise<void> {
	let prev: number | null = null, stable = 0;
	for (let i = 0; i < maxFrames; i++) {
		await frame(p);
		const cur = await p.evaluate(() => {
			const line = document.querySelector(".cm-line") as HTMLElement, sc = document.querySelector(".cm-scroller") as HTMLElement;
			return line.getBoundingClientRect().left - sc.getBoundingClientRect().left;
		});
		if (prev !== null && Math.abs(cur - prev) < 0.01) { stable++; if (stable >= 2) return; } else stable = 0;
		prev = cur;
	}
	throw new Error(`the column's left edge never stabilized within ${maxFrames} frames`);
}

/** What premise 1 (the plugin took the resize) reads before and after a container write. */
const resizeProbe = (p: Page) => p.evaluate(() => {
	const editorEl = document.querySelector(".cm-editor") as HTMLElement;
	const scroller = document.querySelector(".cm-scroller") as HTMLElement;
	const rig = document.querySelector('[data-rig="paper"]') as HTMLElement;
	return { editorWidth: editorEl.style.width, scrollerClientWidth: scroller.clientWidth, rigClientWidth: rig.clientWidth };
});

/**
 * Resizes the CONTAINER (`.cm-editor`'s own parentElement, the `[data-rig]`
 * host) to `px`, not `.cm-editor` itself - see the header. Returns the
 * before/after read premise 1 needs: the scroller's clientWidth against the
 * container's own delta, and whether the plugin rewrote `.cm-editor`'s
 * inline width in response.
 */
async function resizeContainer(p: Page, px: number) {
	const before = await resizeProbe(p);
	await p.evaluate(px => { (document.querySelector('[data-rig="paper"]') as HTMLElement).style.width = `${px}px`; }, px);
	await settleColumn(p);
	const after = await resizeProbe(p);
	return { before, after, delta: px - before.rigClientWidth };
}

/** width stages: 640 is `mountPaper`'s own pinned starting width (read as `rest`, no resize call needed to reach it). */
const STAGE_WIDTHS = [900, 520] as const;

it("WINDOW RESIZE, grid paper, readable line length on: the grid stays on the text column's left edge through a resize", async () => {
	const p = await realPage();
	const errors: string[] = [];
	p.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	try {
		await mountPaper(p, "grid", "x", true);
		await p.evaluate(async () => {
			await (window as any).edgeAudit.commit("paper", 1);
			(document.querySelector(".cm-scroller") as HTMLElement).scrollTop = 1200;
			await (window as any).viewportFixture.settle();
		});
		await settleColumn(p);
		const rest = await readPatch(p);
		expect(errors, "no script error before the first read").toEqual([]);
		expect(rest.geo.zoom, "premise: at 100 percent, no pinch in this arm").toBeCloseTo(1, 6);
		for (const a of AXES) {
			expect(rest.count[a], `premise: at least 3 grid marks found on ${a} at rest ${JSON.stringify(rest)}`).toBeGreaterThanOrEqual(3);
			expect(rest.tight[a], `premise: the grid ${a} positions form one lattice at rest ${JSON.stringify(rest)}`).toBeGreaterThanOrEqual(0.9);
		}
		// PLANT SCOPE: the first capture must survive the plant (see header) - but only under the plant. The build before
		// this fix has no x anchor at all (no paperOriginLeft), so rest.abs.x is not near zero there regardless of this
		// arm's resize claim; asserting this unconditionally would fail that build for the wrong reason, before any
		// resize. Every other run (unplanted, either build) just logs it.
		// eslint-disable-next-line no-console
		console.log("PAPER-RESIZE-GRID-REST", JSON.stringify({ plant: !!process.env.HW_PAPER_RESIZE_PLANT_NO_XREPLAN, restAbsX: rest.abs.x, restAbsY: rest.abs.y }));
		if (process.env.HW_PAPER_RESIZE_PLANT_NO_XREPLAN) {
			expect(rest.abs.x, `PLANT SCOPE: at rest, independent of the resize path, the grid still sits on the text column's left edge, device px ${JSON.stringify(rest)}`).toBeLessThanOrEqual(2);
			expect(rest.abs.y, `PLANT SCOPE: at rest, independent of the resize path, the grid still sits on the note's top, device px ${JSON.stringify(rest)}`).toBeLessThanOrEqual(2);
		}
		// The freeze starts here, AFTER rest is read: every capture up to this point (mount's own, and commit's
		// readable-line-length centring jump) still landed normally, planted or not. Harmless on an unplanted build -
		// the planted line does not exist there, so this flag is never read.
		await p.evaluate(() => { (window as any).__hwFreezePaperX = true; });

		const stages: { label: string; width: number; r: Awaited<ReturnType<typeof readPatch>>; probe: Awaited<ReturnType<typeof resizeContainer>> }[] = [];
		for (const width of STAGE_WIDTHS) {
			const probe = await resizeContainer(p, width);
			const r = await readPatch(p);
			expect(errors, `no script error after resizing the container to ${width}px`).toEqual([]);
			expect(r.stable, `premise: the frame did not move while it was read at ${width}px ${JSON.stringify(r.geo)}`).toBe(true);
			for (const a of AXES) {
				expect(r.count[a], `premise: at least 3 grid marks found on ${a} at ${width}px ${JSON.stringify(r)}`).toBeGreaterThanOrEqual(3);
			}
			// PREMISE 1: the plugin actually took the resize.
			expect(Math.abs((probe.after.scrollerClientWidth - probe.before.scrollerClientWidth) - probe.delta), `PREMISE 1 at ${width}px: the scroller's clientWidth must move by the container's own delta (${probe.delta} css px) within 2 css px, or the plugin never saw this resize ${JSON.stringify(probe)}`).toBeLessThanOrEqual(2);
			expect(probe.after.editorWidth, `PREMISE 1 at ${width}px: .cm-editor's own inline width must be rewritten by applyViewportBox, not left stale ${JSON.stringify(probe)}`).not.toBe(probe.before.editorWidth);
			stages.push({ label: `${width}px`, width, r, probe });
		}

		const pDev = PITCH * rest.geo.zoom * DSF;
		const moves = stages.map(s => ({ label: s.label, movedDev: Math.abs(columnFromEdge(s.r) - columnFromEdge(rest)) }));
		// eslint-disable-next-line no-console
		console.log("PAPER-RESIZE-GRID", JSON.stringify({ restColumnFromEdge: columnFromEdge(rest), moves, pDev, rest, stages }));
		// PREMISE 2: the column actually moved on some stage.
		const qualifying = stages.filter(s => Math.abs(columnFromEdge(s.r) - columnFromEdge(rest)) >= pDev);
		expect(qualifying.length > 0, `PREMISE 2: the column's left edge must move by at least one painted pitch (${pDev.toFixed(1)} device px) on some stage, or this cell resized nothing worth reading ${JSON.stringify(moves)}`).toBe(true);

		// PREMISE 3: that move must clear the reader's own aliasing floor, or a broken build's offset could alias back near zero here.
		for (const s of qualifying) {
			const moveLayoutPx = (columnFromEdge(s.r) - columnFromEdge(rest)) / DSF;
			const d = circ(moveLayoutPx, PITCH) * DSF * s.r.geo.zoom;
			// eslint-disable-next-line no-console
			console.log("PAPER-RESIZE-GRID-ALIAS", JSON.stringify({ label: s.label, moveLayoutPx, d, aliasFloor: ALIAS_FLOOR_DEV }));
			expect(d, `PREMISE 3 at ${s.label}: the column's move modulo the pitch (d=${d.toFixed(2)} device px, from a ${moveLayoutPx.toFixed(2)} layout px move) must clear ${ALIAS_FLOOR_DEV} device px, or this stage cannot show a broken phase-x - pick a different stage width if this fails`).toBeGreaterThanOrEqual(ALIAS_FLOOR_DEV);
		}

		for (const { label, r } of stages) {
			// THE CONTRACT: x only - see the header for why y is logged, not asserted.
			expect.soft(Math.abs(r.abs.x - rest.abs.x), `WINDOW RESIZE ${label} x: grid marks vs the text column's left edge, device px from the value before the first resize (rest ${rest.abs.x.toFixed(2)}, now ${r.abs.x.toFixed(2)})`).toBeLessThanOrEqual(RESIZE_TOL_DEV);
			// eslint-disable-next-line no-console
			console.log("PAPER-RESIZE-GRID-Y-LOGGED-ONLY", JSON.stringify({ label, restAbsY: rest.abs.y, stageAbsY: r.abs.y, deltaY: Math.abs(r.abs.y - rest.abs.y), tightY: r.tight.y, countY: r.count.y }));
		}
	} finally {
		await p.close();
	}
}, 180_000);
