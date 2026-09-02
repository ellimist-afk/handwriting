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
};

/** Show the notes, or don't - and either way, the version to remember. */
export type NotesDecision =
	| { show: false; record: string }
	| { show: true; record: string; version: string; notes: string[] };

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
	const lines = notesSince(current, seen, notes);
	if (lines.length === 0) return { show: false, record: current };
	return { show: true, record: current, version: current, notes: lines };
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
 * Deduplicated, because that copy-forward workaround is still in the data and
 * nobody wants the pdf headline twice.
 */
function notesSince(
	current: string,
	seen: string | null,
	notes: Record<string, string[]>
): string[] {
	const eligible = Object.keys(notes)
		.filter((v) => (notes[v] ?? []).length > 0 && compareVersions(v, current) <= 0)
		.filter((v) => seen === null || compareVersions(v, seen) > 0)
		.sort(compareVersions);
	const chosen = seen === null ? eligible.slice(-1) : eligible;
	const out: string[] = [];
	for (const v of chosen) {
		for (const line of notes[v] ?? []) if (!out.includes(line)) out.push(line);
	}
	return out;
}

/**
 * The notice's contents: a heading and the lines the release went out with.
 *
 * A corner toast, not a modal. A changelog is an aside - it should catch the
 * eye of someone who wants it and cost nothing to anyone who doesn't, and a
 * dialog in the middle of the screen demanding dismissal is neither.
 */
export function whatsNewFragment(version: string, notes: string[]): DocumentFragment {
	const frag = createFragment();
	frag.createDiv({ cls: "handwriting-whats-new-title", text: `Handwriting ${version}` });
	const list = frag.createEl("ul", { cls: "handwriting-whats-new-list" });
	for (const line of notes) list.createEl("li", { text: line });
	return frag;
}

/** Long enough to read four short lines; a click dismisses it sooner. */
export const WHATS_NEW_MS = 15000;
