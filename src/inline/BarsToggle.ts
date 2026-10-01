import type { NoteZoomControlsMode } from "./NoteZoomControlsMode";
import type { PenToolsMode } from "./PenToolsMode";

/**
 * What `barsRestore` is, and why it is still here.
 *
 * Until 1.4.20 one command hid the pen toolbar and the note zoom bar together
 * and remembered the pair it hid, so a user on Auto came back to Auto. The canvas work
 * item 15 split that: the command is "Toolbar on / off" and moves the toolbar
 * only, because the zoom bar now answers to its own row AND to Infinite
 * Canvas, and with the canvas off there is no zoom bar for a command to put
 * back.
 *
 * The remembered PAIR outlived the command that wrote it. It is already in
 * every user's data.json, main.ts still reads and writes it (the toolbar half
 * is live; the zoom bar's mode is carried through unchanged and never read
 * back out), so the shape and its normalizer stay exactly as they were. The
 * toggle function that used to compute the pair is gone with its caller
 * - it had none left in src, and a tested helper nothing calls is a
 * second answer waiting to disagree with the one that ships.
 */
export interface BarsPair {
	penTools: PenToolsMode;
	noteZoomControls: NoteZoomControlsMode;
}

const MODES: readonly string[] = ["auto", "show", "hide"];

/** data.json's remembered pair, or null for anything that is not exactly one. */
export function normalizeBarsRestore(raw: unknown): BarsPair | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as { penTools?: unknown; noteZoomControls?: unknown };
	if (typeof r.penTools !== "string" || typeof r.noteZoomControls !== "string") return null;
	if (!MODES.includes(r.penTools) || !MODES.includes(r.noteZoomControls)) return null;
	return { penTools: r.penTools as PenToolsMode, noteZoomControls: r.noteZoomControls as NoteZoomControlsMode };
}
