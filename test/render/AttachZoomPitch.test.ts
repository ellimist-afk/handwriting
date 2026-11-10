/**
 * ATTACH ON A WORD WITH THE NOTE ZOOMED OUT TO HALF AND IN TO DOUBLE: THE SAME WORDS AS AT 100 PERCENT.
 *
 * What it looks like: on a zoomed note a user circles a word, underlines a word just under its row, or underlines a word
 * on the blank line under a paragraph, and picks Attach. The group is attached to the word drawn under and the mark is on
 * that word, as it is at 100 percent. Wrong, it would attach to the whole paragraph, or to a word of the line above.
 *
 * Why a browser: Attach measures a row's pitch from the editor's line height (attachTargetIn) and the reach of an
 * underline on a blank line from the same height against the editor's height map (attachSelected). Both are numbers the
 * editor measures from the page, in screen px under the note's scale, and the unit cells run every scale at 1, so they
 * cannot tell screen px from note px. Here Infinite Canvas is on and the note is zoomed the way a user zooms it, through
 * the plugin's own note zoom (zoomNoteBy, the zoom bar's step), so the host takes the form the plugin gives it at k (CSS
 * zoom at or below 1, a transform above 1), the overlay measures its scale from it and CodeMirror its scaleY. No scale is
 * written by hand. Each mark is drawn with the real pen (Chromium's own pen events, cdpPen.ts) at the place the word is
 * shown on the screen.
 *
 * The note: a plain editor, monospace 20 px on a 40 px line, four lines.
 *   1  "cell wall gene code"
 *   2  "fish bird frog lamb"    (same columns as line 1, so "gene" sits straight above "frog")
 *   3  ""                        (blank)
 *   4  "last line here"
 * Four marks, each its own stroke, each selected alone and attached, the record read after:
 *   circle      round "frog", its height 1.2 rows, its sides 4 screen px past the letters: the range "frog".
 *   row         an underline under "wall", an eighth of a row below line 1 (inside line 2's block): the range "wall".
 *   blank       an underline under "bird", a sixth of a row below line 2 (on the blank line): the range "bird".
 *   blank-end   the same underline past the end of line 2, under no word: the paragraph, line 2 whole.
 * Distances are the screen's: a row is the line element's height on screen, the word's place its letters' rect.
 *
 * PREMISES: the zoom step was taken and the note's zoom is k; the overlay's measured scale and the editor's scaleY are k;
 * the font zoom is 1; every word is on screen inside the pane; each mark made exactly one stroke and the stroke's box
 * centre is where it was drawn, read back in note px.
 * THE CLAIM: each of the four marks gives the target above; the record is made (Attach is offered and lands).
 * Printed per cell: ATTACH-ZOOM with the editor's line height, the line element's height, the letters' height and each
 * mark's target, so a run shows the units it ran under, and the host's CSS zoom and transform, so it shows which form
 * the plugin put the note in (zoom at 50 percent, a transform at 200). With ATTACH_ZOOM_OUT set the line is also added
 * to that file, since the reporter prints a passed cell's console only when it fails.
 *
 * The ruling's third mark, an underline within a quarter line under the last text line, is read here as two: under a
 * word it takes that word's range (the unit cells in src/inline/AttachRangeTarget.test.ts, "an underline over a blank
 * line takes its word"), and under no word it takes the line's paragraph.
 *
 * Plants, run by the lane script as source patches, one at a time, each reverted to the exact file after:
 *   pitch      the row pitch in attachTargetIn read as the editor's line height with no division by the scale. Predicted
 *              red: at k 0.5 circle, row and blank (the pitch half a row: the circle is taller than 1.5 of it, the
 *              underlines fall out of the band); at k 2 circle (the pitch two rows: the box's centre is in line 1's band
 *              and "gene" is taken). Predicted green: blank-end at both, row and blank at k 2.
 *   reach      the blank-line reach in attachSelected multiplied by the scale. Predicted red: at k 0.5 blank and
 *              blank-end (a sixth of a row past a reach of an eighth: no record). Predicted green: every mark at k 2, circle
 *              and row at k 0.5.
 *
 * Run: npx vitest run --config vitest.render.mts test/render/AttachZoomPitch.test.ts
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type CDPSession, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";
import { penStroke } from "./cdpPen";

declare const process: { env: Record<string, string | undefined> };

const LINES = ["cell wall gene code", "fish bird frog lamb", "", "last line here"];
const FONT_PX = 20, LINE_PX = 40;
const PANE = { w: 700, h: 400 };

const PAGE = `
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { Platform } from "obsidian";
import { inlineInk, inkOverlayExtension, overlayForPath, setInlineTool, setScrollExpansionEnabled, setShapeSnap } from "../../src/inline/InkOverlay";
import { setPenInk } from "../../src/inline/PenInk";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField } from "./iphoneObsidianStub";
import { emptyPage, parsePage, serializePage } from "../../src/model/PageData";

Object.assign(Platform, { isMobile: false, isDesktop: true, isIosApp: false, isDesktopApp: true, isMobileApp: false, isPhone: false, isWin: true });
installObsidianDom();
const ids = new Map(), sidecars = new Map();
const save = (id, page) => { sidecars.set(id, serializePage(page)); };
inlineInk.attachHost({ readPageId: p => ids.get(p) ?? null, claimId: async (p, id) => { ids.set(p, id); return { pageId: id }; },
	loadSidecar: async id => (sidecars.has(id) ? parsePage(sidecars.get(id), id) : null), scheduleSidecar: save, scheduleSidecarNow: async (id, p) => save(id, p), notify: () => {} });

const frame = () => new Promise(r => requestAnimationFrame(() => r()));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await frame(); };
let rig = null;
const rectOf = (r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
/** What the waits read, printed when one runs out. */
const restOf = (overlay, view) => ({ pinchScaleNow: overlay.pinchScaleNow, cssScale: overlay.cssScale, scaleY: view.scaleY,
	pinchPreview: overlay.pinchPreview, settleHold: overlay.panAnchorHold ? overlay.panAnchorHold.outcome : null, repaintQueued: overlay.repaintQueued,
	scroll: [view.scrollDOM.scrollLeft, view.scrollDOM.scrollTop], cameraScroll: [overlay.lastSyncScrollLeft, overlay.lastSyncScrollTop],
	stroking: overlay.router?.isStroking ?? false, builder: overlay.builder !== null, frameLocked: overlay.frame.locked });
/**
 * Wait for a state of the plugin, read once a frame: done when it holds on two frames running. At the cap it throws,
 * naming the state and printing what was read, so a state that never comes is a red that says which.
 */
const until = async (state, ready, read, cap = 240) => {
	let held = 0;
	for (let i = 0; i <= cap; i++) {
		held = ready() ? held + 1 : 0;
		if (held >= 2) return;
		await frame();
	}
	throw new Error("not reached in " + cap + " frames: " + state + " " + JSON.stringify(read()));
};
const near = (a, b) => Math.abs(a - b) < 1e-6;

window.attachZoom = {
	async mount(k, lines, pane, fontPx, linePx) {
		// Infinite Canvas on: a note is zoomed only under it.
		setPenInk(true); setInlineTool("pen"); setShapeSnap(false); setScrollExpansionEnabled(true);
		const path = "attach-zoom-" + k + ".md", pageId = "attach-zoom-page-" + k;
		const page = emptyPage(pageId);
		page.surface = "inline";
		ids.set(path, pageId); sidecars.set(pageId, serializePage(page));
		const el = document.body.appendChild(document.createElement("div"));
		el.className = "markdown-source-view mod-cm6";
		el.style.cssText = "position:absolute;left:40px;top:30px;width:" + pane.w + "px;height:" + pane.h + "px;overflow:hidden";
		const view = new EditorView({ parent: el, state: EditorState.create({ doc: lines.join("\\n"), extensions: [history(),
			editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} })), inkOverlayExtension(),
			EditorView.theme({ "&": { width: pane.w + "px", height: pane.h + "px" }, ".cm-scroller": { overflowY: "auto" },
				".cm-content": { fontFamily: "monospace", fontSize: fontPx + "px", lineHeight: linePx + "px", padding: "40px 0" } })] }) });
		await settle(12);
		const overlay = overlayForPath(path);
		if (!overlay) throw new Error("no overlay for " + path);
		for (let i = 0; i < 60 && !overlay.lineAnchors?.sig; i++) await frame();
		await settle(6);
		const canvas = overlay.canvasModeOn(), busy = overlay.getNoteViewportState().busy;
		// The zoom bar's step, from 100 percent: one multiply by k lands at k.
		const stepped = overlay.zoomNoteBy(k);
		// The zoom at rest at k: the scale committed, its settle hold retired, no preview up, no repaint owed, and both the
		// overlay and the editor measuring k.
		await until("the zoom at rest at " + k, () => overlay.pinchScaleNow === k && overlay.panAnchorHold === null && !overlay.pinchPreview &&
			!overlay.repaintQueued && near(overlay.cssScale, k) && near(view.scaleY, k), () => restOf(overlay, view));
		// The step zooms about the pane's centre; the cells read the note from its top left, where every word is on screen.
		view.scrollDOM.scrollLeft = 0; view.scrollDOM.scrollTop = 0;
		view.scrollDOM.dispatchEvent(new Event("scroll", { bubbles: true }));
		// The scroll settled at 0,0: the scroller there, the camera synced to it, no repaint owed, no settle hold.
		await until("the scroll settled at 0,0", () => view.scrollDOM.scrollLeft === 0 && view.scrollDOM.scrollTop === 0 &&
			overlay.lastSyncScrollLeft === 0 && overlay.lastSyncScrollTop === 0 && !overlay.repaintQueued && overlay.panAnchorHold === null,
			() => restOf(overlay, view));
		rig = { el, view, overlay, path };
		const cs = getComputedStyle(view.dom);
		return { canvas, busy, stepped, noteZoom: overlay.getNoteViewportState().zoom, pinchScaleNow: overlay.pinchScaleNow, cssScale: overlay.cssScale,
			scaleY: view.scaleY, fontZoom: overlay.fontZoom, cameraZoom: overlay.camera.snapshot.zoom, hostZoom: cs.zoom, hostTransform: cs.transform,
			scroll: { left: view.scrollDOM.scrollLeft, top: view.scrollDOM.scrollTop }, sig: !!overlay.lineAnchors?.sig };
	},
	/** Screen geometry: each line element's rect, and each word's letters' rect, from the editor as it shows them. */
	geometry() {
		const { view } = rig, doc = view.state.doc;
		const lineEls = [...view.contentDOM.querySelectorAll(".cm-line")].map(e => rectOf(e.getBoundingClientRect()));
		const words = [];
		for (let n = 1; n <= doc.lines; n++) {
			const line = doc.line(n);
			for (const m of line.text.matchAll(/\\S+/g)) {
				const from = line.from + m.index, to = from + m[0].length;
				const a = view.coordsAtPos(from, 1), b = view.coordsAtPos(to, -1);
				words.push({ line: n, word: m[0], left: a.left, right: b.left, top: a.top, bottom: a.bottom });
			}
		}
		return { lineEls, words, defaultLineHeight: view.defaultLineHeight, pane: rectOf(rig.el.getBoundingClientRect()) };
	},
	strokeIds() { return inlineInk.strokes(rig.path).map(s => s.id); },
	/**
	 * After a mark: the stroke the attach reads is in the store, the pen is up (no stroke routed or built, the frame free)
	 * and no repaint is owed. The attach's own record is waited for in attachNew.
	 */
	async strokeLanded(before) {
		const { overlay, view, path } = rig, n = before.length;
		await until("the mark's stroke landed in the store with the pen up", () => inlineInk.strokes(path).length > n &&
			!(overlay.router?.isStroking ?? false) && overlay.builder === null && !overlay.frame.locked && !overlay.repaintQueued,
			() => ({ strokes: inlineInk.strokes(path).length, before: n, ...restOf(overlay, view) }), 120);
	},
	/** Select the strokes not in before, attach them, and read the record made (null when none lands). */
	async attachNew(before) {
		const { overlay, path } = rig, old = new Set(before);
		const fresh = inlineInk.strokes(path).filter(s => !old.has(s.id));
		const box = fresh.length ? fresh.reduce((a, s) => ({ x0: Math.min(a.x0, s.bbox.x), y0: Math.min(a.y0, s.bbox.y), x1: Math.max(a.x1, s.bbox.x + s.bbox.width), y1: Math.max(a.y1, s.bbox.y + s.bbox.height) }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }) : null;
		overlay.selection.selectExactly(fresh.map(s => s.id));
		overlay.redrawSelectionUI();
		const n0 = inlineInk.attachments(path).length;
		const offered = overlay.attachSelected();
		for (let j = 0; j < 60 && inlineInk.attachments(path).length === n0; j++) await frame();
		const list = inlineInk.attachments(path), rec = list.length > n0 ? list[list.length - 1] : null;
		overlay.selection.selectExactly([]);
		overlay.redrawSelectionUI();
		await settle(4);
		return { strokes: fresh.length, box, offered, target: rec ? { kind: rec.target.kind, text: rec.target.text } : null };
	},
	/** A screen point in note px, as the pen maps it: the overlay's rect, its pan, its scale, then the camera. */
	toNote(x, y) {
		const { overlay } = rig, edge = overlay.container.getBoundingClientRect(), k = overlay.cssScale;
		return overlay.camera.screenToWorld((x - edge.left - overlay.inkInputPanX()) / k, (y - edge.top - overlay.inkInputPanY()) / k);
	},
};
`;

let browser: Browser | null = null;
let script = "";

beforeAll(async () => {
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "attachZoomPitchPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);
afterAll(async () => {
	if (browser) await browser.close();
});

const call = (p: Page, method: string, ...args: unknown[]) => p.evaluate(([n, a]) => (window as any).attachZoom[n](...a), [method, args] as const) as Promise<any>;

type R = { left: number; right: number; top: number; bottom: number };
type Mark = { name: string; points: { x: number; y: number }[]; at: { x: number; y: number }; want: { kind: string; text: string } };

/** A horizontal underline from x0 to x1 at y, 12 points. */
const underline = (x0: number, x1: number, y: number) => Array.from({ length: 13 }, (_, i) => ({ x: x0 + (x1 - x0) * i / 12, y }));
/** A closed loop round (cx, cy), radii rx and ry, 24 points, ending where it began. */
const loop = (cx: number, cy: number, rx: number, ry: number) => Array.from({ length: 25 }, (_, i) => ({ x: cx + rx * Math.cos(-Math.PI / 2 + 2 * Math.PI * i / 24), y: cy + ry * Math.sin(-Math.PI / 2 + 2 * Math.PI * i / 24) }));

function marks(g: { lineEls: R[]; words: (R & { line: number; word: string })[] }): Mark[] {
	const word = (w: string) => g.words.find(x => x.word === w)!;
	const row = g.lineEls[0]!.bottom - g.lineEls[0]!.top;
	const frog = word("frog"), wall = word("wall"), bird = word("bird"), lamb = word("lamb");
	const fcx = (frog.left + frog.right) / 2, fcy = (frog.top + frog.bottom) / 2;
	const k = row / LINE_PX;
	const rowY = g.lineEls[0]!.bottom + row / 8, blankY = g.lineEls[1]!.bottom + row / 6;
	const endX0 = lamb.right + 20 * k, endX1 = lamb.right + 60 * k;
	return [
		{ name: "circle", points: loop(fcx, fcy, (frog.right - frog.left) / 2 + 4, 0.6 * row), at: { x: fcx, y: fcy }, want: { kind: "range", text: "frog" } },
		{ name: "row", points: underline(wall.left, wall.right, rowY), at: { x: (wall.left + wall.right) / 2, y: rowY }, want: { kind: "range", text: "wall" } },
		{ name: "blank", points: underline(bird.left, bird.right, blankY), at: { x: (bird.left + bird.right) / 2, y: blankY }, want: { kind: "range", text: "bird" } },
		{ name: "blank-end", points: underline(endX0, endX1, blankY), at: { x: (endX0 + endX1) / 2, y: blankY }, want: { kind: "paragraph", text: LINES[1]! } },
	];
}

async function draw(cdp: CDPSession, page: Page, points: { x: number; y: number }[], before: string[]) {
	await penStroke(cdp, points, { pressure: 0.5, between: async (i) => { if (i % 4 === 0) await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null)))); } });
	await call(page, "strokeLanded", before);
}

for (const k of [0.5, 2]) it(`note at ${k * 100} percent: a circle on a word, an underline under a row and underlines on the blank line take the same words as at 100 percent`, async () => {
	const page = await browser!.newPage({ viewport: { width: 1600, height: 1100 } });
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	try {
		await page.setContent('<!doctype html><body class="theme-light" style="margin:0"></body>');
		await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
		await page.addScriptTag({ content: script });
		const m = await call(page, "mount", k, LINES, PANE, FONT_PX, LINE_PX);
		const g = await call(page, "geometry");
		// The zoom is the plugin's own, read before any mark is drawn: a refused step would test 100 percent twice.
		expect({ canvas: m.canvas, busy: m.busy, stepped: m.stepped }, "premise: Infinite Canvas on, the zoom step taken").toEqual({ canvas: true, busy: false, stepped: true });
		expect(m.noteZoom, "premise: the note's zoom is k").toBeCloseTo(k, 9);
		const off = g.words.filter((w: R) => w.left < g.pane.left || w.right > g.pane.right || w.top < g.pane.top || w.bottom > g.pane.bottom);
		expect(off.map((w: { word: string }) => w.word), `premise: every word is on screen inside the pane ${JSON.stringify(m)}`).toEqual([]);
		const cdp = await page.context().newCDPSession(page);
		const rows: Record<string, unknown>[] = [];
		const got: Record<string, unknown> = {}, want: Record<string, unknown> = {};
		for (const mk of marks(g)) {
			const before = await call(page, "strokeIds");
			await draw(cdp, page, mk.points, before);
			const r = await call(page, "attachNew", before);
			const at = await call(page, "toNote", mk.at.x, mk.at.y);
			const centre = r.box ? { x: (r.box.x0 + r.box.x1) / 2, y: (r.box.y0 + r.box.y1) / 2 } : null;
			rows.push({ mark: mk.name, strokes: r.strokes, offered: r.offered, target: r.target, drawnAt: at, boxCentre: centre });
			expect(r.strokes, `premise: ${mk.name} made one stroke`).toBe(1);
			expect(Math.abs(centre!.y - at.y), `premise: ${mk.name}'s box centre is where it was drawn (note px y)`).toBeLessThan(1.5);
			got[mk.name] = r.target;
			want[mk.name] = mk.want;
		}
		const letters = g.words[0].bottom - g.words[0].top, lineEl = g.lineEls[0].bottom - g.lineEls[0].top;
		// eslint-disable-next-line no-console
		const line = `ATTACH-ZOOM ${JSON.stringify({ k, mount: m, defaultLineHeight: g.defaultLineHeight, lineElement: lineEl, letters, rows })}`;
		console.log(line);
		// The reporter shows a passed cell's console only on failure: ATTACH_ZOOM_OUT names a file the line is added to.
		if (process.env.ATTACH_ZOOM_OUT) appendFileSync(process.env.ATTACH_ZOOM_OUT, line + "\n");
		expect(errors, "page errors").toEqual([]);
		expect(m.cssScale, "premise: the overlay measures the note's scale").toBeCloseTo(k, 6);
		expect(m.scaleY, "premise: the editor measures the note's scale").toBeCloseTo(k, 6);
		expect(m.fontZoom, "premise: font zoom 1").toBe(1);
		expect(lineEl, "premise: a row on screen is the line height times the scale").toBeCloseTo(LINE_PX * k, 1);
		// THE CLAIM: every mark takes the words it was drawn on, as at 100 percent.
		expect(got, `each mark's target at ${k * 100} percent`).toEqual(want);
	} finally {
		await page.close();
	}
}, 120_000);
