/**
 * Wiring in main.ts for two diagnostics defects: a report ending the recording must repaint the
 * toolbars' recording dot (audit 142), and a report's delivery callback must not end a newer
 * recording (audit 141).
 */
import { describe, expect, it } from "vitest";
import mainSource from "./main.ts?raw";

const source = mainSource.replace(/\r\n/g, "\n");

describe("recording dot follows the switch (audit 142)", () => {
	it("the diagnostics-changed listener repaints every strip", () => {
		const at = source.indexOf("setDiagnosticsChangedListener(() => {");
		expect(at).toBeGreaterThan(0);
		const end = source.indexOf("});", at);
		expect(source.slice(at, end)).toContain("refreshAllStrips()");
	});
});

describe("delivery callbacks check the epoch (audit 141)", () => {
	it("each pen-trace modal captures the epoch and ends the recording only through it", () => {
		const opens = [...source.matchAll(/new DiagnosticTextModal\(\s*this\.app,\s*"Handwriting pen trace/g)];
		expect(opens).toHaveLength(2);
		for (const m of opens) {
			const from = m.index ?? 0;
			const window = source.slice(Math.max(0, from - 200), from + 2500);
			expect(window, "epoch captured before the modal").toMatch(/const epoch\w* = diagnosticsEpoch\(\)/);
			expect(window).toMatch(/endRecordingIfCurrent\(epoch\w*\)/);
			expect(window).not.toMatch(/\n\s*setDiagnosticsEnabled\(false\);\s*\n\s*\/\/ Cleared as well/);
		}
	});
});
