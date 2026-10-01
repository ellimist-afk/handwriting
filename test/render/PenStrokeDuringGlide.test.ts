/**
 * Case 3, and Alan's ruling on the conflict this cell first exposed. Off-centre pinch-out
 * 100% -> 10%, RLL off, IC off. 100ms into the post-lift glide, a real pen contact: pointerdown, a short move (a
 * stroke), pointerup - on view.scrollDOM, pointerType "pen". InlinePenRouter.pointerDown calls onViewportInput()
 * at its very top (:2502-2504), before any pen/touch classification, so this hits the same cancel path the tap
 * cell covers, and the same resumeStrandedPan resumes it - one method, called from both the touch and the pen
 * lift sites, with no branch on input type. Logs the cancelOverscrollBounce entry (build-time patch, source
 * untouched), viewportPan, leftEdgePx at rest.
 *
 * Nothing moves unless the page stands past its bound, then it eases back - no infinite blank forever.
 * This cell's page is well past its bound at the moment of the tap-equivalent pen contact (a 10% zoom-out has
 * plenty of room), so the correct rest here is the bound, same as the touch cells. OverscrollBounce.test.ts's
 * "PEN DOWN MID-BOUNCE" is the paired control for the OTHER regime - a page already inside its room, where a
 * caught-and-drawn stroke has nowhere to ease to and correctly does not move after.
 *
 * No separate floor-bound (-9ish) arm here: resumeStrandedPan clamps identically regardless of what cancelled the
 * ease, and TapDuringGlide.test.ts's floor cell already exercises that clamp end to end. This cell's job is
 * proving the PEN call site reaches resumeStrandedPan at all (it's a distinct wiring point, penUp -> the same
 * method), not re-proving the clamp math a second time.
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

/** Minimal 9.0.2's theme.css, verbatim (the fixture MinimalCameraScale.test.ts loads): every cell runs on both arms. */
const MINIMAL_CSS = readFileSync(fileURLToPath(new URL("./fixtures/minimal-9.0.2-theme.css", import.meta.url)), "utf8");
const ARMS = ["stock", "minimal"] as const;
type Arm = typeof ARMS[number];

declare const process: { env: Record<string, string | undefined> };

const PAGE = `
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { inlineInk, inkOverlayExtension, overlayForPath, setScrollExpansionEnabled } from "../../src/inline/InkOverlay";
import { setInkColorHex } from "../../src/ink/InkColor";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField } from "./iphoneObsidianStub";
import { parsePage, serializePage } from "../../src/model/PageData";

installObsidianDom();
const ids = new Map(), sidecars = new Map();
const save = (id, page) => { sidecars.set(id, serializePage(page)); };
inlineInk.attachHost({ readPageId: p => ids.get(p) ?? null, claimId: async (p, id) => { ids.set(p, id); return { pageId: id }; },
	loadSidecar: async id => (sidecars.has(id) ? parsePage(sidecars.get(id), id) : null), scheduleSidecar: save, scheduleSidecarNow: async (id, p) => save(id, p), notify: () => {} });

const frame = () => new Promise(r => requestAnimationFrame(() => r()));
const rendered = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await frame(); };
const PANE_W = 1397.5, PANE_H = 800, HOST_LEFT = 300;
let rig = null;

function installSizer(view) {
	const sizer = document.createElement("div"); sizer.className = "cm-sizer";
	const container = document.createElement("div"); container.className = "cm-contentContainer";
	view.contentDOM.parentElement.insertBefore(sizer, view.contentDOM); sizer.appendChild(container); container.appendChild(view.contentDOM);
	void view.scrollDOM.clientWidth; return sizer;
}
const r2 = v => Math.round(v * 100) / 100;
// ANY PAINTED PIXEL, not solid magenta. The committed pen layer holds ink and nothing else, and each page here has one
// stroke on it. At 10% the stroke rasterises below full coverage, so a solid-colour test found none of it, on the
// page as well as in the margin, on both arms: measured, 0 of about 40 painted pixels passed it.
const INKED = (d, i) => d[i + 3] > 0;

/** The committed canvas's painted pixels as a client box, beside the pane's: the stroke as painted, not as stored. */
function inkBox() {
	const { overlay, pane } = rig, cc = overlay.committedCanvas, pr = pane.getBoundingClientRect();
	const paneBox = { left: r2(pr.left), right: r2(pr.right), top: r2(pr.top), bottom: r2(pr.bottom) };
	if (!cc || !(cc.width > 0 && cc.height > 0)) return { n: 0, pane: paneBox };
	const w = cc.width, h = cc.height, d = cc.getContext("2d").getImageData(0, 0, w, h).data;
	let n = 0, minX = Infinity, maxX = -1, minY = Infinity, maxY = -1;
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (INKED(d, (y * w + x) * 4)) { n++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
	if (!n) return { n, pane: paneBox };
	const r = cc.getBoundingClientRect();
	return { n, pane: paneBox, left: r2(r.left + minX * r.width / w), right: r2(r.left + (maxX + 1) * r.width / w),
		top: r2(r.top + minY * r.height / h), bottom: r2(r.top + (maxY + 1) * r.height / h) };
}

function sample(phase) {
	const { view, overlay, pane } = rig;
	const pr = pane.getBoundingClientRect(), cr = view.contentDOM.getBoundingClientRect();
	const bounce = typeof overlay.overscrollBounceReadout === "function" ? overlay.overscrollBounceReadout() : null;
	return { phase, k: overlay.pinchScaleNow, preview: !!overlay.pinchPreview,
		panX: r2((overlay.viewportPan || { x: 0 }).x),
		leftEdgePx: r2(cr.left - pr.left), bounce, reserve: overlay.leftReserveHeld ?? 0,
		band: overlay.band ? { left: overlay.band.left, width: overlay.band.width } : null, repaints: rig?.repaints ?? 0, bounceSyncs: rig?.bounceSyncs ?? 0, bounceResized: rig?.bounceResized ?? 0 };
}

window.penProbe = {
	async mount(tag) {
		// 1: MOUNT WITH THE CANVAS ON. This rig made its hang and its glide with a
		// two-finger pinch through the router while the canvas was OFF - a gesture a later ruling removed and the ruling
		// handed to the host, so every premise below read 0 and the cells failed without a product fault.
		setScrollExpansionEnabled(true);
		// A colour of its own, so a screenshot of a failing run shows the stroke plainly.
		setInkColorHex("pen", "#ff00ff");
		const path = "pen-probe-" + (tag || "x") + ".md";
		const pane = document.body.appendChild(document.createElement("div"));
		pane.className = "markdown-source-view mod-cm6";
		pane.style.cssText = "position:relative;margin-left:" + HOST_LEFT + "px;width:" + PANE_W + "px;height:" + PANE_H + "px;overflow:hidden";
		const doc = Array.from({ length: 400 }, (_, i) => "line " + i + " alpha beta gamma delta epsilon zeta").join("\\n");
		const view = new EditorView({ parent: pane, state: EditorState.create({ doc, extensions: [history(), EditorView.lineWrapping,
			editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} })), inkOverlayExtension(),
			EditorView.theme({ "&": { width: PANE_W + "px", height: PANE_H + "px" }, ".cm-scroller": { overflowY: "auto", overflowX: "hidden" }, ".cm-content": { fontFamily: "monospace", fontSize: "16px", lineHeight: "24px" } })] }) });
		const sizer = installSizer(view);
		await settle(12);
		const overlay = overlayForPath(path);
		if (!overlay) throw new Error("no overlay for " + path);
		rig = { pane, view, overlay, sizer, path, repaints: 0, bounceSyncs: 0, bounceResized: 0 };
		// Band syncs that move or resize the band while a bounce plays, every call and not only those a row happens to
		// see. Past a bound it is a loop, and the guard stops calling through so the cell reads the count.
		const sync = overlay.syncBand.bind(overlay);
		overlay.syncBand = () => {
			if (overlay.bounceState && rig.bounceSyncs > 100) return "none";
			const r = sync();
			if (r !== "none" && overlay.bounceState) { rig.bounceSyncs++; if (r === "resized") rig.bounceResized++; }
			return r;
		};
		// Counts the committed layer's repaints, so a cell can say how many a lift costs.
		const repaint = overlay.repaint.bind(overlay);
		overlay.repaint = () => { rig.repaints++; repaint(); };
		return sample("natural");
	},
	async pinchOutThenPenStroke(to, widthFraction, tag, where) {
		const { overlay, pane, view } = rig, router = overlay.router;
		const r = pane.getBoundingClientRect(), cx = r.left + r.width * widthFraction, cy = r.top + r.height / 2;
		const spread0 = 300, spread1 = 300 * to / overlay.pinchScaleNow, steps = 30;
		const touch = s => { router.touchPos.set(911, { x: cx - s / 2, y: cy }); router.touchPos.set(912, { x: cx + s / 2, y: cy }); };
		const ev = type => new PointerEvent(type, { pointerId: 912, pointerType: "touch" });
		const rows = [sample(tag + "-before")];
		touch(spread0); router.beginPinch(ev("pointerdown"));
		for (let i = 1; i <= steps; i++) { touch(spread0 + (spread1 - spread0) * i / steps); router.updatePinch(ev("pointermove")); await rendered(); rows.push(sample(tag + "-move-" + i)); }
		router.endPinch(ev("pointerup"), { x: cx, y: cy }); router.touchPos.clear();
		let penned = false, inked = false;
		for (let j = 1; j <= 60; j++) {
			await rendered();
			if (!penned && j >= 6) {
				penned = true;
				// "page": on the page, 20 px inside the column's left edge, so the stroke is ordinary ink and the cell keeps
				// its intent. "margin": 20 px inside the pane, which during this glide is blank left of the page, so the
				// stroke is margin ink and the left reserve grows at pen-up. Both 20 px below the page's top edge: the glide
				// holds the page well down the pane, and a pen at the pane's top would put the stroke above the page as well.
				const page = view.contentDOM.getBoundingClientRect();
				const px = (where === "margin" ? r.left : page.left) + 20, py = page.top + 20;
				const pen = (type, x, y, buttons) => view.scrollDOM.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "pen", pointerId: 960, isPrimary: true, clientX: x, clientY: y, buttons, pressure: buttons ? 0.5 : 0 }));
				pen("pointerdown", px, py, 1);
				rows.push(sample(tag + "-pendown"));
				for (let s = 1; s <= 4; s++) { pen("pointermove", px + 10 * s, py, 1); await rendered(); }
				rows.push(sample(tag + "-penmove"));
				pen("pointerup", px + 40, py, 0);
				const up = sample(tag + "-penup"); up.ink = inkBox(); inked = up.ink.n > 0; rows.push(up);
			}
			const row = sample(tag + "-post-" + j);
			if (penned && !inked) { row.ink = inkBox(); inked = row.ink.n > 0; }
			// Two frames into the ease, while a stroke drawn beside the page is still partly on the pane.
			else if (penned && (j === 7 || j === 8)) row.ink = inkBox();
			rows.push(row);
		}
		rows.at(-1).ink = inkBox();
		return rows;
	},
};
`;

let browser: Browser, script: string;
const record: unknown[] = [];

beforeAll(async () => {
	const from = "if (!offset || (!state && offset.x === 0 && offset.y === 0)) return;";
	const to = 'if (offset && state) console.log("CANCEL-BOUNCE-ACTIVE", JSON.stringify({x:offset.x,y:offset.y}), new Error().stack);\n\t\tif (!offset || (!state && offset.x === 0 && offset.y === 0)) return;';
	let planted = 0;
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "penProbePage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
		plugins: [{ name: "cancel-log", setup(builder) {
			builder.onLoad({ filter: /src[\\/]inline[\\/]InkOverlay\.ts$/ }, args => {
				const text = readFileSync(args.path, "utf8");
				if (text.split(from).length !== 2) throw new Error("pen probe: cancelOverscrollBounce anchor not found once");
				planted++;
				return { loader: "ts", contents: text.replace(from, to) };
			});
		} }] });
	if (!planted) throw new Error("pen probe: patch never applied");
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);
afterAll(async () => {
	await browser?.close();
	if (process.env.HW_PEN_OUT) writeFileSync(process.env.HW_PEN_OUT, JSON.stringify(record, null, 1));
});

const call = (p: Page, method: string, ...args: unknown[]) => p.evaluate(([m, a]) => (window as any).penProbe[m](...a), [method, args] as const);

async function withPage(arm: Arm, fn: (p: Page, logs: string[]) => Promise<void>) {
	const p = await browser.newPage({ viewport: { width: 1800, height: 900 }, hasTouch: true });
	const logs: string[] = [];
	p.on("console", m => { if (m.text().startsWith("CANCEL-BOUNCE-ACTIVE")) logs.push(m.text()); });
	const errors: string[] = [];
	p.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	await p.setContent('<!doctype html><body style="margin:0"></body>');
	await p.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
	if (arm === "minimal") await p.addStyleTag({ content: MINIMAL_CSS });
	await p.addScriptTag({ content: script });
	await fn(p, logs);
	if (errors.length) record.push({ pageErrors: errors });
	await p.close();
}

for (const arm of ARMS) {
	it(`${arm}: a pen stroke landing during the post-lift glide does not strand the page: rest reaches the bound after pen-up`, async () => {
		let rest: any, penup: any, rows: any[] = [], cancelLogs: string[] = [];
		await withPage(arm, async (p, logs) => {
			await call(p, "mount", "p");
			rows = await call(p, "pinchOutThenPenStroke", 0.10, 0.6, "p", "page") as any[];
			rest = rows.at(-1);
			penup = rows.find(r => r.phase.endsWith("-penup"));
			cancelLogs = logs;
			record.push({ arm, rows, cancelLogs: logs, rest, penup });
		});
		// THE EASE IS BACK UNDER THE CANVAS, so this premise is the original one again. A later ruling had it pinned
		// the other way - nothing played, so nothing could be cancelled - because the true-travel capture ran
		// canvas-off only. With the ruling's capture the lift eases under the canvas too and a contact cancels it,
		// which is what this cell has always been about.
		expect(cancelLogs.length, "premise: the pen contact really did cancel a playing ease").toBeGreaterThan(0);
		// THE EASE ITSELF, not just where it ends up: two endpoints, right after the lift and at
		// rest - a mere park (the page silently placed at its bound with no ease) would pass a rest-only check.
		// The ruling's own clause, back with the ease: two endpoints, right after the lift and at rest, so a silent
		// park cannot pass a rest-only check.
		expect(Math.abs(penup.bounce.x), "the resume actually started an ease: offset non-zero right after the lift").toBeGreaterThan(0.5);
		expect(rest.bounce.active, "the ease finished by the time the page is read at rest").toBe(false);
		expect(Math.abs(rest.bounce.x), "the offset decayed to 0, not left standing").toBeLessThanOrEqual(0.5);
		expect(Math.abs(rest.panX), `pan resumed to its bound instead of freezing where the pen landed (rest ${JSON.stringify(rest)})`).toBeLessThanOrEqual(0.5);
		expect(Math.abs(rest.leftEdgePx), `the painted edge reached 0, not stuck mid-glide`).toBeLessThanOrEqual(0.5);
		expect(rest.reserve, "premise: a stroke on the page holds no left reserve").toBe(0);
		// Cross-check of the margin cell's measure: here too only the ease moves the page after pen-up.
		const place = (r: any) => r.leftEdgePx - (r.bounce?.x ?? 0);
		const after = rows.slice(rows.indexOf(penup) + 1).filter(r => r.phase.startsWith("p-post-"));
		const worst = after.reduce((w, r) => (Math.abs(place(r) - place(penup)) > Math.abs(place(w) - place(penup)) ? r : w), after[0]);
		expect(Math.abs(place(worst) - place(penup)), `page stroke: no frame after pen-up moves the page beyond the ease (worst ${JSON.stringify(worst)})`).toBeLessThanOrEqual(0.5);
		// A page with no scroll to its left: the ease reveals nothing the band lacks, so the lift moves no band.
		const penmove = rows.find(r => r.phase.endsWith("-penmove"));
		const moved = rows.slice(rows.indexOf(penmove)).filter((r, i, a) => i > 0 && JSON.stringify(r.band) !== JSON.stringify(a[i - 1].band));
		expect(moved.length, `page stroke: the band does not move from pen-up to rest (moves ${JSON.stringify(moved.map(r => [r.phase, r.band]))})`).toBe(0);
		expect(rest.bounceSyncs - penmove.bounceSyncs, "page stroke: no band sync moves the band while the ease plays").toBe(0);
	}, 60_000);

	// MARGIN INK DURING THE GLIDE. The same pinch and pen timing, but the pen lands left of the page. The page is bounded
	// by its left edge, so ink left of it buys no room: nothing is held at pen-up, and the page moves only by the resumed
	// ease, from pen-up through the frame that re-measures the column and on to rest, which is the page's normal edge.
	it(`${arm}: margin ink landing during the glide holds no room, the page moves only by the ease through rest`, async () => {
		let rows: any[] = [];
		await withPage(arm, async p => {
			await call(p, "mount", "m");
			rows = await call(p, "pinchOutThenPenStroke", 0.10, 0.6, "m", "margin") as any[];
			record.push({ arm, margin: rows });
		});
		const at = (phase: string) => rows.find(r => r.phase === phase);
		const penmove = at("m-penmove"), penup = at("m-penup"), rest = rows.at(-1);
		expect(penup.reserve, `the margin stroke holds no room left of the page at pen-up (pen-up ${JSON.stringify(penup)})`).toBe(0);
		expect(Math.abs(penup.leftEdgePx - penmove.leftEdgePx), "the pen-up frame holds the screen still").toBeLessThanOrEqual(0.5);
		// The page's own place is the painted edge less the ease's offset; only the ease may move the painted edge.
		const place = (r: any) => r.leftEdgePx - (r.bounce?.x ?? 0);
		const after = rows.slice(rows.indexOf(penup) + 1).filter(r => r.phase.startsWith("m-post-"));
		const worst = after.reduce((w, r) => (Math.abs(place(r) - place(penup)) > Math.abs(place(w) - place(penup)) ? r : w), after[0]);
		expect(Math.abs(place(worst) - place(penup)), `no frame after pen-up moves the page beyond the ease (worst ${JSON.stringify(worst)})`).toBeLessThanOrEqual(0.5);
		expect(rest.bounce.active, "the ease finished by the time the page is read at rest").toBe(false);
		// No room left of the page: the ease reveals nothing the band lacks, so the lift moves no band, as for the page stroke.
		const easing = rows.slice(rows.indexOf(penmove)).filter(r => r === penmove || r.bounce?.active);
		const moves = easing.filter((r, i) => i > 0 && JSON.stringify(r.band) !== JSON.stringify(easing[i - 1].band));
		expect(moves.length, `the band does not move while the ease plays (moves ${JSON.stringify(moves.map(r => [r.phase, r.band]))})`).toBe(0);
		expect(rest.bounceSyncs - penmove.bounceSyncs, "no band sync moves the band while the ease plays").toBe(0);
		// The rest is the page's normal edge, the same rest as the page stroke above: the page slides back to its edge and
		// the margin stroke rests off-screen left of the pane.
		expect(rest.reserve, "no room is held left of the page at rest").toBe(0);
		expect(Math.abs(rest.leftEdgePx), "at rest the painted edge is back at the page's normal edge, 0").toBeLessThanOrEqual(0.5);
		// The pen-up reading: the first row from pen-up on whose committed canvas holds the stroke (committed, not wet).
		const upRow = rows.slice(rows.indexOf(penup)).find(r => r.ink?.n > 0), ink = rest.ink;
		expect(upRow, "premise: the stroke reaches the committed canvas after pen-up").toBeTruthy();
		// While it slides: the stroke is not painted on any frame of the ease. The band holds nothing left of scroll zero
		// and no room is held left of the page, so from the first frame read after pen-up the stroke's place is outside
		// the band. This is the accepted behaviour for a margin stroke written during the glide; a later change that
		// paints it while it slides flips this line on purpose.
		const sliding = rows.slice(rows.indexOf(upRow) + 1).filter(r => r.bounce?.active && r.ink && r.phase.startsWith("m-post-"));
		expect(sliding.length, "premise: the ease was read two frames in").toBeGreaterThan(0);
		const painted = sliding.filter(r => r.ink.n > 0);
		expect(painted.map(r => r.phase), `accepted: the margin stroke is not painted while the page slides back (${JSON.stringify(painted.map(r => r.ink))})`).toEqual([]);
		// At rest it is off the pane to the left, and nothing of it shows: off the committed canvas, or wholly left of the pane.
		expect(ink.n === 0 || ink.right <= ink.pane.left, `the margin stroke rests off-screen, wholly left of the pane (${JSON.stringify(ink)})`).toBe(true);
	}, 60_000);

	// WHAT A MARGIN LIFT COSTS IN REPAINTS, against a page lift in the same run. Three of each, paired, on fresh pages;
	// the median of the pairwise difference. At pen-up the margin lift may repaint twice more than the page lift (the
	// committed layer following the new room, and the band widened for the ease); by rest at most once more again (the
	// band narrowed when the ease ends).
	it(`${arm}: a margin lift repaints at most twice more than a page lift at pen-up, and at most once more by rest`, async () => {
		const runs: { page: any; margin: any }[] = [];
		const counts = (rows: any[]) => {
			const penmove = rows.find(r => r.phase.endsWith("-penmove")), penup = rows.find(r => r.phase.endsWith("-penup")), rest = rows.at(-1);
			return { penup: penup.repaints - penmove.repaints, rest: rest.repaints - penmove.repaints };
		};
		for (let i = 0; i < 3; i++) {
			const run: any = {};
			for (const where of ["page", "margin"] as const) {
				await withPage(arm, async p => {
					await call(p, "mount", where[0] + "c" + i);
					run[where] = counts(await call(p, "pinchOutThenPenStroke", 0.10, 0.6, where[0], where) as any[]);
				});
			}
			runs.push(run);
		}
		record.push({ arm, repaintRuns: runs });
		const median = (v: number[]) => [...v].sort((a, b) => a - b)[1]!;
		const atPenup = median(runs.map(r => r.margin.penup - r.page.penup));
		const atRest = median(runs.map(r => r.margin.rest - r.page.rest));
		expect(atPenup, `median extra repaints at pen-up, margin less page (${JSON.stringify(runs)})`).toBeLessThanOrEqual(2);
		expect(atRest - atPenup, `median extra repaints from pen-up to rest, margin less page (${JSON.stringify(runs)})`).toBeLessThanOrEqual(1);
	}, 120_000);
}
