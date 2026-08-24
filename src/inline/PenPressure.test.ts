import { describe, expect, it } from "vitest";

import { normalizeInlinePenPressure } from "./PenPressure";

describe("inline pen pressure", () => {
	it("preserves exact zero so release travel cannot look like renewed contact", () => {
		expect(normalizeInlinePenPressure(0)).toBe(0);
	});

	it("clamps finite values and uses the standard fallback only for invalid input", () => {
		expect(normalizeInlinePenPressure(-1)).toBe(0);
		expect(normalizeInlinePenPressure(2)).toBe(1);
		expect(normalizeInlinePenPressure(Number.NaN)).toBe(0.5);
	});
});
