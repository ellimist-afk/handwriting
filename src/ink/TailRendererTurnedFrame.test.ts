/**
 * THE SELECTION FRAME TURNS WITH THE INK (Alan, 10-28: "it doesnt even move").
 *
 * During a resize or a turn the tail draws the dashed frame as the grab's padded box under the step the preview shows: a
 * polygon through its four turned corners, with the corner squares and the knob at their turned places. With no step it
 * draws the axis-aligned rectangle as before.
 */
import { describe, expect, it } from "vitest";
import { TailRenderer } from "./TailRenderer";
import { framePoints, handlePoints, transformPoint } from "../inline/LassoTransform";

type Call = [string, ...number[]];

function recordingCanvas(): { canvas: HTMLCanvasElement; calls: Call[] } {
	const calls: Call[] = [];
	const ctx = new Proxy(
		{},
		{
			get(_t, prop) {
				if (prop === "getContextAttributes") return () => ({ desynchronized: false });
				if (typeof prop !== "string") return undefined;
				return (...a: unknown[]) => void calls.push([prop, ...a.filter((v): v is number => typeof v === "number")]);
			},
			set() {
				return true;
			},
		}
	);
	return { canvas: { getContext: () => ctx } as unknown as HTMLCanvasElement, calls };
}

const cam = { x: 40, y: 150, zoom: 2 };
const BOX = { x: 100, y: 200, width: 80, height: 40 };
const screen = (p: { x: number; y: number }) => [(p.x - cam.x) * cam.zoom, (p.y - cam.y) * cam.zoom];

describe("the tail's selection frame during a turn", () => {
	it("strokes the turned frame and puts the knob at its turned place", () => {
		const t = { pivot: { x: 140, y: 220 }, scale: 1, angle: Math.PI / 2 };
		const { canvas, calls } = recordingCanvas();
		const tail = new TailRenderer(canvas);
		calls.length = 0;
		(tail.drawSelectionBox as (...a: unknown[]) => void)(cam, BOX, "#1e6ec8", true, t);
		expect(calls.some(([name]) => name === "strokeRect"), "an axis-aligned rectangle was drawn").toBe(false);
		const path = calls.filter(([name]) => name === "moveTo" || name === "lineTo").slice(0, 4).map(([, x, y]) => [x, y]);
		const corners = framePoints(BOX, t, cam.zoom).corners.map(screen);
		expect(path).toHaveLength(4);
		path.forEach((p, i) => {
			expect(p[0], `frame corner ${i} x`).toBeCloseTo(corners[i]![0]!, 6);
			expect(p[1], `frame corner ${i} y`).toBeCloseTo(corners[i]![1]!, 6);
		});
		const arc = calls.find(([name]) => name === "arc");
		const knob = screen(transformPoint(handlePoints(BOX, cam.zoom).rotate, t));
		expect(arc?.[1], "knob x").toBeCloseTo(knob[0]!, 6);
		expect(arc?.[2], "knob y").toBeCloseTo(knob[1]!, 6);
	});

	it("with no step draws the rectangle and the knob over its top, as before", () => {
		const { canvas, calls } = recordingCanvas();
		const tail = new TailRenderer(canvas);
		calls.length = 0;
		tail.drawSelectionBox(cam, BOX, "#1e6ec8", true);
		const rect = calls.find(([name]) => name === "strokeRect");
		expect(rect?.slice(1)).toEqual([(BOX.x - cam.x) * cam.zoom - 6, (BOX.y - cam.y) * cam.zoom - 6, BOX.width * cam.zoom + 12, BOX.height * cam.zoom + 12]);
		const arc = calls.find(([name]) => name === "arc");
		expect(arc?.slice(1, 3)).toEqual(screen(handlePoints(BOX, cam.zoom).rotate));
	});
});
