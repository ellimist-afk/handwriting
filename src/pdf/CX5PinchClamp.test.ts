import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PinchBridge } from "./PinchBridge";

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
const MAX_SCALE = 10;
const MIN_SCALE = 0.1;

class FakePane {
	scale = 1;
	/** One constant true gain per direction: the only variable is the clamp. */
	trueKIn = 0.004;
	trueKOut = 0.002;
	clamps = 0;
	wheels: { deltaY: number }[] = [];
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
			dispatchEvent: (e: { ctrlKey?: boolean; deltaY?: number }) => {
				if (e.ctrlKey && typeof e.deltaY === "number") {
					self.wheels.push({ deltaY: e.deltaY });
					const gain = e.deltaY < 0 ? self.trueKIn : self.trueKOut;
					const want = self.scale * Math.exp(-e.deltaY * gain);
					const got = Math.max(MIN_SCALE, Math.min(MAX_SCALE, want));
					if (got !== want) self.clamps++;
					self.scale = got;
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
}

let pane: FakePane;

/** Fingers down at spread 100, apart to 100*ratio, off; then the 120 ms learn window. */
function pinch(ratio: number): void {
	pane.fire("touchstart", [
		[1, 350, 300],
		[2, 450, 300],
	]);
	const half = (100 * ratio) / 2;
	pane.fire("touchmove", [
		[1, 400 - half, 300],
		[2, 400 + half, 300],
	]);
	pane.fire("touchend", [], [1, 2]);
	vi.advanceTimersByTime(200);
}

describe("PDF a zoom-limit-clamped landing must not poison the next pinch", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		pane = new FakePane();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const bind = (): PinchBridge => {
		const bridge = new PinchBridge(
			() => true,
			() => pane.scale
		);
		bridge.attach(pane.el);
		return bridge;
	};

	/** Warm up: one ordinary pinch in, far from the limit, so kIn is measured and exact. */
	function warm(): void {
		pinch(2);
		expect(pane.clamps).toBe(0);
		const s = pane.scale;
		pinch(1.5);
		// Precondition: the learned gain is the true one - an ordinary pinch lands on its preview.
		expect(pane.scale).toBeCloseTo(s * 1.5, 6);
		expect(pane.clamps).toBe(0);
	}

	it("control: without a clamped landing, zoom out then a x1.5 pinch lands on its preview", () => {
		bind();
		warm();
		pane.scale = 2; // zoom out by other means (toolbar / menu)
		pinch(1.5);
		expect(pane.clamps).toBe(0);
		expect(pane.scale).toBeCloseTo(3, 6);
	});

	it("after a x6 pinch that the viewer stops at max zoom, the next x1.5 pinch still lands near its preview", () => {
		bind();
		warm();
		// Pinch in x6 from 5x: the viewer can only honour x2 (to MAX_SCALE=10).
		pane.scale = 5;
		pinch(6);
		// Precondition: the landing moved PART way and stopped at the limit.
		expect(pane.clamps).toBe(1);
		expect(pane.scale).toBe(MAX_SCALE);
		// Zoom out by other means, then an ordinary x1.5 pinch.
		pane.scale = 2;
		const wheelsBefore = pane.wheels.length;
		pinch(1.5);
		expect(pane.wheels.length).toBe(wheelsBefore + 1); // one commit wheel, no probe
		expect(pane.clamps).toBe(1); // this landing itself was not clamped
		// Correct behaviour: the page lands where the preview showed it (x1.5 -> 3x),
		// within 10%. The bug lands it at ~5.7x.
		const landedRatio = pane.scale / 2;
		expect(landedRatio, `landed at ${pane.scale.toFixed(3)}x for a x1.5 preview`).toBeGreaterThan(1.5 * 0.9);
		expect(landedRatio, `landed at ${pane.scale.toFixed(3)}x for a x1.5 preview`).toBeLessThan(1.5 * 1.1);
	});

	it("after a x3 pinch clamped after x2, the next x2 pinch lands near its preview", () => {
		bind();
		warm();
		pane.scale = 5;
		pinch(3); // wants 15x, viewer stops at 10x (x2 of x3)
		expect(pane.clamps).toBe(1);
		expect(pane.scale).toBe(MAX_SCALE);
		pane.scale = 1;
		pinch(2);
		expect(pane.clamps).toBe(1);
		const landedRatio = pane.scale / 1;
		expect(landedRatio, `landed at ${pane.scale.toFixed(3)}x for a x2 preview`).toBeLessThan(2 * 1.1);
	});
	it("a lower-limit landing preserves the next zoom-out gain", () => {
		bind();
		pane.scale = 4;
		pinch(0.5);
		const learnedAt = pane.scale;
		pinch(0.5);
		expect(pane.scale).toBeCloseTo(learnedAt * 0.5, 6);
		pane.scale = 0.2;
		pinch(0.25);
		expect(pane.scale).toBe(MIN_SCALE);
		expect(pane.clamps).toBe(1);
		pane.scale = 2;
		pinch(0.5);
		expect(pane.scale).toBeCloseTo(1, 6);
	});
	it.each([true, false])("a partially clamped probe cannot teach a false gain (in=%s)", (zoomIn) => {
		const bridge = bind();
		pane.scale = zoomIn ? 9.99 : 0.1001;
		pane.fire("touchstart", [[1,350,300],[2,450,300]]);
		const ratio = zoomIn ? 2 : 0.5;
		pane.fire("touchmove", [[1,400-50*ratio,300],[2,400+50*ratio,300]]);
		expect(pane.clamps).toBe(1);
		expect(pane.scale).toBe(zoomIn ? MAX_SCALE : MIN_SCALE);
		vi.advanceTimersByTime(150);
		const measured = bridge as unknown as { kIn: number; kOut: number; calibrated: boolean };
		expect(zoomIn ? measured.kIn : measured.kOut).toBe(0.0035);
		expect(measured.calibrated).toBe(false);
		bridge.dispose();
	});});
