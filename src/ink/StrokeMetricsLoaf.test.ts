import { describe, expect, it } from "vitest";
import { StrokeMetrics, type LoafFrame, type LoafSource } from "./StrokeMetrics";

/**
 * Long-animation-frame attribution in the ink metrics text. A stroke that
 * feels late with flat draw times has its lag upstream of the canvas; the
 * browser's long-animation-frame entries name the script that held the frame,
 * so each stroke's summary carries the long frames that overlapped it.
 *
 * The source is injected so these cells never depend on the host browser:
 * Node has no long-animation-frame entry type, which is the unsupported case.
 */
function fakeSource(frames: LoafFrame[], supported = true): LoafSource & { starts: number } {
	return {
		starts: 0,
		supported: () => supported,
		start() {
			this.starts++;
		},
		framesBetween: (from, to) => frames.filter((f) => f.startTime < to && f.startTime + f.duration > from),
		watch: () => {},
	};
}

const HEAVY: LoafFrame = {
	startTime: 120,
	duration: 140,
	blockingDuration: 90,
	styleAndLayoutMs: 30,
	scripts: [
		{ invoker: "PointerEvent.onpointermove", sourceURL: "app://obsidian.md/plugins/handwriting/main.js", sourceFunctionName: "onMove", sourceCharPosition: 4812, duration: 95, forcedStyleAndLayoutMs: 12 },
		{ invoker: "FrameRequestCallback", sourceURL: "app://obsidian.md/app.js", sourceFunctionName: "", sourceCharPosition: 77, duration: 30, forcedStyleAndLayoutMs: 0 },
	],
};

describe("StrokeMetrics long-animation-frame attribution", () => {
	it("attributes each overlapping long frame to its scripts: source, invoker, duration", () => {
		const m = new StrokeMetrics(fakeSource([HEAVY]));
		m.begin("ink", 100);
		const s = m.end(400);

		expect(s.loaf.supported).toBe(true);
		expect(s.loaf.frames).toHaveLength(1);
		const text = StrokeMetrics.summaryText(s);
		expect(text).toContain("long frames 1  140/140ms  blocking 90ms");
		expect(text).toContain("  frame 140ms  blocking 90ms  style/layout 30ms");
		expect(text).toContain("  script 95ms  PointerEvent.onpointermove  onMove main.js:4812  forced style/layout 12ms");
		expect(text).toContain("  script 30ms  FrameRequestCallback  (anonymous) app.js:77");
		expect(text).not.toContain("app.js:77  forced");
	});

	it("keeps only frames that overlap the stroke", () => {
		const before: LoafFrame = { ...HEAVY, startTime: 0, duration: 60 };
		const after: LoafFrame = { ...HEAVY, startTime: 500, duration: 60 };
		const m = new StrokeMetrics(fakeSource([before, HEAVY, after]));
		m.begin("ink", 100);
		const s = m.end(400);

		expect(s.loaf.frames.map((f) => f.startTime)).toEqual([120]);
	});

	it("prints a measured zero when supported and no frame was long", () => {
		const m = new StrokeMetrics(fakeSource([]));
		m.begin("ink", 0);
		const text = StrokeMetrics.summaryText(m.end(100));

		expect(text).toContain("long frames 0");
		expect(text).not.toContain("long frames (not recorded)");
	});

	it("says not recorded when the browser has no long-animation-frame entries", () => {
		const m = new StrokeMetrics(fakeSource([HEAVY], false));
		m.begin("ink", 100);
		const s = m.end(400);

		expect(s.loaf.supported).toBe(false);
		expect(s.loaf.frames).toHaveLength(0);
		expect(StrokeMetrics.summaryText(s)).toContain("long frames (not recorded)");
	});

	it("bounds the text: the three longest frames, three longest scripts each", () => {
		const scripts = [10, 40, 20, 30].map((d, i) => ({ ...HEAVY.scripts[0]!, sourceFunctionName: `f${i}`, duration: d }));
		const frames = [60, 90, 70, 80].map((d, i) => ({ ...HEAVY, startTime: 110 + i, duration: d, scripts }));
		const m = new StrokeMetrics(fakeSource(frames));
		m.begin("ink", 100);
		const text = StrokeMetrics.summaryText(m.end(400));

		expect(text).toContain("long frames 4  75/90ms");
		expect(text.match(/^ {2}frame /gm)).toHaveLength(3);
		expect(text).not.toContain("frame 60ms");
		expect(text.match(/^ {2}script /gm)).toHaveLength(9);
		expect(text).not.toContain("script 10ms");
	});

	it("touches the source once per stroke, never per pointer event", () => {
		const src = fakeSource([]);
		const m = new StrokeMetrics(src);
		m.begin("ink", 0);
		m.recordEvent("move", 1, 1, true);
		m.recordEvent("move", 1, 1, true);
		m.end(10);
		m.begin("ink", 20);
		m.end(30);

		expect(src.starts).toBe(2);
	});
});
