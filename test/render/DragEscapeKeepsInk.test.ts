/**
 * ESCAPE OR A TOOL CHANGE IN THE MIDDLE OF A LASSO DRAG OR TURN: THE DRAGGED INK STAYS ON SCREEN.
 *
 * Defect (TF-8, C2-06): while a lassoed selection is dragged or turned, the committed layer paints the note without the
 * selected ink and the tail carries it as the grab's picture. Escape, or a tool change, clears the selection with the pen
 * still down. The selection layer then draws no chrome, its tail is shrunk, and the picture goes with it; the samples after
 * that draw nothing. The ink is gone from the screen until the lift puts it back.
 *
 * The bar, either of: the picture is still drawn (the ink where it was let go), or the gesture ended cleanly with the ink
 * shown at its start place (no picture, the store at pen-down, the committed layer painting it). Read after the key, after
 * the queued tail shrink has had its frame and task, and again after more samples, all before the lift.
 *
 * The page is TransformPreviewRedraws.test.ts's: a plain editor, dark, one magenta stroke drawn by real pen events through
 * the router, selected by a real lasso loop, device scale 2. The grab is a real pen-down inside the box (drag) or on the
 * turn knob (turn). Escape is a keydown dispatched on the editor's content, which reaches the overlay's own handler; the
 * tool change is setInlineTool, as the toolbar and hotkeys call it. Ink is read as magenta pixels on the tail and the
 * committed canvas, the two layers that can show it.
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
import { Platform } from "obsidian";
import { inlineInk, inkOverlayExtension, overlayForPath, setInlineTool, setInkSizeMult } from "../../src/inline/InkOverlay";
import { setInkColorHex } from "../../src/ink/InkColor";
import { setPenInk } from "../../src/inline/PenInk";
import { setMouseInk } from "../../src/inline/MouseInk";
import { setTipMode } from "../../src/inline/TipMode";
import { handlePoints } from "../../src/inline/LassoTransform";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField } from "./iphoneObsidianStub";
import { parsePage, serializePage } from "../../src/model/PageData";

Object.assign(Platform, { isMobile: false, isDesktop: true, isIosApp: false, isDesktopApp: true, isMobileApp: false, isPhone: false, isWin: true });
installObsidianDom();
const ids = new Map(), sidecars = new Map();
const save = (id, page) => { sidecars.set(id, serializePage(page)); };
inlineInk.attachHost({ readPageId: p => ids.get(p) ?? null, claimId: async (p, id) => { ids.set(p, id); return { pageId: id }; },
	loadSidecar: async id => (sidecars.has(id) ? parsePage(sidecars.get(id), id) : null), scheduleSidecar: save, scheduleSidecarNow: async (id, p) => save(id, p), notify: () => {} });

const frame = () => new Promise(r => requestAnimationFrame(() => r()));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await frame(); };
const task = () => new Promise(r => setTimeout(r, 30));
let rig = null;

const ptr = (type, px, py, buttons) => document.elementFromPoint(px, py)?.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true,
	pointerType: "pen", pointerId: 902, isPrimary: true, clientX: px, clientY: py, buttons, button: type === "pointerdown" || type === "pointerup" ? 0 : -1, pressure: buttons ? 0.5 : 0 }));
const toClient = (p) => { const s = rig.overlay.camera.worldToScreen(p.x, p.y); return { x: s.x + rig.off.x, y: s.y + rig.off.y }; };
/** Magenta pixels on a canvas (the stroke's colour, any alpha above a quarter). */
const magenta = (c) => {
	if (!c || !c.width || !c.height) return 0;
	const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
	let n = 0;
	for (let i = 0; i < d.length; i += 4) if (d[i] > 150 && d[i + 1] < 90 && d[i + 2] > 150 && d[i + 3] > 64) n++;
	return n;
};
const points = () => inlineInk.strokes(rig.path)[0].points.map(p => [p.x, p.y]);

window.tf8 = {
	async mount() {
		setPenInk(true); setMouseInk(true);
		setInlineTool("pen"); setInkColorHex("pen", "#ff00ff"); setInkSizeMult("pen", 4); setTipMode("nib");
		const path = "drag-escape-keeps-ink.md";
		const pane = document.body.appendChild(document.createElement("div"));
		pane.className = "markdown-source-view mod-cm6";
		pane.style.cssText = "position:relative;margin-left:120px;margin-top:60px;width:900px;height:700px;overflow:hidden";
		const text = Array.from({ length: 40 }, (_, i) => "line " + (i + 1) + " words").join("\\n");
		const view = new EditorView({ parent: pane, state: EditorState.create({ doc: text, extensions: [history(), EditorView.lineWrapping,
			editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} })), inkOverlayExtension(),
			EditorView.theme({ "&": { width: "900px", height: "700px" }, ".cm-scroller": { overflowY: "auto" }, ".cm-content": { fontSize: "26px", lineHeight: "39px" } })] }) });
		await settle(12);
		const overlay = overlayForPath(path);
		if (!overlay) throw new Error("no overlay for " + path);
		rig = { pane, view, overlay, path, off: { x: 0, y: 0 } };
		const x0 = 400, y0 = 300, pts = Array.from({ length: 24 }, (_, i) => [x0 + i * 8, y0 + (i % 2 ? 26 : 0)]);
		ptr("pointermove", x0, y0, 0); await frame();
		ptr("pointerdown", x0, y0, 1);
		for (const [x, y] of pts.slice(1)) { ptr("pointermove", x, y, 1); await frame(); }
		ptr("pointerup", pts.at(-1)[0], pts.at(-1)[1], 0);
		await settle(12);
		const st = inlineInk.strokes(path)[0];
		if (!st) throw new Error("no stroke drawn");
		const s = overlay.camera.worldToScreen(st.points[0].x, st.points[0].y);
		rig.off = { x: x0 - s.x, y: y0 - s.y };
		return { strokes: inlineInk.strokes(path).length };
	},
	async select() {
		setTipMode("lasso");
		const cx = 492, cy = 313, R = 150, N = 36;
		ptr("pointermove", cx + R, cy, 0); await frame();
		ptr("pointerdown", cx + R, cy, 1);
		for (let i = 1; i <= N; i++) { ptr("pointermove", cx + R * Math.cos(2 * Math.PI * i / N), cy + R * 0.6 * Math.sin(2 * Math.PI * i / N), 1); await frame(); }
		ptr("pointerup", cx + R, cy, 0);
		await settle(6);
		return rig.overlay.selection.size;
	},
	/** Grab, move, let go of the selection by o.how ("escape" | "tool") with the pen down, read, move more, read, lift. */
	async run(o) {
		const { overlay } = rig, box = overlay.selectionBounds(), cam = overlay.camera.snapshot;
		const at = o.gesture === "drag" ? toClient({ x: box.x + box.width / 2, y: box.y + box.height / 2 }) : toClient(handlePoints(box, cam.zoom).rotate);
		const start = points();
		const committedIdle = magenta(overlay.committedCanvas);
		ptr("pointermove", at.x, at.y, 0); await frame();
		ptr("pointerdown", at.x, at.y, 1); await frame();
		const snap0 = overlay.spaceSnapshot;
		const began = o.gesture === "drag" ? !!(snap0 && snap0.kind === "lasso" && !snap0.transform) : !!(snap0 && snap0.transform);
		let last = at;
		const move = async (n, from) => { for (let i = 1; i <= n; i++) { last = { x: at.x + (from + i) * 4, y: at.y + (from + i) * 3 }; ptr("pointermove", last.x, last.y, 1); await frame(); } };
		await move(10, 0);
		await settle(2);
		const shownBefore = { tail: magenta(overlay.tailCanvas), committed: magenta(overlay.committedCanvas) };
		if (o.how === "escape") rig.view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		else setInlineTool("highlighter");
		const cleared = overlay.selection.isEmpty;
		// The queued tail shrink runs a frame and then a task after the key.
		await settle(2); await task(); await settle(2);
		const read = () => ({ tail: magenta(overlay.tailCanvas), committed: magenta(overlay.committedCanvas),
			picture: !!(overlay.spaceSnapshot && overlay.spaceSnapshot.kind === "lasso"), atStart: JSON.stringify(points()) === JSON.stringify(start) });
		const afterKey = read();
		await move(8, 10);
		await settle(2); await task(); await settle(2);
		const afterMoves = read();
		ptr("pointerup", last.x, last.y, 0);
		await settle(8);
		if (o.how === "tool") setInlineTool("pen");
		setTipMode("lasso");
		return { gesture: o.gesture, how: o.how, began, cleared, committedIdle, shownBefore, afterKey, afterMoves };
	},
};
`;

let browser: Browser | null = null;
let script = "";

beforeAll(async () => {
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "dragEscapeKeepsInkPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true, args: ["--force-device-scale-factor=2", "--window-size=1200,900"] });
}, 180_000);
afterAll(async () => {
	if (browser) await browser.close();
});

async function openPage(): Promise<{ page: Page; errors: string[] }> {
	const page = await (await browser!.newContext({ viewport: null })).newPage();
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	await page.setContent('<!doctype html><body class="theme-dark" style="margin:0"></body>');
	await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
	await page.addScriptTag({ content: script });
	const m = await page.evaluate(() => (window as any).tf8.mount());
	expect(m.strokes, "premise: one stroke").toBe(1);
	return { page, errors };
}
const call = (p: Page, method: string, ...args: unknown[]) => p.evaluate(([n, a]) => (window as any).tf8[n](...a), [method, args] as const) as Promise<any>;

type Seen = { tail: number; committed: number; picture: boolean; atStart: boolean };
/** The bar: the picture still drawn, or the gesture ended with the ink back at its start and painted. */
const verdict = (s: Seen) =>
	s.picture ? (s.tail > 0 ? "picture drawn" : "picture live, nothing on the tail")
		: s.atStart ? (s.committed > 0 ? "ended at the start, painted" : "ended at the start, not painted")
		: "ended away from the start";
const OK = ["picture drawn", "ended at the start, painted"];

for (const gesture of ["drag", "turn"] as const) {
	for (const how of ["escape", "tool"] as const) {
		it(`${how === "escape" ? "Escape" : "a tool change"} mid-${gesture}: the dragged ink stays on screen until the lift`, async () => {
			const { page, errors } = await openPage();
			try {
				expect(await call(page, "select"), "premise: the lasso selected the stroke").toBe(1);
				const r = await call(page, "run", { gesture: gesture === "turn" ? "rotate" : "drag", how });
				// eslint-disable-next-line no-console
				console.log(`TF-8 ${JSON.stringify(r)}`);
				expect(errors, "page errors").toEqual([]);
				expect(r.committedIdle, "premise: the committed layer showed the ink before the grab").toBeGreaterThan(0);
				expect(r.began, `premise: the grab started the ${gesture}`).toBe(true);
				expect(r.shownBefore.tail, "premise: the picture was on the tail before the key").toBeGreaterThan(0);
				expect(r.cleared, `premise: ${how} let go of the selection`).toBe(true);
				const seen = [verdict(r.afterKey), verdict(r.afterMoves)];
				expect(seen.every(v => OK.includes(v)), `after the ${how} and its shrink, then after more samples: ${seen.join("; ")} ` +
					`(tail ${r.afterKey.tail}/${r.afterMoves.tail} px, committed ${r.afterKey.committed}/${r.afterMoves.committed} px)`).toBe(true);
			} finally {
				await page.context().close();
			}
		}, 120_000);
	}
}
