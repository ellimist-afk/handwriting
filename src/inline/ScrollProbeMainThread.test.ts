import { afterEach, describe, expect, it, vi } from "vitest";
import { diagnosticsEpoch, endRecordingForReport, endRecordingIfCurrent, setDiagnosticsEnabled } from "../diag/DiagSwitch";
import { clearScrollProbe, formatScrollProbe, scrollProbeSchedule } from "./ScrollProbe";

/**
 * The main-thread probe in the diagnostics capture: a GAP line for every gap timer run more than 20 ms after it was
 * due, a LONGTASK line for every long task Chromium reports, and nothing at all while diagnostics are off: no timer,
 * no observer, no entry. Timers are faked, the clock is stubbed and the observer is a stand-in, so every number below
 * is exact.
 */

let now = 0;
let made = 0;
let live = 0;
let observed: unknown[] = [];
let deliver: (entries: unknown[]) => void = () => {
	throw new Error("observer not started");
};

class Observer {
	static supportedEntryTypes = ["longtask"];
	constructor(callback: (list: { getEntries(): unknown[] }) => void) {
		made++;
		deliver = (entries) => callback({ getEntries: () => entries });
	}
	observe(options: unknown): void {
		live++;
		observed.push(options);
	}
	disconnect(): void {
		live--;
	}
}

function rig(): void {
	now = 1000;
	made = 0;
	live = 0;
	observed = [];
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	vi.spyOn(performance, "now").mockImplementation(() => now);
	vi.stubGlobal("PerformanceObserver", Observer);
	setDiagnosticsEnabled(false);
	clearScrollProbe();
}

const linesOf = (pattern: RegExp): string[] => formatScrollProbe().split("\n").filter((l) => pattern.test(l));

afterEach(() => {
	setDiagnosticsEnabled(false);
	clearScrollProbe();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("scroll probe main-thread gap line", () => {
	it("prints one GAP line for a timer run more than 20 ms late, from the time it was due, and none for 20 ms", () => {
		rig();
		setDiagnosticsEnabled(true); // the gap timer is due at 1010
		scrollProbeSchedule("gap-test"); // the timeline's zero, at 1000
		now = 1030;
		vi.advanceTimersByTime(10); // ran 20 ms late: not a gap; next due 1040
		now = 1075;
		vi.advanceTimersByTime(10); // ran 35 ms late: a gap from 1040; next due 1085
		now = 1085;
		vi.advanceTimersByTime(10); // on time
		const lines = linesOf(/ GAP {6}/);
		expect(lines, formatScrollProbe()).toHaveLength(1);
		expect(lines[0]).toMatch(/^ +75\.0 {2}GAP {6}start=40\.0 len=35\.0ms$/);
	});

	it("marks a gap whose timer ran while the window was hidden, where Chromium slows timers on purpose", () => {
		rig();
		vi.stubGlobal("document", { visibilityState: "hidden" });
		setDiagnosticsEnabled(true);
		scrollProbeSchedule("gap-test");
		now = 2000;
		vi.advanceTimersByTime(10);
		const lines = linesOf(/ GAP {6}/);
		expect(lines, formatScrollProbe()).toHaveLength(1);
		expect(lines[0]).toMatch(/^ +1000\.0 {2}GAP {6}start=10\.0 len=990\.0ms hidden$/);
	});
});

describe("scroll probe long task line", () => {
	it("prints one LONGTASK line per long task Chromium reports, with its start, length and name", () => {
		rig();
		setDiagnosticsEnabled(true);
		scrollProbeSchedule("longtask-test");
		expect(observed, "no long-task observer is watching").toEqual([{ type: "longtask" }]);
		now = 1200;
		deliver([{ entryType: "longtask", name: "self", startTime: 1100, duration: 64.5 }]);
		const lines = linesOf(/ LONGTASK /);
		expect(lines, formatScrollProbe()).toHaveLength(1);
		expect(lines[0]).toMatch(/^ +200\.0 {2}LONGTASK start=100\.0 len=64\.5ms name=self$/);
	});

	it("makes no observer where the runtime does not offer long tasks", () => {
		rig();
		vi.stubGlobal(
			"PerformanceObserver",
			class extends Observer {
				static supportedEntryTypes = ["mark", "measure"];
			}
		);
		setDiagnosticsEnabled(true);
		expect(made).toBe(0);
	});
});

describe("scroll probe main-thread probe with recording off", () => {
	it.each([
		["the command", () => setDiagnosticsEnabled(false)],
		["showing a report", () => void endRecordingForReport()],
		["a delivered report", () => void endRecordingIfCurrent(diagnosticsEpoch())],
	])("has no timer and no observer before recording, one of each during it, and none after %s ends it", (_how, stop) => {
		rig();
		now = 2000;
		vi.advanceTimersByTime(1000);
		expect(vi.getTimerCount(), "a timer runs with recording off").toBe(0);
		expect(made, "an observer exists with recording off").toBe(0);
		expect(formatScrollProbe()).toContain("no samples");
		setDiagnosticsEnabled(true);
		expect(vi.getTimerCount(), "the gap timer did not start with the recording").toBe(1);
		expect(live, "the long-task observer did not start with the recording").toBe(1);
		stop();
		expect(vi.getTimerCount(), "the gap timer outlived the recording").toBe(0);
		expect(live, "the long-task observer outlived the recording").toBe(0);
		now = 9000;
		vi.advanceTimersByTime(1000);
		expect(formatScrollProbe()).toContain("no samples");
	});
});
