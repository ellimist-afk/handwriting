/**
 * The notes each version shows once, on the first launch after the update.
 *
 * Kept in the build rather than fetched: the popup must work on an iPad in
 * a plane, and a changelog that needs the network is a changelog that fails
 * exactly when someone is wondering what just changed under their pen.
 */
export const RELEASE_NOTES: Record<string, string[]> = {
	"1.3.10": ["undo works", "ink prediction v2", "toolbar ui fixes", "bug fixes"],
	"1.3.11": [
		"data safety fix",
		"palm rejection fix",
		"pdf handling fix",
		"mouse ink fixes",
		"ui polish",
		"ui fixes",
		"bug fixes",
	],
	"1.4.1": [
		"write on pdfs",
		"flatten a pdf with the ink in it",
		"export ink as pdf",
		"data safety fix",
		"palm rejection fix",
		"bug fixes",
	],
	// Most vaults update to this straight from 1.3.x, so the pdf headline
	// rides here too - notes only show for the version landed on.
	"1.4.2": [
		"write on pdfs",
		"flatten a pdf with the ink in it",
		"export ink as pdf",
		"snip pdf regions to png",
		"pinch zoom on pdfs",
		"bug report: record and send",
		"pen and highlighter color commands",
		"toolbar ui fixes",
		"bug fixes",
	],
	"1.4.4": [
		"boox mode: new setting for e-ink, should reduce latency. please bug report",
		"ink prediction on by default",
		"pdf v2 groundwork",
		"house cleaning",
		"bug fixes",
	],
	"1.4.5": [
		"pen latency fix",
		"pdf fixes",
		"performance fix",
		"data fixes",
		"ui fixes",
		"bug fixes",
	],
	"1.4.6": [
		"pdf fixes",
		"ink smoothing fixed",
		"toolbar on mobile fixes",
		"settings fixes",
		"data reliability fixes",
		"bug fixes",
	],
	"1.4.7": [
		"emergency bug fix",
	],
	"1.4.8": [
		"slider fix",
		"eraser fix",
		"tool bar fixes",
		"pdf tool bar fix",
		"icon fix",
		"ios fix",
	],
	"1.4.9": [
		"ink fix fixes for minimal theme and other centered themes (ty samuelbits)",
		"pdf fixes",
		"more pdf fixes",
		"omg more pdf fixes",
		"data safety fix",
		"toolbar fixes",
		"bug fixes",
	],
	"1.4.10": [
		"mouse ink session bug fix",
		"even more pdf fixes",
		"bug fixes",
	],
	"1.4.11": [
		"keyboard mode button on the toolbar for boox users",
		"ink shows in embeds",
		"dotted paper",
		"bug fixes",
	],
	// Opened ahead of the cut, which is safe: `notesSince` only ever looks at
	// versions at or below the one being LANDED on, so this says nothing to
	// anyone until manifest.json reaches it.
	// One line per thing a reader would notice, in one voice, each true on its
	// own: the toolbar lines used to say the same thing twice and the palette
	// lines split one change across two entries. "pressure moved to settings"
	// was half true and is now specific - the switch was always a setting; what
	// moved is the Recalibrate button, and three commands left the palette.
	//
	// IN FLIGHT, sentences that belong here when their slices merge:
	//  - mouse-toast-ink: turning mouse drawing on says "Handwriting: ink".
	//  - pen-hardware-local-store: the Keyboard latch is per device and does
	//    not travel with a synced vault.
	//  - pen-button-is-the-truth: the mouse acts as the lit tool on a pen-less
	//    device, and the first pen contact lights the pen.
	//  - ipad-ink-purge-repaint: ink repaints when the app comes back.
	//  - ink-theme-adapt: the black and the white swatch stay told apart on the
	//    dark theme while ink adapts to it. NOT WRITTEN HERE YET, and the
	//    reason is that the defect cannot happen on this branch: it needs the
	//    `inkAdaptsToTheme` setting and the `previewColor` hook that paints a
	//    swatch with the DISPLAYED colour rather than the stored one, and
	//    neither exists here - `paintSwatches` in MobileTools.ts fills every
	//    swatch straight from `paletteFor`, so black (#1c1f26) and white
	//    (#f4f4f2) are two colours on every theme. The sentence, and the fix
	//    it describes, belong on the branch that carries the adaptation.
	"1.4.12": [
		"bug fixes galore",
		"keyboard button on the toolbar",
		"check for broken ink command added",
		"toolbar fixes",
		"toolbar ui change (draggable!)",
		"bug report flow fixes",
		"bug fixes",
		"data safety fixes",
	],
	// Opened ahead of the cut, safe for the reason the 1.4.12 comment above
	// gives: `notesSince` filters on `compareVersions(v, current) <= 0`, so
	// nothing here reaches a reader until manifest.json says 1.4.13. The key
	// order in this literal is cosmetic - `notesSince` sorts by version - so
	// it sits after 1.4.12 to keep the file ascending the way it reads.
	"1.4.13": [
		"slides added!!",
		"data safety 2.0",
		// ALAN'S OWN LINE, TYPED BY HIM AND SIGNED BY HIM (2026-09-09 23:32, at
		// source in queue.md / lead-engineer.md / astra.md). It is a direct
		// message from him to his readers asking for a reply, and the
		// informality is the point: lowercase throughout, no trailing period,
		// `-alan` with no space after the hyphen. Do not capitalise it, do not
		// punctuate it, do not expand "changes" into a description.
		//
		// NO PERIOD HERE IS NOT AN OVERSIGHT. He ruled trailing periods back
		// ON for the delete-all refusal sentences the same day; that ruling was
		// about those strings and he typed this one bare.
		"ink pressure changes (let me know how it feels -alan)",
		"pdf ink color setting added",
		"cursor fixes",
		"lasso fixes",
		"undo fix",
		"toolbar fixes",
		"new toolbar anchors (drag toolbar to new locations!)",
		"notification spam fix",
		"dev mode",
		"boox/ipad hints",
		"bug fixes",
	],
	"1.4.14": ["ink thickness hotfix"],
	"1.4.15": ["properly done ink pressure sens patch", "bug fixes"],
	"1.4.16": [
		"per note lined/dotted/grid paper (hint: the ... button in the top right corner of the note -alan)",
		"ghost shape snapping",
		"toolbar settings changes",
		"reading mode ink bug fix",
		"notification bug fix",
		"zoom and fit to ink",
	],
	"1.4.17": ["compatibility bug fixes", "build verification bug fix"],
};

/** One release's own notes, kept apart so the toast can label them honestly. */
export type NotesGroup = {
	version: string;
	notes: string[];
	/**
	 * Set only on the synthetic marker `collapseOlderGroups` stands in for
	 * every group older than the two most recent - never on a real release's
	 * group. Its `notes` holds the one summary line to show; `version` is "".
	 */
	collapsedCount?: number;
};

/** Show the notes, or don't - and either way, the version to remember. */
export type NotesDecision =
	| { show: false; record: string }
	| {
			show: true;
			record: string;
			version: string;
			notes: string[];
			groups: NotesGroup[];
	  };

/**
 * Whether this launch has earned a what's-new notice.
 *
 * The whole difficulty is one case. A vault updating from 1.3.9 has never
 * stored a seen-version, because no build before this one wrote the key -
 * so "the key is missing" describes the updating user and the brand new
 * one identically, and the obvious rule (missing means new, stay quiet)
 * would hide the notes from precisely the people the notes are for.
 *
 * `fresh` is the honest discriminator: it comes from loadData() returning
 * null, meaning the vault holds no settings file at all. Someone updating
 * always has one. Someone installing for the first time never does, and is
 * left alone - a plugin whose first act is a popup is a plugin that starts
 * by talking about itself.
 */
export function decideWhatsNew(
	current: string,
	seen: string | null,
	fresh: boolean,
	notes: Record<string, string[]> = RELEASE_NOTES
): NotesDecision {
	// Record even when silent, so the NEXT update speaks instead of showing
	// this version's notes late.
	if (fresh) return { show: false, record: current };
	if (seen === current) return { show: false, record: current };
	const rawGroups = notesSince(current, seen, notes);
	if (rawGroups.every((g) => g.notes.length === 0)) return { show: false, record: current };
	// The two most recent groups render in full; anything older collapses to
	// a count, so a vault back after a long absence is told how much it
	// missed instead of being shown all of it ("they shouldn't get spammed,
	// ever"). `lines` is read off the COLLAPSED groups, not the raw ones, so
	// whatsNewDurationMs - fed from this same array's length by the caller -
	// scales to what actually renders, not to everything that would have.
	const groups = collapseOlderGroups(rawGroups);
	const lines = groups.flatMap((g) => g.notes);
	return { show: true, record: current, version: current, notes: lines, groups };
}

/** Ascending order for dotted versions; a non-numeric part sorts as 0. */
function compareVersions(a: string, b: string): number {
	const pa = a.split(".");
	const pb = b.split(".");
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (Number(pa[i]) || 0) - (Number(pb[i]) || 0);
		if (d !== 0) return d;
	}
	return 0;
}

/**
 * Everything worth saying about landing on `current`.
 *
 * Notes used to be looked up under the landed version and nowhere else, so a
 * release with no entry of its own said nothing at all - and a vault jumping
 * several versions heard only about the last one. 1.4.3 has no entry, so
 * everyone arriving there from 1.3.x was told nothing about the PDF release
 * they had just installed. The standing workaround was to copy a headline
 * forward into the next version's list by hand, which is a note that has to
 * be remembered every time.
 *
 * With a known `seen`, this is every version's notes in (seen, current].
 * With none - a build older than the key itself - it is the most recent
 * version at or below current that has any, rather than the whole changelog
 * at someone who has been away one release.
 *
 * Returned GROUPED, oldest first, one entry per version, so a caller that
 * skipped several releases can label each release's notes instead of
 * presenting them as one undifferentiated list under the version just
 * installed (1.4.6, §5c). Deduplicated across the whole set, because that
 * copy-forward workaround is still in the data and nobody wants the pdf
 * headline twice - a repeated line keeps its FIRST (oldest) occurrence, so
 * the repeat is dropped from the newer group, where the user would already
 * have seen it had they been on that release.
 */
function notesSince(
	current: string,
	seen: string | null,
	notes: Record<string, string[]>
): NotesGroup[] {
	const eligible = Object.keys(notes)
		.filter((v) => (notes[v] ?? []).length > 0 && compareVersions(v, current) <= 0)
		.filter((v) => seen === null || compareVersions(v, seen) > 0)
		.sort(compareVersions);
	const chosen = seen === null ? eligible.slice(-1) : eligible;
	const seenLines = new Set<string>();
	const groups: NotesGroup[] = [];
	for (const v of chosen) {
		const lines: string[] = [];
		for (const line of notes[v] ?? []) {
			if (seenLines.has(line)) continue;
			seenLines.add(line);
			lines.push(line);
		}
		groups.push({ version: v, notes: lines });
	}
	return groups;
}

/** The one true wording for how many older groups got folded away. */
function collapsedNoticeText(count: number): string {
	return `and ${count} earlier update${count === 1 ? "" : "s"}`;
}

/**
 * Keep the two most recent groups exactly as `notesSince` returned them;
 * fold every older one into a single synthetic marker naming a count, never
 * the version numbers themselves (the point is fewer lines, not a shorter
 * list of version numbers). Two groups or fewer already fits on screen, so
 * nothing changes for them - no marker, no empty element left behind.
 */
function collapseOlderGroups(groups: NotesGroup[]): NotesGroup[] {
	if (groups.length <= 2) return groups;
	const collapsedCount = groups.length - 2;
	const notice: NotesGroup = {
		version: "",
		notes: [collapsedNoticeText(collapsedCount)],
		collapsedCount,
	};
	return [notice, ...groups.slice(-2)];
}

/**
 * The notice's contents: a heading and the lines the release went out with.
 *
 * A corner toast, not a modal. A changelog is an aside - it should catch the
 * eye of someone who wants it and cost nothing to anyone who doesn't, and a
 * dialog in the middle of the screen demanding dismissal is neither.
 *
 * With `groups` (more than one release's worth), each group after the first
 * gets its own version label ahead of its list, so a vault that skipped
 * several releases reads five short honestly-labelled lists instead of one
 * flat list that reads as if it all shipped in the version just installed
 * (1.4.6, §5c). The first group carries no label of its own - the heading
 * above already names the current version. With zero or one group (or no
 * `groups` argument at all, for older callers) the output is exactly what
 * this function always produced: one title, one list.
 *
 * A group with `collapsedCount` set (see `collapseOlderGroups`) stands for
 * every release older than the two most recent: it renders as its one
 * summary line, with no version label and no list of its own.
 */
export function whatsNewFragment(
	version: string,
	notes: string[],
	groups?: NotesGroup[]
): DocumentFragment {
	const frag = createFragment();
	frag.createDiv({ cls: "handwriting-whats-new-title", text: `Handwriting ${version}` });
	if (groups && groups.length > 1) {
		groups.forEach((group, i) => {
			if (group.collapsedCount !== undefined) {
				frag.createDiv({
					cls: "handwriting-whats-new-collapsed",
					text: group.notes[0] ?? "",
				});
				return;
			}
			if (i > 0) {
				frag.createDiv({
					cls: "handwriting-whats-new-version",
					text: group.version,
				});
			}
			const list = frag.createEl("ul", { cls: "handwriting-whats-new-list" });
			for (const line of group.notes) list.createEl("li", { text: line });
		});
	} else {
		const list = frag.createEl("ul", { cls: "handwriting-whats-new-list" });
		for (const line of notes) list.createEl("li", { text: line });
	}
	return frag;
}

/** Long enough to read four short lines; a click dismisses it sooner. */
export const WHATS_NEW_MS = 15000;

/**
 * How long the toast stays up, scaled to how much there is to read.
 *
 * `WHATS_NEW_MS` covers up to four short lines. Past that - a vault that
 * skipped several releases can carry 20+ lines (measured against the
 * shipped notes: 1.3.10 -> 1.4.5 is 23 lines across five versions, §5c) -
 * a fixed 15s left the earliest release's lines scrolled off the
 * bottom-anchored toast before anyone could read them. 1.5s per line past
 * the base, capped at 45s so a very long history doesn't sit on screen
 * indefinitely.
 */
export function whatsNewDurationMs(lineCount: number): number {
	if (lineCount <= 4) return WHATS_NEW_MS;
	return Math.min(45000, WHATS_NEW_MS + (lineCount - 4) * 1500);
}
