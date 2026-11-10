/**
 * EACH SLIDE'S INK MOVES WITH ITS OWN SLIDE DURING A SLIDE CHANGE.
 *
 * The ink layers hang on `.reveal`, so Reveal's transition never moved them, and the layers were repainted for the new
 * slide at the change: the incoming slide's ink sat over the outgoing slide's text and stood still while both slides
 * moved. Now, during a change only, the outgoing slide's ink follows its section and the
 * incoming slide's ink follows its own, translation and opacity, until the slide lands; a transition that is not a pure
 * translation hides the committed ink until then; at the land one plain repaint.
 *
 * The page (slidesTransitionPage.ts) is a real SlidesDeck over three sections laid out by Reveal's own rules: every rule
 * below is a verbatim slice of the reveal.css bundled in Obsidian 1.14.5 (obsidian-1.14.5.asar, lib/reveal/reveal.css,
 * 46725 bytes, sha256 cb3c0deb593f2f6527a5955f47a3f6e2c192b2bed35fb52231c95966e2d2d727), cited by byte offset. The
 * transitions run by the browser are those rules' transitions, paused and seeked, so a mid-move frame is exact. What
 * the viewer sees is read from compositor screenshots by hue: magenta and a yellow wash on slide 1, cyan and a yellow
 * wash on slide 2, green on slide 3, orange for a stroke drawn mid-move; the background is #191919 and text is grey.
 * Grey text is drawn with colour fringes at its glyph edges on some machines (subpixel text), and a fringe pixel can
 * read as an ink hue, so every shot is read with each slide's title box, where it is on screen, masked out. No ink is
 * drawn near a title, and every shot checks that: a stroke box meeting a padded title box fails the case as a fixture
 * error, so the mask can never hide ink. Each shot logs how many hued pixels its mask took out.
 *
 * Run: npm run test:render -- SlidesTransitionInk.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { launch, stylesCss } from "./harness";
import { decodePng, type Decoded } from "./pngInk";
import type {} from "./slidesTransitionPage";

const REVEAL_CSS = `
/* reveal.css offset 11150 */
.reveal{position:relative;width:100%;height:100%;overflow:hidden;touch-action:pinch-zoom}
/* reveal.css offset 11275 */
.reveal .slides{position:absolute;width:100%;height:100%;top:0;right:0;bottom:0;left:0;margin:auto;pointer-events:none;overflow:visible;z-index:1;text-align:center;perspective:600px;perspective-origin:50% 40%}
/* reveal.css offset 11526 */
.reveal .slides>section,.reveal .slides>section>section{display:none;position:absolute;width:100%;pointer-events:auto;z-index:10;transform-style:flat;transition:transform-origin .8s cubic-bezier(.26,.86,.44,.985),transform .8s cubic-bezier(.26,.86,.44,.985),visibility .8s cubic-bezier(.26,.86,.44,.985),opacity .8s cubic-bezier(.26,.86,.44,.985)}
/* reveal.css offset 12272 */
.reveal .slides>section.present,.reveal .slides>section>section.present{display:block;z-index:11;opacity:1}
/* reveal.css offset 12871 */
.reveal .slides>section.future,.reveal .slides>section.future>section,.reveal .slides>section.past,.reveal .slides>section.past>section,.reveal .slides>section>section.future,.reveal .slides>section>section.past{opacity:0}
/* reveal.css offset 13093 */
.reveal .slides>section[data-transition=slide].past,.reveal .slides>section[data-transition~=slide-out].past,.reveal.slide .slides>section:not([data-transition]).past{transform:translate(-150%,0)}
/* reveal.css offset 13289 */
.reveal .slides>section[data-transition=slide].future,.reveal .slides>section[data-transition~=slide-in].future,.reveal.slide .slides>section:not([data-transition]).future{transform:translate(150%,0)}
/* reveal.css offset 15942 */
.reveal .slides section[data-transition=convex].stack,.reveal.convex .slides section.stack{transform-style:preserve-3d}
/* reveal.css offset 16061 */
.reveal .slides>section[data-transition=convex].past,.reveal .slides>section[data-transition~=convex-out].past,.reveal.convex .slides>section:not([data-transition]).past{transform:translate3d(-100%,0,0) rotateY(-90deg) translate3d(-100%,0,0)}
/* reveal.css offset 16303 */
.reveal .slides>section[data-transition=convex].future,.reveal .slides>section[data-transition~=convex-in].future,.reveal.convex .slides>section:not([data-transition]).future{transform:translate3d(100%,0,0) rotateY(90deg) translate3d(100%,0,0)}
/* reveal.css offset 18234 */
.reveal .slides section[data-transition=zoom],.reveal.zoom .slides section:not([data-transition]){transition-timing-function:ease}
/* reveal.css offset 18364 */
.reveal .slides>section[data-transition=zoom].past,.reveal .slides>section[data-transition~=zoom-out].past,.reveal.zoom .slides>section:not([data-transition]).past{visibility:hidden;transform:scale(16)}
/* reveal.css offset 18566 */
.reveal .slides>section[data-transition=zoom].future,.reveal .slides>section[data-transition~=zoom-in].future,.reveal.zoom .slides>section:not([data-transition]).future{visibility:hidden;transform:scale(.2)}
/* reveal.css offset 21489 */
.reveal .slides section[data-transition=fade],.reveal.fade .slides section:not([data-transition]),.reveal.fade .slides>section>section:not([data-transition]){transform:none;transition:opacity .5s}
/* reveal.css offset 21785 */
.reveal .slides section[data-transition=none],.reveal.none .slides section:not([data-transition]){transform:none;transition:none}
`;

const W = 1000, H = 760, BG = 25;
type Hue = "magenta" | "cyan" | "yellow" | "green" | "orange";
const HUES: Hue[] = ["magenta", "cyan", "yellow", "green", "orange"];

/** A pixel's ink hue, or null for the background, grey text and their edges. */
function hueOf(r: number, g: number, b: number): Hue | null {
	const T = 12, hi = Math.max(r, g, b), lo = Math.min(r, g, b);
	if (hi - lo < T) return null;
	if (r - g > T && b - g > T && Math.abs(r - b) < 0.35 * (hi - lo)) return "magenta";
	if (g - r > T && b - r > T && Math.abs(g - b) < 0.35 * (hi - lo)) return "cyan";
	if (g - r > T && g - b > T) return "green";
	if (r - b > T && g - b > T) return (r - g) / (r - b) < 0.33 ? "yellow" : "orange";
	return null;
}

type Box = { left: number; top: number; right: number; bottom: number };
type Found = { count: number; box: Box | null };
/** A screenshot with the title boxes on screen when it was taken; their pixels are never read as ink. */
type Shot = Decoded & { mask: Box[] };
/** Title boxes are grown by this much each way, screen px, for fringes past the glyph box. */
const MASK_PAD = 3;

const grow = (m: Box): Box => ({ left: m.left - MASK_PAD, top: m.top - MASK_PAD, right: m.right + MASK_PAD, bottom: m.bottom + MASK_PAD });
const meets = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const masked = (img: Shot, x: number, y: number) =>
	img.mask.some(m => x >= m.left - MASK_PAD && x < m.right + MASK_PAD && y >= m.top - MASK_PAD && y < m.bottom + MASK_PAD);

/** Each hue's pixel count and bounding box, inside `region` (screen px) if given. */
function inks(img: Shot, region?: Box): Record<Hue, Found> {
	const out = Object.fromEntries(HUES.map(h => [h, { count: 0, box: null }])) as Record<Hue, Found>;
	const x0 = Math.max(0, Math.ceil(region?.left ?? 0)), x1 = Math.min(img.width, Math.floor(region?.right ?? img.width));
	const y0 = Math.max(0, Math.ceil(region?.top ?? 0)), y1 = Math.min(img.height, Math.floor(region?.bottom ?? img.height));
	for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
		const o = (y * img.width + x) * img.channels;
		const h = hueOf(img.px[o]!, img.px[o + 1]!, img.px[o + 2]!);
		if (!h || masked(img, x, y)) continue;
		const f = out[h];
		f.count++;
		f.box = f.box ? { left: Math.min(f.box.left, x), top: Math.min(f.box.top, y), right: Math.max(f.box.right, x + 1), bottom: Math.max(f.box.bottom, y + 1) }
			: { left: x, top: y, right: x + 1, bottom: y + 1 };
	}
	return out;
}

function px(img: Decoded, x: number, y: number): [number, number, number] {
	const o = (Math.round(y) * img.width + Math.round(x)) * img.channels;
	return [img.px[o]!, img.px[o + 1]!, img.px[o + 2]!];
}

let browser: Browser, bundle: string, page: Page;
beforeAll(async () => {
	const result = await build({ entryPoints: [fileURLToPath(new URL("./slidesTransitionPage.ts", import.meta.url))],
		bundle: true, write: false, format: "iife", platform: "browser", target: "es2022",
		alias: { obsidian: fileURLToPath(new URL("../obsidian-stub.ts", import.meta.url)) } });
	bundle = result.outputFiles[0]!.text;
	browser = await launch();
});
afterAll(async () => { await browser?.close(); });

async function fresh(transition = "slide", opts: { refuse?: boolean; throwDraw?: boolean } = {}) {
	await page?.close();
	page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
	page.on("pageerror", e => { throw e; });
	await page.setContent("<!doctype html><html><body style='margin:0'></body></html>");
	await page.addStyleTag({ content: REVEAL_CSS });
	await page.addStyleTag({ content: stylesCss() });
	await page.addScriptTag({ content: bundle });
	return page.evaluate(([t, o]) => window.slidesTransition.open(t, o), [transition, opts] as const);
}
type State = Awaited<ReturnType<typeof fresh>>;
/**
 * A screenshot with the shown title boxes live at that moment. Fails as a fixture error if the present slide's title
 * is not among them, or if any stroke's screen box, on a section that is only translated, meets a padded title box;
 * logs the hued pixels the mask took out.
 */
const shot = async (label: string): Promise<Shot> => {
	const { titles, strokes } = await page.evaluate(() => ({ titles: window.slidesTransition.titles(), strokes: window.slidesTransition.inkBoxes() }));
	// The mask never goes empty: the present slide's title is always shown, so it is always masked.
	expect(titles.some(t => t.present), `fixture error at ${label}: the mask holds the present slide's title`).toBe(true);
	const hits = strokes.filter(s => titles.some(t => meets(s.box, grow(t)))).map(s => s.id);
	expect(hits, `fixture error at ${label}: a stroke box meets a title mask`).toEqual([]);
	const img: Shot = { ...decodePng(await page.screenshot()), mask: titles };
	let n = 0;
	for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
		const o = (y * img.width + x) * img.channels;
		if (masked(img, x, y) && hueOf(img.px[o]!, img.px[o + 1]!, img.px[o + 2]!)) n++;
	}
	console.log(`[mask] ${label}: ${n} hued px masked, ${titles.length} title boxes, ${strokes.length} stroke boxes checked`);
	return img;
};

/**
 * The stroke's own full-strength pixels in a rest shot: `hue`, not masked, and channel `ch` within 10% of the
 * brightest such pixel. Never a box centre, which can fall between strokes.
 */
function strokePixels(img: Shot, hue: Hue, ch: number): Array<[number, number]> {
	const all: Array<[number, number, number]> = [];
	for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
		const o = (y * img.width + x) * img.channels;
		if (!masked(img, x, y) && hueOf(img.px[o]!, img.px[o + 1]!, img.px[o + 2]!) === hue) all.push([x, y, img.px[o + ch]! - BG]);
	}
	const top = all.reduce((t, p) => Math.max(t, p[2]), 0);
	return all.filter(p => p[2] >= 0.9 * top).map(([x, y]) => [x, y]);
}

/** Mean of channel `ch` above the background over `pts`. */
function meanAbove(img: Shot, pts: Array<[number, number]>, ch: number): number {
	let sum = 0;
	for (const [x, y] of pts) sum += px(img, x, y)[ch]! - BG;
	return sum / pts.length;
}
const sw = (s: State) => s.sections.map(r => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }));

/** The layers at rest: the four canvases, nothing moved, nothing hidden. */
function expectRestLayers(s: State, label: string) {
	expect(s.following, `${label}: no follow running`).toBe(false);
	expect(s.canvases.map(c => c.cls).sort(), `${label}: the four layers and no extra pair`).toEqual(
		["handwriting-slides-highlight", "handwriting-slides-ink", "handwriting-slides-ink-wet", "handwriting-slides-tail"]);
	for (const c of s.canvases) {
		expect([c.cls, c.transform, c.opacity, c.visibility], `${label}: ${c.cls} not moved, faded or hidden`).toEqual([c.cls, "", "", ""]);
	}
}

/** Check 1, 5: each hue's box sits within 2 px of its rest box moved by its own section's offset. */
function expectFollows(img: Shot, s: State, rest: Partial<Record<Hue, Box>>, owner: Partial<Record<Hue, number[]>>, label: string) {
	const slides = s.slides;
	for (const [hue, sections] of Object.entries(owner) as Array<[Hue, number[]]>) {
		for (const i of sections) {
			const sec = s.sections[i]!;
			const r = rest[hue]!;
			const dx = sec.left - slides.left, dy = sec.top - slides.top;
			const want = { left: r.left + dx, top: r.top + dy, right: r.right + dx, bottom: r.bottom + dy };
			if (sec.opacity < 0.25 || want.right <= 0 || want.left >= W) continue;
			const got = inks(img, sw(s)[i])[hue].box;
			expect(got, `${label}: ${hue} of slide ${i + 1} shows (opacity ${sec.opacity.toFixed(2)})`).not.toBeNull();
			if (!got) continue;
			if (want.left >= 2) expect(Math.abs(got.left - want.left), `${label}: ${hue} of slide ${i + 1} left edge vs its slide`).toBeLessThanOrEqual(2);
			if (want.right <= W - 2) expect(Math.abs(got.right - want.right), `${label}: ${hue} of slide ${i + 1} right edge vs its slide`).toBeLessThanOrEqual(2);
			expect(Math.abs(got.top - want.top), `${label}: ${hue} of slide ${i + 1} top vs its slide`).toBeLessThanOrEqual(2);
			expect(Math.abs(got.bottom - want.bottom), `${label}: ${hue} of slide ${i + 1} bottom vs its slide`).toBeLessThanOrEqual(2);
		}
	}
}

describe("slides ink follows its own slide during a slide change", () => {
	it("check 1, 2, 5: slide transition, mid-move each slide's pen and highlighter ink rides its own slide; arrived frame is a plain repaint", async () => {
		const opened = await fresh("slide");
		const restImg = await shot("check 1 rest on slide 1");
		const rest0 = inks(restImg);
		expect(rest0.magenta.count, "slide 1 magenta at rest").toBeGreaterThan(0);
		expect(rest0.yellow.count, "slide 1 wash at rest").toBeGreaterThan(0);
		expect(opened.groups).toBe(1);
		await page.evaluate(() => window.slidesTransition.go(1));
		const mids: Array<{ f: number; s: State; img: Shot }> = [];
		for (const f of [0.05, 0.25, 0.5, 0.75]) {
			const s = await page.evaluate(x => window.slidesTransition.seek(x), f);
			mids.push({ f, s, img: await shot(`check 1 slide at ${f * 100}%`) });
			// Check 5: the incoming wash is in the one translucent group, as one composite.
			expect(s.groups, `${f}: one highlight group`).toBe(1);
			const follow = s.canvases.filter(c => c.cls.includes("follow"));
			expect(follow.map(c => [c.cls, c.parent]).sort(), `${f}: the incoming pair, its wash inside the group`).toEqual([
				["handwriting-slides-highlight-follow", "handwriting-slides-highlight-group"],
				["handwriting-slides-ink-follow", "reveal slide"],
			]);
		}
		const landed = await page.evaluate(() => window.slidesTransition.finish());
		expectRestLayers(landed, "landed");
		const restImg1 = await shot("check 1 landed on slide 2");
		const rest1 = inks(restImg1);
		expect(rest1.cyan.count, "slide 2 cyan at rest after the land").toBeGreaterThan(0);
		expect(rest1.yellow.count, "slide 2 wash at rest after the land").toBeGreaterThan(0);
		expect(rest1.magenta.count, "no slide 1 ink after the land").toBe(0);
		// Slide 2's wash at rest: the one yellow box once slide 1 has gone.
		const rest = { magenta: rest0.magenta.box!, cyan: rest1.cyan.box! };
		const restYellow = [rest0.yellow.box!, rest1.yellow.box!];
		for (const { f, s, img } of mids) {
			const label = `slide at ${f * 100}%`;
			const [out, inc] = sw(s);
			expect(inks(img, out).cyan.count, `${label}: no slide 2 ink inside slide 1's moving box`).toBe(0);
			expect(inks(img, inc).magenta.count, `${label}: no slide 1 ink inside slide 2's moving box`).toBe(0);
			// No ink outside both moving boxes: every painted pixel belongs to a slide.
			const all = inks(img), inOut = inks(img, out), inInc = inks(img, inc);
			for (const h of ["magenta", "cyan", "yellow"] as Hue[]) {
				expect(all[h].count - inOut[h].count - inInc[h].count, `${label}: ${h} painted outside both slides`).toBeLessThanOrEqual(0);
			}
			expectFollows(img, s, rest, { magenta: [0], cyan: [1] }, label);
			expectFollows(img, s, { yellow: restYellow[0]! }, { yellow: [0] }, label);
			expectFollows(img, s, { yellow: restYellow[1]! }, { yellow: [1] }, label);
		}
		const bytes = await page.evaluate(() => window.slidesTransition.arrivedVsPlain());
		expect(bytes.arrived, "check 2: the arrived frame is byte-same to a plain repaint").toBe(bytes.plain);
	});

	it("the land swaps only within 0.5 px of rest and fully opaque, so the swap frame moves no ink", async () => {
		await fresh("slide");
		await page.evaluate(() => window.slidesTransition.go(1));
		await page.evaluate(() => window.slidesTransition.seek(0.5));
		const s = await page.evaluate(() => window.slidesTransition.play());
		expectRestLayers(s, "landed");
		const writes = s.followWrites.filter(w => w.transform);
		expect(writes.length, "the incoming pair was moved frame by frame").toBeGreaterThan(2);
		const last = writes[writes.length - 1]!;
		const m = /translate\(([-\d.e]+)px(?:, ([-\d.e]+)px)?\)/.exec(last.transform);
		expect(m, `last write parses: ${last.transform}`).not.toBeNull();
		expect(Math.abs(Number(m![1])), "last pose before the swap, x").toBeLessThanOrEqual(0.5);
		expect(Math.abs(Number(m![2] ?? 0)), "last pose before the swap, y").toBeLessThanOrEqual(0.5);
		expect(Number(last.opacity), "last pose before the swap, opacity").toBeGreaterThanOrEqual(0.99);
		const bytes = await page.evaluate(() => window.slidesTransition.arrivedVsPlain());
		expect(bytes.arrived).toBe(bytes.plain);
	});

	it("check 3: a second arrow mid-move leaves no stale ink, no extra canvas, no transform, no hidden layer", async () => {
		await fresh("slide");
		await page.evaluate(() => window.slidesTransition.go(1));
		await page.evaluate(() => window.slidesTransition.seek(0.5));
		await page.evaluate(() => window.slidesTransition.go(2));
		const mid = await page.evaluate(() => window.slidesTransition.seek(0.5));
		const img = await shot("check 3 second arrow at 50%");
		expect(inks(img).magenta.count, "slide 1's ink is in neither pair after the second arrow").toBe(0);
		expect(mid.canvases.filter(c => c.cls.includes("follow")).length, "one extra pair, not two").toBeLessThanOrEqual(2);
		const landed = await page.evaluate(() => window.slidesTransition.finish());
		expectRestLayers(landed, "after the second arrow");
		const after = inks(await shot("check 3 landed on slide 3"));
		expect([after.magenta.count, after.cyan.count], "no stale ink of either earlier slide").toEqual([0, 0]);
		expect(after.green.count, "slide 3's ink at rest").toBeGreaterThan(0);
		const bytes = await page.evaluate(() => window.slidesTransition.arrivedVsPlain());
		expect(bytes.arrived).toBe(bytes.plain);
	});

	it("a resize and a dispose mid-move leave no extra canvas, no transform, no hidden layer", async () => {
		await fresh("slide");
		await page.evaluate(() => window.slidesTransition.go(1));
		await page.evaluate(() => window.slidesTransition.seek(0.5));
		expectRestLayers(await page.evaluate(() => window.slidesTransition.resize()), "after a resize mid-move");
		await fresh("slide");
		await page.evaluate(() => window.slidesTransition.go(1));
		await page.evaluate(() => window.slidesTransition.seek(0.5));
		const gone = await page.evaluate(() => window.slidesTransition.dispose());
		expect([gone.following, gone.canvases.length], "dispose mid-move: no follow, no canvas left").toEqual([false, 0]);
	});

	it("check 4: a pen stroke started mid-move is saved on the present slide and shows once on the settled layers", async () => {
		await fresh("slide");
		await page.evaluate(() => window.slidesTransition.go(1));
		await page.evaluate(() => window.slidesTransition.seek(0.5));
		const s = await page.evaluate(() => window.slidesTransition.pen({ x: 450, y: 640 }, { x: 600, y: 640 }));
		expect(s.strokes[0], "slide 1 unchanged").toEqual(["m", "y1"]);
		expect(s.strokes[1]!.slice(0, 2), "slide 2 keeps its ink").toEqual(["c", "y2"]);
		expect(s.strokes[1]!.length, "the new stroke is on slide 2, the present slide").toBe(3);
		expectRestLayers(s, "the contact put the slide's ink at rest");
		const landed = await page.evaluate(() => window.slidesTransition.finish());
		expectRestLayers(landed, "landed");
		const orange = inks(await shot("check 4 landed after the pen")).orange;
		expect(orange.count, "the stroke is on screen").toBeGreaterThan(0);
		const bytes = await page.evaluate(() => window.slidesTransition.arrivedVsPlain());
		expect(bytes.arrived, "the settled layers hold it once: byte-same to a plain repaint").toBe(bytes.plain);
		// Its twin: the same pen path drawn with slide 2 at rest. The stroke started mid-move must land on the same
		// pixels, within 1 px each edge (a cap reaches past the pen's first point, so a fixed bound is no reference).
		await fresh("slide");
		await page.evaluate(() => window.slidesTransition.go(1));
		await page.evaluate(() => window.slidesTransition.finish());
		await page.evaluate(() => window.slidesTransition.pen({ x: 450, y: 640 }, { x: 600, y: 640 }));
		await page.evaluate(() => window.slidesTransition.finish());
		const twin = inks(await shot("check 4 twin drawn at rest")).orange;
		expect(twin.count, "the twin stroke is on screen").toBeGreaterThan(0);
		const [o, t] = [orange.box!, twin.box!];
		expect([o.left - t.left, o.top - t.top, o.right - t.right, o.bottom - t.bottom].map(Math.abs).every(d => d <= 1),
			`where the pen drew it: mid-move ${JSON.stringify(o)} vs drawn at rest ${JSON.stringify(t)}`).toBe(true);
	});

	it("check 6: fade, each slide's ink fades with its own slide; no full-strength incoming ink mid-move", async () => {
		await fresh("fade");
		const restImg0 = await shot("check 6 rest on slide 1");
		await page.evaluate(() => window.slidesTransition.go(1));
		const mids: Array<{ f: number; s: State; img: Shot }> = [];
		for (const f of [0.25, 0.5]) {
			const s = await page.evaluate(x => window.slidesTransition.seek(x), f);
			mids.push({ f, s, img: await shot(`check 6 fade at ${f * 100}%`) });
		}
		await page.evaluate(() => window.slidesTransition.finish());
		const restImg1 = await shot("check 6 landed on slide 2");
		// Full-strength references on each stroke's own pixels: magenta's red channel on slide 1 at rest, cyan's green
		// on slide 2 at rest. The two strokes sit on different rows, so mid-fade each pixel holds one slide's ink only.
		const mPts = strokePixels(restImg0, "magenta", 0), cPts = strokePixels(restImg1, "cyan", 1);
		expect(mPts.length, "slide 1 magenta stroke pixels at rest").toBeGreaterThan(0);
		expect(cPts.length, "slide 2 cyan stroke pixels at rest").toBeGreaterThan(0);
		const mFull = meanAbove(restImg0, mPts, 0), cFull = meanAbove(restImg1, cPts, 1);
		expect(mFull, "slide 1 magenta full strength at rest").toBeGreaterThan(0);
		expect(cFull, "slide 2 cyan full strength at rest").toBeGreaterThan(0);
		for (const { f, s, img } of mids) {
			const op0 = s.sections[0]!.opacity, op1 = s.sections[1]!.opacity;
			expect(op0, `${f}: slide 1 is mid-fade`).toBeLessThan(0.95);
			expect(op1, `${f}: slide 2 is mid-fade`).toBeLessThan(0.95);
			const aM = meanAbove(img, mPts, 0) / mFull, aC = meanAbove(img, cPts, 1) / cFull;
			expect(Number.isFinite(aM), `fade ${f * 100}%: slide 1 ink alpha is a number`).toBe(true);
			expect(Number.isFinite(aC), `fade ${f * 100}%: slide 2 ink alpha is a number`).toBe(true);
			expect(Math.abs(aM - op0), `fade ${f * 100}%: slide 1 ink alpha ${aM.toFixed(2)} vs its slide's opacity ${op0.toFixed(2)}`).toBeLessThanOrEqual(0.05);
			expect(Math.abs(aC - op1), `fade ${f * 100}%: slide 2 ink alpha ${aC.toFixed(2)} vs its slide's opacity ${op1.toFixed(2)}`).toBeLessThanOrEqual(0.05);
		}
		const bytes = await page.evaluate(() => window.slidesTransition.arrivedVsPlain());
		expect(bytes.arrived).toBe(bytes.plain);
	});

	it("not a translation (convex): no ink of either slide mid-move; the arrived frame is a plain repaint", async () => {
		await fresh("convex");
		await page.evaluate(() => window.slidesTransition.go(1));
		for (const f of [0.25, 0.5]) {
			await page.evaluate(x => window.slidesTransition.seek(x), f);
			const all = inks(await shot(`convex at ${f * 100}%`));
			expect([all.magenta.count, all.cyan.count, all.yellow.count], `convex ${f * 100}%: no ink shows`).toEqual([0, 0, 0]);
		}
		const landed = await page.evaluate(() => window.slidesTransition.finish());
		expectRestLayers(landed, "landed");
		expect(inks(await shot("convex landed on slide 2")).cyan.count, "slide 2's ink at rest").toBeGreaterThan(0);
		const bytes = await page.evaluate(() => window.slidesTransition.arrivedVsPlain());
		expect(bytes.arrived).toBe(bytes.plain);
	});

	it("not a translation (zoom, a 2D scale): the follow hides, no ink mid-move; the land shows the arrived slide's ink", async () => {
		await fresh("zoom");
		await page.evaluate(() => window.slidesTransition.go(1));
		for (const f of [0.25, 0.5]) {
			const s = await page.evaluate(x => window.slidesTransition.seek(x), f);
			expect([s.following, s.mode], `zoom ${f * 100}%: the follow runs in hide mode`).toEqual([true, "hide"]);
			const all = inks(await shot(`zoom at ${f * 100}%`));
			expect([all.magenta.count, all.cyan.count, all.yellow.count], `zoom ${f * 100}%: no ink shows`).toEqual([0, 0, 0]);
		}
		const landed = await page.evaluate(() => window.slidesTransition.finish());
		expectRestLayers(landed, "landed");
		const rest = inks(await shot("zoom landed on slide 2"));
		expect([rest.cyan.count > 0, rest.magenta.count], "zoom: the land shows slide 2's ink, not slide 1's").toEqual([true, 0]);
	});

	it("an extra pair the browser refuses hides the ink until the land, never blank at rest", async () => {
		await fresh("slide", { refuse: true });
		await page.evaluate(() => window.slidesTransition.go(1));
		const mid = await page.evaluate(() => window.slidesTransition.seek(0.5));
		expect(mid.canvases.map(c => c.cls).filter(c => c.includes("follow")), "refused: no extra canvas left in the viewport").toEqual([]);
		const all = inks(await shot("refused at 50%"));
		expect([all.magenta.count, all.cyan.count, all.yellow.count], "refused: no ink shows mid-move").toEqual([0, 0, 0]);
		const landed = await page.evaluate(() => window.slidesTransition.finish());
		expectRestLayers(landed, "landed");
		expect(inks(await shot("refused landed on slide 2")).cyan.count, "slide 2's ink at rest").toBeGreaterThan(0);
	});

	it("an extra pair whose draw throws is dropped: the follow hides, the land shows the arrived slide's ink", async () => {
		await fresh("slide", { throwDraw: true });
		await page.evaluate(() => window.slidesTransition.go(1));
		const mid = await page.evaluate(() => window.slidesTransition.seek(0.5));
		expect(mid.canvases.map(c => c.cls).filter(c => c.includes("follow")), "draw throws: no follow canvas left in the viewport").toEqual([]);
		expect([mid.following, mid.mode], "draw throws: the follow runs in hide mode").toEqual([true, "hide"]);
		const all = inks(await shot("draw throws at 50%"));
		expect([all.magenta.count, all.cyan.count, all.yellow.count], "draw throws: no ink shows mid-move").toEqual([0, 0, 0]);
		const landed = await page.evaluate(() => window.slidesTransition.finish());
		expectRestLayers(landed, "landed");
		const rest = inks(await shot("draw throws landed on slide 2"));
		expect([rest.cyan.count > 0, rest.magenta.count], "draw throws: the land shows slide 2's ink, not slide 1's").toEqual([true, 0]);
	});

	it("a follow lands by itself at the timeout, at rest", async () => {
		await fresh("slide");
		await page.evaluate(() => window.slidesTransition.timeout(1500));
		await page.evaluate(() => window.slidesTransition.go(1));
		await page.waitForTimeout(1800);
		const s = await page.evaluate(() => window.slidesTransition.state());
		expectRestLayers(s, "after the timeout");
	});
});
