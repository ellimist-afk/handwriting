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

const PANE = { left: 0, top: 40, width: 800, height: 600 };
const PAGE_W = 816;
const PAGE_H = 1056;
const PAGES = 40;

type Mode = "gain" | "pdfjs";

class Viewer {
	scale = 1;
	sx = 0;
	sy = 0;
	unusedTicks = 0;
	wheels: { deltaY: number; clientX: number; clientY: number; before: number; after: number }[] = [];
	styles: Record<string, string> = {};
	private handlers = new Map<string, (e: unknown) => void>();
	readonly el: HTMLElement;

	constructor(private mode: Mode, private delayed = false) {
		const self = this;
		const content = asEl({
			setCssStyles: (s: Record<string, string>) => Object.assign(self.styles, s),
		});
		const pages = Array.from({ length: PAGES }, (_, i) =>
			asEl({
				getAttribute: () => String(i + 1),
				getBoundingClientRect: () => {
					const top = PANE.top + i * PAGE_H * self.scale - self.sy;
					const left = PANE.left - self.sx;
					return { left, top, right: left + PAGE_W * self.scale, bottom: top + PAGE_H * self.scale };
				},
			})
		);
		this.el = asEl({
			addEventListener: (t: string, fn: (e: unknown) => void) => self.handlers.set(t, fn),
			removeEventListener: (t: string) => self.handlers.delete(t),
			querySelector: (sel: string) => {
				if (sel.includes("pdfViewer")) return content;
				const m = /data-page-number="(\d+)"/.exec(sel);
				return m ? pages[Number(m[1]) - 1] ?? null : pages[0];
			},
			querySelectorAll: () => pages,
			getBoundingClientRect: () => ({ ...PANE, right: PANE.left + PANE.width, bottom: PANE.top + PANE.height }),
			get scrollLeft() {
				return self.sx;
			},
			set scrollLeft(v: number) {
				self.sx = Math.min(Math.max(0, v), Math.max(0, PAGE_W * self.scale - PANE.width));
			},
			get scrollTop() {
				return self.sy;
			},
			set scrollTop(v: number) {
				self.sy = Math.min(Math.max(0, v), Math.max(0, PAGES * PAGE_H * self.scale - PANE.height));
			},
			dispatchEvent: (e: { ctrlKey?: boolean; deltaY?: number; deltaMode?: number; clientX?: number; clientY?: number }) => {
				if (e.ctrlKey && typeof e.deltaY === "number") {
					const apply = () => self.wheel(e.deltaY!, e.clientX ?? 0, e.clientY ?? 0, e.deltaMode ?? 0);
					if (self.delayed) setTimeout(apply, 16); else apply();
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

	/** A ctrl wheel reaching the viewer (the bridge's, or the user's own). */
	wheel(deltaY: number, cx: number, cy: number, deltaMode = 0): void {
		const before = this.scale;
		let next = before;
		if (this.mode === "gain") {
			next = before * Math.exp(-deltaY * 0.0035);
		} else {
			const o = Math.exp(-deltaY / 100);
			const pinchPath = deltaMode === 0 && Math.abs(o - 1) < 0.05;
			if (pinchPath) {
				next = Math.round(before * o * 100) / 100;
			} else {
				const t = -deltaY / 30; // normalizeWheelEventDirection for deltaX 0
				if ((this.unusedTicks > 0 && t < 0) || (this.unusedTicks < 0 && t > 0)) this.unusedTicks = 0;
				this.unusedTicks += t;
				let steps = Math.trunc(this.unusedTicks);
				this.unusedTicks -= steps;
				if (steps) {
					const d = steps > 0 ? 1.1 : 1 / 1.1;
					const round = steps > 0 ? Math.ceil : Math.floor;
					steps = Math.abs(steps);
					do next = round(10 * Number((next * d).toFixed(2))) / 10;
					while (--steps > 0);
				}
				next = Math.min(10, Math.max(0.1, next));
			}
		}
		if (Math.abs(next - before) >= 1e-15) {
			const f = next / before;
			const keepTop = this.sy * f;
			const keepLeft = this.sx * f;
			this.scale = next;
			this.el.scrollTop = keepTop + (cy - PANE.top) * (f - 1);
			this.el.scrollLeft = keepLeft + (cx - PANE.left) * (f - 1);
		}
		this.wheels.push({ deltaY, clientX: cx, clientY: cy, before, after: this.scale });
	}

	fire(type: string, pts: [number, number, number][], lifted: number[] = []): void {
		this.handlers.get(type)?.({
			touches: pts.map(([identifier, clientX, clientY]) => ({ identifier, clientX, clientY })),
			changedTouches: lifted.map((identifier) => ({ identifier })),
			preventDefault: () => {},
			stopImmediatePropagation: () => {},
		});
	}

	/** Fingers at y = CY around x = 400, spread 100. */
	fingersDown(): void {
		this.fire("touchstart", [
			[1, 350, CY],
			[2, 450, CY],
		]);
	}
	fingersApart(ratio: number): void {
		const half = (100 * ratio) / 2;
		this.fire("touchmove", [
			[1, 400 - half, CY],
			[2, 400 + half, CY],
		]);
	}
	fingersOff(): void {
		this.fire("touchend", [], [1, 2]);
	}

	/** Screen y where a document point (unscaled units) draws right now, preview included. */
	drawnY(docY: number): number {
		const contentY = docY * this.scale;
		const base = PANE.top - this.sy;
		const tf = this.styles["transform"] ?? "";
		const m = /scale\(([^)]+)\)/.exec(tf);
		if (!m) return base + contentY;
		const s = Number(m[1]);
		const oy = Number((this.styles["transformOrigin"] ?? "0px 0px").split(" ")[1]!.replace("px", ""));
		return base + oy + s * (contentY - oy);
	}
}

const CY = 300;
const START_SCROLL = 20000; // about page 19-20 of a letter PDF at 100%

describe("PDF the mid-pinch probe vs the fixed preview origin", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	function start(mode: Mode, unusedTicks = 0) {
		const v = new Viewer(mode);
		v.unusedTicks = unusedTicks;
		v.el.scrollTop = START_SCROLL;
		const bridge = new PinchBridge(
			() => true,
			() => v.scale
		);
		bridge.attach(v.el);
		v.fingersDown();
		// The document point under the pinch centre at touchdown.
		const docY = (v.sy + CY - PANE.top) / v.scale;
		return { v, docY };
	}

	it("mechanism: a viewer that honours the probe - the pinched point stays under the fingers", () => {
		const { v, docY } = start("gain");
		expect(v.sy).toBe(START_SCROLL);
		expect(v.drawnY(docY)).toBeCloseTo(CY, 6); // precondition: model agrees before any preview
		v.fingersApart(1.05); // inside the probe's 8% dead zone
		expect(v.wheels).toHaveLength(0);
		const at105 = v.drawnY(docY);
		expect(at105).toBeCloseTo(CY, 6); // precondition: locked centre holds before the probe
		v.fingersApart(1.1); // crosses 8%: the probe fires
		expect(v.wheels).toHaveLength(1);
		expect(v.wheels[0]!.after / v.wheels[0]!.before).toBeGreaterThan(1.02); // precondition: probe re-laid out
		const at110 = v.drawnY(docY);
		v.fingersApart(2);
		const at200 = v.drawnY(docY);
		const drift = { at110: at110 - CY, at200: at200 - CY, probeF: v.wheels[0]!.after / v.wheels[0]!.before };
		expect(Math.abs(drift.at200), JSON.stringify(drift)).toBeLessThan(2);
		expect(Math.abs(drift.at110), JSON.stringify(drift)).toBeLessThan(2);
	});

	it("finding's trigger on the pdf.js wheel path: fresh viewer, first pinch at page ~20", () => {
		const { v, docY } = start("pdfjs", 0);
		v.fingersApart(1.1);
		expect(v.wheels).toHaveLength(1); // precondition: the probe fired
		expect(Math.abs(v.wheels[0]!.deltaY)).toBeCloseTo(0.03 / 0.0035, 6);
		const probeF = v.wheels[0]!.after / v.wheels[0]!.before;
		v.fingersApart(2);
		const drift = { at200: v.drawnY(docY) - CY, probeF, unusedTicks: v.unusedTicks };
		expect(Math.abs(drift.at200), JSON.stringify(drift)).toBeLessThan(2);
	});

	it("narrow case on the pdf.js wheel path: a same-direction tick leftover from one earlier user ctrl+wheel", () => {
		const v = new Viewer("pdfjs");
		v.el.scrollTop = START_SCROLL;
		// The user's own ctrl+wheel zoom-in of 24 px (a fast touchpad pinch event):
		// 0.8 tick, truncated to no zoom, 0.8 carried.
		v.wheel(-24, 400, CY);
		expect(v.scale).toBe(1);
		expect(v.unusedTicks).toBeCloseTo(0.8, 9);
		const bridge = new PinchBridge(
			() => true,
			() => v.scale
		);
		bridge.attach(v.el);
		v.fingersDown();
		const docY = (v.sy + CY - PANE.top) / v.scale;
		v.fingersApart(1.1);
		expect(v.wheels).toHaveLength(2);
		const probeF = v.wheels[1]!.after / v.wheels[1]!.before;
		expect(probeF).toBeCloseTo(1.1, 9); // precondition: the probe landed one pdf.js step
		v.fingersApart(2);
		const midPinch = v.drawnY(docY) - CY;
		v.fingersOff();
		vi.advanceTimersByTime(200);
		const afterLift = v.drawnY(docY) - CY;
		const drift = { midPinch, afterLift, probeF, finalScale: v.scale };
		// Landing reported alongside; the claim is the preview drift.
		expect(Math.abs(drift.midPinch), JSON.stringify(drift)).toBeLessThan(2);
	});
	it("refreshes origin after delayed layout without another finger move", () => {
		const v = new Viewer("gain", true);
		v.el.scrollTop = START_SCROLL;
		const bridge = new PinchBridge(() => true, () => v.scale);
		bridge.attach(v.el); v.fingersDown();
		const docY = (v.sy + CY - PANE.top) / v.scale;
		v.fingersApart(2);
		expect(v.wheels).toHaveLength(0);
		vi.advanceTimersByTime(16);
		expect(v.wheels).toHaveLength(1);
		expect(v.styles.transform).toBe("scale(2)");
		expect(v.drawnY(docY)).toBeCloseTo(CY, 6);
		vi.advanceTimersByTime(150);
		expect(v.wheels).toHaveLength(1);
		v.fingersOff(); vi.advanceTimersByTime(200);
		expect(v.wheels).toHaveLength(2);
	});
	it.each(["end", "rebind", "dispose"])("pending origin refresh cannot repaint after %s", (exit) => {
		const v = new Viewer("gain", true);
		v.el.scrollTop = START_SCROLL;
		const bridge = new PinchBridge(() => true, () => v.scale);
		bridge.attach(v.el); v.fingersDown(); v.fingersApart(2);
		if (exit === "end") v.fingersOff();
		else if (exit === "rebind") bridge.attach(new Viewer("gain").el);
		else bridge.dispose();
		vi.advanceTimersByTime(400);
		expect(v.styles.transform).toBe("");
		expect(v.styles.transformOrigin).toBe("");
		expect(v.wheels).toHaveLength(exit === "end" ? 2 : 1);
	});});
