/**
 * Insert space on a heavy page: ink below the divider moves and ink above it
 * stays, however much writing the page holds; and the labels at the divider
 * start inside the pane on a note that scrolls sideways.
 *
 * The page is generated here with the shape of a heavy imported note (19,736
 * strokes): a column of short items (dashes, two-letter words) above one low,
 * wide drawing at its foot, a column of writing beside it, and a larger
 * drawing to the right. On that note the floating-mark pass let the low
 * drawing take the item above it, then judged it grown, so it took the next
 * item too, and so on up the page, until one row ran from near the note's top
 * to near its bottom. A divider anywhere then moved that whole row (ink above
 * the line went with it) or kept it (ink below the line stayed), and the
 * preview drew it that way.
 *
 * Every divider below sits in a gap between lines that no stroke crosses, so
 * the strokes that should move are exactly the strokes wholly below it.
 *
 * Label rig: the REAL InkOverlayPlugin.prototype queueSpaceFeedback,
 * planSpace, previewSpace and redrawSelectionUI with the REAL inlineInk store
 * (memory mode), as SpaceHoverSkip.test.ts builds it, and the REAL
 * TailRenderer.drawSpaceLabel on a context that tracks its transform.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { InsertSpaceRows, strokeIdsBelow } from "./InsertSpace";
import { InkOverlayPlugin, inlineInk } from "./InkOverlay";
import type { InlineInkHost } from "./InlineInkStore";
import type { InkStroke } from "../ink/Stroke";
import { translateStroke } from "../objects/Selection";
import { TailRenderer } from "../ink/TailRenderer";
import { resetTipModeForTest, setTipMode } from "./TipMode";

function mk(id: string, x0: number, y0: number, x1: number, y1: number): InkStroke {
	const points = [{ x: x0, y: y0, pressure: 0.5, t: 0 }, { x: x1, y: y1, pressure: 0.5, t: 8 }];
	return {
		id, tool: "pen", color: "#000000", width: 2, points,
		bbox: { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) },
		createdAt: 0,
	};
}

const LINES = 200;
/** Line i's ink sits in the 22 px above this y; the 18 px below it are clear in every column. */
const baseOf = (i: number) => 100 + 40 * i + 20;
/** Dividers: in the clear gap under every tenth line, except line 105's, which the large drawing spans. */
const DIVIDERS = Array.from({ length: 20 }, (_, k) => 5 + 10 * k).filter(i => i !== 105).map(i => baseOf(i) + 3);

/** The heavy page: ids of its two drawings and its strokes, in a store order that is not spatial order. */
function heavyPage(): { strokes: InkStroke[]; drawing: string[]; seed: string[] } {
	let s = 7;
	const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
	const out: InkStroke[] = [];
	let n = 0;
	for (let i = 0; i < LINES; i++) {
		const base = baseOf(i);
		// Writing from x 700: words of three to five joined letters, a dot over some letters, ending before x 1250.
		let x = 700 + rnd() * 10;
		for (let w = 0; w < 6 && x < 1180; w++) {
			for (let k = 3 + Math.floor(rnd() * 3); k > 0; k--) {
				const h = 8 + rnd() * 9, width = 6 + rnd() * 6;
				out.push(mk(`w${n++}`, x, base - h, x + width, base));
				if (rnd() < 0.15) { const dx = x + rnd() * width; out.push(mk(`d${n++}`, dx, base - h - 5, dx + 1.5, base - h - 2)); }
				x += width + 1;
			}
			x += 8 + rnd() * 10;
		}
		// The item column, x 120 to 580: a dash or a two-letter word.
		const ix = 120 + rnd() * 380;
		if (rnd() < 0.5) out.push(mk(`m${n++}`, ix, base - 6, ix + 12, base - 4));
		else out.push(mk(`i${n++}`, ix, base - 10, ix + 18, base), mk(`i${n++}`, ix + 20, base - 10, ix + 40, base));
	}
	// The low wide drawing under the item column: 26 strokes, 476 by 75, 20 px under the last line.
	const top = baseOf(LINES - 1) + 20, seed: string[] = [];
	for (let k = 0; k < 26; k++) { const x0 = 100 + k * 456 / 25; seed.push(`s${k}`); out.push(mk(`s${k}`, x0, top, x0 + 20, top + 75)); }
	// The large drawing to the right: 235 strokes, about 300 by 290, across lines 100 to 107.
	const drawing: string[] = [];
	for (let k = 0; k < 235; k++) { const x0 = 1700 + k * 1.2; drawing.push(`g${k}`); out.push(mk(`g${k}`, x0, baseOf(100) - 20, x0 + 20, baseOf(100) + 270)); }
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rnd() * (i + 1));
		[out[i], out[j]] = [out[j]!, out[i]!];
	}
	return { strokes: out, drawing, seed };
}

const topOf = (s: InkStroke) => Math.min(...s.points.map(p => p.y));
const bottomOf = (s: InkStroke) => Math.max(...s.points.map(p => p.y));

describe("insert space on a heavy page", () => {
	it("premise: the page is heavy, and no stroke crosses any divider", () => {
		const { strokes } = heavyPage();
		expect(strokes.length).toBeGreaterThan(4000);
		expect(DIVIDERS.length).toBe(19);
		for (const y of DIVIDERS) expect(strokes.filter(s => topOf(s) < y && bottomOf(s) > y).map(s => s.id), `divider ${y}`).toEqual([]);
	});

	it("the largest row is the large drawing, 235 strokes, not the item column under one row", () => {
		const { strokes, drawing } = heavyPage();
		const rows = new InsertSpaceRows().get(strokes);
		const largest = rows.reduce((a, b) => (b.ids.length > a.ids.length ? b : a));
		expect(largest.ids.length, `largest row y ${largest.top}..${largest.bottom}`).toBe(235);
		expect([...largest.ids].sort()).toEqual([...drawing].sort());
	});

	it("at every divider the strokes that move are exactly the strokes wholly below it", () => {
		const { strokes } = heavyPage();
		const rows = new InsertSpaceRows().get(strokes);
		const wrong: string[] = [];
		for (const y of DIVIDERS) {
			const moving = new Set(strokeIdsBelow(strokes, y, rows));
			const below = new Set(strokes.filter(s => topOf(s) >= y).map(s => s.id));
			const above = [...moving].filter(id => !below.has(id)).length, kept = [...below].filter(id => !moving.has(id)).length;
			if (above || kept) wrong.push(`y ${y}: ${above} above the line move, ${kept} below it stay`);
		}
		expect(wrong).toEqual([]);
	});

	it("the rows shifted after an insert equal a rebuild", () => {
		const { strokes } = heavyPage();
		const cache = new InsertSpaceRows(), before = cache.get(strokes);
		const ids = strokeIdsBelow(strokes, DIVIDERS[9]!, before), steps = [7.5, 11.25, 5.25];
		const wanted = new Set(ids);
		for (const d of steps) for (const s of strokes) if (wanted.has(s.id)) translateStroke(s, 0, d);
		cache.shift(strokes, before, ids, steps);
		expect(cache.get(strokes)).toEqual(new InsertSpaceRows().get(strokes));
	});
});

// ---- the labels -----------------------------------------------------------------

const BODY = 24;
let serial = 0;
const paths = new Set<string>();
beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	resetTipModeForTest();
});
afterEach(() => {
	for (const p of paths) inlineInk.handleDelete(p);
	paths.clear();
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	resetTipModeForTest();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

interface FakeLine { nodeType: 1; top: number; closest(sel: string): FakeLine | null; getBoundingClientRect(): { top: number; left: number } }
type LabelCall = { label: string; landing: boolean; cssScale: number; left: number | undefined; y: number };

/** A note of one-line paragraphs scrolled `scrollLeft` sideways, its band's left edge at `bandLeft`; labels recorded. */
async function labelRig(scrollLeft: number, bandLeft: number) {
	const path = `space-label-left-${++serial}.md`;
	paths.add(path);
	await inlineInk.ensureLoaded(path);
	const text = Array.from({ length: 40 }, (_, i) => `paragraph ${i + 1}`).join("\n\n") + "\n";
	const state = EditorState.create({ doc: text });
	const rowOf = (n: number) => {
		const line = state.doc.line(n), top = (n - 1) * BODY;
		const el: FakeLine = {
			nodeType: 1, top,
			closest(sel: string) { return sel === ".cm-line" ? this : null; },
			getBoundingClientRect() { return { top: this.top, left: 0 }; },
		};
		return { n, from: line.from, to: line.to, top, el };
	};
	const rowAtY = (y: number) => rowOf(Math.min(state.doc.lines, Math.max(1, Math.floor(y / BODY) + 1)));
	const rowAtPos = (pos: number) => rowOf(state.doc.lineAt(pos).number);
	const pending: FrameRequestCallback[] = [];
	const fakeWin = {
		getComputedStyle: () => ({ lineHeight: `${BODY}px` }),
		requestAnimationFrame: (cb: FrameRequestCallback) => { pending.push(cb); return pending.length; },
		cancelAnimationFrame() {},
	};
	const view = {
		get state() { return state; },
		dom: { isConnected: true, ownerDocument: { defaultView: fakeWin } },
		scrollDOM: { scrollLeft, scrollTop: 0, clientWidth: 900, clientHeight: 1200 },
		contentDOM: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
		documentTop: 0, scaleX: 1, scaleY: 1, defaultLineHeight: BODY,
		posAtCoords: ({ y }: { x: number; y: number }) => rowAtY(y).from,
		coordsAtPos: (pos: number) => { const r = rowAtPos(pos); return { top: r.top, bottom: r.top + BODY, left: 0, right: 0 }; },
		domAtPos: (pos: number) => ({ node: rowAtPos(pos).el, offset: 0 }),
		lineBlockAt: (pos: number) => { const r = rowAtPos(pos); return { from: r.from, to: r.to, top: r.top, bottom: r.top + BODY, height: BODY }; },
	};
	const labels: LabelCall[] = [];
	const tail = {
		configureInlineBacking: () => undefined,
		placeInline: () => undefined,
		restoreFullSurface: () => undefined,
		prepareLive: () => undefined,
		clearAll() {},
		drawLasso() {},
		drawSpaceStroke() { return true; },
		spaceStrokeOnScreen: () => true,
		drawSpaceDivider() {},
		drawSpaceLabel(_cam: unknown, y: number, label: string, _color: string, scale: number, landing = false, left?: number) {
			labels.push({ label, landing, cssScale: scale, left, y });
		},
		drawSelectionBox() {},
		drawHead() {},
	};
	const overlay = Object.create(InkOverlayPlugin.prototype) as any;
	Object.assign(overlay, {
		view, container: {}, tail, scale: 1, cssScale: 1, contentStyle: undefined,
		band: { left: bandLeft, top: -240, width: 900 + 2 * (scrollLeft - bandLeft), height: 1680 },
		cssWidth: 900 + 2 * (scrollLeft - bandLeft), cssHeight: 1680, mode: "ink", lassoActive: false, lassoPts: [], builder: null,
		spaceTextEnd: null, spacePreview: null, spacePlan: null, spaceHoverY: null, spaceFeedbackRaf: null,
		spaceRowsCache: null, spaceLineY: null, spaceTotalDy: 0,
		filePath: () => path,
		camera: { screenToWorld: (x: number, y: number) => ({ x, y }), snapshot: { x: 0, y: 0, zoom: 1 } },
		selection: { bounds: () => null },
	});
	inlineInk.applyAddLive(path, [mk("above", 300, 10, 320, 18), mk("below", 300, 200, 320, 208)]);
	return {
		overlay, labels,
		hover(worldY: number) { overlay.queueSpaceFeedback(worldY); },
		frame() { for (const cb of pending.splice(0)) cb(0); },
	};
}

/** Where drawSpaceLabel's first text starts, in the tail's css px, read from a context that tracks translate and scale. */
function textStart(call: LabelCall): number {
	const m = { sx: 1, tx: 0 }, stack: { sx: number; tx: number }[] = [], xs: number[] = [];
	const ctx = new Proxy({}, {
		get(_t, prop) {
			if (prop === "save") return () => void stack.push({ ...m });
			if (prop === "restore") return () => void Object.assign(m, stack.pop());
			if (prop === "translate") return (x: number) => void (m.tx += m.sx * x);
			if (prop === "scale") return (x: number) => void (m.sx *= x);
			if (prop === "fillText") return (_s: string, x: number) => void xs.push(m.tx + m.sx * x);
			return () => undefined;
		},
		set() { return true; },
	});
	const tail = new TailRenderer({ getContext: () => ctx } as unknown as HTMLCanvasElement);
	tail.drawSpaceLabel({ x: 0, y: 0, zoom: 1 }, call.y, call.label, "#000", call.cssScale, call.landing, call.left);
	expect(xs.length, "one text drawn").toBe(1);
	return xs[0]!;
}

describe("insert space labels start at the pane's left edge", () => {
	it("on a note scrolled sideways, the hover label and the release label start inside the pane", async () => {
		setTipMode("space");
		// The band reaches 320 px left of the pane, the widest margin a band takes.
		const r = await labelRig(2000, 1680);
		r.hover(100); r.frame();
		expect(r.overlay.spacePreview, "premise: the hover drew a preview").toBeTruthy();
		r.overlay.spacePlan = r.overlay.spacePreview.plan;
		r.overlay.spaceLineY = r.overlay.spacePlan.y;
		r.overlay.spaceTotalDy = 48;
		r.overlay.spaceTextChange = () => ({ dy: 48, lines: 2 });
		r.overlay.redrawSelectionUI();
		const hover = r.labels.filter(c => !c.landing), release = r.labels.filter(c => c.landing);
		expect(hover.length, "premise: hover labels drawn").toBeGreaterThan(0);
		expect(release.length, "premise: the release label drawn").toBe(1);
		// The pane begins 320 css px into the tail canvas.
		for (const c of [...hover, ...release]) {
			expect(c.left, c.label).toBe(320);
			expect(textStart(c), c.label).toBeGreaterThanOrEqual(320);
			expect(textStart(c), c.label).toBeLessThan(320 + 900);
		}
	});

	it("on a note that does not scroll sideways, the labels start where they always did", async () => {
		setTipMode("space");
		const r = await labelRig(0, 0);
		r.hover(100); r.frame();
		expect(r.overlay.spacePreview, "premise: the hover drew a preview").toBeTruthy();
		const hover = r.labels.filter(c => !c.landing);
		expect(hover.length, "premise: hover labels drawn").toBeGreaterThan(0);
		for (const c of hover) {
			expect(c.left ?? 0, c.label).toBe(0);
			expect(textStart(c), c.label).toBe(8);
		}
	});

	it("the label's left is in the canvas's css px, taken before the scale to physical px", () => {
		const call: LabelCall = { label: "Text boundary", landing: false, cssScale: 1.25, left: 320, y: 100 };
		expect(textStart(call)).toBeCloseTo(320 + 8 / 1.25, 9);
		expect(textStart({ ...call, landing: true })).toBeCloseTo(320 + 36 / 1.25, 9);
	});
});
