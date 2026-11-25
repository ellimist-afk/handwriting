/**
 * Page guides: the page they mark and the pitch they draw at (PageGuides.ts), and the box the overlay keeps for them
 * (InkOverlayPaperPinch.ts syncPageGuideBox).
 *
 * Page: the Export to PDF dialog's saved page area when its settings read, else Letter portrait at the default margin.
 * Pitch: where an export of the column cuts its pages, the page area's height times the larger of 1 and column over
 * page width.
 *
 * Box: Infinite Canvas on with a measured column and column edge only; behind the text after the grid box and before
 * the content; the page outline: left at the column's left edge, one page wide (the larger of page and column), cut at
 * the area's edge with the right line dropped; top at the note origin; as tall as the content and the grant, never
 * adding scroll room; nothing written on a preview
 * frame; gone with the canvas, the column or the release. Quiet while a preview lives by its own class, set where the
 * preview paper begins and cleared where it ends, on paper none as on any paper.
 */
import { describe, expect, it } from "vitest";

(globalThis as { window?: unknown }).window = globalThis;
if (typeof (globalThis as { HTMLElement?: unknown }).HTMLElement === "undefined") {
	(globalThis as { HTMLElement?: unknown }).HTMLElement = class ProbeHTMLElement {};
}

import { InkOverlayPlugin } from "./InkOverlay";
import { guidePageArea, guidePitch, LETTER_PAGE_AREA, pageGuidePitch } from "./PageGuides";
import { initEmbedInkPrintPaper } from "./EmbedInkPrint";

const close = (a: number, b: number) => Math.abs(a - b) < 1e-6;

describe("the page the guides mark", () => {
	it("no saved settings, or settings the dialog does not write: Letter portrait at the default margin", () => {
		expect(LETTER_PAGE_AREA.w).toBeCloseTo(739.2, 6);
		expect(LETTER_PAGE_AREA.h).toBeCloseTo(979.2, 6);
		for (const raw of [null, undefined, {}, { pageSize: "Folio", landscape: false, margin: "0", downscalePercent: 100 }, { pageSize: "A4", landscape: "no", margin: "0", downscalePercent: 100 }]) {
			expect(guidePageArea(raw), JSON.stringify(raw)).toEqual({ w: LETTER_PAGE_AREA.w, h: LETTER_PAGE_AREA.h });
		}
	});
	it("the dialog's saved page area: size, orientation, margin and downscale", () => {
		const a4 = guidePageArea({ pageSize: "A4", landscape: false, margin: "0", downscalePercent: 100 });
		expect(close(a4.w, (8.27 - 0.8) * 96) && close(a4.h, (11.69 - 0.8) * 96), JSON.stringify(a4)).toBe(true);
		const land = guidePageArea({ pageSize: "Letter", landscape: true, margin: "1", downscalePercent: 50 });
		expect(close(land.w, 11 * 96 / 0.5) && close(land.h, 8.5 * 96 / 0.5), JSON.stringify(land)).toBe(true);
	});
	it("the provider the export reads is the one the guides read", () => {
		initEmbedInkPrintPaper(() => ({ pageSize: "Legal", landscape: false, margin: "2", downscalePercent: 100 }));
		try {
			const page = { w: (8.5 - 0.32) * 96, h: (14 - 0.32) * 96 };
			expect(close(pageGuidePitch(page.w), page.h)).toBe(true);
		} finally { initEmbedInkPrintPaper(null); }
		initEmbedInkPrintPaper(() => { throw new Error("config gone"); });
		try { expect(close(pageGuidePitch(LETTER_PAGE_AREA.w), LETTER_PAGE_AREA.h)).toBe(true); } finally { initEmbedInkPrintPaper(null); }
	});
});

describe("the pitch: where an export of the column cuts its pages", () => {
	const page = { w: 739.2, h: 979.2 };
	it("a column the page's width or narrower prints at full size: one page area's height", () => {
		expect(guidePitch(739.2, page)).toBeCloseTo(979.2, 6);
		expect(guidePitch(700, page)).toBeCloseTo(979.2, 6);
	});
	it("a wider column is shrunk to the paper: the page holds more of it", () => {
		expect(guidePitch(1478.4, page)).toBeCloseTo(1958.4, 6);
	});
	it("no column, no pitch", () => {
		for (const c of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) expect(Number.isNaN(guidePitch(c, page)), String(c)).toBe(true);
	});
});

type Fields = Record<string, unknown>;
interface FakeEl { cls: string; classes: Set<string>; left: number; classList: { add(c: string): void; remove(c: string): void; toggle(c: string, on?: boolean): void; contains(c: string): boolean }; parentElement: unknown; w: number; h: number; top: number; props: Map<string, string>; readonly nextElementSibling: unknown; setCssStyles(st: Record<string, string>): void; style: { transform: string; setProperty(n: string, v: string): void; removeProperty(n: string): void }; remove(): void }

/** A `translate(xpx,ypx)` string's two numbers; zero for "". */
function translateOf(t: string): { x: number; y: number } {
	const m = /^translate\((-?[\d.e+-]+)px,(-?[\d.e+-]+)px\)$/.exec(t);
	return m ? { x: Number(m[1]), y: Number(m[2]) } : { x: 0, y: 0 };
}

function makeRig(opts: { canvas: boolean; column: number; contentH: number; origin: number | null; left?: number | null; contentW?: number }) {
	const state = { contentH: opts.contentH, writes: 0, classWrites: 0, transformWrites: 0, reads: 0 };
	const H = (globalThis as unknown as { HTMLElement: { prototype: object } }).HTMLElement;
	const sizer = Object.create(H.prototype) as Record<string, unknown>;
	Object.defineProperties(sizer, {
		offsetTop: { get: () => { state.reads++; return 0; } }, offsetLeft: { get: () => { state.reads++; return 0; } },
		offsetWidth: { get: () => { state.reads++; return opts.contentW ?? 700; } }, offsetHeight: { get: () => { state.reads++; return state.contentH; } },
		nextElementSibling: { get: () => null },
		style: { value: { transform: "" } },
	});
	const children: unknown[] = [sizer];
	const els: FakeEl[] = [];
	const makeEl = (cls: string): FakeEl => {
		const props = new Map<string, string>();
		const classes = new Set<string>([cls]);
		const el: FakeEl = {
			cls, classes, parentElement: null,
			classList: {
				add: c => { state.classWrites++; classes.add(c); },
				remove: c => { state.classWrites++; classes.delete(c); },
				toggle: (c, on) => { state.classWrites++; if (on ?? !classes.has(c)) classes.add(c); else classes.delete(c); },
				contains: c => classes.has(c),
			}, left: Number.NaN, w: 0, h: 0, top: Number.NaN, props,
			get nextElementSibling() { const i = children.indexOf(el); return i >= 0 ? children[i + 1] ?? null : null; },
			setCssStyles(st) {
				state.writes++;
				if (st.left !== undefined) el.left = Number.parseFloat(st.left);
				if (st.width !== undefined) el.w = Number.parseFloat(st.width);
				if (st.height !== undefined) el.h = Number.parseFloat(st.height);
				if (st.top !== undefined) el.top = Number.parseFloat(st.top);
			},
			style: {
				_t: "",
				get transform() { return (this as unknown as { _t: string })._t; },
				set transform(v: string) { state.writes++; state.transformWrites++; (this as unknown as { _t: string })._t = v; },
				setProperty: (n, v) => { state.writes++; props.set(n, v); }, removeProperty: n => { props.delete(n); },
			} as FakeEl["style"],
			remove() { const i = children.indexOf(el); if (i >= 0) children.splice(i, 1); el.parentElement = null; },
		};
		els.push(el);
		return el;
	};
	const live = (cls: string): FakeEl | undefined => els.find(e => e.cls === cls && e.parentElement);
	const scroller = {
		isConnected: true, scrollLeft: 0, scrollTop: 0, clientWidth: 800, clientHeight: 600, clientTop: 0, clientLeft: 0,
		get firstElementChild() { return children[0] ?? null; },
		get firstChild() { return children[0] ?? null; },
		// A transformed child counts toward scrollable overflow with its translate; past the origin is not scroll room.
		get scrollWidth() { const b = live("handwriting-page-guides"); return Math.max(800, opts.contentW ?? 700, b ? (Number.isFinite(b.left) ? b.left : 0) + translateOf(b.style.transform).x + b.w : 0); },
		get scrollHeight() { const b = live("handwriting-page-guides"); return Math.max(600, state.contentH, b ? b.top + translateOf(b.style.transform).y + b.h : 0); },
		classList: { add: () => undefined, remove: () => undefined, contains: () => false },
		style: { setProperty: () => undefined, removeProperty: () => undefined },
		setCssStyles: () => undefined,
		insertBefore(node: FakeEl, ref: unknown) {
			const at = children.indexOf(node); if (at >= 0) children.splice(at, 1);
			const i = ref ? children.indexOf(ref) : children.length;
			children.splice(i < 0 ? children.length : i, 0, node);
			node.parentElement = scroller;
		},
		createDiv({ cls }: { cls: string }) { const el = makeEl(cls); children.push(el); el.parentElement = scroller; return el; },
	};
	// Grid paper stated on the scroller, as the stylesheet does, so the grid box's own sync keeps its box.
	const win = { devicePixelRatio: 1, getComputedStyle: () => { state.reads++; return { position: "relative", getPropertyValue: (n: string) => (n === "--handwriting-paper-grid" ? "1" : "") }; } };
	const o = Object.create(InkOverlayPlugin.prototype) as Fields;
	o.view = { dom: { isConnected: true, ownerDocument: { defaultView: win, body: {} } }, scrollDOM: scroller };
	o.canvasMode = opts.canvas;
	o.viewportLayout = opts.column > 0 ? { columnBox: opts.column, externalScale: 1 } : null;
	o.pinchPreview = false;
	o.paperGridBox = null;
	o.paperGridBoxSize = null;
	o.paperKindWatch = [];
	o.pageGuideBox = null;
	o.pageGuideBoxKey = null;
	o.pageGuidesPreviewing = false;
	o.paperOriginLayout = opts.origin;
	o.paperOriginLeft = opts.left === undefined ? 0 : opts.left;
	o.spacerLeft = Number.NaN;
	o.spacerTop = Number.NaN;
	o.scrollPositionPatched = false;
	// The pan: writeViewportPan's own path, with the sizer, the paper and the ink layer it writes.
	o.cssScale = 1;
	o.viewportPan = { x: 0, y: 0 };
	o.bounceOffset = null;
	o.pageGuideArea = null;
	o.pageGuidePanWritten = null;
	o.panSizer = () => sizer;
	o.panGuttersEl = null;
	o.panGuttersMode = null;
	o.panGuttersWritten = "";
	o.previewPaperBoxDirty = false;
	o.previewPaperEl = null;
	o.paperWritten = null;
	o.paperPanWritten = null;
	o.paperGridBoxPanX = "";
	o.paperColumnDrift = 0;
	o.paperRewrapY = 0;
	o.paperSnapResidual = { x: 0, y: 0 };
	const inkLayer = { style: { transform: "" } };
	o.inkLayer = inkLayer;
	o.previewInkOffset = 0;
	o.previewInkOffsetY = 0;
	o.rasterPan = null;
	o.heldRaster = null;
	o.releaseWetIfIdle = () => undefined;
	const call =(name: string, ...args: unknown[]): unknown => (o[name] as (...a: unknown[]) => unknown).call(o, ...args);
	return { o, state, scroller, win, children, sizer: sizer as Record<string, unknown> & { style: { transform: string } }, inkLayer, call, box:() => live("handwriting-page-guides"), makeGrid: () => { const g = makeEl("handwriting-paper-grid-column"); scroller.insertBefore(g, scroller.firstChild); o.paperGridBox = g; return g; } };
}

describe("the guides' box", () => {
	it("Infinite Canvas on: one box behind the content, top at the note origin, the pitch written, no scroll room added", () => {
		initEmbedInkPrintPaper(null);
		const r = makeRig({ canvas: true, column: 700, contentH: 3000, origin: 40 });
		const rangeBefore = { w: r.scroller.scrollWidth, h: r.scroller.scrollHeight };
		r.call("syncPageGuideBox");
		const b = r.box();
		expect(b, "the box was made").toBeDefined();
		expect(r.children.indexOf(b), "before the content").toBeLessThan(r.children.indexOf(r.sizer));
		expect(b!.top, "page 1 starts at the note origin").toBe(40);
		expect(b!.props.get("--handwriting-page-guide-pitch"), "Letter at a 700 px column prints full size: 979.2 px pages").toBe("979.2px");
		expect(b!.left, "from the column's left edge").toBe(0);
		expect(b!.w, "one Letter page wide").toBeCloseTo(739.2, 6);
		expect(b!.top + b!.h, "covers the content").toBe(3000);
		expect({ w: r.scroller.scrollWidth, h: r.scroller.scrollHeight }, "no scroll room added").toEqual(rangeBefore);
	});
	it("after the grid's box, so the guides paint over its vertical rules; the grid box still reads the content under it", () => {
		const r = makeRig({ canvas: true, column: 700, contentH: 3000, origin: 0 });
		const g = r.makeGrid();
		r.call("syncPageGuideBox");
		expect(r.children.slice(0, 3)).toEqual([g, r.box(), r.sizer]);
		r.call("syncGridPaperBox");
		expect((g as unknown as FakeEl).h, "grid box sized from the content, not from the guide box").toBe(3000);
	});
	it("Infinite Canvas off: no box, and a box already up goes", () => {
		const off = makeRig({ canvas: false, column: 700, contentH: 3000, origin: 0 });
		off.call("syncPageGuideBox");
		expect(off.box()).toBeUndefined();
		const r = makeRig({ canvas: true, column: 700, contentH: 3000, origin: 0 });
		r.call("syncPageGuideBox");
		expect(r.box()).toBeDefined();
		r.o.canvasMode = false;
		r.call("syncPageGuideBox");
		expect(r.box(), "the canvas went: so did the guides").toBeUndefined();
		expect(r.o.pageGuideBox).toBeNull();
	});
	it("no column measured: no box", () => {
		const r = makeRig({ canvas: true, column: 0, contentH: 3000, origin: 0 });
		r.call("syncPageGuideBox");
		expect(r.box()).toBeUndefined();
	});
	it("a preview frame reads and writes nothing; unchanged geometry writes nothing again", () => {
		const r = makeRig({ canvas: true, column: 700, contentH: 3000, origin: 0 });
		r.call("syncPageGuideBox");
		const writes = r.state.writes;
		r.call("syncPageGuideBox");
		expect(r.state.writes, "nothing changed: no write").toBe(writes);
		r.o.pinchPreview = true;
		r.state.contentH = 5000;
		r.call("syncPageGuideBox");
		expect(r.state.writes, "preview frame: no write").toBe(writes);
		r.o.pinchPreview = false;
		r.call("syncPageGuideBox");
		expect(r.box()!.h, "at rest again it follows the content").toBe(5000);
	});
	it("the release takes the box with it", () => {
		const r = makeRig({ canvas: true, column: 700, contentH: 3000, origin: 0 });
		r.call("syncPageGuideBox");
		r.call("removePageGuideBox");
		expect(r.box()).toBeUndefined();
		expect(r.o.pageGuideBox).toBeNull();
	});
});

const OPEN = "handwriting-page-guides-open";

describe("the outline: two side lines one page apart, the page ends between them", () => {
	it("a narrow column: the left line at the column's left edge, the right one Letter page width away", () => {
		initEmbedInkPrintPaper(null);
		const r = makeRig({ canvas: true, column: 700, contentH: 3000, origin: 0, left: 30 });
		r.call("syncPageGuideBox");
		const b = r.box()!;
		expect(b.left, "left side line at the column's left edge").toBe(30);
		expect(b.left + b.w, "right side line one page width (739.2 px) from it").toBeCloseTo(30 + 739.2, 6);
		expect(b.classes.has(OPEN), "the right line is drawn").toBe(false);
	});
	it("a wide column: the export shrinks it to the page, so the right line is the column's own right edge", () => {
		initEmbedInkPrintPaper(null);
		const r = makeRig({ canvas: true, column: 1478.4, contentH: 3000, origin: 0, left: 30, contentW: 30 + 1478.4 });
		r.call("syncPageGuideBox");
		const b = r.box()!;
		expect(b.left, "left side line at the column's left edge").toBe(30);
		expect(b.left + b.w, "right side line at the column's right edge").toBeCloseTo(30 + 1478.4, 6);
		expect(b.classes.has(OPEN), "the right line is drawn").toBe(false);
		expect(b.props.get("--handwriting-page-guide-pitch"), "pitch unchanged: twice the page height").toBe("1958.4px");
	});
	it("the saved page sets the width: A4 portrait, no margin", () => {
		initEmbedInkPrintPaper(() => ({ pageSize: "A4", landscape: false, margin: "0", downscalePercent: 100 }));
		try {
			const r = makeRig({ canvas: true, column: 600, contentH: 3000, origin: 0, left: 10 });
			r.call("syncPageGuideBox");
			expect(r.box()!.w).toBeCloseTo((8.27 - 0.8) * 96, 6);
		} finally { initEmbedInkPrintPaper(null); }
	});
	it("an outline wider than the note's area is cut at its edge: no scroll room, and no right line past the box", () => {
		initEmbedInkPrintPaper(null);
		const r = makeRig({ canvas: true, column: 700, contentH: 3000, origin: 0, left: 100 });
		const before = r.scroller.scrollWidth;
		r.call("syncPageGuideBox");
		const b = r.box()!;
		expect(b.left + b.w, "stops at the area's right edge").toBe(800);
		expect(b.classes.has(OPEN), "the right line, past the box, is not drawn").toBe(true);
		expect(r.scroller.scrollWidth, "no scroll room added").toBe(before);
		r.o.paperOriginLeft = 30;
		r.call("syncPageGuideBox");
		expect(b.classes.has(OPEN), "the column moved left: the whole outline fits, the right line is back").toBe(false);
		expect(b.left).toBe(30);
	});
	it("the column's left edge not yet measured: no box", () => {
		const r = makeRig({ canvas: true, column: 700, contentH: 3000, origin: 0, left: null });
		r.call("syncPageGuideBox");
		expect(r.box()).toBeUndefined();
	});
	it("a column move rewrites the box; nothing else changed writes nothing", () => {
		const r = makeRig({ canvas: true, column: 700, contentH: 3000, origin: 0, left: 30 });
		r.call("syncPageGuideBox");
		const writes = r.state.writes;
		r.call("syncPageGuideBox");
		expect(r.state.writes).toBe(writes);
		r.o.paperOriginLeft = 50;
		r.call("syncPageGuideBox");
		expect(r.box()!.left).toBe(50);
	});
});

describe("the dash and the gap are screen px at every zoom", () => {
	const DASH = "--handwriting-page-guide-dash", GAP = "--handwriting-page-guide-gap";
	it("zoom 1: 4 px each; zoom 0.25: 16 layout px each, 4 on the glass", () => {
		const r = makeRig({ canvas: true, column: 700, contentH: 3000, origin: 0, left: 30 });
		r.o.cssScale = 1;
		r.call("syncPageGuideBox");
		expect(r.box()!.props.get(DASH), "zoom 1 dash").toBe("4px");
		expect(r.box()!.props.get(GAP), "zoom 1 gap").toBe("4px");
		r.o.cssScale = 0.25;
		r.call("syncPageGuideBox");
		expect(r.box()!.props.get(DASH), "zoom 0.25 dash: 4 / 0.25").toBe("16px");
		expect(r.box()!.props.get(GAP), "zoom 0.25 gap: 4 / 0.25").toBe("16px");
	});
	it("a zoom that does not divide evenly rounds to a thousandth; an unchanged zoom writes nothing", () => {
		const r = makeRig({ canvas: true, column: 700, contentH: 3000, origin: 0, left: 30 });
		r.o.cssScale = 0.3;
		r.call("syncPageGuideBox");
		expect(r.box()!.props.get(DASH)).toBe("13.333px");
		const writes = r.state.writes;
		r.call("syncPageGuideBox");
		expect(r.state.writes, "same zoom: no write").toBe(writes);
	});
	it("a scale not measured yet falls back to zoom 1, never a NaN or infinite length", () => {
		const r = makeRig({ canvas: true, column: 700, contentH: 3000, origin: 0, left: 30 });
		r.o.cssScale = 0;
		r.call("syncPageGuideBox");
		expect(r.box()!.props.get(DASH)).toBe("4px");
		r.o.cssScale = Number.NaN;
		r.call("syncPageGuideBox");
		expect(r.box()!.props.get(GAP)).toBe("4px");
	});
});

describe("the guides follow a standing pan", () => {
	type Rig = ReturnType<typeof makeRig>;
	/** A rest pan (painted px) written the way every pan change writes it. */
	const pan = (r: Rig, x: number, y: number, deferPaper = false) => { r.o.viewportPan = { x, y }; r.call("writeViewportPan", deferPaper); };
	/** Where the box's left edge and top sit on the text's frame: its place plus its translate. */
	const placed = (r: Rig) => { const b = r.box()!, t = translateOf(b.style.transform); return { left: b.left + t.x, top: b.top + t.y }; };
	/** A wide area, so no cut: the box is one page wide whatever the pan. */
	const wide = () => makeRig({ canvas: true, column: 700, contentH: 3000, origin: 40, left: 30, contentW: 2000 });

	it("panned side x and page top: the box takes the sizer's translate, at two pans and two zooms", () => {
		initEmbedInkPrintPaper(null);
		for (const k of [1, 0.5]) for (const [px, py] of [[120, 80], [-60, -40]] as const) {
			const r = wide();
			r.o.cssScale = k;
			r.call("syncPageGuideBox");
			pan(r, px, py);
			const label = `k ${k} pan ${px},${py}`;
			expect(r.box()!.style.transform, `the sizer's own translate ${label}`).toBe(r.sizer.style.transform);
			expect(placed(r).left, `left side line on the column ${label}`).toBeCloseTo(30 + px / k, 6);
			expect(placed(r).left + r.box()!.w, `right side line one page on ${label}`).toBeCloseTo(30 + px / k + 739.2, 6);
			expect(placed(r).top, `page 1 starts at the note top ${label}`).toBeCloseTo(40 + py / k, 6);
		}
	});
	it("the exact pan, unfolded: pans of one paper pitch, two, and three pitches and a px each move the lines", () => {
		const r = wide();
		r.o.paperWritten = new Map([["--handwriting-paper-pitch", "24px"]]);
		r.call("syncPageGuideBox");
		for (const x of [24, 48, 73]) {
			pan(r, x, x);
			expect(placed(r).left, `pan ${x}: left side line on the column`).toBeCloseTo(30 + x, 6);
			expect(placed(r).top, `pan ${x}: page 1 at the note top`).toBeCloseTo(40 + x, 6);
		}
	});
	it("the preview's end brings the box to the pan in force, the scale too, whichever way the settle wrote", () => {
		const r = wide();
		r.call("syncPageGuideBox");
		pan(r, 50, 20);
		r.call("markPageGuidesPreview", true);
		const before = r.box()!.style.transform;
		// Live frames: a new scale and pan, the paper deferred; the box is blank and takes nothing.
		r.o.cssScale = 0.5;
		pan(r, 90, 30, true);
		expect(r.box()!.style.transform, "blank under the preview: no write").toBe(before);
		// The settle's unchanged-pan arm: the paper's write only, its flag spent.
		r.call("writePaperPan");
		r.o.previewPaperBoxDirty = false;
		r.call("markPageGuidesPreview", false);
		expect(r.box()!.style.transform, "painted again on the sizer's translate").toBe(r.sizer.style.transform);
		expect(placed(r).left).toBeCloseTo(30 + 90 / 0.5, 6);
	});
	it("a box made while a pan stands carries it at once: canvas off and on again under a pan", () => {
		const r = wide();
		r.call("syncPageGuideBox");
		pan(r, 70, 25);
		r.o.canvasMode = false;
		r.call("syncPageGuideBox");
		expect(r.box(), "premise: the box went with the canvas").toBeUndefined();
		r.o.canvasMode = true;
		r.call("syncPageGuideBox");
		expect(r.box()!.style.transform, "the remade box on the sizer's translate, no pan write since").toBe(r.sizer.style.transform);
		expect(placed(r).left).toBeCloseTo(30 + 70, 6);
	});
	it("no scroll room at a pan right, down, left or up, the cut using the translate's own pan", () => {
		initEmbedInkPrintPaper(null);
		// Area 800 wide, the outline 739.2 from x 30: 30.8 px of gap, which a pan of 120 overruns.
		for (const [px, py] of [[120, 0], [0, 80], [-60, 0], [0, -40], [120, 80]] as const) {
			const r = makeRig({ canvas: true, column: 700, contentH: 3000, origin: 40, left: 30 });
			r.o.viewportPan = { x: px, y: py };
			r.call("writeViewportPan");
			const off = { w: r.scroller.scrollWidth, h: r.scroller.scrollHeight };
			r.call("syncPageGuideBox");
			r.call("writePageGuidePan");
			const label = `pan ${px},${py} (gap box to area edge 30.8 px${px > 30.8 ? ", overrun" : ""})`;
			expect({ w: r.scroller.scrollWidth, h: r.scroller.scrollHeight }, `scroll range equal, guides on vs off ${label}`).toEqual(off);
			const b = r.box()!, t = translateOf(b.style.transform);
			expect(t.x, `the cut and the translate read one pan ${label}`).toBeCloseTo(px, 6);
			expect(b.left + t.x + b.w, `right edge inside the area ${label}`).toBeLessThanOrEqual(800 + 1e-6);
			expect(b.top + t.y + b.h, `bottom inside the area ${label}`).toBeLessThanOrEqual(3000 + 1e-6);
			expect(b.classes.has(OPEN), `cut: the right line past the box is not drawn ${label}`).toBe(b.w < 739.2 - 1e-6);
		}
	});
	it("a pan up and left, the canvas's common rest: the lines reach the area's bottom, and the right line comes back once it fits", () => {
		initEmbedInkPrintPaper(null);
		// A short note: the area is the scroller's 800 x 600. The outline from x 100 is 839.2 wide, cut at rest.
		for (const k of [1, 0.5]) {
			const r = makeRig({ canvas: true, column: 700, contentH: 400, origin: 40, left: 100 });
			r.o.cssScale = k;
			r.call("syncPageGuideBox");
			expect(r.box()!.classes.has(OPEN), `premise: cut at rest, k ${k}`).toBe(true);
			r.call("removePageGuideBox");
			const off = { w: r.scroller.scrollWidth, h: r.scroller.scrollHeight };
			// -200, -300 layout px: the pan in painted px is that times the scale.
			r.o.viewportPan = { x: -200 * k, y: -300 * k };
			r.call("writeViewportPan");
			const offPanned = { w: r.scroller.scrollWidth, h: r.scroller.scrollHeight };
			r.call("syncPageGuideBox");
			const b = r.box()!, t = translateOf(b.style.transform);
			const label = `k ${k} ${JSON.stringify({ left: b.left, w: b.w, top: b.top, h: b.h, t })}`;
			expect(t.x, `premise: the translate is the pan ${label}`).toBeCloseTo(-200, 6);
			expect(b.top + t.y + b.h, `the side lines and page ends reach the area's bottom in the band the pan shows ${label}`).toBeCloseTo(600, 3);
			expect(b.left + t.x + b.w, `the right line one page on, inside the area ${label}`).toBeCloseTo(Math.min(100 - 200 + 739.2, 800), 3);
			expect(b.classes.has(OPEN), `the outline fits after the pan: the right line is drawn ${label}`).toBe(false);
			expect({ w: r.scroller.scrollWidth, h: r.scroller.scrollHeight }, `no scroll room, guides on vs off ${label}`).toEqual(offPanned);
			expect(offPanned, `premise: the pan itself changed no range ${label}`).toEqual(off);
		}
	});
	it("the cut never rounds past the area's edge: a remainder with a fourth decimal of 5 or more", () => {
		initEmbedInkPrintPaper(null);
		const r = makeRig({ canvas: true, column: 700, contentH: 3000, origin: 40, left: 100 });
		r.call("syncPageGuideBox");
		// 800 - 100 - 0.0004 = 699.9996 and 3000 - 40 - 0.0004 = 2959.9996: a round to the 0.001 lands 0.0004 past.
		r.o.viewportPan = { x: 0.0004, y: 0.0004 };
		r.call("writeViewportPan");
		const b = r.box()!, t = translateOf(b.style.transform);
		const label = JSON.stringify({ left: b.left, w: b.w, top: b.top, h: b.h, t });
		expect(t.x, `premise: the translate carries the pan ${label}`).toBe(0.0004);
		// A 1e-9 slack for float sums only: the floored edge sits 0.0006 inside, the rounded one 0.0004 past.
		expect(b.left + t.x + b.w, `right edge at or inside the area ${label}`).toBeLessThanOrEqual(800 + 1e-9);
		expect(b.top + t.y + b.h, `bottom at or inside the area ${label}`).toBeLessThanOrEqual(3000 + 1e-9);
	});
	it("a pan drag writes only what changed and reads nothing; the hook never re-measures", () => {
		const r = wide();
		r.call("syncPageGuideBox");
		const reads = r.state.reads, transforms = r.state.transformWrites;
		for (let i = 1; i <= 10; i++) pan(r, i * 3, i);
		pan(r, 30, 10);
		expect(r.state.reads, "no read on any pan write").toBe(reads);
		expect(r.state.transformWrites - transforms, "at most one transform write per changed sample").toBeLessThanOrEqual(10);
		r.call("markPageGuidesPreview", true);
		const during = r.state.writes;
		pan(r, 99, 99, true);
		pan(r, 98, 98);
		expect(r.state.writes, "nothing on the box while it is blank").toBe(during);
	});
	it("a pull and its bounce: nothing on the box per frame under the preview's class, one write each at the end", () => {
		// Every pull and bounce puts the preview paper up first, which sets the guides' previewing class; the cut rig, so
		// a pan past the 30.8 px gap changes the size too.
		const r = makeRig({ canvas: true, column: 700, contentH: 3000, origin: 40, left: 30 });
		r.call("syncPageGuideBox");
		r.call("markPageGuidesPreview", true);
		const writes = r.state.writes, transforms = r.state.transformWrites, reads = r.state.reads;
		for (let i = 1; i <= 12; i++) { r.o.bounceOffset = { x: 120 - i * 10, y: 60 - i * 5 }; pan(r, 0, 0, i % 2 === 0); }
		expect(r.state.writes, "no box write on any bounce frame").toBe(writes);
		// The last frame: the pan write, then the preview's end.
		r.o.bounceOffset = null;
		pan(r, -50, -20);
		r.call("markPageGuidesPreview", false);
		expect(r.state.transformWrites - transforms, "one transform write at the end").toBeLessThanOrEqual(1);
		expect(r.state.writes - writes, "the transform and the size, once each").toBeLessThanOrEqual(2);
		expect(r.state.reads, "no read").toBe(reads);
		expect(r.box()!.style.transform).toBe(r.sizer.style.transform);
	});
	it("guides off: the pan writes, the paper's flag and every other transform are as with no guides at all", () => {
		const run = (stub: boolean) => {
			const r = makeRig({ canvas: false, column: 700, contentH: 3000, origin: 40, left: 30 });
			if (stub) r.o.writePageGuidePan = () => undefined;
			r.call("syncPageGuideBox");
			const seen: unknown[] = [];
			for (const [x, y, d] of [[40, 10, true], [40, 10, false], [-20, 5, true], [0, 0, false]] as const) {
				pan(r, x, y, d);
				// The paper's deferred flag stands after a deferred write, whatever the guides do: the live pinch frame's
				// paper waits on it. Pinned on its own, since both arms here run the same writeViewportPan.
				expect(r.o.previewPaperBoxDirty, `the paper's flag after a ${d ? "deferred" : "plain"} pan write, stub ${stub}`).toBe(d);
				r.o.previewPaperBoxDirty = false;
				seen.push([r.sizer.style.transform, r.inkLayer.style.transform, r.o.previewPaperBoxDirty, r.o.paperPanWritten]);
			}
			expect(r.box(), "no box with the canvas off").toBeUndefined();
			return seen;
		};
		expect(run(false)).toEqual(run(true));
	});
	it("a pan back to zero takes the translate off", () => {
		const r = wide();
		r.call("syncPageGuideBox");
		r.o.viewportPan = { x: 40, y: 15 };
		r.call("writePageGuidePan");
		expect(r.box()!.style.transform).not.toBe("");
		r.o.viewportPan = { x: 0, y: 0 };
		r.call("writePageGuidePan");
		expect(r.box()!.style.transform, "no stale translate").toBe("");
		expect(placed(r).left).toBe(30);
	});
	it("the ink layer and the sizer move exactly as they do with the guides off", () => {
		const run = (canvas: boolean) => {
			const r = makeRig({ canvas, column: 700, contentH: 3000, origin: 40, left: 30 });
			r.call("syncPageGuideBox");
			const seen: string[] = [];
			for (const k of [1, 0.5]) {
				r.o.cssScale = k;
				for (const [x, y] of [[120, 80], [-60, -40], [0, 0]]) { pan(r, x!, y!); seen.push(r.sizer.style.transform, r.inkLayer.style.transform); }
			}
			return seen;
		};
		expect(run(true)).toEqual(run(false));
	});
});

const PREVIEWING = "handwriting-page-guides-previewing";

describe("the guides go quiet by their own class while a preview lives", () => {
	/** Paper none: the scroller resolves no paper pitch, so the preview paper never goes up and the scroller's class never comes on. */
	function noPaperPreviewRig() {
		const r = makeRig({ canvas: true, column: 700, contentH: 3000, origin: 0 });
		const host = { isConnected: true, style: {}, ownerDocument: { defaultView: r.win, body: {} } };
		(r.o.view as Fields).dom = host;
		(r.scroller as unknown as Fields).parentElement = host;
		return r;
	}
	it("paper none: the preview's begin sets the box's class with no preview paper up, and its end clears it", () => {
		const r = noPaperPreviewRig();
		r.call("syncPageGuideBox");
		expect(r.box()!.classes.has(PREVIEWING), "at rest: painted").toBe(false);
		r.call("beginPreviewPaper");
		expect(r.o.previewPaperEl ?? null, "premise: paper none puts no preview paper up").toBeNull();
		expect(r.box()!.classes.has(PREVIEWING), "the preview began: the box carries its own quiet class").toBe(true);
		r.call("endPreviewPaper", "settle");
		expect(r.box()!.classes.has(PREVIEWING), "the settle: painted again").toBe(false);
		expect(r.o.pageGuidesPreviewing).toBe(false);
	});
	it("every end clears it: cancel, commit, input, note switch, unmount", () => {
		for (const reason of ["cancel", "commit", "input", "note-switch", "unmount"]) {
			const r = noPaperPreviewRig();
			r.call("syncPageGuideBox");
			r.call("beginPreviewPaper");
			r.call("endPreviewPaper", reason);
			expect(r.box()!.classes.has(PREVIEWING), reason).toBe(false);
		}
	});
	it("written only when it changes", () => {
		const r = noPaperPreviewRig();
		r.call("syncPageGuideBox");
		r.call("markPageGuidesPreview", true);
		r.call("markPageGuidesPreview", true);
		expect(r.state.classWrites, "one write for two marks").toBe(1);
		r.call("markPageGuidesPreview", false);
		r.call("markPageGuidesPreview", false);
		expect(r.state.classWrites, "one more for two clears").toBe(2);
	});
	it("a box made while a preview lives starts quiet; one made after it ends paints", () => {
		const r = noPaperPreviewRig();
		r.call("markPageGuidesPreview", true);
		r.call("syncPageGuideBox");
		expect(r.box()!.classes.has(PREVIEWING)).toBe(true);
		r.call("removePageGuideBox");
		r.call("markPageGuidesPreview", false);
		r.call("syncPageGuideBox");
		expect(r.box()!.classes.has(PREVIEWING)).toBe(false);
	});
});
