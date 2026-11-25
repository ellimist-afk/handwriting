/**
 * A PDF page with no ink yet, after the viewer turns it.
 *
 * A turned page refuses new ink: the stroke would be stored in the upright
 * page's frame at the turned screen's numbers, and painted back through the
 * turn somewhere else. A page that has ink knows it is turned once it is
 * painted or the viewer's writes reach the observer. A page with no ink is
 * never painted and never measured, so nothing marks it turned, and the
 * first pen on it after the turn has to be refused all the same.
 *
 * These cells drive the real controller through `mount()`: the viewer probe
 * and the strip are stubbed, and the mutation observer is captured so the
 * cell can fire it the way the viewer's own DOM writes would. No frame or
 * timer is ever flushed, so no repaint runs between the turn and the pen.
 * The rig is PdfTurnMidStroke.test.ts's, with no measuring call.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { InkOp } from "../inline/InkHistory";
import { InkStroke, computeBBox } from "../ink/Stroke";
import { PenSample } from "../input/PointerRouter";
import { resetTipModeForTest, setTipMode } from "../inline/TipMode";

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
		addEventListener: () => {},
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
	/** Fire the observer with the attribute writes the viewer makes on a turn. */
	viewerWrites(): void;
	/** The size the page was measured at by a repaint, as `paint` records it. */
	measured(): void;
	/** Whether the pan tool started a pan at the last pen-down. */
	panStarted(): boolean;
	addedPoints(): Array<{ x: number; y: number }>;
}

let teardown: Array<() => void> = [];
afterEach(() => {
	for (const t of teardown.reverse()) t();
	teardown = [];
	probe.current = null;
	resetTipModeForTest();
	vi.unstubAllGlobals();
});

/** One page at the top left of the scroller, one css px per point. */
function rig(pageW: number, pageH: number, opts: { unreadableTurn?: boolean; strokes?: InkStroke[] } = {}): Rig {
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
	const box = () => (deg % 180 === 0 ? { w: pageW, h: pageH } : { w: pageH, h: pageW });
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
		scrollWidth: 1600,
		scrollHeight: 4000,
		style: {},
		classList: { add: () => {}, remove: () => {}, contains: () => false },
		querySelector: (sel: string) => (/div\.page\[data-page-number="1"\]/.test(sel) ? pageEl : null),
		addEventListener: () => {},
		removeEventListener: () => {},
		setCssStyles: () => {},
		setCssProps: () => {},
		toggleClass: () => {},
	};
	const setProbe = () => {
		const b = box();
		probe.current = {
			scroller,
			scaleFactor: 1,
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
		(page: number) => (page === 1 ? (opts.strokes ?? []) : []),
		() => "doc-1",
		() => [],
		(op) => ops.push(op),
		() => {},
		(message) => notices.push(message)
	);
	// An unreadable turn is a source that throws: the viewer's attribute is gone or not a number.
	setViewTurnSource(controller, () => {
		if (opts.unreadableTurn) throw new Error("no turn attribute");
		return deg;
	});
	controller.mount();
	teardown.push(() => controller.unmount());
	(controller as unknown as { boundScroller: unknown }).boundScroller = scroller;
	const priv = controller as unknown as {
		pageWidthPt(p: number, w: number, h: number, s: number): number;
		panLast: unknown;
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
		viewerWrites: () => {
			if (!notify) throw new Error("mount() built no mutation observer");
			const rec = (attributeName: string) =>
				({ target: layer, type: "attributes", attributeName, addedNodes: [], removedNodes: [] }) as unknown as MutationRecord;
			notify([rec("data-main-rotation"), rec("style")]);
		},
		measured: () => {
			const b = box();
			priv.pageWidthPt(1, b.w, b.h, 1);
		},
		panStarted: () => priv.panLast !== null,
		addedPoints: () =>
			ops.flatMap((op) => (op.type === "add" ? op.strokes.flatMap((s) => s.points.map((p) => ({ x: p.x, y: p.y }))) : [])),
	};
}

const adds = (ops: InkOp[]) => ops.filter((op) => op.type === "add").length;
const turnedNotices = (n: string[]) => n.filter((m) => m.includes("rotated")).length;

describe("a clean PDF page, never painted, after the viewer turns", () => {
	for (const d of [180, 90, 270] as const) {
		it(`turn ${d}: a pen on a page with no ink and no repaint since the turn is refused`, () => {
			const r = rig(600, 800);
			// The page has no ink, so no paint ever measured it.
			expect(r.controller.isRotated(1), "premise: the page starts unmeasured and upright").toBe(false);
			r.turn(d);
			r.viewerWrites();
			r.pen.penDown(sample(100, 100));
			r.pen.penRaw([sample(110, 110), sample(120, 120)]);
			r.pen.penUp();
			const pts = r.addedPoints();
			expect.soft(adds(r.ops), `a pen on a clean page turned ${d} saved ink: ${JSON.stringify(pts)}`).toBe(0);
			expect
				.soft(r.notices.some((n) => n.includes("rotated")), `no notice said the turned page takes no ink: ${JSON.stringify(r.notices)}`)
				.toBe(true);
		});
	}

	it("control: the same clean page upright draws on the marks", () => {
		const r = rig(600, 800);
		r.viewerWrites();
		r.pen.penDown(sample(100, 100));
		r.pen.penRaw([sample(110, 110), sample(120, 120)]);
		r.pen.penUp();
		expect(adds(r.ops)).toBe(1);
		const xs = r.addedPoints().map((p) => p.x);
		expect(Math.min(...xs), "upright clean page: stored x off the marks").toBeGreaterThanOrEqual(99);
		expect(Math.max(...xs), "upright clean page: stored x off the marks").toBeLessThanOrEqual(121);
	});

	it("turn 180: a second pen on the same clean page is refused too, with the notice shown once", () => {
		const r = rig(600, 800);
		r.turn(180);
		r.viewerWrites();
		for (const at of [100, 300]) {
			r.pen.penDown(sample(at, at));
			r.pen.penRaw([sample(at + 10, at + 10), sample(at + 20, at + 20)]);
			r.pen.penUp();
		}
		expect.soft(adds(r.ops), `two pens on a clean page turned 180 saved ink: ${JSON.stringify(r.addedPoints())}`).toBe(0);
		expect
			.soft(r.notices.filter((n) => n.includes("rotated")).length, `the turned-page notice count: ${JSON.stringify(r.notices)}`)
			.toBe(1);
	});

	it("control: a turn that cannot be read leaves a clean page drawing as before", () => {
		const r = rig(600, 800, { unreadableTurn: true });
		r.viewerWrites();
		r.pen.penDown(sample(100, 100));
		r.pen.penRaw([sample(110, 110), sample(120, 120)]);
		r.pen.penUp();
		expect(adds(r.ops), "an unreadable turn refused a clean page").toBe(1);
		expect(r.notices.some((n) => n.includes("rotated")), "an unreadable turn showed the turned-page notice").toBe(false);
	});

	it("control: an upright view of a landscape page, never measured, draws on the marks", () => {
		// A page whose box is wider than tall is not a turned page while the view reads 0.
		const r = rig(800, 600);
		r.viewerWrites();
		r.pen.penDown(sample(100, 100));
		r.pen.penRaw([sample(110, 110), sample(120, 120)]);
		r.pen.penUp();
		expect(adds(r.ops), "an upright landscape page was refused").toBe(1);
		expect(r.notices.some((n) => n.includes("rotated")), "an upright landscape page showed the turned-page notice").toBe(false);
	});

	it("control: the pan tool on a clean page still pans while the view is turned, with no ink notice", () => {
		// A pan saves no stroke and maps nothing through the page's frame: it moves the scroller.
		const r = rig(600, 800);
		setTipMode("pan");
		r.turn(180);
		r.viewerWrites();
		r.pen.penDown(sample(100, 100));
		const started = r.panStarted();
		r.pen.penRaw([sample(100, 140), sample(100, 180)]);
		r.pen.penUp();
		expect.soft(started, "the pan tool did not start a pan on a turned view").toBe(true);
		expect.soft(turnedNotices(r.notices), `a pan was told ink is not supported: ${JSON.stringify(r.notices)}`).toBe(0);
		expect.soft(adds(r.ops), "a pan saved ink").toBe(0);
	});

	it("the pan tool inside a held selection on an unpainted page pans while the view is turned, and moves no ink", () => {
		// Pasted ink is selected and saved before the page is first painted, so the page is not yet in `rotated`.
		const points = [0, 1, 2].map((i) => ({ x: 100 + i * 10, y: 100 + i * 10, pressure: 0.5, t: i * 8 }));
		const pasted: InkStroke = { id: "p-1", tool: "pen", color: "#202020", width: 3, points, bbox: computeBBox(points, 3), createdAt: 0, page: 1 };
		const r = rig(600, 800, { strokes: [pasted] });
		const sel = r.controller as unknown as { selected: string[]; selectionPage: number };
		sel.selected = ["p-1"];
		sel.selectionPage = 1;
		expect(r.controller.isRotated(1), "premise: the page is not in the measured turned set").toBe(false);
		setTipMode("pan");
		r.turn(180);
		r.viewerWrites();
		r.pen.penDown(sample(110, 110));
		const started = r.panStarted();
		r.pen.penRaw([sample(110, 150), sample(110, 190)]);
		r.pen.penUp();
		expect.soft(r.ops.map((op) => op.type), "a pan inside the selection under a turn wrote ops").toEqual([]);
		expect.soft(started, "the pan tool inside the selection did not pan under a turn").toBe(true);
	});

	it("turned, refused, turned back upright: the next pen on the clean page draws on the marks", () => {
		// The upright pen reads the page as the view shows it now, with no repaint in between.
		const r = rig(600, 800);
		r.turn(180);
		r.viewerWrites();
		r.pen.penDown(sample(100, 100));
		r.pen.penRaw([sample(110, 110), sample(120, 120)]);
		r.pen.penUp();
		const before = adds(r.ops);
		r.turn(0);
		r.viewerWrites();
		r.pen.penDown(sample(200, 200));
		r.pen.penRaw([sample(210, 210), sample(220, 220)]);
		r.pen.penUp();
		expect.soft(adds(r.ops) - before, "turned back upright, the clean page took no ink").toBe(1);
		const last = r.ops.filter((op) => op.type === "add").slice(-1);
		const xs = last.flatMap((op) => (op.type === "add" ? op.strokes.flatMap((s) => s.points.map((p) => p.x)) : []));
		if (xs.length > 0) {
			expect.soft(Math.min(...xs), "upright stroke off the marks").toBeGreaterThanOrEqual(199);
			expect.soft(Math.max(...xs), "upright stroke off the marks").toBeLessThanOrEqual(221);
		}
	});

	it("a clean page says it takes no ink again on a second turned spell, as an inked page does", () => {
		const r = rig(600, 800);
		const pen = (at: number) => {
			r.pen.penDown(sample(at, at));
			r.pen.penRaw([sample(at + 10, at + 10)]);
			r.pen.penUp();
		};
		r.turn(180);
		r.viewerWrites();
		pen(100);
		// Turned back upright with no pen in between: the viewer's writes alone end the turned spell.
		r.turn(0);
		r.viewerWrites();
		r.turn(180);
		r.viewerWrites();
		pen(300);
		expect.soft(adds(r.ops), `a turned clean page took ink: ${JSON.stringify(r.addedPoints())}`).toBe(0);
		expect.soft(turnedNotices(r.notices), `clean page notices over two turned spells: ${JSON.stringify(r.notices)}`).toBe(2);
	});

	it("control: an inked, measured page says it takes no ink again on a second turned spell", () => {
		const r = rig(600, 800);
		r.measured();
		const pen = (at: number) => {
			r.pen.penDown(sample(at, at));
			r.pen.penRaw([sample(at + 10, at + 10)]);
			r.pen.penUp();
		};
		r.turn(180);
		r.viewerWrites();
		pen(100);
		r.turn(0);
		r.viewerWrites();
		r.measured();
		r.turn(180);
		r.viewerWrites();
		pen(300);
		expect.soft(adds(r.ops), "a turned inked page took ink").toBe(0);
		expect.soft(turnedNotices(r.notices), `inked page notices over two turned spells: ${JSON.stringify(r.notices)}`).toBe(2);
	});
});
