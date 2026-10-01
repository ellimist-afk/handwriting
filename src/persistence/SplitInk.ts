/**
 * Find notes whose ink ended up in TWO folders. Look only; change nothing.
 *
 * THE DEFECT. Ink is one JSON file per page, `<folder>/<pageId>.json`. The
 * folder in force is the `inkFolder` setting, which `normalizeInkFolder`
 * lets be `.handwriting` (DEFAULT_INK_FOLDER), `handwriting`
 * (SYNCED_INK_FOLDER), or a third, custom path such as `assets/ink`. In
 * shipped 1.4.9, 1.4.10 and 1.4.11 `PageStore.findSidecar` fell back to the
 * other well-known folders when the configured one had no file for a page,
 * while the write went to `path()` - the CONFIGURED folder. So a device
 * whose setting names a folder other than the one holding the sidecar READ
 * one file and WROTE a second, and from then on two files held different
 * strokes for one note. Nothing was deleted; both survive; the app shows
 * one. `PageStore.resolvePath` pins the found path and closes it, but that
 * fix is not in any released tag, so vaults are still out there carrying the
 * fork with nothing to tell them.
 *
 * READ-ONLY BY CONSTRUCTION. `SplitInkAdapter` has no write, no rename, no
 * mkdir and no remove - not "we don't call them", they are not reachable
 * from here. The user authorised a detector and nothing else. A repair, a
 * merge, a conflict copy, a rename: each of those is its own decision with
 * its own evidence, and none of them is in this file.
 *
 * `enumerable` IS THE MOST IMPORTANT FIELD. A detector that answers "nothing
 * found" because it could not look is worse than no detector: it converts
 * "I don't know" into "you're fine". If any folder cannot be listed, the
 * report says `enumerable: false`, carries NO findings at all, and the
 * caller must say out loud that nothing was checked. A clean report and an
 * unlistable report are therefore never the same object.
 */

import { DEFAULT_INK_FOLDER, SYNCED_INK_FOLDER } from "./InkFolder";

/**
 * The filesystem, narrowed to the three verbs a detector needs.
 *
 * Deliberately NOT `MigrationAdapter`: that one carries mkdir and rename
 * because migration moves files. Widening this interface is how a later edit
 * turns "look" into "fix" without anyone deciding to.
 */
export interface SplitInkAdapter {
	exists(p: string): Promise<boolean>;
	list?(p: string): Promise<{ files: string[]; folders: string[] }>;
	read(p: string): Promise<string>;
}

/** What one copy of a page holds, or that it would not parse. */
export interface SplitCounts {
	strokes: number;
	textBoxes: number;
	images: number;
}

export interface SplitPage {
	pageId: string;
	/** The copy the app reads, per `PageStore.findSidecar`'s order. */
	shownPath: string;
	/** Every other copy. On disk, holding ink, invisible in the app. */
	hiddenPaths: string[];
	/** By path, for every copy including the shown one. */
	counts: Record<string, SplitCounts | "unreadable">;
	/**
	 * Always false for a page in `split`: byte-identical copies are not a
	 * fork and are counted in `identicalOnly` instead. The field is kept so
	 * a caller reading one page in isolation can still ask.
	 */
	identical: boolean;
}

export interface SplitInkReport {
	/** The folders actually looked in, de-duplicated, in scan order. */
	folders: string[];
	/** Sidecar page files seen across all of them. */
	scanned: number;
	split: SplitPage[];
	/** Pages present in two folders whose copies are byte-identical. */
	identicalOnly: number;
	/** Paths of copies that would not parse. */
	unreadable: string[];
	/**
	 * False when a folder could not be listed. Then `split` is empty because
	 * NOTHING WAS CHECKED, not because nothing was found.
	 */
	enumerable: boolean;
}

/**
 * A recovery copy, not a page: `<id>.damaged-<mtime>[-<n>].json` and
 * `<id>.conflict-<mtime>[-<n>].json` (PageStore.freeDamagedPath,
 * freeConflictPath). These are deliberate artefacts - the thing someone
 * reaches for after an accident - and a page sitting beside its own conflict
 * copy is not a fork. They are excluded from the page set entirely, in both
 * directions: neither as a page of its own nor as a second copy of one.
 */
const RECOVERY_COPY = /\.(damaged|conflict|superseded|flush-conflict)-\d+(-\d+)?\.json$/;

/** The last path segment, matching `InkFolder.baseName`. */
function baseName(path: string): string {
	const parts = path.replace(/\\/g, "/").split("/");
	return parts[parts.length - 1] ?? path;
}

/** A live page file: `<id>.json`, not a recovery copy, not a `.json.tmp`. */
function isPageFile(name: string): boolean {
	if (!name.endsWith(".json")) return false; // this also drops ".json.tmp"
	if (RECOVERY_COPY.test(name)) return false;
	return name !== ".json";
}

/**
 * The folders a page could be in: the configured one FIRST, then both
 * well-known ones, de-duplicated.
 *
 * Three, not two. The setting can name a custom folder, and then BOTH known
 * folders are fallbacks - which is exactly what `findSidecar`'s `others`
 * computes. Order is scan order and also the order the app resolves in.
 */
export function splitInkFolders(configuredFolder: string): string[] {
	const out: string[] = [];
	for (const f of [configuredFolder, DEFAULT_INK_FOLDER, SYNCED_INK_FOLDER]) {
		if (f !== "" && !out.includes(f)) out.push(f);
	}
	return out;
}

/** Count what a sidecar holds, or say it would not parse. */
function countPage(text: string): SplitCounts | "unreadable" {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return "unreadable";
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return "unreadable";
	}
	const obj = parsed as Record<string, unknown>;
	// A missing array is zero, not damage: an older or newer schema may omit
	// one, and refusing to count it would report a readable file unreadable.
	const len = (v: unknown): number => (Array.isArray(v) ? v.length : 0);
	return {
		strokes: len(obj.strokes),
		textBoxes: len(obj.textBoxes),
		images: len(obj.images),
	};
}

/**
 * Every page whose sidecar exists in more than one ink folder.
 *
 * Nothing here writes, and nothing here needs to. Copies are read only for
 * pages that already turned up in two folders, so the cost is one listing
 * per folder plus two reads per fork - not a read of every sidecar.
 */
export async function findSplitInk(
	adapter: SplitInkAdapter,
	configuredFolder: string
): Promise<SplitInkReport> {
	const folders = splitInkFolders(configuredFolder);
	const blind: SplitInkReport = {
		folders,
		scanned: 0,
		split: [],
		identicalOnly: 0,
		unreadable: [],
		enumerable: false,
	};
	// No list() at all: an adapter that cannot enumerate cannot clear a
	// vault, and saying so is the entire point of the flag.
	if (!adapter.list) return blind;

	/** filename -> the folders holding it, in scan order. */
	const byName = new Map<string, string[]>();
	let scanned = 0;
	for (const folder of folders) {
		let present: boolean;
		try {
			present = await adapter.exists(folder);
		} catch {
			// Cannot even ask whether the folder is there. That is a failure
			// to look, and a failure to look is never a clean result.
			return blind;
		}
		// A folder that simply is not there holds no ink and hides nothing.
		// This is the common case - most vaults have only one of the three -
		// and it must NOT count as a failure to look.
		if (!present) continue;
		let listing: { files: string[]; folders: string[] };
		try {
			listing = await adapter.list(folder);
		} catch {
			return blind;
		}
		for (const file of listing.files) {
			const name = baseName(file);
			if (!isPageFile(name)) continue;
			scanned++;
			const seen = byName.get(name);
			if (seen) seen.push(folder);
			else byName.set(name, [folder]);
		}
	}

	const split: SplitPage[] = [];
	const unreadable: string[] = [];
	let identicalOnly = 0;
	for (const [name, holders] of byName) {
		if (holders.length < 2) continue;
		const pageId = name.slice(0, -".json".length);
		// `holders` is already in scan order, and scan order is resolve
		// order: the configured folder first, then the well-known ones.
		// So the head IS the copy the app shows (PageStore.findSidecar).
		const paths = holders.map((f) => `${f}/${name}`);
		const texts: Array<string | null> = [];
		for (const p of paths) {
			try {
				texts.push(await adapter.read(p));
			} catch {
				// The file is listed but will not come back. Treat it as a
				// copy we cannot vouch for: the page is still reported.
				texts.push(null);
			}
		}
		const counts: Record<string, SplitCounts | "unreadable"> = {};
		let anyBad = false;
		paths.forEach((p, i) => {
			const text = texts[i];
			const c = typeof text === "string" ? countPage(text) : "unreadable";
			counts[p] = c;
			if (c === "unreadable") {
				anyBad = true;
				unreadable.push(p);
			}
		});
		// Byte-identical copies hold the same ink; nothing forked, and
		// calling that "split ink" would train people to ignore this
		// command. A copy that will not parse is excluded from that mercy on
		// purpose: an unreadable sidecar is a stronger reason to tell the
		// user, not a reason to stay silent (even when its twin matches it
		// byte for byte, because we cannot say what either one holds).
		const allSameBytes = texts.every((t) => typeof t === "string" && t === texts[0]);
		if (allSameBytes && !anyBad) {
			identicalOnly++;
			continue;
		}
		split.push({
			pageId,
			shownPath: paths[0]!,
			hiddenPaths: paths.slice(1),
			counts,
			identical: false,
		});
	}

	return { folders, scanned, split, identicalOnly, unreadable, enumerable: true };
}

/** `7 strokes, 1 text boxes, 0 images`, or the word for a copy that would not parse. */
function countsLine(c: SplitCounts | "unreadable"): string {
	if (c === "unreadable") return "unreadable";
	return `${c.strokes} strokes, ${c.textBoxes} text boxes, ${c.images} images`;
}

/**
 * The report as the user reads it.
 *
 * Kept here, beside the scan and away from obsidian, so the exact sentences
 * can be asserted. Three shapes, and the middle one is the reason the
 * function exists: an unlistable vault gets its OWN paragraph, not the clean
 * one with a caveat.
 *
 * `noteNames` maps a page id to the vault path of the note carrying it. A
 * page with no entry is shown by id, so a sidecar whose note was deleted or
 * never had frontmatter is still visible rather than silently dropped.
 */
export function splitInkReportText(
	report: SplitInkReport,
	noteNames: Map<string, string>
): string {
	if (!report.enumerable) {
		return "This vault could not be listed, so nothing was checked. This is not a clean result.";
	}
	if (report.split.length === 0) {
		return (
			"No split ink files. Every note's ink is in one place.\n\n" +
			`Scanned ${report.scanned} sidecar files in: ${report.folders.join(", ")}.`
		);
	}
	const n = report.split.length;
	const parts: string[] = [
		n === 1
			? "1 note has ink in more than one folder."
			: `${n} notes have ink in more than one folder.`,
		"Both copies are on disk and nothing has been deleted. The app shows one of them;" +
			" the other is not visible in the app.",
	];
	for (const p of report.split) {
		const lines = [
			noteNames.get(p.pageId) ?? `${p.pageId} (no note found)`,
			`    shown:  ${p.shownPath}  ${countsLine(p.counts[p.shownPath] ?? "unreadable")}`,
		];
		for (const hidden of p.hiddenPaths) {
			lines.push(`    hidden: ${hidden}  ${countsLine(p.counts[hidden] ?? "unreadable")}`);
		}
		parts.push(lines.join("\n"));
	}
	if (report.identicalOnly > 0) {
		parts.push(
			`${report.identicalOnly} further pages have identical copies in two folders.` +
				" Those hold the same ink and are not split."
		);
	}
	// Last, always: the promise this whole slice is built to keep.
	parts.push("Nothing was changed. This command only looks.");
	return parts.join("\n\n");
}
