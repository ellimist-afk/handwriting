/**
 * One event: a note's ink changed and was persisted. Fired from
 * InlineInkStore.save, which every mutation path (commit, erase, move,
 * undo) already funnels through - so this is once per gesture, never on
 * the erase hot path. Embed layers listen so a rendered picture stops
 * going stale the moment its note is drawn on.
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
