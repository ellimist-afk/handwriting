import { describe, expect, it } from "vitest";
import { DWELL_MS, dwellStart, snapStroke } from "./ShapeSnap";
import { InkPoint, InkStroke, computeBBox } from "./Stroke";

/** Deterministic jitter so the suite never flakes. */
function jitter(i: number, amp: number): number {
	return Math.sin(i * 12.9898) * amp;
}

function strokeOf(points: InkPoint[]): InkStroke {
	return {
		id: "raw",
		tool: "pen",
		color: "#4b7bec",
		width: 2.2,
		points,
		bbox: computeBBox(points, 4.4),
		createdAt: 1,
	} as InkStroke;
}

/** Append a stationary hold at the final point, so the snap is requested. */
function withDwell(points: InkPoint[]): InkPoint[] {
	const last = points[points.length - 1]!;
	const out = [...points];
	for (let i = 1; i <= 6; i++) {
		out.push({ x: last.x + jitter(i, 0.4), y: last.y + jitter(i + 3, 0.4), pressure: 0.4, t: last.t + i * (DWELL_MS / 5) });
	}
	return out;
}

function noisyCircle(cx: number, cy: number, r: number): InkPoint[] {
	const out: InkPoint[] = [];
	for (let i = 0; i <= 60; i++) {
		const a = (i / 60) * Math.PI * 2;
		out.push({
			x: cx + Math.cos(a) * (r + jitter(i, r * 0.05)),
			y: cy + Math.sin(a) * (r + jitter(i + 7, r * 0.05)),
			pressure: 0.4,
			t: i * 12,
		});
	}
	return out;
}

function noisyRect(x: number, y: number, w: number, h: number): InkPoint[] {
	const corners = [
		{ x, y },
		{ x: x + w, y },
		{ x: x + w, y: y + h },
		{ x, y: y + h },
		{ x, y },
	];
	const out: InkPoint[] = [];
	let t = 0;
	for (let c = 0; c < 4; c++) {
		const a = corners[c]!;
		const b = corners[c + 1]!;
		for (let i = 0; i < 15; i++) {
			const f = i / 15;
			out.push({
				x: a.x + (b.x - a.x) * f + jitter(t, 1.2),
				y: a.y + (b.y - a.y) * f + jitter(t + 5, 1.2),
				pressure: 0.4,
				t: t * 10,
			});
			t++;
		}
	}
	return out;
}

describe("dwellStart", () => {
	it("a stroke that ends moving has no dwell", () => {
		const pts: InkPoint[] = [];
		for (let i = 0; i < 40; i++) pts.push({ x: i * 5, y: 0, pressure: 0.4, t: i * 10 });
		expect(dwellStart(pts)).toBe(null);
	});

	it("a stationary tail is found and located", () => {
		const pts = withDwell(
			Array.from({ length: 30 }, (_, i) => ({ x: i * 5, y: 0, pressure: 0.4, t: i * 10 }))
		);
		const idx = dwellStart(pts);
		expect(idx).not.toBe(null);
		expect(idx!).toBeGreaterThanOrEqual(29);
	});

	it("a dot (all dwell) is not a snap request", () => {
		const pts: InkPoint[] = Array.from({ length: 10 }, (_, i) => ({
			x: jitter(i, 0.5),
			y: jitter(i + 2, 0.5),
			pressure: 0.4,
			t: i * 60,
		}));
		expect(dwellStart(pts)).toBe(null);
	});
});

describe("snapStroke", () => {
	it("no dwell means no snap, whatever the figure", () => {
		expect(snapStroke(strokeOf(noisyCircle(100, 100, 40)))).toBe(null);
	});

	it("a held noisy circle becomes a circle", () => {
		const s = snapStroke(strokeOf(withDwell(noisyCircle(100, 100, 40))));
		expect(s).not.toBe(null);
		// Every synthesized point is equidistant from the center (a true
		// circle), at a radius honest to the drawn size.
		// Equidistance from the FITTED center (the drawn bbox center sits a
		// jitter-offset from the ideal 100,100 - the circle is still true).
		const ring = s!.points.slice(0, -3); // drop the closure + seam-overlap points
		const cx = ring.reduce((a, p) => a + p.x, 0) / ring.length;
		const cy = ring.reduce((a, p) => a + p.y, 0) / ring.length;
		const radii = ring.map((p) => Math.hypot(p.x - cx, p.y - cy));
		const rMin = Math.min(...radii);
		const rMax = Math.max(...radii);
		expect(rMax - rMin).toBeLessThan(0.01);
		expect(rMax).toBeGreaterThan(38);
		expect(rMax).toBeLessThan(42);
	});

	it("a held tall oval becomes an ellipse", () => {
		const oval: InkPoint[] = [];
		for (let i = 0; i <= 60; i++) {
			const a = (i / 60) * Math.PI * 2;
			oval.push({ x: 50 + Math.cos(a) * 20, y: 100 + Math.sin(a) * 60, pressure: 0.4, t: i * 12 });
		}
		const s = snapStroke(strokeOf(withDwell(oval)));
		expect(s).not.toBe(null);
		const b = s!.bbox;
		expect(b.height / b.width).toBeGreaterThan(2);
	});

	it("a held noisy rectangle squares up to its bounds", () => {
		const s = snapStroke(strokeOf(withDwell(noisyRect(10, 20, 120, 80))));
		expect(s).not.toBe(null);
		// All points on the synthesized outline hug one of the four edges.
		for (const p of s!.points) {
			const onX = Math.abs(p.x - 10) < 2 || Math.abs(p.x - 130) < 2;
			const onY = Math.abs(p.y - 20) < 2 || Math.abs(p.y - 100) < 2;
			expect(onX || onY).toBe(true);
		}
	});

	it("a held triangle keeps its three corners", () => {
		const corners = [
			{ x: 0, y: 100 },
			{ x: 60, y: 0 },
			{ x: 120, y: 100 },
			{ x: 0, y: 100 },
		];
		const pts: InkPoint[] = [];
		let t = 0;
		for (let c = 0; c < 3; c++) {
			const a = corners[c]!;
			const b = corners[c + 1]!;
			for (let i = 0; i < 15; i++) {
				const f = i / 15;
				pts.push({ x: a.x + (b.x - a.x) * f + jitter(t, 1), y: a.y + (b.y - a.y) * f + jitter(t + 9, 1), pressure: 0.4, t: t * 10 });
				t++;
			}
		}
		const s = snapStroke(strokeOf(withDwell(pts)));
		expect(s).not.toBe(null);
		const b = s!.bbox;
		expect(b.width).toBeGreaterThan(100);
		expect(b.height).toBeGreaterThan(80);
	});

	it("a held wobbly line straightens between its endpoints", () => {
		const pts: InkPoint[] = [];
		for (let i = 0; i <= 40; i++) {
			pts.push({ x: i * 5, y: 50 + jitter(i, 2), pressure: 0.4, t: i * 10 });
		}
		const s = snapStroke(strokeOf(withDwell(pts)));
		expect(s).not.toBe(null);
		for (const p of s!.points) {
			expect(Math.abs(p.y - 50)).toBeLessThan(3);
		}
	});

	it("held scribble stays itself (null: honesty over eagerness)", () => {
		const pts: InkPoint[] = [];
		for (let i = 0; i <= 80; i++) {
			pts.push({
				x: i * 3 + Math.sin(i * 1.7) * 30,
				y: Math.cos(i * 2.3) * 40 + Math.sin(i * 0.9) * 25,
				pressure: 0.4,
				t: i * 10,
			});
		}
		expect(snapStroke(strokeOf(withDwell(pts)))).toBe(null);
	});

	it("a soft-cornered square is a rectangle, never a circle (hardware repro)", () => {
		// Rounded hand corners: chamfer each corner across ~15% of the side.
		const pts: InkPoint[] = [];
		const corners = [
			{ x: 0, y: 0 },
			{ x: 100, y: 0 },
			{ x: 100, y: 100 },
			{ x: 0, y: 100 },
		];
		let t = 0;
		for (let c = 0; c < 4; c++) {
			const a = corners[c]!;
			const b = corners[(c + 1) % 4]!;
			const nxt = corners[(c + 2) % 4]!;
			for (let i = 2; i < 13; i++) {
				const f = i / 15;
				pts.push({ x: a.x + (b.x - a.x) * f + jitter(t, 0.8), y: a.y + (b.y - a.y) * f + jitter(t + 4, 0.8), pressure: 0.4, t: t * 10 });
				t++;
			}
			// the rounded corner: two soft steps cutting toward the next side
			pts.push({ x: b.x + (a.x - b.x) * 0.06 + (nxt.x - b.x) * 0.02, y: b.y + (a.y - b.y) * 0.06 + (nxt.y - b.y) * 0.02, pressure: 0.4, t: t++ * 10 });
			pts.push({ x: b.x + (a.x - b.x) * 0.02 + (nxt.x - b.x) * 0.06, y: b.y + (a.y - b.y) * 0.02 + (nxt.y - b.y) * 0.06, pressure: 0.4, t: t++ * 10 });
		}
		const s2 = snapStroke(strokeOf(withDwell(pts)));
		expect(s2).not.toBe(null);
		// rectangle: the outline hugs the axis-aligned bounds, corners intact
		const b = s2!.bbox;
		expect(b.width).toBeGreaterThan(90);
		expect(b.height).toBeGreaterThan(90);
		const xs = s2!.points.map((p) => p.x);
		const nearLeft = xs.filter((x) => Math.abs(x - Math.min(...xs)) < 3).length;
		expect(nearLeft).toBeGreaterThan(3); // a circle has ONE leftmost point
	});

	it("a square started mid-edge still squares (hardware repro)", () => {
		// Start halfway along the top and go around: the seam sits mid-edge.
		const path = [
			{ x: 50, y: 0 },
			{ x: 100, y: 0 },
			{ x: 100, y: 100 },
			{ x: 0, y: 100 },
			{ x: 0, y: 0 },
			{ x: 50, y: 0 },
		];
		const pts: InkPoint[] = [];
		let t = 0;
		for (let c = 0; c < path.length - 1; c++) {
			const a = path[c]!;
			const b = path[c + 1]!;
			const n = Math.max(6, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 8));
			for (let i = 0; i < n; i++) {
				const f = i / n;
				pts.push({ x: a.x + (b.x - a.x) * f + jitter(t, 0.8), y: a.y + (b.y - a.y) * f + jitter(t + 6, 0.8), pressure: 0.4, t: t * 10 });
				t++;
			}
		}
		const s2 = snapStroke(strokeOf(withDwell(pts)));
		expect(s2).not.toBe(null);
		const xs = s2!.points.map((p) => p.x);
		const nearLeft = xs.filter((x) => Math.abs(x - Math.min(...xs)) < 3).length;
		expect(nearLeft).toBeGreaterThan(3);
	});

	it("the snapped stroke keeps tool, color and width", () => {
		const raw = strokeOf(withDwell(noisyCircle(50, 50, 30)));
		raw.color = "#e0245e";
		raw.width = 4.4;
		const s = snapStroke(raw)!;
		expect(s.color).toBe("#e0245e");
		expect(s.width).toBe(4.4);
		expect(s.id).not.toBe(raw.id);
	});
});
