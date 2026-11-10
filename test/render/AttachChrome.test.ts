/**
 * ATTACHED INK'S CHROME ON A CAMERA MOVE: WITHIN 0.3 MS, NO LAYOUT READ, DARK FIRST.
 *
 * What it looks like: a note with 20 attached groups, two needing reattachment, one selected; the page scrolls or zooms
 * and the outline, the "Attached" label and the two "Needs reattachment" tags move with the ink at once.
 *
 * One page, no editor: the real TailRenderer on a real canvas at backing 2, the real attachChromeOf and paintAttachChrome
 * over a surface object holding what the overlay holds (the note's list, the member lists, each group's correction, a
 * selection). Each of 400 camera moves runs the selection redraw's attach part, the cleared tail and the chrome drawn,
 * and is timed alone. THE CLAIMS: the chrome's p95 per move within 0.3 ms over the clear alone (the clear is
 * the redraw's own cost today), and no layout read during the moves: every Element and HTMLElement geometry getter and
 * getBoundingClientRect, getClientRects, scrollTop and the rest are counted, and the count is 0. The theme's colours
 * are read once, before the first move, from CSS variables (one getComputedStyle, a style read).
 * Dark first: the page wears a dark theme; the tag's pill is the theme's --background-primary and its words the
 * theme's --text-error, read back from the canvas.
 * Premises: every move drew 3 tags and 1 outline (counted through the tail); the selection box is not drawn here.
 *
 * Plants (HW_PLANT_ATTACH_CHROME): "layout" reads view.dom's rect per move; "colours" reads the theme on every move. Each
 * must turn its claim red. Timing claim: run under WALLTIME-LOCK.
 *
 * Run: npx vitest run --config vitest.render.mts test/render/AttachChrome.test.ts
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";

declare const process: { env: Record<string, string | undefined> };
const PLANT = process.env.HW_PLANT_ATTACH_CHROME ?? "";

const PAGE = `
import { TailRenderer } from "../../src/ink/TailRenderer";
import { attachChromeOf, paintAttachChrome, ATTACH_STRINGS } from "../../src/inline/AttachDecoration";
import { computeBBox } from "../../src/ink/Stroke";

const PLANT = ${JSON.stringify(PLANT)};
const BACKING = 2, CSS_W = 900, CSS_H = 700;

// Every layout read the chrome could make, counted while armed.
let armed = false, layoutReads = 0, styleReads = 0;
const count = (proto, name) => {
	const d = Object.getOwnPropertyDescriptor(proto, name);
	if (!d) return;
	if (d.get) Object.defineProperty(proto, name, { ...d, get() { if (armed) layoutReads++; return d.get.call(this); } });
	else if (typeof d.value === "function") Object.defineProperty(proto, name, { ...d, value: function (...a) { if (armed) layoutReads++; return d.value.apply(this, a); } });
};
for (const n of ["getBoundingClientRect", "getClientRects", "scrollTop", "scrollLeft", "scrollWidth", "scrollHeight", "clientWidth", "clientHeight", "clientTop", "clientLeft"]) count(Element.prototype, n);
for (const n of ["offsetWidth", "offsetHeight", "offsetTop", "offsetLeft", "innerText"]) count(HTMLElement.prototype, n);
const gcs = window.getComputedStyle.bind(window);
window.getComputedStyle = (el, p) => { styleReads++; return gcs(el, p); };

const stroke = (id, x, y) => {
	const points = [0, 1, 2, 3, 4, 5].map((i) => ({ x: x + i * 6, y: y + (i % 2) * 5, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#ffffff", width: 2, points, bbox: computeBBox(points, 2), createdAt: 1 };
};

window.chrome = {
	run(moves) {
		const canvas = document.body.appendChild(document.createElement("canvas"));
		canvas.width = CSS_W * BACKING; canvas.height = CSS_H * BACKING;
		canvas.style.cssText = "width:" + CSS_W + "px;height:" + CSS_H + "px";
		const ctx = canvas.getContext("2d", { willReadFrequently: true });
		const tail = new TailRenderer(canvas);
		ctx.setTransform(BACKING, 0, 0, BACKING, 0, 0);
		// 20 groups of 5 strokes down the page, 60 px apart; g3 and g11 need reattachment; g0 is selected.
		const strokes = [], list = [], members = new Map(), memberMap = new Map(), held = new Set(["g3", "g11"]);
		for (let g = 0; g < 20; g++) {
			const ms = [];
			for (let k = 0; k < 5; k++) { const s = stroke("s" + g + "-" + k, 80 + k * 40, 60 + g * 60); strokes.push(s); ms.push(s); memberMap.set(s.id, "g" + g); }
			members.set("g" + g, ms);
			list.push({ v: 1, id: "g" + g, strokeIds: ms.map((s) => s.id), target: { kind: "paragraph", from: g * 10, to: g * 10 + 8, text: "", before: "", after: "" }, ref: { x: 0, y: 0 }, layout: { width: 900, font: 16 }, probe: { id: ms[0].id, x: 0, y: 0 } });
		}
		const selected = members.get("g0").map((s) => s.id);
		const dom = document.body;
		const surface = {
			filePath: () => "chrome.md",
			lineAnchors: {
				follow: { setList() {}, memberMap, groupOffset: (id) => (held.has(id) ? { dx: 0, dy: 0 } : { dx: 4, dy: 9 }), followsText: (id) => !held.has(id) },
				freeFor: () => ({ free: [], members }),
			},
			selection: { strokeIds: selected, revision: 1, isEmpty: false },
			view: { dom, dispatch() {} },
			refreshStrip() {},
			// The held tags' set, kept for the committed layer: unchanged over the moves, so no damage after the first.
			camera: { snapshot: { x: 0, y: 0, zoom: 1 } }, cssScale: 1, damage: { addRect() {} }, scheduleRepaint() {},
		};
		let outlines = 0, tags = [];
		const box = tail.drawSelectionBox.bind(tail), tag = tail.drawGroupTag.bind(tail);
		tail.drawSelectionBox = (...a) => { outlines++; return box(...a); };
		tail.drawGroupTag = (...a) => { tags.push(a[2]); return tag(...a); };
		// The colours, read once: one draw before the moves.
		paintAttachChrome(surface, tail, { x: 0, y: 0, zoom: 1 }, attachChromeOf(surface, list, strokes), "#7f9cf5", 1);
		const stylesBefore = styleReads;
		const chrome = [], clear = [];
		let perMove = [];
		armed = true;
		for (let i = 0; i < moves; i++) {
			const cam = { x: (i % 7) * 3, y: (i * 13) % 600, zoom: 0.5 + (i % 5) * 0.25 };
			const t0 = performance.now();
			tail.clearAll(CSS_W, CSS_H);
			const t1 = performance.now();
			outlines = 0; tags = [];
			if (PLANT === "layout") dom.getBoundingClientRect();
			if (PLANT === "colours") window.getComputedStyle(dom).getPropertyValue("--text-normal");
			paintAttachChrome(surface, tail, cam, attachChromeOf(surface, list, strokes), "#7f9cf5", 1);
			const t2 = performance.now();
			clear.push(t1 - t0); chrome.push(t2 - t1);
			perMove.push(outlines + ":" + tags.length);
		}
		armed = false;
		// Dark first: one last draw at zoom 1, then the pill's colour and the needs tag's words from the canvas.
		tail.clearAll(CSS_W, CSS_H);
		paintAttachChrome(surface, tail, { x: 0, y: 0, zoom: 1 }, attachChromeOf(surface, list, strokes), "#7f9cf5", 1);
		const g3 = members.get("g3"), x3 = Math.min(...g3.map((s) => s.bbox.x)), y3 = Math.min(...g3.map((s) => s.bbox.y));
		// The pill spans [x - 6, x - 6 + w + 8] by [y - 24, y - 8] css px; its first column holds no words.
		const px = (x, y) => Array.from(ctx.getImageData(Math.round(x * BACKING), Math.round(y * BACKING), 1, 1).data);
		const pill = px(x3 - 5, y3 - 22);
		let words = null;
		for (let x = x3 - 2; x < x3 + 100 && !words; x += 0.5) for (let y = y3 - 22; y < y3 - 10; y += 0.5) { const p = px(x, y); if (p[0] > 150 && p[1] < 120) { words = p; break; } }
		const p95 = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * 0.95)]; };
		const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
		return { moves, chromeP95: p95(chrome), chromeMed: med(chrome), clearP95: p95(clear), layoutReads, styleReadsDuringMoves: styleReads - stylesBefore,
			perMove: [...new Set(perMove)], pill, words, needsLabel: ATTACH_STRINGS.needs };
	},
};
`;

let browser: Browser, script: string;

beforeAll(async () => {
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "attachChromePage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("../obsidian-stub.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);
afterAll(async () => { await browser?.close(); });

it("a camera move redraws 20 groups' outline, label and tags within 0.3 ms p95, with no layout read, in the dark theme's colours", async () => {
	const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, deviceScaleFactor: 2 });
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 200)));
	try {
		await page.setContent("<!doctype html><body class=\"theme-dark\" style=\"margin:0;--background-primary:#202020;--text-normal:#dadada;--text-error:#fb464c\"></body>");
		await page.addScriptTag({ content: script });
		const r = await page.evaluate(() => (window as any).chrome.run(400)) as Record<string, any>;
		const brief = `\n${JSON.stringify(r)}`;
		console.log(`[attach-chrome] ${JSON.stringify(r)}`);
		expect(errors).toEqual([]);
		expect(r.perMove, `premise: every move drew one outline and three labels (attached, two needs)${brief}`).toEqual(["1:3"]);
		expect(r.layoutReads, `a layout read during the camera moves${brief}`).toBe(0);
		expect(r.styleReadsDuringMoves, `the theme's colours read again during the moves${brief}`).toBe(0);
		expect(r.chromeP95, `the chrome's p95 per camera move, ms${brief}`).toBeLessThanOrEqual(0.3);
		expect(r.pill, `the tag's pill is the theme's --background-primary${brief}`).toEqual([0x20, 0x20, 0x20, 255]);
		expect(r.words, `the needs tag's words wear the theme's --text-error${brief}`).not.toBeNull();
	} finally {
		await page.close();
	}
}, 120_000);
