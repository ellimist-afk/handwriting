/**
 * The page side of Issue58Font.test.ts: one "device" per browser context. Ported from the issue 58 repro rig
 * (issue58ReproPage.ts), with the first painted frame at open read as well (after the frame's callbacks, so the read sees
 * what that frame painted), and steps that change the pane's width, change the text size by a css variable alone (the
 * content's own resize is all the overlay hears), zoom the note, change the text size under a pen held down, and switch
 * the pane to another note.
 *
 * A device mounts a note in a CodeMirror editor with the real ink overlay, under its own pane width, font size, canvas
 * setting, platform answer and block heights. A device can be handed the bytes another device saved (the note's text,
 * its page id and its ink file), so device B opens exactly what device A wrote. Reports what it shows; decides nothing.
 *
 * Block stand-ins: Obsidian's live preview draws display math, an image embed and a callout as block widgets. Those
 * renderers are not here, so each is a CodeMirror block widget that replaces the same source lines, with a height the
 * device config sets (math, callout) or one that follows the column width (the image).
 */
import { Compartment, EditorState, RangeSetBuilder, StateField } from "@codemirror/state";
import { EditorView, Decoration, WidgetType, type DecorationSet } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { Platform } from "obsidian";
import { InkOverlayPlugin, inlineInk, inkOverlayExtension, overlayForPath, setScrollExpansionEnabled, setInlineTool, setInkSizeMult } from "../../src/inline/InkOverlay";
import { setInkColorHex } from "../../src/ink/InkColor";
import { setPenInk } from "../../src/inline/PenInk";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField, setBrowserEditorInfo } from "./iphoneObsidianStub";
import { parsePage, serializePage } from "../../src/model/PageData";

export interface DeviceConfig {
	paneW: number;
	paneH: number;
	fontPx: number;
	canvas: boolean;
	mobile: boolean;
	/** Display math block height, css px. */
	mathH: number;
	/** Callout padding, css px: the callout's text wraps inside it, so its height also follows the column. */
	calloutPad: number;
	/** The editor's font-family, so a CJK paragraph falls back to another face. */
	fontFamily: string;
	/** Image block height, css px; 0 or absent: it follows the column width (2:1). */
	imageH?: number;
	/** The image decodes late: 0 px tall until this many ms after it is drawn, then imageH. */
	imageLateMs?: number;
	/**
	 * The image is imageH tall from its first frame, but the editor is not told that height before it measures the block (as
	 * Obsidian's picture embed): the height map starts it at one line.
	 */
	imageUnknown?: boolean;
	/**
	 * The image is one line (24 px) tall when the editor first measures it, and imageH tall from that measure's own write on,
	 * with nothing telling the editor: its height map keeps the one line until something measures again.
	 */
	imageAfterMeasure?: boolean;
	/** An embed of another note (a `![[...]]` line with no picture extension): its height, css px, unknown to the editor before it measures. */
	embedH?: number;
	/** The embed is one line (24 px) tall when the editor first measures it, and embedH tall from that measure's own write on, as imageAfterMeasure. */
	embedAfterMeasure?: boolean;
	/** Properties block height, css px (the note's frontmatter, drawn as one block of that height). */
	propsH?: number;
	/** Every text line's own padding, left and right, css px (the editor's default is 6 and 2). */
	linePad?: number;
	/** The phrase's line as a nested list item (an em indent, as Obsidian's) or inside a quote (a px rule and indent). */
	phraseIn?: "list" | "quote";
	/** The pane has no box at mount (a background tab or a hidden split) and is shown once the ink has arrived. */
	hidden?: boolean;
	/** The note's path; absent: issue-58.md. */
	path?: string;
	/**
	 * Measure only (HW_FIRST_PAINT_MEASURE): after the first paint, one read per frame until the open read; and a log of every
	 * overlay repaint from the mount, taken after the repaint with no read that writes (the anchor's memo, never dyOf).
	 */
	measure?: boolean;
	text: string;
	phrase: string;
	pageId: string | null;
	sidecar: string | null;
}

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

let PATH = "issue-58.md";
const ids = new Map<string, string>(), sidecars = new Map<string, string>();
let saves = 0;
const save = (id: string, page: Any): void => { saves++; sidecars.set(id, serializePage(page)); };
let hostAttached = false;
/** The content font theme, swapped by setFont (a device's own text size changed after drawing). */
const fontTheme = new Compartment();
// The size reads a css variable first: setFontCss sets it on the body and nothing else, as Obsidian's font size setting does.
const fontRule = (px: number, family: string) => EditorView.theme({ ".cm-content": { fontSize: `var(--i58-font-size, ${px}px)`, lineHeight: "1.5", fontFamily: family } });
/** The editor's size theme, swapped by setPane (the window or a sidebar changed the pane's width). */
const sizeTheme = new Compartment();
const sizeRule = (w: number, h: number) => EditorView.theme({ "&": { width: w + "px", height: h + "px" }, ".cm-scroller": { overflowY: "auto" } });

const frame = (): Promise<void> => new Promise(r => requestAnimationFrame(() => r()));
/** After a frame's callbacks, its own and every other: a read here sees what that frame painted. */
const painted = (): Promise<void> => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
const settle = async (n = 8): Promise<void> => { for (let i = 0; i < n; i++) await frame(); };

let rig: { view: EditorView; overlay: Any; pane: HTMLElement; phrase: string; cfg: DeviceConfig } | null = null;

class BlockWidget extends WidgetType {
	constructor(readonly kind: string, readonly cfg: DeviceConfig, readonly body: string) { super(); }
	eq(o: BlockWidget): boolean { return o.kind === this.kind && o.body === this.body; }
	toDOM(view: EditorView): HTMLElement {
		const el = document.createElement("div");
		el.className = "issue58-block issue58-" + this.kind;
		if (this.kind === "math") el.style.cssText = `height:${this.cfg.mathH}px;display:flex;align-items:center;justify-content:center;font-style:italic`;
		else if (this.kind === "image" && this.cfg.imageLateMs) {
			el.style.cssText = "width:100%;max-width:800px;height:0px;background:#556";
			// Decoded: its height, and the editor told to measure its content again, as Obsidian's image embed does on load. A
			// bare requestMeasure left the editor's height map at the 0 px image through the whole open (run rig3-6eb8623c:
			// phrase line 288 in the map, 589 on the page), so the content flag is set too.
			setTimeout(() => { el.style.height = (this.cfg.imageH ?? 300) + "px"; (view as Any).viewState.mustMeasureContent = true; view.requestMeasure(); },
				this.cfg.imageLateMs);
		} else if (this.kind === "image" && this.cfg.imageAfterMeasure) {
			el.style.cssText = "width:100%;max-width:800px;height:24px;background:#556";
			// The write of the measure that reads the one line: no measure request follows it, so the measure stops there.
			view.requestMeasure({ read: () => null, write: () => { el.style.height = (this.cfg.imageH ?? 200) + "px"; } });
		} else if (this.kind === "image") el.style.cssText = this.cfg.imageH ? `width:100%;max-width:800px;height:${this.cfg.imageH}px;background:#556`
			: "width:100%;max-width:800px;aspect-ratio:2/1;background:#556";
		else if (this.kind === "embed" && this.cfg.embedAfterMeasure) {
			el.style.cssText = "height:24px;box-sizing:border-box;border:1px solid #556;background:#223;overflow:hidden";
			// As the picture above: its full height in the write of the measure that read one line, and no measure after it.
			view.requestMeasure({ read: () => null, write: () => { el.style.height = (this.cfg.embedH ?? 168) + "px"; } });
		} else if (this.kind === "embed") el.style.cssText = `height:${this.cfg.embedH ?? 168}px;box-sizing:border-box;border:1px solid #556;background:#223;overflow:hidden`;
		else if (this.kind === "props") el.style.cssText = `height:${this.cfg.propsH ?? 120}px;background:#334;font-size:13px;overflow:hidden`;
		else el.style.cssText = `padding:${this.cfg.calloutPad}px;border-left:4px solid #88f;background:#223`;
		el.textContent = this.body;
		return el;
	}
	get estimatedHeight(): number {
		if (this.kind === "props") return this.cfg.propsH ?? 120;
		return this.kind === "math" ? this.cfg.mathH : this.kind === "image" && this.cfg.imageH && !this.cfg.imageLateMs && !this.cfg.imageUnknown && !this.cfg.imageAfterMeasure ? this.cfg.imageH : -1;
	}
}

/** The block stand-ins: `$$` ... `$$`, a `![[...]]` line, and `> [!note]` callout lines, each one block widget. */
function blocks(cfg: DeviceConfig): StateField<DecorationSet> {
	const build = (state: EditorState): DecorationSet => {
		const b = new RangeSetBuilder<Decoration>(), doc = state.doc;
		for (let n = 1; n <= doc.lines; n++) {
			const l = doc.line(n);
			if (n === 1 && l.text === "---") {
				let m = n + 1;
				while (m <= doc.lines && doc.line(m).text !== "---") m++;
				if (m > doc.lines) break;
				b.add(l.from, doc.line(m).to, Decoration.replace({ block: true, widget: new BlockWidget("props", cfg, doc.sliceString(doc.line(n + 1).from, doc.line(m - 1).to)) }));
				n = m;
			} else if (l.text === "$$") {
				let m = n + 1;
				while (m <= doc.lines && doc.line(m).text !== "$$") m++;
				if (m > doc.lines) break;
				const body = doc.sliceString(doc.line(n + 1).from, doc.line(m - 1).to);
				b.add(l.from, doc.line(m).to, Decoration.replace({ block: true, widget: new BlockWidget("math", cfg, body) }));
				n = m;
			} else if (/^!\[\[.*\]\]$/.test(l.text)) {
				const kind = /\.(png|jpe?g|gif|webp|svg)\]\]$/i.test(l.text) ? "image" : "embed";
				b.add(l.from, l.to, Decoration.replace({ block: true, widget: new BlockWidget(kind, cfg, kind === "embed" ? "Other note" : "") }));
			} else if (l.text.startsWith("> [!")) {
				let m = n;
				while (m + 1 <= doc.lines && doc.line(m + 1).text.startsWith(">")) m++;
				const body = doc.sliceString(l.from, doc.line(m).to).replace(/^> ?/gm, "");
				b.add(l.from, doc.line(m).to, Decoration.replace({ block: true, widget: new BlockWidget("callout", cfg, body) }));
				n = m;
			}
		}
		return b.finish();
	};
	return StateField.define<DecorationSet>({ create: build, update: (d, tr) => (tr.docChanged ? build(tr.state) : d), provide: f => EditorView.decorations.from(f) });
}

/** The phrase's line as a nested list item or inside a quote: a line class on it, kept through edits. */
function phraseLine(cfg: DeviceConfig): StateField<DecorationSet> {
	const build = (state: EditorState): DecorationSet => {
		const at = state.doc.toString().indexOf(cfg.phrase);
		if (!cfg.phraseIn || at < 0) return Decoration.none;
		return Decoration.set([Decoration.line({ class: "i58-" + cfg.phraseIn }).range(state.doc.lineAt(at).from)]);
	};
	return StateField.define<DecorationSet>({ create: build, update: (d, tr) => (tr.docChanged ? build(tr.state) : d), provide: f => EditorView.decorations.from(f) });
}
/** A list item two levels in (Obsidian indents 2.25em a level); a quote's 4 px rule and 24 px indent. */
const LINE_CLASSES = EditorView.theme({ ".cm-line.i58-list": { paddingInlineStart: "4.5em" }, ".cm-line.i58-quote": { borderLeft: "4px solid #88f", paddingInlineStart: "24px" } });

function installSizer(view: EditorView): void {
	const sizer = document.createElement("div"); sizer.className = "cm-sizer";
	const container = document.createElement("div"); container.className = "cm-contentContainer";
	view.contentDOM.parentElement!.insertBefore(sizer, view.contentDOM); sizer.appendChild(container); container.appendChild(view.contentDOM);
	void view.scrollDOM.clientWidth;
}

const measureOnce = (): Promise<string> => new Promise(r => rig!.view.requestMeasure({
	read: v => [v.scrollDOM.scrollTop, v.contentHeight, v.defaultLineHeight, v.viewport.from, v.viewport.to].join(","), write: m => r(m) }));
async function idleMeasures(max = 40): Promise<number> {
	let prev: string | null = null, same = 0;
	for (let i = 0; i < max; i++) { await frame(); const m = await measureOnce(); if (m === prev) { if (++same >= 2) return i; } else same = 0; prev = m; }
	return -1;
}

function phrasePos(): number { return rig!.view.state.doc.toString().indexOf(rig!.phrase); }
/** The phrase's first client rect: the words the ink was drawn on. */
function phraseRect(): DOMRect | null {
	const { view } = rig!, pos = phrasePos();
	if (pos < 0 || pos < view.viewport.from || pos + rig!.phrase.length > view.viewport.to) return null;
	const a = view.domAtPos(pos), b = view.domAtPos(pos + rig!.phrase.length), r = document.createRange();
	r.setStart(a.node, a.offset); r.setEnd(b.node, b.offset);
	const rs = r.getClientRects(); return rs.length ? rs[0]! : null;
}
/** The text row under a screen y: "L<line> r<wrapped row>". */
function rowAt(y: number): string | null {
	const { view } = rig!;
	for (const l of Array.from(view.contentDOM.querySelectorAll(".cm-line"))) {
		const lr = l.getBoundingClientRect(); if (y < lr.top || y >= lr.bottom) continue;
		const n = view.state.doc.lineAt(view.posAtDOM(l, 0)).number, r = document.createRange(); r.selectNodeContents(l);
		const rows: number[] = [];
		for (const q of Array.from(r.getClientRects())) { if (q.height < 1) continue; const c = (q.top + q.bottom) / 2; if (!rows.some(v => Math.abs(v - c) < 4)) rows.push(c); }
		rows.sort((p, q) => p - q);
		let best = -1; for (let i = 0; i < rows.length; i++) if (best < 0 || Math.abs(rows[i]! - y) < Math.abs(rows[best]! - y)) best = i;
		return "L" + n + " r" + (best < 0 ? "?" : best);
	}
	for (const blk of Array.from(view.contentDOM.querySelectorAll(".issue58-block"))) {
		const br = blk.getBoundingClientRect(); if (y >= br.top && y < br.bottom) return "block " + blk.className.replace("issue58-block ", "");
	}
	return null;
}
/** The magenta ink's painted box and centroid, css px; green ink (B's save mark) is left out. */
function inkBox(): { x: number; y: number; left: number; top: number; right: number; bottom: number } | null {
	const cc = rig!.overlay.committedCanvas as HTMLCanvasElement | undefined;
	if (!cc || !cc.width || !cc.height) return null;
	const w = cc.width, h = cc.height;
	// An attached group's members are painted on the attached layer's pen canvas, over the committed one.
	const att = rig!.overlay.attachedLayer?.pen as HTMLCanvasElement | undefined;
	const layers = [cc, ...(att && att.width === w && att.height === h ? [att] : [])];
	let sw = 0, sx = 0, sy = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (const c of layers) {
		const d = c.getContext("2d")!.getImageData(0, 0, w, h).data;
		for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 4, a = d[i + 3]!;
			if (!a || d[i + 1]! > 90 || d[i]! < 128 || d[i + 2]! < 128) continue;
			sw += a; sx += (x + 0.5) * a; sy += (y + 0.5) * a;
			if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
		}
	}
	if (!sw) return null;
	const r = cc.getBoundingClientRect(), fx = r.width / w, fy = r.height / h;
	return { x: r.left + (sx / sw) * fx, y: r.top + (sy / sw) * fy, left: r.left + x0 * fx, top: r.top + y0 * fy, right: r.left + (x1 + 1) * fx, bottom: r.top + (y1 + 1) * fy };
}
const pen = (type: string, px: number, py: number, buttons: number): void => {
	document.elementFromPoint(px, py)?.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "pen", pointerId: 901, isPrimary: true,
		clientX: px, clientY: py, buttons, pressure: buttons ? 0.5 : 0 }));
};
function loop(cx: number, cy: number, R: number): void {
	const N = 24;
	pen("pointermove", cx + R, cy, 0);
	pen("pointerdown", cx + R, cy, 1);
	for (let i = 1; i <= N; i++) pen("pointermove", cx + R * Math.cos(2 * Math.PI * i / N), cy + R * Math.sin(2 * Math.PI * i / N), 1);
	pen("pointerup", cx + R, cy, 0);
}
/** Scroll so the phrase's line sits in the pane's upper third (the ink may be shown elsewhere; both are read). */
async function scrollToPhrase(): Promise<void> {
	const { view, pane } = rig!, pos = phrasePos();
	if (pos < 0) return;
	view.scrollDOM.scrollTop = Math.max(0, view.lineBlockAt(pos).top - pane.clientHeight / 3);
	await settle(8); await idleMeasures();
}

/** A plain text line's own horizontal padding, css px. */
function linePadX(): number | null {
	const l = rig!.view.contentDOM.querySelector(".cm-line:not(.i58-list):not(.i58-quote)");
	if (!l) return null;
	const s = getComputedStyle(l);
	return Number.parseFloat(s.paddingLeft) + Number.parseFloat(s.paddingRight);
}

/**
 * Where the phrase line's text starts across, css px from the content's left: the line's left plus its border and padding
 * (px and em parts alike, as laid out). The ink scales about the content's left and the text about this start, so between two
 * text sizes the ink sits across from its words by (ratio x this at the first size) - (this at the second): the line's fixed
 * px times (ratio - 1).
 */
function phraseLineX(): number | null {
	const { view } = rig!, pos = phrasePos();
	if (pos < 0 || pos < view.viewport.from || pos > view.viewport.to) return null;
	let node: Node | null = view.domAtPos(pos).node;
	while (node && !(node.nodeType === 1 && (node as HTMLElement).classList.contains("cm-line"))) node = node.parentNode;
	if (!node) return null;
	const el = node as HTMLElement, s = getComputedStyle(el);
	return el.getBoundingClientRect().left + Number.parseFloat(s.borderLeftWidth) + Number.parseFloat(s.paddingLeft) - view.contentDOM.getBoundingClientRect().left;
}

/**
 * The first frame that paints the open note's ink, read after that frame's callbacks (the overlay's frame callbacks and the
 * resize observers have run): what the eye sees at open. Beside it, for the record only, the older read made inside a frame
 * callback, before the overlay's own callbacks in that frame. Null when no frame in 60 painted it.
 */
async function firstPaint(view: EditorView, pane: HTMLElement, cfg: DeviceConfig): Promise<Record<string, unknown> | null> {
	let inFrame: Record<string, unknown> | null = null;
	const ready = (): boolean => {
		const ov = overlayForPath(PATH);
		if (!ov || inlineInk.strokes(PATH).length === 0) return false;
		rig = { view, overlay: ov, pane, phrase: cfg.phrase, cfg };
		return !!inkBox() && !!phraseRect();
	};
	for (let i = 0; i < 60; i++) {
		await frame();
		if (cfg.measure) wrapBoxes(view);
		if (!inFrame && ready()) inFrame = read("first paint, in frame");
		await new Promise<void>(r => setTimeout(r, 0));
		if (ready()) {
			const first = { ...read("first paint"), inFrame, frame: i, t: performance.now() };
			if (!cfg.measure) return first;
			// Measure: the frames after the first paint, one after-callbacks read each, ink and phrase only.
			const trail: Record<string, unknown>[] = [];
			for (let k = 1; k <= 40; k++) { await painted(); trail.push({ k, ...trailRead() }); }
			return { ...first, trail };
		}
	}
	return null;
}

/** The function names that called the wrapped call, nearest first (the bundle keeps them). */
function callers(): string {
	const st = (new Error().stack ?? "").split("\n").slice(2, 10);
	return st.map(l => l.trim().replace(/^at /, "").replace(/ \(.*$/, "")).join(" < ");
}
/** Measure: CodeMirror's measure loop, wrapped once per view: when each runs, logged beside the repaints. */
function wrapMeasure(view: EditorView): void {
	const v = view as Any;
	if (v.__i58Measure) return;
	v.__i58Measure = true;
	const m = v.measure;
	v.measure = function (this: Any, ...args: unknown[]) {
		const t0 = performance.now(), out = m.apply(this, args);
		if (paints.length < 400) paints.push({ cm: true, t: t0, t1: performance.now() });
		return out;
	};
}
/** Measure: the overlay's repaints since the mount, each read just after it ran. */
let paints: Record<string, unknown>[] = [];
let wrapped: Any = null;
/** The open note's overlay repaint, wrapped once per mount: the call runs as before, then one row is logged. */
function wrapRepaint(view: EditorView | null): void {
	// On the class, once per page: the overlay's first repaint can run before it is registered for the path.
	const proto = InkOverlayPlugin.prototype as Any;
	wrapped = true;
	if (proto.__i58Repaint) return;
	proto.__i58Repaint = true;
	const orig = proto.repaint;
	proto.repaint = function (this: Any, ...args: unknown[]) {
		const out = orig.apply(this, args);
		const v: EditorView | null = this.view ?? rig?.view ?? view ?? null;
		if (paints.length < 400) paints.push(v ? { ...repaintRow(v, this), from: callers(), pathNow: overlayForPath(PATH) === this } : { t: performance.now(), noView: true, from: callers() });
		if (v) wrapBoxes(v);
		return out;
	};
}
/**
 * The anchors' box reads, logged beside the repaints: when each lands and what it read. Wrapped once their state exists (never
 * made here: the getter that makes it is not called).
 */
let boxesWrapped: Any = null;
function wrapBoxes(view: EditorView): void {
	const ov = overlayForPath(PATH) as Any, la = ov && ov.lineAnchorState;
	if (!la || la === boxesWrapped || typeof la.boxesRead !== "function") return;
	boxesWrapped = la;
	const boxes = la.boxesRead;
	la.boxesRead = function (this: Any, path: string, src: unknown, tops: Map<number, number>, reads: number) {
		// Before the read: per line the height map's top, the epoch's cached top, the box on record; the epochs and the flag.
		const lay = typeof this.layout === "function" ? this.layout() : null;
		const pre = Array.from(tops.keys()).map(n => ({ n, map: lay ? lay.lineTop(n) : null, px: lay ? lay.pxPerWorld : null, cached: this.tops?.get(n) ?? null, old: this.boxTops?.get(n) ?? null }));
		const pre2 = { topsEpoch: this.topsEpoch, layoutEpoch: this.layoutEpoch, epoch: this.epoch, answeredDropped: this.answeredDropped };
		const out = boxes.call(this, path, src, tops, reads);
		if (paints.length < 400) paints.push({ box: true, t: performance.now(), tops: Array.from(tops.entries()), reads, moved: out, pre, pre2, cmTop: phrasePos() < 0 ? null : view.lineBlockAt(phrasePos()).top });
		return out;
	};
}
/** Reads with no write: the anchors' state as is (never the getter that makes it), the memo of the first stroke's correction. */
function repaintRow(view: EditorView, ov: Any): Record<string, unknown> {
	const strokes = inlineInk.strokes(PATH), first = strokes[0] as Any, a = first && first.lineAnchor;
	const la = ov.lineAnchorState as Any, memo = la && first ? la.dys?.get(first) : undefined;
	const n = a && Number.isInteger(a.line) && a.line >= 1 && a.line <= view.state.doc.lines ? a.line : null;
	return {
		t: performance.now(), strokes: strokes.length,
		dyMemo: memo ? memo.dy : null, dyEpoch: memo ? memo.epoch : null, laEpoch: la ? la.epoch : null,
		sigW: la?.sig ? la.sig.width : null, sigFont: la?.sig ? la.sig.fontPx : null,
		clientW: view.contentDOM.clientWidth, columnHeld: ov.columnHeld ?? null,
		anchorLine: a ? a.line : null, anchorTop: a ? a.top : null, anchorW: a ? a.width : null, anchorFont: a ? a.fontPx : null,
		cmTop: n ? view.lineBlockAt(view.state.doc.line(n).from).top : null,
		boxTop: la && n ? la.boxTops?.get(n) ?? null : null,
		boxLater: la && a ? la.boxLater?.has(a) ?? null : null, boxHeld: la && first ? la.boxHeld?.has(first) ?? null : null,
		vouched: la && first ? la.vouched?.has(first) ?? null : null,
	};
}
/** Measure: the ink's and phrase's place after a frame, with the memo of the first stroke's correction (no read that writes). */
function trailRead(): Record<string, unknown> {
	const { view, overlay } = rig!, ink = inkBox(), pr = phraseRect();
	const textX = pr ? (pr.left + pr.right) / 2 : null, textY = pr ? (pr.top + pr.bottom) / 2 : null;
	const first = inlineInk.strokes(PATH)[0] as Any, la = overlay.lineAnchorState as Any, memo = la && first ? la.dys?.get(first) : undefined;
	return {
		t: performance.now(), offX: ink && textX !== null ? ink.x - textX : null, offY: ink && textY !== null ? ink.y - textY : null,
		dyMemo: memo ? memo.dy : null, clientW: view.contentDOM.clientWidth, columnHeld: overlay.columnHeld ?? null,
		cmTop: phrasePos() < 0 ? null : view.lineBlockAt(phrasePos()).top,
	};
}

function read(phase: string): Record<string, unknown> {
	const { view, overlay, pane } = rig!, ink = inkBox(), pr = phraseRect();
	// The first stroke is device A's magenta loop: a save mark is always added after it.
	const first = inlineInk.strokes(PATH)[0] as Any;
	const a = first && first.lineAnchor, sig = overlay.lineAnchors ? overlay.lineAnchors.sig : null;
	const dy = first && overlay.lineAnchorDy ? overlay.lineAnchorDy(first) : null;
	const textX = pr ? (pr.left + pr.right) / 2 : null, textY = pr ? (pr.top + pr.bottom) / 2 : null;
	return {
		phase, saves, strokes: inlineInk.strokes(PATH).length, canvasMode: !!overlay.canvasMode,
		inkX: ink ? ink.x : null, inkY: ink ? ink.y : null, inkBox: ink ? [ink.left, ink.top, ink.right, ink.bottom] : null,
		textX, textY, phraseLine: phrasePos() < 0 ? null : view.state.doc.lineAt(phrasePos()).number,
		offX: ink && textX !== null ? ink.x - textX : null, offY: ink && textY !== null ? ink.y - textY : null,
		under: ink ? rowAt(ink.y) : null, own: textY === null ? null : rowAt(textY),
		anchorLine: a ? a.line : null, anchorW: a ? a.width : null, anchorFont: a ? a.fontPx : null, anchorTop: a ? a.top : null,
		dy, bboxY: first ? first.bbox.y : null, bboxX: first ? first.bbox.x : null,
		sigW: sig ? sig.width : null, sigFont: sig ? sig.fontPx : null,
		columnRefPx: inlineInk.columnRefPx(PATH), fontRefPx: inlineInk.fontRefPx(PATH),
		columnHeld: overlay.columnHeld ?? null, columnCapped: overlay.columnCapped ?? null,
		clientW: view.contentDOM.clientWidth, paneW: pane.clientWidth, fontCss: getComputedStyle(view.contentDOM).fontSize,
		fontZoom: overlay.fontZoom, cssScale: overlay.cssScale, layoutFont: overlay.lastFontStr, syncFont: overlay.lastSyncFontStr, zoom: overlay.pinchScaleNow,
		// The phrase line's top as the editor's height map has it and as the page lays it out (both document px).
		cmTop: phrasePos() < 0 ? null : view.lineBlockAt(phrasePos()).top,
		domTop: pr ? pr.top - view.documentTop : null,
		linePadX: linePadX(), lineX: phraseLineX(), groups: inlineInk.attachments(PATH).length, scrollTop: view.scrollDOM.scrollTop, scrollLeft: view.scrollDOM.scrollLeft,
		dpr: window.devicePixelRatio, inner: [window.innerWidth, window.innerHeight], ua: navigator.userAgent.slice(0, 80),
		blocks: Array.from(view.contentDOM.querySelectorAll(".issue58-block")).map(b => { const r = b.getBoundingClientRect(); return b.className.replace("issue58-block ", "") + " " + r.width.toFixed(1) + "x" + r.height.toFixed(1); }),
	};
}

(window as Any).issue58 = {
	async mount(cfg: DeviceConfig): Promise<Record<string, unknown>> {
		Object.assign(Platform, cfg.mobile
			? { isMobile: true, isDesktop: false, isIosApp: false, isAndroidApp: true, isDesktopApp: false, isMobileApp: true, isPhone: true, isTablet: false, isWin: false }
			: { isMobile: false, isDesktop: true, isIosApp: false, isAndroidApp: false, isDesktopApp: true, isMobileApp: false, isPhone: false, isTablet: false, isWin: true });
		installObsidianDom();
		if (!hostAttached) {
			hostAttached = true;
			inlineInk.attachHost({ readPageId: (p: string) => ids.get(p) ?? null, claimId: async (p: string, id: string) => { ids.set(p, id); return { pageId: id }; },
				loadSidecar: async (id: string) => (sidecars.has(id) ? parsePage(sidecars.get(id)!, id) : null), scheduleSidecar: save,
				scheduleSidecarNow: async (id: string, p: Any) => save(id, p), notify: () => {} } as Any);
		}
		if (cfg.path) PATH = cfg.path;
		if (cfg.pageId && cfg.sidecar) { ids.set(PATH, cfg.pageId); sidecars.set(cfg.pageId, cfg.sidecar); }
		setPenInk(true); setScrollExpansionEnabled(cfg.canvas);
		setInlineTool("pen"); setInkColorHex("pen", "#ff00ff"); setInkSizeMult("pen", 4);
		paints = []; wrapped = null; boxesWrapped = null;
		if (cfg.measure) wrapRepaint(null);
		const pane = document.body.appendChild(document.createElement("div"));
		pane.className = "markdown-source-view mod-cm6";
		pane.style.cssText = `position:relative;width:${cfg.paneW}px;height:${cfg.paneH}px;overflow:hidden` + (cfg.hidden ? ";display:none" : "");
		const view = new EditorView({ parent: pane, state: EditorState.create({ doc: cfg.text, extensions: [history(), EditorView.lineWrapping, blocks(cfg),
			phraseLine(cfg), LINE_CLASSES, ...(cfg.linePad !== undefined ? [EditorView.theme({ ".cm-line": { paddingLeft: cfg.linePad + "px", paddingRight: cfg.linePad + "px" } })] : []),
			editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path: PATH }, editor: {} })), inkOverlayExtension(),
			sizeTheme.of(sizeRule(cfg.paneW, cfg.paneH)),
			fontTheme.of(fontRule(cfg.fontPx, cfg.fontFamily))] }) });
		installSizer(view);
		if (cfg.measure) { wrapMeasure(view); paints.push({ cm: true, t: performance.now(), t1: performance.now(), mountWrapped: !!wrapped, strokes: inlineInk.strokes(PATH).length }); }
		// Hidden at mount: the ink arrives with no box, then the pane is shown.
		let hiddenArrived: boolean | null = null;
		if (cfg.hidden) {
			for (let i = 0; i < 60 && cfg.sidecar && inlineInk.strokes(PATH).length === 0; i++) await frame();
			await settle(8);
			hiddenArrived = inlineInk.strokes(PATH).length > 0;
			pane.style.display = "";
		}
		// The first frame that paints the opened ink, read before any settle.
		const first = cfg.sidecar ? await firstPaint(view, pane, cfg) : null;
		await settle(12);
		const overlay = overlayForPath(PATH);
		if (!overlay) throw new Error("no overlay for " + PATH);
		rig = { view, overlay, pane, phrase: cfg.phrase, cfg };
		// Opened bytes: wait for the ink to arrive and the column hold and anchors to settle under it.
		if (cfg.sidecar) for (let i = 0; i < 60 && inlineInk.strokes(PATH).length === 0; i++) await frame();
		await settle(12);
		const idle = await idleMeasures();
		await scrollToPhrase();
		await settle(8);
		return { idle, first, hiddenArrived, ...read("open"), ...(cfg.measure ? { paints, openT: performance.now() } : {}) };
	},
	/** This device's pane width changed (a window resize, a sidebar), nothing else. */
	async setPane(w: number): Promise<Record<string, unknown>> {
		const { view, pane, cfg } = rig!;
		pane.style.width = w + "px";
		view.dispatch({ effects: sizeTheme.reconfigure(sizeRule(w, cfg.paneH)) });
		view.requestMeasure();
		await settle(12); await idleMeasures();
		await scrollToPhrase();
		await settle(8);
		return read("pane " + w);
	},
	/** Device A: one magenta loop on the phrase, then the save it asks for. */
	async draw(): Promise<Record<string, unknown>> {
		await scrollToPhrase();
		const pr = phraseRect();
		if (!pr) throw new Error("phrase not drawn");
		const atPen = read("pen"), blocksAtPen = atPen.blocks, topsAtPen = [atPen.cmTop, atPen.domTop];
		loop((pr.left + pr.right) / 2, (pr.top + pr.bottom) / 2, 12);
		await settle(16); await idleMeasures(); await settle(8);
		return { ...read("drawn"), blocksAtPen, topsAtPen };
	},
	/**
	 * Device A attaches its magenta loop to the phrase's paragraph, as Attach records it: the paragraph as the target, its
	 * reference point read through the layout, the layout's width and font, and the stroke's first point as the probe.
	 */
	async attachFirst(): Promise<Record<string, unknown>> {
		const { view, overlay } = rig!, doc = view.state.doc, text = doc.toString(), l = doc.lineAt(phrasePos());
		const s = inlineInk.strokes(PATH)[0] as Any, sig = overlay.lineAnchors?.sig;
		if (!s || !sig) throw new Error("no stroke or no signature to attach under");
		const ref = await new Promise<{ x: number; y: number } | null>(r => view.requestMeasure({ read: () => overlay.followRefAt(l.from), write: r }));
		if (!ref) throw new Error("no reference point for the phrase's paragraph");
		const rec = { v: 1, id: "i58-group", strokeIds: [s.id],
			target: { kind: "paragraph", from: l.from, to: l.to, text: l.text, before: text.slice(Math.max(0, l.from - 32), l.from).replace(/\s+/g, " "),
				after: text.slice(l.to, l.to + 32).replace(/\s+/g, " ") },
			ref: { x: ref.x, y: ref.y }, layout: { width: sig.width, font: sig.fontPx }, probe: { id: s.id, x: s.points[0].x, y: s.points[0].y } };
		inlineInk.setAttachments(PATH, [rec as Any], true);
		await settle(16); await idleMeasures();
		await scrollToPhrase();
		return { attached: inlineInk.attachments(PATH).length, ...read("attached") };
	},
	/**
	 * Canvas off, the pane put at the room edge of the column the ink's size ratio asks (the note's width x the ratio, plus
	 * the chrome, plus half a scrollbar) and its height at the note's height there, so the note's height decides the
	 * scrollbar and the scrollbar decides the room. Counts the held column's changes over 40 painted frames.
	 */
	async roomEdge(): Promise<Record<string, unknown>> {
		const { view, pane, overlay, cfg } = rig!;
		// A classic scrollbar that takes room (headless Chromium's own takes none), on the scroller and on the probe.
		const bar = document.head.appendChild(document.createElement("style"));
		bar.textContent = ".cm-scroller::-webkit-scrollbar, .i58-probe::-webkit-scrollbar { width: 14px } .cm-scroller::-webkit-scrollbar-thumb { background: #888 }";
		view.requestMeasure();
		await settle(4);
		const probe = document.body.appendChild(document.createElement("div"));
		probe.className = "i58-probe";
		probe.style.cssText = "position:absolute;width:100px;height:100px;overflow:scroll;visibility:hidden";
		const sbw = probe.offsetWidth - probe.clientWidth; probe.remove();
		const ref = inlineInk.columnRefPx(PATH) ?? 0, chrome = overlay.columnFit?.chrome ?? 0, scaled = ref * overlay.fontZoom;
		const w = Math.round(scaled + chrome + sbw / 2);
		pane.style.width = w + "px";
		view.dispatch({ effects: sizeTheme.reconfigure(sizeRule(w, cfg.paneH)) });
		await settle(8); await idleMeasures();
		const h = Math.round(view.contentHeight);
		pane.style.height = h + "px";
		view.dispatch({ effects: sizeTheme.reconfigure(sizeRule(w, h)) });
		const seen: string[] = [];
		for (let i = 0; i < 40; i++) { await painted(); seen.push([overlay.columnHeld ?? null, overlay.columnCapped ?? false].join("/")); }
		let changes = 0; for (let i = 1; i < seen.length; i++) if (seen[i] !== seen[i - 1]) changes++;
		const lastChange = seen.reduce((k, v, i) => (i && v !== seen[i - 1] ? i : k), 0);
		await idleMeasures(); await scrollToPhrase(); await settle(8);
		return { sbw, edgeW: w, edgeH: h, scaled, changes, lastChange, seen: seen.slice(0, 12), ...read("room edge") };
	},
	/** An ordinary save with no edit to the first stroke: a small green mark on the last line. */
	async saveMark(): Promise<Record<string, unknown>> {
		const { view } = rig!, last = view.state.doc.line(view.state.doc.lines);
		view.scrollDOM.scrollTop = view.lineBlockAt(last.from).top;
		await settle(8); await idleMeasures();
		const c = view.coordsAtPos(last.from);
		if (!c) throw new Error("last line not drawn");
		setInkColorHex("pen", "#00ff00");
		loop(c.left + 40, (c.top + c.bottom) / 2, 6);
		setInkColorHex("pen", "#ff00ff");
		await settle(16); await idleMeasures();
		await scrollToPhrase();
		return read("saved");
	},
	/** Text typed at the start of the line n lines above the phrase's line, plus a blank line. */
	async typeAbove(n: number, text: string): Promise<Record<string, unknown>> {
		const { view } = rig!, line = view.state.doc.lineAt(phrasePos()).number - n;
		view.dispatch({ changes: { from: view.state.doc.line(line).from, insert: text + "\n\n" }, userEvent: "input.type" });
		await settle(12); await idleMeasures();
		await scrollToPhrase();
		return read("typed");
	},
	/** This device's own text size changed (Obsidian's font size setting), nothing else. */
	async setFont(px: number): Promise<Record<string, unknown>> {
		const { view, cfg } = rig!;
		view.dispatch({ effects: fontTheme.reconfigure(fontRule(px, cfg.fontFamily)) });
		view.requestMeasure();
		await settle(12); await idleMeasures();
		await scrollToPhrase();
		await settle(8);
		return read("font " + px);
	},
	/**
	 * This device's own text size changed by the css variable alone: no editor transaction, so the overlay hears it only
	 * through the content's own resize (its content observer), never through the editor's update.
	 */
	async setFontCss(px: number): Promise<Record<string, unknown>> {
		const ov = rig!.overlay, layoutBefore = ov.lastFontStr;
		// Which reader took the new size first: the layout read as it stood when the sync path (the content's resize) took
		// it. Read there, not once settled: a held column written on the size change resizes the pane, which runs the layout
		// read after the sync path already had the size.
		let syncStr = ov.lastSyncFontStr, layoutAtSync: unknown = "sync path never took it";
		Object.defineProperty(ov, "lastSyncFontStr", { configurable: true, get: () => syncStr,
			set: (v) => { if (v !== syncStr && layoutAtSync === "sync path never took it") layoutAtSync = ov.lastFontStr; syncStr = v; } });
		document.body.style.setProperty("--i58-font-size", px + "px");
		await settle(12); await idleMeasures();
		const layoutAfterChange = ov.lastFontStr;
		delete ov.lastSyncFontStr; ov.lastSyncFontStr = syncStr;
		await scrollToPhrase();
		await settle(8);
		return { layoutBefore, layoutAtSync, layoutAfterChange, ...read("font css " + px) };
	},
	/** The note zoomed to k (Infinite Canvas on): the zoom bar's step. */
	async zoom(k: number): Promise<Record<string, unknown>> {
		const { overlay } = rig!;
		const stepped = overlay.zoomNoteBy(k / overlay.pinchScaleNow);
		await settle(16); await idleMeasures(); await settle(8);
		return { stepped, ...read("zoom " + k) };
	},
	/**
	 * The text size changes while a pen is down (a green stroke beside the phrase, left out of the ink read), then the pen
	 * lifts. Reads the held column before, while down after the change, and the arrived layout after the lift.
	 */
	async contactFont(px: number): Promise<Record<string, unknown>> {
		const { view, overlay, cfg } = rig!;
		await scrollToPhrase();
		const pr = phraseRect();
		if (!pr) throw new Error("phrase not drawn");
		const x = pr.right + 60, y = (pr.top + pr.bottom) / 2, strokesBefore = inlineInk.strokes(PATH).length;
		const heldBefore = overlay.columnHeld ?? null;
		setInkColorHex("pen", "#00ff00");
		pen("pointermove", x, y, 0);
		pen("pointerdown", x, y, 1);
		for (let i = 1; i <= 6; i++) pen("pointermove", x + i * 3, y + i, 1);
		view.dispatch({ effects: fontTheme.reconfigure(fontRule(px, cfg.fontFamily)) });
		view.requestMeasure();
		await settle(12);
		const heldDown = overlay.columnHeld ?? null, fontDown = getComputedStyle(view.contentDOM).fontSize;
		for (let i = 7; i <= 12; i++) pen("pointermove", x + i * 3, y + i, 1);
		pen("pointerup", x + 36, y + 12, 0);
		setInkColorHex("pen", "#ff00ff");
		await settle(16); await idleMeasures();
		await scrollToPhrase();
		await settle(8);
		return { heldBefore, heldDown, fontDown, strokesAdded: inlineInk.strokes(PATH).length - strokesBefore, ...read("contact font " + px) };
	},
	/**
	 * The same pane switches to another note (its text, path, page id and ink file): Obsidian reuses the editor. Reads the
	 * new note's first painted frame and its arrived layout.
	 */
	async switchTo(next: { text: string; path: string; pageId: string | null; sidecar: string | null }): Promise<Record<string, unknown>> {
		const { view, pane, cfg } = rig!;
		if (next.pageId && next.sidecar) { ids.set(next.path, next.pageId); sidecars.set(next.pageId, next.sidecar); }
		PATH = next.path;
		view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next.text },
			effects: setBrowserEditorInfo.of({ app: { commands: { executeCommandById: () => false } }, file: { path: next.path }, editor: {} } as Any) });
		const first = await firstPaint(view, pane, cfg);
		await settle(12);
		for (let i = 0; i < 60 && inlineInk.strokes(PATH).length === 0; i++) await frame();
		const overlay = overlayForPath(PATH);
		if (!overlay) throw new Error("no overlay for " + PATH);
		rig = { view, overlay, pane, phrase: cfg.phrase, cfg };
		await settle(12); await idleMeasures();
		await scrollToPhrase();
		await settle(8);
		return { first, ...read("switched") };
	},
	/** The bytes this device would sync: the note's text, its page id and its ink file as last saved. */
	bytes(): { text: string; pageId: string | null; sidecar: string | null; saves: number } {
		const id = ids.get(PATH) ?? null;
		return { text: rig!.view.state.doc.toString(), pageId: id, sidecar: id ? sidecars.get(id) ?? null : null, saves };
	},
};
