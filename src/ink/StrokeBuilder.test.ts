import { describe, expect, it } from "vitest";

import { RELEASE_MAX_MS, StrokeBuilder } from "./StrokeBuilder";

function builder(): StrokeBuilder {
	const value = new StrokeBuilder("pen", "#377dff", 2);
	value.start(1000);
	return value;
}

describe("inline pen release filtering", () => {
	it("drops terminal travel reported after a confident Surface pen contact", () => {
		const value = builder();
		value.add(0, 0, 0.403, 1000);
		value.add(2, 0, 0.306, 1004);
		value.add(5, 1, 0.012, 1008);
		value.add(12, 3, 0.015, 1016);
		value.add(22, 6, 0.003, 1025);
		value.add(30, 8, 0, 1030);

		const strokes = value.finishReleaseFiltered();

		expect(strokes).toHaveLength(1);
		expect(strokes[0]!.points.map((point) => point.x)).toEqual([0, 2]);
		expect(strokes[0]!.bbox.x + strokes[0]!.bbox.width).toBeLessThan(8);
	});

	it("counts the jump into the first low-pressure sample as release travel", () => {
		const value = builder();
		value.add(0, 0, 0.4, 1000);
		value.add(2, 0, 0.3, 1008);
		value.add(9, 0, 0.01, 1017);

		const strokes = value.finishReleaseFiltered();

		expect(strokes).toHaveLength(1);
		expect(strokes[0]!.points.at(-1)!.x).toBe(2);
	});

	it("keeps one stroke when contact comes back after a light run with no lift between", () => {
		const value = builder();
		value.add(0, 0, 0.4, 1000);
		value.add(10, 0, 0.3, 1006);
		value.add(12, 0, 0.012, 1010);
		value.add(24, 1, 0.014, 1022);
		value.add(28, 2, 0.04, 1027);
		value.add(31, 3, 0.08, 1032);
		value.add(40, 5, 0.2, 1040);

		const strokes = value.finishReleaseFiltered();

		// The pen never left the glass: the light samples are ink drawn in contact.
		expect(strokes).toHaveLength(1);
		expect(strokes[0]!.points.map((point) => point.x)).toEqual([0, 10, 12, 24, 28, 31, 40]);
	});

	it("keeps repeated light runs that recover whole and still removes the final release tail", () => {
		const value = builder();
		for (const [x, pressure, time] of [
			[0, 0.3, 1000],
			[5, 0.2, 1005],
			[10, 0.01, 1014],
			[20, 0.01, 1024],
			[23, 0.04, 1028],
			[25, 0.09, 1032],
			[30, 0.2, 1038],
			[35, 0.01, 1047],
			[45, 0.01, 1057],
			[48, 0.04, 1061],
			[50, 0.1, 1065],
			[55, 0.2, 1070],
			[70, 0.01, 1080],
			[85, 0, 1090],
		] as const) {
			value.add(x, 0, pressure, time);
		}

		const strokes = value.finishReleaseFiltered();

		expect(strokes).toHaveLength(1);
		expect(strokes[0]!.points.map((point) => point.x)).toEqual([0, 5, 10, 20, 23, 25, 30, 35, 45, 48, 50, 55]);
	});

	it("preserves a short low-pressure wobble that is too small to prove a release", () => {
		const value = builder();
		value.add(0, 0, 0.3, 1000);
		value.add(10, 0, 0.25, 1008);
		value.add(11, 0, 0.015, 1010);
		value.add(12, 0, 0.014, 1015);
		value.add(13, 0, 0.09, 1018);
		value.add(20, 0, 0.2, 1025);

		const strokes = value.finishReleaseFiltered();

		expect(strokes).toHaveLength(1);
		expect(strokes[0]!.points.map((point) => point.x)).toEqual([0, 10, 11, 12, 13, 20]);
	});

	it("preserves a genuinely light stroke when no confident contact preceded it", () => {
		const value = builder();
		value.add(0, 0, 0.012, 1000);
		value.add(10, 2, 0.016, 1010);
		value.add(20, 4, 0.02, 1020);

		const strokes = value.finishReleaseFiltered();

		expect(strokes).toHaveLength(1);
		expect(strokes[0]!.points.map((point) => point.x)).toEqual([0, 10, 20]);
	});

	it("leaves the ordinary finish path unchanged for non-inline surfaces", () => {
		const value = builder();
		value.add(0, 0, 0.4, 1000);
		value.add(10, 0, 0.3, 1008);
		value.add(25, 2, 0.01, 1020);

		const stroke = value.finish();

		expect(stroke!.points.map((point) => point.x)).toEqual([0, 10, 25]);
	});
});

/**
 * LIGHT RUNS LONGER THAN A BOUNCE ARE WRITING (2026-09-15; the ink loss in
 * Alan's trace d1c16bdb).
 *
 * Pressure cannot tell release travel from a deliberate light glide: Alan's
 * in-contact glide went as low as 0.0039, below the fixture's release values.
 * Duration can. A light run is release travel only while it lasts at most
 * RELEASE_MAX_MS, timed from its FIRST light sample to its last. A still hold
 * at confident pressure before the run is not part of it. A longer run is
 * writing and stays whole, unsplit, whether it sits mid-stroke or at the end
 * (real captures show no light run at any stroke end: a real lift is a single
 * sample, below RELEASE_MIN_MS). The edge-inclusive time gate RELEASE_MIN_MS
 * is unchanged.
 *
 * Every run below passes the pressure, time and travel gates, so the keep or
 * the removal is the ceiling's doing and nothing else.
 */
describe("inline pen release filtering: light runs longer than a bounce are writing", () => {
	/**
	 * A confident stroke, then 12 light samples whose first-to-last span is
	 * `lightMs`, starting 4 ms after the release edge; then renewed contact,
	 * unless `terminal`.
	 */
	function withLightRun(lightMs: number, terminal = false): { value: StrokeBuilder; added: number[] } {
		const value = builder();
		const added: number[] = [];
		const add = (x: number, p: number, t: number): void => {
			if (value.add(x, 0, p, t)) added.push(x);
		};
		add(0, 0.4, 1000);
		add(4, 0.3, 1004); // the release edge
		const first = 1008;
		const steps = 12;
		for (let k = 0; k < steps; k++) {
			// Light, and moving 3 world px a sample: the travel gate is met many times over.
			add(7 + 3 * k, k === steps - 1 ? 0.004 : 0.02 - 0.0012 * k, first + (lightMs * k) / (steps - 1));
		}
		if (!terminal) {
			const end = first + lightMs;
			add(7 + 3 * steps + 3, 0.05, end + 4);
			add(7 + 3 * steps + 6, 0.2, end + 8);
			add(7 + 3 * steps + 9, 0.3, end + 12);
		}
		return { value, added };
	}

	it("keeps a 188 ms light glide between two confident contacts whole, as one stroke (Alan's d1c16bdb shape)", () => {
		const { value, added } = withLightRun(188);
		const strokes = value.finishReleaseFiltered();
		expect(strokes, "no split around a glide").toHaveLength(1);
		expect(strokes[0]!.points.map((point) => point.x), "every sample the wet layer drew is committed").toEqual(added);
	});

	it("keeps a light run that recovers whole at the ceiling and a millisecond over it", () => {
		expect(RELEASE_MAX_MS).toBeGreaterThan(RELEASE_MIN_MS_FOR_TEST);
		for (const lightMs of [RELEASE_MAX_MS, RELEASE_MAX_MS + 1]) {
			const run = withLightRun(lightMs);
			const kept = run.value.finishReleaseFiltered();
			expect(kept, `a ${lightMs} ms run between two contacts is writing`).toHaveLength(1);
			expect(kept[0]!.points.map((point) => point.x)).toEqual(run.added);
		}
	});

	it("applies the same ceiling at the end of a contact: a long light ending stays, a short light tail goes", () => {
		const long = withLightRun(188, true);
		const kept = long.value.finishReleaseFiltered();
		expect(kept).toHaveLength(1);
		expect(kept[0]!.points.map((point) => point.x), "a 188 ms light ending is writing").toEqual(long.added);
		const short = withLightRun(RELEASE_MAX_MS, true).value.finishReleaseFiltered();
		expect(short).toHaveLength(1);
		expect(short[0]!.points.map((point) => point.x), "a tail within the ceiling is release travel").toEqual([0, 4]);
	});

	it("does not count a still hold before the run: a 15 ms light ending after 300 ms without movement is still a tail", () => {
		const value = builder();
		value.add(0, 0, 0.4, 1000);
		value.add(8, 0, 0.5, 1100); // then the pen holds still: no sample is accepted until it moves
		value.add(12, 0, 0.01, 1400);
		value.add(20, 0, 0.01, 1415);

		const strokes = value.finishReleaseFiltered();

		expect(strokes, "the light ending is trimmed, one stroke is left").toHaveLength(1);
		expect(strokes[0]!.points.map((point) => point.x), "the stroke up to the hold").toEqual([0, 8]);
	});

	/**
	 * A confident stroke, a light run, then a lift whose last samples rise into
	 * the band between RELEASE_PRESSURE_MAX (0.025) and CONFIDENT_CONTACT_PRESSURE
	 * (0.08). Light run: 3 samples at 0.01, 3 px apart. Band samples: `band`,
	 * each 4 ms and 3 px further on. All inside the gates: 8 ms and 3 px
	 * from the release edge, and a light span far under RELEASE_MAX_MS.
	 */
	function withBandEnding(band: number[]): { strokes: ReturnType<StrokeBuilder["finishReleaseFiltered"]>; added: number[] } {
		const value = builder();
		const added: number[] = [];
		const add = (x: number, p: number, t: number): void => {
			if (value.add(x, 0, p, t)) added.push(x);
		};
		add(0, 0.4, 1000);
		add(4, 0.3, 1004); // the release edge
		add(7, 0.01, 1008);
		add(10, 0.01, 1012);
		add(13, 0.01, 1016);
		band.forEach((p, k) => add(16 + 3 * k, p, 1020 + 4 * k));
		return { strokes: value.finishReleaseFiltered(), added };
	}

	it("trims a light ending whose last samples rise into the band but never reach confident contact (0.04 to 0.07 to the lift)", () => {
		const { strokes, added } = withBandEnding([0.04, 0.06, 0.07]);

		expect(added, "the fixture adds every sample").toHaveLength(8);
		expect(strokes, "one stroke is left").toHaveLength(1);
		expect(strokes[0]!.points.map((point) => point.x), "the light run and the band samples ride together and are trimmed").toEqual([0, 4]);
	});

	it("keeps the whole stroke when the same ending reaches confident contact: 0.04, 0.06, then 0.08", () => {
		const { strokes, added } = withBandEnding([0.04, 0.06, 0.08]);

		expect(strokes, "contact came back with no lift between: one stroke").toHaveLength(1);
		expect(strokes[0]!.points.map((point) => point.x), "every sample drawn is committed").toEqual(added);
	});
});

/** StrokeBuilder's RELEASE_MIN_MS: a ceiling at or below it would make every light run writing. */
const RELEASE_MIN_MS_FOR_TEST = 8;

describe("non-finishing release-filtered snapshots", () => {
 it("owns deep points including retained pressure and tilt, without consuming the builder", () => {
  const b = new StrokeBuilder("pen", "#123456", 2);
  b.start(1000); b.add(0,0,0.4,1000,10,20); b.add(10,0,0.5,1010,30,40);
  const before = b.pointCount;
  const snapshot = b.snapshotReleaseFiltered();
  b.add(10,0,0.9,1020,50,60);
  expect(snapshot[0]!.points[1]!.pressure).toBe(0.5);
  snapshot[0]!.points[0]!.x = 99;
  expect(b.finishReleaseFiltered()[0]!.points[0]!.x).toBe(0);
  expect(b.pointCount).toBe(before);
  b.add(20,0,0.5,1030);
  expect(b.finishReleaseFiltered()[0]!.points).toHaveLength(3);
 });
 it("uses the same release groups and profile as lift", () => {
  const b = new StrokeBuilder("pen", "#123456", 2);
  b.start(0); b.add(0,0,0.4,0); b.add(10,0,0.4,10); b.add(20,0,0.01,20); b.add(30,0,0.01,30);
  const snapshot=b.snapshotReleaseFiltered(), final=b.finishReleaseFiltered();
  expect(snapshot).toHaveLength(1);
  expect(snapshot[0]!.points.map(p=>p.x)).toEqual([0,10]);
  expect(snapshot.map(s=>[s.points,s.width,s.pressureProfile])).toEqual(final.map(s=>[s.points,s.width,s.pressureProfile]));
  expect(snapshot[0]!.points[0]).not.toBe(final[0]!.points[0]);
 });
});

describe("release filter: a point that arrives light and is then held and pressed", () => {
	it("keeps the whole stroke when the held pen reaches confident pressure on the point", () => {
		const b = new StrokeBuilder("pen", "#000", 2);
		b.start(1000);
		const drawn: number[] = [];
		const add = (x: number, p: number, t: number) => {
			if (b.add(x, 0, p, t)) drawn.push(x);
		};
		add(0, 0.4, 1000);
		add(4, 0.4, 1008);
		add(8, 0.02, 1020);
		expect(b.add(8.05, 0, 0.4, 1030)).toBeUndefined();

		const strokes = b.finishReleaseFiltered();

		expect(strokes).toHaveLength(1);
		expect(strokes[0]!.points.map((p) => p.x), "the pressed point is committed with the stroke").toEqual(drawn);
	});
});

describe("a held pen's later pressure stays off the saved point", () => {
	it("saves the pressure the point arrived with, which the wet layer drew", () => {
		const b = new StrokeBuilder("pen", "#000", 2);
		b.start(0);
		b.add(0, 0, 0.2, 0);
		expect(b.add(0.05, 0, 0.9, 8)).toBeUndefined();
		b.add(4, 0, 0.2, 16);
		expect(b.finishReleaseFiltered()[0]!.points.map((p) => p.pressure)).toEqual([0.2, 0.2]);
	});
	it("forgets a held press at the next start, so a light ending there is still release", () => {
		const b = new StrokeBuilder("pen", "#000", 2);
		b.start(1000);
		b.add(0, 0, 0.4, 1000);
		b.add(4, 0, 0.4, 1008);
		b.add(8, 0, 0.02, 1020);
		expect(b.add(8.05, 0, 0.4, 1030)).toBeUndefined();
		b.start(2000);
		b.add(0, 0, 0.4, 2000);
		b.add(4, 0, 0.4, 2008);
		b.add(8, 0, 0.02, 2020);
		expect(b.finishReleaseFiltered()[0]!.points.map((p) => p.x)).toEqual([0, 4]);
	});
});
