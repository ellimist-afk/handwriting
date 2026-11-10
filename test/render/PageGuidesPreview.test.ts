/**
 * PAGE GUIDES DURING A PINCH PREVIEW: not painted while the preview lives, painted again at the settle.
 *
 * The guides' box (InkOverlayPaperPinch.ts syncPageGuideBox) is the overlay's own, on the real note rig
 * (noteViewportCameraPage.ts, Infinite Canvas on). Measured before it was built: a painted guide box more than doubled
 * a held preview's raster at 10 to 15 percent; blanked under the previewing class it cost what no box costs. So:
 *
 * 1. PRESENCE (ordinary suite), on lined paper and on paper none: the box is up at rest; during a held pinch preview
 *    (read from the overlay, not from any class) its computed background is none and it carries its own previewing
 *    class; after the fingers lift and the note settles, it is the guides' gradient again. Under print media it is not
 *    shown. Paper none is the case the box's own class is for: the scroller's previewing class never comes on there.
 *
 * 2. COST (HW_PAPER_COST=1, a timing run, alone on the machine): on the held pinch preview of PaperPaintCost.test.ts
 *    (page deviceScaleFactor 2, lined paper, 30 steps, never lifted), main-thread Paint plus the renderer's RasterTask
 *    from the first mark to the end of the trace, median of N rounds per arm:
 *      absent   the box hidden by a test style (no box painted at all);
 *      present  the overlay's box, as shipped;
 *      painted  THE PLANT: a test style paints the box whatever class it carries.
 *    present / absent within 1.10 per gesture and paper; the plant must read over 1.10, or the rig cannot see the box
 *    and the run is void. A drift control (absent again, last) must agree with absent within 10 percent.
 *
 * Run: npx vitest run --config vitest.render.mts test/render/PageGuidesPreview.test.ts
 *      HW_PAPER_COST=1 for the cost cells; HW_GUIDES_N=<rounds> (default 5); HW_GUIDES_OUT=<file> writes every row.
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";

declare const process: { env: Record<string, string | undefined> };
let browser: Browser, viewportScript: string;

const ROUNDS = Number(process.env.HW_GUIDES_N ?? 5);
const STEPS = 30;
const OUT = process.env.HW_GUIDES_OUT ?? "";
const TRACE_CATEGORIES = "devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.stack,disabled-by-default-devtools.timeline.frame,blink.user_timing,blink".split(",");
const GESTURES = [{ name: "down", from: 0.15, to: 0.1 }, { name: "up", from: 0.1, to: 0.15 }] as const;
const ARMS = ["absent", "present", "painted", "absent-b"] as const;
/** Lined paper, and paper none: no paper class on the body, so the scroller's previewing class never comes on. */
const PAPERS = [{ name: "lines", bodyClass: "handwriting-paper-lines" }, { name: "none", bodyClass: "" }] as const;
type Paper = typeof PAPERS[number];
type Arm = typeof ARMS[number];
const ABSENT_CSS = ".handwriting-page-guides { display: none !important; }";
/** The plant: the guides' own gradient, painted whatever class the box carries (more specific than the quiet rule). */
const PAINTED_CSS = "body .markdown-source-view .cm-scroller > .handwriting-page-guides { background-image: repeating-linear-gradient(to bottom, transparent 0px, transparent calc(var(--handwriting-page-guide-pitch) - 1px), #777 calc(var(--handwriting-page-guide-pitch) - 1px), #777 var(--handwriting-page-guide-pitch)) !important; }";

beforeAll(async () => {
	const bv = await build({
		entryPoints: [fileURLToPath(new URL("./noteViewportCameraPage.ts", import.meta.url))],
		bundle: true, write: false, format: "iife", platform: "browser",
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
	});
	viewportScript = bv.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);

const dump: Record<string, unknown> = { regime: "page deviceScaleFactor 2, no launch flag", rounds: ROUNDS, steps: STEPS, papers: PAPERS.map(p => p.name) };
afterAll(async () => {
	await browser?.close();
	if (OUT) writeFileSync(OUT, JSON.stringify(dump, null, 1));
});

const gated = process.env.HW_PAPER_COST === "1" ? it : it.skip;

async function openRig(id: string, extraCss: string, from: number, paper: Paper) {
	const page = await browser.newPage({ viewport: { width: 700, height: 540 }, deviceScaleFactor: 2 });
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	await page.setContent(`<!doctype html><body class="${paper.bodyClass}" style="--background-modifier-border:#777; background:white"></body>`);
	await page.addStyleTag({ content: css + readFileSync(fileURLToPath(new URL("./noteViewportCamera.css", import.meta.url)), "utf8") });
	if (extraCss) await page.addStyleTag({ content: extraCss });
	await page.addScriptTag({ content: viewportScript });
	await page.evaluate(i => (window as any).viewportFixture.setup(i), id);
	const committed = await page.evaluate(a => (window as any).edgeAudit.commit(a.id, a.z), { id, z: from }) as any;
	return { page, errors, committed };
}

/** `previewing` is the overlay's own word (pinchPreview), so a class never set cannot hide that a preview lived. */
const boxState = (page: Page, id: string) => page.evaluate(i => {
	const b = document.querySelector(".cm-scroller > .handwriting-page-guides") as HTMLElement | null;
	const s = document.querySelector(".cm-scroller") as HTMLElement;
	const previewing = (window as any).viewportFixture.preview(i) as boolean;
	const scrollerClass = s.classList.contains("handwriting-paper-previewing");
	if (!b) return { present: false, image: "", display: "", pitch: "", previewing, scrollerClass, ownClass: false, scrollW: s.scrollWidth, scrollH: s.scrollHeight };
	const cs = getComputedStyle(b);
	return { present: true, image: cs.backgroundImage, display: cs.display, pitch: b.style.getPropertyValue("--handwriting-page-guide-pitch"), previewing, scrollerClass, ownClass: b.classList.contains("handwriting-page-guides-previewing"), scrollW: s.scrollWidth, scrollH: s.scrollHeight };
}, id);

function touch(page: Page) {
	return (type: string, id: number, x: number, y: number, isPrimary: boolean) =>
		page.evaluate(a => {
			const target = document.elementFromPoint(a.x, a.y);
			target?.dispatchEvent(new PointerEvent(a.type, { bubbles: true, cancelable: true, pointerType: "touch", pointerId: a.id, isPrimary: a.isPrimary, clientX: a.x, clientY: a.y, buttons: a.type === "pointerup" ? 0 : 1, width: 8, height: 8 }));
		}, { type, id, x, y, isPrimary });
}
const settleFrame = (page: Page) => page.evaluate(() => new Promise<number>(r => requestAnimationFrame(t => r(t))));

for (const paper of PAPERS) it(`page guides, paper ${paper.name}: up at rest on a canvas note, blank during a held pinch preview, back after the settle, never in print`, async () => {
	const id = `guides-presence-${paper.name}`;
	const { page, errors, committed } = await openRig(id, "", 0.15, paper);
	try {
		expect(committed.accepted, "premise: the start zoom committed").toBe(true);
		const rest = await boxState(page, id);
		expect(rest.present, "the overlay put the guides' box up on an Infinite Canvas note").toBe(true);
		expect(rest.image, "at rest the box paints the guides").toContain("repeating-linear-gradient");
		expect(Number.parseFloat(rest.pitch), "a page pitch is written").toBeGreaterThan(0);
		const send = touch(page);
		await send("pointerdown", 701, 250, 250, true);
		await send("pointerdown", 702, 350, 250, false);
		let during: Awaited<ReturnType<typeof boxState>> | null = null;
		for (let i = 0; i < 12; i++) {
			const spread = 100 - (34 * (i + 1)) / 12;
			await send("pointermove", 701, 300 - spread / 2, 250, true);
			await send("pointermove", 702, 300 + spread / 2, 250, false);
			await settleFrame(page);
			const st = await boxState(page, id);
			if (st.previewing) during = st;
		}
		expect(during, "premise: the overlay held a preview during the pinch").not.toBeNull();
		expect(during!.scrollerClass, `premise: the scroller's previewing class ${paper.bodyClass ? "comes on" : "never comes on with paper none"}`).toBe(!!paper.bodyClass);
		expect(during!.present, "the box stays in the page during the preview").toBe(true);
		expect(during!.ownClass, "during the preview the box carries its own previewing class").toBe(true);
		expect(during!.image, "during the preview the box paints nothing").toBe("none");
		await send("pointerup", 701, 283, 250, true);
		await send("pointerup", 702, 317, 250, false);
		for (let i = 0; i < 20; i++) await settleFrame(page);
		await page.waitForTimeout(600);
		for (let i = 0; i < 6; i++) await settleFrame(page);
		const after = await boxState(page, id);
		expect(after.previewing, "premise: the preview ended").toBe(false);
		expect(after.ownClass, "after the settle the box's own class is off").toBe(false);
		expect(after.present, "the box is up after the settle").toBe(true);
		expect(after.image, "after the settle the box paints the guides again").toContain("repeating-linear-gradient");
		await page.emulateMedia({ media: "print" });
		const printed = await boxState(page, id);
		expect(printed.display, "under print media the box is not shown").toBe("none");
		expect(errors, "no page errors").toEqual([]);
	} finally {
		await page.close();
	}
}, 120_000);

type TraceEvent = { name: string; ts: number; dur?: number; cat?: string; ph?: string; pid?: number; tid?: number; args?: any };
function parseTrace(buffer: any): TraceEvent[] {
	try { const d = JSON.parse(buffer.toString("utf8")); return Array.isArray(d) ? d : (d.traceEvents ?? []); } catch { return []; }
}
const median = (a: number[]) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const r2 = (x: number) => Math.round(x * 100) / 100;

async function previewArm(arm: Arm, g: typeof GESTURES[number], round: number, paper: Paper) {
	const extra = arm === "absent" || arm === "absent-b" ? ABSENT_CSS : arm === "painted" ? PAINTED_CSS : "";
	const id = `guides-cost-${paper.name}`;
	const { page, errors, committed } = await openRig(id, extra, g.from, paper);
	try {
		const rest = await boxState(page, id);
		for (let k = 0; k < 8; k++) await settleFrame(page);
		await page.waitForTimeout(300);
		const send = touch(page);
		const prefix = `hw-guides-${paper.name}-${g.name}-${round}-${arm}-`;
		await browser.startTracing(page, { categories: TRACE_CATEGORIES });
		await send("pointerdown", 701, 250, 250, true);
		await send("pointerdown", 702, 350, 250, false);
		const s1 = 100 * g.to / g.from;
		let previewSeen = 0, paintedInPreview = 0;
		for (let i = 0; i < STEPS; i++) {
			const spread = 100 + ((s1 - 100) * (i + 1)) / STEPS;
			await send("pointermove", 701, 300 - spread / 2, 250, true);
			await send("pointermove", 702, 300 + spread / 2, 250, false);
			await settleFrame(page);
			await page.evaluate(n => { performance.mark(n); }, `${prefix}${i}`);
			const st = await boxState(page, id);
			if (st.previewing) { previewSeen++; if (st.image && st.image !== "none") paintedInPreview++; }
		}
		// NEVER pointerup: the preview goes down with the page.
		const events = parseTrace(await browser.stopTracing());
		const main = new Set<string>();
		for (const e of events) if (e.ph === "M" && e.name === "thread_name" && e.args?.name === "CrRendererMain") main.add(`${e.pid}:${e.tid}`);
		const pids = new Set([...main].map(k => k.split(":")[0]!));
		const marks = events.filter(e => typeof e.name === "string" && e.name.startsWith(prefix) && String(e.cat ?? "").includes("blink.user_timing")).map(e => e.ts).sort((a, b) => a - b);
		const from = marks.length ? marks[0]! : Infinity;
		let mainPaintMs = 0, rasterMs = 0;
		for (const e of events) {
			if (e.ts < from) continue;
			if (e.name === "Paint" && main.has(`${e.pid}:${e.tid}`)) mainPaintMs += (e.dur ?? 0) / 1000;
			else if (e.name === "RasterTask" && pids.has(String(e.pid))) rasterMs += (e.dur ?? 0) / 1000;
		}
		return { paper: paper.name, gesture: g.name, round, arm, committed: committed.accepted, zoom: committed.state?.zoom, rest, previewSeen, paintedInPreview, framesCaptured: marks.length, mainThreadFound: main.size > 0, errors, mainPaintMs, rasterMs, totalMs: mainPaintMs + rasterMs };
	} finally {
		await page.close();
	}
}

for (const paper of PAPERS) for (const g of GESTURES) {
	const key = `${paper.name}-${g.name}`;
	gated(`page guides cost nothing on a held pinch preview, paper ${paper.name}, ${g.from} -> ${g.to}: present within 1.10 of absent, plant painted reads over`, async () => {
		const rows: Awaited<ReturnType<typeof previewArm>>[] = [];
		try {
			for (let r = 0; r < ROUNDS; r++) {
				const order = ARMS.map((_, k) => ARMS[(k + r) % ARMS.length]!);
				for (const arm of order) {
					const row = await previewArm(arm, g, r, paper);
					rows.push(row);
					console.log(`GUIDES-PREVIEW-PASS ${key} round=${r} arm=${arm} total=${r2(row.totalMs)} paint=${r2(row.mainPaintMs)} raster=${r2(row.rasterMs)} preview=${row.previewSeen}/${row.framesCaptured} paintedInPreview=${row.paintedInPreview} box=${row.rest.present} display=${row.rest.display}`);
				}
			}
		} finally {
			dump[key] = rows;
		}
		for (const row of rows) {
			const label = `${key} round ${row.round} ${row.arm}`;
			expect(row.errors, `${label}: no page errors`).toEqual([]);
			expect(row.committed, `${label}: premise, the start zoom committed`).toBe(true);
			expect(row.zoom, `${label}: premise, the start zoom is ${g.from}`).toBeCloseTo(g.from, 3);
			expect(row.mainThreadFound, `${label}: CrRendererMain found`).toBe(true);
			expect(row.framesCaptured, `${label}: every preview step marked`).toBe(STEPS);
			expect(row.previewSeen, `${label}: premise, the preview is up on at least 60 percent of the steps`).toBeGreaterThanOrEqual(Math.ceil(0.6 * STEPS));
			expect(row.rest.present, `${label}: premise, the overlay's box is in the page`).toBe(true);
			if (row.arm === "present") expect(row.paintedInPreview, `${label}: the box paints nothing during the preview`).toBe(0);
			if (row.arm === "painted") expect(row.paintedInPreview, `${label}: premise, the plant paints the box during the preview`).toBeGreaterThan(0);
		}
		const med = (arm: Arm) => median(rows.filter(x => x.arm === arm).map(x => x.totalMs));
		const absent = med("absent"), present = med("present"), painted = med("painted"), absentB = med("absent-b");
		const ratio = present / absent, plant = painted / absent, drift = Math.abs(absentB - absent) / absent;
		dump[`summary-${key}`] = { absent, present, painted, absentB, presentOverAbsent: ratio, paintedOverAbsent: plant, drift };
		console.log(`GUIDES-PREVIEW-SUMMARY ${key} absent=${r2(absent)} present=${r2(present)} painted=${r2(painted)} absent-b=${r2(absentB)} present/absent=${r2(ratio)} painted/absent=${r2(plant)} drift=${r2(drift)}`);
		expect(drift, "drift: absent-b within 10 percent of absent, or the run drifted").toBeLessThanOrEqual(0.10);
		expect(plant, "plant: a box painted in the preview reads over 1.10 of no box, or the rig is blind").toBeGreaterThan(1.10);
		expect(ratio, "the guides' box adds nothing to a held preview: present within 1.10 of absent").toBeLessThanOrEqual(1.10);
	}, 1_800_000);
}
