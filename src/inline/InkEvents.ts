/**
 * One event: a note's ink changed. Fired at gesture boundaries - save
 * (erase end, lasso move, paste, move ops), commitGesture (a drawn
 * stroke), applyRemove (deletes and the remove leg of undo/redo), and
 * the add op's application - never per erase move: the hot path is
 * applyAdd putting split pieces back, and it stays silent. Embed layers
 * listen so a rendered picture stops going stale the moment its note
 * changes.
 */

const listeners = new Set<(path: string) => void>();

/** Subscribe; the return value unsubscribes. */
export function onInkChanged(fn: (path: string) => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

export function notifyInkChanged(path: string): void {
	// Copied first: a listener that unsubscribes mid-notify must not skip
	// its neighbors.
	for (const fn of [...listeners]) fn(path);
}

const rereadListeners = new Set<(path: string) => void>();

/**
 * A note's ink file was read again under its open session, and its strokes or attached groups changed: a duplicate lock
 * cleared on a copy. The open panes on the note take it as after an outside reload. Subscribe; the return value
 * unsubscribes.
 */
export function onInkReread(fn: (path: string) => void): () => void {
	rereadListeners.add(fn);
	return () => rereadListeners.delete(fn);
}

export function notifyInkReread(path: string): void {
	for (const fn of [...rereadListeners]) fn(path);
}
