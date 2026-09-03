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

/**
 * Surfaces waiting to be told the answer changed.
 *
 * The note surface never needed this: `refreshPenToolsAll` (InkOverlay.ts)
 * walks InkOverlay's own set of open editors, and every place in main.ts that
 * changes the mode or marks a pen calls it on the next line. The PDF surface
 * is not in that set - main.ts holds its controllers in a different map, and
 * the note's fan-out has never looked there - so "Pen toolbar → Hide" hid the
 * strip on notes and left it on screen over every PDF (alan, 2026-09-02).
 *
 * A registry HERE rather than a second fan-out in main.ts, because the two
 * things that can change the answer - `setPenToolsMode` and `markPenSeen` -
 * both live in this file, and a subscriber therefore cannot be missed by a
 * caller who forgot to refresh. That is not hypothetical: `markPenSeen` is
 * called from inside both ink surfaces' own pen paths (InkOverlay's
 * `showPenCursor` and ink branch, PdfInkController's `showCursor` and
 * `penDown`), where no `refreshPenToolsAll` follows it and none should.
 */
type PenToolsListener = () => void;
const listeners = new Set<PenToolsListener>();

/**
 * Be told whenever `penToolsVisible` would answer differently than it just
 * did. Returns the unsubscribe, which a surface MUST call at teardown: a PDF
 * viewer is rebuilt inside a leaf that outlives it, and a controller leaking
 * one of these per teardown would hold a dead pane's strip logic alive for
 * the rest of the session.
 */
export function onPenToolsChanged(listener: PenToolsListener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/**
 * Tell everyone, and let nobody's failure stop the next.
 *
 * Copied before walking, because a listener is allowed to unsubscribe from
 * inside the call - tearing a surface down IS one of the things a mode change
 * can do - and mutating the set being iterated is how that turns into a
 * missed surface. Each call is bulkheaded for the reason every strip path in
 * this plugin is: chrome must never take the ink down with it.
 */
function announce(): void {
	for (const listener of [...listeners]) {
		try {
			listener();
		} catch (err) {
			console.error("[handwriting] pen tools listener failed", err);
		}
	}
}

export function getPenToolsMode(): PenToolsMode {
	return mode;
}

export function setPenToolsMode(m: PenToolsMode): void {
	// Only on a real change. The setting is re-applied at every settings save
	// and again at load, and announcing an unchanged answer would have every
	// open surface re-run its create-or-destroy for nothing.
	if (mode === m) return;
	mode = m;
	announce();
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
	// The false-to-true edge only. This runs on every pen-down on both
	// surfaces, and announcing on each of them would put a create-or-destroy
	// sweep in the middle of every stroke's first sample - the one place in
	// this plugin where nothing may be spent.
	if (penSeen) return;
	penSeen = true;
	announce();
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
	// The subscribers too, and not as an afterthought: this is module state
	// like the other two, and a listener left over from a surface an earlier
	// test never tore down would fire into a dead fixture on the next test's
	// first mode change.
	listeners.clear();
}

/**
 * How many surfaces are listening. Test seam, and the only witness there is
 * that a teardown actually ran its unsubscribe - a leaked listener is
 * invisible from the outside until the session has accumulated enough of them
 * to matter, which is exactly too late to notice.
 */
export function penToolsListenerCountForTest(): number {
	return listeners.size;
}
