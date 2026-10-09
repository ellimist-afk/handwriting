/**
 * THE VIEW JUMPS AFTER A PINCH IS LET GO, FAR INTO A NOTE WITH INFINITE CANVAS ON.
 *
 * Seen on a device (SCROLL-PROBE-alan-20261006-1d091c72.txt): far right and down in an inked note, a pinch from 89 to 221 percent
 * was let go, the spacer was written, and the scroller then moved by (-317.5, +320.5) with no finger down. A second pinch, to 123
 * percent, wrote the spacer again, started a bounce of 158 px to the left, and the scroller went 2129.5, 1976.5, 2129.5 on three
 * frames in a row before it moved again by (+467, -171.5).
 *
 * The rule: nothing moves at the lift. Once at rest the page stands where the last preview frame left it, to 1 px, and nothing is
 * animated over that: a page far from every edge has no bound to ease to. Only an edge of the scroll range in the pane at the lift
 * lets the page ease, to the bound only. Every scroll write after the lift asks for the settled value, and the settle's hold ends ready.
 *
 * Arms: Readable line length on (the device's setting: Minimal at 19 px) and off (the control). With it on, a zoom out widens the
 * column's margin, and the settle pays that margin back as scroll and a bounce, so the page glides sideways after the lift.
 *
 * Each arm mounts the large ink at 89 percent, scrolls far right and down and bakes that, then pinches to the arm's zoom with the
 * fingers at the pane's centre and lets go. Every frame from the last preview frame until the page has been still for 20 frames
 * records the scroll, the spacer, the resting pan, the bounce, the camera, and where the text column's top left corner is on
 * screen. The text column stands for the page: it rides the bounce with the ink. Each settle also records the scroll target before
 * the commit's corrections and what each correction moved it by, the margin debt, the painted column inset before and after the
 * commit, and whether the settle returned or threw.
 *
 * Run: npx vitest run --config vitest.render.mts test/render/ViewportJumpAfterZoom.test.ts
 * HW_VJ_OUT=<file> writes every arm's frames as JSON.
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

declare const process: { env: Record<string, string | undefined> };

const MINIMAL_CSS = readFileSync(fileURLToPath(new URL("./fixtures/minimal-9.0.2-theme.css", import.meta.url)), "utf8");
const TEMPLATE = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/alan-ink-75d1627a.json", import.meta.url)), "utf8")) as Record<string, unknown>;
const PAGE_ID = "75d1627a-c4d7-4a11-947d-bc26b7f83c20";
const PANE = { w: 1184, h: 824 };
const DSF = 2;

function seeded(seed: number): () => number {
	let a = seed >>> 0;
	return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function strokeJson(i: number, x: number, y: number, rnd: () => number) {
	let heading = rnd() * Math.PI * 2;
	const pts: number[] = [];
	for (let k = 0; k < 14; k++) {
		pts.push(Math.round(x * 100) / 100, Math.round(y * 100) / 100, 0.3 + 0.2 * rnd(), k * 8);
		heading += (rnd() - 0.5) * 0.9; x += Math.cos(heading) * 6; y += Math.sin(heading) * 6;
	}
	return { id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, tool: "pen", color: "#2f6de0", width: 2.6, createdAt: 1788552785194, pts };
}
/** `count` strokes spread over a world `w` by `h` css px from (40, 40). */
function ink(count: number, w: number, h: number): string {
	const rnd = seeded(41);
	const strokes = [];
	for (let i = 0; i < count; i++) strokes.push(strokeJson(i + 1, 40 + rnd() * w, 40 + rnd() * h, rnd));
	return JSON.stringify({ ...TEMPLATE, strokes, images: [], textBoxes: [] });
}

const ENTRY = `import "./panBakeRepaintPage.ts";
import { overlayForPath } from "../../src/inline/InkOverlay";
const frame = () => new Promise<void>(r => requestAnimationFrame(() => r()));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await frame(); };
(window as any).vj = {
	/** Scroll to left, top at the mounted zoom and let the repaint that bakes it run. */
	async scrollTo(path: string, left: number, top: number) {
		const o: any = overlayForPath(path), sd = o.view.scrollDOM;
		sd.scrollLeft = left; sd.scrollTop = top;
		await settle(12);
		o.scheduleRepaint("scroll");
		await settle(12);
		return { left: sd.scrollLeft, top: sd.scrollTop, scrollWidth: sd.scrollWidth, scrollHeight: sd.scrollHeight, bake: !!o.rasterPanNeedsBake(), canvasMode: !!o.canvasMode, zoom: o.pinchScaleNow };
	},
	/** Readable line length on (the pane's class, as Obsidian sets it), then a commit at the same zoom so the layout is measured again. */
	async readable(path: string) {
		const o: any = overlayForPath(path);
		o.view.dom.closest(".markdown-source-view").classList.add("is-readable-line-width");
		await settle(4);
		const ok = !!o.commitCameraScale(o.pinchScaleNow, { left: 0, top: 0 });
		await settle(12);
		return ok;
	},
	/** Every scroll write the overlay makes through setViewportScroll, with what the scroller kept. */
	spyScroll(path: string) {
		const o: any = overlayForPath(path), w = (window as any).vjWrites = [] as any[], orig = o.setViewportScroll;
		o.setViewportScroll = function (this: any, left: number, top: number) {
			const r = orig.call(this, left, top);
			w.push({ t: performance.now(), asked: [left, top], kept: [this.view.scrollDOM.scrollLeft, this.view.scrollDOM.scrollTop], pan: [this.viewportPan.x, this.viewportPan.y],
				offset: [this.bounceOffset.x, this.bounceOffset.y], stack: (new Error().stack ?? "").split(String.fromCharCode(10)).slice(2, 4).map((l: string) => l.trim().split(" (")[0]).join(" < ") });
			return r;
		};
	},
	/**
	 * Per settle: the scroll target's x before the commit's corrections and the by of each (the page box, the margin debt, a fitting
	 * column), the margin debt around the debt's correction, the painted column inset in host-local px before and after the commit,
	 * and whether applyPinchScale returned or threw.
	 */
	spySettle(path: string) {
		const o: any = overlayForPath(path), log = (window as any).vjSettle = [] as any[];
		const inset = () => {
			// Host-local px from the scrolled content's left edge: a scroll of dS moves painted content by -dS times the effective scale.
			const sd = o.view.scrollDOM, s = sd.getBoundingClientRect(), c = o.view.contentDOM.getBoundingClientRect(), k = o.cssScale;
			const shown = k > 0 ? (c.left - s.left) / k + sd.scrollLeft : null;
			// The first rendered line, the same way: where the margin lands when the theme centres lines.
			const e = o.view.contentDOM.firstElementChild as HTMLElement | null, ln = e && k > 0 ? (e.getBoundingClientRect().left - s.left) / k + sd.scrollLeft : null;
			const less = (o.viewportPan.x + o.bounceOffset.x) / k;
			// Less the resting pan and the bounce's offset (screen px): the column's own inset.
			return { local: shown === null ? null : shown - less, line: ln === null ? null : ln - less, lineMargin: e ? parseFloat(getComputedStyle(e).marginLeft) : null, shown, pan: o.viewportPan.x, offset: o.bounceOffset.x, scrollLeft: sd.scrollLeft, applied: o.appliedColumnMargin(o.pinchScaleNow),
				css: o.view.dom.style.getPropertyValue("--handwriting-column-margin-left") };
		};
		const wrap = (name: string, f: (orig: any) => any) => { const orig = o[name]; o[name] = f(orig); };
		wrap("ownLinesPageBoxScrollLeft", orig => function (this: any, next: number, eff: number, left: number) {
			const r = orig.call(this, next, eff, left); log.push({ at: "pageBox", leftIn: left, by: r - left }); return r; });
		wrap("columnMarginDebtScrollLeft", orig => function (this: any, eff: number, left: number) {
			const debt = this.columnMarginDebt, r = orig.call(this, eff, left);
			log.push({ at: "marginDebt", leftIn: left, by: r - left, debtBefore: debt, debtAfter: this.columnMarginDebt, effective: eff }); return r; });
		wrap("columnFitsPane", orig => function (this: any, next: number, eff: number) {
			const r = orig.call(this, next, eff); log.push({ at: "fitsPane", fits: r }); return r; });
		wrap("restColumnAgainstCurrentGrant", orig => function (this: any, next: number, eff: number, shownPainted?: number | null) {
			const shown = shownPainted ?? this.restingColumnMargin, r = orig.call(this, next, eff, shownPainted);
			log.push({ at: "restColumn", shown, settled: this.restingColumnMargin, debt: this.columnMarginDebt }); return r; });
		wrap("commitCameraScale", orig => function (this: any, ...a: any[]) {
			const before = inset(); const r = orig.apply(this, a);
			log.push({ at: "commit", zoom: a[0], target: a[1] ?? null, ok: r, insetBefore: before, insetAfter: inset() }); return r; });
		const caller = () => (new Error().stack ?? "").split(String.fromCharCode(10)).slice(3, 6).map((l: string) => l.trim().split(" (")[0].replace("at InkOverlayPlugin.", "")).join(" < ");
		wrap("startOverscrollBounce", orig => function (this: any, hold: any, dx: number, dy: number, travelled?: boolean) {
			const r = orig.call(this, hold, dx, dy, travelled); log.push({ at: "bounce", dx, dy, travelled: !!travelled, started: r, by: caller() }); return r; });
		wrap("reanchorPan", orig => function (this: any) {
			const before = [this.viewportPan.x, this.viewportPan.y], left = this.view.scrollDOM.scrollLeft; const r = orig.call(this);
			log.push({ at: "reanchorPan", scrollLeft: left, panBefore: before, panAfter: [this.viewportPan.x, this.viewportPan.y], offset: [this.bounceOffset.x, this.bounceOffset.y], by: caller() }); return r; });
		wrap("applyPinchScale", orig => function (this: any, next: number, settle: boolean) {
			try { const r = orig.call(this, next, settle); if (settle) log.push({ at: "applyPinchScale", returned: true }); return r; }
			catch (e) { log.push({ at: "applyPinchScale", threw: String((e as any)?.message ?? e) }); throw e; }
		});
	},
	read(path: string) {
		const o: any = overlayForPath(path), sd = o.view.scrollDOM, c = o.view.contentDOM.getBoundingClientRect(), b = o.overscrollBounceReadout();
		return { t: performance.now(), left: sd.scrollLeft, top: sd.scrollTop, spacer: [o.spacerLeft, o.spacerTop], pan: [o.viewportPan.x, o.viewportPan.y],
			bounce: b.active ? [b.x, b.y, b.fromX, b.fromY] : null, offset: [o.bounceOffset.x, o.bounceOffset.y], cam: [o.camera.x, o.camera.y],
			// With Readable line length on the theme centres each LINE (the content's children carry the margin), so the
			// content box alone does not show where the text is: the first rendered line's left edge and margin are kept too.
			line: (() => { const e = o.view.contentDOM.firstElementChild as HTMLElement | null; return e ? [e.getBoundingClientRect().left, parseFloat(getComputedStyle(e).marginLeft)] : null; })(),
			col: [c.left, c.top], zoom: o.pinchScaleNow, preview: !!o.pinchPreview,
			layout: o.viewportLayout ? { ownLines: o.viewportLayout.ownLines, sizerColumn: o.viewportLayout.sizerColumn, columnInset: o.viewportLayout.columnInset } : null,
			margin: [o.restingColumnMargin, o.columnMarginDebt, o.leftReserveHeld], writes: ((window as any).vjWrites ?? []).splice(0),
			range: [sd.scrollWidth - sd.clientWidth, sd.scrollHeight - sd.clientHeight], settle: ((window as any).vjSettle ?? []).splice(0) };
	},
	/** Pinch from the current zoom to \`to\`, fingers at the pane's centre, in \`steps\` frames; record from the last preview frame on. */
	async pinch(path: string, to: number, steps: number) {
		const o: any = overlayForPath(path), r = o.view.scrollDOM.getBoundingClientRect(), from = o.pinchScaleNow;
		const focal = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
		const rows: any[] = [];
		o.pinch("start", 1, focal);
		for (let i = 1; i <= steps; i++) { o.pinch("move", 1 + (to / from - 1) * i / steps, focal); await frame(); }
		await frame();
		rows.push({ phase: "preview", ...this.read(path) });
		o.pinch("end", to / from, focal);
		const hold = o.panAnchorHold;
		rows.push({ phase: "lift", ...this.read(path) });
		let still = 0;
		for (let j = 0; j < 240 && still < 20; j++) {
			await frame();
			const row = this.read(path), prev = rows[rows.length - 1];
			rows.push({ phase: "after", ...row });
			still = row.left === prev.left && row.top === prev.top && row.col[0] === prev.col[0] && row.col[1] === prev.col[1] && !row.bounce ? still + 1 : 0;
		}
		return { from, to, focal, rows, hold: hold ? { outcome: hold.outcome, ready: hold.ready, attempts: hold.attempts } : null };
	},
};`;

let browser: Browser, script: string;
beforeAll(async () => {
	const b = await build({
		stdin: { contents: ENTRY, resolveDir: fileURLToPath(new URL("./", import.meta.url)), sourcefile: "viewportJumpEntry.ts", loader: "ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
	});
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true, args: [`--force-device-scale-factor=${DSF}`, "--window-size=1700,1000"] });
}, 180_000);
afterAll(async () => { await browser?.close(); });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const PATH = "Untitled 1.md";
const BIG = { count: 4000, w: 11000, h: 13000 };
const FIXTURE = ink(BIG.count, BIG.w, BIG.h);
const OUT: Record<string, unknown> = {};
afterAll(() => { if (process.env.HW_VJ_OUT) writeFileSync(process.env.HW_VJ_OUT, JSON.stringify(OUT, null, 1)); });

async function withNote(zoom: number, body: (page: Page) => Promise<void>) {
	const context = await browser.newContext({ viewport: null, hasTouch: true });
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	try {
		await page.setContent(`<!doctype html><body class="theme-dark" style="margin:0; --font-text-size:19px; --background-modifier-border:#777777"></body>`);
		await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
		await page.addStyleTag({ content: MINIMAL_CSS });
		await page.addScriptTag({ content: script });
		const mounted = await page.evaluate(([z, s, id, w, h, n]) => (window as any).panBake.mount(z, s, id, w, h, n), [zoom, FIXTURE, PAGE_ID, PANE.w, PANE.h, BIG.count] as const) as any;
		expect(mounted.strokes, "premise: every stroke loaded").toBe(BIG.count);
		expect(mounted.zoomCommitted, "premise: the first zoom committed").toBe(true);
		await sleep(400);
		await page.evaluate(() => (window as any).panBake.awaitSharp());
		await body(page);
		expect(errors).toEqual([]);
	} finally { await context.close(); }
}

/**
 * The rule over one pinch's frames, per axis, on the text column's screen position: once the page is at rest it stands where the
 * last preview frame left it (to 1 px). Nothing else moves at the lift, and nothing is animated over: no bounce plays after it and
 * no pan is left standing at rest (to 1 px). Only where an edge of the scroll range sat in the pane at the lift (the scroll at
 * either end of its range) may the page ease, and then to the bound only; that axis is reported and not held. On x the column is
 * the first line when there is one, since with Readable line length on the theme carries the margin on each line. Returns the
 * breaches.
 */
function breach(rows: any[]): string[] {
	const pre = rows.find(r => r.phase === "preview"), lift = rows.find(r => r.phase === "lift"), rest = rows[rows.length - 1];
	const out: string[] = [];
	for (const axis of [0, 1]) {
		const name = axis === 0 ? "x" : "y", at = (r: any) => axis === 0 ? r.left : r.top;
		const edge = [pre, lift].some(r => at(r) <= 0.5 || at(r) >= r.range[axis] - 0.5);
		const pos = (r: any) => axis === 0 && pre.line && r.line ? r.line[0] : r.col[axis];
		const d = pos(rest) - pos(pre), at_ = edge ? ", an edge of the range was in the pane at the lift" : "";
		if (Math.abs(d) > 1) out.push(`${name}: at rest the column stands ${d.toFixed(2)} px from the last preview frame (${pos(pre).toFixed(2)} to ${pos(rest).toFixed(2)})${at_}`);
		const moved = rows.filter(r => r.phase !== "preview" && (Math.abs(r.offset[axis]) > 0.5 || (r.bounce && Math.abs(r.bounce[axis]) > 0.5)));
		if (moved.length) out.push(`${name}: a bounce plays after the lift, from ${moved[0].offset[axis].toFixed(2)} px${at_}`);
		if (Math.abs(rest.pan[axis]) > 1) out.push(`${name}: at rest a pan of ${rest.pan[axis].toFixed(2)} px stands${at_}`);
	}
	return out;
}

const START = { zoom: 0.891480, left: 1980, top: 1361 };

for (const rll of [false, true]) for (const [name, legs] of [
	["one pinch in, 89 to 221 percent", [2.208427]],
	["a pinch in, 89 to 221 percent, then out to 123 percent", [2.208427, 1.225092]],
	["a pinch out, 89 to 50 percent, then back in to 89 percent", [0.5, 0.891480]],
] as const) if (rll || legs[0] !== 0.5) {
	it(`Infinite Canvas on, Readable line length ${rll ? "on" : "off"}, scrolled far right and down: ${name}: after each lift the page rests where the last preview frame left it`, async () => {
		await withNote(START.zoom, async (page) => {
			if (rll) expect(await page.evaluate((p) => (window as any).vj.readable(p), PATH), "premise: the re-measure commit ran").toBe(true);
			await page.evaluate((p) => { (window as any).vj.spyScroll(p); (window as any).vj.spySettle(p); }, PATH);
			const at = await page.evaluate(([p, l, t]) => (window as any).vj.scrollTo(p, l, t), [PATH, START.left, START.top] as const) as any;
			expect(at.canvasMode, `premise: Infinite Canvas is on (${JSON.stringify(at)})`).toBe(true);
			// The scroller under css zoom keeps fractions of a px.
			expect(Math.max(Math.abs(at.left - START.left), Math.abs(at.top - START.top)), `premise: the scroll reached the start (${JSON.stringify(at)})`).toBeLessThan(1);
			expect(at.bake, "premise: the scroll is baked").toBe(false);
			const legsOut: any[] = [];
			for (const to of legs) {
				const leg = await page.evaluate(([p, z]) => (window as any).vj.pinch(p, z, 8), [PATH, to] as const) as any;
				legsOut.push(leg);
				OUT[`rll ${rll ? "on" : "off"}: ${name}`] = legsOut;
				await sleep(300);
			}
			// The rule first, then the scroll writes and the settle's hold; every failure is reported together.
			const found = legsOut.flatMap((l, i) => breach(l.rows).map(b => `leg ${i + 1} (to ${l.to}): ${b}`));
			const writes = legsOut.map(l => l.rows.filter((r: any) => r.phase !== "preview").flatMap((r: any) => r.writes));
			legsOut.forEach((l, i) => {
				const w = writes[i]!, last = w[w.length - 1];
				if (!w.length) found.push(`leg ${i + 1}: premise: the settle wrote no scroll`);
				const off = w.filter((x: any) => Math.abs(x.asked[0] - last.asked[0]) > 0.5 || Math.abs(x.asked[1] - last.asked[1]) > 0.5);
				if (off.length) found.push(`leg ${i + 1}: a scroll write after the lift asks for a value other than the settled one ${JSON.stringify({ settled: last.asked, off: off.map((x: any) => ({ asked: x.asked, by: x.stack })) })}`);
				if (!(l.hold && l.hold.outcome !== "cancelled" && l.hold.ready)) found.push(`leg ${i + 1}: the settle's hold ends cancelled or not ready ${JSON.stringify(l.hold)}`);
			});
			const readout = legsOut.map((l, i) => `leg ${i + 1}: ${JSON.stringify(l.rows.filter((r: any) => r.phase !== "preview").flatMap((r: any) => r.settle))}`).join("\n");
			const brief = legsOut.map(l => l.rows.map((r: any) => `${r.phase} scroll=(${r.left},${r.top}) col=(${r.col[0].toFixed(1)},${r.col[1].toFixed(1)}) line=${r.line ? `${r.line[0].toFixed(1)}+${r.line[1].toFixed(2)}` : "-"} spacer=(${r.spacer}) bounce=${r.bounce ? r.bounce.map((v: number) => v.toFixed(1)).join(",") : "-"} margin=(${r.margin.map((v: any) => typeof v === "number" ? v.toFixed(2) : v)})`).filter((_: string, k: number, a: string[]) => k < 4 || k === a.length - 1).join("\n")).join("\n--\n");
			expect(found, `after the lift the page does not rest where the last preview frame left it:\n${brief}\nsettle readout:\n${readout}`).toEqual([]);
		});
	}, 240_000);
}
