/**
 * THE SELECTED GROUP'S LABEL AND THE MARK ON ITS TEXT, ON A REAL MOUNT.
 *
 * What it looks like: a note with two groups of ink, one attached to a word on a short line, one attached to a long
 * paragraph that wraps over several rows. Selecting either group (as a tap on its pin selects it) labels it "Attached"
 * at its top-left, and the text it is attached to is highlighted: the one word, or the whole paragraph, every row of it.
 *
 * A real EditorView with the real overlay and the plugin's own styles.css over the Minimal theme, the note loaded from
 * its sidecar as a saved note is. The labels are those the overlay's tail draws (its drawGroupTag calls). The highlight is
 * read from the screen: the text inside the mark (class hw-attach-target), the rows its rects cover against the rows the
 * editor lays the target's text on, and, with the ink canvases hidden, the screen pixels in each row's rect before the
 * group is selected and after. A row whose background is painted changes most of its pixels.
 *
 * Cells:
 *   mark   each group selected in turn: the mark holds exactly its target's text; for the paragraph, the mark's rows are
 *          the paragraph's rows (three or more) and each row's rect is painted (half its pixels or more changed).
 *   label  each group selected in turn: the overlay draws one label, "Attached".
 *
 * HW_ATTACH_TAG_STILL=<dir> also writes the screen with each group selected, ink shown: still-word.png and
 * still-paragraph.png.
 *
 * Run: npx vitest run --config vitest.render.mts test/render/AttachTagMark.test.ts
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

declare const process: { env: Record<string, string | undefined> };

const STILL = process.env.HW_ATTACH_TAG_STILL ?? "";
const MINIMAL_CSS = readFileSync(fileURLToPath(new URL("./fixtures/minimal-9.0.2-theme.css", import.meta.url)), "utf8");
const PAGE_ID = "attach-tag-mark-0001";
const SHORT = "A short line with one word circled.";
const LONG = "This paragraph is long enough to wrap over several rows of the pane, so the highlight on it must cover every row " +
	"from its first word to its last, and the label over its ink must say no more than that the ink is attached to it.";
// Four empty lines first: the short line sits below the tool strip and zoom box at the pane's top, which cover row one.
const TEXT = "\n\n\n\n" + SHORT + "\n\n" + LONG + "\n\nA last line.";
const W_FROM = TEXT.indexOf("word"), W_TO = W_FROM + "word".length;
const P_FROM = TEXT.indexOf(LONG), P_TO = P_FROM + LONG.length;
const WIDTH = 600, DPR = 2;

const PAGE = `
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { inlineInk, inkOverlayExtension, setScrollExpansionEnabled, setInlineTool } from "../../src/inline/InkOverlay";
import { instances } from "../../src/inline/InkOverlayRegistry";
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
const path = "Attach tag mark.md";

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
const rnd = v => Math.round(v * 100) / 100;
/** The distinct row tops (client px) the editor lays [from, to) on, from its own coordsAtPos. */
function rowsOf(view, from, to) {
	const tops = new Set();
	for (let pos = from; pos < to; pos++) { const r = view.coordsAtPos(pos, 1); if (r) tops.add(Math.round(r.top)); }
	return [...tops].sort((a, b) => a - b);
}
/** The mark on screen: its text, and each row rect its elements cover (client px), rows merged by top. */
function markNow(view) {
	const els = [...view.contentDOM.querySelectorAll(".hw-attach-target")];
	const byTop = new Map();
	for (const el of els) for (const r of el.getClientRects()) {
		if (r.width <= 0 || r.height <= 0) continue;
		const k = Math.round(r.top), was = byTop.get(k);
		byTop.set(k, was ? { left: Math.min(was.left, r.left), top: Math.min(was.top, r.top), right: Math.max(was.right, r.right), bottom: Math.max(was.bottom, r.bottom) }
			: { left: r.left, top: r.top, right: r.right, bottom: r.bottom });
	}
	const rows = [...byTop.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => ({ left: rnd(r.left), top: rnd(r.top), right: rnd(r.right), bottom: rnd(r.bottom) }));
	const bg = els.length ? getComputedStyle(els[0]).backgroundColor : null;
	return { count: els.length, text: els.map(e => e.textContent).join(""), rows, bg };
}

let mount = null, labels = [];
window.atm = {
	async prepare(sidecar, pageId, text, froms) {
		setPenInk(true); setScrollExpansionEnabled(true); setInlineTool("pen");
		sidecars.set(pageId, sidecar); ids.set(path, pageId);
		const p = await openPane(text, ${WIDTH});
		const refs = [];
		for (const f of froms) refs.push(await readRef(p, f));
		const sig = p.overlay.lineAnchors.sig;
		return { refs, sig: sig ? { width: sig.width, fontPx: sig.fontPx } : null };
	},
	async open(sidecar, pageId, text) {
		setPenInk(true); setScrollExpansionEnabled(false); setInlineTool("pen");
		sidecars.set(pageId, sidecar); ids.set(path, pageId);
		mount = await openPane(text, ${WIDTH});
		await quiet(mount.view);
		const tail = mount.overlay.tail, draw = tail.drawGroupTag.bind(tail);
		tail.drawGroupTag = (...a) => { labels.push(a[2]); return draw(...a); };
		return { list: inlineInk.attachments(path).map(a => a.id), selected: mount.overlay.selection.isEmpty === false, mark: markNow(mount.view) };
	},
	/** The editor's rows for [from, to) and the pane's rect, client px. */
	rows(from, to) {
		const pr = mount.pane.getBoundingClientRect();
		return { tops: rowsOf(mount.view, from, to), pane: { left: pr.left, top: pr.top, right: pr.right, bottom: pr.bottom } };
	},
	/** The ink canvases hidden or shown: the pixel cell reads the editor's own paint. */
	canvases(hidden) {
		const cs = [...mount.pane.querySelectorAll("canvas")];
		for (const c of cs) c.style.visibility = hidden ? "hidden" : "";
		return cs.length;
	},
	/** The group selected as a tap on its pin selects it; then the editor quiet. The labels drawn on the way, and the mark. */
	async select(groupId) {
		const a = inlineInk.attachments(path).find(x => x.id === groupId);
		labels = [];
		mount.overlay.selection.selectExactly([...a.strokeIds]);
		mount.overlay.redrawSelectionUI();
		mount.overlay.refreshStrip();
		await quiet(mount.view);
		return { labels: labels.slice(), mark: markNow(mount.view), offset: mount.overlay.lineAnchors.follow.groupOffset(groupId), follows: mount.overlay.lineAnchors.follow.followsText(groupId) };
	},
	async deselect() {
		mount.overlay.dissolveSelection();
		mount.overlay.redrawSelectionUI();
		await quiet(mount.view);
		return { selected: mount.overlay.selection.isEmpty === false, mark: markNow(mount.view) };
	},
	/** Per rect (client px, inside the clip), the share of device pixels that differ between two PNG shots of the clip. */
	async changed(before, after, clip, rects, dpr) {
		const load = async b64 => { const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode();
			const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const g = c.getContext("2d"); g.drawImage(img, 0, 0);
			return g.getImageData(0, 0, img.width, img.height); };
		const A = await load(before), B = await load(after);
		return rects.map(r => {
			const x0 = Math.max(0, Math.round((r.left - clip.x) * dpr)), x1 = Math.min(A.width, Math.round((r.right - clip.x) * dpr));
			const y0 = Math.max(0, Math.round((r.top - clip.y) * dpr)), y1 = Math.min(A.height, Math.round((r.bottom - clip.y) * dpr));
			let n = 0, d = 0;
			for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
				const i = (y * A.width + x) * 4; n++;
				if (Math.max(Math.abs(A.data[i] - B.data[i]), Math.abs(A.data[i + 1] - B.data[i + 1]), Math.abs(A.data[i + 2] - B.data[i + 2])) > 8) d++;
			}
			return { pixels: n, changed: d, share: n ? Math.round((d / n) * 1000) / 1000 : 0 };
		});
	},
};
`;

let browser: Browser, script: string;
let prep: { refs: Array<{ x: number; y: number } | null>; sig: { width: number; fontPx: number } };

beforeAll(async () => {
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "attachTagMarkPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
	const page = await openPage();
	try { prep = await call(page, "prepare", sidecarText([]), PAGE_ID, TEXT, [W_FROM, P_FROM]) as typeof prep; } finally { await page.close(); }
}, 180_000);
afterAll(async () => { await browser?.close(); });

const call = (p: Page, method: string, ...args: unknown[]) => p.evaluate(([m, a]) => (window as any).atm[m](...a), [method, args] as const);
async function openPage() {
	const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: DPR });
	await page.setContent(`<!doctype html><body class="theme-dark" style="margin:0; --font-text-size:19px; --background-modifier-border:#777777"></body>`);
	await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
	await page.addStyleTag({ content: MINIMAL_CSS });
	await page.addScriptTag({ content: script });
	return page;
}

type Stroke = { id: string; tool: string; color: string; width: number; createdAt: number; pts: number[] };
/** Six short strokes beside a target's first character: `tag` names them, `dx` and `dy` place them from its point. */
function strokesAt(tag: string, ref: { x: number; y: number } | null | undefined, dx: number, dy: number): Stroke[] {
	const at = ref ?? { x: 100, y: 100 }, out: Stroke[] = [];
	for (let k = 0; k < 6; k++) {
		const x0 = at.x + dx + 14 * k, y0 = at.y + dy + (k % 2) * 4, pts: number[] = [];
		for (let i = 0; i <= 6; i++) pts.push(x0 + 2 * i, y0 + Math.sin(i) * 3, 0.5, i * 8);
		out.push({ id: `atm-${tag}-${k}`, tool: "pen", color: "#ffffff", width: 3, createdAt: 1, pts });
	}
	return out;
}
const wordInk = () => strokesAt("w", prep?.refs[0], -4, 26);
const paraInk = () => strokesAt("p", prep?.refs[1], 40, 10);
function sidecarText(attachments: unknown[]) {
	return JSON.stringify({ schemaVersion: 1, pageId: PAGE_ID, surface: "inline", strokes: [...wordInk(), ...paraInk()], textBoxes: [], images: [], attachments });
}
function recordOf(id: string, kind: "range" | "paragraph", from: number, to: number, ref: { x: number; y: number }, strokes: Stroke[]) {
	const first = strokes[0]!;
	return { v: 1, id, strokeIds: strokes.map((s) => s.id), target: { kind, from, to, text: TEXT.slice(from, to), before: TEXT.slice(Math.max(0, from - 32), from).replace(/\s+/g, " "), after: TEXT.slice(to, to + 32).replace(/\s+/g, " ") },
		ref: { x: ref.x, y: ref.y }, layout: { width: prep.sig.width, font: prep.sig.fontPx }, probe: { id: first.id, x: first.pts[0]!, y: first.pts[1]! } };
}
const records = () => [recordOf("atm-word", "range", W_FROM, W_TO, prep.refs[0]!, wordInk()), recordOf("atm-para", "paragraph", P_FROM, P_TO, prep.refs[1]!, paraInk())];

type Rect = { left: number; top: number; right: number; bottom: number };
type Mark = { count: number; text: string; rows: Rect[]; bg: string | null };

/** The note opened with both groups; each selected in turn: what it showed, the rows' pixels before and after, stills. */
async function selectEach(page: Page) {
	const opened = await call(page, "open", sidecarText(records()), PAGE_ID, TEXT) as { list: string[]; selected: boolean; mark: Mark };
	const out: Record<string, unknown> = { opened };
	for (const [id, from, to] of [["atm-word", W_FROM, W_TO], ["atm-para", P_FROM, P_TO]] as const) {
		const rows = await call(page, "rows", from, to) as { tops: number[]; pane: Rect };
		const clip = { x: rows.pane.left, y: rows.pane.top, width: rows.pane.right - rows.pane.left, height: rows.pane.bottom - rows.pane.top };
		const hidden = await call(page, "canvases", true) as number;
		const before = (await page.screenshot({ clip })).toString("base64");
		const sel = await call(page, "select", id) as { labels: string[]; mark: Mark; offset: unknown; follows: boolean };
		const after = (await page.screenshot({ clip })).toString("base64");
		const painted = await call(page, "changed", before, after, clip, sel.mark.rows, DPR) as Array<{ pixels: number; changed: number; share: number }>;
		await call(page, "canvases", false);
		if (STILL) {
			mkdirSync(STILL, { recursive: true });
			writeFileSync(join(STILL, id === "atm-word" ? "still-word.png" : "still-paragraph.png"), await page.screenshot({ clip }));
		}
		const after2 = await call(page, "deselect") as { selected: boolean; mark: Mark };
		out[id] = { rowTops: rows.tops, canvases: hidden, ...sel, painted, deselected: after2 };
	}
	return out as { opened: { list: string[]; selected: boolean; mark: Mark } } & Record<"atm-word" | "atm-para", {
		rowTops: number[]; canvases: number; labels: string[]; mark: Mark; offset: unknown; follows: boolean;
		painted: Array<{ pixels: number; changed: number; share: number }>; deselected: { selected: boolean; mark: Mark };
	}>;
}

let shown: Awaited<ReturnType<typeof selectEach>> | null = null;
let shownErrors: string[] = [];
async function shownOnce() {
	if (shown) return shown;
	const page = await openPage();
	page.on("pageerror", (e) => shownErrors.push(String(e.message).slice(0, 200)));
	try {
		shown = await selectEach(page);
		console.log(`[attach-tag-mark] ${JSON.stringify(shown)}`);
		return shown;
	} finally { await page.close(); }
}

it("mark: the selected group's text is highlighted, the one word or every row of the wrapped paragraph", async () => {
	const r = await shownOnce(), brief = `\n${JSON.stringify(r)}`;
	expect(shownErrors, "page errors").toEqual([]);
	expect([r.opened.list, r.opened.selected, r.opened.mark.count], `premise: two groups listed, nothing selected, no mark at open${brief}`).toEqual([["atm-word", "atm-para"], false, 0]);
	for (const id of ["atm-word", "atm-para"] as const) {
		expect([r[id].follows, r[id].canvases > 0], `premise: ${id} follows its text; the ink canvases were hidden for the pixels${brief}`).toEqual([true, true]);
		expect(r[id].deselected, `premise: ${id} deselected leaves no mark${brief}`).toMatchObject({ selected: false, mark: { count: 0 } });
	}
	expect(r["atm-word"].mark.text, `the word group's mark holds exactly its word${brief}`).toBe("word");
	expect(r["atm-word"].rowTops.length, `premise: the word sits on one row${brief}`).toBe(1);
	expect(r["atm-word"].painted.map((p) => p.share >= 0.5), `the word's rect is painted${brief}`).toEqual([true]);
	const para = r["atm-para"];
	expect(para.rowTops.length, `premise: the paragraph wraps over three rows or more${brief}`).toBeGreaterThanOrEqual(3);
	expect(para.mark.text, `the paragraph group's mark holds exactly its paragraph${brief}`).toBe(LONG);
	expect(para.mark.rows.length, `the mark covers each of the paragraph's ${para.rowTops.length} rows${brief}`).toBe(para.rowTops.length);
	expect(para.painted.map((p) => p.share >= 0.5), `each of the paragraph's rows is painted${brief}`).toEqual(para.rowTops.map(() => true));
}, 180_000);

it("label: the selected group reads Attached, the word group and the paragraph group alike", async () => {
	const r = await shownOnce(), brief = `\n${JSON.stringify({ word: r["atm-word"].labels, para: r["atm-para"].labels })}`;
	expect(shownErrors, "page errors").toEqual([]);
	const once = (ls: string[]) => [...new Set(ls)];
	expect(once(r["atm-word"].labels), `the word group's label${brief}`).toEqual(["Attached"]);
	expect(once(r["atm-para"].labels), `the paragraph group's label${brief}`).toEqual(["Attached"]);
}, 180_000);
