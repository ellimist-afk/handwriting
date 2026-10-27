/**
 * ZOOM ROUND TRIP: PINCH IN TO 600% ABOUT THE BOTTOM TEXT LINE OF THE PANE, LIFT, SETTLE, PINCH OUT IN LIFTS TO 100%.
 *
 * Device report: with the fingers on the bottom text of the pane, pinching to 600% and letting go leaves the text and
 * pictures off; it stays wrong while zooming out and clears near 120%. Measured here with the router's own two-finger
 * pinch (beginPinch, updatePinch, endPinch) about the anchor line's ink.
 *
 * The page of ZoomOut203.arm.test.ts (Minimal theme, line numbers, 12 px text, 641 px pane, two pictures above long
 * text), two notes, each on its own page:
 *   below: the anchor is the lowest text line fully on the pane at scrollTop 0; text continues below it.
 *   last:  the anchor is the last line of the note, placed 36 px above the pane's bottom edge.
 * A magenta stroke is inked on the anchor line. Steps: pinch to k 6 then to 4, 3, 2, 1.5, 1.2, 1.0, each lifted and
 * settled. HW_Z1_SIZED_PICS=1 gives the rig pictures width and height attributes (1280 by 400, height auto) so a
 * picture load cannot change the content height; unset leaves them unsized. Run both ways.
 *
 * Recorded on every frame: the anchor line's text box, every picture box, the content box, the gutter box; scrollTop
 * and scrollLeft as ASKED (every write to the scroller is wrapped) against ACHIEVED, with the clamp signature
 * (scrollHeight minus clientHeight, scrollWidth minus clientWidth); the note's granted extent. The ink box is read
 * at the last preview frame, the first settled frame and every rest. Nothing in src/ is changed.
 *
 * Reds (soft, so every column is recorded):
 *   each lift, last preview frame to first settled frame: the anchor text, the ink, each rendered picture and the
 *     gutter's left edge move at most 2 screen px;
 *   each rest: text minus ink stays within 1.5 px of its value before the first pinch;
 *   the 100% lift's first settled frame and the 100% rest: the gap from the gutter's left edge to the text within 0.5 px of
 *     the natural frame's (the line numbers ride the pan with the text);
 *   the 100% rest: anchor text and ink within 2 px of the natural frame, x and y; scrollLeft within 2 px of the natural frame;
 *   the anchor text is on the pane at the 600% rest.
 * A missing anchor text, ink or gutter on a lift or rest frame where one should exist is a red, not a pass. A picture is paired
 * across a lift by its place in the note (data-pic, 0 or 1), not by rendered order; a pair on both frames is asserted, a
 * picture on one frame only is recorded (picsOneFrame) and not asserted.
 * The content box bottom edge is recorded and not asserted: it rides CodeMirror's height estimate for lines it has
 * not rendered. HW_Z1_OUT writes every sample as JSON.
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import rawCss from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

declare const process: { env: Record<string, string | undefined> };

const PAGE = `
import { EditorState, StateField, RangeSetBuilder } from "@codemirror/state";
import { EditorView, Decoration, WidgetType, lineNumbers } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { inlineInk, inkOverlayExtension, overlayForPath, setScrollExpansionEnabled, setInlineTool, setInkSizeMult } from "../../src/inline/InkOverlay";
import { surfaceExtents } from "../../src/inline/SurfaceExtent";
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
const PANE_W = 641, PANE_H = 900, HOST_LEFT = 200, MARK = "ANCHOR-LINE";
let rig = null;
const frames = [];
let writes = [];

class Pic extends WidgetType {
	constructor(src, n) { super(); this.src = src; this.n = n; }
	eq(o) { return o.src === this.src; }
	toDOM() {
		const d = document.createElement("div"); d.className = "internal-embed media-embed image-embed is-loaded";
		const img = document.createElement("img"); img.src = this.src; img.dataset.pic = String(this.n); img.style.display = "block"; if (window.z1SizedPics) { img.setAttribute("width", "1280"); img.setAttribute("height", "400"); img.style.height = "auto"; } d.appendChild(img); return d;
	}
}
function picField(srcs) {
	const deco = doc => { const b = new RangeSetBuilder(); for (let i = 1; i <= doc.lines; i++) { const l = doc.line(i), m = /^!\\[\\[pic-(\\d)\\.png\\]\\]$/.exec(l.text); if (m) b.add(l.from, l.to, Decoration.replace({ widget: new Pic(srcs[Number(m[1])], Number(m[1])) })); } return b.finish(); };
	return StateField.define({ create: s => deco(s.doc), update: (v, tr) => (tr.docChanged ? deco(tr.state.doc) : v), provide: f => EditorView.decorations.from(f) });
}
async function picture(w, h, shade) {
	const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d"); g.fillStyle = shade; g.fillRect(0, 0, w, h);
	const src = c.toDataURL("image/png"), img = new Image(); img.src = src; await img.decode(); return src;
}
function installSizer(view) {
	const sizer = document.createElement("div"); sizer.className = "cm-sizer";
	const container = document.createElement("div"); container.className = "cm-contentContainer";
	view.contentDOM.parentElement.insertBefore(sizer, view.contentDOM); sizer.appendChild(container); container.appendChild(view.contentDOM);
	void view.scrollDOM.clientWidth; return sizer;
}
/** Obsidian hosts the gutters in .cm-contentContainer; stock CM puts them in the scroller (OverscrollBounce.test.ts). */
function nestGutters(view) {
	const gutters = view.scrollDOM.querySelector(":scope > .cm-gutters");
	if (!gutters) throw new Error("missing stock gutters");
	const container = view.contentDOM.parentElement, insert = view.scrollDOM.insertBefore.bind(view.scrollDOM);
	view.scrollDOM.insertBefore = (node, before) => node === gutters ? container.insertBefore(node, before?.parentNode === container ? before : view.contentDOM) : insert(node, before);
	container.insertBefore(gutters, view.contentDOM);
}
const lines = () => [...rig.view.contentDOM.querySelectorAll(".cm-line")];
const textLines = () => lines().filter(l => !l.querySelector(".image-embed") && l.textContent.trim());
/** The anchor line, by its mark: CodeMirror renders only the lines near the viewport, so an index would shift. */
const anchorLine = () => lines().find(l => l.textContent.includes(MARK)) ?? null;
const textBox = el => { const range = document.createRange(); range.selectNodeContents(el); const r = range.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, cy: (r.top + r.bottom) / 2, left: r.left, right: r.right }; };
const MAGENTA = (d, i) => d[i + 3] > 200 && d[i] > 200 && d[i + 1] < 60 && d[i + 2] > 200;
function backingInk() {
	const cc = rig.overlay.committedCanvas; if (!cc) return null; const w = cc.width, h = cc.height;
	if (!(w > 0 && h > 0)) return null;
	const d = cc.getContext("2d").getImageData(0, 0, w, h).data;
	let minY = Infinity, minX = Infinity, maxX = -1, maxY = -1, n = 0;
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; if (MAGENTA(d, i)) { n++; if (y < minY) minY = y; if (y > maxY) maxY = y; if (x < minX) minX = x; if (x > maxX) maxX = x; } }
	if (!n) return { n };
	const r = cc.getBoundingClientRect();
	return { n, top: r.top + minY * r.height / h, bottom: r.top + (maxY + 1) * r.height / h, left: r.left + minX * r.width / w, right: r.left + (maxX + 1) * r.width / w };
}
const r2 = v => Math.round(v * 100) / 100;
const box = r => ({ left: r2(r.left), right: r2(r.right), top: r2(r.top), bottom: r2(r.bottom), w: r2(r.right - r.left), h: r2(r.bottom - r.top) });
/** Wrap every write to the scroller so the sample can say what was asked and what the browser achieved (the clamp). */
function wrapScrollWrites(sd, phaseNow) {
	const maxOf = prop => (prop === "scrollTop" ? sd.scrollHeight - sd.clientHeight : sd.scrollWidth - sd.clientWidth);
	for (const prop of ["scrollTop", "scrollLeft"]) {
		const d = Object.getOwnPropertyDescriptor(Element.prototype, prop);
		Object.defineProperty(sd, prop, { configurable: true, get() { return d.get.call(this); },
			set(v) { const before = d.get.call(this); d.set.call(this, v); writes.push({ via: prop, phase: phaseNow(), asked: r2(v), before: r2(before), achieved: r2(d.get.call(this)), max: maxOf(prop) }); } });
	}
	for (const fn of ["scrollTo", "scrollBy"]) {
		const orig = sd[fn].bind(sd);
		sd[fn] = (a, b) => { const o = typeof a === "object" ? a : { left: a, top: b }; const bl = sd.scrollLeft, bt = sd.scrollTop; orig(a, b);
			writes.push({ via: fn, phase: phaseNow(), askedLeft: o.left ?? null, askedTop: o.top ?? null, beforeLeft: r2(bl), beforeTop: r2(bt), achievedLeft: r2(sd.scrollLeft), achievedTop: r2(sd.scrollTop), maxLeft: sd.scrollWidth - sd.clientWidth, maxTop: sd.scrollHeight - sd.clientHeight }); };
	}
}
let currentPhase = "setup";
function sample(phase, ink = false) {
	currentPhase = phase;
	const { view, overlay, pane, path, sizer } = rig, pr = pane.getBoundingClientRect(), cr = view.contentDOM.getBoundingClientRect(), sd = view.scrollDOM;
	const al = anchorLine(), t = al ? textBox(al) : null;
	const pics = [...view.contentDOM.querySelectorAll(".image-embed img")].map(i => ({ id: Number(i.dataset.pic), ...box(i.getBoundingClientRect()) }));
	const ext = surfaceExtents.get(path);
	const tl = textLines().map(l => textBox(l).left).filter(Number.isFinite), textLeft = tl.length ? Math.min(...tl) : null;
	const g = view.dom.querySelector(".cm-gutters"), gr = g ? g.getBoundingClientRect() : null;
	const nums = [...view.dom.querySelectorAll(".cm-lineNumbers .cm-gutterElement")].filter(e => e.textContent.trim()).map(e => e.getBoundingClientRect());
	const numRight = nums.length ? Math.max(...nums.map(r => r.right)) : null;
	const vl = overlay.viewportLayout;
	const s = { phase, k: overlay.pinchScaleNow, preview: !!overlay.pinchPreview,
		ownLines: vl ? (vl.ownLines === undefined ? null : !!vl.ownLines) : null, marginVar: view.dom.style.getPropertyValue("--handwriting-column-margin-left"), restingMargin: overlay.restingColumnMargin, sizerOffsetLeft: sizer.offsetLeft,
		scrollLeft: r2(sd.scrollLeft), scrollTop: r2(sd.scrollTop), scrollWidth: sd.scrollWidth, clientWidth: sd.clientWidth, scrollHeight: sd.scrollHeight, clientHeight: sd.clientHeight,
		clampX: sd.scrollWidth - sd.clientWidth, clampY: sd.scrollHeight - sd.clientHeight,
		extent: { x: ext.x, y: ext.y }, writes: writes.splice(0),
		pane: box(pr), content: box(cr),
		anchor: t ? { present: true, left: r2(t.left), right: r2(t.right), top: r2(t.top), bottom: r2(t.bottom), onPane: t.bottom > pr.top && t.top < pr.bottom && t.right > pr.left && t.left < pr.right, inside: t.top >= pr.top && t.bottom <= pr.bottom && t.left >= pr.left && t.right <= pr.right } : { present: false },
		textLeft: textLeft === null ? null : r2(textLeft),
		gutter: gr ? box(gr) : null, numRight: numRight === null ? null : r2(numRight),
		overlapPx: gr && textLeft !== null ? r2((numRight ?? gr.right) - textLeft) : null,
		picCount: pics.length, pics, renderedTextLines: textLines().length };
	if (ink) { const i = backingInk(); s.ink = i && i.n ? { n: i.n, left: r2(i.left), right: r2(i.right), top: r2(i.top), bottom: r2(i.bottom) } : { n: i ? i.n : 0 }; }
	frames.push(s); return s;
}

window.z1 = {
	async mount(mode) {
		setPenInk(true); setScrollExpansionEnabled(true);
		setInlineTool("pen"); setInkColorHex("pen", "#ff00ff"); setInkSizeMult("pen", 4);
		const path = "zoom-out-203-d-" + mode + ".md";
		const srcs = [await picture(1280, 400, "#406080"), await picture(1280, 400, "#608040")];
		const para = "Two pictures, then lines to write on. " + Array.from({ length: 6 }, (_, i) => "This sentence is " + (i + 1) + " of a paragraph long enough to wrap at every zoom.").join(" ");
		const doc = [para, "![[pic-0.png]]", "line 2 alpha beta gamma", "![[pic-1.png]]",
			...Array.from({ length: 70 }, (_, i) => "line " + (i + 4) + " alpha beta gamma delta")].join("\\n");
		const pane = document.body.appendChild(document.createElement("div"));
		pane.className = "markdown-source-view mod-cm6 is-readable-line-width";
		pane.style.cssText = "position:relative;margin-left:" + HOST_LEFT + "px;width:" + PANE_W + "px;height:" + PANE_H + "px;overflow:hidden";
		const view = new EditorView({ parent: pane, state: EditorState.create({ doc, extensions: [history(), EditorView.lineWrapping, lineNumbers(), picField(srcs),
			editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} })), inkOverlayExtension(),
			EditorView.theme({ "&": { width: PANE_W + "px", height: PANE_H + "px" }, ".cm-scroller": { overflowY: "auto", overflowX: "hidden" }, ".cm-content": { fontSize: "12px" } })] }) });
		const sizer = installSizer(view);
		nestGutters(view);
		for (let i = 0; i < 60 && [...view.contentDOM.querySelectorAll(".image-embed img")].some(i => !(i.complete && i.naturalWidth > 0)); i++) await frame();
		view.requestMeasure(); await settle(12);
		const overlay = overlayForPath(path);
		if (!overlay) throw new Error("no overlay for " + path);
		rig = { pane, view, overlay, sizer, path };
		const sd = view.scrollDOM;
		// "last": scroll to the end so the last line renders, then place the last line 36 px above the pane's bottom edge (the end of the
		// scroller is the granted blank room below the text, not the last line).
		if (mode === "last") {
			sd.scrollTop = sd.scrollHeight; await settle(12);
			for (let i = 0; i < 4; i++) { const ls = lines(), last = ls[ls.length - 1], pb = pane.getBoundingClientRect().bottom; sd.scrollTop += last.getBoundingClientRect().bottom - (pb - 36); await settle(12); }
		}
		// The anchor: the lowest text line whose box is fully on the pane. "below" keeps 24 px clear of the bottom edge; "last"
		// takes the lowest fully visible line, and says what it saw when there is none.
		const pr = pane.getBoundingClientRect();
		const inside = textLines().map(l => ({ l, b: l.getBoundingClientRect() })).filter(c => c.b.top >= pr.top && c.b.bottom <= pr.bottom);
		const cand = (mode === "last" ? inside : inside.filter(c => c.b.bottom <= pr.bottom - 24)).sort((x, y) => y.b.bottom - x.b.bottom);
		const pick = cand[0];
		if (!pick) throw new Error("no text line on the pane: " + JSON.stringify({ mode, scrollTop: sd.scrollTop, scrollHeight: sd.scrollHeight, clientHeight: sd.clientHeight, pane: [pr.top, pr.bottom], lines: textLines().map(l => { const b = l.getBoundingClientRect(); return [l.textContent.slice(0, 12), r2(b.top), r2(b.bottom)]; }) }));
		const pos = view.posAtDOM(pick.l), line = view.state.doc.lineAt(pos);
		view.dispatch({ changes: { from: line.from, to: line.to, insert: MARK + " " + line.text } });
		await settle(12);
		const a = anchorLine(); if (!a) throw new Error("anchor line not rendered");
		const lastLineNo = view.state.doc.lines, anchorLineNo = view.state.doc.lineAt(view.posAtDOM(a)).number;
		const t = textBox(a), x = t.left + 40, y = t.cy;
		const pen = (type, px, py, buttons) => document.elementFromPoint(px, py)?.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "pen", pointerId: 901, isPrimary: true, clientX: px, clientY: py, buttons, pressure: buttons ? 0.5 : 0 }));
		pen("pointerdown", x, y, 1); for (let i = 1; i <= 4; i++) pen("pointermove", x + 20 * i, y, 1); pen("pointerup", x + 80, y, 0);
		await settle(12);
		wrapScrollWrites(sd, () => currentPhase);
		const nat = sample("natural", true);
		return { strokes: inlineInk.strokes(path).length, natural: nat, anchorLineNo, lastLineNo, docLines: view.state.doc.lines, anchorFromPaneBottom: r2(pr.bottom - t.bottom), scrollTopAtMount: r2(sd.scrollTop), maxScrollTop: sd.scrollHeight - sd.clientHeight };
	},
	/** Where the fingers go: the anchor line's text a little right of its start (the ink's centre when it is on the pane), else the pane's middle at the line's height kept on the pane. */
	finger() {
		const pr = rig.pane.getBoundingClientRect(), al = anchorLine(), i = backingInk();
		const t = al ? textBox(al) : null;
		const p = i && i.n ? { x: (i.left + i.right) / 2, y: (i.top + i.bottom) / 2 } : t ? { x: t.left + 80, y: t.cy } : { x: (pr.left + pr.right) / 2, y: pr.bottom - 40 };
		const on = p.x > pr.left + 20 && p.x < pr.right - 20 && p.y > pr.top + 20 && p.y < pr.bottom - 20;
		return on ? { ...p, on } : { x: (pr.left + pr.right) / 2, y: Math.min(pr.bottom - 40, Math.max(pr.top + 40, p.y)), on };
	},
	/** The router's two-finger pinch about a client point to scale "to", every frame sampled, then the settle sampled. */
	async pinch(to, steps, tag, via) {
		const { overlay } = rig, router = overlay.router, from = overlay.pinchScaleNow, w = this.finger(), cx = w.x, cy = w.y;
		// "via": the fingers go out to that scale over the first half of the moves and back to "to" over the second half.
		const spread0 = 100, spread1 = 100 * to / from, spreadVia = via ? 100 * via / from : null;
		const spreadAt = i => spreadVia === null ? spread0 + (spread1 - spread0) * i / steps
			: i <= steps / 2 ? spread0 + (spreadVia - spread0) * i / (steps / 2) : spreadVia + (spread1 - spreadVia) * (i - steps / 2) / (steps / 2);
		const touch = s => { router.touchPos.set(911, { x: cx - s / 2, y: cy }); router.touchPos.set(912, { x: cx + s / 2, y: cy }); };
		const ev = type => new PointerEvent(type, { pointerId: 912, pointerType: "touch" });
		touch(spread0); router.beginPinch(ev("pointerdown"));
		for (let i = 1; i <= steps; i++) { touch(spreadAt(i)); router.updatePinch(ev("pointermove")); await rendered(); sample(tag + "-move-" + i, i === steps); }
		router.endPinch(ev("pointerup"), { x: cx, y: cy }); router.touchPos.clear();
		currentPhase = tag + "-lift-0";
		for (let j = 1; j <= 16; j++) { await rendered(); sample(tag + "-lift-" + j, j === 1); }
		for (let j = 1; j <= 90 && overlay.overscrollBounceReadout && overlay.overscrollBounceReadout().active; j++) { await rendered(); sample(tag + "-bounce-" + j); }
		return { center: { x: r2(cx), y: r2(cy) }, onFinger: w.on, from: r2(from) };
	},
	async later(ms, phase) {
		await new Promise(r => setTimeout(r, ms));
		for (let i = 0; i < 90 && rig.overlay.overscrollBounceReadout && rig.overlay.overscrollBounceReadout().active; i++) await frame();
		await settle(4); return sample(phase, true);
	},
	frames: () => frames,
};
`;

const THEME_CSS = readFileSync(fileURLToPath(new URL("./fixtures/minimal-9.0.2-theme.css", import.meta.url)), "utf8");
const css = rawCss.replace(/\r\n/g, "\n");
const record: unknown[] = [];
let browser: Browser;
let script = "";
/**
 * PLANTS, one per run (HW_Z1_PLANT), each a source rewrite of the one line that carries a part of the fix; the anchor must
 * match exactly once. correction0: the settle's line correction forced to 0 (the lift jump comes back). sigreread: the
 * line signature re-read while zoomed (ink leaves its line at the rests). ease0: the commit-time ease alone, no re-aim on
 * the hold's attempts (the first settled frame steps off the last preview frame). band0: the residue band
 * dropped, so a scale gap reads as the line moving. k1sticky: the line-number travel class comes off at 100% again, as
 * before the line numbers rode the pan (the 100% lift's gutter steps by the pan, and its gap to the text with it).
 */
const PLANTS: Record<string, [string, string, string]> = {
	correction0: ["InkOverlayZoomApi", "moved=this.view.lineBlockAt(fingerLine.pos).top/scaleY-fingerLine.top-(settleLineApplied.get(hold)??0);", "moved=0;"],
	sigreread: ["InkOverlayLineAnchors", "if (this.pinchScaleNow !== 1) return;", ""],
	band0: ["InkOverlayZoomApi", "if(Number.isFinite(moved)&&Math.abs(moved)>band){", "if(Number.isFinite(moved)&&moved!==0){"],
	ease0: ["InkOverlayPanSettle", "const reaim = settling && !owesPreviewEase && settlePaintedBefore.has(a);", "const reaim = false;"],
	k1sticky: ["InkOverlayViewportBox", "if(release){host.classList.remove(GUTTER_TRAVEL_CLASS);return;}", "if(release||Math.abs(next-1)<=SCALE_EPSILON){host.classList.remove(GUTTER_TRAVEL_CLASS);return;}"],
};
const PLANT = process.env.HW_Z1_PLANT ?? "";
if (PLANT && !PLANTS[PLANT]) throw new Error(`unknown HW_Z1_PLANT ${PLANT}`);
let plantHits = 0;

beforeAll(async () => {
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "zoomOut203ArmDPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
		plugins: PLANT ? [{ name: "z1-plant", setup(builder) {
			const [file, from, to] = PLANTS[PLANT]!;
			builder.onLoad({ filter: new RegExp(`src[\\\\/]inline[\\\\/]${file}\\.ts$`) }, args => {
				const source = readFileSync(args.path, "utf8"), hits = source.split(from).length - 1;
				if (hits !== 1) throw new Error(`z1 plant ${PLANT}: anchor matched ${hits} times, want 1`);
				plantHits++;
				return { loader: "ts", contents: source.replace(from, to) };
			});
		} }] : [] });
	if (PLANT && plantHits !== 1) throw new Error(`z1 plant ${PLANT}: the planted file was bundled ${plantHits} times, want 1`);
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);
afterAll(async () => {
	await browser?.close();
	if (process.env.HW_Z1_OUT) writeFileSync(process.env.HW_Z1_OUT, JSON.stringify(record, null, 1));
});

type Edges = { left: number; right: number; top: number; bottom: number };
const jump = (a: Edges, b: Edges) => Math.max(Math.abs(a.left - b.left), Math.abs(a.right - b.right), Math.abs(a.top - b.top), Math.abs(a.bottom - b.bottom));
const rd = (v: number) => Math.round(v * 100) / 100;
/** Largest edge change of each tracked box between two frames; a box missing on either frame is reported as null. */
function jumps(a: any, b: any) {
	const anchor = a.anchor.present && b.anchor.present ? rd(jump(a.anchor, b.anchor)) : null;
	const ink = a.ink?.n > 0 && b.ink?.n > 0 ? rd(jump(a.ink, b.ink)) : null;
	const content = rd(jump(a.content, b.content));
	const gutterLeft = a.gutter && b.gutter ? rd(Math.abs(a.gutter.left - b.gutter.left)) : null;
	const ids = (f: any) => f.pics.map((p: any) => p.id);
	const pics = a.pics.filter((p: any) => ids(b).includes(p.id)).map((p: any) => ({ id: p.id, jump: rd(jump(p, b.pics.find((q: any) => q.id === p.id))) }));
	const picsOneFrame = [...ids(a).filter((i: number) => !ids(b).includes(i)).map((id: number) => ({ id, on: "last preview" })), ...ids(b).filter((i: number) => !ids(a).includes(i)).map((id: number) => ({ id, on: "first settled" }))];
	return { anchor, ink, content, gutterLeft, pics, picsOneFrame, anchorPresent: [a.anchor.present, b.anchor.present], inkPresent: [a.ink?.n > 0, b.ink?.n > 0], picCount: [a.picCount, b.picCount] };
}
/** Pinch-in target, then the pinch-out lifts, in order. */
const STEPS: { tag: string; to: number }[] = [{ tag: "in", to: 6 }, ...[4, 3, 2, 1.5, 1.2, 1.0].map(k => ({ tag: "k" + k, to: k }))];

const SIZED = process.env.HW_Z1_SIZED_PICS === "1";
for (const mode of ["below", "last"] as const) {
	it(`zoom round trip, note "${mode}", pictures ${SIZED ? "sized" : "unsized"}: pinch in to 600% about the bottom text line, lift, then pinch out in lifts to 100%`, async () => {
		const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2, hasTouch: true });
		const errors: string[] = [];
		page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
		try {
			await page.setContent('<!doctype html><body class="theme-dark" style="margin:0"></body>');
			await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS + "\n.markdown-source-view img:not([width]) { max-width: 100%; }\n" });
			await page.addStyleTag({ content: THEME_CSS });
			await page.addScriptTag({ content: script });
			await page.evaluate((f) => { (window as any).z1SizedPics = f; }, SIZED);
			const m = await page.evaluate((md) => (window as any).z1.mount(md), mode) as any;
			expect(m.strokes, "the stroke committed").toBe(1);
			if (mode === "last") expect(m.anchorLineNo, "premise: the anchor is the last line of the note").toBe(m.lastLineNo);
			if (mode === "below") expect(m.anchorLineNo, "premise: text continues below the anchor").toBeLessThan(m.lastLineNo);
			const legsRun: any[] = [];
			for (const st of STEPS) {
				const pin = await page.evaluate(([to, tag]) => (window as any).z1.pinch(to, tag === "in" ? 40 : 20, tag), [st.to, st.tag] as [number, string]) as any;
				const rest = await page.evaluate(([ms, tag]) => (window as any).z1.later(ms, "rest-" + tag), [st.tag === "in" ? 400 : 700, st.tag] as [number, string]) as any;
				legsRun.push({ ...st, pin, rest: { k: rest.k } });
			}
			const frames = await page.evaluate(() => (window as any).z1.frames()) as any[];
			const at = (p: string) => frames.findIndex(f => f.phase === p);
			// The last move frame with the preview on; a leg whose moves never show the preview falls back to its last move frame and says so (previewSeen false).
			const moveIdx = (tag: string) => frames.map((f, i) => (f.phase.startsWith(tag + "-move") ? i : -1)).filter(i => i >= 0);
			const lastPreview = (tag: string): number => { const mv = moveIdx(tag), pv = mv.filter(i => frames[i].preview); return pv.length ? pv[pv.length - 1]! : mv[mv.length - 1] ?? -1; };
			const previewSeen = (tag: string) => moveIdx(tag).some(i => frames[i].preview);
			let prevRest = at("natural");
			let prev = { k: 1, frame: frames[prevRest] };
			const read: any[] = [];
			for (const st of legsRun) {
				const ix = { lastPreview: lastPreview(st.tag), firstSettled: at(st.tag + "-lift-1"), rest: at("rest-" + st.tag) };
				const a = frames[ix.lastPreview], f = frames[ix.firstSettled], r = frames[ix.rest];
				const ws = frames.slice(prevRest + 1, ix.rest + 1).flatMap(x => x.writes);
				const gap = (ax: "x" | "y") => ws.reduce((mx: number, w: any) => {
					const v = ax === "y" ? (w.via === "scrollTop" ? Math.abs(w.asked - w.achieved) : w.askedTop != null ? Math.abs(w.askedTop - w.achievedTop) : 0) : (w.via === "scrollLeft" ? Math.abs(w.asked - w.achieved) : w.askedLeft != null ? Math.abs(w.askedLeft - w.achievedLeft) : 0);
					return Math.max(mx, v); }, 0);
				const lastWrite = ws.length ? ws[ws.length - 1] : null;
				// Where pure scaling about the fingers puts the anchor's top-left, from the previous rest: the offset is rest minus that.
				const fx = st.pin.center.x, fy = st.pin.center.y, ratio = r.k / prev.k;
				const pa = prev.frame.anchor;
				const off = pa.present && r.anchor.present ? { x: rd(r.anchor.left - (fx + (pa.left - fx) * ratio)), y: rd(r.anchor.top - (fy + (pa.top - fy) * ratio)) } : null;
				const clamped = { x: r.scrollLeft <= 0 || r.scrollLeft >= r.clampX - 1, y: r.scrollTop <= 0 || r.scrollTop >= r.clampY - 1 };
				read.push({ step: st.tag, kWant: st.to, previewSeen: previewSeen(st.tag), kRest: rd(r.k), frames: ix, onFinger: st.pin.onFinger, finger: st.pin.center,
					firstSettledVsLastPreview: jumps(a, f), restVsLastPreview: jumps(a, r),
					rest: { anchor: r.anchor, ink: r.ink, pics: r.pics, picCount: r.picCount, content: r.content, gutter: r.gutter, numRight: r.numRight, overlapPx: r.overlapPx, textLeft: r.textLeft,
						scrollLeft: r.scrollLeft, scrollTop: r.scrollTop, clampX: r.clampX, clampY: r.clampY, scrollWidth: r.scrollWidth, scrollHeight: r.scrollHeight, extent: r.extent,
						ownLines: r.ownLines, marginVar: r.marginVar, restingMargin: r.restingMargin, sizerOffsetLeft: r.sizerOffsetLeft },
					scrollAt: { lastPreview: [a.scrollLeft, a.scrollTop], firstSettled: [f.scrollLeft, f.scrollTop], rest: [r.scrollLeft, r.scrollTop] },
					writesToRest: { n: ws.length, gapX: rd(gap("x")), gapY: rd(gap("y")), last: lastWrite }, clamped, offsetFromScaling: off });
				prevRest = ix.rest; prev = { k: r.k, frame: r };
			}
			const worstOverlap = frames.reduce((a, f) => (f.overlapPx !== null && f.overlapPx > a.overlapPx ? f : a), { overlapPx: -Infinity, phase: null } as any);
			record.push({ mode, sizedPics: SIZED, mount: m, legs: legsRun, read, worstOverlap: { px: worstOverlap.overlapPx, phase: worstOverlap.phase }, frames });
			// eslint-disable-next-line no-console
			console.log("ROUNDTRIP-" + mode + (SIZED ? "-sized " : "-unsized ") + JSON.stringify({ mount: { anchorLineNo: m.anchorLineNo, lastLineNo: m.lastLineNo, anchorFromPaneBottom: m.anchorFromPaneBottom, maxScrollTop: m.maxScrollTop }, worstOverlap: [worstOverlap.overlapPx, worstOverlap.phase],
				steps: read.map(r => ({ step: r.step, previewSeen: r.previewSeen, kRest: r.kRest, onFinger: r.onFinger, frames: r.frames, anchorPresent: r.rest.anchor.present, anchorOnPane: r.rest.anchor.onPane, anchorInside: r.rest.anchor.inside,
					jumpSettled: r.firstSettledVsLastPreview, jumpRest: r.restVsLastPreview, scrollAt: r.scrollAt, writes: r.writesToRest, clampX: r.rest.clampX, clampY: r.rest.clampY, clamped: r.clamped,
					sw: r.rest.scrollWidth, sh: r.rest.scrollHeight, ownLines: r.rest.ownLines, margin: r.rest.marginVar, off: r.offsetFromScaling, picCount: r.rest.picCount, inkN: r.rest.ink?.n, overlap: r.rest.overlapPx })), frames: frames.length }));
			const six = read[0], final = read[read.length - 1];
			expect(six.kRest, "premise: pinched to 600%").toBeGreaterThan(5.9);
			expect(final.kRest, "premise: pinched out to 100%").toBeLessThan(1.06);
			const nat = frames[at("natural")];
			const tmi = (an: any, ink: any) => (an?.present && ink?.n > 0 ? an.top - ink.top : null);
			const natTmi = tmi(nat.anchor, nat.ink);
			expect(natTmi, "premise: the natural frame has the anchor text and its ink").not.toBeNull();
			// Each lift, last preview frame to first settled frame: anchor text, ink, rendered pictures, gutter left edge.
			for (const r of read) {
				const j = r.firstSettledVsLastPreview, lift = `${r.step} lift`;
				expect.soft(j.anchor !== null, `${lift}: the anchor text is rendered on both frames (${j.anchorPresent})`).toBe(true);
				if (j.anchor !== null) expect.soft(j.anchor, `${lift}: the anchor text moves at most 2 px`).toBeLessThanOrEqual(2);
				expect.soft(j.ink !== null, `${lift}: the ink is measured on both frames (${j.inkPresent})`).toBe(true);
				if (j.ink !== null) expect.soft(j.ink, `${lift}: the ink moves at most 2 px`).toBeLessThanOrEqual(2);
				for (const pj of j.pics) expect.soft(pj.jump, `${lift}: picture ${pj.id} (on both frames) moves at most 2 px`).toBeLessThanOrEqual(2);
				expect.soft(j.gutterLeft !== null, `${lift}: the gutter is measured on both frames`).toBe(true);
				// THE LINE NUMBERS STAY WITH THE TEXT, at every lift and at 100% as zoomed: at k 1.0 the fingers' sideways pan becomes
				// scroll at the lift (a design rest), and the gutter rides it with the lines, so it does not step at the lift either.
				// The 100% lift's first settled frame also holds the gap from the gutter's left edge to the text to the natural frame's.
				if (j.gutterLeft !== null) expect.soft(j.gutterLeft, `${lift}: the gutter's left edge moves at most 2 px`).toBeLessThanOrEqual(2);
				if (r.step === "k1") {
					const f = frames[r.frames.firstSettled], gs = f?.gutter && nat.gutter ? rd(Math.abs(f.gutter.left - nat.gutter.left)) : null;
					const gap = (x: any) => (x?.gutter && x.textLeft !== null && x.textLeft !== undefined ? x.textLeft - x.gutter.left : null);
					const gf = gap(f), gn = gap(nat), gd = gf !== null && gn !== null ? rd(Math.abs(gf - gn)) : null;
					// eslint-disable-next-line no-console
					console.log(`Z1-K1-GUTTER ${mode} previewToSettled=${j.gutterLeft} settledVsNatural=${gs} gapVsNatural=${gd}`);
					expect.soft(gd, `${lift}: the first settled gap from the gutter to the text is measured against the natural frame`).not.toBeNull();
					if (gd !== null) expect.soft(gd, `${lift}: the first settled gap from the gutter to the text within 0.5 px of the natural frame's`).toBeLessThanOrEqual(0.5);
				}
				// Each rest: text minus ink against its value before the first pinch, within max(1.5, 0.3 k) screen px: a sub-pixel
				// difference between the text's and the ink's note positions is painted k times larger at a zoomed rest.
				const t = tmi(r.rest.anchor, r.rest.ink), tmiBound = Math.max(1.5, 0.3 * r.kRest);
				expect.soft(t !== null, `rest ${r.step}: the anchor text and its ink are both measured`).toBe(true);
				if (t !== null) expect.soft(Math.abs(t - natTmi!), `rest ${r.step}: text minus ink (${rd(t)}) within ${rd(tmiBound)} px of its value before the first pinch (${rd(natTmi!)})`).toBeLessThanOrEqual(tmiBound);
			}
			expect.soft(six.rest.anchor.onPane, "anchor text is on the pane at the 600% rest").toBe(true);
			// The 100% rest: y against the natural frame; x against the k 1.0 leg's last preview frame, because the fingers' sideways
			// pan at k 1.0 becomes scroll at the lift (a design rest), so the page stays where the fingers left
			// it. scrollLeft is held to that pan: the natural scrollLeft plus the natural content left minus the preview content left.
			const edgesXY = (x: any, y: any) => (x && y && x.left !== undefined && y.left !== undefined ? { x: rd(Math.max(Math.abs(x.left - y.left), Math.abs(x.right - y.right))), y: rd(Math.max(Math.abs(x.top - y.top), Math.abs(x.bottom - y.bottom))) } : null);
			const finalPreview = frames[final.frames.lastPreview];
			const xyRest = (rest: any, natural: any, preview: any) => { const vn = edgesXY(rest, natural), vp = edgesXY(rest, preview); return vn && vp ? { x: vp.x, y: vn.y } : null; };
			const fingersScrollLeft = nat.scrollLeft + (nat.content.left - finalPreview.content.left);
			const roundTrip = { anchor: final.rest.anchor.present && finalPreview.anchor.present ? xyRest(final.rest.anchor, nat.anchor, finalPreview.anchor) : null,
				ink: final.rest.ink?.n > 0 && nat.ink?.n > 0 && finalPreview.ink?.n > 0 ? xyRest(final.rest.ink, nat.ink, finalPreview.ink) : null,
				scrollLeft: rd(Math.abs(final.rest.scrollLeft - fingersScrollLeft)), scrollLeftWant: rd(fingersScrollLeft), gutterLeft: rd(Math.abs(final.rest.gutter.left - nat.gutter.left)),
				gap: final.rest.gutter && final.rest.textLeft !== null && nat.gutter && nat.textLeft !== null ? rd(Math.abs((final.rest.textLeft - final.rest.gutter.left) - (nat.textLeft - nat.gutter.left))) : null };
			record[record.length - 1] = { ...(record[record.length - 1] as object), roundTrip };
			// eslint-disable-next-line no-console
			console.log("ROUNDTRIP-DELTA-" + mode + (SIZED ? "-sized " : "-unsized ") + JSON.stringify(roundTrip));
			expect.soft(roundTrip.anchor, "100% rest: the anchor text is rendered").not.toBeNull();
			expect.soft(roundTrip.ink, "100% rest: the ink is measured").not.toBeNull();
			for (const [what, d] of [["anchor text", roundTrip.anchor], ["ink", roundTrip.ink]] as [string, any][]) if (d) {
				expect.soft(d.x, `100% rest: the ${what} is within 2 px of the k 1.0 last preview frame in x`).toBeLessThanOrEqual(2);
				expect.soft(d.y, `100% rest: the ${what} is within 2 px of the natural frame in y`).toBeLessThanOrEqual(2);
			}
			expect.soft(roundTrip.scrollLeft, `100% rest: scrollLeft within 2 px of the natural frame's plus the fingers' pan (${roundTrip.scrollLeftWant})`).toBeLessThanOrEqual(2);
			expect.soft(roundTrip.gap, "100% rest: the gap from the gutter to the text is measured").not.toBeNull();
			if (roundTrip.gap !== null) expect.soft(roundTrip.gap, "100% rest: the gap from the gutter to the text within 0.5 px of the natural frame's").toBeLessThanOrEqual(0.5);
			expect(errors).toEqual([]);
		} finally { await page.close(); }
	}, 900_000);
}

// A LIFT UNDER CODEMIRROR'S REFRESH THRESHOLD. CodeMirror rebuilds its height map only when its scale
// moves by more than 0.005, so a lift from 60% to 60.4% leaves its scaleY at 0.6 against a painted 0.604: the line correction
// would read that gap as the line moving and step the page at the lift. The residue band leaves it alone, so the first settled
// frame stands where the last preview frame painted the anchor text and the ink.
it("a lift under CodeMirror's 0.005 refresh threshold, 60% to 60.4%, steps nothing at the lift", async () => {
	const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2, hasTouch: true });
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	try {
		await page.setContent('<!doctype html><body class="theme-dark" style="margin:0"></body>');
		await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS + "\n.markdown-source-view img:not([width]) { max-width: 100%; }\n" });
		await page.addStyleTag({ content: THEME_CSS });
		await page.addScriptTag({ content: script });
		await page.evaluate((f) => { (window as any).z1SizedPics = f; }, SIZED);
		const m = await page.evaluate(() => (window as any).z1.mount("below")) as any;
		expect(m.strokes, "the stroke committed").toBe(1);
		// The second lift goes out to 80% and back, so the router takes the pinch, and lifts at 60.4%.
		const legs = [{ tag: "k0.6", to: 0.6, steps: 20, via: null }, { tag: "k0.604", to: 0.604, steps: 20, via: 0.8 }];
		const rests: number[] = [];
		for (const st of legs) {
			await page.evaluate(([to, steps, tag, via]) => (window as any).z1.pinch(to, steps, tag, via), [st.to, st.steps, st.tag, st.via] as [number, number, string, number | null]);
			rests.push(((await page.evaluate((tag) => (window as any).z1.later(700, "rest-" + tag), st.tag)) as any).k);
		}
		const frames = await page.evaluate(() => (window as any).z1.frames()) as any[];
		const at = (p: string) => frames.findIndex(f => f.phase === p);
		const mv = frames.map((f, i) => (f.phase.startsWith("k0.604-move") ? i : -1)).filter(i => i >= 0), pv = mv.filter(i => frames[i].preview);
		const a = frames[pv.length ? pv[pv.length - 1]! : mv[mv.length - 1]!], f = frames[at("k0.604-lift-1")];
		const j = jumps(a, f);
		// eslint-disable-next-line no-console
		console.log(`Z1-SUBTHRESHOLD rests ${JSON.stringify(rests)} previewSeen ${pv.length > 0} jump ${JSON.stringify(j)} scrollTop ${a.scrollTop} -> ${f.scrollTop}`);
		expect(errors, "page errors").toEqual([]);
		expect(rests[0], "premise: the first lift rests at 60%").toBeCloseTo(0.6, 3);
		expect(rests[1], "premise: the second lift rests at 60.4%").toBeCloseTo(0.604, 3);
		expect(j.anchorPresent, "the anchor text is on both frames").toEqual([true, true]);
		expect.soft(j.anchor!, "the anchor text moves at most 1 px at the 60.4% lift").toBeLessThanOrEqual(1);
		if (j.ink !== null) expect.soft(j.ink, "the ink moves at most 1 px at the 60.4% lift").toBeLessThanOrEqual(1);
	} finally {
		await page.close();
	}
}, 180_000);
