import { beforeEach, describe, expect, it } from "vitest";
import { presentLagMs, recordPresentAge, resetLatencyEstimate } from "./LatencyEstimate";

function feed(ms: number, times: number): void {
	for (let i = 0; i < times; i++) recordPresentAge(ms);
}

describe("presentation latency estimate", () => {
	beforeEach(() => resetLatencyEstimate());

	it("has no opinion until it has seen enough", () => {
		expect(presentLagMs()).toBeUndefined();
		feed(10, 23);
		expect(presentLagMs()).toBeUndefined();
		feed(10, 1);
		expect(presentLagMs()).toBe(10);
	});

	it("reports the median of what it has seen", () => {
		feed(6, 20);
		feed(30, 10);
		// 30 samples: twenty 6s then ten 30s, median sits in the 6s.
		expect(presentLagMs()).toBe(6);
	});

	it("does not let one stall move the horizon", () => {
		feed(8, 30);
		expect(presentLagMs()).toBe(8);
		// A GC pause or a dragged window. Plausible enough to be recorded,
		// and a mean would move; the median must not.
		recordPresentAge(200);
		expect(presentLagMs()).toBe(8);
	});

	it("drops samples that are stalls rather than latency", () => {
		feed(10, 12);
		// Twelve more, all past the plausible ceiling. If these counted, the
		// estimate would both warm up and read ~300ms.
		feed(600, 12);
		expect(presentLagMs()).toBeUndefined();
	});

	it("ignores garbage rather than poisoning the window", () => {
		feed(10, 24);
		recordPresentAge(Number.NaN);
		recordPresentAge(-5);
		recordPresentAge(Number.POSITIVE_INFINITY);
		expect(presentLagMs()).toBe(10);
	});

	it("forgets a machine's old behaviour as the window rolls", () => {
		feed(10, 64);
		expect(presentLagMs()).toBe(10);
		// A full window of a slower state - plugged in to battery, another
		// app taking the GPU - and the estimate follows rather than
		// averaging the two forever.
		feed(40, 64);
		expect(presentLagMs()).toBe(40);
	});
});
