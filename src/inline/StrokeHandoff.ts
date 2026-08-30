/**
 * Replace one finished wet stroke with its committed rendering without ever
 * presenting a frame where both layers are empty.
 *
 * This ordering was written when the wet canvas requested Chromium's
 * desynchronized path, where clearing it could reach the compositor while the
 * main thread was still flattening a long committed stroke - the clear landing
 * a frame before the paint that replaces it. That flag is OFF now (see
 * INLINE_DESYNCHRONIZED, where the measurements live), so both layers present
 * together and the gap it guarded against cannot open.
 *
 * The ordering stays anyway. It is correct on its own terms - never clear what
 * replaces a thing before the replacement exists - it costs nothing, and it is
 * the invariant that has to hold if anyone ever turns that flag back on.
 */
export function handoffFinishedStroke(ops: {
	store: () => void;
	drawCommitted: () => void;
	clearTransient: () => void;
	publishHistory: () => void;
}): void {
	ops.store();
	ops.drawCommitted();
	ops.clearTransient();
	ops.publishHistory();
}
