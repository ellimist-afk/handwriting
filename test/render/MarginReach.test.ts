/**
 * INK LEFT OF OR ABOVE THE TEXT ORIGIN BUYS NO ROOM.
 *
 * The page is bounded by its top and left edges: the pane never scrolls or
 * rests past them, whatever ink the note holds. Ink written left of the text
 * origin (the blank beside a Readable line length column) or above the first
 * line stays in the note and is drawn where it lies, but nothing is granted to
 * reach it past those edges.
 *
 * Each note is compared with a reference: the same note without the ink left
 * of or above its origin (the pinch cells: the same strokes shifted right by
 * REF_SHIFT), in the same kind of pane. The inked note must rest, scroll,
 * settle and lay out its text exactly where the reference does.
 *
 * Surfaces: the editor (Readable line length on and off, Infinite Canvas on and
 * off) in a narrow pane, the same editor through a pinch, a reading view in a
 * narrow pane, an embed that clips its overflow (no padding is held, its text
 * does not move) and a reading view in print (no margin is held).
 *
 * Run: npm run test:render -- MarginReach.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

const PAGE = `
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { inlineInk, inkOverlayExtension, overlayForPath, setScrollExpansionEnabled } from "../../src/inline/InkOverlay";
import { attachEmbedInk, initEmbedInkRefresh, teardownEmbedInk } from "../../src/inline/EmbedInk";
import { setPenInk } from "../../src/inline/PenInk";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField } from "./iphoneObsidianStub";
import { emptyPage, parsePage, serializePage } from "../../src/model/PageData";

installObsidianDom();
const ids = new Map(), sidecars = new Map();
const save = (id, page) => { sidecars.set(id, serializePage(page)); };
inlineInk.attachHost({ readPageId: p => ids.get(p) ?? null, claimId: async (p, id) => { ids.set(p, id); return { pageId: id }; },
	loadSidecar: async id => (sidecars.has(id) ? parsePage(sidecars.get(id), id) : null), scheduleSidecar: save, scheduleSidecarNow: async (id, p) => save(id, p), notify: () => {} });

const frame = () => new Promise(r => requestAnimationFrame(() => r()));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await frame(); };
const rest = async () => { await settle(10); await new Promise(r => setTimeout(r, 300)); await settle(6); };
const MAGENTA = (d, i) => d[i + 3] > 200 && d[i] > 200 && d[i + 1] < 60 && d[i + 2] > 200;
const r2 = v => Math.round(v * 100) / 100;

/** One stroke a pen could have made: a wavy line from x0 to x1 at height y, note px. */
function stroke(id, x0, x1, y) {
	const points = Array.from({ length: 16 }, (_, j) => ({ x: x0 + (x1 - x0) * j / 15, y: y + Math.sin(j) * 10, pressure: 0.5, t: j * 9 }));
	const pad = 8, xs = points.map(p => p.x), ys = points.map(p => p.y);
	return { id, tool: "pen", color: "#ff00ff", width: 4, createdAt: 0, points,
		bbox: { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, width: Math.max(...xs) - Math.min(...xs) + 2 * pad, height: Math.max(...ys) - Math.min(...ys) + 2 * pad } };
}
/** Wholly left of the origin, and straddling it. SPLIT_Y separates them. */
const STROKE_Y = { left: 120, straddle: 220 }, SPLIT_Y = 170;
function strokes(shift) {
	return [stroke("wholly-left", -210 + shift, -110 + shift, STROKE_Y.left), stroke("straddling", -70 + shift, 70 + shift, STROKE_Y.straddle)];
}

let rig = null, rendered = null;
window.marginReach = {
	/** The editor, with the ink seeded through the sidecar so its coordinates are exactly the ones stated. */
	async mountEditor(tag, readable, canvas, shift, paneW, extra = [], base = true) {
		setPenInk(true); setScrollExpansionEnabled(canvas);
		const path = "margin-reach-" + tag + ".md", inkId = path + "-ink";
		const page = emptyPage(inkId); page.surface = "inline"; page.strokes.push(...(base ? strokes(shift) : []), ...extra.map(([x0, x1, y], k) => stroke("extra-" + k, x0 + shift, x1 + shift, y)));
		ids.set(path, inkId); sidecars.set(inkId, serializePage(page));
		const pane = document.body.appendChild(document.createElement("div"));
		pane.className = "markdown-source-view mod-cm6" + (readable ? " is-readable-line-width" : "");
		pane.style.cssText = "position:relative;margin-left:300px;width:" + paneW + "px;height:640px;overflow:hidden";
		const doc = Array.from({ length: 120 }, (_, i) => "line " + i + " alpha beta gamma delta epsilon zeta").join("\\n");
		const view = new EditorView({ parent: pane, state: EditorState.create({ doc, extensions: [history(), EditorView.lineWrapping,
			editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} })), inkOverlayExtension(),
			EditorView.theme({ "&": { width: "100%", height: "100%" }, ".cm-scroller": { overflowY: "auto", overflowX: "hidden" }, ".cm-content": { fontFamily: "monospace", fontSize: "16px", lineHeight: "24px" } })] }) });
		const sizer = document.createElement("div"); sizer.className = "cm-sizer";
		const container = document.createElement("div"); container.className = "cm-contentContainer";
		view.contentDOM.parentElement.insertBefore(sizer, view.contentDOM); sizer.appendChild(container); container.appendChild(view.contentDOM);
		await rest();
		const overlay = overlayForPath(path);
		if (!overlay) throw new Error("no overlay for " + path);
		rig = { pane, view, overlay, path };
		return { strokes: inlineInk.strokes(path).length, ...this.editorGeometry() };
	},
	editorGeometry() {
		const s = rig.view.scrollDOM, pr = rig.pane.getBoundingClientRect(), cr = rig.view.contentDOM.getBoundingClientRect();
		return { pane: { x: pr.left, y: pr.top, width: pr.width, height: pr.height }, originLeft: r2(cr.left), originTop: r2(cr.top),
			split: cr.top + SPLIT_Y, scrollLeft: s.scrollLeft, scrollTop: s.scrollTop, rangeX: s.scrollWidth - s.clientWidth,
			scrollWidth: s.scrollWidth, scrollHeight: s.scrollHeight };
	},
	async resizePane(width) { rig.pane.style.width = width + "px"; await rest(); return this.editorGeometry(); },
	async scrollEditor(left) { const s = rig.view.scrollDOM; s.scrollLeft = left; s.dispatchEvent(new Event("scroll")); await rest(); return this.editorGeometry(); },
	unmountEditor() { rig.view.destroy(); rig.pane.remove(); rig = null; },

	/** The camera as the user sees it: the column's screen x, the reserve and the scroll, and the owned layout's verdict. */
	pinchState() {
		const o = rig.overlay, layout = o.viewportLayout, s = rig.view.scrollDOM;
		return { colX: r2(rig.view.contentDOM.getBoundingClientRect().left), reserve: o.leftReserveHeld ?? 0, scrollLeft: r2(s.scrollLeft),
			owned: !!layout, sizerColumn: layout ? layout.sizerColumn : null, scale: o.pinchScaleNow, panX: r2(o.viewportPan?.x ?? 0) };
	},
	/**
	 * A two-finger pinch spanning frames, as a real one does: start at 1, one preview frame per step (scale and focal x),
	 * then the lift and the settle. Returns the state before, at the first preview frame, and settled.
	 */
	async pinch(steps, focalY) {
		const o = rig.overlay, pr = rig.pane.getBoundingClientRect();
		const at = dx => ({ x: pr.left + pr.width / 2 + dx, y: pr.top + focalY });
		const before = this.pinchState();
		o.pinch("start", 1, at(0));
		await frame();
		const frames = [];
		for (const [scale, dx] of steps) { o.pinch("move", scale, at(dx)); await frame(); await frame(); frames.push(this.pinchState()); }
		const [lastScale, lastDx] = steps[steps.length - 1];
		o.pinch("end", lastScale, at(lastDx));
		await rest(); await settle(40); await rest();
		return { before, first: frames[0], frames, settled: this.pinchState() };
	},
	/** New ink further left than any before it, through the store, then the overlay's own repaint and extent. */
	async inkFurtherLeft(x) {
		inlineInk.commit(rig.path, stroke("further-left-" + x, x, x + 60, STROKE_Y.left));
		rig.overlay.scheduleRepaint?.("ink");
		await rest();
		return this.pinchState();
	},

	/**
	 * A rendered root holding the same strokes: a reading view (the sizer centred inside a view that scrolls) or an
	 * embed's content box that clips its overflow, the way a transcluded note does.
	 */
	mountRendered(kind, shift, width, list) {
		const path = "margin-reach-" + kind + "-" + shift + "-" + width + "-" + (list ? list.length : "base") + ".md";
		const set = list ? list.map(([x0, x1, y], k) => stroke("ink-" + k, x0 + shift, x1 + shift, y)) : strokes(shift);
		initEmbedInkRefresh(() => set);
		const host = document.body.appendChild(document.createElement("div"));
		host.style.cssText = "position:relative;margin:24px 0 0 300px;width:" + width + "px";
		let root;
		if (kind === "reading") {
			root = host.appendChild(document.createElement("div"));
			root.className = "markdown-preview-view markdown-rendered";
			root.style.cssText = "position:relative;overflow:auto;height:360px";
			const sizer = root.appendChild(document.createElement("div"));
			sizer.className = "markdown-preview-sizer markdown-preview-section";
			sizer.style.cssText = "max-width:700px;margin:0 auto;min-height:320px";
			sizer.textContent = "A note with ink in its margin.";
		} else {
			const embed = host.appendChild(document.createElement("div"));
			embed.className = "internal-embed markdown-embed inline-embed";
			root = embed.appendChild(document.createElement("div"));
			root.className = "markdown-embed-content";
			root.style.cssText = "overflow:hidden";
			const sizer = root.appendChild(document.createElement("div"));
			sizer.className = "markdown-preview-view markdown-rendered";
			sizer.textContent = "A transcluded note with ink in its margin.";
		}
		attachEmbedInk(root, path, set);
		rendered = { kind, host, root };
		return this.renderedGeometry();
	},
	renderedGeometry() {
		const { kind, host, root } = rendered;
		const hr = host.getBoundingClientRect();
		const box = root.getBoundingClientRect();
		// The origin the ink is drawn from: the reading view's sizer, or the embed box itself.
		const anchor = kind === "reading" ? root.querySelector(".markdown-preview-sizer").getBoundingClientRect() : box;
		// The text: the reading view's sizer, or the embed's rendered view inside the content box.
		const text = kind === "reading" ? root.querySelector(".markdown-preview-sizer") : root.querySelector(".markdown-preview-view");
		const cs = getComputedStyle(root), ts = getComputedStyle(text);
		return { host: { x: hr.left, y: hr.top, width: hr.width, height: Math.max(hr.height, 1) }, originLeft: r2(anchor.left), split: anchor.top + SPLIT_Y,
			scrollLeft: root.scrollLeft, scrollTop: root.scrollTop, rangeX: root.scrollWidth - root.clientWidth, scrollWidth: root.scrollWidth, scrollHeight: root.scrollHeight,
			padLeft: cs.paddingLeft, sizerMargin: ts.marginLeft, textLeft: r2(text.getBoundingClientRect().left) };
	},
	async scrollRendered(left) { rendered.root.scrollLeft = left; await settle(2); return this.renderedGeometry(); },
	firePrint(on) { window.dispatchEvent(new Event(on ? "beforeprint" : "afterprint")); },
	clearRendered() { teardownEmbedInk(); document.querySelectorAll("body > div").forEach(el => el.remove()); rendered = null; },

	/** Magenta in the screenshot, split into the two strokes' bands at client y = split. */
	async count(b64, split) {
		const img = await createImageBitmap(await (await fetch("data:image/png;base64," + b64)).blob());
		const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
		const g = c.getContext("2d"); g.drawImage(img, 0, 0);
		const d = g.getImageData(0, 0, c.width, c.height).data;
		let left = 0, straddle = 0;
		for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (MAGENTA(d, (y * c.width + x) * 4)) { if (y < split) left++; else straddle++; }
		return { left, straddle };
	},
};
`;

let browser: Browser, script: string;
/** How far right the reference copy sits, note px: enough to put both strokes wholly on the positive side. */
const REF_SHIFT = 300;

beforeAll(async () => {
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "marginReachPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);
afterAll(async () => { await browser?.close(); });

const call = (p: Page, method: string, ...args: unknown[]) => p.evaluate(([m, a]) => (window as any).marginReach[m](...a), [method, args] as const);

async function open(): Promise<{ page: Page; errors: string[] }> {
	const page = await browser.newPage({ viewport: { width: 1800, height: 900 }, deviceScaleFactor: 1 });
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	await page.setContent('<!doctype html><body style="margin:0;background:#fff"></body>');
	await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
	await page.addScriptTag({ content: script });
	return { page, errors };
}

type Rect = { x: number; y: number; width: number; height: number };
type Counts = { left: number; straddle: number };
async function inkIn(page: Page, clip: Rect, split: number): Promise<Counts> {
	const png = await page.screenshot({ clip });
	return await call(page, "count", png.toString("base64"), split - clip.y) as Counts;
}

const NARROW = 520;
/** Ink far left of the origin and far above the first line, note px: [x0, x1, y]. The pinch reference holds none of it. */
const FAR: [number, number, number][] = [[-620, -520, 120], [20, 120, -400]];
/** Ink right of the origin, in every note of the rows below and in its reference. */
const RIGHT: [number, number, number][] = [[10, 150, 220]];
/** The ink each row adds left of or above the origin. Its reference is the same note without it. */
const ROWS: [string, [number, number, number][]][] = [
	["218 px left", [[-210, -110, 120]]],
	["6000 px left and 3000 px above", [[-6000, -5900, 120], [20, 120, -3000]]],
];

for (const readable of [true, false]) for (const canvas of [false, true]) {
	it(`editor: ink left of or above the origin buys no room left or up, Readable line length ${readable ? "on" : "off"}, Infinite Canvas ${canvas ? "on" : "off"}`, async () => {
		const { page, errors } = await open();
		try {
			const out: any[] = [];
			const ref = await call(page, "mountEditor", `ref-${readable}-${canvas}`, readable, canvas, 0, NARROW, RIGHT, false) as any;
			await call(page, "unmountEditor");
			for (const [row, ink] of ROWS) {
				const rest = await call(page, "mountEditor", `left-${row}-${readable}-${canvas}`, readable, canvas, 0, NARROW, [...RIGHT, ...ink], false) as any;
				const home = await call(page, "scrollEditor", 0) as any;
				await call(page, "unmountEditor");
				out.push({ row, strokes: rest.strokes, rest, home });
			}
			// eslint-disable-next-line no-console
			console.log("EDITOR " + JSON.stringify({ readable, canvas, ref, out }));
			expect(errors).toEqual([]);
			for (const { row, strokes, rest, home } of out) {
				expect(strokes, `${row}: strokes loaded`).toBe(RIGHT.length + ROWS.find(r => r[0] === row)![1].length);
				expect(rest.scrollLeft, `${row}: at rest the pane is scrolled to the page's left edge (0)`).toBe(0);
				expect(rest.scrollTop, `${row}: at rest the pane is scrolled to the page's top edge (0)`).toBe(0);
				expect(home.originLeft - home.pane.x, `${row}: scrolled fully left, the column sits where the reference's does (0 px)`).toBe(ref.originLeft - ref.pane.x);
				expect(home.originTop - home.pane.y, `${row}: scrolled fully up, the first line sits where the reference's does (0 px)`).toBe(ref.originTop - ref.pane.y);
				expect(home.scrollWidth, `${row}: the scroll width is the reference's`).toBe(ref.scrollWidth);
				expect(home.scrollHeight, `${row}: the scroll height is the reference's`).toBe(ref.scrollHeight);
			}
		} finally { await page.close(); }
	}, 180_000);
}

it(`reading view, ${NARROW} px: ink left of or above the origin buys no scroll room left or up`, async () => {
	const { page, errors } = await open();
	try {
		const ref = await call(page, "mountRendered", "reading", 0, NARROW, RIGHT) as any;
		await call(page, "clearRendered");
		const out: any[] = [];
		for (const [row, ink] of ROWS) {
			const rest = await call(page, "mountRendered", "reading", 0, NARROW, [...RIGHT, ...ink]) as any;
			const home = await call(page, "scrollRendered", 0) as any;
			await call(page, "clearRendered");
			out.push({ row, rest, home });
		}
		// eslint-disable-next-line no-console
		console.log("READING " + JSON.stringify({ ref, out }));
		expect(errors).toEqual([]);
		for (const { row, rest, home } of out) {
			expect(rest.scrollLeft, `${row}: at rest the view is scrolled to the page's left edge (0)`).toBe(0);
			expect(rest.scrollTop, `${row}: at rest the view is scrolled to the page's top edge (0)`).toBe(0);
			expect(home.originLeft - home.host.x, `${row}: scrolled fully left, the column sits where the reference's does (0 px)`).toBe(ref.originLeft - ref.host.x);
			expect(home.scrollWidth, `${row}: the scroll width is the reference's`).toBe(ref.scrollWidth);
			expect(home.scrollHeight, `${row}: the scroll height is the reference's`).toBe(ref.scrollHeight);
		}
	} finally { await page.close(); }
}, 180_000);

// An embed's content box clips what falls outside it. Ink left of the origin does not move its text: no padding is held.
it(`embed that clips its overflow, ${NARROW} px: ink left of the origin holds no padding, and the text stays where the reference's is`, async () => {
	const { page, errors } = await open();
	try {
		const ref = await call(page, "mountRendered", "embed", 0, NARROW, RIGHT) as any;
		await call(page, "clearRendered");
		const out: any[] = [];
		for (const [row, ink] of ROWS) {
			out.push({ row, g: await call(page, "mountRendered", "embed", 0, NARROW, [...RIGHT, ...ink]) as any });
			await call(page, "clearRendered");
		}
		// eslint-disable-next-line no-console
		console.log("EMBED " + JSON.stringify({ ref, out }));
		expect(errors).toEqual([]);
		for (const { row, g } of out) {
			expect(g.padLeft, `${row}: the content box's padding-left is the reference's`).toBe(ref.padLeft);
			expect(g.textLeft - g.host.x, `${row}: the text's left edge is the reference's (0 px)`).toBe(ref.textLeft - ref.host.x);
		}
	} finally { await page.close(); }
}, 180_000);

// Paper has no scroll. In print the reading view's sizer holds no margin for ink left of the origin.
it(`print, reading view ${NARROW} px: ink left of the origin holds no margin, and the text stays where the reference's is`, async () => {
	const { page, errors } = await open();
	try {
		await call(page, "mountRendered", "reading", 0, NARROW, RIGHT);
		await call(page, "firePrint", true);
		const ref = await call(page, "renderedGeometry") as any;
		await call(page, "firePrint", false);
		await call(page, "clearRendered");
		const out: any[] = [];
		for (const [row, ink] of ROWS) {
			await call(page, "mountRendered", "reading", 0, NARROW, [...RIGHT, ...ink]);
			await call(page, "firePrint", true);
			out.push({ row, g: await call(page, "renderedGeometry") as any });
			await call(page, "firePrint", false);
			await call(page, "clearRendered");
		}
		// eslint-disable-next-line no-console
		console.log("PRINT " + JSON.stringify({ ref, out }));
		expect(errors).toEqual([]);
		for (const { row, g } of out) {
			expect(g.sizerMargin, `${row}: in print the sizer's margin-left is the reference's`).toBe(ref.sizerMargin);
			expect(g.textLeft - g.host.x, `${row}: in print the text's left edge is the reference's (0 px)`).toBe(ref.textLeft - ref.host.x);
		}
	} finally { await page.close(); }
}, 180_000);

// THROUGH A PINCH. Infinite Canvas on only: with it off there is no zoom at all (pinch() returns at once), so no owned
// layout starts; the at-rest cells above are that setting's coverage. Narrow pane, Readable line length on.
const FOCAL_Y = 200;
const PAN = 100;
for (const [name, steps] of [["a pan right", [[1, PAN / 2], [1, PAN]]], ["a zoom out to 50%", [[0.8, 0], [0.6, 0], [0.5, 0]]]] as const) {
	it(`pinch, Infinite Canvas on, ${name}: the inked page settles where a note without ink left of it settles, scroll at 0`, async () => {
		const { page, errors } = await open();
		try {
			const runs: any = {};
			for (const [tag, shift] of [["ref", REF_SHIFT], ["left", 0]] as const) {
				await call(page, "mountEditor", `pinch-${tag}`, true, true, shift, NARROW, tag === "ref" ? [] : FAR);
				runs[tag] = await call(page, "pinch", steps, FOCAL_Y);
				await call(page, "unmountEditor");
			}
			// eslint-disable-next-line no-console
			console.log("PINCH " + JSON.stringify({ name, ref: { before: runs.ref.before, settled: runs.ref.settled }, left: { before: runs.left.before, settled: runs.left.settled } }));
			expect(errors).toEqual([]);
			expect(runs.left.before.scrollLeft, "at rest the scroll stands at 0").toBe(0);
			expect(runs.left.before.colX - runs.ref.before.colX, "at rest the columns agree (0 px)").toBe(0);
			expect(Math.abs(runs.left.settled.colX - runs.ref.settled.colX), "settled, the inked column rests where the reference's rests (within 1 px)").toBeLessThanOrEqual(1);
			expect(runs.left.settled.scrollLeft, "settled, the scroll stands at 0 (within 1 px)").toBeLessThanOrEqual(1);
		} finally { await page.close(); }
	}, 180_000);
}
