/**
 * A GROUP TURNED HELD BY TYPING SHOWS ITS "NEEDS REATTACHMENT" TAG, NOTHING SELECTED.
 *
 * What it looks like: a note with one group of ink attached to a paragraph, nothing selected. The paragraph's words are
 * deleted (selected and Backspace), so the group has nothing to follow: it stays where it is and a small "Needs
 * reattachment" tag shows above its top-left corner, in the theme's error colour on the page background, without a click.
 *
 * A real EditorView with the real overlay, the note loaded from its sidecar as a saved note is. No hand call to the
 * overlay's redraw. Read back from the committed canvas: the pixels in the tag's own rect (7 css px left of the group's
 * shown box and 25 above it, the bound the committed layer damages for a tag) before and after the delete.
 *
 * HW_HELD_TAG_PLANT=1 adds one hand redraw after the open and one after the delete.
 *
 * Run: npx vitest run --config vitest.render.mts test/render/AttachHeldTagMount.test.ts
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

declare const process: { env: Record<string, string | undefined> };

const PLANT = process.env.HW_HELD_TAG_PLANT === "1";
const MINIMAL_CSS = readFileSync(fileURLToPath(new URL("./fixtures/minimal-9.0.2-theme.css", import.meta.url)), "utf8");
const PAGE_ID = "held-tag-mount-0001";
const TARGET = "Target paragraph with the ink beside it.";
const TEXT = "A first line of the note.\n\nA second paragraph above the target.\n\n" + TARGET + "\n\nA last line.";
const FROM = TEXT.indexOf(TARGET), TO = FROM + TARGET.length;
const WIDE = 900;

const PAGE = `
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { inlineInk, inkOverlayExtension, setScrollExpansionEnabled, setInlineTool } from "../../src/inline/InkOverlay";
import { instances } from "../../src/inline/InkOverlayRegistry";
import { ATTACH_STRINGS, themeColours } from "../../src/inline/AttachDecoration";
import { setPenInk } from "../../src/inline/PenInk";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField } from "./iphoneObsidianStub";
import { parsePage } from "../../src/model/PageData";

installObsidianDom();
const ids = new Map(), sidecars = new Map();
inlineInk.attachHost({ readPageId: p => ids.get(p) ?? null, claimId: async (p, id) => { ids.set(p, id); return { pageId: id }; },
	loadSidecar: async id => (sidecars.has(id) ? parsePage(sidecars.get(id), id) : null), scheduleSidecar: () => {}, scheduleSidecarNow: async () => {}, notify: () => {} });
const frame = () => new Promise(r => requestAnimationFrame(() => r()));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await frame(); };
// One pass of the editor's own measure cycle: resolves in its write phase, after the measures queued before it.
const measured = view => new Promise(res => view.requestMeasure({ read: () => null, write: () => res() }));
const quiet = async view => { await settle(8); await measured(view); await settle(8); };
const path = "Held tag mount.md";

function installSizer(view) {
	const sizer = document.createElement("div"); sizer.className = "cm-sizer";
	const container = document.createElement("div"); container.className = "cm-contentContainer";
	view.contentDOM.parentElement.insertBefore(sizer, view.contentDOM); sizer.appendChild(container); container.appendChild(view.contentDOM);
	void view.scrollDOM.clientWidth;
}

async function openPane(text, width) {
	const pane = document.body.appendChild(document.createElement("div"));
	pane.className = "markdown-source-view mod-cm6";
	pane.style.cssText = "position:absolute;left:20px;top:40px;width:" + width + "px;height:700px;overflow:hidden";
	const view = new EditorView({ parent: pane, state: EditorState.create({ doc: text, extensions: [history(), EditorView.lineWrapping,
		editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} })), inkOverlayExtension(),
		EditorView.theme({ "&": { width: "100%", height: "700px" }, ".cm-scroller": { overflowY: "auto", overflowX: "hidden" } })] }) });
	installSizer(view);
	for (let i = 0; i < 200 && inlineInk.strokes(path).length === 0; i++) await settle(2);
	await settle(12); await measured(view); await settle(8);
	const overlay = [...instances].find(p => p.view === view);
	if (!overlay) throw new Error("no overlay for the pane");
	return { pane, view, overlay };
}

const readRef = (p, pos) => new Promise(res => p.view.requestMeasure({ read: () => p.overlay.followRefAt(pos), write: res }));
/** The group's box as this pane shows it: the union of its shown members' boxes, world units. */
function shownBox(p, idsOf) {
	const want = new Set(idsOf), ms = p.overlay.noteStrokes(path).filter(s => want.has(s.id));
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (const s of ms) { x0 = Math.min(x0, s.bbox.x); y0 = Math.min(y0, s.bbox.y); x1 = Math.max(x1, s.bbox.x + s.bbox.width); y1 = Math.max(y1, s.bbox.y + s.bbox.height); }
	return { members: ms.length, box: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } };
}
/** A world rect as a device-pixel rect on the pane's committed canvas. */
function devRect(p, r) {
	const o = p.overlay, cam = o.camera, c = o.committedCanvas, cr = c.getBoundingClientRect(), box = o.container.getBoundingClientRect();
	const a = cam.worldToScreen(r.x, r.y), b = cam.worldToScreen(r.x + r.width, r.y + r.height), k = c.width / cr.width;
	const dev = (sx, sy) => ({ x: (box.left + sx * o.cssScale - cr.left) * k, y: (box.top + sy * o.cssScale - cr.top) * k });
	const p0 = dev(a.x, a.y), p1 = dev(b.x, b.y);
	return { x: Math.floor(p0.x), y: Math.floor(p0.y), w: Math.ceil(p1.x) - Math.floor(p0.x), h: Math.ceil(p1.y) - Math.floor(p0.y) };
}
/** On the committed canvas inside a device rect: pixels within 24 per channel of each colour, at alpha over 200. */
function countIn(p, d, cols) {
	const c = p.overlay.committedCanvas, g = c.getContext("2d");
	const x = Math.max(0, d.x), y = Math.max(0, d.y), w = Math.min(c.width - x, d.w), h = Math.min(c.height - y, d.h);
	const n = cols.map(() => 0);
	if (w <= 0 || h <= 0) return { counts: n, rect: d };
	const img = g.getImageData(x, y, w, h).data;
	for (let i = 0; i < img.length; i += 4) {
		if (img[i + 3] <= 200) continue;
		cols.forEach((k, j) => { if (Math.abs(img[i] - k[0]) <= 24 && Math.abs(img[i + 1] - k[1]) <= 24 && Math.abs(img[i + 2] - k[2]) <= 24) n[j]++; });
	}
	return { counts: n, rect: d };
}
/** The tag's rect for a box at this zoom (the committed layer's bound for a tag), and the error and background pixels in it. */
function tagAt(p, box, cols) {
	const o = p.overlay, k = 1 / (o.camera.snapshot.zoom * o.cssScale);
	const r = { x: box.x - 7 * k, y: box.y - 25 * k, width: (ATTACH_STRINGS.needs.length * 9 + 16) * k, height: 20 * k };
	const got = countIn(p, devRect(p, r), cols);
	return { world: r, error: got.counts[0], background: got.counts[1], rect: got.rect };
}
/** A css colour as the canvas reads it, [r, g, b]. */
function rgbOf(css) {
	const g = document.createElement("canvas").getContext("2d"); g.fillStyle = "#000000"; g.fillStyle = css;
	const m = /^#([0-9a-f]{6})$/i.exec(g.fillStyle);
	return m ? [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)) : null;
}
const handRedraw = async (p, plant) => { if (!plant) return 0; p.overlay.redrawSelectionUI(); await quiet(p.view); return 1; };

window.lim = {
	async prepare(sidecar, pageId, text, from) {
		setPenInk(true); setScrollExpansionEnabled(true); setInlineTool("pen");
		sidecars.set(pageId, sidecar); ids.set(path, pageId);
		const p = await openPane(text, ${WIDE});
		const ref = await readRef(p, from), sig = p.overlay.lineAnchors.sig;
		return { ref, sig: sig ? { width: sig.width, fontPx: sig.fontPx } : null };
	},
	async run(sidecar, pageId, text, rec, plant) {
		setPenInk(true); setScrollExpansionEnabled(false); setInlineTool("pen");
		sidecars.set(pageId, sidecar); ids.set(path, pageId);
		const p = await openPane(text, ${WIDE});
		await quiet(p.view);
		let redraws = await handRedraw(p, plant);
		const th = themeColours(p.overlay.view.dom), error = rgbOf(th.needs), background = rgbOf(th.background);
		const follow = p.overlay.lineAnchors.follow;
		const selected = p.overlay.selection.isEmpty === false;
		const list0 = inlineInk.attachments(path).map(a => a.id), follows0 = follow.followsText(rec.id);
		const open = shownBox(p, rec.strokeIds), atOpen = tagAt(p, open.box, [error, background]);
		// The target's words deleted, as a selection and Backspace reach the editor.
		const from = p.view.state.doc.toString().indexOf(rec.target.text);
		p.view.dispatch({ changes: { from, to: from + rec.target.text.length }, userEvent: "delete.backward" });
		await quiet(p.view);
		redraws += await handRedraw(p, plant);
		const after = shownBox(p, rec.strokeIds), atAfter = tagAt(p, after.box, [error, background]);
		return { needs: th.needs, error, background: th.background, backgroundRgb: background, selected, list0, list1: inlineInk.attachments(path).map(a => a.id),
			follows0, follows1: follow.followsText(rec.id), open, after, atOpen, atAfter, redraws };
	},
};
`;

let browser: Browser, script: string;
let prep: { ref: { x: number; y: number }; sig: { width: number; fontPx: number } };

beforeAll(async () => {
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "attachLinkIconMountPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
	const page = await openPage();
	try { prep = await call(page, "prepare", sidecarText([]), PAGE_ID, TEXT, FROM) as typeof prep; } finally { await page.close(); }
}, 180_000);
afterAll(async () => { await browser?.close(); });

const call = (p: Page, method: string, ...args: unknown[]) => p.evaluate(([m, a]) => (window as any).lim[m](...a), [method, args] as const);
async function openPage() {
	const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 2 });
	await page.setContent(`<!doctype html><body class="theme-dark" style="margin:0; --font-text-size:19px; --background-modifier-border:#777777"></body>`);
	await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
	await page.addStyleTag({ content: MINIMAL_CSS });
	await page.addScriptTag({ content: script });
	return page;
}

/** Six short strokes 30 world units right of the target's first character and 8 below its top. */
function strokesNear(ref: { x: number; y: number } | null) {
	const at = ref ?? { x: 100, y: 100 }, out: Array<{ id: string; tool: string; color: string; width: number; createdAt: number; pts: number[] }> = [];
	for (let k = 0; k < 6; k++) {
		const x0 = at.x + 30 + 22 * k, y0 = at.y + 8 + (k % 2) * 4, pts: number[] = [];
		for (let i = 0; i <= 8; i++) pts.push(x0 + 2 * i, y0 + Math.sin(i) * 3, 0.5, i * 8);
		out.push({ id: "lim-" + k, tool: "pen", color: "#ffffff", width: 3, createdAt: 1, pts });
	}
	return out;
}
function sidecarText(attachments: unknown[]) {
	return JSON.stringify({ schemaVersion: 1, pageId: PAGE_ID, surface: "inline", strokes: strokesNear(prep?.ref ?? null), textBoxes: [], images: [], attachments });
}
function theRecord() {
	const strokes = strokesNear(prep.ref), first = strokes[0]!;
	return { v: 1, id: "lim-group", strokeIds: strokes.map((s) => s.id), target: { kind: "paragraph", from: FROM, to: TO, text: TARGET, before: TEXT.slice(Math.max(0, FROM - 32), FROM).replace(/\s+/g, " "), after: TEXT.slice(TO, TO + 32).replace(/\s+/g, " ") },
		ref: { x: prep.ref.x, y: prep.ref.y }, layout: { width: prep.sig.width, font: prep.sig.fontPx }, probe: { id: first.id, x: first.pts[0]!, y: first.pts[1]! } };
}

it(`a group turned held by typing shows its tag, nothing selected, no hand redraw${PLANT ? " (plant: hand redraw)" : ""}`, async () => {
	const page = await openPage(), errors: string[] = [];
	page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 200)));
	try {
		const r = await call(page, "run", sidecarText([theRecord()]), PAGE_ID, TEXT, theRecord(), PLANT) as any;
		const brief = `
${JSON.stringify(r)}`;
		console.log(`[held-tag-mount] plant=${PLANT ? 1 : 0} ${JSON.stringify(r)}`);
		expect(errors, "page errors").toEqual([]);
		expect([r.list0, r.list1, r.selected, r.open.members, r.after.members, r.redraws], `premise: one group listed before and after, nothing selected, six members shown, hand redraws${brief}`).toEqual([["lim-group"], ["lim-group"], false, 6, 6, PLANT ? 2 : 0]);
		expect([r.follows0, r.follows1, r.error !== null, r.backgroundRgb !== null], `premise: the group followed its text, then not; both theme colours read${brief}`).toEqual([true, false, true, true]);
		expect(r.atOpen.error, `premise: no tag before the delete${brief}`).toBe(0);
		// The tag after the delete: its words in the error colour, on its page-background pill.
		expect([r.atAfter.error > 0, r.atAfter.background > 0], `[error-colour words, background pill] in the tag's rect after the delete${brief}`).toEqual([true, true]);
	} finally { await page.close(); }
}, 120_000);
