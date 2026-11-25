/**
 * AN INSERT SPACE DRAG ON A BIG DESKTOP CANVAS SHOWS ALL OF ITS MOVING INK.
 *
 * During an insert space drag the committed layers paint the note without the moving strokes; only the tail shows them,
 * as one picture made at pen-down (drawSpacePicture, rasterSpacePicture). The picture's window was capped at 10M device
 * px, counted as rows of the tail's width. A desktop ink canvas can hold more than that (a 4K pane, or an ordinary pane
 * zoomed in, up to the 16M desktop budget), and then the rows the tail shows did not fit the window: a strip of moving
 * ink at the bottom stayed blank until the release, and the picture was made again on every frame.
 *
 * Bound: every row of moving ink the tail shows is drawn; the picture is made once across frames that need no new rows;
 * no picture holds more pixels than the tail canvas (or 10M, for a canvas under that).
 *
 * Cost is counted, not timed: picture builds (rasterSpacePicture) and tail draws (drawImage) per frame. The real methods
 * run on a bare overlay with recording canvases; no moving stroke is drawn, so the counts are the window's alone.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { InkOverlayPlugin } from "./InkOverlay";
import { backingScale, MAX_BACKING_AREA } from "./ZoomScale";
import { computeCanvasSize } from "../diag/Raster";

type Draw = { sy: number; sh: number; dy: number; dh: number };

interface FakeCanvas {
	width: number;
	height: number;
	draws: Draw[];
	getContext(kind: string): unknown;
	cloneNode(deep: boolean): FakeCanvas;
}

function canvas(width: number, height: number): FakeCanvas {
	const c: FakeCanvas = {
		width,
		height,
		draws: [],
		getContext: () => ctx,
		cloneNode: () => canvas(0, 0),
	};
	const noop = (): void => {};
	const ctx = {
		save: noop, restore: noop, setTransform: noop, beginPath: noop, rect: noop, clip: noop, clearRect: noop, fillRect: noop,
		globalAlpha: 1, globalCompositeOperation: "source-over", fillStyle: "",
		drawImage: (_src: unknown, _sx: number, sy: number, _sw: number, sh: number, _dx: number, dy: number, _dw: number, dh: number) => {
			c.draws.push({ sy, sh, dy, dh });
		},
	};
	return c;
}

type Method = (this: unknown, ...a: unknown[]) => void;
const proto = InkOverlayPlugin.prototype as unknown as { drawSpacePicture: Method; rasterSpacePicture: Method };

/** The blue stroke's pad drawSpacePicture adds above and below the box at backing 1, scale 1. */
const PAD = 6;

interface Rig {
	o: Record<string, unknown>;
	tail: FakeCanvas;
	snap: Record<string, unknown>;
	builds: number;
	/** One drag frame at this offset (device rows, negative = up): the picture drawn on the tail. */
	frame(shift: number): Draw[];
	/** The tail rows of moving ink the frame must show at this offset. */
	want(shift: number): [number, number];
}

/** A tail of `w` x `h` device px at backing 1, zoom 1; the insert space's moving box from css row `lineY` to `lineY + boxH`. */
function rig(w: number, h: number, lineY: number, boxH: number): Rig {
	const tail = canvas(w, h);
	const snap: Record<string, unknown> = {
		kind: "space", col: 0, moving: [], box: { x: 0, y: lineY, width: w, height: boxH }, canvas: null, tailCtx: null,
		top: 0, lo: 0, done: 0, bottom: 0, at: { x: 0, y: 0, zoom: 1 }, x: NaN, y: NaN, zoom: NaN, backing: NaN, w: 0, h: 0,
	};
	const o = Object.create(InkOverlayPlugin.prototype) as Record<string, unknown>;
	const r: Rig = {
		o, tail, snap, builds: 0,
		frame(shift) {
			o.spaceTotalDy = shift;
			const n = tail.draws.length;
			proto.drawSpacePicture.call(o, snap, { x: 0, y: 0, zoom: 1 });
			return tail.draws.slice(n);
		},
		want(shift) {
			return [Math.max(lineY - PAD + shift, 0), Math.min(lineY + boxH + PAD + shift, h)];
		},
	};
	Object.assign(o, {
		tailCanvas: tail,
		committedBacking: 1,
		dpr: 1,
		cssScale: 1,
		spaceTotalDy: 0,
		spacePictureReach: 1,
		committedCanvas: { height: h, getBoundingClientRect: () => ({ top: 0, height: h, bottom: h, left: 0, right: w, width: w }) },
		view: { scrollDOM: { getBoundingClientRect: () => ({ top: 0, height: h, bottom: h, left: 0, right: w, width: w }) } },
		rasterSpacePicture(...a: unknown[]): void {
			r.builds++;
			proto.rasterSpacePicture.apply(this, a);
		},
	});
	return r;
}

/** Each frame's draws as tail rows [from, to); a frame's moving ink is one copy. */
function shown(draws: Draw[]): [number, number][] {
	return draws.map((d) => [d.dy, d.dy + d.dh]);
}

function pictureArea(r: Rig): number {
	const pic = r.snap.canvas as FakeCanvas | null;
	return pic ? pic.width * pic.height : 0;
}

/** The find's figure, and an ordinary pane zoomed in: 1600 x 1100 css px at dpr 1, 300%, on the desktop budget. */
const FIND = { w: 4800, h: 3000 };
const ordinary = computeCanvasSize(1600, 1100, backingScale(1, 3, 1600, 1100, false));
const ORDINARY = { w: ordinary.backingW, h: ordinary.backingH };
/** The same pane at 200%: under 10M, the window as before. */
const small = computeCanvasSize(1600, 1100, backingScale(1, 2, 1600, 1100, false));
const SMALL = { w: small.backingW, h: small.backingH };

beforeEach(() => {
	// The figures the cells stand on: two canvases over 10M, one under.
	expect(FIND.w * FIND.h).toBeGreaterThan(MAX_BACKING_AREA);
	expect(ORDINARY.w * ORDINARY.h, "precondition: the ordinary zoomed pane is over 10M").toBeGreaterThan(MAX_BACKING_AREA);
	expect(SMALL.w * SMALL.h, "precondition: the 200% pane is under 10M").toBeLessThan(MAX_BACKING_AREA);
});

describe("insert space on a desktop canvas over 10M px", () => {
	for (const [name, size] of [["k1 4800 x 3000", FIND], [`k2 ordinary pane at 300% (${ORDINARY.w} x ${ORDINARY.h})`, ORDINARY]] as const) {
		it(`${name}, ink over every row, held 300 rows up: every row drawn, one picture across two frames`, () => {
			const r = rig(size.w, size.h, -100, size.h + 1000);
			const want = r.want(-300);
			expect(want, "precondition: the moving ink covers the whole tail").toEqual([0, size.h]);
			expect(shown(r.frame(-300)), "frame 1 draws every row the tail shows").toEqual([want]);
			expect(shown(r.frame(-300)), "frame 2 draws every row the tail shows").toEqual([want]);
			expect(r.builds, "one picture across both frames").toBe(1);
			expect(pictureArea(r), "the picture holds no more pixels than the tail").toBeLessThanOrEqual(size.w * size.h);
		});

		it(`${name}, line at row 600, dragged up 300 rows in 10 frames: every row drawn each frame, one picture`, () => {
			const r = rig(size.w, size.h, 600, size.h + 1000);
			for (let i = 0; i <= 10; i++) {
				const shift = -30 * i;
				expect(shown(r.frame(shift)), `frame at ${shift} draws every row the tail shows`).toEqual([r.want(shift)]);
			}
			expect(r.builds, "one picture for the whole drag").toBe(1);
			expect(pictureArea(r), "the picture holds no more pixels than the tail").toBeLessThanOrEqual(size.w * size.h);
		});
	}
});

describe("control: a canvas under 10M keeps its window", () => {
	it(`k3 the same pane at 200% (${SMALL.w} x ${SMALL.h}), line at row 600, dragged up 300 rows: every row, one picture, picture within 10M`, () => {
		const r = rig(SMALL.w, SMALL.h, 600, SMALL.h + 1000);
		for (let i = 0; i <= 10; i++) {
			const shift = -30 * i;
			expect(shown(r.frame(shift)), `frame at ${shift} draws every row the tail shows`).toEqual([r.want(shift)]);
		}
		expect(r.builds, "one picture for the whole drag").toBe(1);
		expect(pictureArea(r), "the picture stays within 10M").toBeLessThanOrEqual(MAX_BACKING_AREA);
	});
});
