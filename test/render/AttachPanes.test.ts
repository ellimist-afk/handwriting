/**
 * INK ATTACHED TO TEXT, ON THE SCREEN: TWO PANES, A WIDTH CHANGE AND AN EXPORT.
 *
 * One small note, no heavy fixture: a line, a long paragraph that wraps once more at the narrow width, and a target
 * paragraph with six short strokes attached to it beside its words. The record is made where the target is laid out in a
 * 900 px pane (its reference point read through the layout, as Attach reads it) and written into the sidecar copy, so it
 * loads as a saved note does. Device pixel ratio 2, the Minimal theme.
 *
 * Cells:
 *   A6     the note open in a 900 px pane and a 600 px pane: the group stands at the same place against its words in
 *          both, to the hundredth of a world unit, and the committed canvas pixels around it are equal.
 *   first  the 900 px pane narrowed to 600 px: in no frame after the change is the group's ink at its old place on the
 *          screen, and once quiet it stands as the 600 px pane shows it.
 *   A17    the narrow pane's export strokes (the overlay's exportStrokes) are the group as shown, not as stored.
 *
 * Run: npx vitest run --config vitest.render.mts test/render/AttachPanes.test.ts. HW_AP_OUT=<file> writes the record.
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
const PAGE_ID = "attach-panes-0001";
const LONG = "This paragraph is long enough that the narrow pane wraps it onto one more line than the wide pane does, so every line below it sits lower there, and the attached ink must follow its words down.";
const TARGET = "Target paragraph with the ink beside it.";
const TEXT = "A first line of the note.\n\n" + LONG + "\n\n" + TARGET + "\n\nA last line.";
const FROM = TEXT.indexOf(TARGET), TO = FROM + TARGET.length;
const WIDE = 900, NARROW = 600;

const PAGE = `
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { inlineInk, inkOverlayExtension, setScrollExpansionEnabled, setInlineTool } from "../../src/inline/InkOverlay";
import { instances } from "../../src/inline/InkOverlayRegistry";
import { targetAt } from "../../src/inline/InkAttachments";
import { setPenInk } from "../../src/inline/PenInk";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField } from "./iphoneObsidianStub";
import { parsePage } from "../../src/model/PageData";

installObsidianDom();
const ids = new Map(), sidecars = new Map();
inlineInk.attachHost({ readPageId: p => ids.get(p) ?? null, claimId: async (p, id) => { ids.set(p, id); return { pageId: id }; },
	loadSidecar: async id => (sidecars.has(id) ? parsePage(sidecars.get(id), id) : null), scheduleSidecar: () => {}, scheduleSidecarNow: async () => {}, notify: () => {} });
const frame = () => new Promise(r => requestAnimationFrame(() => r()));
/** After every frame callback of the next frame: what that frame painted. */
const painted = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await frame(); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const path = "Attach panes.md";
const panes = [];

function installSizer(view) {
	const sizer = document.createElement("div"); sizer.className = "cm-sizer";
	const container = document.createElement("div"); container.className = "cm-contentContainer";
	view.contentDOM.parentElement.insertBefore(sizer, view.contentDOM); sizer.appendChild(container); container.appendChild(view.contentDOM);
	void view.scrollDOM.clientWidth;
}

async function openPane(text, width, left) {
	const pane = document.body.appendChild(document.createElement("div"));
	pane.className = "markdown-source-view mod-cm6";
	pane.style.cssText = "position:absolute;left:" + left + "px;top:40px;width:" + width + "px;height:700px;overflow:hidden";
	const view = new EditorView({ parent: pane, state: EditorState.create({ doc: text, extensions: [history(), EditorView.lineWrapping,
		editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} })), inkOverlayExtension(),
		EditorView.theme({ "&": { width: "100%", height: "700px" }, ".cm-scroller": { overflowY: "auto", overflowX: "hidden" } })] }) });
	installSizer(view);
	for (let i = 0; i < 200 && inlineInk.strokes(path).length === 0; i++) await settle(2);
	await settle(12); await sleep(200); await settle(8);
	const overlay = [...instances].find(p => p.view === view);
	if (!overlay) throw new Error("no overlay for the pane");
	const p = { pane, view, overlay };
	panes.push(p);
	return p;
}

const readRef = (p, pos) => new Promise(res => p.view.requestMeasure({ read: () => p.overlay.followRefAt(pos), write: res }));
const members = (p, idsOf) => { const want = new Set(idsOf); return p.overlay.noteStrokes(path).filter(s => want.has(s.id)); };
/** The device-pixel box on a pane's committed canvas that holds these strokes, padded 3 world units. */
function boxOf(p, strokes) {
	const o = p.overlay, cam = o.camera, c = o.committedCanvas, cr = c.getBoundingClientRect(), box = o.container.getBoundingClientRect();
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (const s of strokes) { x0 = Math.min(x0, s.bbox.x); y0 = Math.min(y0, s.bbox.y); x1 = Math.max(x1, s.bbox.x + s.bbox.width); y1 = Math.max(y1, s.bbox.y + s.bbox.height); }
	const a = cam.worldToScreen(x0 - 3, y0 - 3), b = cam.worldToScreen(x1 + 3, y1 + 3), k = c.width / cr.width;
	const dev = (sx, sy) => ({ x: Math.round((box.left + sx * o.cssScale - cr.left) * k), y: Math.round((box.top + sy * o.cssScale - cr.top) * k) });
	const p0 = dev(a.x, a.y), p1 = dev(b.x, b.y);
	return { x: p0.x, y: p0.y, w: p1.x - p0.x, h: p1.y - p0.y };
}
function pixels(p, b) {
	// The pen ink as shown: the committed pen layer with the attached layer's pen canvas over it.
	const c = p.overlay.committedCanvas, att = p.overlay.attachedLayer?.pen;
	const x = Math.max(0, b.x), y = Math.max(0, b.y), w = Math.min(c.width - x, b.w), h = Math.min(c.height - y, b.h);
	if (w <= 0 || h <= 0) return { data: [], ink: 0 };
	const t = document.createElement("canvas");
	t.width = w; t.height = h;
	const g = t.getContext("2d");
	g.drawImage(c, x, y, w, h, 0, 0, w, h);
	if (att && att.width === c.width && att.height === c.height) g.drawImage(att, x, y, w, h, 0, 0, w, h);
	const d = g.getImageData(0, 0, w, h).data;
	let ink = 0;
	for (let i = 3; i < d.length; i += 4) if (d[i] > 0) ink++;
	return { data: d, ink };
}

window.ap = {
	/** One pane at the wide width: the target's reference point, read through the layout, and the signature. */
	async prepare(sidecar, pageId, text, from) {
		setPenInk(true); setScrollExpansionEnabled(true); setInlineTool("pen");
		sidecars.set(pageId, sidecar); ids.set(path, pageId);
		const p = await openPane(text, ${WIDE}, 20);
		const ref = await readRef(p, from), sig = p.overlay.lineAnchors.sig;
		return { ref, sig: sig ? { width: sig.width, fontPx: sig.fontPx } : null, scale: p.overlay.scale };
	},
	/** A6: the same note in a wide and a narrow pane. */
	async twoPanes(sidecar, pageId, text, rec, canvas = true) {
		setPenInk(true); setScrollExpansionEnabled(canvas); setInlineTool("pen");
		sidecars.set(pageId, sidecar); ids.set(path, pageId);
		const a = await openPane(text, ${WIDE}, 20), b = await openPane(text, ${NARROW}, 20 + ${WIDE} + 20);
		await settle(8); await sleep(200); await settle(8);
		const out = [];
		for (const p of [a, b]) {
			const ref = await readRef(p, rec.target.from), ms = members(p, rec.strokeIds);
			out.push({ ref, rel: ms.map(s => ({ x: s.points[0].x - ref.x, y: s.points[0].y - ref.y })), offset: p.overlay.lineAnchors.follow.groupOffset(rec.id), box: boxOf(p, ms) });
		}
		const pa = pixels(a, out[0].box), pb = pixels(b, { ...out[1].box, w: out[0].box.w, h: out[0].box.h });
		let differ = pa.data.length === pb.data.length ? 0 : -1;
		if (differ === 0) for (let i = 0; i < pa.data.length; i++) if (pa.data[i] !== pb.data[i]) differ++;
		// A17 on the narrow pane: what an export prints for the group.
		const stored = new Map(inlineInk.strokes(path).map(s => [s.id, s]));
		const shown = members(b, rec.strokeIds), want = new Set(rec.strokeIds);
		const exported = b.overlay.exportStrokes(path).filter(s => want.has(s.id));
		const sameAs = (xs, ys) => xs.length === ys.length && xs.every((s, i) => s.points.every((q, j) => Math.abs(q.x - ys[i].points[j].x) < 1e-9 && Math.abs(q.y - ys[i].points[j].y) < 1e-9));
		return { store: inlineInk.strokes(path).map(s => s.id), list: inlineInk.attachments(path).map(a => a.id), shownIds: a.overlay.noteStrokes(path).map(s => s.id), panes: out.map(o => ({ ref: o.ref, rel: o.rel, offset: o.offset, box: o.box })), held: [a, b].map(p => p.overlay.columnHeld ?? null), inkA: pa.ink, inkB: pb.ink, differ, sizes: [pa.data.length, pb.data.length],
			export: { members: exported.length, equalsShown: sameAs(exported, shown), equalsStored: sameAs(exported, shown.map(s => stored.get(s.id))) } };
	},
	/** First paint after a width change: the wide pane narrowed; every frame's pixels at the group's old place. */
	async narrow(sidecar, pageId, text, rec, canvas = true) {
		setPenInk(true); setScrollExpansionEnabled(canvas); setInlineTool("pen");
		sidecars.set(pageId, sidecar); ids.set(path, pageId);
		const fileAnchors = JSON.parse(sidecar).strokes.filter(s => s.lineAnchor || s.anchor).length;
		const a = await openPane(text, ${WIDE}, 20);
		const heldBefore = a.overlay.columnHeld ?? null;
		const old = boxOf(a, members(a, rec.strokeIds)), oldInk = pixels(a, old).ink;
		// Where the words are on the screen: the target's first character, read after each frame painted (outside CodeMirror's update).
		const wordsAt = () => { const r = a.view.coordsAtPos(rec.target.from, 1); return r ? Math.round(r.top * 100) / 100 : null; };
		const words0 = wordsAt();
		a.pane.style.width = "${NARROW}px";
		const seen = [];
		for (let i = 0; i < 40; i++) {
			await painted();
			const ms = members(a, rec.strokeIds), off = a.overlay.lineAnchors.follow.groupOffset(rec.id);
			const words = wordsAt();
			seen.push({ frame: i, atOld: pixels(a, old).ink, pending: off === null, offset: off, words, moved: words !== words0 });
		}
		await settle(8); await sleep(200); await settle(8);
		const ref = await readRef(a, rec.target.from), ms = members(a, rec.strokeIds);
		const now = boxOf(a, ms);
		return { oldInk, words0, seen, fileAnchors, heldBefore, heldAfter: a.overlay.columnHeld ?? null, wordsEnd: wordsAt(), old, now, overlap: !(now.y >= old.y + old.h || now.y + now.h <= old.y || now.x >= old.x + old.w || now.x + now.w <= old.x),
			rel: ms.map(s => ({ x: s.points[0].x - ref.x, y: s.points[0].y - ref.y })), newInk: pixels(a, now).ink };
	},
};
`;

let browser: Browser, script: string;
const record: unknown[] = [];
let prep: { ref: { x: number; y: number }; sig: { width: number; fontPx: number }; scale: number };

beforeAll(async () => {
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "attachPanesPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
	const page = await openPage();
	try { prep = await call(page, "prepare", sidecarText([]), PAGE_ID, TEXT, FROM) as typeof prep; } finally { await page.close(); }
}, 180_000);
afterAll(async () => {
	await browser?.close();
	if (process.env.HW_AP_OUT) writeFileSync(process.env.HW_AP_OUT, JSON.stringify(record, null, 1));
});

const call = (p: Page, method: string, ...args: unknown[]) => p.evaluate(([m, a]) => (window as any).ap[m](...a), [method, args] as const);
async function openPage() {
	const page = await browser.newPage({ viewport: { width: 1600, height: 800 }, deviceScaleFactor: 2 });
	await page.setContent(`<!doctype html><body class="theme-dark" style="margin:0; --font-text-size:19px; --background-modifier-border:#777777"></body>`);
	await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
	await page.addStyleTag({ content: MINIMAL_CSS });
	await page.addScriptTag({ content: script });
	return page;
}

/** Six short strokes 30 world units right of the target's first character and 8 below its top, plus one far ink stroke. */
function strokesNear(ref: { x: number; y: number } | null) {
	const at = ref ?? { x: 100, y: 100 }, out: Array<{ id: string; tool: string; color: string; width: number; createdAt: number; pts: number[] }> = [];
	for (let k = 0; k < 6; k++) {
		const x0 = at.x + 30 + 22 * k, y0 = at.y + 8 + (k % 2) * 4, pts: number[] = [];
		for (let i = 0; i <= 8; i++) pts.push(x0 + 2 * i, y0 + Math.sin(i) * 3, 0.5, i * 8);
		out.push({ id: "ap-" + k, tool: "pen", color: "#ffffff", width: 3, createdAt: 1, pts });
	}
	out.push({ id: "ap-far", tool: "pen", color: "#ffffff", width: 3, createdAt: 1, pts: [40, 2000, 0.5, 0, 80, 2004, 0.5, 8] });
	return out;
}
function sidecarText(attachments: unknown[]) {
	return JSON.stringify({ schemaVersion: 1, pageId: PAGE_ID, surface: "inline", strokes: strokesNear(prep?.ref ?? null), textBoxes: [], images: [], attachments });
}
function theRecord() {
	const strokes = strokesNear(prep.ref).slice(0, 6), first = strokes[0]!;
	return { v: 1, id: "ap-group", strokeIds: strokes.map((s) => s.id), target: { kind: "paragraph", from: FROM, to: TO, text: TARGET, before: TEXT.slice(Math.max(0, FROM - 32), FROM).replace(/\s+/g, " "), after: TEXT.slice(TO, TO + 32).replace(/\s+/g, " ") },
		ref: { x: prep.ref.x, y: prep.ref.y }, layout: { width: prep.sig.width, font: prep.sig.fontPx }, probe: { id: first.id, x: first.pts[0]!, y: first.pts[1]! } };
}

it("premise: the target's reference point was read in the wide pane", () => {
	expect(prep.ref, "a reference point").not.toBeNull();
	expect(prep.sig, "a line signature").not.toBeNull();
});

it("A6: opened in two panes of different widths, the group is read and painted at once, at the same place against its words, pixel for pixel; A17: the export prints it as shown", async () => {
	const page = await openPage(), errors: string[] = [];
	page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 200)));
	try {
		const rec = theRecord();
		// Infinite Canvas off: an inked note's column is held only while the pane has room for the width its ink was drawn at,
		// so the narrow pane (below that width) wraps its text as before and re-places the group against its words.
		const r = await call(page, "twoPanes", sidecarText([rec]), PAGE_ID, TEXT, rec, false) as any;
		record.push({ cell: "A6+A17", r });
		const brief = "\n" + JSON.stringify(r);
		expect(errors, "page errors").toEqual([]);
		const [a, b] = r.panes;
		// Opening the note is enough: each pane reads the group's words and paints it, with no edit, scroll or resize after the load.
		expect([a.offset !== null, b.offset !== null], `after the load, with no editor change, both panes read the group and paint it${brief}`).toEqual([true, true]);
		expect(a.offset, `premise: the wide pane shows the group at its stored points${brief}`).toEqual({ dx: 0, dy: 0 });
		expect(b.offset && (Math.abs(b.offset.dx) > 1 || Math.abs(b.offset.dy) > 1), `premise: the narrow pane shows the group away from its stored points${brief}`).toBe(true);
		expect(b.rel.map((p: { x: number; y: number }, i: number) => Math.max(Math.abs(p.x - a.rel[i].x), Math.abs(p.y - a.rel[i].y)) < 0.01), `the group against its words, equal in both panes${brief}`).toEqual(a.rel.map(() => true));
		expect([r.inkA > 0, r.differ], `the committed pixels around the group are equal in both panes${brief}`).toEqual([true, 0]);
		expect([r.export.members, r.export.equalsShown, r.export.equalsStored], `A17: the narrow pane's export holds the group as shown, not as stored${brief}`).toEqual([6, true, false]);
		// Infinite Canvas on: the column is held at the ink's width in any pane, so the narrow pane shows the group at its stored
		// points as the wide one does, the same against its words and pixel for pixel, and its export prints it as stored.
		const on = await (async () => { const p2 = await openPage(); try { return await call(p2, "twoPanes", sidecarText([rec]), PAGE_ID, TEXT, rec, true) as any; } finally { await p2.close(); } })();
		record.push({ cell: "A6+A17 canvas on", r: on });
		const briefOn = "\n" + JSON.stringify(on);
		const [c, d] = on.panes;
		expect(on.held, `Infinite Canvas on: both panes hold the column at the width the note's ink was drawn at, the pane opened first too${briefOn}`).toEqual([prep.sig.width, prep.sig.width]);
		expect([c.offset, d.offset], `Infinite Canvas on: both panes show the group at its stored points${briefOn}`).toEqual([{ dx: 0, dy: 0 }, { dx: 0, dy: 0 }]);
		expect(d.rel.map((p: { x: number; y: number }, i: number) => Math.max(Math.abs(p.x - c.rel[i].x), Math.abs(p.y - c.rel[i].y)) < 0.01), `Infinite Canvas on: the group against its words, equal in both panes${briefOn}`).toEqual(c.rel.map(() => true));
		expect([on.inkA > 0, on.differ], `Infinite Canvas on: the committed pixels around the group are equal in both panes${briefOn}`).toEqual([true, 0]);
		expect([on.export.members, on.export.equalsShown, on.export.equalsStored], `Infinite Canvas on, A17: the narrow pane's export holds the group as shown, which is as stored${briefOn}`).toEqual([6, true, true]);
	} finally { await page.close(); }
}, 120_000);

it("first paint after a width change: the group is never painted at its old place, and lands where the narrow pane shows it", async () => {
	const page = await openPage(), errors: string[] = [];
	page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 200)));
	try {
		const rec = theRecord();
		// Infinite Canvas off: a pane narrowed below the width the ink was drawn at re-wraps its text (with the canvas on the
		// column is held and nothing re-wraps; the cell after this one).
		const r = await call(page, "narrow", sidecarText([rec]), PAGE_ID, TEXT, rec, false) as any;
		const two = await (async () => { const p2 = await openPage(); try { return await call(p2, "twoPanes", sidecarText([rec]), PAGE_ID, TEXT, rec, false) as any; } finally { await p2.close(); } })();
		record.push({ cell: "first", r });
		const brief = "\n" + JSON.stringify({ ...r, seen: r.seen.slice(0, 12) });
		expect(errors, "page errors").toEqual([]);
		expect([r.oldInk > 0, r.overlap], `premise: ink at the old place before the change, and the new place apart from it${brief}`).toEqual([true, false]);
		// Until the narrowed pane has laid its words out again the old place is still theirs; from the first frame they stand
		// elsewhere, the group's ink is never at its old place.
		expect(r.seen.some((s: { moved: boolean }) => s.moved), `premise: the width change moved the target's words${brief}`).toBe(true);
		expect(r.seen.filter((s: { atOld: number; moved: boolean }) => s.moved && s.atOld > 0).map((s: { frame: number }) => s.frame), `frames after the words moved with ink at the old place${brief}`).toEqual([]);
		const want = two.panes[1].rel;
		expect([r.newInk > 0, r.rel.every((p: { x: number; y: number }, i: number) => Math.abs(p.x - want[i].x) < 0.01 && Math.abs(p.y - want[i].y) < 0.01)],
			`once quiet, painted where the narrow pane shows it${brief}`).toEqual([true, true]);
	} finally { await page.close(); }
}, 120_000);

it("Infinite Canvas on, a note whose file strokes carry no line anchor, opened once in one pane: the column is held from the session's first anchors, before and after the pane narrows, and the ink does not move", async () => {
	const page = await openPage(), errors: string[] = [];
	page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 200)));
	try {
		const rec = theRecord();
		const r = await call(page, "narrow", sidecarText([rec]), PAGE_ID, TEXT, rec, true) as any;
		record.push({ cell: "pre-anchor canvas on", r: { ...r, seen: r.seen.slice(0, 12) } });
		const brief = "\n" + JSON.stringify({ ...r, seen: r.seen.slice(0, 12) });
		expect(errors, "page errors").toEqual([]);
		expect([r.fileAnchors, r.oldInk > 0], `premise: the file's strokes carry no line anchor, and the group is painted at open${brief}`).toEqual([0, true]);
		expect([r.heldBefore, r.heldAfter], `the pane opened first holds the column at the width the ink was drawn at, before and after narrowing to ${NARROW} px${brief}`).toEqual([prep.sig.width, prep.sig.width]);
		expect([r.seen.filter((s: { moved: boolean }) => s.moved).map((s: { frame: number }) => s.frame), r.wordsEnd === r.words0], `the target's words never move${brief}`).toEqual([[], true]);
		expect([r.now.x - r.old.x, r.now.y - r.old.y, r.newInk > 0], `the group's ink stays where it was painted${brief}`).toEqual([0, 0, true]);
	} finally { await page.close(); }
}, 120_000);
