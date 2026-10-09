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
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";

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

async function open(): Promise<Page> {
	const page = await browser.newPage({ viewport: { width: 700, height: 540 } });
	await page.setContent("<!doctype html><body></body>");
	await page.addStyleTag({ content: css + readFileSync(fileURLToPath(new URL("./noteViewportCamera.css", import.meta.url)), "utf8") });
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
