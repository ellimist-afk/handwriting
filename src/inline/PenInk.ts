/**
 * The pen-off switch: let the keyboard have the note.
 *
 * TWO REPORTS, both e-ink (1.4.10-design.md §30). Boox 4c: "I couldn't see
 * how to toggle it off or activate the keyboard input when I needed it". Boox
 * 5c: the pen fights the keyboard in live preview. Neither of them is asking
 * for a different TOOL - `InkTool` is `"pen" | "highlighter"` and has no off
 * value, every strip button selects a tool, and collapsing the strip stops
 * nothing. They are asking for the pen to stop being ours for a while, so a
 * tap can place a caret and the software keyboard can come up.
 *
 * So this is not a tool and it is not the tip's mode: it is whether the
 * router CLAIMS the pen at all. Off means the pen is a native pointer on that
 * surface - taps place the caret (which on a touch device raises the
 * keyboard, which is the whole point), drags select, swipes scroll - exactly
 * as if this plugin were not installed. One gate, at the router, rather than
 * an "off" member on `InkTool`: a tool is a thing the tip DOES, and every
 * path that claims a contact would then have to remember to ask whether the
 * tool it holds is the one that means "do not claim". Asking once, at the
 * claim, is the only place the answer can be complete.
 *
 * SESSION ONLY, never written to data.json (design §5). Nobody should open
 * the app tomorrow to a plugin that looks broken because of a toggle they
 * flipped for one paragraph yesterday; the state defaults to ON at every
 * launch and the worst a forgotten toggle costs is a relaunch.
 *
 * NOTE SURFACES ONLY. The note overlay passes `penOff: () => !penInkEnabled()`
 * to its router; the pdf surface passes nothing and keeps inking. The 4c
 * user's own words are that they type with the Boox recogniser and want the
 * plugin on PDFs - there is no keyboard use case on a PDF, and taking the pen
 * away there would answer a request nobody made.
 *
 * MOUSE INK IS UNTOUCHED. `mouseActsAsPen` (MouseInk.ts) is a different
 * question with a different answer: this is about the pen the router claims,
 * and a mouse user who armed mouse ink still has the editor's own text
 * selection to give up or keep.
 *
 * MouseInk's shape, deliberately: module state, two tiny functions, no
 * obsidian import, so it loads under vitest and both the router and the strip
 * can read it without either importing the other.
 */

let enabled = true;

export function penInkEnabled(): boolean {
	return enabled;
}

export function setPenInk(on: boolean): void {
	enabled = on;
}

/**
 * Test seam, and the reason it exists rather than tests calling
 * `setPenInk(true)`: the default is the fact under test in half of them, and
 * a reset that spells the default out at each call site is a second copy of
 * it that can drift from this one.
 */
export function resetPenInkForTest(): void {
	enabled = true;
}
