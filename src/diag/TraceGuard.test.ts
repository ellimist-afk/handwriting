import { describe, expect, it } from "vitest";
import { traceGuardVerdict } from "./TraceGuard";

describe("traceGuardVerdict (Y1, 1.4.6-design.md §5g)", () => {
	it("proceeds once the trace has events, recording state aside", () => {
		expect(traceGuardVerdict(1, true)).toBe("proceed");
		expect(traceGuardVerdict(1, false)).toBe("proceed");
	});

	it("asks for a reproduction when recording is on but nothing landed yet", () => {
		expect(traceGuardVerdict(0, true)).toBe("reproduce");
	});

	it("asks for Bug report: record first when nothing is recording either", () => {
		expect(traceGuardVerdict(0, false)).toBe("record-first");
	});
});
