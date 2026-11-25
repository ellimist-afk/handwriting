/**
 * A live highlighter's tip on a PDF page is cut out of the strip's end disc only where the pair wears the wash itself,
 * and that is read from the wash dressWet last put on, never from the page's answer at cut time.
 *
 * Where highlights have a layer of their own, the live pair sits at full opacity inside the page's highlight group,
 * which carries the wash once; a cut there leaves a seam lighter than the trail. The page's dark answer can change
 * mid-stroke with nothing dressing the pair again (a theme flip read before its repaint lands), so an answer read at
 * cut time can disagree with what the pair actually wears.
 *
 * Driven through the controller's own dressWet, undressWet and drawHead on a pair whose canvases keep the opacity they
 * are given, and whose tail records what is asked of it. The pixels are test/render/PdfPlainWashHeadDot.test.ts.
 *
 * The plain-answer cells drive the page's answer by hand: the controller's own answer is layered on every PDF page, so a
 * plain page is not reached through it today. The last cell keeps the controller's own answer.
 */
import { describe, expect, it } from "vitest";
import { PdfInkController } from "./PdfInkController";
import { HIGHLIGHTER_ALPHA, HIGHLIGHTER_PEN } from "../ink/PenStyle";
import type { CameraState } from "../camera/coordinates";

type Style = { opacity: string };
const canvas = () => {
	const style: Style = { opacity: "" };
	return { style, setCssProps: (p: Partial<Style>) => void Object.assign(style, p) };
};

/** A pair at rest; the tail logs every call. The strip's end and the head are fixed: a strip is painted. */
function pairOf() {
	const calls: string[] = [];
	const end = { x: 100, y: 50, hw: 6 };
	return {
		calls,
		wetCanvas: canvas(),
		headCanvas: canvas(),
		wet: {
			head: () => ({ from: { x: 100, y: 50 }, to: { x: 110, y: 50 }, pressure: 0.5 }),
			liveHalfWidth: () => 6,
			stripEnd: () => end,
		},
		tail: {
			clear: () => void calls.push("clear"),
			drawHead: () => void calls.push("drawHead"),
			cutDisc: () => void calls.push("cutDisc"),
		},
	};
}
type Pair = ReturnType<typeof pairOf>;

type Rig = {
	pair: Pair | null;
	wetHostPage: number;
	overlays: Map<number, unknown>;
	wetHighlighter: boolean;
	strokeStyle: unknown;
	highlightLayered(page: number): boolean;
	dressWet(attached: undefined): void;
	undressWet(attached: undefined): void;
	drawHead(pair: Pair, cam: CameraState): void;
};

const cam = { x: 0, y: 0, zoom: 1 } as unknown as CameraState;

/** A controller with only what dressWet and drawHead read, its page's answer under the test's hand. */
function rig(tool: "highlighter" | "pen", layered: boolean) {
	const answer = { layered };
	const c = Object.create(PdfInkController.prototype) as Rig;
	const pair = pairOf();
	Object.assign(c, {
		pair,
		wetHostPage: 1,
		overlays: new Map(),
		wetHighlighter: tool === "highlighter",
		strokeStyle: HIGHLIGHTER_PEN,
		highlightLayered: () => answer.layered,
	});
	return { c, pair, answer };
}

const cuts = (p: Pair) => p.calls.filter((k) => k === "cutDisc").length;

describe("the PDF tip cut is gated on the wash dressWet put on", () => {
	it("a plain page: dressWet washes the pair, and the held tip is cut out of the strip's end disc", () => {
		const { c, pair } = rig("highlighter", false);
		c.dressWet(undefined);
		expect(pair.headCanvas.style.opacity, "premise: the head canvas wears the wash").toBe(String(HIGHLIGHTER_ALPHA));
		c.drawHead(pair, cam);
		expect(pair.calls, "the tip drawn, then cut").toEqual(["clear", "drawHead", "cutDisc"]);
	});

	it("a layered page whose dark answer flips to plain mid-stroke, no dressWet: no cut", () => {
		const { c, pair, answer } = rig("highlighter", true);
		c.dressWet(undefined);
		expect(pair.headCanvas.style.opacity, "premise: the pair sits at full opacity (the group washes)").toBe("1");
		answer.layered = false;
		c.drawHead(pair, cam);
		expect(cuts(pair), "a cut inside the group, where the pair is not washed").toBe(0);
	});

	it("a plain page whose answer flips to layered mid-stroke, no dressWet: the cut stays, the pair still wears the wash", () => {
		const { c, pair, answer } = rig("highlighter", false);
		c.dressWet(undefined);
		answer.layered = true;
		c.drawHead(pair, cam);
		expect(cuts(pair), "no cut on a pair that still wears the wash").toBe(1);
	});

	it("a pen: dressWet leaves the pair unwashed, no cut", () => {
		const { c, pair } = rig("pen", false);
		c.dressWet(undefined);
		c.drawHead(pair, cam);
		expect(cuts(pair)).toBe(0);
	});

	it("after undressWet, no cut", () => {
		const { c, pair } = rig("highlighter", false);
		c.dressWet(undefined);
		c.undressWet(undefined);
		c.drawHead(pair, cam);
		expect(cuts(pair)).toBe(0);
	});

	it("a pair dressWet never washed (a new pair after the wash): no cut", () => {
		const { c, pair } = rig("highlighter", false);
		c.dressWet(undefined);
		const other = pairOf();
		c.pair = other;
		c.drawHead(other, cam);
		expect(cuts(other)).toBe(0);
		expect(cuts(pair)).toBe(0);
	});

	it("the controller's own answer, layered on every page: a highlighter's pair stays at full opacity, its tip never cut", () => {
		for (const page of [1, 2, 9]) {
			const c = Object.create(PdfInkController.prototype) as Rig;
			const pair = pairOf();
			Object.assign(c, {
				pair,
				wetHostPage: page,
				overlays: new Map(),
				wetHighlighter: true,
				strokeStyle: HIGHLIGHTER_PEN,
			});
			expect(c.highlightLayered(page), `premise: page ${page} is layered`).toBe(true);
			c.dressWet(undefined);
			expect(pair.wetCanvas.style.opacity, `page ${page}: the wet canvas`).toBe("1");
			expect(pair.headCanvas.style.opacity, `page ${page}: the head canvas`).toBe("1");
			for (let i = 0; i < 3; i++) c.drawHead(pair, cam);
			expect(pair.calls, `page ${page}: the tip drawn, never cut`).toEqual([
				"clear",
				"drawHead",
				"clear",
				"drawHead",
				"clear",
				"drawHead",
			]);
		}
	});
});
