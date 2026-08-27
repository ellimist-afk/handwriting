/**
 * Sidecar schema v2: integer-delta point packing. Writes stay v1 until the
 * fleet can read v2; what ships NOW is the reader plus the encoder, so the
 * later flip is one constant. The oracle for every round-trip is the v1
 * parse of the same page - v2 must reproduce it exactly (both formats
 * quantize identically: x/y to 2dp, pressure to 3dp, t to 1ms).
 */

import { describe, expect, it } from "vitest";

import {
	READ_SCHEMA_VERSION,
	SCHEMA_VERSION,
	emptyPage,
	packPointsV2,
	parsePage,
	serializePage,
	unpackPointsV2,
} from "./PageData";
import { InkPoint, InkStroke } from "../ink/Stroke";

function pageWith(points: InkPoint[]) {
	const page = emptyPage("p1");
	page.surface = "inline";
	page.strokes = [
		{
			id: "s1",
			tool: "pen",
			color: "#4b7bec",
			width: 2.2,
			points,
			bbox: { x: 0, y: 0, width: 1, height: 1 },
			createdAt: 123,
		} as InkStroke,
	];
	return page;
}

const POINTS: InkPoint[] = [
	{ x: 78.857, y: 44.812, pressure: 0.0871, t: 0 },
	{ x: 77.949, y: 46.64, pressure: 0.2874, t: 67 },
	{ x: -12.5, y: -3.25, pressure: 0.5, t: 71 },
	{ x: 1500.01, y: 0.01, pressure: 1, t: 5000 },
];

describe("sidecar v2", () => {
	it("writes stay v1 by default", () => {
		const json = serializePage(pageWith(POINTS));
		const raw = JSON.parse(json);
		expect(raw.schemaVersion).toBe(1);
		expect(raw.strokes[0].pts).toBeDefined();
		expect(raw.strokes[0].ptsd).toBeUndefined();
	});

	it("v2 round-trips to exactly what v1 produces", () => {
		const v1 = parsePage(serializePage(pageWith(POINTS), 1), "p1");
		const v2 = parsePage(serializePage(pageWith(POINTS), 2), "p1");
		expect(v2.futureVersion).toBeUndefined();
		expect(v2.data.strokes[0]!.points).toEqual(v1.data.strokes[0]!.points);
	});

	it("v2 is meaningfully smaller than v1", () => {
		const dense: InkPoint[] = [];
		for (let i = 0; i < 200; i++) {
			dense.push({ x: 100 + i * 0.91, y: 200 + Math.sin(i / 5) * 8, pressure: 0.3 + (i % 7) * 0.01, t: i * 7 });
		}
		const v1 = serializePage(pageWith(dense), 1).length;
		const v2 = serializePage(pageWith(dense), 2).length;
		expect(v2).toBeLessThan(v1 * 0.65);
	});

	it("pack/unpack is its own inverse at the quantization grid", () => {
		const out = unpackPointsV2(packPointsV2(POINTS));
		expect(out).toHaveLength(POINTS.length);
		for (let i = 0; i < POINTS.length; i++) {
			expect(out[i]!.x).toBeCloseTo(POINTS[i]!.x, 2);
			expect(out[i]!.y).toBeCloseTo(POINTS[i]!.y, 2);
			expect(out[i]!.pressure).toBeCloseTo(POINTS[i]!.pressure, 3);
			expect(out[i]!.t).toBe(Math.round(POINTS[i]!.t));
		}
	});

	it("a v2 sidecar loads today (reader ships ahead of the writer)", () => {
		const result = parsePage(serializePage(pageWith(POINTS), 2), "p1");
		expect(result.futureVersion).toBeUndefined();
		expect(result.damaged).toBeFalsy();
		expect(result.data.strokes).toHaveLength(1);
	});

	it("a v3 sidecar still future-locks", () => {
		const raw = JSON.parse(serializePage(pageWith(POINTS), 2));
		raw.schemaVersion = READ_SCHEMA_VERSION + 1;
		const result = parsePage(JSON.stringify(raw), "p1");
		expect(result.futureVersion).toBe(READ_SCHEMA_VERSION + 1);
	});

	it("empty points pack to an empty array", () => {
		expect(packPointsV2([])).toEqual([]);
		expect(unpackPointsV2([])).toEqual([]);
	});

	it("write version constant is still v1 (the flip has not happened)", () => {
		expect(SCHEMA_VERSION).toBe(1);
		expect(READ_SCHEMA_VERSION).toBe(2);
	});
});
