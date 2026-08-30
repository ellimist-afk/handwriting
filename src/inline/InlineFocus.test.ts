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

	it("does not focus at all when suppressed, however unfocused the view", () => {
		// On a touch device this call IS what raises the software keyboard,
		// once per pen-down, and hiding the keyboard blurs the editor so the
		// next stroke raises it again.
		let focused = 0;
		const view = { hasFocus: false, focus: () => void focused++ };
		focusClaimedPenEditor(view, true);
		focusClaimedPenEditor(view, true);
		expect(focused).toBe(0);
	});
});
