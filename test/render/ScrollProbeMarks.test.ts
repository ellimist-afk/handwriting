/**
 * THE SCROLL PROBE'S TRACE MARKS: A TRACE NAMES WHICH SCROLL EVENT CAUSED WHICH REPAINT.
 *
 * What it looks like: the scroll probe's text report holds every scroll event and every repaint, but a Chromium trace taken
 * on the device holds none of them, so a slow frame in the trace cannot be tied to the gesture that asked for it. With
 * diagnostics recording, the probe now also writes one performance.mark per scroll event ("hw:scroll x=<scrollLeft>
 * y=<scrollTop>") and one per repaint ("hw:repaint work=<all | n rect> band=<moved | still> x=<scrollLeft> y=<scrollTop>").
 * Marks land in the trace under blink.user_timing. With diagnostics off nothing is written.
 *
 * One rig page: a note with a few strokes and a scroller that can move on both axes. Diagnostics on, the cell scrolls the
 * scroller in eight steps, one frame apart, and reads the page's own performance marks and a Chromium trace taken over the
 * same window. Diagnostics off, the same drive must leave no hw: mark and no hw: event in the trace.
 *
 * THE CLAIMS:
 *   - on: one hw:scroll mark per scroll event, each carrying the scrollLeft and scrollTop the scroller had at that event;
 *     at least one hw:repaint mark; every one of them is also in the Chromium trace as a user_timing event;
 *   - off: no hw: mark on the page and none in the trace, though the scroller moved and the overlay repainted.
 *
 * Run: npx vitest run --config vitest.render.mts test/render/ScrollProbeMarks.test.ts
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

const PAGE = `
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { inlineInk, inkOverlayExtension, overlayForPath, setScrollExpansionEnabled, setInlineTool, setInkSizeMult } from "../../src/inline/InkOverlay";
import { surfaceExtents } from "../../src/inline/SurfaceExtent";
import { setInkColorHex } from "../../src/ink/InkColor";
import { setPenInk } from "../../src/inline/PenInk";
import { setDiagnosticsEnabled } from "../../src/diag/DiagSwitch";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField } from "./iphoneObsidianStub";
import { parsePage, serializePage } from "../../src/model/PageData";

installObsidianDom();
const ids = new Map(), sidecars = new Map();
const save = (id, page) => { sidecars.set(id, serializePage(page)); };
inlineInk.attachHost({ readPageId: p => ids.get(p) ?? null, claimId: async (p, id) => { ids.set(p, id); return { pageId: id }; },
	loadSidecar: async id => (sidecars.has(id) ? parsePage(sidecars.get(id), id) : null), scheduleSidecar: save, scheduleSidecarNow: async (id, p) => save(id, p), notify: () => {} });

const frame = () => new Promise(r => requestAnimationFrame(() => r()));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await frame(); };
const PANE_W = 1000, PANE_H = 700, STROKES = 60;
let rig = null;

window.probeMarks = {
	async mount() {
		setPenInk(true); setScrollExpansionEnabled(true);
		setInlineTool("pen"); setInkColorHex("pen", "#222222"); setInkSizeMult("pen", 2);
		const path = "probe-marks.md";
		const pane = document.body.appendChild(document.createElement("div"));
		pane.className = "markdown-source-view mod-cm6";
		pane.style.cssText = "position:relative;margin-left:200px;margin-top:40px;width:" + PANE_W + "px;height:" + PANE_H + "px;overflow:hidden";
		const doc = ["line one", "", "line three", "", "", "", "", "", "", ""].join("\\n");
		const view = new EditorView({ parent: pane, state: EditorState.create({ doc, extensions: [history(), EditorView.lineWrapping,
			editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} })), inkOverlayExtension(),
			EditorView.theme({ "&": { width: PANE_W + "px", height: PANE_H + "px" }, ".cm-scroller": { overflowY: "auto", overflowX: "hidden" } })] }) });
		const sizer = document.createElement("div"); sizer.className = "cm-sizer";
		const container = document.createElement("div"); container.className = "cm-contentContainer";
		view.contentDOM.parentElement.insertBefore(sizer, view.contentDOM); sizer.appendChild(container); container.appendChild(view.contentDOM);
		void view.scrollDOM.clientWidth;
		await settle(12);
		const overlay = overlayForPath(path);
		if (!overlay) throw new Error("no overlay for " + path);
		rig = { view, overlay, path };
		const ink = [];
		for (let k = 0; k < STROKES; k++) {
			const ox = (k * 97) % 900, oy = (k * 61) % 600;
			ink.push({ id: "pm-" + k, tool: "pen", color: "#222", width: 2, createdAt: 1, bbox: { x: ox - 2, y: oy - 2, width: 31, height: 11 },
				points: [[0, 0], [9, 7], [18, 0], [27, 7]].map(([dx, dy], j) => ({ x: ox + dx, y: oy + dy, pressure: 0.5, t: j * 8 })) });
		}
		inlineInk.applyAdd(path, ink);
		surfaceExtents.grow(path, { x: 1500, y: 0 });
		overlay.updateExtent(true);
		await settle(12);
		const sd = view.scrollDOM;
		return { scrollWidth: sd.scrollWidth, clientWidth: sd.clientWidth, scrollHeight: sd.scrollHeight, clientHeight: sd.clientHeight };
	},
	/** Eight scroll steps, one frame apart, both axes; returns the positions the scroller really took and every hw: mark. */
	async drive(diagnostics) {
		const sd = rig.view.scrollDOM;
		setDiagnosticsEnabled(false);
		sd.scrollLeft = 0; sd.scrollTop = 0;
		await settle(6);
		performance.clearMarks();
		setDiagnosticsEnabled(diagnostics);
		const took = [];
		for (let i = 1; i <= 8; i++) {
			sd.scrollLeft = i * 40; sd.scrollTop = i * 7;
			took.push([sd.scrollLeft, sd.scrollTop]);
			await frame();
		}
		await settle(6);
		setDiagnosticsEnabled(false);
		const marks = performance.getEntriesByType("mark").map(m => m.name).filter(n => n.startsWith("hw:"));
		return { took, marks };
	},
};
`;

let browser: Browser, script: string;
beforeAll(async () => {
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "probeMarksPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);
afterAll(async () => { await browser?.close(); });

async function open() {
	const page = await browser.newPage({ viewport: { width: 1400, height: 800 }, deviceScaleFactor: 2, hasTouch: true });
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	await page.setContent('<!doctype html><body class="theme-dark" style="margin:0; --font-text-size:19px; --background-modifier-border:#777777"></body>');
	await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
	await page.addScriptTag({ content: script });
	const mounted = await page.evaluate(() => (window as any).probeMarks.mount()) as { scrollWidth: number; clientWidth: number };
	return { page, errors, mounted };
}

/** The user_timing events named hw: in a Chromium trace. */
function traceMarks(buf: { toString(encoding: string): string }): string[] {
	const events = (JSON.parse(buf.toString("utf8")).traceEvents ?? []) as { name?: string; cat?: string }[];
	return events.filter(e => typeof e.name === "string" && e.name.startsWith("hw:") && String(e.cat).includes("blink.user_timing")).map(e => e.name!);
}

async function run(page: Page, diagnostics: boolean) {
	await browser.startTracing(page, { categories: ["blink.user_timing"] });
	const r = await page.evaluate(d => (window as any).probeMarks.drive(d), diagnostics) as { took: number[][]; marks: string[] };
	const trace = traceMarks(await browser.stopTracing());
	return { ...r, trace };
}

it("diagnostics on: a scroll mark per scroll event with its scroll position, and a repaint mark, on the page and in the trace", async () => {
	const { page, errors, mounted } = await open();
	try {
		// The fixture can scroll on both axes, or the marks would read zeros.
		expect(mounted.scrollWidth).toBeGreaterThan(mounted.clientWidth);
		const r = await run(page, true);
		const scrolls = r.marks.filter(n => n.startsWith("hw:scroll "));
		const repaints = r.marks.filter(n => n.startsWith("hw:repaint "));
		expect(scrolls.length, "one hw:scroll mark per scroll event: " + r.marks.join(" | ")).toBeGreaterThanOrEqual(8);
		// The last scroll mark names the position the scroller ended on.
		const last = r.took[r.took.length - 1]!;
		expect(scrolls[scrolls.length - 1], "the last hw:scroll mark carries the final scrollLeft and scrollTop").toBe(`hw:scroll x=${last[0]} y=${last[1]}`);
		expect(repaints.length, "at least one hw:repaint mark: " + r.marks.join(" | ")).toBeGreaterThanOrEqual(1);
		expect(repaints.every(n => /^hw:repaint work=(all|\d+ rect) /.test(n) && / x=-?\d+ y=-?\d+$/.test(n)), "every hw:repaint mark names its work and the scroll position: " + repaints.join(" | ")).toBe(true);
		// The same marks are in the Chromium trace, where the device run will read them.
		expect(r.trace.filter(n => n.startsWith("hw:scroll ")).length, "hw:scroll marks in the trace").toBe(scrolls.length);
		expect(r.trace.filter(n => n.startsWith("hw:repaint ")).length, "hw:repaint marks in the trace").toBe(repaints.length);
		expect(errors).toEqual([]);
	} finally { await page.close(); }
}, 120_000);

it("diagnostics off: the scroller moves and the overlay repaints, and no hw: mark is written, on the page or in the trace", async () => {
	const { page, errors } = await open();
	try {
		const r = await run(page, false);
		// The drive did scroll: the final position is the last step.
		expect(r.took[r.took.length - 1]![0]).toBeGreaterThan(0);
		expect(r.marks, "no hw: mark with diagnostics off").toEqual([]);
		expect(r.trace, "no hw: event in the trace with diagnostics off").toEqual([]);
		expect(errors).toEqual([]);
	} finally { await page.close(); }
}, 120_000);
