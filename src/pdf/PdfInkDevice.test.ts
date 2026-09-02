/**
 * A mouse-drawn stroke on the PDF surface must be marked as one.
 *
 * `StrokeBuilder`'s fifth argument sets `stroke.device`, and `device ===
 * "mouse"` is what suppresses velocity shaping downstream (StrokeOutline.ts,
 * StrokeRenderer.ts). A mouse reports no pressure and its velocity is not a
 * hand's, so a shaped mouse stroke thins and swells at the wrong places.
 *
 * The note surface has passed it since mouse ink existed
 * (InkOverlay.ts: `fromMouse ? "mouse" : undefined`). This surface computed
 * the same answer at pen-down - `this.mouseStroke` - and then built the
 * stroke with three arguments, so the flag was worked out and dropped on the
 * floor and every mouse stroke over a PDF was shaped. The divergence is
 * 1.4.7-design.md C6 / backlog #5.
 *
 * Driven through the controller's own pen callbacks rather than asserted on
 * source text: what matters is that the flag survives from the pointer event
 * to the committed stroke, and only the whole path shows that.
 */

import { describe, expect, it, vi } from "vitest";
import { InkOp } from "../inline/InkHistory";
import { InkStroke } from "../ink/Stroke";
import { PenSample } from "../input/PointerRouter";
import { resetTipModeForTest } from "../inline/TipMode";

/**
 * The gesture path constructs observers; node has none and none is needed
 * here. Same no-op the lasso suite installs.
 */
class NoopObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
const g = globalThis as unknown as Record<string, unknown>;
g.ResizeObserver ??= NoopObserver;
g.MutationObserver ??= NoopObserver;

const probe = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("./PdfViewerProbe", () => ({ probeViewer: () => probe.current }));

import { PdfInkController } from "./PdfInkController";

/** css px per point, as `--scale-factor` reports it. */
const SCALE = 2;

function sample(x: number, y: number): PenSample {
	return { x, y, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 };
}

/**
 * The private pen callbacks, which is what the router calls. `penDown` takes
 * the originating PointerEvent as its second argument and that event is the
 * only place the device is stated.
 */
type Pen = {
	penDown(s: PenSample, ev?: PointerEvent): void;
	penRaw(s: PenSample[]): void;
	penUp(): void;
};

/** Draw one short stroke on page 1 and return the strokes it committed. */
function drawWith(pointerType: string | undefined): InkStroke[] {
	resetTipModeForTest();
	const ops: InkOp[] = [];
	// Richer than the lasso suite's scroller stub, and it has to be: a MOUSE
	// keeps the nib reticle on (`if (!this.mouseStroke) this.hideCursor()`),
	// so the mouse path alone walks into `showCursor`, which creates a div in
	// the scroller and styles it. A stub that only answers the pen path would
	// make this test unrunnable on the one device it is about.
	const el = () => ({
		parentElement: null as unknown,
		classList: { add: () => {}, remove: () => {}, toggle: () => {} },
		setAttribute: () => {},
		setCssStyles: () => {},
		remove: () => {},
	});
	const scroller = {
		scrollLeft: 0,
		scrollTop: 0,
		classList: { add: () => {}, remove: () => {} },
		querySelector: () => null,
		setCssStyles: () => {},
		createDiv: () => el(),
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
		setTimeout: () => 0,
		requestAnimationFrame: () => 0,
		// "relative" so showCursor leaves the scroller's own position alone;
		// the branch that rewrites it is not what is under test here.
		getComputedStyle: () => ({ position: "relative" }),
	};
	const strokes: InkStroke[] = [];
	const controller = new PdfInkController(
		{} as HTMLElement,
		win as unknown as Window,
		() => strokes,
		() => "doc-1",
		() => strokes,
		(op) => ops.push(op)
	);
	const pen = controller as unknown as Pen;
	// Only `pointerType` is read at pen-down. `buttons`/`button` are left
	// undefined deliberately: the eraser-end test reads them and undefined
	// must not be mistaken for a barrel button.
	const ev = pointerType === undefined ? undefined : ({ pointerType } as PointerEvent);
	pen.penDown(sample(200, 200), ev);
	pen.penRaw([sample(210, 210)]);
	pen.penRaw([sample(220, 215)]);
	pen.penUp();
	const added = ops.filter((op) => op.type === "add") as Extract<InkOp, { type: "add" }>[];
	return added.flatMap((op) => op.strokes);
}

describe("PdfInkController stamps the drawing device", () => {
	it("marks a mouse-drawn stroke so shaping is suppressed", () => {
		const drawn = drawWith("mouse");
		expect(drawn).toHaveLength(1);
		// The whole point: `stroke.device !== "mouse"` is the shaping gate, so
		// an absent field here is a shaped mouse stroke.
		expect(drawn[0]!.device).toBe("mouse");
	});

	it("leaves a pen-drawn stroke unmarked, so it is still shaped", () => {
		const drawn = drawWith("pen");
		expect(drawn).toHaveLength(1);
		expect(drawn[0]!.device).toBeUndefined();
	});

	it("leaves a stroke with no originating event unmarked", () => {
		// The synthetic path (no PointerEvent) must not claim to be a mouse.
		const drawn = drawWith(undefined);
		expect(drawn).toHaveLength(1);
		expect(drawn[0]!.device).toBeUndefined();
	});
});
