/**
 * A single sparse stroke can exceed the raster path limit even when its
 * points and backing are valid. Check emitted geometry, not stored bboxes.
 * Screen visibility and antialiasing are separate browser acceptance checks.
 */
import { describe, expect, it } from "vitest";
import { fillRibbon, ribbonBoundsPasses } from "./RibbonRenderer";
import { drawSegment, drawStroke } from "./StrokeRenderer";
import { DEFAULT_PEN } from "./PenStyle";
import { computeBBox, type InkStroke } from "./Stroke";

type Bounds = { left: number; top: number; right: number; bottom: number };
function recorder(options: { width?: number; height?: number; scale?: number; tx?: number; ty?: number } = {}) {
	const commands: unknown[][] = [];
	const paints: Array<{ bounds: Bounds; clip: Bounds | null; path: unknown[][] }> = [];
	let pathStart = 0;
	let bounds: Bounds;
	let clip: Bounds | null = null;
	const stack: Array<{ clip: Bounds | null; fillStyle: string; alpha: number; composite: string }> = [];
	const point = (x: number, y: number) => {
		bounds.left = Math.min(bounds.left, x); bounds.right = Math.max(bounds.right, x);
		bounds.top = Math.min(bounds.top, y); bounds.bottom = Math.max(bounds.bottom, y);
	};
	const ctx = {
		canvas: { width: options.width ?? 40000, height: options.height ?? 40000 },
		fillStyle: "", strokeStyle: "", lineWidth: 1, lineCap: "butt", lineJoin: "miter",
		globalAlpha: 0.4, globalCompositeOperation: "source-over",
		getTransform: () => ({ a: options.scale ?? 0.2, b: 0, c: 0, d: options.scale ?? 0.2, e: options.tx ?? 20000, f: options.ty ?? 20000 }),
		beginPath() { bounds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity }; commands.push(["begin"]); pathStart = commands.length; },
		moveTo(x: number, y: number) { point(x, y); commands.push(["move", x, y]); },
		lineTo(x: number, y: number) { point(x, y); commands.push(["line", x, y]); },
		quadraticCurveTo(x: number, y: number, ex: number, ey: number) { point(x, y); point(ex, ey); commands.push(["quad", x, y, ex, ey]); },
		arc(x: number, y: number, r: number, start: number, end: number, ccw = false) {
			const tau = 2 * Math.PI;
			const span = ccw ? ((start - end) % tau + tau) % tau : ((end - start) % tau + tau) % tau;
			const full = Math.abs(end - start) >= tau - 1e-10;
			for (const t of [start, end, 0, Math.PI / 2, Math.PI, 3 * Math.PI / 2]) {
				const offset = ccw ? ((start - t) % tau + tau) % tau : ((t - start) % tau + tau) % tau;
				if (full || offset <= span + 1e-10) point(x + r * Math.cos(t), y + r * Math.sin(t));
			}
			commands.push(["arc", x, y, r, start, end, ccw]);
		},
		closePath() { commands.push(["close"]); },
		rect(x: number, y: number, w: number, h: number) { point(x, y); point(x + w, y + h); commands.push(["rect", x, y, w, h]); },
		clip() {
			clip = clip ? { left: Math.max(clip.left, bounds.left), top: Math.max(clip.top, bounds.top), right: Math.min(clip.right, bounds.right), bottom: Math.min(clip.bottom, bounds.bottom) } : { ...bounds };
			commands.push(["clip"]);
		},
		save() { stack.push({ clip, fillStyle: this.fillStyle, alpha: this.globalAlpha, composite: this.globalCompositeOperation }); commands.push(["save"]); },
		restore() {
			const state = stack.pop()!;
			clip = state.clip; this.fillStyle = state.fillStyle; this.globalAlpha = state.alpha; this.globalCompositeOperation = state.composite;
			commands.push(["restore"]);
		},
		fill() { paints.push({ bounds: { ...bounds }, clip, path: commands.slice(pathStart) }); commands.push(["fill", this.fillStyle]); },
		stroke() {
			const r = this.lineWidth / 2;
			paints.push({ bounds: { left: bounds.left - r, top: bounds.top - r, right: bounds.right + r, bottom: bounds.bottom + r }, clip, path: commands.slice(pathStart) });
			commands.push(["stroke", this.strokeStyle, this.lineWidth, this.lineCap, this.lineJoin]);
		},
	};
	return { ctx: ctx as unknown as CanvasRenderingContext2D, paints, commands, stack, get clip() { return clip; } };
}

/** Independent point-in-path oracle. Arc tessellation error stays below .01 layout px. */
function contours(path: unknown[][], scale: number): Array<Array<[number, number]>> {
	const result: Array<Array<[number, number]>> = [];
	let current: Array<[number, number]> = [];
	for (const [op, ...args] of path) {
		const a = args as number[];
		if (op === "move") { current = [[a[0]! * scale, a[1]! * scale]]; result.push(current); }
		if (op === "line") current.push([a[0]! * scale, a[1]! * scale]);
		if (op === "arc") {
			const [x, y, r, start, end] = a as [number, number, number, number, number];
			const ccw = Boolean(args[5]), tau = 2 * Math.PI;
			const delta = ccw ? start - end : end - start;
			const span = Math.abs(delta) >= tau - 1e-10 ? tau : ((delta % tau) + tau) % tau;
			const steps = Math.max(1, Math.ceil(span * Math.sqrt(r * scale / 0.04)));
			if (!current.length) { current = []; result.push(current); }
			for (let i = 0; i <= steps; i++) {
				const t = start + (ccw ? -1 : 1) * span * i / steps;
				current.push([(x + r * Math.cos(t)) * scale, (y + r * Math.sin(t)) * scale]);
			}
		}
	}
	return result;
}

function winding(polys: Array<Array<[number, number]>>, x: number, y: number): number {
	let result = 0;
	for (const poly of polys) for (let i = 0; i < poly.length; i++) {
		const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
		const side = (b[0] - a[0]) * (y - a[1]) - (x - a[0]) * (b[1] - a[1]);
		if (a[1] <= y && b[1] > y && side > 0) result++;
		if (a[1] > y && b[1] <= y && side < 0) result--;
	}
	return result;
}

function bounded(paints: ReturnType<typeof recorder>["paints"]) {
	expect(paints.length).toBeGreaterThan(1);
	for (const { bounds } of paints) {
		expect(bounds.right - bounds.left).toBeLessThanOrEqual(16000.000001);
		expect(bounds.bottom - bounds.top).toBeLessThanOrEqual(16000.000001);
	}
}

describe("bounded stroke raster geometry", () => {
	it.each([false, true])("keeps ordinary ribbon commands, raw=%s", raw => {
		const r = recorder();
		fillRibbon(r.ctx, { x: 3, y: -4, zoom: 2 }, [
			{ x: 4, y: 5, hw: 1 }, { x: 20, y: 5, hw: 2 }, { x: 20, y: 11, hw: 1 },
		], "rgba(1,2,3,.4)", raw, { backing: 0.2, dpr: 2 });
		expect(r.commands).toMatchSnapshot();
		expect(r.paints).toHaveLength(1);
	});

	it.each([[22860, 0], [0, 22860], [22860, -22860]])("bounds a sparse ribbon spanning %s,%s", (x, y) => {
		const r = recorder();
		fillRibbon(r.ctx, { x: 70000, y: 2000, zoom: 2 }, [
			{ x: 70000, y: 2000, hw: 3 }, { x: 70000 + x, y: 2000 + y, hw: 7 },
		], "#123");
		bounded(r.paints);
		expect(r.stack).toHaveLength(0);
	});

	it("includes width when bounding a giant round nib", () => {
		const r = recorder();
		fillRibbon(r.ctx, { x: 0, y: 0, zoom: 1 }, [{ x: 60000, y: 0, hw: 12000 }], "#123");
		bounded(r.paints);
	});

	it("bounds a long legacy segment without changing its width law", () => {
		const r = recorder();
		drawSegment(r.ctx, { x: 500, y: 100, zoom: 2 }, { ...DEFAULT_PEN, baseWidth: 8 },
			{ x: 500, y: 100, pressure: 0.25, t: 0 }, { x: 23500, y: 23100, pressure: 0.75, t: 1 });
		bounded(r.paints);
	});

	it("keeps a million-pixel sparse diagonal within a visible operation budget", () => {
		const r = recorder({ width: 2400, height: 1800, scale: 0.2, tx: 0.3, ty: 0.7 });
		fillRibbon(r.ctx, { x: 0, y: 0, zoom: 1 }, [
			{ x: -500000, y: -500000, hw: 20 }, { x: 500000, y: 500000, hw: 20 },
		], "rgba(1,2,3,.4)", true);
		expect(r.paints).toHaveLength(1);
		expect(r.commands.length).toBeLessThan(30);
		expect(r.paints[0]!.bounds.right - r.paints[0]!.bounds.left).toBeLessThanOrEqual(12000);
	});

	it("does no canvas work for a wholly offscreen oversized stroke", () => {
		const r = recorder({ width: 2400, height: 1800, tx: 0, ty: 0 });
		fillRibbon(r.ctx, { x: 0, y: 0, zoom: 1 }, [
			{ x: 500000, y: 500000, hw: 3 }, { x: 1500000, y: 1500000, hw: 3 },
		], "#123");
		expect(r.commands).toHaveLength(0);
		expect(r.paints).toHaveLength(0);
	});

	it.each([false, true])("preserves the original pointwise union without double fills, raw=%s", raw => {
		const shapes = [
			[{ x: 0, y: 0, hw: 500 }, { x: 40000, y: 0, hw: 1200 }, { x: 0, y: 0, hw: 700 }, { x: 20000, y: 6000, hw: 900 }],
			[{ x: 20000, y: 20000, hw: 20000 }],
			[{ x: -20000, y: -20000, hw: 3000 }, { x: 0, y: 0, hw: 4000 }, { x: 0, y: 0, hw: 4000 }, { x: 20000, y: -20000, hw: 3000 }],
		];
		for (const pts of shapes) {
			const r = recorder({ tx: 20000.31, ty: 20000.73 }), reference = recorder();
			fillRibbon(r.ctx, { x: 0, y: 0, zoom: 1 }, pts, "rgba(1,2,3,.4)", raw);
			// Same original geometry at a scale that stays on the unsplit path.
			fillRibbon(reference.ctx, { x: 0, y: 0, zoom: 0.125 }, pts, "rgba(1,2,3,.4)", raw);
			expect(reference.paints).toHaveLength(1);
			bounded(r.paints);
			const expected = contours(reference.paints[0]!.path, 8);
			const actual = r.paints.map(p => ({ polys: contours(p.path, 1), clip: p.clip! }));
			const samples: Array<[number, number]> = [];
			for (let x = -24000.37; x < 44000; x += 1883) for (let y = -24000.29; y < 44000; y += 1901) samples.push([x, y]);
			for (const { clip } of actual) {
				for (const delta of [-0.1, 0.1]) {
					samples.push([clip.left + delta, (clip.top + clip.bottom) / 2], [(clip.left + clip.right) / 2, clip.top + delta]);
				}
				// Real context translation, rather than camera zoom, controls alignment.
				for (const x of [clip.left, clip.right]) expect(x * 0.2 + 20000.31).toBeCloseTo(Math.round(x * 0.2 + 20000.31), 8);
				for (const y of [clip.top, clip.bottom]) expect(y * 0.2 + 20000.73).toBeCloseTo(Math.round(y * 0.2 + 20000.73), 8);
			}
			let missingPieceDetected = false;
			for (const [x, y] of samples) {
				const wanted = Number(winding(expected, x, y) !== 0);
				const hits = actual.map(({ polys, clip }) => Number(x >= clip.left && x < clip.right && y >= clip.top && y < clip.bottom && winding(polys, x, y) !== 0));
				expect(hits.reduce((a, b) => a + b, 0), `union at ${x},${y}`).toBe(wanted);
				if (hits.slice(1).reduce((a, b) => a + b, 0) !== wanted) missingPieceDetected = true;
			}
			// Sensitivity control: dropping a region must lose visible coverage.
			expect(missingPieceDetected).toBe(true);
		}
	});

	it.each(["clip", "fill"] as const)("restores caller state if %s fails", method => {
		const r = recorder();
		r.ctx.beginPath(); r.ctx.rect(-1000, -1000, 50000, 50000); r.ctx.clip();
		const savedClip = r.clip, savedTransform = r.ctx.getTransform();
		const original = r.ctx[method].bind(r.ctx);
		r.ctx[method] = () => {
			original(); r.ctx.globalAlpha = 0.1; r.ctx.globalCompositeOperation = "copy";
			throw new Error("paint refused");
		};
		expect(() => fillRibbon(r.ctx, { x: 0, y: 0, zoom: 1 }, [
			{ x: 0, y: 0, hw: 3 }, { x: 40000, y: 0, hw: 4 },
		], "#123")).toThrow("paint refused");
		expect(r.stack).toHaveLength(0);
		expect(r.clip).toEqual(savedClip);
		expect(r.ctx.globalAlpha).toBe(0.4);
		expect(r.ctx.globalCompositeOperation).toBe("source-over");
		expect(r.ctx.getTransform()).toEqual(savedTransform);
	});

	it("rejects non-finite projections before constructing a grid", () => {
		const r = recorder();
		expect(() => fillRibbon(r.ctx, { x: 0, y: 0, zoom: 2 }, [
			{ x: 0, y: 0, hw: 3 }, { x: Number.MAX_VALUE, y: 0, hw: 3 },
		], "#123")).toThrow(RangeError);
		expect(r.commands).toHaveLength(0);
	});

	it("never closes a subpath on the bounded route", () => {
		// fill closes every subpath; a close per piece is the cost ZoomFreezeHeavyNote counts.
		const r = recorder();
		fillRibbon(r.ctx, { x: 70000, y: 2000, zoom: 2 }, [
			{ x: 70000, y: 2000, hw: 3 }, { x: 92860, y: 2000, hw: 7 }, { x: 92860, y: -20860, hw: 5 },
		], "#123", true);
		bounded(r.paints);
		expect(r.paints.some(p => p.path.some(c => c[0] === "arc")), "a disc piece is drawn").toBe(true);
		expect(r.commands.filter(c => c[0] === "close")).toEqual([]);
	});

	it("skips the point-by-point measure for an ordinary committed stroke", () => {
		const r = recorder();
		const cam = { x: 0, y: 0, zoom: 2 };
		const floor = { backing: 2, dpr: 2 };
		const stroke = (span: number): InkStroke => {
			const points = [
				{ x: 10, y: 10, pressure: 0.5, t: 0 },
				{ x: 10 + span / 2, y: 14, pressure: 0.6, t: 8 },
				{ x: 10 + span, y: 10, pressure: 0.5, t: 16 },
			];
			return { id: `s${span}`, tool: "pen", color: "#202020", width: 2, points, bbox: computeBBox(points, 4), createdAt: 0 };
		};
		// An ordinary stroke through all three committed calls (uncached, cache miss, cache hit):
		// its bbox answers, so the ribbon is never walked.
		const ordinary = stroke(300);
		let before = ribbonBoundsPasses();
		drawStroke(r.ctx, cam, ordinary, undefined, true, false, floor);
		drawStroke(r.ctx, cam, ordinary, undefined, true, true, floor);
		drawStroke(r.ctx, cam, ordinary, undefined, true, true, floor);
		expect(ribbonBoundsPasses() - before).toBe(0);
		expect(r.paints).toHaveLength(3);
		// A direct caller that passes nothing (the wet strip, the tail) is measured.
		before = ribbonBoundsPasses();
		fillRibbon(r.ctx, cam, [{ x: 10, y: 10, hw: 1 }, { x: 310, y: 10, hw: 1 }], "#202020");
		expect(ribbonBoundsPasses() - before).toBe(1);
		// A committed stroke whose bbox could reach the limit is measured, and bounded.
		before = ribbonBoundsPasses();
		const long = recorder();
		drawStroke(long.ctx, cam, stroke(9000), undefined, true, false, floor);
		expect(ribbonBoundsPasses() - before).toBe(1);
		bounded(long.paints);
	});

});
