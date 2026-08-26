/**
 * When the floating pen-tools strip shows (roadmap wishlist: pen GUI).
 *
 * Mobile always shows it: the palette lives in a toolbar the pen keeps
 * hidden, so the strip is the only path. Desktop is the judgment call - a
 * keyboard user writing prose does not want floating chrome, and a Surface
 * in tablet mode has exactly the iPad's problem. "auto" resolves it without
 * a setting safari: the strip appears the first time a pen is actually
 * seen (hover or contact) and stays for the session. "show" and "hide"
 * override in either direction, for the people auto guesses wrong about.
 */

export type PenToolsMode = "auto" | "show" | "hide";

export const PEN_TOOLS_MODES: readonly PenToolsMode[] = ["auto", "show", "hide"];

let mode: PenToolsMode = "auto";
let penSeen = false;

export function getPenToolsMode(): PenToolsMode {
	return mode;
}

export function setPenToolsMode(m: PenToolsMode): void {
	mode = m;
}

export function normalizePenToolsMode(raw: unknown): PenToolsMode {
	return raw === "show" || raw === "hide" ? raw : "auto";
}

export function nextPenToolsMode(cur: PenToolsMode): PenToolsMode {
	const i = PEN_TOOLS_MODES.indexOf(cur);
	return PEN_TOOLS_MODES[(i + 1) % PEN_TOOLS_MODES.length] ?? "auto";
}

/** A pen existed this session (hover counts: it is proof enough). */
export function markPenSeen(): void {
	penSeen = true;
}

export function penSeenThisSession(): boolean {
	return penSeen;
}

/** The whole visibility rule, pure. */
export function penToolsVisible(m: PenToolsMode, isMobile: boolean, seen: boolean): boolean {
	if (m === "show") return true;
	if (m === "hide") return false;
	return isMobile || seen;
}

/** Test seam. */
export function resetPenToolsForTest(): void {
	mode = "auto";
	penSeen = false;
}
