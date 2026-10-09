import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StrokeBuilder } from "../ink/StrokeBuilder";
import { inkToSvg } from "../ink/SvgExport";

/**
 * The website demo and the release tail.
 *
 * In a note, a pen that lifts with a light, travelling ending has that ending cut off at the lift (finishReleaseFiltered). The
 * demo says it runs the plugin's own ink path, and its Export button writes the same SVG a note's export would. This feeds the
 * same samples to both and compares what each keeps. A pen contact on the demo must keep what the note keeps; a mouse or touch contact
 * keeps its whole stroke, as it does in a note.
 *
 * The demo module wires itself to the page when it loads, so the cell stubs the few globals it touches, loads it fresh, drives
 * the canvas with pointer events, and reads the SVG the Export button writes.
 */

const RECT = { left: 0, top: 0, width: 100, height: 50, right: 100, bottom: 50, x: 0, y: 0 };

/** A confident pen contact followed by light, travelling samples: the shape the note's release filter cuts at the lift. */
const SAMPLES: Array<[x: number, y: number, pressure: number, t: number]> = [
	[0, 0, 0.403, 0],
	[2, 0, 0.306, 4],
	[5, 1, 0.012, 8],
	[12, 3, 0.015, 16],
	[22, 6, 0.003, 25],
];

function fakeContext(): CanvasRenderingContext2D {
	const own: Record<string, unknown> = {};
	return new Proxy(own, {
		get(target, key) {
			if (typeof key !== "string") return undefined;
			if (key in target) return target[key];
			return () => {};
		},
		set(target, key, value) {
			target[key as string] = value;
			return true;
		},
	}) as unknown as CanvasRenderingContext2D;
}

/** Load the demo against a fake page, write SAMPLES, press Export, and return the SVG text it wrote. */
async function demoSvg(pointerType: "pen" | "mouse" | "touch" = "pen"): Promise<string> {
	const listeners = new Map<string, (ev: unknown) => void>();
	const clicks = new Map<string, () => void>();
	const canvas = {
		width: 0,
		height: 0,
		getContext: () => fakeContext(),
		getBoundingClientRect: () => RECT,
		addEventListener: (type: string, fn: (ev: unknown) => void) => void listeners.set(type, fn),
		setPointerCapture: () => {},
	};
	let written: Promise<string> | null = null;
	vi.stubGlobal("window", { devicePixelRatio: 1, requestAnimationFrame: () => 1, matchMedia: () => ({ matches: true }) });
	vi.stubGlobal("ResizeObserver", class { observe() {} });
	vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => ((written = (blob as Blob).text()), "blob:demo"));
	vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
	vi.stubGlobal("document", {
		readyState: "complete",
		querySelector: (sel: string) => {
			if (sel === "#ink-demo") return canvas;
			if (sel === "#ink-export") return { addEventListener: (_: string, fn: () => void) => void clicks.set("export", fn) };
			return null;
		},
		querySelectorAll: () => [],
		createElement: () => ({ click() {} }),
		addEventListener: () => {},
	});
	vi.resetModules();
	await import("./DemoInk");

	const fire = (type: string, x: number, y: number, pressure: number, t: number) =>
		listeners.get(type)?.({ preventDefault() {}, button: 0, pointerType, pointerId: 1, clientX: x, clientY: y, pressure, timeStamp: t });
	SAMPLES.forEach(([x, y, p, t], i) => fire(i === 0 ? "pointerdown" : "pointermove", x, y, p, 1000 + t));
	fire("pointerup", 22, 6, 0.003, 1030);
	clicks.get("export")?.();
	if (!written) throw new Error("the Export button wrote nothing");
	return await written;
}

/** The SVG the same samples give through the plain finish, as a mouse or touch stroke is built (no release filter). */
function plainFinishSvg(pointerType: "mouse" | "touch"): string {
	const b = new StrokeBuilder("pen", "#6d3fc4", 2.6, 0.15, pointerType === "mouse" ? "mouse" : undefined);
	b.start(1000);
	for (const [x, y, p, t] of SAMPLES) b.add(x, y, p, 1000 + t);
	const stroke = b.finish();
	expect(stroke, "premise: the plain finish keeps the stroke").toBeDefined();
	expect(stroke!.points.length, "premise: the plain finish keeps every sample").toBe(SAMPLES.length);
	return inkToSvg([stroke!]);
}

/** The SVG a note's own export writes for the same samples through the release-filtered finish. */
function noteSvg(): string {
	const b = new StrokeBuilder("pen", "#6d3fc4", 2.6, 0.15);
	b.start(1000);
	for (const [x, y, p, t] of SAMPLES) b.add(x, y, p, 1000 + t);
	const strokes = b.finishReleaseFiltered();
	expect(strokes, "premise: the note keeps one stroke").toHaveLength(1);
	// The tail is gone in the note: its last kept sample is the second one.
	expect(strokes[0]!.points.length, "premise: the note cut the light travelling ending").toBeLessThan(SAMPLES.length);
	return inkToSvg(strokes);
}

beforeEach(() => {
	vi.unstubAllGlobals();
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("the demo's finished stroke against the note's release-filtered one", () => {
	it("the harness holds: the demo writes an SVG for the stroke", async () => {
		const svg = await demoSvg();
		expect(svg.length).toBeGreaterThan(0);
		expect(svg).toContain("<svg");
	});

	for (const pointerType of ["mouse", "touch"] as const) {
		it(`a ${pointerType} stroke on the demo keeps its light travelling ending, as a ${pointerType} stroke does in a note`, async () => {
			const kept = plainFinishSvg(pointerType);
			const demo = await demoSvg(pointerType);
			expect(demo, `the demo cut a ${pointerType} stroke's ending`).toBe(kept);
			expect(demo, "premise: the filtered and the plain stroke differ").not.toBe(noteSvg());
		});
	}

	it("a pen stroke on the demo is the note's, the light travelling ending cut off", async () => {
		const note = noteSvg();
		const demo = await demoSvg();
		expect(note).toContain("<svg");
		expect(demo, "the demo kept the release tail the note removes (note export 36.4 wide, demo 56.4 wide)").toBe(note);
	});
});
