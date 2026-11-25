/**
 * PAGE GUIDES' DASHED OUTLINE ON SCREEN, on the real note rig (noteViewportCameraPage.ts, Infinite Canvas on, paper none,
 * white page, border token #777), page deviceScaleFactor 2, at note zoom 1 and 0.25:
 *
 * 1. SIDE X: the box's left at the text column's left edge (the first line's rect), within 1 px; its right one page
 *    width away (the larger of Letter's 739.2 px and the column, times the zoom), within 1 px, where that fits in the
 *    note's area; where it does not, the box stops at the area's edge and carries the cut class.
 * 2. THE STYLE, READ FROM THE COMPUTED STYLE: each side line's gradient is a dash then a gap of 4 SCREEN px each, so 4
 *    over the zoom in the box's layout px, the dash in the border token at half strength (alpha 0.5, the token's own
 *    channels); the page ends' tile is a dash and a gap wide.
 * 3. A DASH AT EACH LINE'S START, READ FROM THE SCREEN, 4 css px (8 device px) at every zoom: the left line's first
 *    device rows are ink, then a gap, then ink;
 *    the right line likewise where it is drawn; the first page end's first device columns are ink, then a gap, then ink;
 *    and no ink left of the box on the page end's row.
 * 4. NO SCROLL ROOM UNDER A STANDING PAN, at zoom 0.5: at a pan of +x, +y, -x, -y and +400 painted px x (past the gap
 *    between the box's right and the area's edge), the scroller's scrollWidth and scrollHeight are the same with the
 *    guides' box up as with it gone.
 * 5. THE GUIDES FOLLOW A STANDING PAN ON THE GLASS, at zooms 1 and 0.5: the box's left within half a px of the first
 *    line's left at a standing pan of +x and -x.
 *
 * Run: npx vitest run --config vitest.render.mts test/render/PageGuidesOutline.test.ts
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import { decodePng, type Decoded } from "./pngInk";

declare const process: { env: Record<string, string | undefined> };

let browser: Browser, viewportScript: string;
const DPR = 2;
const LETTER_W = 739.2;

beforeAll(async () => {
	const bv = await build({
		entryPoints: [fileURLToPath(new URL("./noteViewportCameraPage.ts", import.meta.url))],
		bundle: true, write: false, format: "iife", platform: "browser",
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
	});
	viewportScript = bv.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);
afterAll(async () => { await browser?.close(); });

async function openRig(id: string, zoom: number) {
	const page = await browser.newPage({ viewport: { width: 700, height: 540 }, deviceScaleFactor: DPR });
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	await page.setContent(`<!doctype html><body style="--background-modifier-border:#777; background:white"></body>`);
	await page.addStyleTag({ content: css + readFileSync(fileURLToPath(new URL("./noteViewportCamera.css", import.meta.url)), "utf8") });
	await page.addScriptTag({ content: viewportScript });
	await page.evaluate(i => (window as any).viewportFixture.setup(i, "empty"), id);
	const committed = await page.evaluate(a => (window as any).edgeAudit.commit(a.id, a.z), { id, z: zoom }) as any;
	await page.evaluate(i => (window as any).viewportFixture.rest(i), id);
	return { page, errors, committed };
}

const read = (page: Page, id: string) => page.evaluate(i => {
	const o = (window as any).viewportFixture.overlay(i);
	const sc = document.querySelector(".cm-scroller") as HTMLElement;
	const b = sc.querySelector(":scope > .handwriting-page-guides") as HTMLElement | null;
	const line = document.querySelector(".cm-content .cm-line") as HTMLElement;
	const lr = line.getBoundingClientRect(), sr = sc.getBoundingClientRect();
	if (!b) return null;
	const r = b.getBoundingClientRect(), cs = getComputedStyle(b);
	return {
		box: { left: r.left, right: r.right, top: r.top, bottom: r.bottom }, line: { left: lr.left, right: lr.right },
		scroller: { left: sr.left + sc.clientLeft, right: sr.left + sc.clientLeft + sc.clientWidth, top: sr.top + sc.clientTop, bottom: sr.top + sc.clientTop + sc.clientHeight },
		open: b.classList.contains("handwriting-page-guides-open"), k: o.cssScale as number, column: o.viewportLayout?.columnBox as number,
		area: o.pageGuideArea as { x: number; full: number; w: number; top: number; h: number } | null,
		pitch: Number.parseFloat(b.style.getPropertyValue("--handwriting-page-guide-pitch")),
		image: cs.backgroundImage, size: cs.backgroundSize, position: cs.backgroundPosition, repeat: cs.backgroundRepeat,
	};
}, id);

/** Top-level comma split. */
function layers(s: string): string[] {
	const out: string[] = []; let depth = 0, from = 0;
	for (let i = 0; i < s.length; i++) { if (s[i] === "(") depth++; else if (s[i] === ")") depth--; else if (s[i] === "," && depth === 0) { out.push(s.slice(from, i).trim()); from = i + 1; } }
	out.push(s.slice(from).trim());
	return out;
}
/** A computed colour's channels 0..1 and alpha, from `rgba(...)`, `rgb(...)` or `color(srgb r g b / a)`. */
function colour(s: string): { r: number; g: number; b: number; a: number } | null {
	let m = /^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.e-]+))?\)$/.exec(s);
	if (m) return { r: +m[1]!, g: +m[2]!, b: +m[3]!, a: m[4] === undefined ? 1 : +m[4] };
	m = /^rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?\)$/.exec(s);
	if (m) return { r: +m[1]! / 255, g: +m[2]! / 255, b: +m[3]! / 255, a: m[4] === undefined ? 1 : +m[4] };
	if (s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
	return null;
}
/** A gradient's stops as [colour, position px]. */
function stops(gradient: string): { c: ReturnType<typeof colour>; at: number }[] {
	const inner = gradient.slice(gradient.indexOf("(") + 1, gradient.lastIndexOf(")"));
	return layers(inner).filter(p => !/^to /.test(p)).map(p => { const m = /^(.*\)|[a-z]+) (-?[\d.]+)px$/.exec(p); return { c: m ? colour(m[1]!) : null, at: m ? +m[2]! : Number.NaN }; });
}

/** Luminance 0..255 of the device pixel at (x, y) of a decoded clip. */
const lum = (d: Decoded, x: number, y: number) => { const i = (y * d.width + x) * d.channels; return (d.px[i]! + d.px[i + 1]! + d.px[i + 2]!) / 3; };
const INK = (v: number) => v < 235, CLEAR = (v: number) => v > 250;

for (const zoom of [1, 0.25]) it(`page guides outline at zoom ${zoom}: side lines at the column edge and one page on, dashed 4 and 4 screen px at half the border token, a dash at each line's start`, async () => {
	const id = `guides-outline-${zoom}`;
	const { page, errors, committed } = await openRig(id, zoom);
	try {
		expect(committed.accepted, "premise: the zoom committed").toBe(true);
		const s = await read(page, id);
		expect(s, "the box is up").not.toBeNull();
		const g = s!;
		const label = JSON.stringify({ box: g.box, line: g.line, scroller: g.scroller, open: g.open, k: g.k, column: g.column, pitch: g.pitch, area: g.area });
		// 1. Side x. The area is the note's scrollable area (the canvas's grant included), not the visible width.
		expect(Math.abs(g.box.left - g.line.left), `left side line at the column's left edge ${label}`).toBeLessThanOrEqual(1);
		expect(g.area, `premise: the box's area is stored ${label}`).not.toBeNull();
		const full = Math.max(LETTER_W, g.column);
		const right = g.line.left + full * g.k;
		const fits = full <= g.area!.w - g.area!.x + 0.001;
		if (fits) {
			expect(g.open, `the whole outline fits: the right line is drawn ${label}`).toBe(false);
			expect(Math.abs(g.box.right - right), `right side line one page width on ${label}`).toBeLessThanOrEqual(1);
		} else {
			expect(g.open, `the outline is past the area: cut ${label}`).toBe(true);
			expect(Math.abs(g.box.right - (g.line.left + (g.area!.w - g.area!.x) * g.k)), `the box stops at the area's edge ${label}`).toBeLessThanOrEqual(1);
		}
		// 2. The style, from the computed style.
		const img = layers(g.image);
		expect(img.length, g.image).toBe(3);
		const side = stops(img[0]!);
		// Screen px: 4 over the painted scale in the box's layout px.
		const unit = 4 / g.k;
		const want = [0, unit, unit, 2 * unit];
		expect(side.length, img[0]).toBe(4);
		side.forEach((p, i) => expect(p.at, `side line stop ${i}: dash 4, gap 4 screen px at k ${g.k} ${img[0]}`).toBeCloseTo(want[i]!, 2));
		for (const p of side.slice(0, 2)) {
			expect(p.c, img[0]).not.toBeNull();
			expect(p.c!.a, `dash at half strength ${img[0]}`).toBeCloseTo(0.5, 3);
			for (const ch of [p.c!.r, p.c!.g, p.c!.b]) expect(ch, `the border token's channels ${img[0]}`).toBeCloseTo(0x77 / 255, 2);
		}
		for (const p of side.slice(2)) expect(p.c?.a, `the gap is clear ${img[0]}`).toBe(0);
		expect(img[1], "the right line").toBe(g.open ? "none" : img[0]);
		expect(img[2]!.startsWith("conic-gradient("), img[2]).toBe(true);
		const tile = layers(g.size)[2]!.split(" ").map(v => Number.parseFloat(v));
		expect(tile[0], `the page ends' tile: a dash and a gap wide, 8 screen px ${g.size}`).toBeCloseTo(2 * unit, 2);
		expect(tile[1], `the page ends' tile: a page tall ${g.size}`).toBeCloseTo(g.pitch, 3);
		// 3. A dash at each line's start, on the screen.
		const clip = { x: Math.max(0, Math.floor(g.box.left) - 4), y: Math.floor(g.box.top), width: Math.min(690, Math.ceil(g.box.right) + 4) - Math.max(0, Math.floor(g.box.left) - 4), height: Math.min(Math.ceil(g.box.top + g.pitch * g.k) + 4, 536) - Math.floor(g.box.top) };
		// The guides alone on the glass: the rig's text sits on the left line (its first glyph column at the column's left
		// edge) and a floating chip of the rig (a rounded box with a ">") crosses the right line near the top at zoom 0.25.
		// Everything but the box is hidden for the shot, so each probe reads the guides' own paint. The page as it stands
		// is kept beside it as evidence.
		if (process.env.PGO_EVIDENCE) writeFileSync(`${process.env.PGO_EVIDENCE}/guides-outline-zoom-${zoom}-page.png`, await page.screenshot({ clip }));
		await page.evaluate(() => {
			document.body.style.visibility = "hidden";
			(document.querySelector(".cm-scroller > .handwriting-page-guides") as HTMLElement).style.visibility = "visible";
		});
		const d = decodePng(await page.screenshot({ clip }));
		const X = (cx: number) => Math.round((cx - clip.x) * DPR), Y = (cy: number) => Math.round((cy - clip.y) * DPR);
		// 4 css px on the glass at every zoom: 4 x DPR device px.
		const dash = 4 * DPR;
		const col = (x: number) => Array.from({ length: Math.round(3 * dash) }, (_, j) => Math.round(lum(d, x, Y(g.box.top) + j)));
		const leftCol = col(X(g.box.left));
		const at = (arr: number[], f: number) => arr[Math.min(arr.length - 1, Math.floor(f))]!;
		expect(INK(at(leftCol, dash / 2)) && CLEAR(at(leftCol, dash * 1.5)) && INK(at(leftCol, dash * 2.5)), `left line: dash, gap, dash from its top ${leftCol.join(",")}`).toBe(true);
		// The right line where it is drawn and on the glass (the clip stops at 690 css px).
		if (!g.open && g.box.right <= 689) {
			// A paper rule wide in layout px, so under a css px at a small zoom: the darker of the two device columns at the
			// box's right edge. The columns read go in the label.
			const a = col(X(g.box.right) - 1), b = col(X(g.box.right) - 2);
			const rightCol = a.map((v, j) => Math.min(v, b[j]!));
			// Logged at every zoom, pass or fail: the two columns and the darkest dash pixel as an alpha of the border
			// token over white (1 = the token itself, 0.5 = the line's own strength at full coverage).
			const alpha = (255 - Math.min(...rightCol.slice(0, dash))) / (255 - 0x77);
			const leftAlpha = (255 - Math.min(...leftCol.slice(0, dash))) / (255 - 0x77);
			// What else is on those rows: a column 3 device px past the box, and one midway between the lines.
			const past = col(Math.min(d.width - 1, X(g.box.right) + 3)), mid = col(X((g.box.left + g.box.right) / 2));
			console.log(`RIGHT-LINE zoom ${zoom} past-box cols ${past.join(",")} | mid cols ${mid.join(",")}`);
			const ev = process.env.PGO_EVIDENCE;
			if (ev) writeFileSync(`${ev}/guides-outline-zoom-${zoom}-guides-only.png`, await page.screenshot({ clip }));
			console.log(`RIGHT-LINE zoom ${zoom} k ${g.k} device x ${X(g.box.right) - 2},${X(g.box.right) - 1} cols ${b.join(",")} | ${a.join(",")} dash alpha ${alpha.toFixed(3)} (left line ${leftAlpha.toFixed(3)})`);
			expect(INK(at(rightCol, dash / 2)) && CLEAR(at(rightCol, dash * 1.5)) && INK(at(rightCol, dash * 2.5)), `right line: dash, gap, dash from its top ${a.join(",")} | ${b.join(",")} at device x ${X(g.box.right) - 1} ${label}`).toBe(true);
		}
		const endY = g.box.top + g.pitch * g.k - 0.25;
		if (endY < 536) {
			const row = Array.from({ length: Math.round(3 * dash) + 8 }, (_, j) => Math.round(lum(d, X(g.box.left) - 8 + j, Y(endY))));
			const start = 8;
			expect(row.slice(0, 6).every(CLEAR), `nothing left of the box on the page end's row ${row.join(",")}`).toBe(true);
			expect(INK(at(row, start + dash / 2)) && CLEAR(at(row, start + dash * 1.5)) && INK(at(row, start + dash * 2.5)), `page end: dash, gap, dash from the left line ${row.join(",")}`).toBe(true);
		}
		expect(errors, "no page errors").toEqual([]);
	} finally {
		await page.close();
	}
}, 120_000);

/**
 * Obsidian's `.cm-sizer > .cm-contentContainer` around the content, as noteViewportCameraPage.ts's pinch settlement
 * does: the pan's translate goes on `.cm-sizer` (panSizer), which vanilla CodeMirror 6 has none of, so on the bare rig
 * the text never moves under a pan. The content is moved, not cloned; the box re-syncs on the new tree.
 */
const obsidianSizer = (page: Page, id: string) => page.evaluate(async i => {
	const o = (window as any).viewportFixture.overlay(i);
	const view = o.view;
	if (!view.dom.querySelector(".cm-sizer")) {
		const content = view.contentDOM as HTMLElement, sizer = document.createElement("div"), container = document.createElement("div");
		sizer.className = "cm-sizer"; container.className = "cm-contentContainer";
		content.parentElement!.insertBefore(sizer, content); sizer.appendChild(container); container.appendChild(content);
		void view.scrollDOM.clientWidth;
	}
	await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
	o.syncPageGuideBox();
	return !!o.panSizer();
}, id);

/** Stand a pan (painted px) the way a settle leaves it: the field, then the pan write. */
const standPan = (page: Page, id: string, x: number, y: number) => page.evaluate(a => {
	const o = (window as any).viewportFixture.overlay(a.id);
	o.viewportPan = { x: a.x, y: a.y };
	o.writeViewportPan();
}, { id, x, y });

const PANS: [string, number, number][] = [["+x", 60, 0], ["+y", 0, 60], ["-x", -60, 0], ["-y", 0, -60], ["+400 x", 400, 0], ["-100,-150 (-200,-300 layout)", -100, -150]];

it("page guides under a standing pan at zoom 0.5 add no scroll room: scrollWidth and scrollHeight the same with the box up and gone", async () => {
	const id = "guides-pan-room";
	const { page, errors, committed } = await openRig(id, 0.5);
	try {
		expect(committed.accepted, "premise: the zoom committed").toBe(true);
		expect(await obsidianSizer(page, id), "premise: the pan has Obsidian's sizer to move").toBe(true);
		for (const [name, x, y] of PANS) {
			await standPan(page, id, x, y);
			const r = await page.evaluate(i => {
				const o = (window as any).viewportFixture.overlay(i);
				const sc = document.querySelector(".cm-scroller") as HTMLElement;
				o.removePageGuideBox();
				const off = { w: sc.scrollWidth, h: sc.scrollHeight, box: !!sc.querySelector(":scope > .handwriting-page-guides") };
				o.syncPageGuideBox();
				const b = sc.querySelector(":scope > .handwriting-page-guides") as HTMLElement | null;
				const on = { w: sc.scrollWidth, h: sc.scrollHeight, box: !!b };
				return { off, on, transform: b?.style.transform ?? null, width: b?.style.width ?? null, height: b?.style.height ?? null, open: b?.classList.contains("handwriting-page-guides-open") ?? null, k: o.cssScale };
			}, id);
			const label = `${name} ${JSON.stringify(r)}`;
			expect(r.off.box, `premise: the box is gone ${label}`).toBe(false);
			expect(r.on.box, `premise: the box is up ${label}`).toBe(true);
			expect(r.transform, `premise: the box carries the pan ${label}`).not.toBe("");
			expect(r.on.w, `scrollWidth unchanged by the guides ${label}`).toBe(r.off.w);
			expect(r.on.h, `scrollHeight unchanged by the guides ${label}`).toBe(r.off.h);
		}
		expect(errors, "no page errors").toEqual([]);
	} finally {
		await page.close();
	}
}, 120_000);

for (const zoom of [1, 0.5]) it(`page guides follow a standing pan on the glass at zoom ${zoom}: the box's left within half a px of the first line's left`, async () => {
	const id = `guides-pan-glass-${zoom}`;
	const { page, errors, committed } = await openRig(id, zoom);
	try {
		expect(committed.accepted, "premise: the zoom committed").toBe(true);
		expect(await obsidianSizer(page, id), "premise: the pan has Obsidian's sizer to move").toBe(true);
		const rest = await read(page, id);
		expect(Math.abs(rest!.box.left - rest!.line.left), `premise: at no pan the box is on the column ${JSON.stringify(rest)}`).toBeLessThanOrEqual(0.5);
		// A pan left and up is the canvas's standing rest (a ceiling of 0); right is the pull, read in the same task.
		for (const [name, x, y] of [["-x", -60, 0], ["-x -y", -60, -40], ["+x", 60, 0]] as const) {
			await standPan(page, id, x, y);
			const s = await read(page, id);
			expect(s, `the box is up ${name}`).not.toBeNull();
			const t = await page.evaluate(() => ({
				box: (document.querySelector(".cm-scroller > .handwriting-page-guides") as HTMLElement).style.transform,
				sizer: (document.querySelector(".cm-sizer") as HTMLElement).style.transform,
			}));
			const label = `${name} ${JSON.stringify({ box: s!.box, line: s!.line, k: s!.k, transform: t })}`;
			expect(t.sizer, `premise: the text moved ${label}`).not.toBe("");
			expect(Math.abs(s!.box.left - s!.line.left), `left side line at the column's left edge under the pan ${label}`).toBeLessThanOrEqual(0.5);
		}
		expect(errors, "no page errors").toEqual([]);
	} finally {
		await page.close();
	}
}, 120_000);
