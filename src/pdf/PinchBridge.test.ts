/**
 * The bridge's numbers, and below them the whole loop: a fake pane whose
 * viewer zooms with its own direction-split gain over a page that floats in
 * centering margins, driven finger-down to commit. The commit's contract -
 * one wheel on a learned gain per direction, a page-anchored correction, a
 * probe hidden inside the first gesture - burned through eight on-glass
 * iterations before it settled; this harness is what should have existed
 * on iteration two.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PinchBridge, centroidOf, spreadOf } from "./PinchBridge";

const pt = (id: number, x: number, y: number) => ({ identifier: id, clientX: x, clientY: y });

describe("the pinch bridge's numbers", () => {
	it("measures spread and centroid where the fingers are", () => {
		expect(spreadOf(pt(1, 0, 0), pt(2, 30, 40))).toBe(50);
		expect(centroidOf(pt(1, 0, 0), pt(2, 30, 40))).toEqual({ x: 15, y: 20 });
	});
});

// Node has neither WheelEvent nor HTMLElement; the bridge constructs the
// former, and the fakes below are typed as the latter, so both get shims -
// stubs are hung off the HTMLElement prototype so they read as elements.
class FakeWheelEvent {
	constructor(type: string, init: Record<string, unknown>) {
		Object.assign(this, { type }, init);
	}
}
const g = globalThis as unknown as Record<string, unknown>;
g["WheelEvent"] ??= FakeWheelEvent;
g["HTMLElement"] ??= class {};
const HTMLEl = g["HTMLElement"] as { prototype: object };
const asEl = <T extends object>(o: T): T => Object.setPrototypeOf(o, HTMLEl.prototype) as T;

const PANE_W = 800;
const PANE_H = 600;
const PAGE_W = 1000;
const PAGE_H = 1500;

/**
 * A pane whose viewer behaves like the real one where it hurt on glass:
 * one page, CENTERED in the scroller while smaller than it (the margins do
 * not scale with zoom - the far-out big-zoom miss), scroll clamped to the
 * extent, and every trusted-looking ctrl wheel multiplying the scale by
 * exp(-deltaY * gain) with the gain split by direction and deliberately
 * different from the bridge's seed - so a landing can only be exact if the
 * bridge measured rather than assumed. Synthesized wheels anchor nothing,
 * which is the whole reason settle() exists.
 */
class FakePane {
	scale = 1;
	trueKIn = 0.004;
	trueKOut = 0.002;
	/** false = the viewer refuses to zoom, as it does at min/max scale. */
	responds = true;
	wheels: { deltaY: number; clientX: number; clientY: number }[] = [];
	styles: Record<string, string> = {};
	readonly el: HTMLElement;
	private sx = 0;
	private sy = 0;
	private handlers = new Map<string, (e: unknown) => void>();

	private content = asEl({
		setCssStyles: (s: Record<string, string>) => {
			Object.assign(this.styles, s);
		},
	});

	/** Where the page sits in the viewport right now. */
	pageRect(): { left: number; top: number; right: number; bottom: number } {
		const w = PAGE_W * this.scale;
		const h = PAGE_H * this.scale;
		const left = Math.max(0, (PANE_W - w) / 2) - this.sx;
		const top = Math.max(0, (PANE_H - h) / 2) - this.sy;
		return { left, top, right: left + w, bottom: top + h };
	}

	constructor() {
		const self = this;
		const page = asEl({
			getAttribute: () => "1",
			getBoundingClientRect: () => self.pageRect(),
		});
		this.el = asEl({
			addEventListener: (type: string, fn: (e: unknown) => void) => {
				self.handlers.set(type, fn);
			},
			removeEventListener: (type: string) => {
				self.handlers.delete(type);
			},
			querySelector: (sel: string) => (sel.includes("pdfViewer") ? self.content : page),
			querySelectorAll: () => [page],
			getBoundingClientRect: () => ({ left: 0, top: 0, width: PANE_W, height: PANE_H }),
			get scrollLeft() {
				return self.sx;
			},
			set scrollLeft(v: number) {
				self.sx = Math.min(Math.max(0, v), Math.max(0, PAGE_W * self.scale - PANE_W));
			},
			get scrollTop() {
				return self.sy;
			},
			set scrollTop(v: number) {
				self.sy = Math.min(Math.max(0, v), Math.max(0, PAGE_H * self.scale - PANE_H));
			},
			dispatchEvent: (e: { ctrlKey?: boolean; deltaY?: number; clientX?: number; clientY?: number }) => {
				if (e.ctrlKey && typeof e.deltaY === "number") {
					self.wheels.push({ deltaY: e.deltaY, clientX: e.clientX ?? 0, clientY: e.clientY ?? 0 });
					const gain = e.deltaY < 0 ? self.trueKIn : self.trueKOut;
					if (self.responds) self.scale *= Math.exp(-e.deltaY * gain);
				}
				return true;
			},
			ownerDocument: {
				defaultView: {
					setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number,
					clearTimeout: (id: number) => clearTimeout(id),
					requestAnimationFrame: (fn: () => void) => setTimeout(fn, 16) as unknown as number,
				},
			},
		}) as unknown as HTMLElement;
	}

	fire(type: "touchstart" | "touchmove" | "touchend", pts: [number, number, number][], lifted: number[] = []): void {
		const touch = ([id, x, y]: [number, number, number]) => ({ identifier: id, clientX: x, clientY: y });
		this.handlers.get(type)?.({
			touches: pts.map(touch),
			changedTouches: lifted.map((id) => ({ identifier: id })),
			preventDefault: () => {},
			stopImmediatePropagation: () => {},
		});
	}

	fingersDown(): void {
		this.fire("touchstart", [
			[1, 350, 300],
			[2, 450, 300],
		]);
	}

	fingersApart(ratio: number): void {
		const half = (100 * ratio) / 2;
		this.fire("touchmove", [
			[1, 400 - half, 300],
			[2, 400 + half, 300],
		]);
	}

	fingersOff(): void {
		this.fire("touchend", [], [1]);
	}
}
let pane: FakePane;

/** Fingers down at spread 100, apart to spread 100*ratio, and off the glass. */
function pinch(ratio: number): void {
	pane.fingersDown();
	pane.fingersApart(ratio);
	pane.fingersOff();
}

describe("the pinch loop against a simulated viewer", () => {
	let allowed: boolean;

	beforeEach(() => {
		vi.useFakeTimers();
		pane = new FakePane();
		allowed = true;
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const bind = (): PinchBridge => {
		const bridge = new PinchBridge(
			() => allowed,
			() => pane.scale
		);
		bridge.attach(pane.el);
		return bridge;
	};

	it("the first gesture is a probe and a commit, both at the start centroid", () => {
		bind();
		pane.fingersDown();
		pane.fingersApart(2);
		// Mid-gesture: the CSS preview, plus the one mid-pinch probe.
		expect(pane.styles["transform"]).toBe("scale(2)");
		expect(pane.wheels).toHaveLength(1);
		pane.fingersOff();
		expect(pane.wheels).toHaveLength(2);
		expect(pane.wheels[0]!.clientX).toBe(400);
		expect(pane.wheels[1]!.clientX).toBe(400);
		// The commit clears the preview so only the real zoom remains.
		expect(pane.styles["transform"]).toBe("");
		// The probe is spent: later gestures are one wheel each.
		pinch(2);
		expect(pane.wheels).toHaveLength(3);
	});

	it("a brief accidental pinch fires nothing at all", () => {
		bind();
		pinch(1.02);
		expect(pane.wheels).toHaveLength(0);
		expect(pane.scale).toBe(1);
	});

	it("the mid-gesture probe teaches the gain and the FIRST landing is exact", () => {
		bind();
		pane.fingersDown();
		pane.fingersApart(3);
		vi.advanceTimersByTime(150); // the probe's measurement window
		const held = pane.scale; // post-probe, what the fingers now hold
		pane.fingersOff();
		// The commit aims from the scale it reads at release, on the gain
		// the probe measured - exact on the very first pinch, with no
		// idle-time blip anywhere (the blip flickered on glass, twice).
		expect(pane.scale).toBeCloseTo(held * 3, 6);
	});

	it("a first pinch OUT probes the out gain and lands exactly", () => {
		bind();
		pane.scale = 2;
		pane.fingersDown();
		pane.fingersApart(0.5);
		vi.advanceTimersByTime(150);
		const held = pane.scale;
		pane.fingersOff();
		expect(pane.scale).toBeCloseTo(held * 0.5, 6);
	});

	it("a fast pinch releasing inside the probe window still learns from its landing", () => {
		bind();
		pinch(2); // probe and commit in the same instant
		vi.advanceTimersByTime(200);
		// The probe's measurement was spoiled by the commit's wheel and
		// rejected; the landing taught instead. The next pinch is exact.
		const afterFirst = pane.scale;
		pinch(2);
		vi.advanceTimersByTime(200);
		expect(pane.scale).toBeCloseTo(afterFirst * 2, 6);
	});

	it("a big zoom in from far out puts the pinched point back under the fingers", () => {
		// Seed-exact gain, so the landing itself is deterministic and the
		// test isolates the ANCHOR: zoomed out to 0.5 the page is centered
		// in margins that do not scale, which is exactly where a formula on
		// scroll position missed (glass, 2026-08-31).
		pane.trueKIn = 0.0035;
		pane.scale = 0.5;
		pane.el.scrollTop = 100;
		bind();
		pane.fingersDown();
		pane.fingersApart(4);
		const held = pane.scale; // the probe's 3% is part of the gesture now
		// Under the pinch centre (400,300) sat page point (500,800) at the
		// gesture's start; the anchor is measured at commit, post-probe.
		const r0 = pane.pageRect();
		const px = (400 - r0.left) / pane.scale;
		const py = (300 - r0.top) / pane.scale;
		pane.fingersOff();
		expect(pane.scale).toBeCloseTo(held * 4, 6);
		const r = pane.pageRect();
		expect(r.left + px * pane.scale).toBeCloseTo(400, 4);
		expect(r.top + py * pane.scale).toBeCloseTo(300, 4);
	});

	it("a zoom-out pinch does not poison the next zoom-in", () => {
		bind();
		pinch(2);
		vi.advanceTimersByTime(200); // kIn learned from the landing
		pinch(0.5);
		vi.advanceTimersByTime(200); // kOut learned - and only kOut
		const before = pane.scale;
		pinch(2);
		// With a single shared gain this flew on the out-gain and doubled
		// the doubling - the "snap zooms in further" bug (glass, 2026-08-31).
		expect(pane.scale).toBeCloseTo(before * 2, 6);
	});

	it("a viewer at its zoom bound breaks nothing", () => {
		bind();
		pane.responds = false;
		pane.fingersDown();
		pane.fingersApart(2);
		vi.advanceTimersByTime(150); // the probe measured nothing; no learn
		pane.fingersOff();
		vi.advanceTimersByTime(200);
		expect(pane.wheels).toHaveLength(2); // probe and commit, both refused
		expect(pane.scale).toBe(1);
	});

	it("a rebind mid-probe teaches nothing across the boundary", () => {
		const bridge = bind();
		pane.fingersDown();
		pane.fingersApart(2);
		const second = new FakePane();
		bridge.attach(second.el); // viewer rebuilt mid-gesture
		pane = second; // the scale oracle follows the pane, as the controller's does
		vi.advanceTimersByTime(400);
		// The old pane's probe response was never read against the new
		// pane, and the new pane still gets its own probe on ITS first
		// pinch - the bridge stayed uncalibrated.
		pane.fingersDown();
		pane.fingersApart(2);
		expect(pane.wheels).toHaveLength(1); // that pinch's own probe
		pane.fingersOff();
	});

	it("a real zoom landing inside the probe window is rejected, not learned", () => {
		bind();
		pane.fingersDown();
		pane.fingersApart(2);
		pane.scale *= 4; // the user ctrl+wheels hard mid-measurement
		vi.advanceTimersByTime(150);
		pane.fingersOff();
		vi.advanceTimersByTime(200);
		// The probe rejected the spoiled window; the landing taught. The
		// next pinch flies exact on what the LANDING measured.
		const before = pane.scale;
		pinch(2);
		expect(pane.scale).toBeCloseTo(before * 2, 6);
	});

	it("dispose mid-probe leaves no timer teaching a dead pane", () => {
		const bridge = bind();
		pane.fingersDown();
		pane.fingersApart(2);
		bridge.dispose();
		vi.advanceTimersByTime(60_000);
		expect(pane.wheels).toHaveLength(1); // the probe, and nothing after
	});

	it("a third finger abandons the gesture without a commit", () => {
		bind();
		pane.fingersDown();
		pane.fire("touchstart", [
			[1, 350, 300],
			[2, 450, 300],
			[3, 400, 400],
		]);
		pane.fingersOff();
		expect(pane.wheels).toHaveLength(0);
	});
});
