/**
 * Saved ink on a PDF page the viewer has turned.
 *
 * The viewer can turn its pages (90, 180, 270 degrees) and can open a
 * document already turned, because it remembers the turn per document. The
 * saved ink is stored in the frame of the upright page, so the committed
 * canvas has to draw it turned with the page and at the page's scale - not
 * upright and stretched to the turned box.
 *
 * These cells drive the real paint through `sync()` with a canvas fake that
 * tracks the full 2D transform, then read where the ink landed back in the
 * page's own css px. The viewer probe is the only thing stubbed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InkStroke, computeBBox } from "../ink/Stroke";
import { resetTipModeForTest } from "../inline/TipMode";
import { installFakeWindow } from "../../test/routerHarness";

declare const process: { env: Record<string, string | undefined> };

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

/** css px per point. */
const SCALE = 1;
/** The upright page, in points (and css px at SCALE 1). */
const PAGE_W = 600;
const PAGE_H = 800;

/** A short stroke around upright page point (100, 200): off every axis of symmetry. */
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

interface Paint {
	/** The transform `paint` set first: device px from the page's css px, offset to the band. */
	base: M | null;
	/** Every path point the renderer emitted, in device px. */
	device: Array<[number, number]>;
	setTransforms: M[];
	clears: number[][];
	/** Raw call log, for the byte-for-byte upright control. */
	calls: string[];
}

/**
 * A 2D context that tracks the current transform exactly (set, transform,
 * translate, scale, rotate, save, restore) and maps every path point through
 * it, so a turn applied by ANY of those calls shows up where the ink lands.
 */
function trackingCtx(canvas: { width: number; height: number }): { ctx: CanvasRenderingContext2D; paints: Paint[] } {
	const paints: Paint[] = [];
	let m: M = [1, 0, 0, 1, 0, 0];
	const stack: M[] = [];
	const cur = (): Paint => {
		const p = paints[paints.length - 1];
		if (!p) throw new Error("drawn before any setTransform");
		return p;
	};
	const log = (name: string, args: unknown[]) => {
		const p = paints[paints.length - 1];
		if (p) p.calls.push(`${name}(${args.map((a) => (typeof a === "number" ? +a.toFixed(6) : typeof a === "string" || typeof a === "boolean" ? JSON.stringify(a) : typeof a)).join(",")})`);
	};
	const point = (x: number, y: number) => cur().device.push(apply(m, x, y));
	const target: Record<string, unknown> = {
		canvas,
		setTransform: (...args: unknown[]) => {
			const t = (typeof args[0] === "object" && args[0] !== null
				? (({ a, b, c, d, e, f }) => [a, b, c, d, e, f])(args[0] as DOMMatrix)
				: args) as M;
			// `paint` opens every repaint with this call on a cleared transform;
			// that is where one paint ends and the next begins.
			if (stack.length === 0 && (paints.length === 0 || cur().clears.length > 0 || cur().device.length > 0)) {
				paints.push({ base: null, device: [], setTransforms: [], clears: [], calls: [] });
			}
			m = [...t] as M;
			cur().setTransforms.push(m);
			if (cur().base === null) cur().base = m;
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
		clearRect: (...a: number[]) => {
			cur().clears.push(a);
			log("clearRect", a);
		},
		moveTo: (x: number, y: number) => {
			point(x, y);
			log("moveTo", [x, y]);
		},
		lineTo: (x: number, y: number) => {
			point(x, y);
			log("lineTo", [x, y]);
		},
		quadraticCurveTo: (cx: number, cy: number, x: number, y: number) => {
			point(x, y);
			log("quadraticCurveTo", [cx, cy, x, y]);
		},
		bezierCurveTo: (a: number, b: number, c: number, d: number, x: number, y: number) => {
			point(x, y);
			log("bezierCurveTo", [a, b, c, d, x, y]);
		},
		arc: (x: number, y: number, ...rest: unknown[]) => {
			point(x, y);
			log("arc", [x, y, ...rest]);
		},
	};
	const ctx = new Proxy(target, {
		get: (t, p) => (p in t ? t[p as string] : (...args: unknown[]) => log(String(p), args)),
		set: (t, p, v) => {
			t[p as string] = v;
			log(`set ${String(p)}`, [v]);
			return true;
		},
	});
	return { ctx: ctx as unknown as CanvasRenderingContext2D, paints };
}

interface Rig {
	controller: PdfInkController;
	sync(): void;
	/**
	 * What the turn source answers, apart from the box: a number the viewer
	 * reports before its page div has been resized, or null for a read that
	 * failed. `undefined` goes back to answering the box's own turn.
	 */
	report(deg: number | null | undefined): void;
	/** Turn the page as the viewer would: its box swaps for 90/270 and its layers carry the angle. */
	turn(deg: 0 | 90 | 180 | 270): void;
	/** The committed canvas's paints, newest last. */
	paints(): Paint[];
	/** Where the ink of the newest paint landed, as the centre of its points in the page's css px. */
	inkCentre(): [number, number];
	isRotated(): boolean;
}

/**
 * One page, wholly inside the band, at a scale of 1 css px per point.
 * `openTurn` is the turn the viewer is at before the first paint.
 */
function rig(strokes: InkStroke[], openTurn: 0 | 90 | 180 | 270 = 0, source: "viewer" | "none" = "viewer"): Rig {
	resetTipModeForTest();
	const uninstall = installFakeWindow();
	cleanups.push(uninstall);
	let deg: 0 | 90 | 180 | 270 = openTurn;
	let reported: number | null | undefined = undefined;
	const box = () => (deg % 180 === 0 ? { w: PAGE_W * SCALE, h: PAGE_H * SCALE } : { w: PAGE_H * SCALE, h: PAGE_W * SCALE });
	const canvases: Array<{ width: number; height: number; parentElement: unknown; paints: Paint[] }> = [];
	// pdf.js writes the page's total rotation on the layers it lays over the
	// canvas; the page div itself carries none.
	const layer = { getAttribute: (n: string) => (n === "data-main-rotation" ? String(deg) : null) };
	const pageEl: Record<string, unknown> = {
		get clientWidth() {
			return box().w;
		},
		get clientHeight() {
			return box().h;
		},
		createEl: () => {
			const c: Record<string, unknown> & { width: number; height: number; parentElement: unknown; paints: Paint[] } = {
				width: 300,
				height: 150,
				parentElement: pageEl,
				paints: [],
				setAttribute: () => {},
				remove() {
					c.parentElement = null;
				},
				setCssStyles: () => {},
				setCssProps: () => {},
				toggleClass: () => {},
				classList: { add: () => {}, remove: () => {} },
			};
			const t = trackingCtx(c);
			c.paints = t.paints;
			c.getContext = () => t.ctx;
			canvases.push(c);
			return c;
		},
		appendChild: () => {},
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
			scaleFactor: SCALE,
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
	const controller = new PdfInkController({} as HTMLElement, win as unknown as Window, () => strokes, () => "doc-1", () => strokes, () => {});
	const priv = controller as unknown as { mounted: boolean; bindTo(el: unknown): void; sync(): void; invalidateProbe(): void; router: { dispose(): void } | null };
	cleanups.push(() => priv.router?.dispose());
	// The viewer's own page turn, as the code that builds the controller reads
	// it. "none" is a controller nothing registered a source for.
	if (source === "viewer") setViewTurnSource(controller, () => (reported === undefined ? deg : reported));
	priv.mounted = true;
	priv.bindTo(scroller);
	const sync = () => {
		priv.invalidateProbe();
		setProbe();
		priv.sync();
	};
	const committed = () => {
		const live = canvases.filter((c) => c.parentElement !== null);
		const c = live[0];
		if (!c) throw new Error("no committed canvas on the page");
		return c;
	};
	return {
		controller,
		sync,
		turn: (d) => {
			deg = d;
			sync();
		},
		report: (d) => {
			reported = d;
		},
		paints: () => committed().paints,
		inkCentre: () => {
			const ps = committed().paints;
			const p = ps[ps.length - 1];
			if (!p || !p.base || p.device.length === 0) throw new Error("the newest paint drew no ink");
			const inv = invert(p.base);
			const css = p.device.map(([x, y]) => apply(inv, x, y));
			const xs = css.map((q) => q[0]);
			const ys = css.map((q) => q[1]);
			return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
		},
		isRotated: () => controller.isRotated(1),
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

/**
 * Where the upright point (x, y) shows on the page turned clockwise by `deg`,
 * in the turned page's css px. pdf.js turns clockwise for a positive angle.
 */
function turned(deg: 0 | 90 | 180 | 270, x: number, y: number): [number, number] {
	const W = PAGE_W * SCALE;
	const H = PAGE_H * SCALE;
	const u = x * SCALE;
	const v = y * SCALE;
	switch (deg) {
		case 0:
			return [u, v];
		case 90:
			return [H - v, u];
		case 180:
			return [W - u, H - v];
		case 270:
			return [v, W - u];
	}
}

/**
 * The upright control's golden: the full call log of one upright paint,
 * recorded at the base commit (1626e830) before any turn handling existed.
 * Regenerate only at a base, with UPDATE_UPRIGHT_GOLDEN=1.
 */
const GOLDEN = fileURLToPath(new URL("../../test/fixtures/pdf-upright-paint-calls-1626e830.json", import.meta.url));
function goldenUpright(): string[] | null {
	if (process.env.UPDATE_UPRIGHT_GOLDEN === "1") return null;
	return JSON.parse(readFileSync(GOLDEN, "utf8")) as string[];
}
/** A pen stroke, a highlighter wash and a second pen stroke, spread over the page. */
function uprightSet(): InkStroke[] {
	const hl = { ...inkNear("h", 300, 400), tool: "highlighter" as const, color: "#ffff00", width: 12 };
	return [inkNear("a", 100, 200), hl, inkNear("b", 520, 700)];
}

const TOL = 2;
function expectNear(got: [number, number], want: [number, number]): void {
	expect(Math.abs(got[0] - want[0]), `x: got ${got[0].toFixed(2)}, want ${want[0]}`).toBeLessThanOrEqual(TOL);
	expect(Math.abs(got[1] - want[1]), `y: got ${got[1].toFixed(2)}, want ${want[1]}`).toBeLessThanOrEqual(TOL);
}

describe("saved ink on a PDF page turned in the viewer", () => {
	it("upright: the ink sits on its mark (control for the reader)", () => {
		const r = rig([inkNear("a", 100, 200)]);
		r.sync();
		expectNear(r.inkCentre(), turned(0, 100, 200));
		expect(r.isRotated()).toBe(false);
	});

	it("turned 90 degrees: the ink turns with the page, at the page's scale", () => {
		const r = rig([inkNear("a", 100, 200)]);
		r.sync();
		r.turn(90);
		expectNear(r.inkCentre(), turned(90, 100, 200));
		expect(r.isRotated()).toBe(true);
	});

	it("turned 180 degrees: the ink turns with the page, and new ink is still refused", () => {
		const r = rig([inkNear("a", 100, 200)]);
		r.sync();
		r.turn(180);
		expectNear(r.inkCentre(), turned(180, 100, 200));
		expect(r.isRotated()).toBe(true);
	});

	it("turned 270 degrees: the ink turns with the page", () => {
		const r = rig([inkNear("a", 100, 200)]);
		r.sync();
		r.turn(270);
		expectNear(r.inkCentre(), turned(270, 100, 200));
	});

	it("turned 90 then back upright: the ink returns to its mark and ink is allowed again", () => {
		const r = rig([inkNear("a", 100, 200)]);
		r.sync();
		r.turn(90);
		r.turn(0);
		expectNear(r.inkCentre(), turned(0, 100, 200));
		expect(r.isRotated()).toBe(false);
	});

	it("a page that opens already turned 90 degrees: ink refused, saved ink painted turned", () => {
		const r = rig([inkNear("a", 100, 200)], 90);
		r.sync();
		expectNear(r.inkCentre(), turned(90, 100, 200));
		expect(r.isRotated()).toBe(true);
	});

	it("upright: every paint call is the same as before turned pages were painted (byte-for-byte control)", () => {
		const r = rig(uprightSet());
		r.sync();
		const first = r.paints()[r.paints().length - 1]!.calls;
		r.turn(90);
		r.turn(0);
		const back = r.paints()[r.paints().length - 1]!.calls;
		const golden = goldenUpright();
		if (golden === null) {
			writeFileSync(GOLDEN, JSON.stringify(first, null, "\t") + "\n");
			throw new Error(`wrote ${GOLDEN}; rerun without UPDATE_UPRIGHT_GOLDEN`);
		}
		expect(first.length).toBeGreaterThan(20);
		expect(first).toEqual(golden);
		expect(back).toEqual(golden);
	});

	it("a page that opens already turned 180 degrees: ink refused, saved ink painted turned", () => {
		const r = rig([inkNear("a", 100, 200)], 180);
		r.sync();
		expectNear(r.inkCentre(), turned(180, 100, 200));
		expect(r.isRotated()).toBe(true);
	});

	it("270 degrees is told from 90: the same ink lands on a different mark for each, each the right one", () => {
		const a = rig([inkNear("a", 100, 200)]);
		a.sync();
		a.turn(90);
		const at90 = a.inkCentre();
		const b = rig([inkNear("a", 100, 200)]);
		b.sync();
		b.turn(270);
		const at270 = b.inkCentre();
		expectNear(at90, turned(90, 100, 200));
		expectNear(at270, turned(270, 100, 200));
		expect(Math.hypot(at90[0] - at270[0], at90[1] - at270[1])).toBeGreaterThan(100);
	});
});

describe("a turn that cannot be read, or that the box does not show yet", () => {
	it("a source that answers null paints an upright page byte-for-byte as before", () => {
		const r = rig(uprightSet());
		r.report(null);
		r.sync();
		const calls = r.paints()[r.paints().length - 1]!.calls;
		const golden = goldenUpright();
		if (golden === null) return;
		expect(calls).toEqual(golden);
		expect(r.isRotated()).toBe(false);
	});

	it("a source that answers null on a page turned 90 paints exactly as a controller with no source", () => {
		const withNull = rig(uprightSet());
		withNull.sync();
		withNull.report(null);
		withNull.turn(90);
		const none = rig(uprightSet(), 0, "none");
		none.sync();
		none.turn(90);
		const a = withNull.paints()[withNull.paints().length - 1]!.calls;
		const b = none.paints()[none.paints().length - 1]!.calls;
		expect(a.length).toBeGreaterThan(20);
		expect(a).toEqual(b);
		// Today's aspect check still refuses ink on it.
		expect(withNull.isRotated()).toBe(true);
		expect(none.isRotated()).toBe(true);
	});

	it("a source that answers something other than a turn reads as null: upright paints as before", () => {
		for (const bad of [Number.NaN, 45, Number.POSITIVE_INFINITY]) {
			const r = rig(uprightSet());
			r.report(bad);
			r.sync();
			const calls = r.paints()[r.paints().length - 1]!.calls;
			const golden = goldenUpright();
			if (golden === null) return;
			expect(calls, `source answered ${bad}`).toEqual(golden);
			expect(r.isRotated()).toBe(false);
		}
	});

	it("a source that throws reads as null: upright paints as before", () => {
		const r = rig(uprightSet());
		setViewTurnSource(r.controller, () => {
			throw new Error("the view is gone");
		});
		r.sync();
		const calls = r.paints()[r.paints().length - 1]!.calls;
		const golden = goldenUpright();
		if (golden === null) return;
		expect(calls).toEqual(golden);
		expect(r.isRotated()).toBe(false);
	});

	it("a quarter turn reported before the box turns paints upright until the box agrees, then turned", () => {
		const r = rig([inkNear("a", 100, 200)]);
		r.sync();
		// The viewer says 90; the page div is still the upright box.
		r.report(90);
		r.sync();
		expectNear(r.inkCentre(), turned(0, 100, 200));
		expect(r.isRotated()).toBe(true);
		// The box turns: the ink turns with it.
		r.report(undefined);
		r.turn(90);
		expectNear(r.inkCentre(), turned(90, 100, 200));
	});
});
