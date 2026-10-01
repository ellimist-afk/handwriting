/**
 * When the note zoom bar (the floating +/-/Fit/100% group on the note
 * viewport) shows.
 *
 * The zoom bar behaves exactly like the pen toolbar: auto steps aside while
 * the pen inks and returns after, show is permanently on, hide is off. This
 * module mirrors `PenToolsMode.ts`'s mode plumbing one for one (same three
 * values, same default, same shape of getter/setter/normalize/next/listener/
 * reset) so the zoom bar's settings behave exactly like the pen toolbar's.
 *
 * DELIBERATELY NOT MIRRORED: `PenToolsMode.ts`'s pen-hardware-seen latch,
 * `penSeen`/`markPenSeen`, and `penToolsVisible`'s `isMobile || seen` clause.
 * Those answer "does the STRIP EXIST AT ALL" (pen-hardware discoverability on
 * desktop) - a question the zoom bar does not ask. Its existence stays with
 * the constructor's own `host.noteViewport && !preview` gate; this module
 * only answers "auto / show / hide" for a group that already exists.
 */

export type NoteZoomControlsMode = "auto" | "show" | "hide";

export const NOTE_ZOOM_CONTROLS_MODES: readonly NoteZoomControlsMode[] = ["auto", "show", "hide"];

let mode: NoteZoomControlsMode = "auto";

type NoteZoomControlsListener = () => void;
const listeners = new Set<NoteZoomControlsListener>();

/**
 * Be told whenever the mode changes. Returns the unsubscribe, which every
 * subscriber MUST call at teardown - same contract as `onPenToolsChanged`.
 */
export function onNoteZoomControlsChanged(listener: NoteZoomControlsListener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function announce(): void {
	for (const listener of [...listeners]) {
		try {
			listener();
		} catch (err) {
			console.error("[handwriting] note zoom controls listener failed", err);
		}
	}
}

export function getNoteZoomControlsMode(): NoteZoomControlsMode {
	return mode;
}

export function setNoteZoomControlsMode(m: NoteZoomControlsMode): void {
	// Only on a real change, same reason as `setPenToolsMode`: re-applied at
	// every settings save and again at load, and announcing an unchanged
	// answer would run every open surface's apply for nothing.
	if (mode === m) return;
	mode = m;
	announce();
}

export function normalizeNoteZoomControlsMode(raw: unknown): NoteZoomControlsMode {
	return raw === "show" || raw === "hide" ? raw : "auto";
}

export function nextNoteZoomControlsMode(cur: NoteZoomControlsMode): NoteZoomControlsMode {
	const i = NOTE_ZOOM_CONTROLS_MODES.indexOf(cur);
	return NOTE_ZOOM_CONTROLS_MODES[(i + 1) % NOTE_ZOOM_CONTROLS_MODES.length] ?? "auto";
}

/**
 * The whole visibility rule, pure. UNLIKE `penToolsVisible`, "auto" is
 * unconditionally true here: the `isMobile || seen` clause on the pen
 * toolbar answers pen-hardware discoverability - whether the strip should
 * exist on a desktop that has never seen a pen - which does not apply to the
 * zoom bar. The zoom bar's step-aside is `setInking` (MobileTools.ts)
 * toggling a class while it inks; it exists whenever the constructor's
 * `host.noteViewport && !preview` gate says so, in every mode.
 */
export function noteZoomControlsVisible(m: NoteZoomControlsMode): boolean {
	if (m === "show") return true;
	if (m === "hide") return false;
	return true;
}

/**
 * INFINITE CANVAS IS THE OTHER HALF OF THE ANSWER.
 *
 * With the canvas off a note has no zoom at all - pinch, ctrl+wheel and
 * `zoomNoteBy` all refuse - so a bar whose every button is a zoom has nothing
 * left to do, and Alan asked for it gone rather than greyed (04:4xZ, "only the
 * toolbar shows"). The mode above stays exactly what it was: the user's own
 * three-value setting. This is a separate gate over it, not a fourth mode,
 * because the two answer different questions and both have to be true - a user
 * who set the bar to Show has not asked for it on a note that cannot zoom, and
 * turning the canvas back on must return them to Show rather than to a default.
 *
 * It lives here rather than beside `setScrollExpansionEnabled` (InkOverlay.ts)
 * for `setStripFoldOrder`'s reason: the strip deliberately does not import
 * InkOverlay, and the zoom bar's visibility is a fact about the strip.
 *
 * DEFAULT TRUE, and deliberately: this module cannot read the setting, so
 * before `main.ts` has spoken the honest answer is "no opinion", and no
 * opinion must not hide a bar. `main.ts` asserts the truth at load and at
 * every flip of the row; `MobileTools.test.ts` pins both call sites in
 * main.ts's source so the wiring cannot be dropped without a red.
 */
let canvasEnabled = true;

export function getZoomBarCanvasEnabled(): boolean {
	return canvasEnabled;
}

export function setZoomBarCanvasEnabled(on: boolean): void {
	// Same "only on a real change" rule as `setNoteZoomControlsMode`, and for
	// the same reason: this is re-applied at every settings save.
	if (canvasEnabled === on) return;
	canvasEnabled = on;
	announce();
}

/**
 * The whole rule, pure, both halves: the user's mode AND the canvas.
 *
 * `canvasHere` is per NOTE, not global - a note may override the setting
 * (CanvasNoteOverride.ts) - so the caller resolves it for the note it is
 * painting and hands the answer in. A caller that has no note (the fold-order
 * preview strip) has no zoom bar either.
 */
export function noteZoomControlsVisibleWithCanvas(m: NoteZoomControlsMode, canvasHere: boolean): boolean {
	return canvasHere && noteZoomControlsVisible(m);
}

/** Test seam. */
export function resetNoteZoomControlsForTest(): void {
	mode = "auto";
	// True, matching the module default above: a cell that says nothing about
	// the canvas is a cell about the mode, and it must see the bar it always
	// saw. The canvas-off cells set this themselves.
	canvasEnabled = true;
	listeners.clear();
}

/** Test seam: how many surfaces are listening (leak witness, mirrors
 * `penToolsListenerCountForTest`). */
export function noteZoomControlsListenerCountForTest(): number {
	return listeners.size;
}
