import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The production long-frame observer, driven through a PerformanceObserver stand-in: the regression cells for
 * two defects found in review. A frame that spans the lift is delivered after it, and the report must still
 * show it; the frame's style and layout time is reported.
 */

// Exercise the production BrowserLoafSource, not an injected LoafSource.
async function rig() {
	vi.resetModules();
	let deliver: (entries: unknown[]) => void = () => { throw new Error("observer not started"); };
	let reads = 0;
	class Observer {
		static supportedEntryTypes = ["long-animation-frame"];
		constructor(callback: (list: { getEntries(): unknown[] }) => void) {
			deliver = entries => callback({ getEntries: () => entries });
		}
		observe() {}
		takeRecords() { reads++; return []; }
		disconnect() {}
	}
	vi.stubGlobal("PerformanceObserver", Observer);
	const { StrokeMetrics } = await import("./StrokeMetrics");
	const metrics = new StrokeMetrics();
	return { StrokeMetrics, metrics, deliver: (entries: unknown[]) => deliver(entries), reads: () => reads };
}

const frame = (startTime = 120, duration = 140) => ({
	entryType: "long-animation-frame", startTime, duration, blockingDuration: 90,
	renderStart: startTime + duration - 40,
	styleAndLayoutStart: startTime + duration - 30,
	scripts: [{ invoker: "PointerEvent.onpointerup", sourceURL: "app://obsidian.md/main.js", sourceFunctionName: "finish", sourceCharPosition: 25, duration: 70, forcedStyleAndLayoutDuration: 17 }],
});

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe("production long-frame observer", () => {
	it("keeps a delivered overlap and excludes frames outside the stroke", async () => {
		const r = await rig();
		r.metrics.begin("ink", 100);
		r.deliver([frame(0, 60), frame(), frame(500, 60)]);
		const summary = r.metrics.end(400);
		expect(summary.loaf.frames.map(f => f.startTime)).toEqual([120]);
		expect(r.StrokeMetrics.summaryText(summary)).toContain("long frames 1");
		expect(r.reads()).toBe(1);
	});

	it("retains a terminal overlapping frame delivered after pen-up", async () => {
		const r = await rig();
		r.metrics.begin("ink", 100);
		const summary = r.metrics.end(180);
		// The rendering task cannot report its own completed frame before
		// finishing. Delivery after end models that required API ordering.
		r.deliver([frame()]);
		const text = r.StrokeMetrics.summaryText(summary);
		expect(text, "A completed overlapping frame must appear when the report is read after observer delivery").toContain("long frames 1");
		expect(text).toContain("PointerEvent.onpointerup");
	});

	it("reports the measured style/layout duration required by the instrument brief", async () => {
		const r = await rig();
		r.metrics.begin("ink", 100);
		r.deliver([frame()]);
		const summary = r.metrics.end(400);
		const text = r.StrokeMetrics.summaryText(summary);
		expect(text, "Frame end 260 minus styleAndLayoutStart 230 is 30ms").toMatch(/style[^\n]*layout[^\n]*30(?:\.0+)?\s*ms/i);
	});

	it("retains an unread late frame after the shared observer buffer turns over", async () => {
		const r = await rig();
		r.metrics.begin("ink", 100);
		const summary = r.metrics.end(180);
		r.deliver([frame()]);
		for (let i = 0; i < 64; i++) r.deliver([frame(500 + i * 100, 60)]);
		const text = r.StrokeMetrics.summaryText(summary);
		expect(text, "The report is first read after 64 later long frames; the frame that spans the lift is still there").toContain("long frames 1");
		expect(text).toContain("PointerEvent.onpointerup");
	});

	it("retains the same late frame when the report was read before buffer turnover", async () => {
		const r = await rig();
		r.metrics.begin("ink", 100);
		const summary = r.metrics.end(180);
		r.deliver([frame()]);
		expect(r.StrokeMetrics.summaryText(summary)).toContain("long frames 1");
		for (let i = 0; i < 64; i++) r.deliver([frame(500 + i * 100, 60)]);
		expect(r.StrokeMetrics.summaryText(summary)).toContain("long frames 1");
	});

	it("keeps late frames in their stroke window without another observer flush", async () => {
		const r = await rig();
		r.metrics.begin("ink", 100);
		const first = r.metrics.end(180);
		r.metrics.begin("ink", 500);
		const second = r.metrics.end(580);
		r.deliver([frame(), frame(520, 140)]);
		expect(first.loaf.frames.map(f => f.startTime)).toEqual([120]);
		expect(second.loaf.frames.map(f => f.startTime)).toEqual([520]);
		r.StrokeMetrics.summaryText(first);
		r.StrokeMetrics.summaryText(second);
		expect(r.reads()).toBe(2);
	});
});
