/**
 * Page guides: the page they mark and the pitch they draw at (PageGuides.ts), and the box the overlay keeps for them
 * (InkOverlayPaperPinch.ts syncPageGuideBox).
 *
 * Page: the Export to PDF dialog's saved page area when its settings read, else Letter portrait at the default margin.
 * Pitch: where an export of the column cuts its pages, the page area's height times the larger of 1 and column over
 * page width.
 *
 * Box: Infinite Canvas on with a measured column only; behind the text after the grid box and before the content;
 * top at the note origin; sized from the content and the grant, never adding scroll room; nothing written on a preview
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
interface FakeEl { cls: string; classes: Set<string>; classList: { add(c: string): void; remove(c: string): void; toggle(c: string, on?: boolean): void; contains(c: string): boolean }; parentElement: unknown; w: number; h: number; top: number; props: Map<string, string>; readonly nextElementSibling: unknown; setCssStyles(st: Record<string, string>): void; style: { setProperty(n: string, v: string): void; removeProperty(n: string): void }; remove(): void }

function makeRig(opts: { canvas: boolean; column: number; contentH: number; origin: number | null }) {
	const state = { contentH: opts.contentH, writes: 0, classWrites: 0 };
	const H = (globalThis as unknown as { HTMLElement: { prototype: object } }).HTMLElement;
	const sizer = Object.create(H.prototype) as Record<string, unknown>;
	Object.defineProperties(sizer, {
		offsetTop: { get: () => 0 }, offsetLeft: { get: () => 0 }, offsetWidth: { get: () => 700 }, offsetHeight: { get: () => state.contentH },
		nextElementSibling: { get: () => null },
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
			}, w: 0, h: 0, top: Number.NaN, props,
			get nextElementSibling() { const i = children.indexOf(el); return i >= 0 ? children[i + 1] ?? null : null; },
			setCssStyles(st) {
				state.writes++;
				if (st.width !== undefined) el.w = Number.parseFloat(st.width);
				if (st.height !== undefined) el.h = Number.parseFloat(st.height);
				if (st.top !== undefined) el.top = Number.parseFloat(st.top);
			},
			style: { setProperty: (n, v) => { state.writes++; props.set(n, v); }, removeProperty: n => { props.delete(n); } },
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
		get scrollWidth() { const b = live("handwriting-page-guides"); return Math.max(800, 700, b?.w ?? 0); },
		get scrollHeight() { const b = live("handwriting-page-guides"); return Math.max(600, state.contentH, b ? b.top + b.h : 0); },
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
	const win = { devicePixelRatio: 1, getComputedStyle: () => ({ position: "relative", getPropertyValue: (n: string) => (n === "--handwriting-paper-grid" ? "1" : "") }) };
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
	o.spacerLeft = Number.NaN;
	o.spacerTop = Number.NaN;
	o.scrollPositionPatched = false;
	const call = (name: string, ...args: unknown[]): unknown => (o[name] as (...a: unknown[]) => unknown).call(o, ...args);
	return { o, state, scroller, win, children, sizer, call, box: () => live("handwriting-page-guides"), makeGrid: () => { const g = makeEl("handwriting-paper-grid-column"); scroller.insertBefore(g, scroller.firstChild); o.paperGridBox = g; return g; } };
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
		expect(b!.w).toBe(800);
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
