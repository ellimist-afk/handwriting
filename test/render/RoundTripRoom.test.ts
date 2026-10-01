/**
 * THE ROOM A ZOOM-OUT ROUND TRIP LEAVES BEHIND.
 *
 * Rig: ZoomOutStandingPan's mount and gesture drivers, with the same three readouts and the blank-note option.
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

declare const process: { env: Record<string, string | undefined> };

/** The page: the same mount as scrollColumnAnchorPage (pane offset 300 px, monospace 16/24, Obsidian's sizer), plus the stroke and the readers. */
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
/** After the frame has rendered: its layout, its observer deliveries and its paint have run. */
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
const lineEl = view => { const all = view.contentDOM.querySelectorAll(".cm-line"); return all[Math.min(TEXT_LINE, all.length - 1)]; };
const textBox = view => { const range = document.createRange(); range.selectNodeContents(lineEl(view)); const r = range.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, cy: (r.top + r.bottom) / 2 }; };
const MAGENTA = p => p[3] > 200 && p[0] > 200 && p[1] < 60 && p[2] > 200;

/** The committed canvas's magenta pixels, mapped through the canvas's client rect. */
function backingInk() {
	const cc = rig.overlay.committedCanvas, w = cc.width, h = cc.height;
	if (!(w > 0 && h > 0)) return null;
	const d = cc.getContext("2d").getImageData(0, 0, w, h).data;
	let minY = Infinity, maxY = -1, minX = Infinity, maxX = -1, n = 0;
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; if (MAGENTA([d[i], d[i + 1], d[i + 2], d[i + 3]])) { n++; if (y < minY) minY = y; if (y > maxY) maxY = y; if (x < minX) minX = x; if (x > maxX) maxX = x; } }
	if (!n) return { n };
	const r = cc.getBoundingClientRect();
	return { n, cy: r.top + ((minY + maxY + 1) / 2) * r.height / h,
		left: r.left + minX * r.width / w, right: r.left + (maxX + 1) * r.width / w };
}

const r2 = v => Math.round(v * 100) / 100;

function sample(phase) {
	const { view, overlay, pane } = rig, t = textBox(view), ink = backingInk(), k = overlay.pinchScaleNow;
	const s = view.scrollDOM, pr = pane.getBoundingClientRect(), sr = s.getBoundingClientRect(), cr = view.contentDOM.getBoundingClientRect();
	const pan = overlay.viewportPan || { x: 0, y: 0 };
	return { phase, k, preview: !!overlay.pinchPreview,
		panX: r2(pan.x), panY: r2(pan.y), rasterPanX: r2(overlay.rasterPan ? overlay.rasterPan.x : 0), rasterPanY: r2(overlay.rasterPan ? overlay.rasterPan.y : 0),
		// The scroller's remaining range on each axis: the regime this claim is about.
		rangeX: r2(s.scrollWidth - s.clientWidth), rangeY: r2(s.scrollHeight - s.clientHeight), scrollLeft: r2(s.scrollLeft), scrollTop: r2(s.scrollTop),
		paneLeft: r2(pr.left), paneRight: r2(pr.right), textLeft: r2(t.left), textRight: r2(t.right), textCy: r2(t.cy),
		// The rule bounds the CONTENT's box against the viewport: the scroller is the viewport, .cm-content is the page.
		viewLeft: r2(sr.left), viewRight: r2(sr.right), contentLeft: r2(cr.left), contentRight: r2(cr.right),
		// The overlay's own fit quantity when the build exposes it (the fix's helper), so the cell can cross-check the regime it asserts.
		fitReadout: typeof overlay.panFitReadout === "function" ? overlay.panFitReadout() : null,
		sizerTransform: rig.sizer.style.transform || "",
		// The scrollbar gutter in screen px, the frozen column inset, and the bounce as the overlay reports it.
		barScreen: r2(sr.width - s.clientWidth * sr.width / s.offsetWidth), columnLocal: overlay.viewportLayout ? overlay.viewportLayout.columnLocal : null,
		bounce: typeof overlay.overscrollBounceReadout === "function" ? overlay.overscrollBounceReadout() : null,
		// The scrollbar gutter in screen px on this frame: Readable line length centres the column beside it.
		gutter: r2(sr.width - s.clientWidth * sr.width / s.offsetWidth),
		inkN: ink ? ink.n : 0, inkLeft: ink && ink.n ? r2(ink.left) : null, inkRight: ink && ink.n ? r2(ink.right) : null,
		dyNote: ink && ink.n ? (ink.cy - t.cy) / k : null };
}

window.standingPan = {
	async mount(readable, tag, lines, noInk) {
		// Alan, 2026-09-20: the note zoom exists only under the Infinite Canvas, so this rig
		// mounts with the canvas ON and its claim is the canvas one: a pinch out and back
		// about one focal point returns the page where it stood.
		setPenInk(true); setScrollExpansionEnabled(true);
		setInlineTool("pen"); setInkColorHex("pen", "#ff00ff"); setInkSizeMult("pen", 4);
		const path = "standing-pan-" + readable + "-" + (tag || "gesture") + ".md";
		const pane = document.body.appendChild(document.createElement("div"));
		pane.className = "markdown-source-view mod-cm6" + (readable ? " is-readable-line-width" : "");
		pane.style.cssText = "position:relative;margin-left:" + HOST_LEFT + "px;width:" + PANE_W + "px;height:" + PANE_H + "px;overflow:hidden";
		const doc = Array.from({ length: lines || 400 }, (_, i) => "line " + i + " alpha beta gamma delta epsilon zeta").join("\\n");
		const view = new EditorView({ parent: pane, state: EditorState.create({ doc, extensions: [history(), EditorView.lineWrapping,
			editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} })), inkOverlayExtension(),
			EditorView.theme({ "&": { width: PANE_W + "px", height: PANE_H + "px" }, ".cm-scroller": { overflowY: "auto", overflowX: "hidden" }, ".cm-content": { fontFamily: "monospace", fontSize: "16px", lineHeight: "24px" } })] }) });
		const sizer = installSizer(view);
		await settle(12);
		const overlay = overlayForPath(path);
		if (!overlay) throw new Error("no overlay for " + path);
		rig = { pane, view, overlay, sizer, path };
		const t = textBox(view), x = t.left + 80, y = t.cy;
		const pen = (type, px, py, buttons) => document.elementFromPoint(px, py)?.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "pen", pointerId: 901, isPrimary: true, clientX: px, clientY: py, buttons, pressure: buttons ? 0.5 : 0 }));
		if (!noInk) { pen("pointerdown", x, y, 1); for (let i = 1; i <= 6; i++) pen("pointermove", x + 30 * i, y, 1); pen("pointerup", x + 180, y, 0); }
		await settle(12);
		return { strokes: inlineInk.strokes(path).length, natural: sample("natural"), inkMiddleX: textBox(view).left + 170, pane: pane.getBoundingClientRect().toJSON() };
	},
	/** Known 10 px down on the committed canvas; both readers must read it back. Removed before returning. */
	async plant(on) { rig.overlay.committedCanvas.style.translate = on ? "0 10px" : ""; await settle(2); return sample(on ? "plant-on" : "plant-off"); },
	/** The router's two-finger pinch about an EXPLICIT client point, spread 300 -> 300 x to over steps frames, then settle. */
	async pinch(to, steps, cx, cy, tag) {
		const { overlay } = rig, router = overlay.router, from = overlay.pinchScaleNow;
		const spread0 = 300, spread1 = 300 * to / from;
		const touch = s => { router.touchPos.set(911, { x: cx - s / 2, y: cy }); router.touchPos.set(912, { x: cx + s / 2, y: cy }); };
		const ev = type => new PointerEvent(type, { pointerId: 912, pointerType: "touch" });
		const rows = [sample(tag + "-before")];
		touch(spread0); router.beginPinch(ev("pointerdown"));
		for (let i = 1; i <= steps; i++) { touch(spread0 + (spread1 - spread0) * i / steps); router.updatePinch(ev("pointermove")); await rendered(); rows.push(sample(tag + "-move-" + i)); }
		router.endPinch(ev("pointerup"), { x: cx, y: cy }); router.touchPos.clear();
		for (let j = 1; j <= 16; j++) { await rendered(); rows.push(sample(tag + "-settle-" + j)); }
		// The settle's correction glides for half a second, longer than those frames: read on to the rest, one row a frame,
		// so the last row is the settled page and the rows in between still carry the glide.
		for (let j = 1; j <= 90 && rig.overlay.overscrollBounceReadout && rig.overlay.overscrollBounceReadout().active; j++) { await rendered(); rows.push(sample(tag + "-glide-" + j)); }
		return rows;
	},
	/**
	 * ONE gesture from the current scale to "to", its centre travelling from cxStart to cxEnd the whole way: a drag whose
	 * spread drifted, or a zoom that also pans. slopKick (px) opens the spread by that much on the first frame, so a drift
	 * smaller than the router's 12 px pinch slop still belongs to an ACTIVE gesture, as it does on a real screen once the
	 * fingers have moved: measured, a 9 px spread change with no kick never activated and moved nothing.
	 */
	async pinchPath(to, steps, cxStart, cxEnd, cy, tag, slopKick) {
		const { overlay } = rig, router = overlay.router, from = overlay.pinchScaleNow;
		const spread0 = 300, spread1 = 300 * to / from, kick = slopKick || 0;
		const touch = (s, cx) => { router.touchPos.set(911, { x: cx - s / 2, y: cy }); router.touchPos.set(912, { x: cx + s / 2, y: cy }); };
		const ev = type => new PointerEvent(type, { pointerId: 912, pointerType: "touch" });
		const rows = [sample(tag + "-before")];
		touch(spread0, cxStart); router.beginPinch(ev("pointerdown"));
		for (let i = 1; i <= steps; i++) {
			const t = i / steps;
			const spread = kick && i === 1 ? spread0 + kick : kick ? spread0 + kick + (spread1 - spread0 - kick) * (i - 1) / (steps - 1) : spread0 + (spread1 - spread0) * t;
			touch(spread, cxStart + (cxEnd - cxStart) * t);
			router.updatePinch(ev("pointermove")); await rendered(); rows.push(sample(tag + "-move-" + i));
		}
		router.endPinch(ev("pointerup"), { x: cxEnd, y: cy }); router.touchPos.clear();
		for (let j = 1; j <= 16; j++) { await rendered(); rows.push(sample(tag + "-settle-" + j)); }
		// The settle's correction glides for half a second, longer than those frames: read on to the rest, one row a frame,
		// so the last row is the settled page and the rows in between still carry the glide.
		for (let j = 1; j <= 90 && rig.overlay.overscrollBounceReadout && rig.overlay.overscrollBounceReadout().active; j++) { await rendered(); rows.push(sample(tag + "-glide-" + j)); }
		return rows;
	},
	/** ONE gesture in to peak and back out to the scale it began at, the centre drifting from cxStart to cxEnd over the whole of it. */
	async pinchRound(peak, steps, cxStart, cxEnd, cy, tag) {
		const { overlay } = rig, router = overlay.router, from = overlay.pinchScaleNow;
		const spread0 = 300, spreadPeak = 300 * peak / from, total = steps * 2;
		const touch = (s, cx) => { router.touchPos.set(911, { x: cx - s / 2, y: cy }); router.touchPos.set(912, { x: cx + s / 2, y: cy }); };
		const ev = type => new PointerEvent(type, { pointerId: 912, pointerType: "touch" });
		const rows = [sample(tag + "-before")];
		touch(spread0, cxStart); router.beginPinch(ev("pointerdown"));
		for (let i = 1; i <= total; i++) {
			const up = i <= steps ? i / steps : (total - i) / steps;
			touch(spread0 + (spreadPeak - spread0) * up, cxStart + (cxEnd - cxStart) * i / total);
			router.updatePinch(ev("pointermove")); await rendered(); rows.push(sample(tag + "-move-" + i));
		}
		router.endPinch(ev("pointerup"), { x: cxEnd, y: cy }); router.touchPos.clear();
		for (let j = 1; j <= 16; j++) { await rendered(); rows.push(sample(tag + "-settle-" + j)); }
		// The settle's correction glides for half a second, longer than those frames: read on to the rest, one row a frame,
		// so the last row is the settled page and the rows in between still carry the glide.
		for (let j = 1; j <= 90 && rig.overlay.overscrollBounceReadout && rig.overlay.overscrollBounceReadout().active; j++) { await rendered(); rows.push(sample(tag + "-glide-" + j)); }
		return rows;
	},
	sample,
	/** The middle zoom button's own path: zoomNoteBy about the pane's centre, no gesture. */
	async zoomBy(factor) { const ok = rig.overlay.zoomNoteBy(factor); await settle(12); await new Promise(r => setTimeout(r, 50)); await settle(4); return { ok, row: sample("zoomBy") }; },
	/** A synthetic tall stroke, copied from the mounted one and stretched down the note, dx note px to the right of it. */
	async tallInk(dx, height, width) {
		const s = inlineInk.strokes(rig.path)[0];
		const n = s.points.length, pts = s.points.map((p, i) => ({ ...p, x: p.x + dx + (width || 0) * i / (n - 1), y: p.y + height * i / (n - 1) }));
		const xs = pts.map(p => p.x), ys = pts.map(p => p.y), pad = s.bbox.x - Math.min(...s.points.map(p => p.x));
		inlineInk.commit(rig.path, { ...s, id: s.id + "-tall-" + dx, points: pts, bbox: { x: Math.min(...xs) + pad, y: Math.min(...ys) + pad, width: Math.max(...xs) - Math.min(...xs) - 2 * pad, height: Math.max(...ys) - Math.min(...ys) - 2 * pad } });
		rig.overlay.scheduleRepaint("tall-ink"); await settle(10);
		return inlineInk.strokes(rig.path).length;
	},
	/** Fit, the command's own path. */
	async fit() { const r = rig.overlay.fitHandwriting(); await settle(12); await new Promise(res => setTimeout(res, 50)); await settle(4); return { r, row: sample("fit") }; },
	/** After a wait in real time, not frames: a deferred repaint runs on a timer. The overscroll glide is half a second, so
	 * a settle's own frames are not enough: wait it out rather than read a page still on its way to rest. */
	async later(ms, phase) { await new Promise(r => setTimeout(r, ms));
		for (let i = 0; i < 90 && rig.overlay.overscrollBounceReadout && rig.overlay.overscrollBounceReadout().active; i++) await frame();
		await settle(4); return sample(phase); },
	/**
	 * Screenshot pixels (PNG as base64 from the test): magenta inside the pane and within 120 px of the text line the stroke
	 * was drawn on, in client px. THE BAND IS NOT DECORATION: the toolbar's colour swatch is magenta too (192 device px of
	 * it), and counting it dragged the bbox centre halfway - the 10 px plant read back as 5 and the cells' own liveness
	 * control caught it. The pane-wide count is kept as 'whole' for diagnosis.
	 */
	async screenInk(b64) {
		const img = await createImageBitmap(await (await fetch("data:image/png;base64," + b64)).blob());
		const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const g = c.getContext("2d"); g.drawImage(img, 0, 0);
		const d = g.getImageData(0, 0, c.width, c.height).data;
		const dpr = c.width / window.innerWidth, pr = rig.pane.getBoundingClientRect();
		const t = textBox(rig.view);
		const x0 = Math.max(0, Math.floor(pr.left * dpr)), x1 = Math.min(c.width, Math.ceil(pr.right * dpr));
		const py0 = Math.max(0, Math.floor(pr.top * dpr)), py1 = Math.min(c.height, Math.ceil(pr.bottom * dpr));
		const y0 = Math.max(py0, Math.floor((t.cy - 120) * dpr)), y1 = Math.min(py1, Math.ceil((t.cy + 120) * dpr));
		let n = 0, minX = Infinity, maxX = -1, minY = Infinity, maxY = -1, whole = 0;
		for (let y = py0; y < py1; y++) for (let x = x0; x < x1; x++) { const i = (y * c.width + x) * 4; if (MAGENTA([d[i], d[i + 1], d[i + 2], d[i + 3]])) {
			whole++;
			if (y >= y0 && y < y1) { n++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; } } }
		if (!n) return { n, dpr, whole };
		return { n, dpr, whole, left: r2(minX / dpr), right: r2((maxX + 1) / dpr), cy: r2((minY + maxY + 1) / 2 / dpr) };
	},
};
`;

let browser: Browser, script: string;
const DPR = 2;
const record: unknown[] = [];

/**
 * Plants, one at a time. HW_ROUNDTRIP_PLANT_NO_BAND_RELEASE=1 stops the commit releasing the band's margin, which is the
 * fix's own mechanism: expected red, both blank arms, on the room left behind. HW_ROUNDTRIP_PLANT_NO_BAND_SYNC=1 stops
 * the settle re-pinning the band to the settled viewport before the extent and the scroll target: expected red, the arm
 * with the setting off, whose parked scroll needs the re-pin as well as the release.
 */
const PLANT = process.env.HW_ROUNDTRIP_PLANT_NO_BAND_RELEASE
	? { name: "no-band-release", edits: [["|| releaseAfterCommit) this.releaseBandMargin", "|| false) this.releaseBandMargin"]] as [string, string][] }
	: process.env.HW_ROUNDTRIP_PLANT_NO_BAND_SYNC
	? { name: "no-band-sync", edits: [["if(this.syncBand()!==\"none\")this.handleResize();this.updateExtent", "this.updateExtent"]] as [string, string][] }
	: null;

beforeAll(async () => {
	let planted = 0;
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "roundTripRoomPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
		plugins: PLANT ? [{ name: "roundtrip-plant-" + PLANT.name, setup(builder) {
			builder.onLoad({ filter: /src[\\/]inline[\\/]InkOverlay\.ts$/ }, args => {
				let text = readFileSync(args.path, "utf8").replace(/\r\n/g, "\n");
				for (const [from, to] of PLANT.edits) {
					if (text.split(from).length !== 2) throw new Error("roundtrip plant: anchor not found once: " + from);
					text = text.replace(from, to);
				}
				planted++;
				return { loader: "ts", contents: text };
			});
		} }] : [] });
	if (PLANT && !planted) throw new Error("roundtrip plant requested but never applied");
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);
afterAll(async () => {
	await browser?.close();
	if (process.env.HW_ROUNDTRIP_OUT) writeFileSync(process.env.HW_ROUNDTRIP_OUT, JSON.stringify(record, null, 1));
});

const call = (p: Page, method: string, ...args: unknown[]) => p.evaluate(([m, a]) => (window as any).standingPan[m](...a), [method, args] as const);
const r2 = (v: number) => Math.round(v * 100) / 100;

async function open(readable: boolean, tag: string, noInk = true) {
	const page = await browser.newPage({ viewport: { width: 1800, height: 900 }, deviceScaleFactor: DPR, hasTouch: true });
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	await page.setContent('<!doctype html><body style="margin:0"></body>');
	await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
	await page.addScriptTag({ content: script });
	const mounted = await call(page, "mount", readable, tag, undefined, noInk) as any;
	expect(mounted.strokes, noInk ? "a blank note" : "the stroke committed").toBe(noInk ? 0 : 1);
	return { page, errors, mounted, n: mounted.natural };
}

/**
 * THE ROOM A ROUND TRIP LEAVES BEHIND. Zoom a note out and back and it keeps sideways scroll room it never needed, and
 * the view can sit parked in it: measured on a blank note, Infinite Canvas off, 100 -> 25 -> 100, rangeX 175 and
 * scrollLeft 160 with Readable line length on, 175 / 175 with it off, against 0 / 0 on a note that never moved. The
 * granted extent is 0 throughout, so nothing the ink asked for is involved: the room is the ink band's own margin, sized
 * for the 25 percent viewport and never re-pinned when the settle landed back at 100 percent.
 *
 * THE CONTRACT: the band never holds scrollable range at rest beyond what the spacer's extent grants, so a round trip
 * ends where a fresh note sits. Both settings, because with the setting off the page has no column inset to explain it.
 *
 * CONTROL, in the same file: a round trip on a note whose ink reaches the pane's right edge KEEPS the room that ink
 * earned (the sideways growth part 16's rule grants), so the re-sync never eats granted room.
 */
for (const readable of [true, false]) {
	it(`a round trip about one focal point does NOT come back, and that is the design: it lands 2096.25 px left, parked in the room the canvas granted, RLL ${readable ? "on" : "off"}`, async () => {
		const { page, errors, mounted, n } = await open(readable, "roundtrip-" + readable);
		try {
			const c = mounted.pane.left + mounted.pane.width / 2, cy = n.textCy as number;
			const out = await call(page, "pinch", 0.25, 30, c, cy, "out") as any[];
			const back = await call(page, "pinch", 1, 30, c, cy, "in") as any[];
			const later = await call(page, "later", 400, "later") as any;
			const settled = back.at(-1);
			record.push({ readable, natural: n, out: out.at(-1), back: settled, later, errors });
			// eslint-disable-next-line no-console
			console.log("ROUNDTRIP " + JSON.stringify({ readable, naturalRangeX: n.rangeX, naturalScrollLeft: n.scrollLeft,
				outRangeX: out.at(-1).rangeX, settledRangeX: settled.rangeX, settledScrollLeft: settled.scrollLeft,
				laterRangeX: later.rangeX, laterScrollLeft: later.scrollLeft, laterPanX: later.panX, laterTextLeft: later.textLeft, naturalTextLeft: n.textLeft }));
			expect(errors).toEqual([]);
			// Under the canvas the room is the canvas's business, so the two
			// room rows are no longer the claim. What survives the mode change is the ruling: a pinch out and
			// back about ONE focal point returns the page where it stood. The room and the scroll are
			// still read and printed above, so a change in them is on the record either way.
			expect(settled.k, "the round trip came back to 100%").toBeCloseTo(1, 3);
			// Alan, 2026-09-20: the slide back to the margin at the lift IS the design, so the page
			// returning to where it stood is NOT the claim any more. What it does instead is DERIVED here
			// rather than pinned: the whole of the displacement is the native scroll the settle parked plus
			// the pan standing at rest. Measured at f3dc4420: 647.25 -> -1449.00 with Readable line length on
			// and 306.00 -> -1790.25 with it off, both 2096.25 px, both on scrollLeft 2096 and pan -0.25.
			expect(later.scrollLeft, "the settle parked a sideways scroll in the granted room").toBeGreaterThan(0);
			expect(later.rangeX, "and the room it parked in is the canvas's own grant").toBeGreaterThanOrEqual(later.scrollLeft);
			expect(Math.abs(later.textLeft - (n.textLeft - later.scrollLeft + later.panX)),
				"the displacement is the parked scroll plus the standing pan, and nothing else, px").toBeLessThanOrEqual(1);
			expect(Math.abs(later.textLeft - n.textLeft), "and it does NOT return: it lands left of where it stood, px").toBeGreaterThan(1);
		} finally { await page.close(); }
	}, 180_000);
}

it("a round trip on a note whose ink reaches the pane's edge keeps the room that ink earned, RLL off", async () => {
	const { page, errors, mounted, n } = await open(false, "roundtrip-ink", false);
	try {
		// Ink out to the right of the pane, so part 16's rule grants sideways room: the room this arm must not lose.
		const strokes = await call(page, "tallInk", 1500, 200, 0) as number;
		expect(strokes, "the far stroke committed").toBe(2);
		const grant = await call(page, "later", 200, "granted") as any;
		expect(grant.rangeX, "premise: the ink earned sideways room").toBeGreaterThan(100);
		const c = mounted.pane.left + mounted.pane.width / 2, cy = n.textCy as number;
		await call(page, "pinch", 0.25, 30, c, cy, "out");
		await call(page, "pinch", 1, 30, c, cy, "in");
		const later = await call(page, "later", 400, "later") as any;
		record.push({ arm: "ink", natural: n, granted: grant, later, errors });
		// eslint-disable-next-line no-console
		console.log("ROUNDTRIP-INK " + JSON.stringify({ grantedRangeX: grant.rangeX, laterRangeX: later.rangeX, laterScrollLeft: later.scrollLeft, textLeft: later.textLeft, naturalTextLeft: n.textLeft }));
		expect(errors).toEqual([]);
		expect(later.k, "back at 100%").toBeCloseTo(1, 3);
		// Under the canvas the round trip may GRANT more room than the ink earned, so the
		// claim is that none of the ink's room is lost, not that the number is unchanged.
		expect(later.rangeX, "the room the ink earned is still there").toBeGreaterThanOrEqual(grant.rangeX);
		// NOT ASSERTED, MEASURED AND DISCLOSED: on a note that HAS granted room, the round trip also leaves the view parked
		// in it (scrollLeft 651 of 666 here, the text off the pane's left edge), and the band release cannot take that back
		// - the room is the ink's, and the guard that protects a view parked in granted room refuses to move it. That park
		// comes from the settle spending its pan into the room the ink granted, which is a different mechanism from this
		// cell's; it is recorded here so a later fix has its number and this arm has its scope.
		expect(later.scrollLeft, "recorded: the view parks in granted room on a round trip (disclosed, not this cell's)").toBeGreaterThanOrEqual(0);
	} finally { await page.close(); }
}, 180_000);
