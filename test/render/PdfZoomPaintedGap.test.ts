/**
 * PDF zoom painted gap: through the viewer's re-renders, every frame that shows a page's own picture shows its saved ink
 * and highlights.
 *
 * The page (test/render/pdfPaintedGapPage.ts) is a stand-in for pdf.js's page list under the real controller, with a
 * reader that reads at the paint point of every frame (a ResizeObserver callback: after every animation frame callback,
 * before paint) the backing alpha of our canvases at one point of each saved stroke. A frame is bad for a page that
 * shows its picture when either point is on screen and none of our canvases has alpha there.
 *
 * The cells are the break read's rows (1.5.2/painted-gap/BREAK-READ-R3.md): G1 a page canvas shown inside the sync floor,
 * G2 a viewer write inside an animation frame after ours, G3 the viewer letting go of a page and coming back, G4 the
 * viewer taking our pen canvas or sweeping the page, G5 the viewer taking only the highlight group, G6 the arm's
 * button-scroll in the stand-in, G7 in every cell (pen and highlight read apart), C1 and C3 in every cell (no more pen
 * canvases than inked pages the viewer holds, never two of a kind on one page), C4 a pinch restyle storm that must not
 * sync more than the floor allows. A1 and A2 are a pair from the device: a page with ink and a highlight, and a page
 * with no ink, which must never hold a canvas of ours. R1 hashes our canvases at rest, to compare across builds. Each
 * cell first checks that it measured something: the action ran, the page showed its picture, and for "sync just
 * before" cells the action landed inside the floor.
 *
 * PG4: a zoom in whose reset takes everything off an inked page, then the new canvas lands finished, so it
 * takes the at-once path. That sync reads no pixels of the page (on the device, one read there cost about 80 ms in the
 * frame the zoom lands in), it is the only one for the new canvas, and the canvas is still read once, at a later sync.
 * On a page the file draws dark, no frame shows the page under a multiply highlight group while the read waits. G6
 * holds the button-scroll's syncs at the painted-gap fix's count (PG-1).
 *
 * BR3 and W1 (break read 1.5.2/audit/BREAKREAD-br3-6bf99882.md): a page read dark gets a new canvas that shows before
 * it can be read. BR3-a: a zoom in's canvas lands shown while the page is still drawing (the at-once path). BR3-b: the
 * sweep's new canvas shows, the zoom layer gone, while the page is still drawing (the put-back path). W1: a second zoom
 * step right after the first one's at-once sync, the first step's canvas kept as the zoom layer while the second draws.
 * No frame may show that page under a multiply highlight group. Each has a Lighten control and a light-page control.
 * OF: another file in the same pane takes no dark answer from the first file's page.
 *
 * PAINTED_GAP_EVIDENCE names a folder for each cell's full frame log (JSON).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { launch, stylesCss } from "./harness";
import type { Result, Spec } from "./pdfPaintedGapPage";
declare const process: { env: Record<string, string | undefined> };

let browser: Browser, bundle: string;
beforeAll(async () => {
	const result = await build({
		entryPoints: [fileURLToPath(new URL("./pdfPaintedGapPage.ts", import.meta.url))],
		bundle: true,
		write: false,
		format: "iife",
		platform: "browser",
		target: "es2022",
		alias: { obsidian: fileURLToPath(new URL("../obsidian-stub.ts", import.meta.url)) },
	});
	bundle = result.outputFiles[0]!.text;
	browser = await launch();
});
afterAll(async () => {
	await browser?.close();
});

interface Doc {
	pages: number;
	rendered: number;
	scale: number;
	height: number;
	/** Pages with no saved ink at all. */
	bare?: number[];
	/** Pages the PDF file draws dark. */
	dark?: number[];
	/** The "dark pages" setting; "darken" unless named. */
	assume?: "darken" | "lighten";
}
const FOUR: Doc = { pages: 4, rendered: 2, scale: 0.5, height: 1300 };
const TEN: Doc = { pages: 10, rendered: 4, scale: 0.5, height: 1300 };
/** Addendum 1's pair (Alan's page 11 and page 20): page 1 has a pen stroke and a highlight, page 2 has no ink. */
const MIXED: Doc = { pages: 4, rendered: 2, scale: 0.5, height: 1300, bare: [2] };
/** FOUR with page 1 drawn dark by the file. */
const DARK1: Doc = { pages: 4, rendered: 2, scale: 0.5, height: 1300, dark: [1] };
/** DARK1 under "Lighten for dark pages": no page is read, no page has a multiply group. */
const DARK1_LIGHTEN: Doc = { ...DARK1, assume: "lighten" };

async function open(doc: Doc): Promise<Page> {
	const page = await browser.newPage({ viewport: { width: 700, height: doc.height + 40 }, deviceScaleFactor: 1 });
	page.on("console", (m) => console.log(`page: ${m.text()}`));
	await page.setContent("<!doctype html><html><body style='margin:0'></body></html>");
	await page.addStyleTag({ content: stylesCss() });
	await page.addScriptTag({ content: bundle });
	await page.evaluate((d) => window.pdfPaintedGap.open(d.pages, d.rendered, d.scale, d.height, d.bare ?? [], d.dark ?? [], d.assume ?? "darken"), doc);
	return page;
}

interface Summary {
	bad: number;
	badFrames: string[];
	endBad: number;
	maxPens: number;
	maxGroups: number;
	/** Frames in which a page with no saved ink held a canvas or group of ours (addendum 1's control). */
	bareOurs: number;
	c1: number;
	shownAfter: number;
	gapMs: number | null;
	syncs: number;
	frames: number;
	notes: string[];
}

function summarise(r: Result): Summary {
	const badFrames: string[] = [];
	let maxPens = 0, maxGroups = 0, bareOurs = 0, c1 = 0, shownAfter = 0;
	const at = r.actionAt ?? Infinity;
	const isBad = (p: Result["log"][number]["pages"][number]): boolean => p.s === 1 && p.ink === 1 && (p.pen === 0 || p.hl === 0);
	for (const fr of r.log) {
		if (fr.pensTotal > fr.liveInked) c1++;
		let bareHere = false;
		for (const [n, p] of Object.entries(fr.pages)) {
			maxPens = Math.max(maxPens, p.pens);
			maxGroups = Math.max(maxGroups, p.groups);
			if (p.ink === 0 && p.pens + p.groups > 0) bareHere = true;
			if (p.s === 1 && fr.t >= at) shownAfter++;
			if (isBad(p)) badFrames.push(`f${fr.f}@${fr.t} p${n} pen ${p.pen} hl ${p.hl} pens ${p.pens} groups ${p.groups} vc ${p.vc}/${p.vh} held ${p.held}`);
		}
		if (bareHere) bareOurs++;
	}
	const last = r.log[r.log.length - 1];
	const endBad = last ? Object.values(last.pages).filter(isBad).length : 1;
	const gapMs = r.actionAt !== null && r.syncBefore !== null ? Math.round((r.actionAt - r.syncBefore) * 10) / 10 : null;
	return { bad: badFrames.length, badFrames, endBad, maxPens, maxGroups, bareOurs, c1, shownAfter, gapMs, syncs: r.syncsDuring, frames: r.log.length, notes: r.notes };
}

function record(name: string, r: Result, s: Summary, extra: object = {}): void {
	const dir = process.env.PAINTED_GAP_EVIDENCE;
	if (dir) writeFileSync(`${dir}/${name}.json`, JSON.stringify({ name, summary: s, ...extra, result: r }, null, 1));
	console.log(`PAINTED_GAP ${name} ${JSON.stringify({ ...s, badFrames: s.badFrames.slice(0, 8), ...extra })}`);
}

/** What the syncs did from the new canvas on, and the dark pages' multiply frames over the whole log. */
interface AtOnce {
	/** Syncs outside every frame callback (the root observer's at-once sync) from the new canvas on. */
	atOnce: number;
	/** Page reads inside those. */
	atOnceReads: number;
	/** Page reads in every sync from the new canvas on. */
	reads: number;
	/** Frames in which a page the file draws dark showed its picture under a multiply highlight group. */
	mulDark: number;
}

function atOnceOf(r: Result, dark: number[]): AtOnce {
	const from = r.newCanvasAt ?? Infinity;
	const after = r.syncLog.filter((x) => x.t >= from);
	const now = after.filter((x) => x.atOnce === 1);
	let mulDark = 0;
	for (const fr of r.log) if (dark.some((n) => fr.pages[n]?.s === 1 && fr.pages[n]?.mul === 1)) mulDark++;
	return {
		atOnce: now.length,
		atOnceReads: now.reduce((a, x) => a + x.reads, 0),
		reads: after.reduce((a, x) => a + x.reads, 0),
		mulDark,
	};
}

/** PG4: a zoom in's new canvas on an inked page with none of ours, read at a later sync, never in the at-once one. */
async function zoomInCell(name: string, doc: Doc, spec: Spec): Promise<void> {
	const dark = doc.dark ?? [];
	const isDark = dark.includes(spec.page);
	const page = await open(doc);
	try {
		const r = await page.evaluate((sp) => window.pdfPaintedGap.run(sp), spec);
		const s = summarise(r);
		const z = atOnceOf(r, dark);
		record(name, r, s, { pg4: z });
		measured(s, r);
		expect(r.newCanvasAt, "the new canvas landed").not.toBeNull();
		expect(r.before?.s, "precondition: the page showed its picture before the zoom").toBe(1);
		expect(r.before?.mul, `precondition: the page was read ${isDark ? "dark (no multiply group)" : "light (its multiply group)"} before the zoom`).toBe(isDark ? 0 : 1);
		expect(z.atOnce, "precondition: the new canvas took the at-once path").toBeGreaterThanOrEqual(1);
		expect.soft(z.atOnceReads, "PG-4: page reads inside the at-once sync for the zoom's new canvas").toBe(0);
		expect.soft(z.atOnce, "PG-4: at-once syncs for one new canvas").toBeLessThanOrEqual(1);
		expect.soft(z.reads, "the new canvas was not read exactly once, at a later sync").toBe(1);
		if (isDark) expect.soft(z.mulDark, "frames in which the dark page showed its picture under a multiply highlight group").toBe(0);
		held(s);
	} finally {
		await page.close();
	}
}

/**
 * Frames, from the new canvas on, in which page `n` showed its picture, holding saved ink, with no multiply highlight
 * group: on a light page that is a dark answer where none belongs (or a group missing).
 */
function plainOnLight(r: Result, n: number): number {
	const from = r.newCanvasAt ?? Infinity;
	return r.log.filter((fr) => fr.t >= from && fr.pages[n]?.s === 1 && fr.pages[n]?.ink === 1 && fr.pages[n]?.mul === 0).length;
}

/**
 * BR3 and W1: a re-render of a page read dark, where the new canvas is shown before it can be read. No frame may show
 * that page under a multiply highlight group. Controls: the same action under Lighten (never a group) and on a light
 * page (its multiply group in every frame from the new canvas on).
 */
async function br3Cell(name: string, doc: Doc, spec: Spec): Promise<void> {
	const dark = doc.dark ?? [];
	const lighten = doc.assume === "lighten";
	const isDark = dark.includes(spec.page);
	const page = await open(doc);
	try {
		const r = await page.evaluate((sp) => window.pdfPaintedGap.run(sp), spec);
		const s = summarise(r);
		const z = atOnceOf(r, dark);
		const plain = plainOnLight(r, spec.page);
		record(name, r, s, { pg4: z, plainOnLight: plain });
		measured(s, r);
		expect(r.newCanvasAt, "the new canvas landed").not.toBeNull();
		expect(r.before?.s, "precondition: the page showed its picture before the action").toBe(1);
		const was = lighten ? "under Lighten (no multiply group)" : isDark ? "read dark (no multiply group)" : "read light (its multiply group)";
		expect(r.before?.mul, `precondition: the page was ${was} before the action`).toBe(isDark || lighten ? 0 : 1);
		if (spec.action === "zoomInDrawing") expect(z.atOnce, "precondition: the new canvas took the at-once path").toBeGreaterThanOrEqual(1);
		if (isDark) expect.soft(z.mulDark, "BR3: frames in which the page read dark showed its picture under a multiply highlight group").toBe(0);
		else if (!lighten) expect.soft(plain, "control: frames in which the light page showed its picture without its multiply group").toBe(0);
		if (!lighten && spec.action !== "zoomInTwice") {
			expect.soft(z.atOnceReads, "page reads inside an at-once sync").toBe(0);
			expect.soft(z.reads, "the new canvas was not read exactly once, after its draw").toBe(1);
		}
		held(s);
	} finally {
		await page.close();
	}
}

/**
 * Another file in the same pane: page 1 of the first file was read dark; the other file's page 1 is light. Its new
 * div has no answer, so no dark answer of the first file's may reach it: from its new canvas on, every frame that
 * shows it shows its highlight under the multiply group.
 */
async function otherFileCell(name: string): Promise<void> {
	const page = await open(DARK1);
	try {
		const r = await page.evaluate((sp) => window.pdfPaintedGap.run(sp), pg("otherFile", 1, "none"));
		const s = summarise(r);
		const plain = plainOnLight(r, 1);
		record(name, r, s, { plainOnLight: plain });
		measured(s, r);
		expect(r.newCanvasAt, "the other file's pages landed").not.toBeNull();
		expect(r.before?.mul, "precondition: the first file's page 1 was read dark (no multiply group)").toBe(0);
		expect.soft(plain, "frames in which the other file's light page 1 showed its picture without its multiply group").toBe(0);
		held(s);
	} finally {
		await page.close();
	}
}

/** The cell measured something: the action ran and finished, the page showed its picture after it. */
function measured(s: Summary, r: Result): void {
	expect(s.notes, "the stand-in reported a problem").toEqual([]);
	expect(r.actionAt, "the action ran").not.toBeNull();
	expect(s.shownAfter, "a watched page showed its picture after the action").toBeGreaterThan(0);
}

/** The contract and the bound, read soft so every cell reports every line in one run. */
function held(s: Summary): void {
	expect.soft(s.bad, `frames that show a page's picture without its ink or highlights: ${s.badFrames.slice(0, 4).join("; ")}`).toBe(0);
	expect.soft(s.endBad, "pages left without ink or highlights at the last frame").toBe(0);
	expect.soft(s.maxPens, "pen canvases of ours on one page (C3)").toBeLessThanOrEqual(1);
	expect.soft(s.maxGroups, "highlight groups of ours on one page (C3)").toBeLessThanOrEqual(1);
	expect.soft(s.c1, "frames with more pen canvases than inked pages the viewer holds (C1)").toBe(0);
	expect.soft(s.bareOurs, "frames in which a page with no ink held a canvas of ours (addendum 1 control)").toBe(0);
}

async function cell(name: string, doc: Doc, spec: Spec): Promise<void> {
	const page = await open(doc);
	try {
		const r = await page.evaluate((sp) => window.pdfPaintedGap.run(sp), spec);
		const s = summarise(r);
		record(name, r, s);
		measured(s, r);
		if (spec.before === "sync" && !spec.inRaf) {
			expect(s.gapMs, "a sync returned before the action").not.toBeNull();
			expect.soft(s.gapMs!, "the action landed inside the sync floor (120 ms)").toBeLessThan(120);
		}
		held(s);
	} finally {
		await page.close();
	}
}

const pg = (action: Spec["action"], page: number, before: Spec["before"], delay = 0, extra: Partial<Spec> = {}): Spec => ({ action, page, before, delay, ...extra });

const CELLS: Array<[string, Doc, Spec]> = [
	["control-unrelated-class", FOUR, pg("control", 1, "sync", 1, { pages: [1, 2] })],
	["G1-append-sync-1", FOUR, pg("showNew", 3, "sync", 1)],
	["G1-append-sync-60", FOUR, pg("showNew", 3, "sync", 60)],
	["G1-append-sync-100", FOUR, pg("showNew", 3, "sync", 100)],
	["G1-append-nosync", FOUR, pg("showNew", 3, "none")],
	["G1-unhide-sync-1", FOUR, pg("showHidden", 3, "sync", 1)],
	["G1-unhide-sync-60", FOUR, pg("showHidden", 3, "sync", 60)],
	["G1-unhide-sync-100", FOUR, pg("showHidden", 3, "sync", 100)],
	["G2-take-in-raf", FOUR, pg("takePen", 1, "none", 0, { inRaf: true })],
	["G2-show-in-raf", FOUR, pg("showNew", 3, "none", 0, { inRaf: true })],
	["G3-swap-1", FOUR, pg("swap", 2, "none", 1)],
	["G3-swap-60", FOUR, pg("swap", 2, "none", 60)],
	["G3-zoomlayer-1", FOUR, pg("swapZoomLayer", 2, "none", 1)],
	// A guard (C1/C2): a page the viewer lets go of for good, its canvas with it, gets none of ours back.
	["G3-destroy-sync-1", FOUR, pg("destroy", 1, "sync", 1, { pages: [1, 2] })],
	["G4-take-sync-1", FOUR, pg("takePen", 1, "sync", 1)],
	["G4-take-sync-60", FOUR, pg("takePen", 1, "sync", 60)],
	["G4-take-sync-100", FOUR, pg("takePen", 1, "sync", 100)],
	["G4-take-nosync", FOUR, pg("takePen", 1, "none")],
	["G4-sweep-sync-1", FOUR, pg("sweep", 1, "sync", 1)],
	["G4-sweep-nosync", FOUR, pg("sweep", 1, "none")],
	["G5-highlights-sync-1", FOUR, pg("takeHighlights", 1, "sync", 1)],
	["G5-highlights-nosync", FOUR, pg("takeHighlights", 1, "none")],
	// Addendum 1's pair, the zoom's sweep with a sync just before: the inked page must be red at the base, the page
	// with no ink green at the base and at the fix, and never given a canvas of ours.
	["A1-ink-page-sweep-sync-1", MIXED, pg("sweep", 1, "sync", 1, { pages: [1, 2] })],
	["A2-noink-page-sweep-sync-1", MIXED, pg("sweep", 2, "sync", 1, { pages: [1, 2] })],
];

describe("PDF zoom painted gap: no frame shows a page's picture without its saved ink and highlights", () => {
	for (const [name, doc, spec] of CELLS) {
		it(name, () => cell(name, doc, spec));
	}

	it("G3-zoomlayer-1 keeps the page's overlay through the swap (no eviction)", async () => {
		const page = await open(FOUR);
		try {
			const r = await page.evaluate((sp) => window.pdfPaintedGap.run(sp), pg("swapZoomLayer", 2, "none", 1));
			const lost = r.log.filter((fr) => fr.pages[2]?.held === 0).length;
			console.log(`PAINTED_GAP G3-zoomlayer-held ${JSON.stringify({ frames: r.log.length, lost })}`);
			measured(summarise(r), r);
			expect.soft(lost, "frames in which the controller held no overlay for the page").toBe(0);
		} finally {
			await page.close();
		}
	});

	it("G6-button-scroll: two zoom-out clicks, then a scroll inside the band margin", async () => {
		const page = await open(TEN);
		try {
			const r = await page.evaluate(() => window.pdfPaintedGap.zoomScroll([0.4, 0.3], 40));
			const s = summarise(r);
			record("G6-button-scroll", r, s);
			measured(s, r);
			held(s);
			expect.soft(r.syncsDuring, "PG-1: syncs in the button-scroll, at most the painted-gap fix's 7").toBeLessThanOrEqual(7);
		} finally {
			await page.close();
		}
	});

	const ZOOM_IN: Array<[string, Doc, Spec]> = [
		["PG4-zoomin-bare-sync-1", FOUR, pg("zoomInBare", 1, "sync", 1)],
		["PG4-zoomin-bare-raf", FOUR, pg("zoomInBare", 1, "none", 0, { inRaf: true })],
		["PG4-zoomin-bare-dark-sync-1", DARK1, pg("zoomInBare", 1, "sync", 1)],
		["PG4-zoomin-bare-dark-raf", DARK1, pg("zoomInBare", 1, "none", 0, { inRaf: true })],
	];
	for (const [name, doc, spec] of ZOOM_IN) {
		it(name, () => zoomInCell(name, doc, spec));
	}

	const BR3: Array<[string, Doc, Spec]> = [
		["BR3-a-zoomin-drawing", DARK1, pg("zoomInDrawing", 1, "none")],
		["BR3-a-zoomin-drawing-lighten", DARK1_LIGHTEN, pg("zoomInDrawing", 1, "none")],
		["BR3-a-zoomin-drawing-light", FOUR, pg("zoomInDrawing", 1, "none")],
		["BR3-b-sweep-late-draw", DARK1, pg("sweepLateDraw", 1, "none")],
		["BR3-b-sweep-late-draw-lighten", DARK1_LIGHTEN, pg("sweepLateDraw", 1, "none")],
		["BR3-b-sweep-late-draw-light", FOUR, pg("sweepLateDraw", 1, "none")],
		["W1-zoomin-twice", DARK1, pg("zoomInTwice", 1, "none")],
		["W1-zoomin-twice-lighten", DARK1_LIGHTEN, pg("zoomInTwice", 1, "none")],
		["W1-zoomin-twice-light", FOUR, pg("zoomInTwice", 1, "none")],
	];
	for (const [name, doc, spec] of BR3) {
		it(name, () => br3Cell(name, doc, spec));
	}
	it("OF-other-file-no-stale-dark", () => otherFileCell("OF-other-file-no-stale-dark"));

	it("R1-rest-pixels: our canvases at rest, hashed (compare the base log with the fix log)", async () => {
		const page = await open(MIXED);
		try {
			const r = await page.evaluate(() => window.pdfPaintedGap.restHash());
			const dir = process.env.PAINTED_GAP_EVIDENCE;
			if (dir) writeFileSync(`${dir}/R1-rest-pixels.json`, JSON.stringify({ name: "R1-rest-pixels", result: r }, null, 1));
			console.log(`PAINTED_GAP R1-rest-pixels ${JSON.stringify(r)}`);
			expect(r.quiet, "the controller went quiet").toBe(true);
			expect(r.pages[1]?.length, "the inked rendered page holds its canvases").toBeGreaterThan(0);
			expect(r.pages[2], "the page with no ink holds none of ours").toEqual([]);
		} finally {
			await page.close();
		}
	});

	it("C4-pinch-storm: a restyle every frame syncs no more than the 120 ms floor allows", async () => {
		const page = await open(FOUR);
		try {
			const r = await page.evaluate(() => window.pdfPaintedGap.storm(60));
			const s = summarise(r);
			record("C4-pinch-storm", r, s);
			const span = (r.lastWriteAt ?? 0) - (r.actionAt ?? 0);
			const allowed = Math.ceil(span / 120) + 2;
			console.log(`PAINTED_GAP C4-pinch-storm-syncs ${JSON.stringify({ span: Math.round(span), syncs: r.syncsDuring, allowed })}`);
			expect(r.actionAt, "the storm ran").not.toBeNull();
			expect.soft(r.syncsDuring, `syncs in a ${Math.round(span)} ms storm`).toBeLessThanOrEqual(allowed);
			held(s);
		} finally {
			await page.close();
		}
	});
});
