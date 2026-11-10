import { isSafePageId } from "../model/PageData";

/**
 * The names three sync tools give the copy they keep when two devices changed
 * the same ink file before either saw the other's change. One list, shared by
 * the fork scan (each copy is listed as a kept copy against its live page) and
 * the live-page filter (a copy is never a page of its own), so the two can
 * never disagree about which files these are.
 *
 * For `<id>.json`:
 * - Syncthing: `<id>.sync-conflict-<yyyymmdd>-<hhmmss>-<first 7 of device id>.json`,
 *   and with no device part from releases that wrote none
 * - Dropbox: `<id> (<who>'s conflicted copy <yyyy-mm-dd>).json`, with ` (<n>)`
 *   after the date when that name was taken
 * - iCloud: `<id> <n>.json`, n from 2
 *
 * A page id holds no space, bracket or quote, so the Dropbox and iCloud names
 * can never be a live page; the Syncthing name can, which is why the filter
 * leaves out every name holding `.sync-conflict-`, as Syncthing itself tests.
 */
export const SYNC_TOOL_COPY_NAMES: readonly { tool: string; pattern: RegExp }[] = [
	{ tool: "Syncthing", pattern: /^(.+)\.sync-conflict-\d{8}-\d{6}(?:-[A-Z0-9]{7})?\.json$/ },
	{ tool: "Dropbox", pattern: /^(.+) \([^()]+['’]s conflicted copy \d{4}-\d{2}-\d{2}(?: \(\d+\))?\)\.json$/ },
	{ tool: "iCloud", pattern: /^(.+) (?:[2-9]|[1-9]\d+)\.json$/ },
];

/** Is this file name a sync tool's copy of an ink file? */
export function isSyncToolCopyName(name: string): boolean {
	return SYNC_TOOL_COPY_NAMES.some((n) => n.pattern.test(name));
}

/** The page id a sync tool's copy was made from, or null when the name is not one or the id is not a page id. */
export function syncToolCopyOf(name: string): string | null {
	for (const n of SYNC_TOOL_COPY_NAMES) {
		const m = n.pattern.exec(name);
		if (m && isSafePageId(m[1])) return m[1];
	}
	return null;
}
