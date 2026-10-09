// A pinch already running when the pen lands on a PDF must not keep zooming
// the document under the pen.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeWindow, penEvent } from "../../test/routerHarness";
import { resetTipModeForTest, setTipMode } from "../inline/TipMode";
import { setMouseInk } from "../inline/MouseInk";
import type { InkOp } from "../inline/InkHistory";

class NoopObserver { observe(): void {} unobserve(): void {} disconnect(): void {} }
const g = globalThis as unknown as Record<string, unknown>;
g.ResizeObserver ??= NoopObserver;
g.MutationObserver ??= NoopObserver;
class FakeWheelEvent { constructor(type: string, init: Record<string, unknown>) { Object.assign(this, { type }, init); } }
g["WheelEvent"] ??= FakeWheelEvent;
g["HTMLElement"] ??= class {};
const HTMLEl = g["HTMLElement"] as { prototype: object };

const probe = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../pdf/PdfViewerProbe", async (importOriginal) => ({
	...(await importOriginal<typeof import("./PdfViewerProbe")>()),
	probeViewer: () => probe.current,
	viewerCanvasOf: () => null,
}));

import { PdfInkController } from "./PdfInkController";

type Listener = (ev: unknown) => void;
type Touch = { identifier: number; clientX: number; clientY: number; radiusX: number; radiusY: number };
const WIN_NAV = {
	userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) obsidian/1.12.3 Chrome/132.0.0.0 Electron/34.0.0 Safari/537.36",
	platform: "Win32",
	maxTouchPoints: 10,
};
const finger = (id: number, x: number, y: number): Touch => ({ identifier: id, clientX: x, clientY: y, radiusX: 5, radiusY: 5 });

function buildRig() {
	const wheels: Array<{ deltaY: number; ctrlKey: boolean }> = [];
	const styles: Record<string, string> = {};
	const winListeners = new Map<string, Listener[]>();
	const elListeners = new Map<string, Listener[]>();
	let viewerScale = 1;
	const win: Record<string, unknown> = {
		devicePixelRatio: 1,
		navigator: WIN_NAV,
		addEventListener: (type: string, fn: Listener) => { const l = winListeners.get(type) ?? []; l.push(fn); winListeners.set(type, l); },
		removeEventListener: (type: string, fn: Listener) => { const l = winListeners.get(type) ?? []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); },
		setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
		clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
		requestAnimationFrame: (fn: () => void) => setTimeout(fn, 16),
		cancelAnimationFrame: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
		getComputedStyle: () => ({ position: "relative", getPropertyValue: (p: string) => (p === "--scale-factor" ? String(viewerScale) : "") }),
	};
	const content = Object.setPrototypeOf({ setCssStyles: (s: Record<string, string>) => Object.assign(styles, s) }, HTMLEl.prototype);
	const page = Object.setPrototypeOf({
		tagName: "DIV", className: "page", parentElement: null,
		getAttribute: (n: string) => (n === "data-page-number" ? "1" : null),
		getBoundingClientRect: () => ({ left: 0, top: 0, right: 1000 * viewerScale, bottom: 1500 * viewerScale, width: 1000 * viewerScale, height: 1500 * viewerScale }),
	}, HTMLEl.prototype);
	const classes = new Set<string>();
	const scroller: Record<string, unknown> = {
		style: { touchAction: "" }, scrollLeft: 0, scrollTop: 0, ownerDocument: { defaultView: win },
		setCssStyles(s: { touchAction?: string }) { if (s.touchAction !== undefined) (this.style as { touchAction: string }).touchAction = s.touchAction; },
		classList: {
			add: (c: string) => void classes.add(c), remove: (c: string) => void classes.delete(c), contains: (c: string) => classes.has(c),
			toggle: (c: string, on?: boolean) => { const want = on ?? !classes.has(c); if (want) classes.add(c); else classes.delete(c); return want; },
		},
		addEventListener: (type: string, fn: Listener) => { const l = elListeners.get(type) ?? []; l.push(fn); elListeners.set(type, l); },
		removeEventListener: (type: string, fn: Listener) => { const l = elListeners.get(type) ?? []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); },
		getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0 }),
		setPointerCapture() {}, releasePointerCapture() {},
		querySelector: (sel: string) => { if (sel === ".pdfViewer") return content; if (sel === "div.page[data-page-number]") return page; return null; },
		querySelectorAll: (sel: string) => (sel.startsWith("div.page") ? [page] : []),
		dispatchEvent: (e: { type?: string; ctrlKey?: boolean; deltaY?: number }) => {
			if (e.type === "wheel") {
				wheels.push({ deltaY: e.deltaY ?? 0, ctrlKey: !!e.ctrlKey });
				if (e.ctrlKey && typeof e.deltaY === "number") viewerScale *= Math.exp(-e.deltaY * 0.0035);
			}
			return true;
		},
		createDiv: () => ({ setAttribute: () => {}, remove: () => {}, classList: { add: () => {}, remove: () => {}, toggle: () => {} }, setCssStyles: () => {}, parentElement: scroller }),
	};
	scroller.contains = (n: unknown) => n === scroller || n === content || n === page;
	probe.current = {
		scroller,
		get scaleFactor() { return viewerScale; },
		scaleSource: "test",
		get pages() { return [{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: 1000 * viewerScale, heightPx: 1500 * viewerScale, hasCanvas: true }]; },
	};
	const ops: InkOp[] = [];
	const controller = new PdfInkController({} as HTMLElement, win as unknown as Window, () => [], () => "doc-1", () => [], (op) => void ops.push(op));
	(controller as unknown as { bindTo(el: unknown): void }).bindTo(scroller);
	const touch = (type: "touchstart" | "touchmove" | "touchend" | "touchcancel", changed: Touch[], touches: Touch[]): void => {
		let stopped = false;
		let immediate = false;
		const ev = {
			type, target: content, changedTouches: changed, touches, cancelable: true, defaultPrevented: false,
			preventDefault() { this.defaultPrevented = true; },
			stopPropagation() { stopped = true; },
			stopImmediatePropagation() { stopped = true; immediate = true; },
		};
		for (const fn of (winListeners.get(type) ?? []).slice()) { if (immediate) break; fn(ev); }
		if (!stopped) for (const fn of (elListeners.get(type) ?? []).slice()) { if (immediate) break; fn(ev); }
	};
	const pointer = (ev: PointerEvent): void => { for (const fn of (elListeners.get(ev.type) ?? []).slice()) fn(ev); };
	return { controller, wheels, styles, touch, pointer, ops, scale: () => viewerScale };
}

describe("a pinch already running when the pen lands on a PDF", () => {
	let uninstallWindow: () => void = () => {};
	beforeAll(() => { uninstallWindow = installFakeWindow(); });
	afterAll(() => uninstallWindow());
	let rig: ReturnType<typeof buildRig>;
	beforeEach(() => { vi.useFakeTimers(); resetTipModeForTest(); setMouseInk(false); rig = buildRig(); });
	afterEach(() => {
		(rig.controller as unknown as { router: { dispose(): void } | null }).router?.dispose();
		vi.useRealTimers();
		resetTipModeForTest();
	});

	it("stops zooming the document under the pen once the stroke holds the pane", () => {
		const a0 = finger(2, 350, 300);
		const b0 = finger(3, 450, 300);
		rig.touch("touchstart", [a0, b0], [a0, b0]);
		setTipMode("nib");
		rig.pointer(penEvent("pointerdown", 100, { x: 200, y: 100 }));
		rig.pointer(penEvent("pointermove", 110, { x: 210, y: 110 }));
		expect(rig.controller.idle, "precondition: the stroke holds the pane").toBe(false);
		const a1 = finger(2, 300, 300);
		const b1 = finger(3, 500, 300);
		rig.touch("touchmove", [a1, b1], [a1, b1]);
		expect.soft(rig.styles["transform"] ?? "", "the viewer was CSS-scaled under the pen mid-stroke").toBe("");
		rig.touch("touchend", [a1, b1], []);
		vi.advanceTimersByTime(300);
		expect.soft(rig.wheels.filter((w) => w.ctrlKey), "ctrl+wheel zoom fired on the PDF in the middle of a pen stroke").toEqual([]);
		expect.soft(rig.scale(), "the PDF's zoom changed mid-stroke").toBe(1);
		expect(rig.controller.idle, "the stroke is still live").toBe(false);
	});

	it("the end of the stroke still lands under the nib", () => {
		const a0 = finger(2, 350, 300);
		const b0 = finger(3, 450, 300);
		rig.touch("touchstart", [a0, b0], [a0, b0]);
		setTipMode("nib");
		rig.pointer(penEvent("pointerdown", 100, { x: 200, y: 100 }));
		rig.pointer(penEvent("pointermove", 110, { x: 210, y: 110 }));
		const a1 = finger(2, 300, 300);
		const b1 = finger(3, 500, 300);
		rig.touch("touchmove", [a1, b1], [a1, b1]);
		rig.touch("touchend", [a1, b1], []);
		const nib = { x: 400, y: 200 };
		const pagePoint = { x: nib.x / rig.scale(), y: nib.y / rig.scale() };
		rig.pointer(penEvent("pointermove", 120, nib));
		rig.pointer(penEvent("pointerup", 130, { ...nib, pressure: 0, buttons: 0 }));
		expect(rig.ops.length, "precondition: the stroke committed").toBe(1);
		const op = rig.ops[0] as Extract<InkOp, { type: "add" }>;
		const last = op.strokes[0]!.points[op.strokes[0]!.points.length - 1]!;
		expect({ x: Math.round(last.x), y: Math.round(last.y) }, `ink landed off the nib after a mid-stroke zoom to ${rig.scale().toFixed(3)}`)
			.toEqual({ x: Math.round(pagePoint.x), y: Math.round(pagePoint.y) });
	});

	it("a pinch preview already showing when the pen lands is dropped at pen-down, before the first sample", () => {
		const a0 = finger(2, 350, 300);
		const b0 = finger(3, 450, 300);
		rig.touch("touchstart", [a0, b0], [a0, b0]);
		const a1 = finger(2, 300, 300);
		const b1 = finger(3, 500, 300);
		rig.touch("touchmove", [a1, b1], [a1, b1]);
		expect(rig.styles["transform"] ?? "", "precondition: the pinch preview is showing").not.toBe("");
		setTipMode("nib");
		// The bridge measures its gain with one small zoom inside the first
		// pinch, before the pen lands; only what comes after pen-down counts.
		const wheelsAtPenDown = rig.wheels.filter((w) => w.ctrlKey).length;
		const scaleAtPenDown = rig.scale();
		rig.pointer(penEvent("pointerdown", 100, { x: 200, y: 100 }));
		expect(rig.styles["transform"] ?? "", "the preview stayed on the viewer under the pen").toBe("");
		rig.touch("touchend", [a1, b1], []);
		vi.advanceTimersByTime(300);
		expect(rig.wheels.filter((w) => w.ctrlKey).length - wheelsAtPenDown, "the dropped pinch still zoomed the PDF after pen-down").toBe(0);
		expect(rig.scale(), "the PDF's zoom changed after pen-down").toBe(scaleAtPenDown);
	});
});
