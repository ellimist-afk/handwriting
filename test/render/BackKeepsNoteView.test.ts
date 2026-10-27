/**
 * The Android Back button never changes a note's scroll or zoom (GitHub issue 9, Bug 1: "the current note gets
 * reloaded and the scroll position jumps back to the top").
 *
 * Alan's contract for Back: it never changes scroll or zoom; with a pop-up, menu or keyboard open it closes that and
 * nothing else; with nothing open it does what Obsidian does (leave the note), and the note's scroll and zoom are saved
 * and come back when it is reopened.
 *
 * The plugin has no Back handler of its own. Obsidian turns Back with nothing open into a history step on the leaf,
 * which reaches the plugin in one of two shapes, and each is an arm here:
 *   SAME NOTE, RELOADED: the note's editor is torn down and built again on the same file (the reporter's "reloaded").
 *     The rig destroys the view and mounts a new one on the same path (viewportFixture.reopen).
 *   LEAVE AND RETURN: the leaf's editor switches to the previous note and, on Forward or on reopening, back again. The
 *     rig switches the same view's file away and back (viewportFixture.switchPath twice).
 * Each arm zooms the note to 50 percent and scrolls it down first, through the plugin's own camera commit, then reads
 * the zoom and the scroll after the step. Both must equal the readings before it.
 *
 * ZOOMED IN, LEAVE AND RETURN (Alan, 2026-10-21, Untitled 1 at 286 percent, Infinite Canvas on, Minimal: away to another
 * note and back, and the view had moved). Three arms at 2.86, each asserting both scrolls within 1 px:
 *   - a Readable line length column under Obsidian's own stylesheet, scrolled inside the range;
 *   - the same under the Minimal theme, which centres each line rather than the column;
 *   - no column, scrolled past the ink's far edge into room the canvas granted, on both axes.
 * And after coming back with the column, one more commit in place at the same zoom (a zoom button's commit with no
 * gesture) must not move the view either: a restore that left margin debt behind would pay it there.
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

const MINIMAL_CSS = readFileSync(fileURLToPath(new URL("./fixtures/minimal-9.0.2-theme.css", import.meta.url)), "utf8");

let browser: Browser, script: string;
beforeAll(async () => {
	const b = await build({
		entryPoints: [fileURLToPath(new URL("./noteViewportCameraPage.ts", import.meta.url))],
		bundle: true, write: false, format: "iife", platform: "browser",
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
	});
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 120_000);
afterAll(async () => { await browser?.close(); });

const ZOOM = 0.5, TOP = 600;
type View = { zoom: number; left: number; top: number; path: string };

async function open(theme: "none" | "obsidian" | "minimal" = "none"): Promise<Page> {
	const page = await browser.newPage({ viewport: theme === "none" ? { width: 700, height: 540 } : { width: 1300, height: 760 } });
	await page.setContent("<!doctype html><body></body>");
	await page.addStyleTag({ content: css + readFileSync(fileURLToPath(new URL("./noteViewportCamera.css", import.meta.url)), "utf8") });
	if (theme !== "none") await page.addStyleTag({ content: REAL_OBSIDIAN_CSS });
	if (theme === "minimal") await page.addStyleTag({ content: MINIMAL_CSS });
	await page.addScriptTag({ content: script });
	return page;
}

/** The note's zoom and scroll as the reader sees them, and the file the editor shows. */
const read = (page: Page): Promise<View> => page.evaluate(() => {
	const s = (window as any).viewportFixture.snap("back");
	const sc = document.querySelector("[data-rig=back] .cm-scroller") as HTMLElement;
	return { zoom: s.state.zoom, left: sc.scrollLeft, top: sc.scrollTop, path: (window as any).__backPath };
});

/** A note at 50 percent, scrolled down, at rest: the view Back must keep. */
async function zoomedAndScrolled(page: Page): Promise<View> {
	await page.evaluate(async ({ zoom, top }) => {
		const vf = (window as any).viewportFixture;
		await vf.setup("back", "far");
		(window as any).__backPath = "fit-back.md";
		await (window as any).edgeAudit.commit("back", zoom);
		(document.querySelector("[data-rig=back] .cm-scroller") as HTMLElement).scrollTop = top;
		await vf.settle(); await vf.rest();
	}, { zoom: ZOOM, top: TOP });
	const before = await read(page);
	expect(before.zoom, "premise: the note is at 50 percent before Back").toBeCloseTo(ZOOM, 3);
	expect(before.top, "premise: the note is scrolled well down before Back").toBeGreaterThan(300);
	return before;
}

type Frame = { zoom: number; top: number };
type Commit = { zoom: number; scroll: { left: number; top: number } | null; accepted: boolean };

/**
 * From here on: after every frame's own callbacks have run (so what the frame painted), the camera of the overlay
 * showing the note, while one shows it; and every camera commit with its answer. Read back by `unwatch`.
 */
const watch = (page: Page): Promise<void> => page.evaluate(() => {
	const w = window as any, vf = w.viewportFixture;
	w.__frames = []; w.__commits = []; w.__watching = true;
	const proto = Object.getPrototypeOf(vf.overlay("back")), commit = proto.commitCameraScale;
	proto.commitCameraScale = function (this: unknown, ...args: unknown[]) {
		const accepted = commit.apply(this, args);
		w.__commits.push({ zoom: args[0], scroll: args[1] ?? null, accepted });
		return accepted;
	};
	w.__unwatch = () => { w.__watching = false; proto.commitCameraScale = commit; };
	const tick = () => requestAnimationFrame(() => {
		const channel = new MessageChannel();
		channel.port1.onmessage = () => {
			const o = vf.overlayAt(w.__backPath), sc = document.querySelector("[data-rig=back] .cm-scroller") as HTMLElement | null;
			if (o && sc) w.__frames.push({ zoom: o.pinchScaleNow, top: sc.scrollTop });
			if (w.__watching) tick();
		};
		channel.port2.postMessage(0);
	});
	tick();
});
const unwatch = (page: Page): Promise<{ frames: Frame[]; commits: Commit[] }> =>
	page.evaluate(() => { const w = window as any; w.__unwatch(); return { frames: w.__frames, commits: w.__commits }; });

/** Every frame that showed the note after the step showed it at the remembered camera, and the restore's commit was taken. */
function noDefaultFrame(step: string, before: View, seen: { frames: Frame[]; commits: Commit[] }): void {
	const report = JSON.stringify({ before, frames: seen.frames.slice(0, 6), commits: seen.commits });
	expect(seen.frames.length, `premise: frames showing the note were read after ${step}; ${report}`).toBeGreaterThan(0);
	const wrong = seen.frames.find(f => Math.abs(f.zoom - before.zoom) > 1e-3 || Math.abs(f.top - before.top) > 1);
	expect.soft(wrong, `FRAMES: after ${step} a frame showed the note at zoom ${wrong?.zoom} scrollTop ${wrong?.top} before its remembered camera; ${report}`).toBeUndefined();
	const restores = seen.commits.filter(c => c.scroll !== null && Math.abs(c.zoom - before.zoom) <= 1e-9);
	expect.soft(restores.length > 0 && restores.every(c => c.accepted), `COMMIT: the restore's camera commit after ${step} was missing or refused; ${report}`).toBe(true);
}

it("Back that reloads the same note keeps its zoom and scroll", async () => {
	const page = await open();
	const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
	try {
		const before = await zoomedAndScrolled(page);
		await watch(page);
		await page.evaluate(async () => { const vf = (window as any).viewportFixture; await vf.reopen("back"); await vf.settle(); await vf.rest(); });
		const seen = await unwatch(page);
		const after = await read(page);
		// eslint-disable-next-line no-console
		console.log("BACK-KEEPS-VIEW same note reloaded", JSON.stringify({ before, after, frames: seen.frames.length, commits: seen.commits }));
		expect.soft(after.zoom, `ZOOM: Back that reloads the note changed its zoom ${JSON.stringify({ before, after })}`).toBeCloseTo(before.zoom, 3);
		expect.soft(Math.abs(after.top - before.top), `SCROLL: Back that reloads the note moved it from scrollTop ${before.top} to ${after.top}`).toBeLessThanOrEqual(1);
		noDefaultFrame("the reload", before, seen);
		expect(errors).toEqual([]);
	} finally { await page.close(); }
}, 60_000);

it("leaving the note and coming back keeps its zoom and scroll", async () => {
	const page = await open();
	const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
	try {
		const before = await zoomedAndScrolled(page);
		await watch(page);
		const away = await page.evaluate(async () => {
			const vf = (window as any).viewportFixture;
			await vf.switchPath("back", "back-other.md"); await vf.rest();
			const s = vf.snap("back");
			await vf.switchPath("back", "fit-back.md"); await vf.settle(); await vf.rest();
			return { zoom: s.state.zoom, top: s.scroll.top };
		});
		const seen = await unwatch(page);
		const after = await read(page);
		// eslint-disable-next-line no-console
		console.log("BACK-KEEPS-VIEW leave and return", JSON.stringify({ before, away, after, frames: seen.frames.length, commits: seen.commits }));
		expect.soft(after.zoom, `ZOOM: coming back to the note did not restore its zoom ${JSON.stringify({ before, away, after })}`).toBeCloseTo(before.zoom, 3);
		expect.soft(Math.abs(after.top - before.top), `SCROLL: coming back to the note did not restore scrollTop ${before.top}, read ${after.top}`).toBeLessThanOrEqual(1);
		// The frames from before the switch away showed the note at rest at its camera too, so they stand with the rest.
		noDefaultFrame("coming back", before, seen);
		expect(errors).toEqual([]);
	} finally { await page.close(); }
}, 60_000);

it("Back that reloads a note whose ink read is slow shows no frame at 100 percent and the top first", async () => {
	const page = await open();
	const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
	try {
		const before = await zoomedAndScrolled(page);
		await watch(page);
		// The read stays held across the reload's whole settle: eight frames painted with the note open.
		await page.evaluate(async () => { const vf = (window as any).viewportFixture; vf.holdRead(); await vf.reopen("back"); await vf.settle(); });
		const seen = await unwatch(page);
		await page.evaluate(async () => { const vf = (window as any).viewportFixture; await vf.releaseRead(); await vf.rest(); });
		const after = await read(page);
		// eslint-disable-next-line no-console
		console.log("BACK-KEEPS-VIEW slow read", JSON.stringify({ before, after, frames: seen.frames.slice(0, 4), commits: seen.commits }));
		noDefaultFrame("the reload with the ink read held", before, seen);
		expect.soft(after.zoom, `ZOOM: after the read landed ${JSON.stringify({ before, after })}`).toBeCloseTo(before.zoom, 3);
		expect.soft(Math.abs(after.top - before.top), `SCROLL: after the read landed, scrollTop ${before.top} to ${after.top}`).toBeLessThanOrEqual(1);
		expect(errors).toEqual([]);
	} finally { await page.close(); }
}, 60_000);

it("a note left at a Fit zoom under the ten percent floor comes back at exactly that zoom", async () => {
	const page = await open();
	const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
	try {
		const fitted = await page.evaluate(async () => {
			const vf = (window as any).viewportFixture;
			await vf.setup("back", "below-minimum");
			(window as any).__backPath = "fit-back.md";
			const f = await vf.fitVisible("back"); await vf.rest();
			return { result: f.result as string, zoom: f.state.zoom as number };
		});
		expect(fitted.result, `premise: Fit committed; ${JSON.stringify(fitted)}`).toBe("fit");
		expect(fitted.zoom, `premise: Fit went under the ten percent floor; ${JSON.stringify(fitted)}`).toBeLessThan(0.1);
		const before = await read(page);
		await watch(page);
		await page.evaluate(async () => { const vf = (window as any).viewportFixture; await vf.reopen("back"); await vf.settle(); await vf.rest(); });
		const seen = await unwatch(page);
		const after = await read(page);
		// eslint-disable-next-line no-console
		console.log("BACK-KEEPS-VIEW under the floor", JSON.stringify({ fitted, before, after, commits: seen.commits }));
		expect.soft(after.zoom, `FLOOR: the reopened note did not come back at its Fit zoom exactly ${JSON.stringify({ fitted, before, after })}`).toBe(fitted.zoom);
		expect.soft(Math.abs(after.top - before.top), `SCROLL: the reopened note moved from scrollTop ${before.top} to ${after.top}`).toBeLessThanOrEqual(1);
		noDefaultFrame("the reload under the floor", before, seen);
		expect(errors).toEqual([]);
	} finally { await page.close(); }
}, 60_000);

const ZOOM_IN = 2.86;

/**
 * The rig note at ZOOM_IN with a Readable line length column: the pane 1200 px wide (wider than the 700 px line width,
 * so the column has a margin at 100 percent), Obsidian's sizer around the content, the readable class on the pane.
 * Both scrolls are then set to the middle of the range.
 */
async function readableAtZoomIn(page: Page): Promise<{ m100: number | null; m: number | null; layout: unknown }> {
	return page.evaluate(async (zoom) => {
		const vf = (window as any).viewportFixture;
		await vf.setup("back", "far");
		(window as any).__backPath = "fit-back.md";
		const o = vf.overlay("back"), view = o.view, host = document.querySelector("[data-rig=back]") as HTMLElement;
		host.classList.add("mod-cm6", "is-readable-line-width");
		host.style.width = "1200px"; host.style.height = "720px"; view.dom.style.width = "1200px"; view.dom.style.height = "720px";
		if (!view.dom.querySelector(".cm-sizer")) {
			const content = view.contentDOM, sizer = document.createElement("div"), container = document.createElement("div");
			sizer.className = "cm-sizer"; container.className = "cm-contentContainer";
			content.parentElement.insertBefore(sizer, content); sizer.appendChild(container); container.appendChild(content);
		}
		view.requestMeasure(); o.handleResize(); await vf.settle(); await vf.rest();
		// A commit in place at 100 percent writes the layout the painted margin is read from.
		await (window as any).edgeAudit.commit("back", 1); await vf.rest();
		const m100 = o.paintedColumnMargin();
		await (window as any).edgeAudit.commit("back", zoom);
		const sc = view.scrollDOM;
		sc.scrollLeft = Math.round((sc.scrollWidth - sc.clientWidth) / 2); sc.scrollTop = Math.round((sc.scrollHeight - sc.clientHeight) / 2);
		await vf.settle(); await vf.rest();
		const l = o.viewportLayout;
		return { m100, m: o.paintedColumnMargin(), layout: l && { sizerColumn: l.sizerColumn, ownLines: l.ownLines, columnLocal: l.columnLocal } };
	}, ZOOM_IN);
}

/** Away to another note in the same editor and back: the view after, and the scroll range there. */
async function awayAndBack(page: Page): Promise<{ after: View; range: { x: number; y: number } }> {
	await page.evaluate(async () => {
		const vf = (window as any).viewportFixture;
		await vf.switchPath("back", "back-other.md"); await vf.rest();
		await vf.switchPath("back", "fit-back.md"); await vf.settle(); await vf.rest();
	});
	const after = await read(page);
	const range = await page.evaluate(() => { const sc = document.querySelector("[data-rig=back] .cm-scroller") as HTMLElement; return { x: sc.scrollWidth - sc.clientWidth, y: sc.scrollHeight - sc.clientHeight }; });
	return { after, range };
}

for (const theme of ["obsidian", "minimal"] as const) it(`at 286 percent with a Readable line length column${theme === "minimal" ? " under Minimal" : ""}, leaving the note and coming back keeps both scrolls`, async () => {
	const page = await open(theme);
	const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
	try {
		const col = await readableAtZoomIn(page);
		const before = await read(page);
		const { after, range } = await awayAndBack(page);
		// eslint-disable-next-line no-console
		console.log(`BACK-KEEPS-VIEW zoomed in ${theme}`, JSON.stringify({ col, before, after, range }));
		expect(before.zoom, "premise: the note is at 286 percent before it is left").toBeCloseTo(ZOOM_IN, 3);
		expect(col.m100 !== null && col.m !== null && Math.abs(col.m100 - col.m) > 1, `premise: the column's painted margin at 100 percent differs from the one at 286 (${JSON.stringify(col)})`).toBe(true);
		expect(before.left > 1 && before.top > 1, `premise: both scrolls inside the range, off 0 (${JSON.stringify(before)})`).toBe(true);
		expect.soft(after.zoom, `ZOOM: coming back did not restore 286 percent ${JSON.stringify({ before, after })}`).toBeCloseTo(before.zoom, 3);
		expect.soft(Math.abs(after.left - before.left), `SCROLL X: coming back moved scrollLeft from ${before.left} to ${after.left}`).toBeLessThanOrEqual(1);
		expect.soft(Math.abs(after.top - before.top), `SCROLL Y: coming back moved scrollTop from ${before.top} to ${after.top}`).toBeLessThanOrEqual(1);
		expect(errors).toEqual([]);
	} finally { await page.close(); }
}, 60_000);

it("at 286 percent with the canvas on, a view past the ink's far edge comes back on both axes", async () => {
	const page = await open();
	const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
	try {
		const past = await page.evaluate(async (zoom) => {
			const vf = (window as any).viewportFixture;
			await vf.setup("back", "far");
			(window as any).__backPath = "fit-back.md";
			await (window as any).edgeAudit.commit("back", zoom);
			// Room the canvas grants past the ink, as a pan into empty space grants it: the scroll stepped right and down a
			// frame at a time, each step asking the extent for more, until the view is 2000 px past the ink on both axes.
			const o = vf.overlay("back"), sc = o.view.scrollDOM, vr = sc.getBoundingClientRect(), s = vf.snap("back");
			const inkRight = Math.max(...s.ink.map((i: any) => i.right)) - vr.left + sc.scrollLeft, inkBottom = Math.max(...s.ink.map((i: any) => i.bottom)) - vr.top + sc.scrollTop;
			const want = { left: Math.round(inkRight + 2000), top: Math.round(inkBottom + 2000) };
			for (let i = 0; i < 200 && (sc.scrollLeft < want.left || sc.scrollTop < want.top); i++) {
				sc.scrollLeft = Math.min(want.left, sc.scrollLeft + 300); sc.scrollTop = Math.min(want.top, sc.scrollTop + 300);
				await new Promise<void>(r => requestAnimationFrame(() => r()));
			}
			await vf.settle(); await vf.rest();
			const grown = { extent: vf.snap("back").extent };
			return { inkRight, inkBottom, grown, range: { x: sc.scrollWidth - sc.clientWidth, y: sc.scrollHeight - sc.clientHeight } };
		}, ZOOM_IN);
		const before = await read(page);
		const { after, range } = await awayAndBack(page);
		// eslint-disable-next-line no-console
		console.log("BACK-KEEPS-VIEW canvas past the ink", JSON.stringify({ past, before, after, range }));
		expect(before.zoom, "premise: the note is at 286 percent before it is left").toBeCloseTo(ZOOM_IN, 3);
		expect(before.left > past.inkRight && before.top > past.inkBottom, `premise: the view is past the ink's far edge on both axes (${JSON.stringify({ past, before })})`).toBe(true);
		expect.soft(after.zoom, `ZOOM: coming back did not restore 286 percent ${JSON.stringify({ before, after })}`).toBeCloseTo(before.zoom, 3);
		expect.soft(Math.abs(after.left - before.left), `SCROLL X: coming back moved scrollLeft from ${before.left} to ${after.left}`).toBeLessThanOrEqual(1);
		expect.soft(Math.abs(after.top - before.top), `SCROLL Y: coming back moved scrollTop from ${before.top} to ${after.top}`).toBeLessThanOrEqual(1);
		expect(errors).toEqual([]);
	} finally { await page.close(); }
}, 60_000);

// A restore leaves no margin debt behind. Coming back puts the view where it was; a commit in place at the same zoom right
// after it, as a zoom button or a refresh makes one, then has nothing owed to pay and keeps both scrolls.
for (const theme of ["obsidian", "minimal"] as const) it(`at 286 percent with a Readable line length column${theme === "minimal" ? " under Minimal" : ""}, a commit in place after coming back keeps both scrolls`, async () => {
	const page = await open(theme);
	const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
	try {
		const col = await readableAtZoomIn(page);
		const before = await read(page);
		const { after: back } = await awayAndBack(page);
		await page.evaluate(async (zoom) => { await (window as any).edgeAudit.commit("back", zoom); await (window as any).viewportFixture.rest(); }, ZOOM_IN);
		const after = await read(page);
		// eslint-disable-next-line no-console
		console.log(`BACK-KEEPS-VIEW commit in place after coming back ${theme}`, JSON.stringify({ col, before, back, after }));
		expect(col.m100 !== null && col.m !== null && Math.abs(col.m100 - col.m) > 1, `premise: the column's painted margin at 100 percent differs from the one at 286 (${JSON.stringify(col)})`).toBe(true);
		expect(Math.abs(back.left - before.left) <= 1 && Math.abs(back.top - before.top) <= 1, `premise: coming back restored both scrolls (${JSON.stringify({ before, back })})`).toBe(true);
		expect.soft(after.zoom, `ZOOM: the commit in place changed the zoom ${JSON.stringify({ before, after })}`).toBeCloseTo(before.zoom, 3);
		expect.soft(Math.abs(after.left - before.left), `SCROLL X: the commit in place after coming back moved scrollLeft from ${before.left} to ${after.left}`).toBeLessThanOrEqual(1);
		expect.soft(Math.abs(after.top - before.top), `SCROLL Y: the commit in place after coming back moved scrollTop from ${before.top} to ${after.top}`).toBeLessThanOrEqual(1);
		expect(errors).toEqual([]);
	} finally { await page.close(); }
}, 60_000);
