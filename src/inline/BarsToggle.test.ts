import { describe, expect, it } from "vitest";
import { normalizeBarsRestore } from "./BarsToggle";

/**
 * What survives the cleanup. `toggleBars` and `BarsSettings` are gone with the
 * command that used them (the canvas work left the toolbar half in main.ts,
 * written inline against the live settings), so the cells that drove the pair
 * through a toggle are gone too - they described a function, not a shipped
 * behaviour, and the behaviour they would have pinned is now main.ts's.
 *
 * `normalizeBarsRestore` stays live: every existing data.json holds a
 * `barsRestore` pair written by the old command, and it is read at every load.
 * These are its cells, unchanged.
 */
describe("normalizeBarsRestore", () => {
	it("keeps a well-formed pair", () => {
		expect(normalizeBarsRestore({ penTools: "show", noteZoomControls: "hide" })).toEqual({ penTools: "show", noteZoomControls: "hide" });
	});

	it("reads anything else in data.json as nothing remembered", () => {
		for (const raw of [undefined, null, 3, "auto", {}, { penTools: "show" }, { penTools: "big", noteZoomControls: "auto" }]) {
			expect(normalizeBarsRestore(raw), JSON.stringify(raw)).toBeNull();
		}
	});

	it("keeps an Auto pair, the value the split command still carries through", () => {
		expect(normalizeBarsRestore({ penTools: "auto", noteZoomControls: "auto" })).toEqual({ penTools: "auto", noteZoomControls: "auto" });
	});
});
