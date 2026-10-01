/**
 * The notice when Delete all ink cannot back the page up first. While an ink-folder move runs, the store
 * refuses with a try-again message; that is not a disk fault, so it is shown as thrown.
 */
export const INK_FOLDER_MOVING_TEXT = "Handwriting: the ink folder is still moving - try again in a moment";

export function deleteAllBackupFailureText(err: unknown, what: "note" | "PDF"): string {
	if (err instanceof Error && err.message === INK_FOLDER_MOVING_TEXT) return INK_FOLDER_MOVING_TEXT;
	return `Handwriting: could not copy this ${what}'s ink to the trash (disk error). Nothing was deleted.`;
}
