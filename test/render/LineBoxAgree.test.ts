/**
 * A DRAWN LINE'S BOX AND ITS HEIGHT-MAP TOP AGREE AT EVERY LINE AND ZOOM.
 *
 * The line anchors read each drawn anchored line's top twice: from CodeMirror's height map, and from the line's box in a
 * measure (LineAnchors.boxesRead). Both see the same pixel; they differ only in the scale each divides by. Read at the
 * rendered scale (the content's box height over its layout height, CodeMirror's own quotient), the box agrees with the height
 * map to float noise at every line while CodeMirror's scale is the current quotient; read at the nominal camera scale it
 * drifts by about 0.006 screen px a line at 10 percent.
 *
 *   1. On the stand-in rig's four lines, the gap is under 1e-4 screen px at 100 percent, after a settle at 60, and back at 100;
 *      the settle to 60 moves no correction. A step that big redraws by design, so no stand-in is claimed there.
 *   2. The same at 10 percent and after the settle to 12, which holds the stand-in the same way.
 *   3. A note of 64 lines with anchored ink sixty lines down, mounted at 10 percent, where CodeMirror's scale stays at the
 *      quotient it took first (0.0999846) while the content's own is 0.1. CodeMirror lays the note out 1820 px tall at 10
 *      percent and 1825 at 12, so the text far down really moves at the settle to 12 (about 1.2 device px at line 64): every
 *      moved line's ink is shown on its text, within 1e-4 world units of its box at the rendered scale, and the stand-in, which
 *      pictures the old places, is let go and the layer drawn by path. The plant that reds this cell: the stand-in kept while
 *      corrections moved (usableStandIn's shown-places test taken out), held at the 12 percent settle.
 *
 * Rig: the PanBakeRepaint page (panBakeRepaintPage.ts) and its synthetic note, with the read in lineBoxAgreePage.ts.
 *
 * Run: npx vitest run --config vitest.render.mts test/render/LineBoxAgree.test.ts
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

const MINIMAL_CSS = readFileSync(fileURLToPath(new URL("./fixtures/minimal-9.0.2-theme.css", import.meta.url)), "utf8");
const TEMPLATE = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/alan-ink-75d1627a.json", import.meta.url)), "utf8")) as Record<string, unknown>;
const PANE = { w: 1184, h: 824 };
const DSF = 2;
const PAGE_ID = "75d1627a-c4d7-4a11-947d-bc26b7f83c20";
/** Screen px: the two readers agree to float noise. */
const AGREE_PX = 1e-4;

function seeded(seed: number): () => number {
	let a = seed >>> 0;
	return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** The PanBakeRepaint note: the same seeded generator, so the same ink. */
function syntheticInk(count: number): string {
	const rnd = seeded(37);
	const strokes = [];
	for (let i = 0; i < count; i++) {
		let x = 40 + rnd() * 11000, y = 40 + rnd() * 13000, heading = rnd() * Math.PI * 2;
		const pts: number[] = [];
		for (let k = 0; k < 14; k++) {
			pts.push(Math.round(x * 100) / 100, Math.round(y * 100) / 100, 0.3 + 0.2 * rnd(), k * 8);
			heading += (rnd() - 0.5) * 0.9; x += Math.cos(heading) * 6; y += Math.sin(heading) * 6;
		}
		strokes.push({ id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, tool: "pen", color: "#2f6de0", width: 2.6, createdAt: 1788552785194, pts });
	}
	return JSON.stringify({ ...TEMPLATE, strokes, images: [], textBoxes: [] });
}
const FIXTURE = syntheticInk(4000);

let browser: Browser, script: string;
beforeAll(async () => {
	const b = await build({ entryPoints: [fileURLToPath(new URL("./lineBoxAgreePage.ts", import.meta.url))], bundle: true, write: false, format: "iife", platform: "browser",
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true, args: [`--force-device-scale-factor=${DSF}`, "--window-size=1700,1000"] });
}, 180_000);
afterAll(async () => { await browser?.close(); });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
type Row = { painted: boolean; work: string | null; pts: number };
type Line = { n: number; drawn: boolean; hm: number; box: number | null; gapPx: number | null; dy: [number, number]; inkGap: number | null };
type Agree = { cssScale: number; scaleY: number; rendered: number; devicePerWorld: number; boxH: number; layoutH: number; drawn: [number, number]; docLines: number; anchored: number; lines: Line[] };

async function withRig(zoom: number, lines: number, body: (call: <T>(name: string, ...a: unknown[]) => Promise<T>) => Promise<void>) {
	const context = await browser.newContext({ viewport: null, hasTouch: true });
	const page: Page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	const call = <T>(name: string, ...a: unknown[]) => page.evaluate(([n, args]) => (window as any).panBake[n as string](...(args as unknown[])), [name, a] as const) as Promise<T>;
	try {
		await page.setContent(`<!doctype html><body class="theme-dark" style="margin:0; --font-text-size:19px; --background-modifier-border:#777777"></body>`);
		await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
		await page.addStyleTag({ content: MINIMAL_CSS });
		await page.addScriptTag({ content: script });
		const mounted = await call<any>("mount", zoom, FIXTURE, PAGE_ID, PANE.w, PANE.h, 4000, lines);
		expect(errors).toEqual([]);
		expect(mounted.strokes, "premise: every stroke loaded").toBe(4000);
		expect(mounted.zoomCommitted, "premise: the zoom committed").toBe(true);
		await sleep(600);
		const whole0 = await call<{ pending: boolean }>("awaitWhole");
		expect(whole0.pending, "premise: the build the mount armed finished").toBe(false);
		await call("record");
		try { await body(call); } finally { await call("stop"); }
		expect(errors).toEqual([]);
	} finally { await context.close(); }
}

/** Every drawn anchored line was read from its box, and its gap to the height map is under AGREE_PX. */
function expectAgree(state: string, a: Agree, minLines: number): void {
	const drawn = a.lines.filter(l => l.drawn);
	expect(drawn.length, `premise, ${state}: anchored lines drawn (${JSON.stringify(a.drawn)})`).toBeGreaterThanOrEqual(minLines);
	expect(drawn.filter(l => l.box === null).map(l => l.n), `premise, ${state}: every drawn anchored line was read from its box`).toEqual([]);
	const worst = drawn.reduce((w, l) => Math.abs(l.gapPx!) > Math.abs(w.gapPx!) ? l : w, drawn[0]!);
	// eslint-disable-next-line no-console
	console.log(`BOXAGREE ${state} ${JSON.stringify({ cssScale: a.cssScale, scaleY: a.scaleY, rendered: a.rendered, boxH: a.boxH, layoutH: a.layoutH,
		worst: worst.n, gapPx: worst.gapPx, anchored: a.anchored, lines: drawn.length })}`);
	expect(Math.abs(worst.gapPx!), `${state}: the box and the height map agree within ${AGREE_PX} screen px at every line ` +
		`(worst line ${worst.n}: ${worst.gapPx}; cssScale ${a.cssScale}, scaleY ${a.scaleY}, rendered ${a.rendered})`).toBeLessThan(AGREE_PX);
}

/** A settle to `to` with the extent pieces held: the rows it painted, whether the stand-in is up, and the read after it. */
async function heldSettle(call: <T>(name: string, ...a: unknown[]) => Promise<T>, to: number) {
	await call("holdPieces", true);
	const n0 = (await call<Row[]>("rows")).length;
	expect((await call<{ ok: boolean }>("rezoom", to)).ok, "premise: the zoom committed").toBe(true);
	await sleep(700);
	const rows = (await call<Row[]>("rows")).slice(n0).filter(r => r.painted);
	return { rows, pathPts: rows.reduce((a, r) => a + (r.pts ?? 0), 0), held: (await call<{ held: boolean }>("standIn")).held, at: await call<Agree>("boxAgree") };
}
const dyOf = (a: Agree) => new Map(a.lines.map(l => [l.n, JSON.stringify(l.dy)]));
const movedLines = (was: Agree, now: Agree) => now.lines.filter(l => dyOf(was).get(l.n) !== JSON.stringify(l.dy));
const works = (rows: Row[]) => JSON.stringify(rows.map(r => [r.work, r.pts]));

it("1: four lines agree within 1e-4 px at 100 percent, after a settle at 60, and back at 100", async () => {
	await withRig(1, 4, async call => {
		await sleep(700);
		const rest = await call<Agree>("boxAgree");
		expectAgree("100 percent rest", rest, 4);
		const s = await heldSettle(call, 0.6);
		expectAgree("60 percent settle", s.at, 4);
		expect(movedLines(rest, s.at).map(l => l.n), "60 percent settle: no correction moved").toEqual([]);
		await call("holdPieces", false);
		expect((await call<{ ok: boolean }>("rezoom", 1)).ok, "premise: the zoom committed").toBe(true);
		await sleep(700);
		expectAgree("back at 100 percent", await call<Agree>("boxAgree"), 4);
	});
}, 180_000);

it("2: four lines agree within 1e-4 px at 10 percent and after the settle to 12, which holds the stand-in", async () => {
	await withRig(0.1, 4, async call => {
		await sleep(700);
		const rest = await call<Agree>("boxAgree");
		expectAgree("10 percent rest", rest, 4);
		const s = await heldSettle(call, 0.12);
		expectAgree("12 percent settle", s.at, 4);
		expect(movedLines(rest, s.at).map(l => l.n), "12 percent settle: no correction moved").toEqual([]);
		expect({ pathPts: s.pathPts, held: s.held }, `12 percent settle: no stroke by path and the stand-in holds (${works(s.rows)})`).toEqual({ pathPts: 0, held: true });
		await call("holdPieces", false);
	});
}, 180_000);

it("3: on a 64-line note the text far down moves at the settle to 12 percent: the ink follows it onto its text, and the stand-in is let go", async () => {
	await withRig(0.1, 64, async call => {
		await sleep(700);
		const rest = await call<Agree>("boxAgree");
		expect(rest.docLines, "premise: the note has 64 lines").toBe(64);
		const far = rest.lines.filter(l => l.drawn && l.n >= 60 && l.box !== null);
		expect(far.length, `premise: anchored ink sixty lines down is drawn and read (${JSON.stringify(rest.lines.map(l => l.n))})`).toBeGreaterThan(0);
		expect(rest.scaleY, `premise: at the 10 percent rest CodeMirror's scale is not the content's quotient ${rest.rendered}`).not.toBe(rest.rendered);
		const s = await heldSettle(call, 0.12);
		const moved = movedLines(rest, s.at);
		// eslint-disable-next-line no-console
		console.log(`BOXAGREE 64 lines ${JSON.stringify({ rest: { scaleY: rest.scaleY, rendered: rest.rendered, layoutH: rest.layoutH },
			settle: { scaleY: s.at.scaleY, rendered: s.at.rendered, layoutH: s.at.layoutH }, moved: moved.length, pathPts: s.pathPts, held: s.held })}`);
		expect(moved.length, "premise: the settle to 12 percent moved corrections").toBeGreaterThan(0);
		expect(moved.filter(l => l.inkGap === null).map(l => l.n), "premise: every moved line was read from its box").toEqual([]);
		const worst = moved.reduce((w, l) => l.inkGap! > w.inkGap! ? l : w, moved[0]!);
		expect(worst.inkGap!, `12 percent settle: every moved line's ink is on its text within 1e-4 world units (worst line ${worst.n})`).toBeLessThan(1e-4);
		expect({ pathPts: s.pathPts > 0, held: s.held }, `12 percent settle: the stand-in is let go and the layer drawn by path (${works(s.rows)})`)
			.toEqual({ pathPts: true, held: false });
		await call("holdPieces", false);
	});
}, 240_000);
