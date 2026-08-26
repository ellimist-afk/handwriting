import { beforeEach, describe, expect, it } from "vitest";
import {
	markPenSeen,
	nextPenToolsMode,
	normalizePenToolsMode,
	penSeenThisSession,
	penToolsVisible,
	resetPenToolsForTest,
} from "./PenToolsMode";

describe("pen tools visibility", () => {
	beforeEach(resetPenToolsForTest);

	it("auto: mobile always, desktop only once a pen was seen", () => {
		expect(penToolsVisible("auto", true, false)).toBe(true);
		expect(penToolsVisible("auto", false, false)).toBe(false);
		expect(penToolsVisible("auto", false, true)).toBe(true);
	});

	it("show and hide override auto in both directions", () => {
		expect(penToolsVisible("show", false, false)).toBe(true);
		expect(penToolsVisible("hide", true, true)).toBe(false);
	});

	it("cycles auto -> show -> hide -> auto", () => {
		expect(nextPenToolsMode("auto")).toBe("show");
		expect(nextPenToolsMode("show")).toBe("hide");
		expect(nextPenToolsMode("hide")).toBe("auto");
	});

	it("normalizes junk to auto", () => {
		expect(normalizePenToolsMode("hide")).toBe("hide");
		expect(normalizePenToolsMode("banana")).toBe("auto");
	});

	it("pen sightings latch for the session", () => {
		expect(penSeenThisSession()).toBe(false);
		markPenSeen();
		expect(penSeenThisSession()).toBe(true);
	});
});
