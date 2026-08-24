import { describe, expect, it, vi } from "vitest";
import { focusClaimedPenEditor } from "./InlineFocus";

describe("inline pen focus", () => {
	it("focuses the editor after a claimed pen contact cancelled native focus", () => {
		const focus = vi.fn();
		focusClaimedPenEditor({ hasFocus: false, focus });
		expect(focus).toHaveBeenCalledOnce();
	});

	it("does not refocus an editor that already owns the keyboard", () => {
		const focus = vi.fn();
		focusClaimedPenEditor({ hasFocus: true, focus });
		expect(focus).not.toHaveBeenCalled();
	});
});
