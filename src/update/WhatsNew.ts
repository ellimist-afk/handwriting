/**
 * The notes each version shows once, on the first launch after the update.
 *
 * Kept in the build rather than fetched: the popup must work on an iPad in
 * a plane, and a changelog that needs the network is a changelog that fails
 * exactly when someone is wondering what just changed under their pen.
 */
export const RELEASE_NOTES: Record<string, string[]> = {
	"1.3.10": ["undo works", "ink prediction v2", "toolbar ui fixes", "bug fixes"],
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
	const lines = notes[current];
	if (!lines || lines.length === 0) return { show: false, record: current };
	return { show: true, record: current, version: current, notes: lines };
}

/**
 * The notice's contents: a heading and the lines the release went out with.
 *
 * A corner toast, not a modal. A changelog is an aside - it should catch the
 * eye of someone who wants it and cost nothing to anyone who doesn't, and a
 * dialog in the middle of the screen demanding dismissal is neither.
 */
export function whatsNewFragment(version: string, notes: string[]): DocumentFragment {
	const frag = document.createDocumentFragment();
	frag.createDiv({ cls: "handwriting-whats-new-title", text: `Handwriting ${version}` });
	const list = frag.createEl("ul", { cls: "handwriting-whats-new-list" });
	for (const line of notes) list.createEl("li", { text: line });
	return frag;
}

/** Long enough to read four short lines; a click dismisses it sooner. */
export const WHATS_NEW_MS = 15000;
