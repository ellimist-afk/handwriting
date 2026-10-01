/**
 * GRID PAPER'S SECOND BOX, everything about it that is not the pixels.
 *
 * `PaperGridProfile.test.ts` reads what the paper PAINTS; this file reads what the fix DOES: which element carries
 * which axis, that no other paper kind grows a box, that the box never feeds the scroll range, that a pinch preview
 * still carries both axes, and that a gesture costs no style write and no forced read it did not cost before.
 *
 * Decided for 1.4.20. The measurement behind it: two repeating
 * gradients on one LARGE box lose the first layer's rules as the box grows, and one gradient per box is clean at
 * every area measured.
 *
 * The rig is the shared viewport fixture (noteViewportCameraPage), which mounts with the Infinite Canvas ON.
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import { decodePng } from "./pngInk";

declare const process: { env: Record<string, string | undefined> };

let browser: Browser;
let script: string;
const OBSIDIAN_CAMERA_CSS = readFileSync(fileURLToPath(new URL("./noteViewportCamera.css", import.meta.url)), "utf8");
const BOX = ".handwriting-paper-grid-column";
/**
 * THE PLANT, for cell C: a box forced on under lined paper. The claim "only grid grows a box" is only worth reading
 * if the cell can see one where it does not belong, and the fix's own code cannot be asked to make that mistake.
 */
const PLANT_BOX_UNDER_LINES = process.env.HW_GRID_PLANT_BOX_UNDER_LINES === "1";

beforeAll(async () => {
	const b = await build({
		entryPoints: [fileURLToPath(new URL("./noteViewportCameraPage.ts", import.meta.url))],
		bundle: true, write: false, format: "iife", platform: "browser",
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
	});
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true, args: ["--window-size=1100,900"] });
}, 240_000);

afterAll(async () => { await browser?.close(); });

/** One note, mounted under a global paper class and an optional per-note override, at 100 percent. */
async function mount(paper: "grid" | "lines" | "dots" | "none", note?: "grid" | "lines" | "dots" | "none", kind = "far"): Promise<{ page: Page; close: () => Promise<void> }> {
	const ctx = await browser.newContext({ viewport: null });
	const page = await ctx.newPage();
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	await page.setContent(`<!doctype html><body class="${paper === "none" ? "" : `handwriting-paper-${paper}`}" style="margin:0; background:#ffffff; --background-modifier-border:#777777"></body>`);
	await page.addStyleTag({ content: css + OBSIDIAN_CAMERA_CSS });
	await page.addScriptTag({ content: script });
	await page.evaluate(async ({ note, kind, plant }) => {
		await (window as any).viewportFixture.setup("paper", kind, 1, 1, "x");
		if (note) {
			// The per-note route: NotePaper writes the attribute on the leaf CONTAINER, which the stylesheet reads as an
			// ancestor of the pane (`body [data-handwriting-paper] .markdown-source-view .cm-scroller`). The rig's host is
			// the pane itself, so the cell gives it the container it would have in Obsidian.
			const pane = document.querySelector(".markdown-source-view") as HTMLElement;
			const container = document.createElement("div");
			pane.parentElement!.insertBefore(container, pane);
			container.appendChild(pane);
			// The attribute goes on once the container is IN the page, as NotePaper sets it on a container already
			// there: set while detached, the change is invisible to anything watching the document.
			container.setAttribute("data-handwriting-paper", note);
		}
		if (plant) {
			const sc = document.querySelector(".cm-scroller") as HTMLElement;
			const box = document.createElement("div");
			box.className = "handwriting-paper-grid-column";
			box.style.cssText = "width:100px;height:100px";
			sc.insertBefore(box, sc.firstChild);
		}
		await (window as any).viewportFixture.settle();
		// The paper plan pass owns the box; a paper changed after mount is exactly the case it has to follow.
		(window as any).viewportFixture.overlay("paper").updateExtent(true);
		await (window as any).viewportFixture.settle();
	}, { note: note ?? null, kind, plant: PLANT_BOX_UNDER_LINES && paper === "lines" });
	return { page, close: async () => { await ctx.close(); expect(errors, "no page errors").toEqual([]); } };
}

/** What the page holds: the box, and the layers each element resolves. */
async function read(page: Page): Promise<{ marker: string; boxes: number; boxWidth: number; boxHeight: number; scrollerLayers: string[]; boxLayers: string[]; linesLayers: string[]; scrollWidth: number; scrollHeight: number; clientWidth: number; clientHeight: number; contentHeight: number }> {
	return await page.evaluate(({ BOX }) => {
		const sc = document.querySelector(".cm-scroller") as HTMLElement;
		const box = document.querySelector(BOX) as HTMLElement | null;
		const layers = (value: string): string[] => {
			const out: string[] = [];
			let depth = 0, start = 0;
			for (let i = 0; i < value.length; i++) {
				const c = value[i];
				if (c === "(") depth++;
				else if (c === ")") depth = Math.max(0, depth - 1);
				else if (c === "," && depth === 0) { out.push(value.slice(start, i).trim()); start = i + 1; }
			}
			const last = value.slice(start).trim();
			if (last && last !== "none") out.push(last);
			return out;
		};
		// Lined paper resolved on this very page, for the comparison the ruling asks for: the grid's scroller layer is
		// the one lined paper has, stop for stop. The probe is built INSIDE the note's own host, so it inherits this
		// note's planned pitch, rule and phase - resolved anywhere else it would carry the stylesheet's fallbacks and
		// the comparison would mean nothing. It is removed before anything else is read.
		const host = document.querySelector(".cm-editor") as HTMLElement;
		const container = document.createElement("div");
		container.setAttribute("data-handwriting-paper", "lines");
		const pane = document.createElement("div");
		pane.className = "markdown-source-view mod-cm6";
		const probe = document.createElement("div");
		probe.className = "cm-scroller";
		pane.appendChild(probe);
		container.appendChild(pane);
		host.appendChild(container);
		const linesLayers = layers(getComputedStyle(probe).backgroundImage);
		container.remove();
		const sizer = sc.querySelector(".cm-sizer") as HTMLElement | null;
		return {
			// The marker the stylesheet states for every paper kind, and the overlay reads to decide about the box.
			marker: getComputedStyle(sc).getPropertyValue("--handwriting-paper-grid").trim(),
			boxes: document.querySelectorAll(BOX).length,
			boxWidth: box ? box.offsetWidth : 0, boxHeight: box ? box.offsetHeight : 0,
			scrollerLayers: layers(getComputedStyle(sc).backgroundImage),
			boxLayers: box ? layers(getComputedStyle(box).backgroundImage) : [],
			linesLayers,
			scrollWidth: sc.scrollWidth, scrollHeight: sc.scrollHeight, clientWidth: sc.clientWidth, clientHeight: sc.clientHeight,
			contentHeight: sizer ? sizer.offsetTop + sizer.offsetHeight : 0,
		};
	}, { BOX });
}

/**
 * A computed `background-image` prints a direction only when it is not the default, so the horizontal layer - which
 * runs `to bottom` - resolves with no direction at all, and the vertical one keeps its `to right`.
 */
const vertical = (layer: string): boolean => /^repeating-linear-gradient\(to right/.test(layer);
const horizontal = (layer: string): boolean => /^repeating-linear-gradient\(/.test(layer) && !/to right|to left|to top|\ddeg/.test(layer);

/**
 * C. ONE AXIS PER BOX UNDER GRID, AND NO BOX ANYWHERE ELSE. Both routes to grid: the global class and a note's own
 * attribute, including grid under a global dots and lines under a global grid, which is the cascade the marker
 * property has to get right.
 */
const PAPERS: { label: string; paper: "grid" | "lines" | "dots" | "none"; note?: "grid" | "lines" | "dots" | "none"; grid: boolean }[] = [
	{ label: "global grid", paper: "grid", grid: true },
	{ label: "global dots, note grid", paper: "dots", note: "grid", grid: true },
	{ label: "global lines, note grid", paper: "lines", note: "grid", grid: true },
	{ label: "global lines", paper: "lines", grid: false },
	{ label: "global dots", paper: "dots", grid: false },
	{ label: "no paper", paper: "none", grid: false },
	{ label: "global grid, note lines", paper: "grid", note: "lines", grid: false },
	{ label: "global grid, note none", paper: "grid", note: "none", grid: false },
];

it.each(PAPERS.map(a => [a.label, a] as const))("C: the vertical rules have their own box under grid and nowhere else - %s", async (_label, a) => {
	const { page, close } = await mount(a.paper, a.note);
	try {
		const r = await read(page);
		// eslint-disable-next-line no-console
		console.log(`PAPER-BOX-C ${a.label}`, JSON.stringify(r));
		if (a.grid) {
			expect(r.boxes, `${a.label}: grid paper has exactly one vertical box`).toBe(1);
			expect(r.boxLayers.length, `${a.label}: the box paints one layer ${JSON.stringify(r.boxLayers)}`).toBe(1);
			expect(vertical(r.boxLayers[0]!), `${a.label}: and that layer is the vertical rules`).toBe(true);
			expect(r.scrollerLayers.length, `${a.label}: the scroller keeps one layer ${JSON.stringify(r.scrollerLayers)}`).toBe(1);
			expect(horizontal(r.scrollerLayers[0]!), `${a.label}: and that layer is the horizontal rules`).toBe(true);
			// The ruling's own wording: the scroller keeps the horizontal layer EXACTLY as lined paper has it.
			expect(r.scrollerLayers[0], `${a.label}: the scroller's layer is the one lined paper resolves to`).toBe(r.linesLayers[0]);
		} else {
			expect(r.boxes, `${a.label}: no paper but grid grows a box`).toBe(0);
			expect(r.scrollerLayers.filter(vertical).length, `${a.label}: nothing paints vertical rules here ${JSON.stringify(r.scrollerLayers)}`).toBe(0);
			if (a.paper === "lines" && !a.note) expect(r.scrollerLayers.length, `${a.label}: lined paper is one layer on the scroller`).toBe(1);
			if (a.paper === "none" || a.note === "none") expect(r.scrollerLayers.length, `${a.label}: none paints nothing`).toBe(0);
		}
	} finally { await close(); }
}, 240_000);

/**
 * D. THE BOX NEVER FEEDS THE SCROLL RANGE. The box is inside the scroller, so a size taken from `scrollWidth` or
 * `scrollHeight` would grow the very number it was taken from. The cell reads the range with the box in place and
 * again with it pulled out, at mount, after a note grows by 200 lines, and after those lines are deleted again.
 */
it("D: the vertical box adds no scroll range, and follows a note that grows and shrinks", async () => {
	const { page, close } = await mount("grid");
	try {
		const rows = await page.evaluate(async ({ BOX }) => {
			const sc = document.querySelector(".cm-scroller") as HTMLElement;
			const fixture = (window as any).viewportFixture;
			const out: unknown[] = [];
			const measure = async (phase: string): Promise<void> => {
				const box = document.querySelector(BOX) as HTMLElement | null;
				const sizer = sc.querySelector(".cm-sizer") as HTMLElement | null;
				const withBox = { w: sc.scrollWidth, h: sc.scrollHeight };
				const parent = box?.parentElement ?? null, next = box?.nextSibling ?? null;
				box?.remove();
				// The range the scroller has without the box at all: the content and the extent spacer alone.
				const withoutBox = { w: sc.scrollWidth, h: sc.scrollHeight };
				if (box && parent) parent.insertBefore(box, next);
				out.push({ phase, withBox, withoutBox, boxes: document.querySelectorAll(BOX).length,
					boxW: box ? box.offsetWidth : 0, boxH: box ? box.offsetHeight : 0,
					contentH: sizer ? sizer.offsetTop + sizer.offsetHeight : 0, clientH: sc.clientHeight });
			};
			await measure("mounted");
			const view = fixture.overlay("paper").view;
			const grown = Array.from({ length: 200 }, (_, i) => `line ${i + 1} alpha beta gamma`).join("\n");
			view.dispatch({ changes: { from: 0, insert: grown } });
			await fixture.settle();
			await measure("grown");
			view.dispatch({ changes: { from: 0, to: grown.length, insert: "" } });
			await fixture.settle();
			await measure("shrunk");
			return out;
		}, { BOX });
		// eslint-disable-next-line no-console
		console.log("PAPER-BOX-D", JSON.stringify(rows));
		for (const row of rows as any[]) {
			expect(row.boxes, `${row.phase}: the box is still there`).toBe(1);
			expect(row.withBox.w, `${row.phase}: the box adds no horizontal scroll range (${row.withBox.w} with it, ${row.withoutBox.w} without)`).toBe(row.withoutBox.w);
			expect(row.withBox.h, `${row.phase}: the box adds no vertical scroll range (${row.withBox.h} with it, ${row.withoutBox.h} without)`).toBe(row.withoutBox.h);
			expect(row.boxH, `${row.phase}: the box covers the content (${row.boxH} against ${Math.max(row.contentH, row.clientH)})`).toBeGreaterThanOrEqual(Math.min(row.contentH, row.clientH));
		}
		const grown = (rows as any[]).find(r => r.phase === "grown"), mounted = (rows as any[]).find(r => r.phase === "mounted");
		expect(grown.boxH, "the box grew with the note").toBeGreaterThanOrEqual(mounted.boxH);
	} finally { await close(); }
}, 240_000);

/**
 * B. THE PINCH PREVIEW CARRIES BOTH AXES. While a preview lives the paper is one element outside the scroller
 * (`InkOverlay.beginPreviewPaper`), which copies what the scroller resolves - and under this fix one axis no longer
 * lives there. The copy takes the box's layer too, and the previewing class quiets the scroller AND the box, so no
 * frame shows an axis twice or not at all.
 */
it("B: a pinch preview paints both axes, and neither the scroller nor the box paints underneath it", async () => {
	const { page, close } = await mount("grid");
	try {
		const seen = await page.evaluate(async ({ BOX }) => {
			const fixture = (window as any).viewportFixture;
			const o = fixture.overlay("paper") as any;
			const sc = document.querySelector(".cm-scroller") as HTMLElement;
			const focal = { x: 300, y: 300 };
			// A gradient carries commas between its own stops, so the layers are counted at depth zero only.
			const layersOf = (el: Element): number => {
				const value = getComputedStyle(el).backgroundImage;
				if (!value || value === "none") return 0;
				let depth = 0, n = 1;
				for (const c of value) {
					if (c === "(") depth++;
					else if (c === ")") depth = Math.max(0, depth - 1);
					else if (c === "," && depth === 0) n++;
				}
				return n;
			};
			o.pinch("start", 1, focal);
			await new Promise(r => requestAnimationFrame(() => r(null)));
			o.pinch("move", 0.7, focal);
			await new Promise(r => requestAnimationFrame(() => r(null)));
			o.pinch("move", 0.5, focal);
			await new Promise(r => requestAnimationFrame(() => r(null)));
			const el = document.querySelector(".handwriting-paper-preview") as HTMLElement | null;
			const image = el ? getComputedStyle(el).backgroundImage : "";
			const mid = {
				preview: !!o.pinchPreview,
				previewElement: !!el,
				previewLayers: el ? layersOf(el) : 0,
				// A computed value prints a direction only when it is not the default, so the vertical layer keeps its
				// `to right` and the horizontal one resolves with no direction at all.
				previewHasHorizontal: /(^|,\s*)repeating-linear-gradient\((?!to )/.test(image),
				previewHasVertical: /to right/.test(image),
				scrollerLayers: layersOf(sc),
				boxLayers: document.querySelector(BOX) ? layersOf(document.querySelector(BOX)!) : -1,
				state: fixture.previewPaper("paper").present,
				previewingClass: fixture.previewPaper("paper").previewing,
			};
			o.pinch("end", 0.5, focal);
			await fixture.rest("paper");
			const after = {
				previewElement: !!document.querySelector(".handwriting-paper-preview"),
				scrollerLayers: layersOf(sc),
				boxLayers: document.querySelector(BOX) ? layersOf(document.querySelector(BOX)!) : -1,
				state: fixture.previewPaper("paper").present,
				previewingClass: fixture.previewPaper("paper").previewing,
			};
			return { mid, after };
		}, { BOX });
		// eslint-disable-next-line no-console
		console.log("PAPER-BOX-B", JSON.stringify(seen));
		expect(seen.mid.preview, "premise: the gesture reached a preview").toBe(true);
		expect(seen.mid.previewElement, "premise: the preview paper element went up").toBe(true);
		expect(seen.mid.state, "premise: the paper the page shows is the preview element").toBe(true);
		expect(seen.mid.previewingClass, "premise: the scroller carries the previewing class").toBe(true);
		expect(seen.mid.previewLayers, "mid-preview: the preview paints two layers").toBe(2);
		expect(seen.mid.previewHasHorizontal, "mid-preview: one of them is the horizontal rules").toBe(true);
		expect(seen.mid.previewHasVertical, "mid-preview: the other is the vertical rules").toBe(true);
		expect(seen.mid.scrollerLayers, "mid-preview: the scroller paints nothing underneath").toBe(0);
		expect(seen.mid.boxLayers, "mid-preview: the vertical box paints nothing underneath either").toBe(0);
		expect(seen.after.previewElement, "at rest: the preview paper is down").toBe(false);
		expect(seen.after.state, "at rest: the preview paper is gone").toBe(false);
		expect(seen.after.previewingClass, "at rest: the previewing class is off the scroller").toBe(false);
		expect(seen.after.scrollerLayers, "at rest: the scroller has its horizontal layer back").toBe(1);
		expect(seen.after.boxLayers, "at rest: the box has its vertical layer back").toBe(1);
	} finally { await close(); }
}, 240_000);

/**
 * E. THE HOT PATH. Latency is a release priority: a per-frame cost here is a defect, not a nit. The cell counts, for
 * grid and for lined paper, the style writes the page takes (every `style` attribute mutation, seen by a mutation
 * observer) and the forced reads (`getComputedStyle`, patched for the run) across a sixty-frame pinch and sixty
 * scroll events. Grid must add neither.
 */
const HOT: { label: string; paper: "grid" | "lines" }[] = [{ label: "grid", paper: "grid" }, { label: "lines", paper: "lines" }];

async function hotPath(page: Page): Promise<{ pinchWrites: number; pinchReads: number; scrollWrites: number; scrollReads: number; boxWrites: number }> {
	return await page.evaluate(async ({ BOX }) => {
		const fixture = (window as any).viewportFixture;
		const o = fixture.overlay("paper") as any;
		const sc = document.querySelector(".cm-scroller") as HTMLElement;
		const host = o.view.dom as HTMLElement;
		let reads = 0;
		const real = window.getComputedStyle.bind(window);
		(window as any).getComputedStyle = (...args: unknown[]): CSSStyleDeclaration => { reads++; return (real as any)(...args); };
		let writes = 0, boxWrites = 0;
		const box = document.querySelector(BOX);
		const observer = new MutationObserver(records => {
			for (const r of records) { writes++; if (box && r.target === box) boxWrites++; }
		});
		for (const el of [sc, host, ...(box ? [box] : []), ...Array.from(host.querySelectorAll("*"))]) observer.observe(el, { attributes: true, attributeFilter: ["style"] });
		const frame = (): Promise<unknown> => new Promise(r => requestAnimationFrame(() => r(null)));
		const focal = { x: 300, y: 300 };
		reads = 0; writes = 0; boxWrites = 0;
		o.pinch("start", 1, focal);
		await frame();
		for (let i = 1; i <= 60; i++) { o.pinch("move", 1 - i * 0.008, focal); await frame(); }
		const pinch = { writes, reads, boxWrites };
		o.pinch("end", 1 - 60 * 0.008, focal);
		await fixture.rest("paper");
		reads = 0; writes = 0;
		for (let i = 1; i <= 60; i++) { sc.scrollTop = 100 + i * 7; sc.dispatchEvent(new Event("scroll", { bubbles: false })); await frame(); }
		const scroll = { writes, reads };
		observer.disconnect();
		(window as any).getComputedStyle = real;
		return { pinchWrites: pinch.writes, pinchReads: pinch.reads, scrollWrites: scroll.writes, scrollReads: scroll.reads, boxWrites: pinch.boxWrites };
	}, { BOX });
}

it("E: grid costs no style write and no forced read that lined paper does not, through a pinch and a scroll", async () => {
	const counts: Record<string, Awaited<ReturnType<typeof hotPath>>> = {};
	for (const arm of HOT) {
		const { page, close } = await mount(arm.paper);
		try { counts[arm.label] = await hotPath(page); } finally { await close(); }
	}
	// eslint-disable-next-line no-console
	console.log("PAPER-BOX-E", JSON.stringify(counts));
	const grid = counts["grid"]!, lines = counts["lines"]!;
	expect(grid.boxWrites, "the vertical box is not written to on a preview frame at all").toBe(0);
	// Per frame, not in total: sixty frames of a pinch and sixty scroll events, so one write a frame is sixty.
	expect(grid.pinchWrites - lines.pinchWrites, `a pinch frame writes no more under grid (grid ${grid.pinchWrites}, lines ${lines.pinchWrites} over 60 frames)`).toBeLessThan(60);
	expect(grid.pinchReads - lines.pinchReads, `a pinch frame forces no more style reads under grid (grid ${grid.pinchReads}, lines ${lines.pinchReads} over 60 frames)`).toBeLessThan(60);
	expect(grid.scrollWrites - lines.scrollWrites, `a scrolled frame writes no more under grid (grid ${grid.scrollWrites}, lines ${lines.scrollWrites} over 60 events)`).toBeLessThan(60);
	expect(grid.scrollReads - lines.scrollReads, `a scrolled frame forces no more style reads under grid (grid ${grid.scrollReads}, lines ${lines.scrollReads} over 60 events)`).toBeLessThan(60);
}, 300_000);

/**
 * H, I, J and the stacking question. The stylesheet paints BOTH axes on a grid scroller by default: the
 * box is the overlay's, and a scroller with no overlay on it - or one in the frames before the overlay's first pass -
 * would otherwise show lined paper where the user chose grid. The scroller gives up its vertical layer only under
 * `handwriting-paper-grid-split`, which the overlay adds in the same call that puts the box in the page.
 */
it("H: a grid scroller with no overlay on it still paints both axes itself", async () => {
	const { page, close } = await mount("grid");
	try {
		const seen = await page.evaluate(() => {
			const layers = (el: Element): string[] => {
				const value = getComputedStyle(el).backgroundImage;
				if (!value || value === "none") return [];
				const out: string[] = [];
				let depth = 0, start = 0;
				for (let i = 0; i < value.length; i++) {
					const c = value[i];
					if (c === "(") depth++;
					else if (c === ")") depth = Math.max(0, depth - 1);
					else if (c === "," && depth === 0) { out.push(value.slice(start, i).trim()); start = i + 1; }
				}
				out.push(value.slice(start).trim());
				return out;
			};
			// A grid scroller of its own, with no overlay and no class: what Obsidian paints before this plugin has
			// touched a pane, and what the NotePaper probe page reads.
			const bare = document.createElement("div");
			bare.className = "markdown-source-view mod-cm6";
			const scroller = document.createElement("div");
			scroller.className = "cm-scroller";
			bare.appendChild(scroller);
			document.body.appendChild(bare);
			const bareLayers = layers(scroller);
			bare.remove();
			const live = document.querySelector(".cm-scroller") as HTMLElement;
			return { bareLayers, liveLayers: layers(live), split: live.classList.contains("handwriting-paper-grid-split") };
		});
		// eslint-disable-next-line no-console
		console.log("PAPER-BOX-H", JSON.stringify(seen));
		expect(seen.bareLayers.length, `a scroller with no overlay paints the whole grid itself ${JSON.stringify(seen.bareLayers)}`).toBe(2);
		expect(seen.bareLayers.filter(vertical).length, "including the vertical rules").toBe(1);
		expect(seen.bareLayers.filter(horizontal).length, "and the horizontal ones").toBe(1);
		expect(seen.split, "premise: the overlay's own scroller has the split class").toBe(true);
		expect(seen.liveLayers.length, "and that one has given up its vertical layer to the box").toBe(1);
	} finally { await close(); }
}, 240_000);

it("I: the split class and the box arrive together and leave together, on every paper change", async () => {
	const { page, close } = await mount("grid");
	try {
		const rows = await page.evaluate(async ({ BOX }) => {
			const fixture = (window as any).viewportFixture;
			const sc = document.querySelector(".cm-scroller") as HTMLElement;
			const out: unknown[] = [];
			// Every frame between a paper change and its settle, not just the state either side: a class without a box
			// paints nothing where the grid's columns belong, and a box without the class paints them twice.
			const watch = async (phase: string, change: () => void): Promise<void> => {
				change();
				for (let i = 0; i < 12; i++) {
					out.push({ phase, frame: i, split: sc.classList.contains("handwriting-paper-grid-split"), boxes: document.querySelectorAll(BOX).length });
					await new Promise(r => requestAnimationFrame(() => r(null)));
				}
				await fixture.settle();
				out.push({ phase: `${phase}-settled`, frame: -1, split: sc.classList.contains("handwriting-paper-grid-split"), boxes: document.querySelectorAll(BOX).length });
			};
			out.push({ phase: "mounted", frame: -1, split: sc.classList.contains("handwriting-paper-grid-split"), boxes: document.querySelectorAll(BOX).length });
			await watch("to-lines", () => { document.body.className = "handwriting-paper-lines"; });
			await watch("back-to-grid", () => { document.body.className = "handwriting-paper-grid"; });
			await watch("to-none", () => { document.body.className = ""; });
			return out;
		}, { BOX });
		// eslint-disable-next-line no-console
		console.log("PAPER-BOX-I", JSON.stringify(rows));
		for (const row of rows as any[]) {
			expect(row.split ? 1 : 0, `${row.phase} frame ${row.frame}: the class and the box are in step (class ${row.split}, boxes ${row.boxes})`).toBe(row.boxes);
		}
		const settled = (phase: string): any => (rows as any[]).find(r => r.phase === phase);
		expect(settled("to-lines-settled").boxes, "lined paper ends with no box").toBe(0);
		expect(settled("back-to-grid-settled").boxes, "grid again ends with one").toBe(1);
		expect(settled("to-none-settled").boxes, "no paper ends with none").toBe(0);
	} finally { await close(); }
}, 240_000);

it("J: the preview copy still carries both axes with the split class on", async () => {
	const { page, close } = await mount("grid");
	try {
		const seen = await page.evaluate(async () => {
			const fixture = (window as any).viewportFixture;
			const o = fixture.overlay("paper") as any;
			const sc = document.querySelector(".cm-scroller") as HTMLElement;
			const focal = { x: 300, y: 300 };
			const before = sc.classList.contains("handwriting-paper-grid-split");
			o.pinch("start", 1, focal);
			await new Promise(r => requestAnimationFrame(() => r(null)));
			o.pinch("move", 0.6, focal);
			await new Promise(r => requestAnimationFrame(() => r(null)));
			const el = document.querySelector(".handwriting-paper-preview") as HTMLElement | null;
			const image = el ? getComputedStyle(el).backgroundImage : "";
			const mid = { split: sc.classList.contains("handwriting-paper-grid-split"), hasVertical: /to right/.test(image),
				hasHorizontal: /(^|,\s*)repeating-linear-gradient\((?!to )/.test(image) };
			o.pinch("end", 0.6, focal);
			await fixture.rest("paper");
			return { before, mid, after: sc.classList.contains("handwriting-paper-grid-split") };
		});
		// eslint-disable-next-line no-console
		console.log("PAPER-BOX-J", JSON.stringify(seen));
		expect(seen.before, "premise: the split is in force before the gesture").toBe(true);
		expect(seen.mid.split, "the split stays in force through the preview").toBe(true);
		expect(seen.mid.hasHorizontal, "and the preview copy carries the horizontal rules").toBe(true);
		expect(seen.mid.hasVertical, "and the vertical ones, taken from the box").toBe(true);
		expect(seen.after, "and the split is still in force at rest").toBe(true);
	} finally { await close(); }
}, 240_000);

/**
 * THE STACKING QUESTION, measured rather than reasoned about. The box is `z-index: -1` inside the
 * scroller. A negative child paints behind its PARENT'S OWN BACKGROUND unless that parent is a stacking context, so a
 * theme that gives the scroller an opaque `background-color` could hide the vertical rules outright. This cell counts
 * the vertical rules in the pixels with such a colour in place, against the same strip without it.
 */
it("the vertical rules survive an opaque background-color on the scroller", async () => {
	const { page, close } = await mount("grid");
	try {
		const where = await page.evaluate(() => {
			const sc = document.querySelector(".cm-scroller") as HTMLElement, r = sc.getBoundingClientRect();
			// The text is ink a profile would read as paper; hidden, not removed, so the plan does not move.
			const style = document.createElement("style");
			style.textContent = ".cm-line, .cm-widgetBuffer { visibility: hidden !important; } canvas { visibility: hidden !important; }";
			document.head.appendChild(style);
			const cs = getComputedStyle(sc);
			return { clip: { x: Math.round(r.left + 6), y: Math.round(r.top + 6), width: Math.min(420, Math.floor(r.width) - 12), height: 18 },
				position: cs.position, zIndex: cs.zIndex, isolation: cs.isolation,
				// WHERE that z-index comes from, so the answer is not "it happened to work here": inline style, then the
				// stylesheet rules that match this element at all.
				inlineZ: sc.style.zIndex, inlinePosition: sc.style.position,
				stackingContext: cs.position !== "static" && cs.zIndex !== "auto" };
		});
		/** Vertical rules in a strip: columns whose median grey is darker than halfway to the rule colour. */
		const rules = async (): Promise<number> => {
			const d = decodePng(await page.screenshot({ clip: where.clip }));
			let n = 0, wasDark = false;
			for (let x = 0; x < d.width; x++) {
				const values: number[] = [];
				for (let y = 0; y < d.height; y++) {
					const at = (y * d.width + x) * d.channels;
					values.push((d.px[at]! + d.px[at + 1]! + d.px[at + 2]!) / 3);
				}
				values.sort((a, b) => a - b);
				const dark = values[Math.floor(values.length / 2)]! < 200;
				if (dark && !wasDark) n++;
				wasDark = dark;
			}
			return n;
		};
		const plain = await rules();
		await page.evaluate(() => {
			// What a theme does: an opaque colour on the scroller itself, under its own paper.
			(document.querySelector(".cm-scroller") as HTMLElement).style.backgroundColor = "rgb(255, 255, 255)";
		});
		const opaque = await rules();
		// eslint-disable-next-line no-console
		console.log("PAPER-BOX-STACK", JSON.stringify({ ...where, plainRules: plain, opaqueRules: opaque }));
		expect(plain, "premise: the strip holds vertical rules to count").toBeGreaterThanOrEqual(4);
		expect(opaque, `an opaque background-color on the scroller does not hide the box's rules (${plain} without it, ${opaque} with it)`).toBe(plain);
	} finally { await close(); }
}, 240_000);
