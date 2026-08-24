/**
 * Start work that the caller deliberately cannot await.
 *
 * Event handlers, timers and Obsidian lifecycle callbacks are synchronous,
 * but some of the work they start is not. Every such launch comes through
 * here so a rejection is reported instead of becoming an unhandled promise.
 */
export function runDetached(
	work: Promise<unknown>,
	context: string,
	onFailure?: (error: unknown) => void
): void {
	void work.catch((error: unknown) => {
		console.error(`[handwriting] ${context}`, error);
		if (!onFailure) return;
		try {
			onFailure(error);
		} catch (reportError) {
			console.error(`[handwriting] ${context}: failure reporter threw`, reportError);
		}
	});
}
