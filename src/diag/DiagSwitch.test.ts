import { afterEach, describe, expect, it } from "vitest";
import {
	DIAG_OFF_NOTE,
	diagnosticsEnabled,
	endRecordingForReport,
	setDiagnosticsEnabled,
} from "./DiagSwitch";
import {
	clearScrollProbe,
	formatScrollProbe,
	scrollProbeWheel,
} from "../inline/ScrollProbe";

describe("diagnostics master switch (v0.13.0 cleanup)", () => {
	afterEach(() => {
		setDiagnosticsEnabled(false);
		clearScrollProbe();
	});

	it("is OFF by default", () => {
		expect(diagnosticsEnabled()).toBe(false);
	});

	it("records nothing while off — ordinary writing pays one boolean check", () => {
		scrollProbeWheel(
			{ deltaX: 10, deltaY: 0, deltaMode: 0, ctrlKey: false } as WheelEvent,
			100,
			0,
			false
		);
		expect(formatScrollProbe()).toContain(DIAG_OFF_NOTE);
	});

	it("records once enabled, and the off-banner disappears", () => {
		setDiagnosticsEnabled(true);
		scrollProbeWheel(
			{ deltaX: 10, deltaY: 0, deltaMode: 0, ctrlKey: false } as WheelEvent,
			100,
			0,
			false
		);
		const out = formatScrollProbe();
		expect(out).toContain("wheel events            : 1");
		expect(out).not.toContain(DIAG_OFF_NOTE);
	});
});

describe("endRecordingForReport (showing a report ends the capture)", () => {
	afterEach(() => setDiagnosticsEnabled(false));

	it("ends a running capture and reports that it did", () => {
		setDiagnosticsEnabled(true);
		expect(endRecordingForReport()).toBe(true);
		expect(diagnosticsEnabled()).toBe(false);
	});

	it("is a no-op when nothing was recording", () => {
		setDiagnosticsEnabled(false);
		expect(endRecordingForReport()).toBe(false);
		expect(diagnosticsEnabled()).toBe(false);
	});

	it("showing the same report twice only announces the stop once", () => {
		setDiagnosticsEnabled(true);
		endRecordingForReport();
		expect(endRecordingForReport()).toBe(false);
	});
});
