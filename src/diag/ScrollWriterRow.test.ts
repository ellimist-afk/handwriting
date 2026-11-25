import { afterEach, describe, expect, it, vi } from "vitest";
import { endRecordingForReport, setDiagnosticsEnabled } from "./DiagSwitch";
import { clearInlinePenTrace } from "../inline/InlinePenRouterTrace";
import { stopMainThreadProbe } from "../inline/ScrollProbe";
import { fakeScrollWindow, scrollRows, writerSlots } from "./ScrollWriterTrace.fixture";

/** Issue 66 scroll-writer row, through the recording switch, the report and the plugin's unload only. */
afterEach(() => {
	setDiagnosticsEnabled(false);
	clearInlinePenTrace();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function rig() {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const f = fakeScrollWindow();
	vi.stubGlobal("window", f.win);
	return { ...f, own: writerSlots(f.El.prototype) };
}

describe("issue 66 scroll-writer row", () => {
	it("recording on: a script write that moves a note's scroller leaves one scroll-write row with old, new and the writer", () => {
		const r = rig();
		setDiagnosticsEnabled(true);
		clearInlinePenTrace();
		const s = r.scroller(1500);
		function pageScrollStandIn() {
			s.scrollTop = 0;
		}
		pageScrollStandIn();
		const rows = scrollRows();
		expect(rows, "scroll-write rows for one write that moved the scroller").toHaveLength(1);
		expect(rows[0]).toContain("scrollTop 1500 -> 0 via scrollTop=0");
		expect(rows[0], "the row names the writer").toContain("stack: pageScrollStandIn (script)");
	});

	it("recording off: the window's own scroll slots stay, a write reads no scrollTop and leaves no row", () => {
		const r = rig();
		setDiagnosticsEnabled(true);
		setDiagnosticsEnabled(false);
		clearInlinePenTrace();
		expect(writerSlots(r.El.prototype), "slots after recording stopped").toEqual(r.own);
		const s = r.scroller(1500);
		r.reads.count = 0;
		s.scrollTop = 0;
		s.scrollTo(0, 700);
		r.child(s, 300).scrollIntoView();
		expect(r.reads.count, "scrollTop reads by writes with recording off").toBe(0);
		setDiagnosticsEnabled(true);
		expect(scrollRows(), "rows written with recording off").toHaveLength(0);
	});

	it("showing a report and the plugin's unload each put the window's own slots back; a write after unload leaves no row", () => {
		const r = rig();
		setDiagnosticsEnabled(true);
		expect(endRecordingForReport(), "a report stops a live recording").toBe(true);
		expect(writerSlots(r.El.prototype), "slots after a report").toEqual(r.own);
		setDiagnosticsEnabled(true);
		clearInlinePenTrace();
		stopMainThreadProbe();
		expect(writerSlots(r.El.prototype), "slots after unload").toEqual(r.own);
		const s = r.scroller(1500);
		s.scrollTop = 0;
		expect(scrollRows(), "rows from a write after unload, switch still on").toHaveLength(0);
	});
});
