import { describe, expect, it } from "vitest";
import { stripEscapeVerdict } from "./StripEscape";

describe("stripEscapeVerdict", () => {
	it("ignores anything but Escape", () => {
		expect(
			stripEscapeVerdict({ key: "a", defaultPrevented: false, anyOpen: true, ownsTarget: true })
		).toBe("ignore");
	});

	it("ignores an Escape already consumed upstream", () => {
		expect(
			stripEscapeVerdict({
				key: "Escape",
				defaultPrevented: true,
				anyOpen: true,
				ownsTarget: true,
			})
		).toBe("ignore");
	});

	it("ignores Escape when nothing is open - today's behaviour, exact", () => {
		expect(
			stripEscapeVerdict({
				key: "Escape",
				defaultPrevented: false,
				anyOpen: false,
				ownsTarget: true,
			})
		).toBe("ignore");
	});

	it("closes and consumes when a pop is open in the strip's OWN pane", () => {
		expect(
			stripEscapeVerdict({
				key: "Escape",
				defaultPrevented: false,
				anyOpen: true,
				ownsTarget: true,
			})
		).toBe("close-consume");
	});

	it("a pop open in pane A, Escape in pane B: closes, never consumes", () => {
		// Pane A's own strip sees anyOpen=true (it has the open pop) but
		// ownsTarget=false (the key landed in pane B). It must close its pop
		// so the strip does not sit open behind the user's back, but must
		// NOT consume the key - pane B's own Escape handling (its lasso
		// selection, its held tip) still needs to see this same press.
		expect(
			stripEscapeVerdict({
				key: "Escape",
				defaultPrevented: false,
				anyOpen: true,
				ownsTarget: false,
			})
		).toBe("close");
	});
});
