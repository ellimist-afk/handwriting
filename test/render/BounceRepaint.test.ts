/**
 * A BOUNCE OFF THE PAGE'S EDGE REPAINTS THE COMMITTED INK ONCE, NOT ONCE PER FRAME.
 *
 * What it looks like: with Infinite Canvas on, flick the page right into its own left edge. It gives, then springs
 * back over half a second. On Orion (package-2dbfa6c0 and 1.4.22-armCE.2, two traces, ten left flings) seven of the
 * ten springs repainted every committed stroke on every frame, 22 to 25 repaints per bounce, and felt laggy; three
 * moved by transform alone.
 *
 * The suspect (unproven when this cell was written): the spring moves the page by a transform, but the x camera read
 * through the live DOM rects can float by a hair each frame; the exact compare at the end of syncCamera then queues
 * a "scroll" repaint, which a moved camera turns into a full re-raster, and the loop runs until the spring stops.
 *
 * THE CELL: one magenta stroke on line 6, device pixel ratio 2, Infinite Canvas on, 100% zoom (vault test 2 stores
 * no camera for Untitled 1). Arms: "alan", vault test 2's Untitled 1 text in Minimal 9.0.2 at base font 19, paper
 * lines, readable line length off; "alan-dom", the same with the column's parent a centring flex box, which sends the
 * x camera down the DOM path; "device", the alan arm with the host offsets of the Orion trace (the editor 77.5 css px
 * down, the pane 300 + 1/3 px from the left), fling only; "rig", OverscrollBounce.test.ts's page (400 lines of monospace 16/24). Drives: "fling",
 * sixteen moves 16 ms apart into the edge and a lift at speed, as the device traces show; "pull", a slow pull and
 * release. Edges: left (the device case) and top. The committed layer's repaints are counted from the lift until the
 * spring has ended and four frames more. Each frame logs the x camera branch, the camera's raw difference from the
 * camera last painted, and the via of every repaint request.
 *
 * Premises, each asserted: the drag pulled, a spring played for at least ten frames, the page came home, the ink is
 * on the pane. Claims: at most one repaint from the lift to the spring's end; the ink rides the page on every sampled
 * spring frame (its centre keeps its natural offset from its text line within a pixel), so a needed repaint cannot
 * be skipped without this going red. Plant HW_BOUNCE_REPAINT_PLANT_EVERY_FRAME=1 queues a repaint on every spring
 * frame; the repaint claim must go red under it on every arm, or the counter cannot see the loop.
 *
 * Run: npx vitest run --config vitest.render.mts test/render/BounceRepaint.test.ts
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

declare const process: { env: Record<string, string | undefined> };

/** Minimal 9.0.2's theme.css, verbatim (the fixture MinimalCameraScale.test.ts loads): vault test 2's theme. */
const MINIMAL_CSS = readFileSync(fileURLToPath(new URL("./fixtures/minimal-9.0.2-theme.css", import.meta.url)), "utf8");

const PAGE = `
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { inlineInk, inkOverlayExtension, overlayForPath, setScrollExpansionEnabled, setInlineTool, setInkSizeMult } from "../../src/inline/InkOverlay";
import { setInkColorHex } from "../../src/ink/InkColor";
import { setPenInk } from "../../src/inline/PenInk";
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
const PANE_W = 1397.5, PANE_H = 800, HOST_LEFT = 300, TEXT_LINE = 6;
let rig = null;

function installSizer(view) {
	const sizer = document.createElement("div"); sizer.className = "cm-sizer";
	const container = document.createElement("div"); container.className = "cm-contentContainer";
	view.contentDOM.parentElement.insertBefore(sizer, view.contentDOM); sizer.appendChild(container); container.appendChild(view.contentDOM);
	void view.scrollDOM.clientWidth; return sizer;
}
const lineEl = view => view.contentDOM.querySelectorAll(".cm-line")[TEXT_LINE];
const textBox = view => { const range = document.createRange(); range.selectNodeContents(lineEl(view)); const r = range.getBoundingClientRect(); return { left: r.left, cy: (r.top + r.bottom) / 2 }; };
const MAGENTA = (d, i) => d[i + 3] > 200 && d[i] > 200 && d[i + 1] < 60 && d[i + 2] > 200;

/** The magenta stroke's centre as painted, client px: the committed canvas's pixels through its on-screen box. */
function inkCentre() {
	const cc = rig.overlay.committedCanvas, w = cc.width, h = cc.height;
	if (!(w > 0 && h > 0)) return null;
	const d = cc.getContext("2d").getImageData(0, 0, w, h).data;
	let minY = Infinity, maxY = -1, minX = Infinity, maxX = -1, n = 0;
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { if (MAGENTA(d, (y * w + x) * 4)) { n++; if (y < minY) minY = y; if (y > maxY) maxY = y; if (x < minX) minX = x; if (x > maxX) maxX = x; } }
	if (!n) return { n };
	const r = cc.getBoundingClientRect();
	return { n, cx: r.left + ((minX + maxX + 1) / 2) * r.width / w, cy: r.top + ((minY + maxY + 1) / 2) * r.height / h };
}
/** The stroke's offset from its text line, client px: zero drift means the ink rode the page. */
function inkOnText() {
	const ink = inkCentre(), t = textBox(rig.view);
	return ink && ink.n ? { n: ink.n, dx: ink.cx - t.left, dy: ink.cy - t.cy } : { n: ink ? ink.n : 0 };
}

window.bounceRepaint = {
	async mount(tag, arm) {
		setPenInk(true); setScrollExpansionEnabled(true);
		setInlineTool("pen"); setInkColorHex("pen", "#ff00ff"); setInkSizeMult("pen", 4);
		const path = "bounce-repaint-" + tag + ".md";
		const pane = document.body.appendChild(document.createElement("div"));
		pane.className = "markdown-source-view mod-cm6";
		// "device": the host offsets read from the Orion trace's layer bounds at dpr 2 - the title bar (78 device px) and
		// the view header (77) put the editor 77.5 css px down, and Obsidian's flex columns leave the pane a third of a
		// px off an integer on the left. Integer and half-px offsets cancel exactly in doubles; thirds need not.
		const hostLeft = arm === "device" ? HOST_LEFT + 1 / 3 : HOST_LEFT, hostTop = arm === "device" ? 77.5 : 0;
		pane.style.cssText = "position:relative;margin-left:" + hostLeft + "px;margin-top:" + hostTop + "px;width:" + PANE_W + "px;height:" + PANE_H + "px;overflow:hidden";
		// "rig": OverscrollBounce's page, 400 lines of monospace 16/24. "alan": vault test 2's Untitled 1 as read from
		// disk (a dozen short lines with a code fence, paper lines, the canvas on), in Minimal 9.0.2 at base font 19,
		// readable line length off: a page shorter than the pane.
		const FENCE = String.fromCharCode(96).repeat(3);
		const alan = arm === "alan" || arm === "alan-dom" || arm === "device";
		const doc = alan
			? [FENCE + FENCE, FENCE + "7", "", "", "", "", "line " + TEXT_LINE + " alpha beta gamma", "", "", "", ""].join("\\n")
			: Array.from({ length: 400 }, (_, i) => "line " + i + " alpha beta gamma delta epsilon zeta").join("\\n");
		if (alan) document.body.classList.add("handwriting-paper-lines");
		const content = alan ? {} : { fontFamily: "monospace", fontSize: "16px", lineHeight: "24px" };
		const view = new EditorView({ parent: pane, state: EditorState.create({ doc, extensions: [history(), EditorView.lineWrapping,
			editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} })), inkOverlayExtension(),
			EditorView.theme({ "&": { width: PANE_W + "px", height: PANE_H + "px" }, ".cm-scroller": { overflowY: "auto", overflowX: "hidden" }, ".cm-content": content })] }) });
		const sizer = installSizer(view);
		// "alan-dom": the same page with the column's parent a centring flex box, which ownedColumnLayoutLeft refuses
		// (a justify-content it does not model), so the x camera takes the live DOM rect path.
		// The column keeps its full width, so only the branch changes, not where the text sits.
		if (arm === "alan-dom") { const c = sizer.firstElementChild; c.style.display = "flex"; c.style.flexDirection = "row"; c.style.justifyContent = "center"; view.contentDOM.style.width = "100%"; }
		await settle(12);
		const overlay = overlayForPath(path);
		if (!overlay) throw new Error("no overlay for " + path);
		rig = { pane, view, overlay, repaints: 0, vias: [] };
		const t = textBox(view), x = t.left + 80, y = t.cy;
		const pen = (type, px, py, buttons) => document.elementFromPoint(px, py)?.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "pen", pointerId: 901, isPrimary: true, clientX: px, clientY: py, buttons, pressure: buttons ? 0.5 : 0 }));
		pen("pointerdown", x, y, 1); for (let i = 1; i <= 6; i++) pen("pointermove", x + 30 * i, y, 1); pen("pointerup", x + 180, y, 0);
		await settle(12);
		// Counts the committed layer's repaints, so the cell can say how many a spring costs.
		const repaint = overlay.repaint.bind(overlay);
		overlay.repaint = () => { rig.repaints++; repaint(); };
		// And who asked: every scheduleRepaint call's via, drained by each frame's reading.
		const schedule = overlay.scheduleRepaint.bind(overlay);
		overlay.scheduleRepaint = (via) => { rig.vias.push(via === undefined ? "other" : via); schedule(via); };
		return { strokes: inlineInk.strokes(path).length, natural: inkOnText() };
	},
	/**
	 * One finger against the edge on the axis, lift, then read every frame until the spring ends plus four.
	 * "pull": 250 px in thirteen moves in one frame, a slow pull and release. "fling": sixteen moves 16 ms apart, 30 px
	 * each (256 ms), lifted at speed: the traced device bounces were left flings of 13 to 21 moves over 150 to 260 ms,
	 * lifted with the page 96 css px past its left rest (the two device traces).
	 */
	async pullAndRelease(axis, mode) {
		const { view, overlay } = rig, router = overlay.router, sd = view.scrollDOM;
		setPenInk(false);
		// Both edges from the top of the page, so the stroke on line 6 stays on the pane.
		sd.scrollTop = 0; sd.scrollLeft = 0;
		await settle(8);
		// The assist guard re-arms a second after the last lift, on a real timer (OverscrollBounce.test.ts, giveRegrab).
		await new Promise(res => setTimeout(res, 1200));
		await settle(4);
		const r = sd.getBoundingClientRect(), x0 = r.left + r.width / 2, y0 = r.top + r.height / 2;
		const ev = (type, px, py, buttons) => ({ type, pointerType: "touch", pointerId: 951, isPrimary: true,
			clientX: px, clientY: py, pressure: buttons === 0 ? 0 : 0.5, buttons, button: 0,
			timeStamp: performance.now(), tiltX: 0, tiltY: 0, width: 0, height: 0,
			target: sd, preventDefault() {}, stopPropagation() {} });
		const finger = (type, px, py, buttons) => {
			const e = ev(type, px, py, buttons);
			if (type === "pointerdown") router.pointerDown(e);
			else if (type === "pointermove") router.pointerMove(e);
			else router.pointerUpOrCancel(e);
		};
		const at = d => axis === "y" ? [x0, y0 + d] : [x0 + d, y0];
		const read = () => { const b = overlay.overscrollBounceReadout(); return { active: b.active,
			offset: axis === "y" ? b.y : b.x, total: axis === "y" ? b.restY + b.y : b.restX + b.x,
			fling: router.flingRaf !== 0, camY: overlay.camera.y, camX: overlay.camera.x, repaints: rig.repaints,
			// Which y source the camera took: the rung ladder (a number) or the document top (NaN, the ladder unused).
			anchorYLayout: overlay.anchorCameraYLayout,
			// Which x camera branch syncCamera takes: the owned column's layout left, or the live DOM rects (null there).
			// "unknown" when the overlay holds no origin line to ask with, so the readout cannot claim a branch it did not read.
			xPath: !overlay.originLine ? "unknown" : overlay.ownedColumnLayoutLeft(overlay.originLine) === null ? "dom" : "owned",
			// The exact compare at the end of syncCamera, as raw doubles: camera minus the camera last painted.
			dCamX: overlay.lastPaintCam ? overlay.camera.x - overlay.lastPaintCam.x : null,
			dCamY: overlay.lastPaintCam ? overlay.camera.y - overlay.lastPaintCam.y : null,
			vias: rig.vias.splice(0) }; };
		finger("pointerdown", ...at(0), 1);
		if (mode === "fling") {
			for (let i = 1; i <= 16; i++) { await new Promise(res => setTimeout(res, 16)); finger("pointermove", ...at(30 * i), 1); }
		} else {
			finger("pointermove", ...at(10), 1);
			for (let i = 1; i <= 12; i++) finger("pointermove", ...at(10 + 20 * i), 1);
			await rendered();
		}
		rig.vias.length = 0;
		const held = { ...read(), pull: axis === "y" ? router.overscrollPullY : router.overscrollPullX, engaged: !!router.assistEngaged };
		const atLift = rig.repaints;
		finger("pointerup", ...at(mode === "fling" ? 480 : 250), 0);
		const frames = [];
		let springFrames = 0, ended = -1;
		for (let j = 0; j < 120; j++) {
			await rendered();
			const f = read();
			if (f.active) springFrames++;
			// Every fourth spring frame, where the stroke is on the pane: does the ink still sit on its text line?
			if (f.active && springFrames % 4 === 0) f.ink = inkOnText();
			frames.push(f);
			if (springFrames > 0 && !f.active && !f.fling) { ended = j; break; }
		}
		await settle(4);
		const rest = { ...read(), ink: inkOnText() };
		return { axis, held, springFrames, ended, repaintsAfterLift: rest.repaints - atLift, rest, frames };
	},
	/**
	 * A real scroll while a left-edge spring plays: the text moves under a live bounce, and the committed ink must be
	 * repainted for it. Pull and release at the left edge, then five spring frames in, scroll the note down 48 px.
	 */
	async scrollMidBounce() {
		const { view, overlay } = rig, router = overlay.router, sd = view.scrollDOM;
		setPenInk(false);
		sd.scrollTop = 0; sd.scrollLeft = 0;
		await settle(8);
		await new Promise(res => setTimeout(res, 1200));
		await settle(4);
		const r = sd.getBoundingClientRect(), x0 = r.left + r.width / 2, y0 = r.top + r.height / 2;
		const finger = (type, px, buttons) => {
			const e = { type, pointerType: "touch", pointerId: 952, isPrimary: true, clientX: px, clientY: y0,
				pressure: buttons === 0 ? 0 : 0.5, buttons, button: 0, timeStamp: performance.now(), tiltX: 0, tiltY: 0,
				width: 0, height: 0, target: sd, preventDefault() {}, stopPropagation() {} };
			if (type === "pointerdown") router.pointerDown(e); else if (type === "pointermove") router.pointerMove(e); else router.pointerUpOrCancel(e);
		};
		finger("pointerdown", x0, 1);
		for (let i = 1; i <= 13; i++) finger("pointermove", x0 + 10 + 20 * (i - 1), 1);
		await rendered();
		finger("pointerup", x0 + 250, 0);
		let live = 0;
		for (let j = 0; j < 40 && live < 5; j++) { await rendered(); if (overlay.overscrollBounceReadout().active) live++; }
		const before = rig.repaints, scrollTop0 = sd.scrollTop;
		sd.scrollTop = scrollTop0 + 48;
		for (let j = 0; j < 3; j++) await rendered();
		const during = { active: overlay.overscrollBounceReadout().active, scrolled: sd.scrollTop - scrollTop0, repaints: rig.repaints - before };
		for (let j = 0; j < 60 && overlay.overscrollBounceReadout().active; j++) await rendered();
		await settle(4);
		return { live, during, rest: { active: overlay.overscrollBounceReadout().active, ink: inkOnText() } };
	},
};
`;

let browser: Browser, script: string;
const record: unknown[] = [];

/**
 * The instrument's plant: every bounce frame queues a repaint, which is the loop this cell exists to catch. With it,
 * both edges must go red on the repaint count; if they stay green the counter cannot see the loop.
 */
const PLANTS = [
	{ env: "HW_BOUNCE_REPAINT_PLANT_EVERY_FRAME",
		from: "\t\t\tthis.writeViewportPan();\n\t\t\t// The page is at its rest: a preview paper that rode the bounce comes down on this frame.\n",
		to: "\t\t\tthis.writeViewportPan();\n\t\t\tthis.scheduleRepaint(\"scroll\");\n\t\t\t// The page is at its rest: a preview paper that rode the bounce comes down on this frame.\n" },
];

beforeAll(async () => {
	const active = PLANTS.filter(pl => process.env[pl.env]);
	let planted = 0;
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "bounceRepaintPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
		plugins: active.length ? [{ name: "bounce-repaint-plants", setup(builder) {
			builder.onLoad({ filter: /src[\\/]inline[\\/]InkOverlay\.ts$/ }, args => {
				let text = readFileSync(args.path, "utf8").replace(/\r\n/g, "\n");
				for (const pl of active) {
					if (text.split(pl.from).length !== 2) throw new Error(`${pl.env}: anchor not found once`);
					text = text.replace(pl.from, pl.to);
					planted++;
				}
				return { loader: "ts", contents: text };
			});
		} }] : [] });
	if (planted !== active.length) throw new Error(`plants requested ${active.length}, applied ${planted}`);
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);
afterAll(async () => {
	await browser?.close();
	if (process.env.HW_BOUNCE_REPAINT_OUT) writeFileSync(process.env.HW_BOUNCE_REPAINT_OUT, JSON.stringify(record, null, 1));
});

const call = (p: Page, method: string, ...args: unknown[]) => p.evaluate(([m, a]) => (window as any).bounceRepaint[m](...a), [method, args] as const);
async function open(tag: string, arm: string) {
	const page = await browser.newPage({ viewport: { width: 1800, height: 900 }, deviceScaleFactor: 2, hasTouch: true });
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	await page.setContent(arm !== "rig"
		? '<!doctype html><body class="theme-dark" style="margin:0; --font-text-size:19px; --background-modifier-border:#777777"></body>'
		: '<!doctype html><body style="margin:0"></body>');
	await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
	if (arm !== "rig") await page.addStyleTag({ content: MINIMAL_CSS });
	await page.addScriptTag({ content: script });
	const mounted = await call(page, "mount", tag, arm) as any;
	return { page, errors, mounted };
}

it("alan: a real scroll during a left-edge spring still repaints the committed ink, and the ink stays on its line", async () => {
	const { page, errors, mounted } = await open("scroll-mid-bounce", "alan");
	try {
		const r = await call(page, "scrollMidBounce") as any;
		record.push({ cell: "scroll-mid-bounce", mounted, ...r });
		const brief = JSON.stringify(r);
		expect(errors).toEqual([]);
		expect(r.live, `premise: the spring was playing when the scroll came (${brief})`).toBe(5);
		expect(r.during.scrolled, `premise: the note scrolled (${brief})`).toBeGreaterThan(0);
		expect(r.during.repaints, `the scroll during the spring was not repainted (${brief})`).toBeGreaterThanOrEqual(1);
		expect(r.rest.active, `premise: the spring ended (${brief})`).toBe(false);
		expect(r.rest.ink.n, `the stroke is painted at rest (${brief})`).toBeGreaterThan(0);
		expect(Math.abs(r.rest.ink.dx - mounted.natural.dx), `the ink kept its place on its line, x (${brief})`).toBeLessThanOrEqual(1);
		expect(Math.abs(r.rest.ink.dy - mounted.natural.dy), `the ink kept its place on its line, y (${brief})`).toBeLessThanOrEqual(1);
	} finally { await page.close(); }
}, 240_000);

const EDGES = [{ axis: "x", name: "LEFT" }, { axis: "y", name: "TOP" }] as const;
const ARMS = ["alan", "alan-dom", "device", "rig"] as const;
for (const mode of ["fling", "pull"] as const) for (const arm of ARMS) for (const edge of EDGES) {
	// The device arm is a fling arm only: the last rig arm tried before the device's scroll probe.
	if (arm === "device" && mode !== "fling") continue;
	it(`${mode}, ${arm}: ${edge.name}: a spring off the page's own edge repaints the committed ink at most once, and the ink rides the page`, async () => {
		const { page, errors, mounted } = await open(mode + "-" + arm + "-" + edge.axis, arm);
		try {
			const r = await call(page, "pullAndRelease", edge.axis, mode) as any;
			record.push({ mode, arm, edge: edge.axis, mounted, ...r });
			const brief = JSON.stringify({ held: r.held, springFrames: r.springFrames, ended: r.ended, repaintsAfterLift: r.repaintsAfterLift, rest: r.rest,
				cam: r.frames.map((f: any) => [f.repaints, f.xPath, f.dCamX, f.dCamY, f.vias.join("+")]), ink: r.frames.filter((f: any) => f.ink).map((f: any) => f.ink) });
			expect(errors).toEqual([]);
			// PREMISES: one stroke on the page and on the pane; the drag pulled against the edge; a spring played and ended; the page came home.
			expect(mounted.strokes, `premise: one stroke (${brief})`).toBe(1);
			expect(mounted.natural.n, `premise: the stroke is painted (${brief})`).toBeGreaterThan(0);
			expect(r.held.engaged, `premise: the assist carried the drag (${brief})`).toBe(true);
			expect(Math.abs(r.held.pull), `premise: the drag pulled against the edge (${brief})`).toBeGreaterThan(10);
			expect(r.springFrames, `premise: the spring played at least ten frames (${brief})`).toBeGreaterThanOrEqual(10);
			expect(r.ended, `premise: the spring ended (${brief})`).toBeGreaterThanOrEqual(0);
			expect(Math.abs(r.rest.total), `premise: the page came home (${brief})`).toBeLessThanOrEqual(0.5);
			// THE INK RIDES THE PAGE on every sampled spring frame and at rest: the stroke's centre keeps its natural
			// offset from its text line, within a pixel.
			const sampled = r.frames.filter((f: any) => f.ink);
			expect(sampled.length, `premise: spring frames were sampled for ink (${brief})`).toBeGreaterThanOrEqual(2);
			for (const f of [...sampled, r.rest]) {
				expect(f.ink.n, `the stroke is painted on a spring frame (${brief})`).toBeGreaterThan(0);
				expect(Math.abs(f.ink.dx - mounted.natural.dx), `the ink kept its place on its line, x (${brief})`).toBeLessThanOrEqual(1);
				expect(Math.abs(f.ink.dy - mounted.natural.dy), `the ink kept its place on its line, y (${brief})`).toBeLessThanOrEqual(1);
			}
			// THE CLAIM: from the lift to four frames after the spring ends, the committed layer repaints at most once
			// (the bounce end). The device read 22 to 25 per left bounce, one per frame.
			expect(r.repaintsAfterLift, `repaints from the lift to the spring's end (${brief})`).toBeLessThanOrEqual(1);
		} finally { await page.close(); }
	}, 240_000);
}
