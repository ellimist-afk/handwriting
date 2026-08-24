/**
 * Replace one finished wet stroke with its committed rendering without ever
 * presenting a frame where both layers are empty.
 *
 * The wet canvas requests Chromium's desynchronized low-latency path. Clearing
 * it can therefore reach the compositor while the main thread is still
 * flattening and drawing a long committed stroke. Keep the wet pixels in front
 * until the committed backing store is ready, then clear the transient layers.
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
