import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CameraState } from "../camera/coordinates";
import { clearInkClipboard, copyInk, pasteInk } from "../inline/InkClipboard";
import { invertInkOp } from "../inline/InkHistory";
import { emptyPage, parsePage, SCHEMA_VERSION, serializePage } from "../model/PageData";
import { splitStrokeByCircle } from "./Eraser";
import { flattenStrokeShaped, setInkShaping } from "./InkShape";
import { inkPdfContent, inkToPdf, strokePdfOps } from "./InkPdf";
import {
	DEFAULT_PEN,
	HIGHLIGHTER_ALPHA,
	setPressureSensitivity,
	shapeFor,
} from "./PenStyle";
import { flattenStroke } from "./Ribbon";
import { snapStroke } from "./ShapeSnap";
import { computeBBox, type InkPoint, type InkStroke } from "./Stroke";
import { StrokeBuilder } from "./StrokeBuilder";
import { EXPORT_PX_PER_WORLD, ribbonOf, strokeOutline } from "./StrokeOutline";
import { drawStroke, resetRibbonCacheStats, ribbonCacheStats } from "./StrokeRenderer";
import { strokeWidthPolicy } from "./StrokeWidth";
import { inkSvgBody, strokeToSvg } from "./SvgExport";
import { WetInkRenderer } from "./WetInkRenderer";

const CAM: CameraState = { x: 0, y: 0, zoom: 1 };
const SERIALIZED_WIDTH_TOLERANCE = 0.0005;
const SERIALIZED_HALF_WIDTH_TOLERANCE = SERIALIZED_WIDTH_TOLERANCE / 2 + 1e-10;

const variedPoints: InkPoint[] = [
	{ x: 0, y: 0, pressure: 0.02, t: 0 },
	{ x: 2, y: 1, pressure: 1, t: 80 }, // slow, hard
	{ x: 42, y: 4, pressure: 0.08, t: 84 }, // fast, light
	{ x: 46, y: 15, pressure: 0.75, t: 140 },
	{ x: 90, y: 18, pressure: 0.15, t: 144 },
];

function stroke(
	id: string,
	width: number,
	tool: InkStroke["tool"] = "pen",
	widthMode: InkStroke["widthMode"] = "uniform"
): InkStroke {
	return {
		id,
		tool,
		color: tool === "highlighter" ? "#ffd60a" : "#2f6de0",
		width,
		widthMode,
		points: variedPoints.map((point) => ({ ...point })),
		bbox: computeBBox(variedPoints, width * 2),
		createdAt: 17,
	};
}

function legacyStroke(id: string, tool: InkStroke["tool"], device?: "mouse"): InkStroke {
	const value = stroke(id, tool === "highlighter" ? 16 : 2.2, tool);
	delete value.widthMode;
	if (device) value.device = device;
	return value;
}

function fakeCanvas(): { canvas: HTMLCanvasElement; radii: number[] } {
	const radii: number[] = [];
	const ctx = new Proxy(
		{},
		{
			get(_target, prop) {
				if (prop === "getContextAttributes") return () => ({ desynchronized: false });
				if (prop === "arc") {
					return (_x: number, _y: number, radius: number) => void radii.push(radius);
				}
				return () => undefined;
			},
			set() {
				return true;
			},
		}
	) as unknown as CanvasRenderingContext2D;
	return {
		canvas: { getContext: () => ctx } as unknown as HTMLCanvasElement,
		radii,
	};
}

function fakeCtx(): CanvasRenderingContext2D {
	return fakeCanvas().canvas.getContext("2d")!;
}

function committedCanvasRadii(value: InkStroke): number[] {
	const { canvas, radii } = fakeCanvas();
	drawStroke(canvas.getContext("2d")!, CAM, value, undefined, true, false);
	return radii;
}

function expectUniform(values: readonly number[], halfWidth: number): void {
	expect(values.length).toBeGreaterThan(0);
	for (const value of values) expect(value).toBeCloseTo(halfWidth, 10);
}

function expectUniformWithin(
	values: readonly number[],
	halfWidth: number,
	tolerance: number
): void {
	expect(values.length).toBeGreaterThan(0);
	for (const value of values) {
		expect(Math.abs(value - halfWidth)).toBeLessThanOrEqual(tolerance);
	}
}

describe("uniform finger stroke width", () => {
	beforeEach(() => {
		setInkShaping(true);
		setPressureSensitivity(true);
		clearInkClipboard();
		resetRibbonCacheStats();
	});

	afterEach(() => {
		setInkShaping(true);
		setPressureSensitivity(true);
		clearInkClipboard();
	});

	it.each([true, false])(
		"keeps two selected sizes constant through pressure, speed, and both endpoints with pressure=%s",
		(pressureOn) => {
			setPressureSensitivity(pressureOn);
			for (const width of [2.2, 7.5]) {
				const value = stroke(`uniform-${width}`, width);
				const ribbon = ribbonOf(value);
				expectUniform(
					ribbon.map((point) => point.hw),
					width / 2
				);
				expect(ribbon[0]!.hw).toBeCloseTo(width / 2, 10);
				expect(ribbon.at(-1)!.hw).toBeCloseTo(width / 2, 10);
			}
		}
	);

	it.each([true, false])(
		"matches the live settled ribbon, head, contact dot, and committed ribbon with pressure=%s",
		(pressureOn) => {
			setPressureSensitivity(pressureOn);
			const width = 6;
			const value = stroke("live", width);
			const policy = strokeWidthPolicy(
				{ ...DEFAULT_PEN, baseWidth: width },
				value.widthMode
			);
			const { canvas, radii } = fakeCanvas();
			const wet = new WetInkRenderer(canvas, false);
			wet.smooth = true;
			wet.shape = policy.shapeWidth;
			wet.beginStroke(value.points[0]!, policy.style, false);
			expect(wet.contactHalfWidth(policy.style, value.points[0]!.pressure)).toBeCloseTo(
				width / 2,
				10
			);
			for (const point of value.points.slice(1)) {
				wet.appendPoint(CAM, policy.style, point);
				expect(wet.liveHalfWidth(policy.style, point.pressure)).toBeCloseTo(width / 2, 10);
			}
			wet.finishStroke(CAM, policy.style);
			expectUniform(radii, width / 2);
			expectUniform(
				ribbonOf(value).map((point) => point.hw),
				width / 2
			);
		}
	);

	it("keeps the smoothed centerline while disabling only width shaping", () => {
		const value = stroke("centerline", 5);
		const policy = strokeWidthPolicy(
			{ ...DEFAULT_PEN, baseWidth: value.width },
			value.widthMode
		);
		expect(policy.shapeWidth).toBe(false);
		expect(ribbonOf(value)).toEqual(
			flattenStroke(value.points, policy.style, EXPORT_PX_PER_WORLD, true)
		);
	});

	it("keeps round caps and makes a dot exactly the selected diameter in SVG and PDF", () => {
		const dot = stroke("dot", 8);
		dot.points = [{ x: 10, y: 20, pressure: 0.01, t: 0 }];
		dot.bbox = computeBBox(dot.points, dot.width * 2);
		const outline = strokeOutline(dot)!;
		expect(outline.left).toEqual([]);
		expect(outline.right).toEqual([]);
		expect(outline.discs).toEqual([{ x: 10, y: 20, r: 4 }]);
		expect(strokeToSvg(dot)).toContain('<circle cx="10" cy="20" r="4"/>');
		expect(strokePdfOps(dot)).toMatch(/^14 20 m /);
	});

	it("preserves the tag on builder dots and every release-filtered output group", () => {
		const dotBuilder = new StrokeBuilder("pen", "#2f6de0", 4, 0.15, undefined, "uniform");
		dotBuilder.start(1000);
		dotBuilder.add(10, 20, 0.5, 1000);
		const dot = dotBuilder.finish()!;
		expect(dot.widthMode).toBe("uniform");
		expect(dot.points).toHaveLength(2);

		const grouped = new StrokeBuilder("pen", "#2f6de0", 4, 0.15, undefined, "uniform");
		grouped.start(1000);
		for (const [x, pressure, time] of [
			[0, 0.4, 1000],
			[10, 0.3, 1006],
			[12, 0.012, 1010],
			[24, 0.014, 1022],
			[28, 0.04, 1027],
			[31, 0.08, 1032],
			[40, 0.2, 1040],
			[50, 0.01, 1050],
			[60, 0, 1060],
		] as const) {
			grouped.add(x, 0, pressure, time);
		}
		// The light run in the middle recovers, so it stays in the one stroke; the light ending is trimmed.
		const groups = grouped.finishReleaseFiltered();
		expect(groups).toHaveLength(1);
		expect(groups[0]!.points.map((point) => point.x)).toEqual([0, 10, 12, 24, 28, 31, 40]);
		expect(groups.map((value) => value.widthMode)).toEqual(["uniform"]);
	});

	it("round-trips as a recognized optional PageData field without changing the schema", () => {
		const page = emptyPage("uniform-page");
		page.strokes = [stroke("uniform", 5), legacyStroke("legacy", "pen")];
		const serialized = serializePage(page);
		const raw = JSON.parse(serialized) as {
			schemaVersion: number;
			strokes: Array<{ widthMode?: string }>;
		};
		expect(raw.schemaVersion).toBe(SCHEMA_VERSION);
		expect(raw.strokes.map((value) => value.widthMode)).toEqual(["uniform", undefined]);
		const restored = parsePage(serialized, page.pageId).data;
		expect(restored.strokes.map((value) => value.widthMode)).toEqual(["uniform", undefined]);
		expect(restored.unknownByObject.uniform).toBeUndefined();
	});

	it.each([true, false])(
		"paints literal selected half-widths on committed canvas before and after save/read with pressure=%s",
		(pressureOn) => {
			setPressureSensitivity(pressureOn);
			for (const tool of ["pen", "highlighter"] as const) {
				for (const selectedWidth of [2.2344, 7.8914]) {
					const line = stroke(`${tool}-${selectedWidth}-line`, selectedWidth, tool);
					const dot = stroke(`${tool}-${selectedWidth}-dot`, selectedWidth, tool);
					// StrokeBuilder represents a tap as a 0.01-world-unit segment so
					// committed rendering reaches its ordinary two-point ribbon path.
					dot.points = [
						{ x: 10, y: 20, pressure: 0.01, t: 0 },
						{ x: 10.01, y: 20, pressure: 0.99, t: 1 },
					];
					dot.bbox = computeBBox(dot.points, selectedWidth * 2);

					for (const value of [line, dot]) {
						expectUniformWithin(
							committedCanvasRadii(value),
							selectedWidth / 2,
							1e-10
						);
					}

					const page = emptyPage(`round-trip-${tool}-${selectedWidth}`);
					page.strokes = [line, dot];
					const restored = parsePage(serializePage(page), page.pageId).data.strokes;
					expect(restored).toHaveLength(2);
					for (const value of restored) {
						expect(value.widthMode).toBe("uniform");
						expect(Math.abs(value.width - selectedWidth)).toBeLessThanOrEqual(
							SERIALIZED_WIDTH_TOLERANCE
						);
						// Serialization rounds a full width to 0.001 world units, so
						// selectedWidth/2 may move by at most 0.00025 after reload.
						expectUniformWithin(
							committedCanvasRadii(value),
							selectedWidth / 2,
							SERIALIZED_HALF_WIDTH_TOLERANCE
						);
					}
				}
			}
		}
	);

	it("retains the tag through snap, erase fragments, copy/paste, and inverse history", () => {
		const source = stroke("source", 5);
		const snapSource = stroke("snap-source", 5);
		snapSource.points = Array.from({ length: 10 }, (_, i) => ({
			x: i * 10,
			y: 2,
			pressure: i % 2 === 0 ? 0.1 : 0.9,
			t: i * 8,
		}));
		snapSource.bbox = computeBBox(snapSource.points, snapSource.width * 2);
		const snapped = snapStroke(snapSource, true)!;
		expect(snapped.widthMode).toBe("uniform");

		let serial = 0;
		const pieces = splitStrokeByCircle(source, 45, 6, 4, () => `piece-${++serial}`);
		expect(pieces.length).toBeGreaterThan(1);
		expect(pieces.every((value) => value.widthMode === "uniform")).toBe(true);

		expect(copyInk([source], "from.md")).toBe(1);
		const pasted = pasteInk("to.md")[0]!;
		expect(pasted.widthMode).toBe("uniform");
		const add = { type: "add" as const, path: "to.md", strokes: [pasted], indices: [0] };
		const removed = invertInkOp(add);
		expect(removed.type).toBe("remove");
		if (removed.type !== "remove") throw new Error("add did not invert to remove");
		expect(removed.strokes[0]).toBe(pasted);
		expect(invertInkOp(removed)).toEqual(add);
	});

	it("uses the width policy in the committed cache key", () => {
		const value = legacyStroke("cache", "pen");
		drawStroke(fakeCtx(), CAM, value, undefined, true);
		value.widthMode = "uniform";
		drawStroke(fakeCtx(), CAM, value, undefined, true);
		expect(ribbonCacheStats()).toMatchObject({ hits: 0, misses: 2, flattens: 2 });
		drawStroke(fakeCtx(), CAM, value, undefined, true);
		expect(ribbonCacheStats().hits).toBe(1);
	});

	it.each([true, false])(
		"leaves legacy pen, mouse, and highlighter geometry unchanged with pressure=%s",
		(pressureOn) => {
			setPressureSensitivity(pressureOn);
			const pen = legacyStroke("pen", "pen");
			const mouse = legacyStroke("mouse", "pen", "mouse");
			const highlighter = legacyStroke("highlighter", "highlighter");
			const penStyle = { color: pen.color, baseWidth: pen.width, ...shapeFor(false) };
			const highlighterStyle = {
				color: highlighter.color,
				baseWidth: highlighter.width,
				...shapeFor(true),
			};
			expect(ribbonOf(pen)).toEqual(
				flattenStrokeShaped(pen.points, penStyle, EXPORT_PX_PER_WORLD)
			);
			expect(ribbonOf(mouse)).toEqual(
				flattenStroke(mouse.points, penStyle, EXPORT_PX_PER_WORLD)
			);
			expect(ribbonOf(highlighter)).toEqual(
				flattenStroke(highlighter.points, highlighterStyle, EXPORT_PX_PER_WORLD)
			);
		}
	);

	it("keeps uniform highlighter width without changing SVG or PDF layer opacity", () => {
		const value = stroke("highlighter", 18, "highlighter");
		expectUniform(
			ribbonOf(value).map((point) => point.hw),
			9
		);
		expect(HIGHLIGHTER_ALPHA).toBe(0.35);
		expect(inkSvgBody([value])).toContain(`<g opacity="${HIGHLIGHTER_ALPHA}">`);
		expect(inkPdfContent([value], 100)).toContain("q /GSa gs");
		expect(inkToPdf([value])).toContain("/ca 0.35 /CA 0.35");
	});
});
