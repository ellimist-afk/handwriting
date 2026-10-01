
/** Extend the existing cursor fixture with its owned clipping parent. */
function cursorChildren(createCursor: () => any): (options?: { cls?: string }) => any {
	return (options) => {
		const cursor = createCursor();
		if (options?.cls !== "handwriting-pdf-cursor-viewport") return cursor;
		const viewport = {
			parentElement: cursor.parentElement,
			classList: { contains: (cls: string) => cls === "handwriting-pdf-cursor-viewport" },
			setCssStyles() {},
			createDiv: () => cursor,
			remove() { cursor.remove(); viewport.parentElement = null; },
		};
		cursor.parentElement = viewport;
		return viewport;
	};
}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PenSample } from "../input/PointerRouter";
import { resetTipModeForTest, setTipMode } from "../inline/TipMode";
import { getEraserRadiusPx, getInkSizeMult, setInlineTool, setPenReticle } from "../inline/InkOverlay";
import { DEFAULT_PEN } from "../ink/PenStyle";
const probe = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("./PdfViewerProbe", () => ({ probeViewer: () => probe.current, viewerCanvasOf: () => null }));
import { PdfInkController, pdfPenWidth } from "./PdfInkController";
const SCALE = 2;
const sample = (x: number, y: number): PenSample => ({ x, y, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 });
describe("PdfInkController pen reticle - mode-specific looks", () => {
	let controller: PdfInkController;
	let priv: { showCursor(sample: PenSample, pointerType?: string): void; penDown(s: PenSample, ev?: PointerEvent): void; penRaw(s: PenSample[]): void; penUp(): void; boundScroller: unknown };
	let cursorClasses: Set<string>;
	let cursorStyle: Record<string, unknown>;

	beforeEach(() => {
		resetTipModeForTest();
		setPenReticle(true);
		cursorClasses = new Set();
		cursorStyle = {};
		const scroller = {
			scrollLeft: 0,
			scrollTop: 0,
			classList: { add: () => {}, remove: () => {} },
			querySelector: () => null,
			setCssStyles: () => {},
			createDiv: cursorChildren(() => ({
				setAttribute: () => {},
				remove: () => {},
				classList: {
					add: (...cls: string[]) => cls.forEach((c) => cursorClasses.add(c)),
					remove: (...cls: string[]) => cls.forEach((c) => cursorClasses.delete(c)),
					toggle: (cls: string, on?: boolean) => {
						const next = on ?? !cursorClasses.has(cls);
						if (next) cursorClasses.add(cls);
						else cursorClasses.delete(cls);
					},
				},
				setCssStyles: (styles: Record<string, unknown>) => {
					Object.assign(cursorStyle, styles);
				},
				parentElement: scroller,
			})),
		};
		probe.current = {
			scroller,
			scaleFactor: SCALE,
			scaleSource: "test",
			pages: [
				{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: 600, heightPx: 800, hasCanvas: true },
			],
		};
		const win = {
			devicePixelRatio: 1,
			clearTimeout: () => {},
			setTimeout: () => 1,
			requestAnimationFrame: () => 0,
			getComputedStyle: () => ({ position: "relative" }),
		};
		controller = new PdfInkController(
			{} as HTMLElement,
			win as unknown as Window,
			() => [],
			() => "doc-1",
			() => [],
			() => {}
		);
		priv = controller as unknown as typeof priv; priv.boundScroller = scroller;
	});

	afterEach(() => {
		setPenReticle(true);
	});

	it("nib: no ring, no pan ring, no space rule", () => {
		setTipMode("nib");
		priv.showCursor(sample(10, 10), "pen");
		expect(cursorClasses.has("handwriting-pdf-cursor-ring")).toBe(false);
		expect(cursorClasses.has("handwriting-pdf-cursor-pan")).toBe(false);
		expect(cursorClasses.has("handwriting-pdf-cursor-space")).toBe(false);
	});

	it("lasso: a dashed ring at the fixed 9px radius, not the nib width", () => {
		setTipMode("lasso");
		priv.showCursor(sample(10, 10), "pen");
		expect(cursorClasses.has("handwriting-pdf-cursor-ring")).toBe(true);
		expect(cursorClasses.has("handwriting-pdf-cursor-pan")).toBe(false);
		// 9px radius -> 18px square, whatever the nib width setting is.
		expect(cursorStyle.width).toBe("18px");
		expect(cursorStyle.height).toBe("18px");
	});

	it("pan: the one solid ring, at the fixed 11px radius", () => {
		setTipMode("pan");
		priv.showCursor(sample(10, 10), "pen");
		expect(cursorClasses.has("handwriting-pdf-cursor-pan")).toBe(true);
		// Solid, not dashed: must not also carry the eraser/lasso ring class.
		expect(cursorClasses.has("handwriting-pdf-cursor-ring")).toBe(false);
		expect(cursorStyle.width).toBe("22px");
		expect(cursorStyle.height).toBe("22px");
	});

	it("space: a dashed rule, not a ring - zero height, fixed 48px width", () => {
		setTipMode("space");
		priv.showCursor(sample(10, 10), "pen");
		expect(cursorClasses.has("handwriting-pdf-cursor-space")).toBe(true);
		expect(cursorClasses.has("handwriting-pdf-cursor-ring")).toBe(false);
		expect(cursorClasses.has("handwriting-pdf-cursor-pan")).toBe(false);
		expect(cursorStyle.width).toBe("48px");
		expect(cursorStyle.height).toBe("0px");
	});

	it("nib: the dot grows with the zoom, because the ink it promises does", () => {
		setTipMode("nib");
		setInlineTool("pen");
		// Zoomed past this fixture's own scale, and well past the 1.5px floor,
		// so the number can only come from the live scale. Under the old law
		// the dot was the same size at every zoom (width / scale * scale) and
		// small enough to be floored to 3px at the default nib.
		(probe.current as { scaleFactor: number }).scaleFactor = 4;
		priv.showCursor(sample(10, 10), "pen");
		const ink = pdfPenWidth(DEFAULT_PEN.baseWidth, getInkSizeMult("pen")) * 4;
		expect(parseFloat(String(cursorStyle.width))).toBeCloseTo(ink, 6);
		expect(parseFloat(String(cursorStyle.height))).toBeCloseTo(ink, 6);
	});

	it("eraser still reads its true erase radius, unaffected by the new branches", () => {
		setTipMode("eraser");
		priv.showCursor(sample(10, 10), "pen");
		expect(cursorClasses.has("handwriting-pdf-cursor-ring")).toBe(true);
		const r = getEraserRadiusPx();
		expect(cursorStyle.width).toBe(`${r * 2}px`);
	});
	for (const event of [{ buttons: 32, button: -1 }, { buttons: 0, button: 5 }]) {
		it(`hardware eraser shows its radius at contact and raw movement ${JSON.stringify(event)}`, () => {
			setTipMode("nib");
			priv.showCursor(sample(10, 10), "pen");
			expect(cursorClasses.has("handwriting-pdf-cursor-ring")).toBe(false);
			priv.penDown(sample(200, 200), { ...event, pointerType: "pen" } as PointerEvent);
			expect(cursorClasses.has("handwriting-pdf-cursor-ring")).toBe(true);
			expect(cursorStyle.width).toBe(`${getEraserRadiusPx() * 2}px`);
			expect(cursorStyle.backgroundColor).toBe("transparent");
			priv.penRaw([sample(220, 220)]);
			expect(cursorStyle.width).toBe(`${getEraserRadiusPx() * 2}px`);
			priv.penUp();
			priv.showCursor(sample(240, 240), "pen");
			expect(cursorClasses.has("handwriting-pdf-cursor-ring")).toBe(false);
		});
	}
	it("reticle-off stays hidden for hardware erase", () => {
		priv.showCursor(sample(10, 10), "pen");
		setPenReticle(false);
		priv.penDown(sample(200, 200), { buttons: 32, button: -1, pointerType: "pen" } as PointerEvent);
		expect(cursorStyle.display).toBe("none");
		priv.penUp();
	});});
