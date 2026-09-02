/**
 * What an Escape key should do to ONE MobileTools strip, decided without
 * touching the DOM.
 *
 * Every strip's `escapeKey` listens on `parent.ownerDocument`, in capture,
 * because that is the only place a key reaches while focus sits in the
 * editor - the same reason `outsideTap` is already document-wide. In a
 * split view each pane has its own strip and its own listener on the SAME
 * document, so a press of Escape reaches every strip in the pane's window
 * at once. The bug this module exists to prevent (audit doc §5p, tools-59,
 * 2026-09-02, before it was committed): "The listener has to sit somewhere
 * document-wide to be heard while focus is in the editor, but EVERY pane
 * has its own MobileTools with its own listener. In a split view, with a
 * pop open in pane A, pressing Escape while working in pane B closes A's
 * pop AND consumes the key, so B's selection never clears. outsideTap has
 * the same document-wide reach and is harmless only because it never
 * consumes."
 *
 * The rule: every strip closes its own pops on an un-prevented Escape,
 * unconditionally, the same as `outsideTap` already reaches document-wide.
 * But a strip only CONSUMES the key - `preventDefault` + `stopPropagation`,
 * so nothing downstream (a lasso selection, a pdf selection) also reacts to
 * the same press - when something was actually open HERE and the event's
 * target sits inside THIS strip's own pane. Ownership is what decides
 * consumption, not "did I close something": pane A closing its own pop is
 * real work and does not entitle it to eat a key meant for pane B.
 */
export type StripEscapeVerdict = "ignore" | "close" | "close-consume";

export function stripEscapeVerdict(input: {
	key: string;
	defaultPrevented: boolean;
	anyOpen: boolean;
	ownsTarget: boolean;
}): StripEscapeVerdict {
	if (input.key !== "Escape" || input.defaultPrevented) return "ignore";
	// Nothing open: today's behaviour, exact - the key is left untouched for
	// whatever else in the editor wants it (a lasso selection, a pdf selection).
	if (!input.anyOpen) return "ignore";
	return input.ownsTarget ? "close-consume" : "close";
}
