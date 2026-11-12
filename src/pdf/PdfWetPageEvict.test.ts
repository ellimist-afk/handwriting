/**
 * A pdf page that hosts the wet ink must keep it while the pen is down.
 *
 * `sync` evicts every overlay whose page the viewer no longer renders
 * (PdfInkBand.ts, the evict loop before `syncBand`). The two other places that
 * drop an overlay - the empty-page branch and the off-band branch of `paint` -
 * first ask `owns(page)`, so a live gesture keeps its canvas and its pair. The
 * evict loop did not ask. When pdf.js let go of the page under the nib while
 * the stroke was still being drawn, the pair was un-parented mid-stroke: the
 * wet ink went with it and nothing showed until pen-up.
 *
 * Driven through the controller's own pen callbacks and its own `sync`, over a
 * fake viewer the probe reports. The pair and the page's overlay are injected,
 * as PdfWetShape.test.ts does, because the fake scroller has no page divs.
 */

import { describe, expect, it, vi } from "vitest";
import { InkOp } from "../inline/InkHistory";
import { computeBBox, InkStroke } from "../ink/Stroke";
import { PenSample } from "../input/PointerRouter";
import { resetTipModeForTest, setTipMode } from "../inline/TipMode";
import { WetInkRenderer } from "../ink/WetInkRenderer";
import { TailRenderer } from "../ink/TailRenderer";

/** The gesture path constructs observers; node has none and none is needed. */
class NoopObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
const g = globalThis as unknown as Record<string, unknown>;
g.ResizeObserver ??= NoopObserver;
g.MutationObserver ??= NoopObserver;

const probe = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("./PdfViewerProbe", () => ({ probeViewer: () => probe.current }));

import { PdfInkController } from "./PdfInkController";
import { applyOp } from "./PdfInkHistory";

const SCALE = 2;

/** A canvas that answers every 2d call with a no-op and notes its removal. */
function fakeCanvas(): HTMLCanvasElement & { removed: number } {
	const ctx = new Proxy(
		{},
		{
			get(_t, prop) {
				if (prop === "getContextAttributes") return () => ({ desynchronized: false });
				return () => undefined;
			},
			set() {
				return true;
			},
		}
	);
	const c = {
		width: 1200,
		height: 1600,
		removed: 0,
		parentElement: null as unknown,
		getContext: () => ctx,
		setCssProps: () => {},
		setCssStyles: () => {},
		// `dressWet` toggles the over-wash class on the page's overlay.
		toggleClass: () => {},
		remove() {
			c.removed++;
		},
	};
	return c as unknown as HTMLCanvasElement & { removed: number };
}

function sample(x: number, y: number, t: number): PenSample {
	return { x, y, pressure: 0.5, timestamp: t, tiltX: 0, tiltY: 0 };
}

type Priv = {
	pair: unknown;
	wetHostPage: number;
	mounted: boolean;
	boundScroller: unknown;
	overlays: Map<number, { canvas: HTMLCanvasElement }>;
	pageSize: Map<number, { wPt: number; hPt: number }>;
	owns(page: number): boolean;
	sync(): void;
	invalidateProbe(): void;
	probeReads: number;
	penDown(s: PenSample, ev?: PointerEvent): void;
	penRaw(s: PenSample[]): void;
	penUp(): void;
};

/** The viewer's report: page 1 rendered or not, page 2 always rendered. */
function report(scroller: unknown, page1Rendered: boolean): unknown {
	return {
		scroller,
		scaleFactor: SCALE,
		scaleSource: "test",
		pages: [
			{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: 600, heightPx: 800, hasCanvas: page1Rendered },
			{ pageNumber: 2, leftPx: 0, topPx: 810, widthPx: 600, heightPx: 800, hasCanvas: true },
		],
	};
}

function rig() {
	resetTipModeForTest();
	const ops: InkOp[] = [];
	const el = () => ({
		parentElement: null as unknown,
		classList: { add: () => {}, remove: () => {}, toggle: () => {} },
		setAttribute: () => {},
		setCssStyles: () => {},
		remove: () => {},
	});
	const viewport = {
		parentElement: null as unknown,
		classList: { contains: (cls: string) => cls === "handwriting-pdf-cursor-viewport" },
		setCssStyles() {},
		createDiv: () => ({ ...el(), parentElement: viewport }),
		remove() {},
	};
	const scroller = {
		scrollLeft: 0,
		scrollTop: 0,
		clientWidth: 600,
		clientHeight: 800,
		scrollWidth: 600,
		scrollHeight: 1610,
		classList: { add: () => {}, remove: () => {} },
		querySelector: () => null,
		setCssStyles: () => {},
		createDiv: () => viewport,
	};
	viewport.parentElement = scroller;
	probe.current = report(scroller, true);
	const win = {
		devicePixelRatio: 1,
		clearTimeout: () => {},
		setTimeout: () => 0,
		requestAnimationFrame: () => 0,
		cancelAnimationFrame: () => {},
		getComputedStyle: () => ({ position: "relative" }),
	};
	const strokes: InkStroke[] = [];
	const controller = new PdfInkController(
		{} as HTMLElement,
		win as unknown as Window,
		() => strokes,
		() => "doc-1",
		() => strokes,
		(op) => ops.push(op)
	);
	const priv = controller as unknown as Priv;
	priv.mounted = true;
	priv.boundScroller = scroller;
	priv.pageSize.set(1, { wPt: 300, hPt: 400 });
	const wetCanvas = fakeCanvas();
	const headCanvas = fakeCanvas();
	const wet = new WetInkRenderer(fakeCanvas(), false);
	wet.smooth = true;
	wet.shape = true;
	priv.pair = { wetCanvas, headCanvas, wet, tail: new TailRenderer(fakeCanvas()) };
	priv.wetHostPage = 1;
	const page1 = fakeCanvas();
	priv.overlays.set(1, { canvas: page1, paintedScale: SCALE, paintedCount: 0, paintedBand: null } as never);
	return { priv, scroller, wetCanvas, headCanvas, page1 };
}

describe("a pdf page that hosts the wet ink keeps it while the pen is down", () => {
	it("keeps the pair and the page's overlay when the viewer drops the page mid-stroke", () => {
		const { priv, scroller, wetCanvas, headCanvas, page1 } = rig();
		priv.penDown(sample(200, 200, 0), { pointerType: "pen" } as PointerEvent);
		priv.penRaw([sample(240, 250, 16)]);
		// Precondition: the gesture is on page 1 and the pair is parented there.
		expect(priv.owns(1)).toBe(true);
		expect(priv.wetHostPage).toBe(1);

		// pdf.js lets go of page 1 under the nib.
		probe.current = report(scroller, false);
		// The viewer's own observers drop the cached probe on its writes; without
		// this `sync` reads the cached report and never sees the page go.
		priv.invalidateProbe();
		const reads = priv.probeReads;
		priv.sync();
		expect(priv.probeReads).toBe(reads + 1);

		expect(priv.wetHostPage).toBe(1);
		expect(wetCanvas.removed).toBe(0);
		expect(headCanvas.removed).toBe(0);
		expect(priv.overlays.has(1)).toBe(true);
		expect(page1.removed).toBe(0);
	});

	it("still evicts the page once the pen is up", () => {
		const { priv, scroller, page1 } = rig();
		priv.penDown(sample(200, 200, 0), { pointerType: "pen" } as PointerEvent);
		priv.penRaw([sample(240, 250, 16)]);
		priv.penUp();
		expect(priv.owns(1)).toBe(false);

		probe.current = report(scroller, false);
		// The viewer's own observers drop the cached probe on its writes; without
		// this `sync` reads the cached report and never sees the page go.
		priv.invalidateProbe();
		const reads = priv.probeReads;
		priv.sync();
		expect(priv.probeReads).toBe(reads + 1);

		expect(priv.overlays.has(1)).toBe(false);
		expect(page1.removed).toBe(1);
		expect(priv.wetHostPage).toBe(0);
	});

	// Only the gesture's own page is kept. A gesture on page 1 does not hold
	// the canvas of a page 2 the viewer let go of: that page goes at once, so
	// a long stroke does not keep every passed page's backing store alive.
	it("evicts another page the viewer drops while a gesture is on page 1", () => {
		const { priv, scroller, page1 } = rig();
		const page2 = fakeCanvas();
		priv.overlays.set(2, { canvas: page2, paintedScale: SCALE, paintedCount: 0, paintedBand: null } as never);
		priv.penDown(sample(200, 200, 0), { pointerType: "pen" } as PointerEvent);
		priv.penRaw([sample(240, 250, 16)]);
		expect(priv.owns(1), "precondition: the gesture is on page 1").toBe(true);
		expect(priv.overlays.has(2), "precondition: page 2 has an overlay").toBe(true);

		// pdf.js lets go of page 2; page 1 stays rendered under the nib.
		const r = report(scroller, true) as { pages: { pageNumber: number; hasCanvas: boolean }[] };
		r.pages = r.pages.map((p) => (p.pageNumber === 2 ? { ...p, hasCanvas: false } : p));
		probe.current = r;
		priv.invalidateProbe();
		const reads = priv.probeReads;
		priv.sync();
		expect(priv.probeReads, "precondition: the sync read the new report").toBe(reads + 1);

		expect(priv.overlays.has(2), "a gesture on page 1 kept page 2's overlay").toBe(false);
		expect(page2.removed, "page 2's canvas stayed in the page").toBe(1);
		expect(priv.overlays.has(1)).toBe(true);
		expect(page1.removed).toBe(0);
		expect(priv.wetHostPage).toBe(1);
	});
});

/**
 * The same law for every gesture that draws on the wet layer, over a page div
 * that keeps a real list of its children.
 *
 * A lasso loop, a selection drag and an insert-space move draw on the one wet
 * pair as a stroke does. When the viewer let go of their page, the evict loop
 * took the overlay and un-parented the pair, so the loop, the box or the
 * divider was gone while the pen was down - and after the lift the selection
 * was held with no box drawn round it, because the page was rebuilt while the
 * gesture was live and the outline restore refuses then.
 *
 * And the evict loop is not the only door: `paint` rebuilds an overlay the
 * viewer took out of the page div, and it took the pair off the page with it,
 * gesture or not.
 *
 * Nothing is injected here: pen-down attaches the pair through the page div
 * the scroller hands back, and the rig's first sync paints the page's overlay.
 */

type Kid = {
	parentElement: FakePage | null;
	/** Every 2d context call made on this canvas, by name. */
	calls: string[];
	remove(): void;
};

class FakePage {
	children: Kid[] = [];
	clientWidth = 600;
	clientHeight = 800;
	get lastElementChild(): Kid | null {
		return this.children[this.children.length - 1] ?? null;
	}
	appendChild<T extends Kid>(kid: T): T {
		kid.remove();
		kid.parentElement = this;
		this.children.push(kid);
		return kid;
	}
	createEl(): Kid {
		return this.appendChild(trackedCanvas());
	}
	setCssStyles(): void {}
	/** The viewer replacing the page div's children: ours go with them. */
	takeChildren(): void {
		for (const kid of this.children) kid.parentElement = null;
		this.children = [];
	}
	has(kid: unknown): boolean {
		return this.children.includes(kid as Kid);
	}
}

function trackedCanvas(): Kid {
	const calls: string[] = [];
	const ctx = new Proxy(
		{},
		{
			get(_t, prop) {
				if (prop === "getContextAttributes") return () => ({ desynchronized: false });
				return () => {
					calls.push(String(prop));
				};
			},
			set() {
				return true;
			},
		}
	);
	const c = {
		width: 1200,
		height: 1600,
		parentElement: null as FakePage | null,
		calls,
		getContext: () => ctx,
		setAttribute: () => {},
		setCssProps: () => {},
		setCssStyles: () => {},
		toggleClass: () => {},
		classList: { add: () => {}, remove: () => {}, contains: () => false },
		remove() {
			const p = c.parentElement;
			if (p) p.children = p.children.filter((k) => k !== c);
			c.parentElement = null;
		},
	};
	return c;
}

type DomPriv = Omit<Priv, "pair" | "overlays"> & {
	pair: { wetCanvas: Kid; headCanvas: Kid } | null;
	overlays: Map<number, { canvas: Kid }>;
	builder: unknown;
	lassoPts: unknown[];
	dragFrom: unknown;
	spaceLineY: number | null;
	panLast: unknown;
};

type Gesture = "stroke" | "lasso" | "drag" | "space" | "pan";

const pen = { pointerType: "pen" } as PointerEvent;
/** The pen's side button: a lasso whatever the strip's mode. */
const barrel = { buttons: 2, button: 2, pointerType: "pen" } as PointerEvent;

function domRig() {
	resetTipModeForTest();
	const pts = Array.from({ length: 50 }, (_, i) => ({ x: 100 + (i % 11), y: 100 + (i % 11), pressure: 0.5, t: i }));
	let ink: InkStroke[] = [
		{ id: "s1", points: pts, bbox: computeBBox(pts, 2), tool: "pen", color: "#000000", width: 2, createdAt: 0, page: 1 },
	];
	const page1 = new FakePage();
	const viewport = {
		parentElement: null as unknown,
		classList: { contains: (cls: string) => cls === "handwriting-pdf-cursor-viewport" },
		setCssStyles() {},
		createDiv: () => ({
			parentElement: viewport,
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			setAttribute: () => {},
			setCssStyles: () => {},
			remove: () => {},
		}),
		remove() {},
	};
	const scroller = {
		scrollLeft: 0,
		scrollTop: 0,
		clientWidth: 600,
		clientHeight: 800,
		scrollWidth: 600,
		scrollHeight: 1610,
		classList: { add: () => {}, remove: () => {} },
		querySelector: (sel: string) => (/data-page-number="1"/.test(sel) ? page1 : null),
		setCssStyles: () => {},
		createDiv: () => viewport,
	};
	viewport.parentElement = scroller;
	const win = {
		devicePixelRatio: 1,
		clearTimeout: () => {},
		setTimeout: () => 0,
		requestAnimationFrame: () => 0,
		cancelAnimationFrame: () => {},
		getComputedStyle: () => ({ position: "relative" }),
	};
	const controller = new PdfInkController(
		{} as HTMLElement,
		win as unknown as Window,
		(page) => ink.filter((s) => s.page === page),
		() => "doc-1",
		() => ink,
		(op) => {
			ink = applyOp(ink, op);
		}
	);
	const priv = controller as unknown as DomPriv;
	priv.mounted = true;
	priv.boundScroller = scroller;
	priv.pageSize.set(1, { wPt: 300, hPt: 400 });
	/** The viewer's report changes and its observers drop the cached probe, then a sync. */
	const resync = (page1Rendered: boolean) => {
		probe.current = report(scroller, page1Rendered);
		priv.invalidateProbe();
		const reads = priv.probeReads;
		priv.sync();
		expect(reads + 1, "precondition: the sync read the new report").toBe(priv.probeReads);
	};
	resync(true);
	const overlay = priv.overlays.get(1)?.canvas;
	expect(overlay?.parentElement, "precondition: the first sync painted page 1's overlay").toBe(page1);

	/** Put the pen down for one gesture on page 1 and move it, leaving it down. */
	const start = (kind: Gesture) => {
		if (kind === "stroke") {
			priv.penDown(sample(200, 200, 0), pen);
			priv.penRaw([sample(240, 250, 16)]);
			expect(priv.builder, "precondition: a stroke is live").not.toBeNull();
		} else if (kind === "lasso") {
			priv.penDown(sample(150, 150, 0), barrel);
			priv.penRaw([sample(250, 150, 16), sample(250, 250, 32), sample(150, 250, 48)]);
			expect(priv.lassoPts.length, "precondition: a lasso loop is live").toBeGreaterThan(0);
		} else if (kind === "drag") {
			priv.penDown(sample(150, 150, 0), barrel);
			priv.penRaw([sample(250, 150, 16), sample(250, 250, 32), sample(150, 250, 48), sample(150, 150, 64)]);
			priv.penUp();
			expect(controller.hasSelection, "precondition: the lasso selected the stroke").toBe(true);
			priv.penDown(sample(205, 205, 100), pen);
			priv.penRaw([sample(225, 235, 116)]);
			expect(priv.dragFrom, "precondition: a selection drag is live").toBeTruthy();
		} else if (kind === "space") {
			setTipMode("space");
			// Above the stroke, so the divider has ink below it.
			priv.penDown(sample(300, 100, 0), pen);
			priv.penRaw([sample(300, 120, 16)]);
			expect(priv.spaceLineY, "precondition: a space move is live").not.toBeNull();
		} else {
			setTipMode("pan");
			priv.penDown(sample(300, 300, 0), pen);
			expect(priv.panLast, "precondition: a pan is live").toBeTruthy();
		}
		if (kind !== "pan") {
			expect(priv.wetHostPage, "precondition: pen-down put the pair on page 1").toBe(1);
		}
	};

	/** The pair is on page 1: hosted there, both canvases its children, over the overlay. */
	const expectPairOnPage1 = (why: string) => {
		const pair = priv.pair;
		expect(priv.wetHostPage, why).toBe(1);
		expect(pair && page1.has(pair.wetCanvas), `${why}: the wet canvas is page 1's child`).toBe(true);
		expect(pair && page1.has(pair.headCanvas), `${why}: the head canvas is page 1's child`).toBe(true);
		const committed = priv.overlays.get(1)?.canvas;
		expect(committed && page1.has(committed), `${why}: page 1 has its overlay`).toBe(true);
		expect(
			page1.children.indexOf(committed as Kid) < page1.children.indexOf(pair?.wetCanvas as Kid),
			`${why}: the wet canvas is over the committed one`
		).toBe(true);
	};

	return { controller, priv, page1, overlay: overlay as Kid, resync, start, expectPairOnPage1 };
}

describe("a pdf page keeps the wet pair for a lasso, a drag and a space move too", () => {
	it.each(["lasso", "drag", "space"] as const)(
		"a %s keeps the pair and the page's overlay when the viewer drops the page",
		(kind) => {
			const r = domRig();
			r.start(kind);
			// pdf.js lets go of page 1 with the pen still down.
			r.resync(false);
			expect(r.priv.overlays.has(1), "the evict loop took the gesture's page").toBe(true);
			expect(r.overlay.parentElement, "the page's overlay left the page mid-gesture").toBe(r.page1);
			r.expectPairOnPage1("the evict loop took the pair off the gesture's page");
		}
	);

	it("a lasso whose page the viewer dropped and gave back draws its box at the lift", () => {
		const r = domRig();
		r.start("lasso");
		r.resync(false);
		r.resync(true);
		const wet = r.priv.pair?.wetCanvas;
		expect(wet, "precondition: the pair exists").toBeTruthy();
		wet!.calls.length = 0;
		r.priv.penUp();
		expect(r.controller.hasSelection, "precondition: the lasso selected the stroke").toBe(true);
		expect(r.priv.wetHostPage, "the lift found no pair on the page").toBe(1);
		expect(wet!.calls, "the selection is held with no box drawn round it").toContain("strokeRect");
	});

	it("a pan does not keep the page the viewer dropped", () => {
		const r = domRig();
		r.start("pan");
		r.resync(false);
		expect(r.priv.overlays.has(1), "a pan held a page the viewer let go of").toBe(false);
		expect(r.overlay.parentElement).toBeNull();
	});

	it.each(["lasso", "drag", "space"] as const)(
		"the first sync after a %s's lift drops a page still outside the viewer's set",
		(kind) => {
			const r = domRig();
			r.start(kind);
			r.resync(false);
			r.priv.penUp();
			r.resync(false);
			expect(r.priv.overlays.has(1), "the page outlived its gesture").toBe(false);
			expect(r.overlay.parentElement).toBeNull();
			expect(r.priv.wetHostPage).toBe(0);
		}
	);
});

describe("after a sync, a page with a live gesture hosts the pair, even when the viewer took its children", () => {
	it.each(["stroke", "lasso", "drag", "space"] as const)(
		"a %s: the viewer drops the page and takes its children, the page returns, sync",
		(kind) => {
			const r = domRig();
			r.start(kind);
			r.page1.takeChildren();
			r.resync(false);
			r.resync(true);
			r.expectPairOnPage1("paint rebuilt the taken overlay and left the pair off the page");
		}
	);
});
