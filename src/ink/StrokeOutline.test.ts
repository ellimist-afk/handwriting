import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * StrokeOutline's `ribbonOf` comment promises "drawStroke's exact style
 * derivation, so the widths match the note" (§5e, 1.4.6). That promise used
 * to be enforced by nothing: StrokeRenderer and StrokeOutline each restated
 * DEFAULT_PEN/HIGHLIGHTER_PEN's minWidthFactor and gamma as literals, and
 * tuning one without the other would pass every existing test while a note's
 * on-screen ink and its exported ink quietly diverged.
 *
 * This test drives StrokeRenderer.drawStroke through the seam RibbonCache
 * .test.ts uses (a fake 2d context, cacheRibbon=false to skip the WeakMap
 * cache and force a fresh flatten every call) and intercepts the flattened
 * ribbon at fillRibbon - the one place StrokeRenderer hands the geometry to
 * the canvas - by mocking RibbonRenderer. That ribbon is then compared,
 * deep-equal, against StrokeOutline.ribbonOf's output for the same stroke.
 * Zoom is set to EXPORT_PX_PER_WORLD and shaping is left on so the two
 * derivations are asked to do the same work; only shapeFor's contribution
 * (minWidthFactor/gamma) is what's actually under test here, but a literal
 * edit anywhere else in either path would break this test too.
 */

const capturedRibbons: unknown[] = [];

vi.mock("./RibbonRenderer", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./RibbonRenderer")>();
	return {
		...actual,
		fillRibbon: (_ctx: unknown, _cam: unknown, pts: unknown) => {
			capturedRibbons.push(pts);
		},
	};
});

import { CameraState } from "../camera/coordinates";
import { setInkShaping } from "./InkShape";
import { EXPORT_PX_PER_WORLD, ribbonOf } from "./StrokeOutline";
import { drawStroke } from "./StrokeRenderer";
import { computeBBox, InkPoint, InkStroke } from "./Stroke";

function fakeCtx(): CanvasRenderingContext2D {
	return {
		fillStyle: "",
		strokeStyle: "",
		lineWidth: 0,
		lineCap: "",
		lineJoin: "",
		beginPath() {},
		moveTo() {},
		lineTo() {},
		closePath() {},
		arc() {},
		fill() {},
		stroke() {},
		save() {},
		restore() {},
	} as unknown as CanvasRenderingContext2D;
}

function makeStroke(tool: InkStroke["tool"]): InkStroke {
	const points: InkPoint[] = [
		{ x: 0, y: 0, pressure: 0.4, t: 0 },
		{ x: 12, y: 6, pressure: 0.7, t: 10 },
		{ x: 26, y: 4, pressure: 0.55, t: 22 },
		{ x: 40, y: 18, pressure: 0.6, t: 34 },
	];
	const width = tool === "highlighter" ? 16 : 2.2;
	return {
		id: "s1",
		tool,
		color: tool === "highlighter" ? "#ffd60a" : "#2f6de0",
		width,
		points,
		bbox: computeBBox(points, width),
		createdAt: 0,
	};
}

/** Exports flatten at EXPORT_PX_PER_WORLD; match that on the renderer side. */
const EXPORT_CAM: CameraState = { x: 0, y: 0, zoom: EXPORT_PX_PER_WORLD };

function renderedRibbonFor(stroke: InkStroke): unknown {
	capturedRibbons.length = 0;
	drawStroke(fakeCtx(), EXPORT_CAM, stroke, undefined, true, false);
	expect(capturedRibbons).toHaveLength(1);
	return capturedRibbons[0];
}

/**
 * The agreement is real but CONDITIONAL, and the condition is the setting.
 * Exports are always shaped (§5n) and shaping implies a smoothed centerline,
 * so `ribbonOf` never varies; the screen follows "Ink smoothing" on both
 * axes. With it on the two are identical, which is what the comment on
 * `ribbonOf` promises. With it off they must differ for the pen and still
 * agree for the highlighter, whose flat wash is exempt from both. Asserting
 * only the ON case would let the export path start following the screen
 * again without a test noticing (§5l/AE7).
 */
describe("StrokeRenderer and StrokeOutline agree on a stroke's geometry", () => {
	beforeEach(() => {
		setInkShaping(true);
	});

	afterEach(() => {
		setInkShaping(true);
	});

	it("flattens a pen stroke identically on screen and on export", () => {
		const stroke = makeStroke("pen");
		expect(renderedRibbonFor(stroke)).toEqual(ribbonOf(stroke));
	});

	it("flattens a highlighter stroke identically on screen and on export", () => {
		const stroke = makeStroke("highlighter");
		expect(renderedRibbonFor(stroke)).toEqual(ribbonOf(stroke));
	});

	it("parts company with the export when smoothing is off, for the pen only", () => {
		setInkShaping(false);
		const pen = makeStroke("pen");
		const exported = ribbonOf(pen);
		expect(renderedRibbonFor(pen)).not.toEqual(exported);
		// The export is unmoved by the setting: that is the always-shaped rule.
		setInkShaping(true);
		expect(ribbonOf(pen)).toEqual(exported);
		// The highlighter is exempt from both axes, so it never parts company.
		setInkShaping(false);
		const hl = makeStroke("highlighter");
		expect(renderedRibbonFor(hl)).toEqual(ribbonOf(hl));
	});
});
