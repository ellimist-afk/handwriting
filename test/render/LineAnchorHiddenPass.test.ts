/**
 * OLD INK IS ANCHORED ONLY ON HEIGHTS A MEASURE READ, NEVER WHILE THE EDITOR IS HIDDEN.
 *
 * Obsidian hides a note behind another tab with display:none and keeps its editor alive, so a sync from another device can
 * change its text while it is hidden. CodeMirror's measure reads no line height then (the view is not in view), yet the
 * old-ink pass still fires on its timer, and the measure asked for after a document change still runs its write. Neither may
 * mark a height measured while the editor is hidden. Off screen the pass arms no timer: it waits for the next lines drawn.
 *
 * Cells (shown again, a scroll away and back draws lines: the shown editor's measure alone may change nothing):
 *  1. old ink: the note's ink is held back until the pane is hidden. It lands, and the pass time passes: no anchor. A wrapped
 *     paragraph is typed above it, and the pass time passes again: no anchor, and the measured prefix as the change left it.
 *     Shown again and scrolled, the pass anchors the ink on the line under its top, where it shows.
 *  2. anchored ink: the ink lands while the note is shown and is anchored. Hidden, a paragraph typed above it opens the rebase
 *     window, and the measure that follows reads no line: the window stays open and the prefix as the change left it. Shown
 *     again and scrolled, the measure reads the lines, the window closes, and the anchor still names the words it was written on.
 *  3. old ink, no change: the ink lands while hidden on lines measured before the hide, and the pass comes due: no anchor.
 *     Shown again and scrolled, the lines drawn grow nothing, yet the waiting pass runs and anchors the ink.
 *
 * Run: npx vitest run --config vitest.render.mts test/render/LineAnchorHiddenPass.test.ts
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";

const ENTRY = `
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { Platform } from "obsidian";
import { inlineInk, inkOverlayExtension, overlayForPath } from "../../src/inline/InkOverlay";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField } from "./iphoneObsidianStub";
import { emptyPage, parsePage, serializePage } from "../../src/model/PageData";

Object.assign(Platform, { isMobile: false, isDesktop: true, isIosApp: false, isDesktopApp: true, isMobileApp: false, isPhone: false, isWin: true });
installObsidianDom();
const PATH = "hidden-pass.md", PAGE_ID = "hidden-pass-page", INK_LINE = 12, WORDS = "line 12 words";
const ids = new Map([[PATH, PAGE_ID]]), pages = new Map();
// The note's ink is held back until release().
let release = null;
const held = new Promise((r) => { release = r; });
inlineInk.attachHost({ readPageId: (p) => ids.get(p) ?? null, claimId: async (p, id) => { ids.set(p, id); return { pageId: id }; },
	loadSidecar: async (id) => { await held; return pages.has(id) ? parsePage(pages.get(id), id) : null; },
	scheduleSidecar: (id, page) => void pages.set(id, serializePage(page)), scheduleSidecarNow: async (id, page) => void pages.set(id, serializePage(page)), notify: () => {} });
const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await frame(); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let host, view;

function readout() {
	const o = overlayForPath(PATH), st = inlineInk.strokes(PATH)[0], px = view.scaleY * (o.fontZoom || 1), a = st && st.lineAnchor;
	const truth = st ? view.state.doc.lineAt(view.lineBlockAtHeight(st.bbox.y * px).from).number : null;
	const dy = st ? o.lineAnchorDy(st) : null;
	// The ink's shown top against the top of the words it was written on (line 12's text, wherever that line is now), world units.
	let words = null;
	for (let n = 1; n <= view.state.doc.lines; n++) if (view.state.doc.line(n).text === WORDS) { words = n; break; }
	const onWords = st && words !== null ? st.bbox.y + dy - view.lineBlockAt(view.state.doc.line(words).from).top / px : null;
	return { inView: view.inView, strokes: inlineInk.strokes(PATH).length, anchorLine: a ? a.line : null, dy, truthLine: truth, words, onWords,
		measured: o.lineAnchors.measuredThrough, windowOpen: o.lineAnchors.windowOpen, lines: view.state.doc.lines };
}

window.hiddenPass = {
	async mount() {
		host = document.body.appendChild(document.createElement("div"));
		host.className = "markdown-source-view mod-cm6";
		host.style.cssText = "position:relative;width:640px;height:480px;overflow:hidden";
		const doc = Array.from({ length: 400 }, (_, i) => "line " + (i + 1) + " words").join("\\n");
		view = new EditorView({ parent: host, state: EditorState.create({ doc, extensions: [EditorView.lineWrapping,
			editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path: PATH }, editor: {} })), inkOverlayExtension(),
			EditorView.theme({ "&": { width: "640px", height: "480px" }, ".cm-content": { fontFamily: "monospace", fontSize: "16px", lineHeight: "24px" } })] }) });
		await settle(12);
		// A scroll away and back: the lines drawn on the way back mark the mount's lines measured.
		view.scrollDOM.scrollTop = 4000;
		await settle(8);
		view.scrollDOM.scrollTop = 0;
		await settle(8);
		if (!overlayForPath(PATH)) throw new Error("no overlay for " + PATH);
		// Old ink, written by an older build: no anchor, its top a third of the way down line 12 as the editor lays it out now.
		const b = view.lineBlockAt(view.state.doc.line(INK_LINE).from), y = b.top + (b.bottom - b.top) / 3;
		const data = emptyPage(PAGE_ID);
		data.surface = "inline";
		data.fontRefPx = 16;
		data.strokes = [{ id: "old", tool: "pen", color: "#000000", width: 2, createdAt: 1, points: [{ x: 40, y: y + 2, pressure: 0.5, t: 0 }, { x: 80, y: y + 6, pressure: 0.5, t: 10 }],
			bbox: { x: 38, y, width: 44, height: 8 } }];
		pages.set(PAGE_ID, serializePage(data));
		return readout();
	},
	/** The note's ink lands. */
	async release() {
		release();
		for (let i = 0; i < 60 && inlineInk.strokes(PATH).length === 0; i++) await frame();
		await settle(2);
		return readout();
	},
	/** The pane hidden as Obsidian hides a background tab; the next measure finds the editor out of view. */
	async hide() {
		host.style.display = "none";
		view.requestMeasure();
		await settle(8);
		return readout();
	},
	/** Shown again: the editor measures. */
	async show() {
		host.style.display = "";
		view.requestMeasure();
		await settle(12);
		return readout();
	},
	/** A scroll far down and back to the top: the editor draws lines both ways. */
	async scrollTrip() {
		view.scrollDOM.scrollTop = 4000;
		await settle(8);
		view.scrollDOM.scrollTop = 0;
		await settle(8);
		return readout();
	},
	/**
	 * A wrapped paragraph and a blank line typed at the start of line n. The prefix and the window are read at once, before the
	 * measure the change asks for: readout()'s lineBlockAtHeight runs that measure on the spot (CodeMirror's readMeasured), so
	 * its own measured and windowOpen are printed only, as what that measure's write left.
	 */
	async type(n) {
		view.dispatch({ changes: { from: view.state.doc.line(n).from, insert: "a wrapped paragraph ".repeat(20) + "\\n\\n" } });
		const a = overlayForPath(PATH).lineAnchors, measured = a.measuredThrough, windowOpen = a.windowOpen;
		const r = readout();
		await settle(4);
		return { ...r, measured, windowOpen, measuredAfterWrite: r.measured, windowOpenAfterWrite: r.windowOpen };
	},
	/** Well past the old-ink pass's quiet time, several times over. */
	async pass() {
		await wait(1500);
		await settle(4);
		return readout();
	},
};
`;

let browser: Browser, script: string;
beforeAll(async () => {
	const b = await build({ stdin: { contents: ENTRY, resolveDir: fileURLToPath(new URL("./", import.meta.url)), sourcefile: "lineAnchorHiddenPassEntry.ts", loader: "ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);
afterAll(async () => { await browser?.close(); });

async function withNote(body: (call: (step: string, ...args: unknown[]) => Promise<any>) => Promise<void>): Promise<void> {
	const page: Page = await (await browser.newContext({ viewport: { width: 900, height: 700 } })).newPage();
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 200)));
	page.on("console", (msg) => { const t = msg.text(); if (/plugin crashed|isn't allowed during an update/.test(t)) errors.push(("console: " + t).slice(0, 200)); });
	try {
		await page.setContent('<!doctype html><body class="theme-dark" style="margin:0"></body>');
		await page.addStyleTag({ content: css });
		await page.addScriptTag({ content: script });
		await body(async (step, ...args) => {
			const r = await page.evaluate(([s, a]) => (window as any).hiddenPass[s as string](...(a as unknown[])), [step, args] as const);
			console.log(step, JSON.stringify(r));
			return r;
		});
		expect(errors).toEqual([]);
	} finally {
		await page.context().close();
	}
}

it("old ink: hidden, its landing and a change above it take no anchor and grow no prefix; shown and measured, it is anchored on the line under its top", async () => {
	await withNote(async (call) => {
		const mounted = await call("mount");
		expect(mounted.measured, "premise: the lines shown at the mount, past the ink's line, are measured").toBeGreaterThan(12);
		expect(mounted.strokes, "premise: the ink is held back").toBe(0);
		expect((await call("hide")).inView, "premise: the hidden editor is not in view").toBe(false);
		expect((await call("release")).strokes, "premise: the ink landed while hidden").toBe(1);
		expect((await call("pass")).anchorLine, "hidden: the pass does not run, though the ink sits on measured lines").toBe(null);
		const typed = await call("type", 3);
		expect(typed.measured, "premise: the change cut the measured prefix above the typed lines").toBeLessThan(12);
		const after = await call("pass");
		expect(after.anchorLine, "hidden, after a change: the pass anchors nothing on heights no measure read").toBe(null);
		expect(after.measured, "hidden, after a change: nothing is marked measured, the prefix stays as the change left it").toBe(typed.measured);
		expect((await call("show")).inView, "premise: shown, the editor is in view").toBe(true);
		// Printed only: whether the shown editor's own measure drew lines and ran the pass.
		await call("pass");
		await call("scrollTrip");
		const shown = await call("pass");
		expect(shown.anchorLine, "shown and drawn: the ink is anchored on the line under its top").toBe(shown.truthLine);
		expect(Math.abs(shown.dy), "anchored where it shows: no correction").toBeLessThan(0.5);
	});
}, 60_000);

it("anchored ink: hidden, a change above it leaves the rebase window open and grows no prefix; shown and measured, the window closes and the anchor keeps its words", async () => {
	await withNote(async (call) => {
		await call("mount");
		await call("release");
		const anchored = await call("pass");
		expect(anchored.anchorLine, "premise: shown, the landed ink is anchored on the line under its top").toBe(anchored.truthLine);
		expect((await call("hide")).inView, "premise: the hidden editor is not in view").toBe(false);
		const typed = await call("type", 3);
		expect(typed.measured, "premise: the change cut the measured prefix above the typed lines").toBeLessThan(12);
		const after = await call("pass");
		expect(after.windowOpen, "hidden: the measure after the change read no line, so the window stays open").toBe(true);
		expect(after.measured, "hidden: nothing is marked measured, the prefix stays as the change left it").toBe(typed.measured);
		await call("show");
		await call("pass");
		await call("scrollTrip");
		const shown = await call("pass");
		expect(shown.windowOpen, "shown and drawn: a measure read the changed lines and the window closed").toBe(false);
		expect(shown.words, "premise: the ink's words moved down with the typed lines").toBe(14);
		// Typing never moves ink: the anchor names the words it was written on. Where the ink shows against them is printed only.
		expect(shown.anchorLine, "the anchor still names the words the ink was written on").toBe(shown.words);
	});
}, 60_000);

it("old ink, no change: hidden, the ink lands on measured lines and the pass waits; shown and drawn, the waiting pass anchors it", async () => {
	await withNote(async (call) => {
		const mounted = await call("mount");
		expect(mounted.measured, "premise: the lines shown at the mount, past the ink's line, are measured").toBeGreaterThan(12);
		expect((await call("hide")).inView, "premise: the hidden editor is not in view").toBe(false);
		expect((await call("release")).strokes, "premise: the ink landed while hidden").toBe(1);
		const hidden = await call("pass");
		expect(hidden.anchorLine, "hidden: the pass does not run, though the ink sits on measured lines").toBe(null);
		expect((await call("show")).inView, "premise: shown, the editor is in view").toBe(true);
		await call("pass");
		await call("scrollTrip");
		const shown = await call("pass");
		expect(shown.measured, "premise: the prefix the lines drawn left is the one measured before the hide").toBe(hidden.measured);
		expect(shown.anchorLine, "shown and drawn: the waiting pass anchors the ink on the line under its top").toBe(shown.truthLine);
		expect(Math.abs(shown.dy), "anchored where it shows: no correction").toBeLessThan(0.5);
	});
}, 60_000);
