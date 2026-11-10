/**
 * A PDF page the viewer turns while the pen is down.
 *
 * The stroke's frame is frozen at pen-down in the upright page's frame, and a
 * turned page refuses new ink. A turn that lands mid-stroke has to end the
 * stroke at the turn, the way a zoom does: what was drawn before it is
 * committed on its marks, and the samples after it are not mapped through a
 * frame the page no longer has. A half turn leaves the page box the same
 * size, and so does a quarter turn of a page within a pixel of square, so
 * the page's width alone cannot tell.
 *
 * And a pen that lands after the turn but before the next repaint has to be
 * refused like any other pen on a turned page.
 *
 * These cells drive the real controller through `mount()`: the viewer probe
 * and the strip are stubbed, and the mutation observer is captured so the
 * cell can fire it the way the viewer's own DOM writes would. No frame or
 * timer is ever flushed, so no repaint runs between the turn and what
 * follows it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { InkOp } from "../inline/InkHistory";
import { PenSample } from "../input/PointerRouter";
import { resetTipModeForTest } from "../inline/TipMode";

const probe = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("./PdfViewerProbe", () => ({
	probeViewer: () => probe.current,
	viewerCanvasOf: () => null,
	wholePageCanvasOf: () => null,
}));
vi.mock("../inline/MobileTools", () => ({
	MobileTools: class {
		setCorner() {}
		refresh() {}
		setInking() {}
		closeInkSliders() {}
		stale() {
			return false;
		}
		destroy() {}
	},
}));

import { PdfInkController } from "./PdfInkController";
import { setViewTurnSource } from "./PdfInkBand";

class NoopObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}

function fakeCanvas(parent: unknown): Record<string, unknown> {
	const ctx = new Proxy({} as Record<string, unknown>, {
		get: (t, p) => (p in t ? t[p as string] : () => undefined),
		set: (t, p, v) => {
			t[p as string] = v;
			return true;
		},
	});
	const c: Record<string, unknown> = {
		width: 300,
		height: 150,
		parentElement: parent,
		style: {},
		setAttribute: () => {},
		remove() {
			c.parentElement = null;
		},
		getContext: () => ctx,
		setCssStyles: () => {},
		setCssProps: () => {},
		toggleClass: () => {},
		classList: { add: () => {}, remove: () => {}, contains: () => false },
	};
	return c;
}

function sample(x: number, y: number): PenSample {
	return { x, y, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 };
}

interface Rig {
	controller: PdfInkController;
	pen: { penDown(s: PenSample): void; penRaw(s: PenSample[]): void; penUp(): void };
	ops: InkOp[];
	notices: string[];
	/** Turn the page as the viewer would: the turn source answers it and a quarter turn swaps the box. */
	turn(deg: 0 | 90 | 180 | 270): void;
	/** Resize the page box, as a zoom would. */
	zoom(factor: number): void;
	/** Fire the observer with the attribute writes the viewer makes on a turn or a zoom. */
	viewerWrites(): void;
	/** The size the page was measured at by the last repaint, as `paint` records it. */
	measured(): void;
	frame(): unknown;
	/** The page div's width as the observer reads it. */
	pageWidthNow(): number;
	addedPoints(): Array<{ x: number; y: number }>;
}

let teardown: Array<() => void> = [];
afterEach(() => {
	for (const t of teardown.reverse()) t();
	teardown = [];
	probe.current = null;
	vi.unstubAllGlobals();
});

/** One page at the top left of the scroller, one css px per point. */
function rig(pageW: number, pageH: number): Rig {
	resetTipModeForTest();
	let notify: ((records: MutationRecord[]) => void) | null = null;
	vi.stubGlobal("Element", class {});
	vi.stubGlobal("ResizeObserver", NoopObserver);
	vi.stubGlobal(
		"MutationObserver",
		class {
			constructor(fn: (records: MutationRecord[]) => void) {
				notify = fn;
			}
			observe() {}
			disconnect() {}
		}
	);
	let deg: 0 | 90 | 180 | 270 = 0;
	let k = 1;
	const box = () => {
		const w = Math.round(pageW * k);
		const h = Math.round(pageH * k);
		return deg % 180 === 0 ? { w, h } : { w: h, h: w };
	};
	const pageEl = {
		get clientWidth() {
			return box().w;
		},
		get clientHeight() {
			return box().h;
		},
		getAttribute: () => null,
		querySelector: () => null,
		querySelectorAll: () => [],
		// The wet pair `attachPair` builds at pen-down; a canvas whose context
		// takes every call, as in PdfInkController.test.ts.
		createEl: () => fakeCanvas(pageEl),
		appendChild: () => {},
		setCssStyles: () => {},
	};
	const layer = { instanceOf: () => false, classList: { contains: () => false } };
	const scroller = {
		scrollLeft: 0,
		scrollTop: 0,
		clientWidth: 1600,
		clientHeight: 1200,
		classList: { add: () => {}, remove: () => {}, contains: () => false },
		querySelector: (sel: string) => (/div\.page\[data-page-number="1"\]/.test(sel) ? pageEl : null),
		addEventListener: () => {},
		removeEventListener: () => {},
	};
	const setProbe = () => {
		const b = box();
		probe.current = {
			scroller,
			scaleFactor: k,
			scaleSource: "test",
			pages: [{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: b.w, heightPx: b.h, hasCanvas: true }],
		};
	};
	setProbe();
	const root = {
		addEventListener: () => {},
		removeEventListener: () => {},
		classList: { add: () => {}, remove: () => {}, contains: () => false },
		querySelector: () => null,
		contains: () => false,
	};
	const win = {
		devicePixelRatio: 1,
		navigator: { userAgent: "test", platform: "", maxTouchPoints: 0 },
		// Captured and never run: no repaint happens inside a cell.
		setTimeout: () => 0,
		clearTimeout: () => {},
		requestAnimationFrame: () => 0,
		cancelAnimationFrame: () => {},
		// The page div is already positioned, as the viewer leaves it.
		getComputedStyle: () => ({ position: "relative" }),
		getSelection: () => null,
	};
	const ops: InkOp[] = [];
	const notices: string[] = [];
	const controller = new PdfInkController(
		root as unknown as HTMLElement,
		win as unknown as Window,
		() => [],
		() => "doc-1",
		() => [],
		(op) => ops.push(op),
		() => {},
		(message) => notices.push(message)
	);
	setViewTurnSource(controller, () => deg);
	controller.mount();
	teardown.push(() => controller.unmount());
	(controller as unknown as { boundScroller: unknown }).boundScroller = scroller;
	const priv = controller as unknown as {
		frame: unknown;
		pageWidthPt(p: number, w: number, h: number, s: number): number;
	};
	return {
		controller,
		pen: controller as unknown as Rig["pen"],
		ops,
		notices,
		turn: (d) => {
			deg = d;
			setProbe();
		},
		zoom: (factor) => {
			k = factor;
			setProbe();
		},
		viewerWrites: () => {
			if (!notify) throw new Error("mount() built no mutation observer");
			const rec = (attributeName: string) =>
				({ target: layer, type: "attributes", attributeName, addedNodes: [], removedNodes: [] }) as unknown as MutationRecord;
			notify([rec("data-main-rotation"), rec("style")]);
		},
		measured: () => {
			const b = box();
			priv.pageWidthPt(1, b.w, b.h, k);
		},
		frame: () => priv.frame,
		pageWidthNow: () => pageEl.clientWidth,
		addedPoints: () =>
			ops.flatMap((op) => (op.type === "add" ? op.strokes.flatMap((s) => s.points.map((p) => ({ x: p.x, y: p.y }))) : [])),
	};
}

const adds = (ops: InkOp[]) => ops.filter((op) => op.type === "add").length;

describe("a PDF page turned while the pen is down", () => {
	it("a half turn mid-stroke ends the stroke at the turn; the ink before it is kept on its marks", () => {
		const r = rig(600, 800);
		r.pen.penDown(sample(100, 100));
		r.pen.penRaw([sample(110, 110), sample(120, 120)]);
		expect(r.frame(), "the stroke is live before the turn").not.toBeNull();
		r.turn(180);
		r.viewerWrites();
		expect(r.frame(), "the stroke is still open after a half turn of the page").toBeNull();
		expect(adds(r.ops), "the ink drawn before the turn was not committed at the turn").toBe(1);
		const before = r.addedPoints();
		for (const p of before) expect(p.x, "a committed point lies past the last sample before the turn").toBeLessThanOrEqual(120);
		// The pen is still on the glass: its next samples and its lift add nothing.
		r.pen.penRaw([sample(300, 300), sample(320, 320)]);
		r.pen.penUp();
		expect(adds(r.ops), "samples after the turn made a second stroke").toBe(1);
		expect(r.addedPoints()).toEqual(before);
	});

	it("a quarter turn of a page within 1 px of square ends the stroke at the turn", () => {
		const r = rig(600, 601);
		r.pen.penDown(sample(100, 100));
		r.pen.penRaw([sample(110, 110), sample(120, 120)]);
		r.turn(90);
		const frozen = (r.frame() as { boxes: Array<{ widthPx: number }> }).boxes[0]!.widthPx;
		expect(Math.abs(r.pageWidthNow() - frozen), "the page width moved by more than 1 px; this is not the near-square case").toBeLessThanOrEqual(1);
		r.viewerWrites();
		expect(r.frame(), "the stroke is still open after a quarter turn of a near-square page").toBeNull();
		expect(adds(r.ops)).toBe(1);
		r.pen.penRaw([sample(300, 300)]);
		r.pen.penUp();
		expect(adds(r.ops), "samples after the turn made a second stroke").toBe(1);
	});

	it("control: viewer writes with no turn leave the stroke open, and it commits whole at the lift", () => {
		const r = rig(600, 800);
		r.pen.penDown(sample(100, 100));
		r.pen.penRaw([sample(110, 110), sample(120, 120)]);
		r.viewerWrites();
		expect(r.frame(), "a viewer write with no turn ended the stroke").not.toBeNull();
		expect(adds(r.ops)).toBe(0);
		r.pen.penRaw([sample(300, 300), sample(320, 320)]);
		r.pen.penUp();
		expect(adds(r.ops)).toBe(1);
		expect(Math.max(...r.addedPoints().map((p) => p.x)), "the samples after the viewer write are missing").toBeGreaterThanOrEqual(300);
	});

	it("control: a zoom mid-stroke still ends the stroke", () => {
		const r = rig(600, 800);
		r.pen.penDown(sample(100, 100));
		r.pen.penRaw([sample(110, 110), sample(120, 120)]);
		r.zoom(1.5);
		r.viewerWrites();
		expect(r.frame(), "a zoom mid-stroke no longer ends the stroke").toBeNull();
		expect(adds(r.ops)).toBe(1);
	});
});

describe("a pen that lands after the turn and before the next repaint", () => {
	it("is refused, as on any turned page", () => {
		const r = rig(600, 800);
		// The page was painted upright before the turn.
		r.measured();
		expect(r.controller.isRotated(1)).toBe(false);
		r.turn(180);
		r.viewerWrites();
		// No repaint has run: the pen lands now.
		r.pen.penDown(sample(100, 100));
		r.pen.penRaw([sample(110, 110), sample(120, 120)]);
		r.pen.penUp();
		expect(r.frame(), "a pen on the turned page opened a stroke before the repaint").toBeNull();
		expect(adds(r.ops), "a pen on the turned page saved ink before the repaint").toBe(0);
		expect(r.notices.some((n) => n.includes("rotated")), "no notice said the turned page takes no ink").toBe(true);
	});

	it("control: the same pen on an upright page with no turn draws", () => {
		const r = rig(600, 800);
		r.measured();
		r.viewerWrites();
		r.pen.penDown(sample(100, 100));
		r.pen.penRaw([sample(110, 110), sample(120, 120)]);
		r.pen.penUp();
		expect(adds(r.ops)).toBe(1);
		expect(r.notices.filter((n) => n.includes("rotated"))).toEqual([]);
	});

	it("control: turned back upright, the next repaint lets the pen draw again", () => {
		const r = rig(600, 800);
		r.measured();
		r.turn(180);
		r.viewerWrites();
		r.turn(0);
		r.viewerWrites();
		r.measured();
		expect(r.controller.isRotated(1)).toBe(false);
		r.pen.penDown(sample(100, 100));
		r.pen.penRaw([sample(110, 110)]);
		r.pen.penUp();
		expect(adds(r.ops)).toBe(1);
	});
});
