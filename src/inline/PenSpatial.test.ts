/**
 * End-to-end spatial fidelity of the inline pen path.
 *
 * The existing tests prove the smoother's head invariant and ZoomScale's
 * algebra in isolation. Neither proves the COMPOSITION is exact, which is what
 * "the ink is not glued to the nib" would show up as. This wires the real
 * production classes together in the same order InkOverlay does —
 *
 *   clientX  ->  visualToNote  ->  Camera.screenToWorld  ->  StrokeBuilder
 *            ->  IncrementalSmoother.head()  ->  Camera.worldToScreen
 *            ->  noteToVisual  ->  clientX
 *
 * — and asserts the round-trip is exact and the drawn endpoint tracks the
 * newest accepted sample. No DOM, no canvas: pure coordinate truth.
 */

import { describe, expect, it } from "vitest";
import { Camera } from "../camera/Camera";
import { IncrementalSmoother } from "../ink/Smoothing";
import { StrokeBuilder } from "../ink/StrokeBuilder";
import { noteToVisual, visualToNote } from "./ZoomScale";

/** The overlay's mapping, assembled exactly as production does it. */
function makePipeline(opts: {
	rectLeft: number;
	rectTop: number;
	contentLeft: number;
	documentTop: number;
	scale: number;
}) {
	const { rectLeft, rectTop, contentLeft, documentTop, scale } = opts;
	const camera = new Camera();
	// syncCamera(): visual origin delta, divided into note space.
	camera.setState(
		visualToNote(rectLeft - contentLeft, scale),
		visualToNote(rectTop - documentTop, scale),
		1
	);
	const builder = new StrokeBuilder("pen", "#000", 2);
	const smoother = new IncrementalSmoother();
	builder.start(0);

	return {
		camera,
		builder,
		smoother,
		/** InlinePenRouter.sampleFrom + InkOverlay.penRaw, in one step. */
		feed(clientX: number, clientY: number, t: number) {
			const sx = visualToNote(clientX - rectLeft, scale);
			const sy = visualToNote(clientY - rectTop, scale);
			const w = camera.screenToWorld(sx, sy);
			const point = builder.add(w.x, w.y, 0.5, t);
			if (point) {
				if (smoother.push(point) === undefined && builder.pointCount === 1) {
					smoother.reset(point);
				}
			}
			return { note: w, accepted: point !== undefined };
		},
		/** Map a note-space coordinate back out to client space. */
		toClient(x: number, y: number) {
			const s = camera.worldToScreen(x, y);
			return {
				x: rectLeft + noteToVisual(s.x, scale),
				y: rectTop + noteToVisual(s.y, scale),
			};
		},
	};
}

const GEOMETRIES = [
	{ name: "typical editor @100%", rectLeft: 320, rectTop: 88, contentLeft: 460, documentTop: 40, scale: 1 },
	{ name: "fractional origin", rectLeft: 320.4, rectTop: 88.6, contentLeft: 460.75, documentTop: 39.25, scale: 1 },
	{ name: "scrolled up (negative documentTop)", rectLeft: 0, rectTop: 0, contentLeft: 120, documentTop: -1840.5, scale: 1 },
	{ name: "css-zoomed 1.25", rectLeft: 100, rectTop: 50, contentLeft: 200, documentTop: 30, scale: 1.25 },
	{ name: "css-zoomed 0.8", rectLeft: 100, rectTop: 50, contentLeft: 200, documentTop: 30, scale: 0.8 },
];

describe("client -> note -> client is exact through the production chain", () => {
	for (const g of GEOMETRIES) {
		it(`${g.name}: no coordinate is lost or displaced`, () => {
			const p = makePipeline(g);
			for (const [cx, cy] of [
				[500, 200],
				[500.5, 200.25],
				[321, 89],
				[1279.75, 903.5],
			] as Array<[number, number]>) {
				const { note } = p.feed(cx, cy, 0);
				const back = p.toClient(note.x, note.y);
				expect(back.x).toBeCloseTo(cx, 9);
				expect(back.y).toBeCloseTo(cy, 9);
			}
		});
	}
});

describe("the drawn endpoint tracks the newest accepted sample", () => {
	it("head().to equals the newest accepted sample after every event", () => {
		const p = makePipeline(GEOMETRIES[0]!);
		let lastAcceptedNote: { x: number; y: number } | null = null;
		for (let i = 0; i < 40; i++) {
			const cx = 500 + i * 3.7;
			const cy = 200 + Math.sin(i / 3) * 25;
			const { note, accepted } = p.feed(cx, cy, i * 4);
			if (accepted) lastAcceptedNote = note;
			const head = p.smoother.head();
			expect(head).toBeDefined();
			expect(head!.to.x).toBeCloseTo(lastAcceptedNote!.x, 9);
			expect(head!.to.y).toBeCloseTo(lastAcceptedNote!.y, 9);
		}
	});

	it("the drawn endpoint maps back to the newest pointer position", () => {
		// The whole product claim, in one assertion: what is on screen at the
		// tip is where the pen physically is (modulo the dedupe threshold).
		const p = makePipeline(GEOMETRIES[1]!);
		let cx = 600;
		let cy = 300;
		for (let i = 0; i < 30; i++) {
			cx += 5.25;
			cy += 2.5;
			p.feed(cx, cy, i * 4);
			const head = p.smoother.head()!;
			const drawn = p.toClient(head.to.x, head.to.y);
			expect(Math.hypot(drawn.x - cx, drawn.y - cy)).toBeLessThan(0.2);
		}
	});

	it("slow movement never lets the tip fall further behind than the dedupe threshold", () => {
		// Sub-threshold motion is the case where a sample is dropped, so this
		// pins the worst-case constant offset rather than assuming it is zero.
		const p = makePipeline(GEOMETRIES[0]!);
		let cx = 700;
		const cy = 400;
		let worst = 0;
		for (let i = 0; i < 200; i++) {
			cx += 0.05; // far below the 0.15 world-unit dedupe distance
			p.feed(cx, cy, i * 4);
			const head = p.smoother.head();
			if (!head) continue;
			const drawn = p.toClient(head.to.x, head.to.y);
			worst = Math.max(worst, Math.hypot(drawn.x - cx, drawn.y - cy));
		}
		expect(worst).toBeLessThanOrEqual(0.15 + 1e-9);
	});
});

describe("coalesced batches leave the NEWEST sample as the visible endpoint", () => {
	it("a batch delivered oldest-first ends on its last sample", () => {
		const p = makePipeline(GEOMETRIES[0]!);
		const batch: Array<[number, number]> = [
			[500, 200],
			[506, 203],
			[512, 207],
			[518, 212],
		];
		let last: { x: number; y: number } | null = null;
		for (const [cx, cy] of batch) last = p.feed(cx, cy, 0).note;
		const head = p.smoother.head()!;
		expect(head.to.x).toBeCloseTo(last!.x, 9);
		const drawn = p.toClient(head.to.x, head.to.y);
		expect(drawn.x).toBeCloseTo(518, 6);
		expect(drawn.y).toBeCloseTo(212, 6);
	});
});

describe("the stroke's coordinate frame must not move mid-stroke", () => {
	it("re-syncing the camera under an in-flight stroke displaces it (why the frame is locked)", () => {
		// This is the defect the frame lock prevents: if documentTop changes
		// while a stroke is live, note-space coordinates for the SAME physical
		// pointer position shift by the origin delta, kinking the line.
		const before = makePipeline(GEOMETRIES[0]!);
		const first = before.feed(600, 300, 0).note;

		const after = makePipeline({ ...GEOMETRIES[0]!, documentTop: 40 - 24 });
		const second = after.feed(600, 300, 4).note;

		expect(second.y - first.y).toBeCloseTo(24, 9);
		// With the frame locked, the second reading uses the ORIGINAL camera
		// and therefore stays put — same pointer, same note coordinate.
		const locked = before.feed(600, 300.0001, 4).note;
		expect(locked.y).toBeCloseTo(first.y, 3);
	});
});
