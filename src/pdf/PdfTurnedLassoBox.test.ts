/**
 * A held lasso selection's box on a PDF page the viewer turns.
 *
 * The saved ink on a turned page is painted turned with it, at the scale of
 * the page's upright side (PdfTurnedPagePaint.test.ts). The box around a held
 * selection lives on the wet layer and is drawn by its own code, so it has to
 * be drawn in that same frame, or it lands where the ink was before the turn
 * and not around it. A half turn leaves the page the same size, so nothing
 * about the page's size tells the wet layer that the box must move.
 *
 * These cells drive the real paint through `sync()` with canvas fakes that
 * track the full 2D transform, then read where the box landed back in the
 * page's own css px. The selection is held as a lasso leaves it at pen-up:
 * the strokes picked, the wet layer on their page, the box drawn once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InkStroke, computeBBox } from "../ink/Stroke";
import { resetTipModeForTest } from "../inline/TipMode";
import { installFakeWindow } from "../../test/routerHarness";

class NoopObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
const g = globalThis as unknown as Record<string, unknown>;
g.ResizeObserver ??= NoopObserver;
g.MutationObserver ??= NoopObserver;

const probe = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("./PdfViewerProbe", () => ({
	probeViewer: () => probe.current,
	viewerCanvasOf: () => null,
	wholePageCanvasOf: () => null,
}));

import { PdfInkController } from "./PdfInkController";
import { setViewTurnSource } from "./PdfInkBand";

/** The upright page, in points and css px (1 css px per point). */
const PAGE_W = 600;
const PAGE_H = 800;

/** A short stroke around upright page point (cx, cy): off every axis of symmetry. */
function inkNear(id: string, cx: number, cy: number): InkStroke {
	const points = [-4, 0, 4].map((d, i) => ({ x: cx + d, y: cy + d, pressure: 0.5, t: i * 8 }));
	return { id, tool: "pen", color: "#000000", width: 2, points, bbox: computeBBox(points, 4), createdAt: 0, page: 1 };
}

type M = [number, number, number, number, number, number];
const mul = (m: M, a: number, b: number, c: number, d: number, e: number, f: number): M => [
	m[0] * a + m[2] * b,
	m[1] * a + m[3] * b,
	m[0] * c + m[2] * d,
	m[1] * c + m[3] * d,
	m[0] * e + m[2] * f + m[4],
	m[1] * e + m[3] * f + m[5],
];
const apply = (m: M, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const invert = (m: M): M => {
	const det = m[0] * m[3] - m[1] * m[2];
	return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
};

/** An axis-aligned rectangle in the page's css px. */
interface Rect {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

/** The rectangle around some points. */
function around(ps: Array<[number, number]>): Rect {
	const xs = ps.map((p) => p[0]);
	const ys = ps.map((p) => p[1]);
	return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

interface Track {
	/** Every box the canvas drew (`strokeRect`), in the page's css px, oldest first. */
	rects: Rect[];
	/** Every path point drawn after the newest page-frame `setTransform`, in the page's css px. */
	points: Array<[number, number]>;
	calls: string[];
}

/**
 * A 2D context that tracks the current transform exactly and maps every box
 * and path point through it, back into the page's css px by the inverse of the
 * last transform set with an empty save stack (the band transform, which is
 * what puts the context in page coordinates).
 */
function trackingCtx(canvas: { width: number; height: number }): { ctx: CanvasRenderingContext2D; track: Track } {
	const track: Track = { rects: [], points: [], calls: [] };
	let m: M = [1, 0, 0, 1, 0, 0];
	let page: M = [1, 0, 0, 1, 0, 0];
	const stack: M[] = [];
	const toPage = (x: number, y: number): [number, number] => apply(invert(page), ...apply(m, x, y));
	const log = (name: string, args: unknown[]) =>
		track.calls.push(`${name}(${args.map((a) => (typeof a === "number" ? +a.toFixed(6) : typeof a === "string" || typeof a === "boolean" ? JSON.stringify(a) : typeof a)).join(",")})`);
	const target: Record<string, unknown> = {
		canvas,
		setTransform: (...args: unknown[]) => {
			const t = (typeof args[0] === "object" && args[0] !== null
				? (({ a, b, c, d, e, f }) => [a, b, c, d, e, f])(args[0] as DOMMatrix)
				: args) as M;
			m = [...t] as M;
			if (stack.length === 0) {
				page = m;
				track.points = [];
			}
			log("setTransform", t);
		},
		transform: (a: number, b: number, c: number, d: number, e: number, f: number) => {
			m = mul(m, a, b, c, d, e, f);
			log("transform", [a, b, c, d, e, f]);
		},
		translate: (x: number, y: number) => {
			m = mul(m, 1, 0, 0, 1, x, y);
			log("translate", [x, y]);
		},
		scale: (x: number, y: number) => {
			m = mul(m, x, 0, 0, y, 0, 0);
			log("scale", [x, y]);
		},
		rotate: (r: number) => {
			m = mul(m, Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0);
			log("rotate", [r]);
		},
		save: () => {
			stack.push(m);
			log("save", []);
		},
		restore: () => {
			m = stack.pop() ?? m;
			log("restore", []);
		},
		getTransform: () => ({ a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] }),
		strokeRect: (x: number, y: number, w: number, h: number) => {
			track.rects.push(around([toPage(x, y), toPage(x + w, y), toPage(x, y + h), toPage(x + w, y + h)]));
			log("strokeRect", [x, y, w, h]);
		},
		moveTo: (x: number, y: number) => {
			track.points.push(toPage(x, y));
			log("moveTo", [x, y]);
		},
		lineTo: (x: number, y: number) => {
			track.points.push(toPage(x, y));
			log("lineTo", [x, y]);
		},
		quadraticCurveTo: (cx: number, cy: number, x: number, y: number) => {
			track.points.push(toPage(x, y));
			log("quadraticCurveTo", [cx, cy, x, y]);
		},
		bezierCurveTo: (a: number, b: number, c: number, d: number, x: number, y: number) => {
			track.points.push(toPage(x, y));
			log("bezierCurveTo", [a, b, c, d, x, y]);
		},
		arc: (x: number, y: number, ...rest: unknown[]) => {
			track.points.push(toPage(x, y));
			log("arc", [x, y, ...rest]);
		},
	};
	const ctx = new Proxy(target, {
		get: (t, p) => (p in t ? t[p as string] : (...args: unknown[]) => log(String(p), args)),
		set: (t, p, v) => {
			t[p as string] = v;
			return true;
		},
	});
	return { ctx: ctx as unknown as CanvasRenderingContext2D, track };
}

interface FakeCanvas {
	width: number;
	height: number;
	parentElement: unknown;
	track: Track;
}

interface Priv {
	mounted: boolean;
	bindTo(el: unknown): void;
	sync(): void;
	invalidateProbe(): void;
	router: { dispose(): void } | null;
	selected: string[];
	selectionPage: number;
	pair: { wetCanvas: FakeCanvas } | null;
	frameBox(page: number): unknown;
	attachPair(pageEl: unknown, box: unknown): unknown;
	drawLasso(box: unknown): void;
	clearSelection(): void;
}

interface Rig {
	priv: Priv;
	sync(): void;
	/** Turn the page as the viewer would: its box swaps for 90/270, and the viewer reports the turn. */
	turn(deg: 0 | 90 | 180 | 270): void;
	/** What the turn source answers apart from the box; `undefined` goes back to the box's own turn. */
	report(deg: number | undefined): void;
	/** Hold a selection of these strokes as a lasso leaves it at pen-up. */
	select(ids: string[]): void;
	/** The boxes the wet layer drew, oldest first. */
	boxes(): Rect[];
	/** Where the newest paint of the saved ink put the ink, in the page's css px. */
	inkRect(): Rect;
}

function rig(strokes: InkStroke[]): Rig {
	resetTipModeForTest();
	const uninstall = installFakeWindow();
	cleanups.push(uninstall);
	let deg: 0 | 90 | 180 | 270 = 0;
	let reported: number | undefined = undefined;
	const box = () => (deg % 180 === 0 ? { w: PAGE_W, h: PAGE_H } : { w: PAGE_H, h: PAGE_W });
	const canvases: FakeCanvas[] = [];
	const layer = { getAttribute: (n: string) => (n === "data-main-rotation" ? String(deg) : null) };
	const pageEl: Record<string, unknown> = {
		get clientWidth() {
			return box().w;
		},
		get clientHeight() {
			return box().h;
		},
		createEl: () => {
			const c: Record<string, unknown> & FakeCanvas = {
				width: 300,
				height: 150,
				parentElement: pageEl,
				track: { rects: [], points: [], calls: [] },
				setAttribute: () => {},
				remove() {
					c.parentElement = null;
				},
				setCssStyles: () => {},
				setCssProps: () => {},
				toggleClass: () => {},
				classList: { add: () => {}, remove: () => {} },
				addEventListener: () => {},
			};
			const t = trackingCtx(c);
			c.track = t.track;
			c.getContext = () => t.ctx;
			canvases.push(c);
			return c;
		},
		appendChild: () => {},
		insertBefore: () => {},
		setCssStyles: () => {},
		querySelectorAll: () => [],
		querySelector: (sel: string) => (/main-rotation|textLayer|annotationLayer/.test(sel) ? layer : null),
		getAttribute: () => null,
	};
	const scroller: Record<string, unknown> = {
		scrollTop: 0,
		scrollLeft: 0,
		clientWidth: 1600,
		clientHeight: 1200,
		get scrollWidth() {
			return box().w;
		},
		get scrollHeight() {
			return box().h;
		},
		style: { touchAction: "" },
		contains: () => false,
		setPointerCapture: () => {},
		releasePointerCapture: () => {},
		classList: { add: () => {}, remove: () => {}, contains: () => false },
		querySelector: (sel: string) => (/data-page-number="1"/.test(sel) ? pageEl : null),
		addEventListener: () => {},
		removeEventListener: () => {},
		getBoundingClientRect: () => ({ left: 0, top: 0, width: 1600, height: 1200 }),
		setCssStyles: () => {},
	};
	const setProbe = () => {
		probe.current = {
			scroller,
			scaleFactor: 1,
			scaleSource: "test",
			pages: [{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: box().w, heightPx: box().h, hasCanvas: true }],
		};
	};
	setProbe();
	const win = {
		devicePixelRatio: 1,
		navigator: { userAgent: "", platform: "", maxTouchPoints: 0 },
		setTimeout: () => 0,
		clearTimeout: () => {},
		requestAnimationFrame: () => 0,
		cancelAnimationFrame: () => {},
		getComputedStyle: () => ({ position: "relative" }),
	};
	const controller = new PdfInkController(
		{} as HTMLElement,
		win as unknown as Window,
		() => strokes,
		() => "doc-1",
		() => strokes,
		() => {},
		() => {},
		() => {},
		() => {},
		() => false,
		() => "darken"
	);
	const priv = controller as unknown as Priv;
	cleanups.push(() => priv.router?.dispose());
	setViewTurnSource(controller, () => (reported === undefined ? deg : reported));
	priv.mounted = true;
	priv.bindTo(scroller);
	const sync = () => {
		priv.invalidateProbe();
		setProbe();
		priv.sync();
	};
	return {
		priv,
		sync,
		turn: (d) => {
			deg = d;
			sync();
		},
		report: (d) => {
			reported = d;
		},
		select: (ids) => {
			priv.selected = ids;
			priv.selectionPage = 1;
			const b = priv.frameBox(1);
			priv.attachPair(pageEl, b);
			priv.drawLasso(b);
		},
		boxes: () => priv.pair?.wetCanvas.track.rects ?? [],
		inkRect: () => {
			const c = canvases.find((x) => x !== priv.pair?.wetCanvas && x.parentElement !== null && x.track.points.length > 0);
			if (!c) throw new Error("no saved ink was painted");
			return around(c.track.points);
		},
	};
}

let cleanups: Array<() => void> = [];
beforeEach(() => {
	cleanups = [];
});
afterEach(() => {
	for (const c of cleanups.reverse()) c();
	probe.current = null;
});

/** Where the upright point (x, y) shows on the page turned clockwise by `deg`, in the turned page's css px. */
function turned(deg: 0 | 90 | 180 | 270, x: number, y: number): [number, number] {
	switch (deg) {
		case 0:
			return [x, y];
		case 90:
			return [PAGE_H - y, x];
		case 180:
			return [PAGE_W - x, PAGE_H - y];
		case 270:
			return [y, PAGE_W - x];
	}
}

/** Where a stroke's box shows on the page turned by `deg`. */
function boxOn(deg: 0 | 90 | 180 | 270, s: InkStroke): Rect {
	const { x, y, width, height } = s.bbox;
	return around([turned(deg, x, y), turned(deg, x + width, y + height)]);
}

const TOL = 0.5;
/** A box drawn where `want` is, each edge within TOL. */
function expectRect(got: Rect | undefined, want: Rect, what: string): void {
	const show = (r: Rect | undefined) => (r ? `[${r.x0.toFixed(1)}, ${r.y0.toFixed(1)} .. ${r.x1.toFixed(1)}, ${r.y1.toFixed(1)}]` : "none");
	const near = !!got && Math.max(Math.abs(got.x0 - want.x0), Math.abs(got.y0 - want.y0), Math.abs(got.x1 - want.x1), Math.abs(got.y1 - want.y1)) <= TOL;
	expect.soft(near, `${what}: box drawn at ${show(got)}, its ink at ${show(want)}`).toBe(true);
}

/** The ink's painted points lie inside the box (the box is around its ink as painted, not only as computed here). */
function expectAroundInk(box: Rect | undefined, ink: Rect, what: string): void {
	const inside = !!box && ink.x0 >= box.x0 - TOL && ink.y0 >= box.y0 - TOL && ink.x1 <= box.x1 + TOL && ink.y1 <= box.y1 + TOL;
	expect.soft(inside, `${what}: the painted ink is not inside the box`).toBe(true);
}

describe("a held PDF selection's box on a page the viewer turns", () => {
	it("upright, no turn: the box is drawn once around its ink (control)", () => {
		const a = inkNear("a", 100, 200);
		const r = rig([a]);
		r.sync();
		r.select(["a"]);
		expect(r.boxes().length, "premise: the lasso drew its box").toBe(1);
		expectRect(r.boxes()[0], boxOn(0, a), "upright");
		expectAroundInk(r.boxes()[0], r.inkRect(), "upright");
		r.sync();
		expect(r.boxes().length, "a sync with nothing changed drew the box again").toBe(1);
	});

	it("a quarter turn, and on to the other quarter: the box turns with the page and sits on its ink each time", () => {
		const a = inkNear("a", 100, 200);
		const r = rig([a]);
		r.sync();
		r.select(["a"]);
		r.turn(90);
		expectRect(r.boxes().at(-1), boxOn(90, a), "turned 90");
		expectAroundInk(r.boxes().at(-1), r.inkRect(), "turned 90");
		// 90 to 270 keeps the page's size: nothing about its size says the box must move.
		r.turn(270);
		expectRect(r.boxes().at(-1), boxOn(270, a), "turned 270 from 90");
		expectAroundInk(r.boxes().at(-1), r.inkRect(), "turned 270 from 90");
		r.turn(0);
		expectRect(r.boxes().at(-1), boxOn(0, a), "back upright");
	});

	it("a half turn: the page keeps its size, and the box still moves to its ink", () => {
		const a = inkNear("a", 100, 200);
		const r = rig([a]);
		r.sync();
		r.select(["a"]);
		r.turn(180);
		expectRect(r.boxes().at(-1), boxOn(180, a), "turned 180");
		expectAroundInk(r.boxes().at(-1), r.inkRect(), "turned 180");
		r.turn(0);
		expectRect(r.boxes().at(-1), boxOn(0, a), "back upright from 180");
	});

	it("a half turn draws the box again once; a sync after it with nothing changed draws no box, so the box does not blink", () => {
		const a = inkNear("a", 100, 200);
		const r = rig([a]);
		r.sync();
		r.select(["a"]);
		r.turn(180);
		const n = r.boxes().length;
		expect(n, "premise: the half turn drew the box again").toBe(2);
		r.sync();
		r.sync();
		expect(r.boxes().length, "a sync with nothing changed drew the box again").toBe(n);
	});

	it("a turn the viewer reports before its page box has turned leaves the box upright with the ink, then the box turns with it", () => {
		const a = inkNear("a", 100, 200);
		const r = rig([a]);
		r.sync();
		r.select(["a"]);
		r.report(90);
		r.sync();
		expectRect(r.boxes().at(-1), boxOn(0, a), "reported 90, box not yet turned");
		expectAroundInk(r.boxes().at(-1), r.inkRect(), "reported 90, box not yet turned");
		r.report(undefined);
		r.turn(90);
		expectRect(r.boxes().at(-1), boxOn(90, a), "turned 90");
	});

	it("pin: with nothing selected, a turn draws no box", () => {
		const r = rig([inkNear("a", 100, 200)]);
		r.sync();
		r.select([]);
		const n = r.boxes().length;
		r.turn(180);
		r.turn(90);
		expect(r.boxes().length, "a box was drawn with nothing selected").toBe(n);
	});
});
