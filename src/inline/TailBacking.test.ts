import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import type { CameraState } from "../camera/coordinates";
import type { PenSample } from "../input/PointerRouter";
import { DEFAULT_PEN } from "../ink/PenStyle";
import { TailRenderer } from "../ink/TailRenderer";

type Head = {
	cam: CameraState;
	style: typeof DEFAULT_PEN;
	from: { x: number; y: number };
	to: { x: number; y: number };
	pressure: number;
	hwWorld: number;
};
type Prediction = { fromX: number; fromY: number; points: readonly PenSample[]; lineWidthPx: number };
type CompactTail = TailRenderer & {
	configureInlineBacking?: (width: number, height: number, backing: number, cssScale: number, hostZoom: boolean) => void;
	prepareLive?: (head: Head | null, prediction: Prediction | null) => void;
};

/** `translate`: whether the page's CSS.supports answers yes for the translate property; "missing" = no CSS.supports. */
function rig(translate: boolean | "missing" = true) {
	const writes: string[] = [];
	const styleWrites: string[] = [];
	const style = new Proxy({ left: "0px", top: "0px", right: "auto", bottom: "auto", translate: "none", width: "1000px", height: "600px", transform: "" } as Record<string, string>, {
		set(target, key, value) { styleWrites.push(String(key)); target[String(key)] = value; return true; },
	}) as { left: string; top: string; right: string; bottom: string; translate: string; width: string; height: string; transform: string };
	const CSS = translate === "missing" ? {} : { supports: (property: string, value: string) => translate && property === "translate" && value === "1px 1px" };
	const ctx = new Proxy({} as CanvasRenderingContext2D, {
		get(_target, key) {
			if (key === "getContextAttributes") return () => ({ desynchronized: false });
			return () => undefined;
		},
		set() { return true; },
	});
	let width = 2000, height = 1200;
	const canvas = {
		get width() { return width; }, set width(value: number) { width = value; writes.push(`w${value}`); },
		get height() { return height; }, set height(value: number) { height = value; writes.push(`h${value}`); },
		style,
		ownerDocument: { defaultView: { CSS } },
		getContext: () => ctx,
	} as unknown as HTMLCanvasElement;
	const tail = new TailRenderer(canvas) as CompactTail;
	tail.applyDpr(2);
	tail.configureInlineBacking?.(1000, 600, 2, 1, false);
	return { canvas, tail, style, writes, styleWrites };
}

const head: Head = {
	cam: { x: 0, y: 0, zoom: 1 }, style: DEFAULT_PEN,
	from: { x: 50, y: 50 }, to: { x: 64, y: 62 }, pressure: 0.7, hwWorld: 4,
};
const prediction: Prediction = {
	fromX: 64, fromY: 62, lineWidthPx: 8,
	points: [{ x: 120, y: 80, pressure: 0.7, timestamp: 1 } as PenSample],
};

describe("inline tail backing policy", () => {
	it("counts one resize only when either backing dimension changes", () => {
		const { canvas, tail, writes } = rig();
		const measured = tail as TailRenderer & { readonly resizeTotal: number };
		expect(writes.slice(-2), "configure sized the compact backing").toEqual([`w${canvas.width}`, `h${canvas.height}`]);
		const initial = measured.resizeTotal;
		tail.prepareLive?.(head, prediction);
		expect(measured.resizeTotal - initial, "a live head resized the configured backing").toBe(0);
		tail.prepareLive?.(null, null);
		tail.prepareLive?.(null, null);
		expect(measured.resizeTotal - initial, "an empty backing resized").toBe(0);
		const resize = tail as unknown as {
			resizeBacking(width: number, height: number, x: number, y: number, mode: "compact"): void;
		};
		writes.length = 0;
		resize.resizeBacking(32, canvas.height, 0, 0, "compact");
		expect(writes).toEqual(["w32"]);
		expect(measured.resizeTotal - initial, "width alone is one resize").toBe(1);
		writes.length = 0;
		resize.resizeBacking(32, 48, 0, 0, "compact");
		expect(writes).toEqual(["h48"]);
		expect(measured.resizeTotal - initial, "height alone is one resize").toBe(2);
	});

	it("places compact origin with translate before the box transform", () => {
		const { tail, style } = rig();
		tail.configureInlineBacking?.(1000, 600, 2, 0.3, false);
		style.left = "23px"; style.top = "31px";
		style.right = "9px"; style.bottom = "11px";
		// Far enough from the band's corner that the centred tile has a
		// non-zero origin: envelope 394..476 x 294..336 css px, grid 10.
		tail.prepareLive?.({ ...head, from: { x: 400, y: 300 }, to: { x: 414, y: 312 } },
			{ ...prediction, fromX: 414, fromY: 312, points: [{ x: 470, y: 330, pressure: 0.7, timestamp: 1 } as PenSample] });
		expect(style.left).toBe("0px");
		expect(style.top).toBe("0px");
		expect(style.right).toBe("auto");
		expect(style.bottom).toBe("auto");
		expect(style.translate).toBe("305px 185px");
		expect(style.transform).toBe("scale(3.3333333333333335)");
	});
	it("allocates a real compact bitmap for the current head and prediction together", () => {
		const { canvas, tail, style } = rig();
		expect(prediction.points[0]!.x).toBeGreaterThan(head.to.x + 40);
		tail.prepareLive?.(head, prediction);
		expect(canvas.width, "compact live geometry still has the full backing width").toBeLessThan(2000);
		expect(canvas.height, "compact live geometry still has the full backing height").toBeLessThan(1200);
		const [left = NaN, top = NaN] = style.translate === "none" ? [0, 0] : style.translate.split(" ").map(parseFloat);
		expect(left).toBeGreaterThanOrEqual(0);
		expect(top).toBeGreaterThanOrEqual(0);
		expect(left).toBeLessThanOrEqual(44);
		expect(top).toBeLessThanOrEqual(44);
		expect(left + canvas.width / 2).toBeGreaterThanOrEqual(126);
		expect(top + canvas.height / 2).toBeGreaterThanOrEqual(86);
	});

	it("retains a fitting allocation and clears it on a missing envelope", () => {
		const { canvas, tail, style, writes } = rig();
		tail.prepareLive?.(head, prediction);
		const first = { width: canvas.width, height: canvas.height, left: style.left, top: style.top };
		writes.length = 0;
		tail.prepareLive?.({ ...head, from: { x: 54, y: 54 }, to: { x: 65, y: 63 } }, null);
		expect(writes, "a fitting envelope needlessly resized the bitmap").toEqual([]);
		expect({ width: canvas.width, height: canvas.height, left: style.left, top: style.top }).toEqual(first);
		writes.length = 0;
		tail.prepareLive?.(null, null);
		expect(writes, "releasing the envelope reallocated the bitmap").toEqual([]);
		expect({ width: canvas.width, height: canvas.height }).toEqual({ width: first.width, height: first.height });
		expect(style.left).toBe("0px");
		expect(style.top).toBe("0px");
	});

	it("uses the full backing when no joint grid fits the 64-pixel cap", () => {
		const { canvas, tail, style } = rig();
		tail.configureInlineBacking?.(1000, 600, Math.PI, 0.3, false);
		tail.prepareLive?.(head, prediction);
		expect(canvas.width).toBe(Math.round(1000 * Math.PI));
		expect(canvas.height).toBe(Math.round(600 * Math.PI));
		expect(style.left).toBe("0px");
		expect(style.top).toBe("0px");
	});

	it("puts the low-zoom tile on the joint grid around the envelope", () => {
		const { canvas, tail, style } = rig();
		const backing = 1.25, grid = 50;
		tail.configureInlineBacking?.(1000, 600, backing, 0.3, false);
		tail.prepareLive?.(head, prediction);
		const [originX = NaN, originY = NaN] = style.translate === "none" ? [0, 0] : style.translate.split(" ").map(parseFloat);
		const x0 = originX * backing;
		const y0 = originY * backing;
		const x1 = x0 + canvas.width, y1 = y0 + canvas.height;
		const envelope = { left: 44, top: 44, right: 126, bottom: 86 };
		const axes: [number, number, number, number][] = [
			[x0, x1, envelope.left, envelope.right],
			[y0, y1, envelope.top, envelope.bottom],
		];
		for (const [start, end, low, high] of axes) {
			const integerLow = Math.floor(low * backing), integerHigh = Math.ceil(high * backing);
			expect(start).toBeGreaterThanOrEqual(0);
			expect(start).toBeLessThanOrEqual(integerLow);
			expect(end).toBeGreaterThanOrEqual(integerHigh);
			expect(start / grid).toBeCloseTo(Math.round(start / grid), 9);
			expect(end / grid).toBeCloseTo(Math.round(end / grid), 9);
		}
		expect(parseFloat(style.width) * 64).toBeCloseTo(Math.round(parseFloat(style.width) * 64), 9);
		expect(parseFloat(style.height) * 64).toBeCloseTo(Math.round(parseFloat(style.height) * 64), 9);
	});

	it("sizes the compact backing once, outside the stroke, and only moves it during one", () => {
		const { canvas, tail, style, writes } = rig();
		const measured = tail as TailRenderer & { readonly resizeTotal: number };
		expect(canvas.width, "configure left no compact backing to move").toBeGreaterThan(0);
		expect(canvas.height, "configure left no compact backing to move").toBeGreaterThan(0);
		expect(canvas.width * canvas.height).toBeLessThan(2000 * 1200);
		const size = { width: canvas.width, height: canvas.height };
		const initial = measured.resizeTotal;
		writes.length = 0;
		const translations: string[] = [];
		for (let i = 0; i < 40; i++) {
			const x = 50 + i * 20, y = 50 + i * 11;
			tail.prepareLive?.({ ...head, from: { x, y }, to: { x: x + 14, y: y + 12 } },
				{ ...prediction, fromX: x + 14, fromY: y + 12, points: [{ x: x + 30, y: y + 20, pressure: 0.7, timestamp: 1 } as PenSample] });
			translations.push(style.translate);
			const [left = 0, top = 0] = style.translate === "none" ? [0, 0] : style.translate.split(" ").map(parseFloat);
			expect(left * 2, `event ${i}: head left of the tile`).toBeLessThanOrEqual(Math.floor((x - 6) * 2));
			expect(top * 2, `event ${i}: head above the tile`).toBeLessThanOrEqual(Math.floor((y - 6) * 2));
			expect(left * 2 + canvas.width, `event ${i}: prediction right of the tile`).toBeGreaterThanOrEqual(Math.ceil((x + 36) * 2));
			expect(top * 2 + canvas.height, `event ${i}: prediction below the tile`).toBeGreaterThanOrEqual(Math.ceil((y + 26) * 2));
		}
		tail.prepareLive?.(null, null);
		expect(writes, "a live event or the release wrote a backing dimension").toEqual([]);
		expect(measured.resizeTotal - initial).toBe(0);
		expect({ width: canvas.width, height: canvas.height }).toEqual(size);
		expect(new Set(translations).size, "the tile never moved with the head").toBeGreaterThan(1);
	});

	it("clears an empty backing instead of zero-sizing it, and leaves visibility to the pinch", () => {
		const { canvas, tail, style } = rig();
		const visibility = () => (style as { visibility?: string }).visibility;
		expect(visibility(), "configure wrote visibility").toBeUndefined();
		tail.prepareLive?.(head, prediction);
		expect(visibility(), "a live head wrote visibility").toBeUndefined();
		tail.prepareLive?.(null, null);
		expect(canvas.width).toBeGreaterThan(0);
		expect(canvas.height).toBeGreaterThan(0);
		expect(visibility(), "a release wrote visibility").toBeUndefined();
		expect(tail.provenBlank, "a released tail is not known blank").toBe(true);
	});

	// Landing cells. The fallback counter counts switches from a tile to the
	// full surface; a stroke that fits must never make one.
	type Counted = { readonly fullFallbackTotal?: number };
	const fallbacks = (tail: TailRenderer) => {
		const n = (tail as TailRenderer & Counted).fullFallbackTotal;
		expect(n, "the tail counts its full-surface fallbacks").toBeTypeOf("number");
		return n!;
	};

	it("keeps a fast predicted stroke inside the tile: envelope measured, no fallback", () => {
		const { canvas, tail, writes } = rig();
		const tile = { width: canvas.width, height: canvas.height };
		const before = fallbacks(tail);
		writes.length = 0;
		// Fast: 20 css px between events (about 5 px per ms at 4 ms events), a
		// wide nib (radius 6 at zoom 2 = 12 px) and three predicted points out to
		// the 24 px distance cap. The device measured tips up to 9.84 px.
		const cam = { x: 0, y: 0, zoom: 2 };
		let maxW = 0, maxH = 0;
		for (let i = 0; i < 40; i++) {
			const x = 30 + i * 10, y = 30 + i * 5;  // world; x2 on screen: 20 px, 10 px per event
			const sx = x * 2, sy = y * 2;
			const points = [1, 2, 3].map(k => ({ x: sx + 20 + k * 8 * 0.894, y: sy + 10 + k * 8 * 0.447, pressure: 0.7, timestamp: k } as PenSample));
			tail.prepareLive?.({ ...head, cam, from: { x, y }, to: { x: x + 10, y: y + 5 }, hwWorld: 6 },
				{ fromX: sx + 20, fromY: sy + 10, lineWidthPx: 24, points });
			// The envelope in backing px, the renderer's own padding rule: radius
			// plus max(2, 2 / backing) around every covered point.
			const xs = [sx, sx + 20, ...points.map(p => p.x)], ys = [sy, sy + 10, ...points.map(p => p.y)];
			const pad = 12 + 2;
			maxW = Math.max(maxW, Math.ceil((Math.max(...xs) + pad) * 2) - Math.floor((Math.min(...xs) - pad) * 2));
			maxH = Math.max(maxH, Math.ceil((Math.max(...ys) + pad) * 2) - Math.floor((Math.min(...ys) - pad) * 2));
		}
		tail.prepareLive?.(null, null);
		const envelopeOut = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.HW_TAIL_ENVELOPE_OUT;
		if (envelopeOut) writeFileSync(envelopeOut, JSON.stringify({ envelope: { width: maxW, height: maxH }, tile, events: 40 }));
		expect(maxW, "measured envelope width").toBeLessThan(tile.width);
		expect(maxH, "measured envelope height").toBeLessThan(tile.height);
		expect(fallbacks(tail) - before, "a fitting fast stroke fell back to the full surface").toBe(0);
		expect(writes, "a fitting fast stroke wrote a size").toEqual([]);
	});

	it("counts exactly one fallback for an envelope larger than the tile, then stays full", () => {
		const { canvas, tail } = rig();
		const tileW = canvas.width;
		const before = fallbacks(tail);
		tail.prepareLive?.(head, prediction);
		expect(fallbacks(tail) - before).toBe(0);
		// A jump wider than the tile (256 css px): the head spans 300 px.
		tail.prepareLive?.({ ...head, from: { x: 100, y: 100 }, to: { x: 400, y: 120 } }, null);
		expect(canvas.width, "the oversized envelope did not take the full surface").toBe(2000);
		expect(fallbacks(tail) - before, "one oversized envelope, one fallback").toBe(1);
		tail.prepareLive?.({ ...head, from: { x: 100, y: 100 }, to: { x: 420, y: 130 } }, null);
		expect(fallbacks(tail) - before, "staying full is not a second fallback").toBe(1);
		tail.prepareLive?.(null, null);
		expect(canvas.width, "the release returns the tile").toBe(tileW);
	});

	it("carries a compact tile off the joint grid without reallocating", () => {
		const { canvas, tail, writes } = rig();
		// Backing 1.5 at CSS scale 1 has joint grid 3: a 1 css px carry is 2
		// backing px, off the grid.
		tail.configureInlineBacking?.(1000, 600, 1.5, 1, false);
		tail.prepareLive?.({ ...head, from: { x: 400, y: 300 }, to: { x: 414, y: 312 } }, null);
		const size = { width: canvas.width, height: canvas.height };
		expect(size.width * size.height).toBeLessThan(1500 * 900);
		writes.length = 0;
		tail.carry(1, 0);
		tail.carry(0, -1);
		expect(writes, "an off-grid carry reallocated the tile").toEqual([]);
		expect({ width: canvas.width, height: canvas.height }).toEqual(size);
	});

	it("keeps a full-surface tail full for the rest of the stroke", () => {
		const { canvas, tail, writes } = rig();
		tail.prepareLive?.({ ...head, from: { x: 100, y: 100 }, to: { x: 400, y: 120 } }, null);
		expect(canvas.width, "the oversized envelope did not take the full surface").toBe(2000);
		writes.length = 0;
		for (let i = 0; i < 10; i++) tail.prepareLive?.({ ...head, from: { x: 400 + i, y: 120 }, to: { x: 404 + i, y: 122 } }, null);
		expect(writes, "a full tail shrank mid-stroke").toEqual([]);
		expect(canvas.width).toBe(2000);
	});

	// Landing guard: the compact tile is placed with the CSS translate
	// property, which an old WebView ignores. Without it the tail keeps the
	// full surface and never writes translate.
	for (const support of [false, "missing"] as const) {
		it(`without CSS translate support (${support === false ? "supports says no" : "no CSS.supports"}), the tail is the full band and writes no translate`, () => {
			const { canvas, tail, writes, styleWrites } = rig(support);
			expect({ width: canvas.width, height: canvas.height }, "no translate: the tail is the full band").toEqual({ width: 2000, height: 1200 });
			writes.length = 0;
			for (let i = 0; i < 25; i++) {
				const x = 50 + i * 20, y = 50 + i * 11;
				tail.prepareLive?.({ ...head, from: { x, y }, to: { x: x + 14, y: y + 12 } },
					{ ...prediction, fromX: x + 14, fromY: y + 12, points: [{ x: x + 30, y: y + 20, pressure: 0.7, timestamp: 1 } as PenSample] });
			}
			tail.prepareLive?.(null, null);
			expect(writes, "no translate: a stroke wrote a size").toEqual([]);
			expect(styleWrites.filter(k => k === "translate"), "no translate: the tail wrote the translate property").toEqual([]);
		});
	}

	it("with CSS translate support, the tail is the tile", () => {
		const { canvas } = rig(true);
		expect(canvas.width * canvas.height, "translate supported: the tail is a tile").toBeLessThan(2000 * 1200);
	});
});
