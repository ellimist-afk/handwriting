/**
 * The PDF wet layer and the commit must make the SAME shaping decision.
 *
 * Two layers decide it separately. The commit reads the stroke:
 * `!flat && stroke.device !== "mouse" && inkShapingEnabled()`
 * (StrokeRenderer.ts:227). The wet layer reads its own `shape` field, latched
 * once per stroke into `shapingThisStroke` at `beginStroke`
 * (WetInkRenderer.ts:139).
 *
 * The note surface keeps them in step by setting `wet.shape = !fromMouse` at
 * pen-down (InkOverlay.ts:2031). This surface set it ONCE, at the pair's
 * construction, and never per stroke - which was inert while `beginStroke`
 * was never called here at all (5d6309a wired it), and became a visible
 * defect the moment the commit learned about the mouse (1c4b250): the mouse
 * stroke was drawn SHAPED and committed FLAT, so it reshaped under the nib at
 * pen-up. That pen-up jump is the exact failure `liveWidthPx` and the
 * hardware report of 2026-08-29 exist for.
 *
 * Driven through the controller's own pen callbacks with a REAL
 * `WetInkRenderer` over a fake 2d context, so the latch under test is the
 * real one and not a stand-in for it.
 */

import { describe, expect, it, vi } from "vitest";
import { InkOp } from "../inline/InkHistory";
import { InkStroke } from "../ink/Stroke";
import { PenSample } from "../input/PointerRouter";
import { resetTipModeForTest } from "../inline/TipMode";
import { WetInkRenderer } from "../ink/WetInkRenderer";
import { TailRenderer } from "../ink/TailRenderer";
import { inkShapingEnabled, setInkShaping } from "../ink/InkShape";

/** The gesture path constructs observers; node has none and none is needed. */
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

/** A 2d context that answers everything with a no-op. Only pixels are fake. */
function fakeCanvas(): HTMLCanvasElement {
	const ctx = new Proxy(
		{},
		{
			get(_t, prop) {
				if (prop === "getContextAttributes") return () => ({ desynchronized: false });
				return () => undefined;
			},
			set() {
				return true;
			},
		}
	);
	// `dressWet` sets the wash on both canvases of the pair through Obsidian's
	// setCssProps, so a bare getContext stub is not enough to reach pen-down.
	return {
		getContext: () => ctx,
		setCssProps: () => {},
		setCssStyles: () => {},
	} as unknown as HTMLCanvasElement;
}

function sample(x: number, y: number, t: number): PenSample {
	return { x, y, pressure: 0.5, timestamp: t, tiltX: 0, tiltY: 0 };
}

type Pen = {
	penDown(s: PenSample, ev?: PointerEvent): void;
	penRaw(s: PenSample[]): void;
	penUp(): void;
};

/** The one private the wet layer latches its per-stroke shaping decision into. */
type Latch = { shapingThisStroke: boolean };

interface Drawn {
	/** `wet.shape` as it read at the instant `beginStroke` was called. */
	shapeAtLatch: boolean | undefined;
	/** What the wet layer actually latched, from the real renderer. */
	wetShaped: boolean | undefined;
	/** What the committed renderer will decide for the stroke that landed. */
	commitShaped: boolean;
	strokes: InkStroke[];
}

/**
 * Draw one short stroke on page 1 with a live wet layer attached, and report
 * both shaping decisions.
 *
 * The pair is injected rather than grown by `attachPair`, because the page
 * element that would host it does not exist here: `pageElement` goes through
 * `scroller.querySelector`, which answers null, so `attachPair` is never
 * called and the injected pair survives pen-down. `wetOn` is a pure read of
 * `pair` and `wetHostPage`, so the layer the controller finds is this one.
 */
function drawWith(pointerType: string | undefined): Drawn {
	resetTipModeForTest();
	setInkShaping(true);
	const ops: InkOp[] = [];
	// A mouse keeps the nib reticle on (`if (!this.mouseStroke)
	// this.hideCursor()`), so the mouse path alone walks into `showCursor`,
	// which creates a div in the scroller and styles it.
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

	// The real renderer, dressed exactly as `attachPair` dresses it.
	const wet = new WetInkRenderer(fakeCanvas(), false);
	wet.smooth = true;
	wet.shape = true;
	const pair = {
		wetCanvas: fakeCanvas(),
		headCanvas: fakeCanvas(),
		wet,
		tail: new TailRenderer(fakeCanvas()),
	};
	const priv = controller as unknown as {
		pair: unknown;
		wetHostPage: number;
		pageSize: Map<number, { wPt: number; hPt: number }>;
	};
	priv.pair = pair;
	priv.wetHostPage = 1;
	// `cameraFor` answers null without a page size, and `drawWet` returns on a
	// null camera - so without this the wet layer is never told anything and
	// the test would pass or fail for the wrong reason. 600px / 300pt = 2x,
	// the SCALE the probe reports.
	priv.pageSize.set(1, { wPt: 300, hPt: 400 });

	// Read at the latch, not after it. An assignment that lands AFTER
	// `beginStroke` would leave `shapingThisStroke` wrong while `shape` looks
	// right, and only sampling here tells the two apart.
	let shapeAtLatch: boolean | undefined;
	const realBegin = wet.beginStroke.bind(wet);
	wet.beginStroke = (...args: Parameters<WetInkRenderer["beginStroke"]>) => {
		shapeAtLatch = wet.shape;
		realBegin(...args);
	};

	const pen = controller as unknown as Pen;
	const ev = pointerType === undefined ? undefined : ({ pointerType } as PointerEvent);
	pen.penDown(sample(200, 200, 0), ev);
	pen.penRaw([sample(240, 250, 16)]);
	pen.penRaw([sample(290, 300, 32)]);
	pen.penUp();

	const added = ops.filter((op) => op.type === "add") as Extract<InkOp, { type: "add" }>[];
	const drawnStrokes = added.flatMap((op) => op.strokes);
	const stroke = drawnStrokes[0];
	// StrokeRenderer.ts:227, restated. `flat` is the highlighter's exemption
	// and this gesture is a pen tool, so it is the device that decides.
	const commitShaped =
		!!stroke && stroke.tool !== "highlighter" && stroke.device !== "mouse" && inkShapingEnabled();
	return {
		shapeAtLatch,
		wetShaped: (wet as unknown as Latch).shapingThisStroke,
		commitShaped,
		strokes: drawnStrokes,
	};
}

describe("the pdf wet layer agrees with the commit about shaping", () => {
	it("does not shape a mouse stroke live, because it will not shape it at pen-up", () => {
		const drawn = drawWith("mouse");
		expect(drawn.strokes).toHaveLength(1);
		// The commit half, from 1c4b250: the mouse is stamped, so no shaping.
		expect(drawn.strokes[0]!.device).toBe("mouse");
		expect(drawn.commitShaped).toBe(false);
		// The wet half, which is this slice. Both must be false or the stroke
		// visibly reshapes at pen-up.
		expect(drawn.shapeAtLatch).toBe(false);
		expect(drawn.wetShaped).toBe(false);
		expect(drawn.wetShaped).toBe(drawn.commitShaped);
	});

	it("still shapes a pen stroke live, exactly as it commits it", () => {
		const drawn = drawWith("pen");
		expect(drawn.strokes).toHaveLength(1);
		expect(drawn.strokes[0]!.device).toBeUndefined();
		expect(drawn.commitShaped).toBe(true);
		expect(drawn.shapeAtLatch).toBe(true);
		expect(drawn.wetShaped).toBe(true);
		expect(drawn.wetShaped).toBe(drawn.commitShaped);
	});

	it("shapes a stroke with no originating event, matching its commit", () => {
		// The synthetic path must not be demoted to a mouse on either layer.
		const drawn = drawWith(undefined);
		expect(drawn.strokes).toHaveLength(1);
		expect(drawn.wetShaped).toBe(true);
		expect(drawn.wetShaped).toBe(drawn.commitShaped);
	});
});
