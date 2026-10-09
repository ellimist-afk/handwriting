import { describe, expect, it } from "vitest";
import { WetInkRenderer } from "./WetInkRenderer";
import { TailRenderer } from "./TailRenderer";
import { StrokeBuilder } from "./StrokeBuilder";
import { drawStroke } from "./StrokeRenderer";
import { EXP7_PEN } from "./PenStyle";
import type { CameraState } from "../camera/coordinates";

/**
 * What was on screen while the pen was down vs the stroke saved at lift,
 * compared as filled geometry. A fake 2d context records every filled quad and
 * disc; coverage is sampled on a 0.1 px grid. The feed mirrors InkOverlay:
 * builder.add, and only an ACCEPTED point reaches the wet layer
 * (InkOverlay.ts:5001-5011); the pen-down contact dot (4891-4913) and the last
 * live head (5034-5048) are drawn on the tail as the overlay draws them; the
 * lift commits finishReleaseFiltered() through drawStroke (5570, 5710).
 *
 * Block 0 is a control; block 1 is a pen held still while its pressure
 * changes; block 2 is a tap, new taps only. The pressure-off start taper and
 * the live head are not covered here.
 */
type Shape = { kind: "poly"; pts: [number, number][] } | { kind: "disc"; x: number; y: number; r: number };
function recorder() {
	const shapes: Shape[] = [];
	let path: Shape[] = [];
	let cur: [number, number][] | null = null;
	const flush = () => { if (cur && cur.length >= 3) path.push({ kind: "poly", pts: cur }); cur = null; };
	const ctx = new Proxy({}, {
		get(_t, prop) {
			switch (prop) {
				case "beginPath": return () => { path = []; cur = null; };
				case "moveTo": return (x: number, y: number) => { flush(); cur = [[x, y]]; };
				case "lineTo": return (x: number, y: number) => { cur?.push([x, y]); };
				case "arc": return (x: number, y: number, r: number) => { flush(); path.push({ kind: "disc", x, y, r }); };
				case "fill": return () => { flush(); shapes.push(...path); path = []; };
				case "getContextAttributes": return () => ({ desynchronized: false });
				default: return () => undefined;
			}
		},
		set() { return true; },
	}) as unknown as CanvasRenderingContext2D;
	return { ctx, shapes, canvas: { getContext: () => ctx, width: 4000, height: 4000 } as unknown as HTMLCanvasElement };
}
function inPoly(px: number, py: number, pts: [number, number][]): boolean {
	let inside = false;
	for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
		const [xi, yi] = pts[i]!, [xj, yj] = pts[j]!;
		if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}
const covered = (shapes: Shape[], x: number, y: number) =>
	shapes.some(s => s.kind === "disc" ? Math.hypot(x - s.x, y - s.y) <= s.r : inPoly(x, y, s.pts));
function diff(wet: Shape[], committed: Shape[], keepX = (_x: number) => true, step = 0.1) {
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (const s of [...wet, ...committed]) {
		const ps = s.kind === "disc" ? [[s.x - s.r, s.y - s.r], [s.x + s.r, s.y + s.r]] : s.pts;
		for (const [x, y] of ps) { x0 = Math.min(x0, x!); y0 = Math.min(y0, y!); x1 = Math.max(x1, x!); y1 = Math.max(y1, y!); }
	}
	let onlyWet = 0, onlyCommitted = 0;
	for (let x = x0; x <= x1; x += step) for (let y = y0; y <= y1; y += step) {
		if (!keepX(x)) continue;
		const a = covered(wet, x, y), b = covered(committed, x, y);
		if (a && !b) onlyWet++; else if (b && !a) onlyCommitted++;
	}
	return { onlyWetPx2: onlyWet * step * step, onlyCommittedPx2: onlyCommitted * step * step };
}

type S = { x: number; y: number; p: number; t: number };
let join = { ribbonEndR: 0, headStartR: 0 };
function liftDiff(samples: S[], opts: { baseWidth?: number; zoom?: number; keepX?: (x: number) => boolean; device?: "mouse" } = {}) {
	const cam: CameraState = { x: 0, y: 0, zoom: opts.zoom ?? 1 };
	const style = { ...EXP7_PEN, baseWidth: opts.baseWidth ?? EXP7_PEN.baseWidth };
	const wetRec = recorder(), tailRec = recorder(), comRec = recorder();
	const wet = new WetInkRenderer(wetRec.canvas, false);
	wet.smooth = true; wet.shape = opts.device !== "mouse"; // InkOverlay.ts:2486-2487; a mouse draws flat live
	const tail = new TailRenderer(tailRec.canvas);
	const b = new StrokeBuilder("pen", style.color, style.baseWidth, undefined, opts.device);
	b.start(0);
	let first = true, moved = false;
	for (const s of samples) {
		const pt = b.add(s.x, s.y, s.p, s.t);
		if (!pt) continue;
		if (first) {
			wet.beginStroke(pt, style, false, b.resolvedPressureProfile);
			tail.drawHead(cam, style, pt, pt, pt.pressure, wet.contactHalfWidth(style, pt.pressure));
			first = false;
		} else { wet.appendPoint(cam, style, pt); moved = true; }
	}
	// A tap never moves, so the overlay never replaces its contact dot.
	const head = moved ? wet.head() : undefined;
	if (head) {
		tailRec.shapes.length = 0; // the move path clears the tail before each head
		tail.drawHead(cam, style, head.from, head.to, head.pressure, wet.liveHalfWidth(style, head.pressure));
		const wetDiscs = wetRec.shapes.filter(s => s.kind === "disc");
		const headDiscs = tailRec.shapes.filter(s => s.kind === "disc");
		join = { ribbonEndR: (wetDiscs.at(-1) as { r: number }).r, headStartR: (headDiscs[0] as { r: number }).r };
	}
	for (const s of b.finishReleaseFiltered()) drawStroke(comRec.ctx, cam, s, undefined, true, false);
	return diff([...wetRec.shapes, ...tailRec.shapes], comRec.shapes, opts.keepX);
}
const line = (n: number, p = 0.5): S[] => Array.from({ length: n + 1 }, (_, i) => ({ x: 10 + i * 2, y: 20, p, t: i * 8 }));

describe("0: control", () => {
	it("a steady line commits exactly as drawn", () => {
		expect(liftDiff(line(20))).toEqual({ onlyWetPx2: 0, onlyCommittedPx2: 0 });
	});
});

describe("1: a held pen's pressure never changes the stroke at lift", () => {
	it("a light landing that firms up before moving grows no start blot", () => {
		const s: S[] = [{ x: 10, y: 20, p: 0.05, t: 0 }];
		for (let k = 1; k <= 6; k++) s.push({ x: 10 + k * 0.01, y: 20, p: 0.05 + k * 0.1, t: k * 4 });
		for (let i = 1; i <= 20; i++) s.push({ x: 10 + i * 2, y: 20, p: 0.65, t: 24 + i * 8 });
		expect(liftDiff(s).onlyCommittedPx2).toBe(0);
	});
	it("pressing harder while parked at the end does not fatten the end", () => {
		const s = line(20);
		for (let k = 1; k <= 10; k++) s.push({ x: 50 + k * 0.005, y: 20, p: 0.5 + k * 0.05, t: 160 + k * 8 });
		expect(liftDiff(s).onlyCommittedPx2).toBe(0);
	});
	it("easing off while parked at the end does not thin the end", () => {
		const s = line(20);
		for (let k = 1; k <= 5; k++) s.push({ x: 50, y: 20, p: 0.5 - k * 0.06, t: 160 + k * 8 });
		expect(liftDiff(s).onlyWetPx2).toBe(0);
	});
	it("a mid-stroke pause with a press does not reshape the ink after it", () => {
		const s = line(10);
		for (let k = 1; k <= 5; k++) s.push({ x: 30, y: 20, p: 0.5 + k * 0.1, t: 80 + k * 8 });
		for (let i = 1; i <= 10; i++) s.push({ x: 30 + i * 2, y: 20, p: 1, t: 120 + i * 8 });
		expect(liftDiff(s).onlyCommittedPx2).toBe(0);
	});
});

describe("2: a tap saves the dot that was on screen", () => {
	for (const size of [1.1, 2.2, 6]) for (const p of [0.1, 0.6, 0.9]) {
		it(`size ${size}, pressure ${p}`, () => {
			const d = liftDiff([{ x: 10, y: 20, p, t: 0 }], { baseWidth: size });
			// The residue is the builder's 0.01-unit tap twin (StrokeBuilder.ts:153).
			expect(d.onlyWetPx2 + d.onlyCommittedPx2).toBeLessThan(0.25);
		});
	}
	it("a mouse tap with the pen tool, pressure 0.5", () => {
		const d = liftDiff([{ x: 10, y: 20, p: 0.5, t: 0 }], { baseWidth: 2.2, device: "mouse" });
		expect(d.onlyWetPx2 + d.onlyCommittedPx2).toBeLessThan(0.25);
	});
});

describe("2: a tap saved before the fix draws as it did", () => {
	// Area (0.1 px grid) drawn before this change for an exp7 tap with no widthMode, the
	// shape every tap was saved in until now. A saved stroke never changes.
	const drawnAtTip: Record<string, number> = { "0.1": 0.57, "0.6": 13.04, "0.9": 30.94 };
	for (const p of [0.1, 0.6, 0.9]) {
		it(`pressure ${p}, size 2.2`, () => {
			const rec = recorder();
			const pt = { x: 10, y: 20, pressure: p, t: 0 };
			drawStroke(rec.ctx, { x: 0, y: 0, zoom: 1 }, {
				id: "old-tap", tool: "pen", color: "#000", width: 2.2, createdAt: 0, pressureProfile: "exp7",
				points: [pt, { ...pt, x: pt.x + 0.01, t: 1 }], bbox: { x: 5, y: 15, width: 10, height: 10 },
			}, undefined, true, false);
			expect(diff([], rec.shapes).onlyCommittedPx2).toBeCloseTo(drawnAtTip[String(p)]!, 6);
		});
	}
});
