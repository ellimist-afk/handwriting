/**
 * The registry of "put this Notice down" callbacks, shared by every module
 * that owns one.
 *
 * WHY IT IS A MODULE OF ITS OWN, and not an export from main.ts. A Notice
 * outlives the plugin that made it: it is Obsidian's DOM on Obsidian's own
 * timeout, so disabling or reloading between the last toast and that timeout
 * left the final one standing, naming the state of a plugin that is no longer
 * running. main.ts's `ownedNotice` slots were reached by `hideOwnedNotices`
 * on unload; the quick-pen presets' slot (`ownedPresetNotice`,
 * ink/InkPresetHost.ts) was not, because the array it would have to join was
 * module-private to main.ts - tap a chip, reload inside the toast's timeout,
 * and the toast stays up with nothing left to dismiss it.
 *
 * Exporting a registrar from main.ts would have fixed the reach and closed an
 * IMPORT CYCLE doing it: main.ts already imports `installInkPresetActions`
 * from ink/InkPresetHost.ts (main.ts's import block), so that file importing
 * main.ts back is the cycle InkPresetHost's own header says it is avoiding.
 * A leaf module that imports nothing has no such edge, and it is the smaller
 * change besides: main.ts keeps `ownedNotice`, keeps `hideOwnedNotices`, and
 * keeps its six slots exactly as PenToggleNotice.test.ts pins them.
 *
 * THE ARRAY ITSELF IS THE SEAM, rather than a register function wrapping it.
 * Every writer does the same one thing - push its own `clear` as it builds
 * its slot - and main.ts owns the walk because `onunload` lives there, beside
 * the rest of the plugin's teardown. One `push` and one `for` is the whole
 * protocol; a pair of functions around it would be two names for it instead.
 *
 * ORDER IS CREATION ORDER, which is module-evaluation order and therefore not
 * something any caller should depend on. Nothing does: unload hides all of
 * them, and hiding a slot that is already down is a no-op by construction
 * (each `clear` probes `messageEl?.isConnected` first).
 *
 * NOT CLEARED ON UNLOAD. The slots are module scope and live as long as the
 * module does, so the array must keep pointing at them: a re-enable inside
 * the same Obsidian session re-runs `onload`, not the module bodies, and an
 * emptied registry would leave every slot unreachable for the rest of that
 * session - the defect this file exists to close, arriving by the other road.
 */
export const ownedNoticeHiders: Array<() => void> = [];
