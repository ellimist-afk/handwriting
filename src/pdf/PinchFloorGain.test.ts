// A pinch clamped at the viewer's 10 percent floor must not teach the bridge a
// gain: getScale reads --scale-factor, pdf.js currentScale times 96/72.
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

const CSS_PER_PT = 96 / 72;
const MAX_SCALE = 10;
const MIN_SCALE = 0.1;

class FakePane {
	cur = 1;
	trueKIn = 0.004;
	trueKOut = 0.002;
	clamps = 0;
	readonly el: HTMLElement;
	private handlers = new Map<string, (e: unknown) => void>();
	private content = asEl({ setCssStyles: () => {} });
	scaleFactor(): number {
		return this.cur * CSS_PER_PT;
	}
	constructor() {
		const self = this;
		const page = asEl({
			getAttribute: () => "1",
			getBoundingClientRect: () => {
				const w = 600 * self.scaleFactor();
				return { left: 0, top: 0, right: w, bottom: w * 1.4 };
			},
		});
		this.el = asEl({
			addEventListener: (t: string, fn: (e: unknown) => void) => self.handlers.set(t, fn),
			removeEventListener: (t: string) => self.handlers.delete(t),
			querySelector: (sel: string) => (sel.includes("pdfViewer") ? self.content : page),
			querySelectorAll: () => [page],
			getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
			scrollLeft: 0,
			scrollTop: 0,
			dispatchEvent: (e: { ctrlKey?: boolean; deltaY?: number }) => {
				if (e.ctrlKey && typeof e.deltaY === "number") {
					const gain = e.deltaY < 0 ? self.trueKIn : self.trueKOut;
					const want = self.cur * Math.exp(-e.deltaY * gain);
					const got = Math.max(MIN_SCALE, Math.min(MAX_SCALE, want));
					if (got !== want) self.clamps++;
					self.cur = got;
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
	fire(type: string, pts: [number, number, number][], lifted: number[] = []): void {
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
function pinch(ratio: number): void {
	pane.fire("touchstart", [[1, 350, 300], [2, 450, 300]]);
	const half = (100 * ratio) / 2;
	pane.fire("touchmove", [[1, 400 - half, 300], [2, 400 + half, 300]]);
	pane.fire("touchend", [], [1, 2]);
	vi.advanceTimersByTime(200);
}
function bind(): PinchBridge {
	const b = new PinchBridge(() => true, () => pane.scaleFactor());
	b.attach(pane.el);
	return b;
}

describe("a pinch clamped at the 10% limit (real --scale-factor units)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		pane = new FakePane();
	});
	afterEach(() => vi.useRealTimers());

	it("control: unclamped zoom-out pinches land on their preview", () => {
		bind();
		pane.cur = 3;
		pinch(0.5);
		pinch(0.5);
		pane.cur = 2;
		pinch(0.5);
		expect(pane.clamps).toBe(0);
		expect(pane.cur).toBeCloseTo(1, 6);
	});

	it("after a zoom-out pinch stopped at 10%, the next x0.5 pinch still lands on its preview", () => {
		bind();
		pane.cur = 3;
		pinch(0.5);
		pane.cur = 0.15;
		pinch(0.25);
		expect(pane.clamps).toBe(1);
		expect(pane.cur).toBe(MIN_SCALE);
		pane.cur = 2;
		pinch(0.5);
		expect(pane.clamps).toBe(1);
		expect(pane.cur, `landed at ${(pane.cur * 100).toFixed(1)}% for a x0.5 preview from 200%`).toBeCloseTo(1, 2);
	});

	it("a probe partially clamped at 10% does not teach a gain", () => {
		const bridge = bind();
		pane.cur = 0.1005;
		pane.fire("touchstart", [[1, 350, 300], [2, 450, 300]]);
		pane.fire("touchmove", [[1, 375, 300], [2, 425, 300]]);
		expect(pane.clamps).toBe(1);
		vi.advanceTimersByTime(150);
		const k = bridge as unknown as { kOut: number; calibrated: boolean };
		expect(k.kOut).toBe(0.0035);
		expect(k.calibrated).toBe(false);
		bridge.dispose();
	});

	it("a probe that lands just above the floor still teaches the gain", () => {
		const bridge = bind();
		pane.cur = 0.13;
		pane.fire("touchstart", [[1, 350, 300], [2, 450, 300]]);
		pane.fire("touchmove", [[1, 375, 300], [2, 425, 300]]);
		expect(pane.clamps, "precondition: the probe did not reach the floor").toBe(0);
		vi.advanceTimersByTime(150);
		const k = bridge as unknown as { kOut: number; calibrated: boolean };
		expect(k.calibrated, "a landing above the floor was refused as a clamp").toBe(true);
		expect(k.kOut).toBeCloseTo(pane.trueKOut, 6);
		bridge.dispose();
	});
});
