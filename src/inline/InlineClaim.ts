import { MD_VERSION, parseMarkdownPage, updateFrontmatter } from "../model/MarkdownPage";

/**
 * The one Markdown write the inline model ever makes: stamping `handwriting-page-id`
 * into a note's frontmatter the first time it acquires spatial state.
 *
 * Pure text-in/text-out so it is testable byte-for-byte, and so the caller can
 * run it inside `vault.process` (Obsidian's atomic read-modify-write). Both
 * identity rules are enforced here and at the call site:
 *
 * - The reference must exist before the referent: the caller AWAITS this write
 *   before scheduling any sidecar keyed by the id.
 * - Absence of a page id is never evidence of anything except "not claimed
 *   yet". If the file turns out to already carry an id (another pane or
 *   another device claimed first), that id WINS and the content comes back
 *   unchanged. Two writers can race the claim and still converge on one id.
 *
 * Uses the single frontmatter parser (`parseMarkdownPage.rawBody`), so the
 * malformed-fence corpus from the v0.8.0 audit is handled by construction: an
 * unterminated leading `---` is body and gains a fresh fence above it, and a
 * well-formed file gains exactly one line.
 */
export interface ClaimResult {
	content: string;
	/** The id the note actually has now: ours, or the one that beat us. */
	pageId: string;
	changed: boolean;
	/** Set when the file declares a newer handwriting-version; the caller must not write. */
	futureVersion?: number;
}

/**
 * Give an already-claimed note a DIFFERENT id. This is the duplicate-resolution
 * write, and the only other Markdown mutation the inline model can make.
 * Used exclusively on the COPY in a duplicate pair; the original is never
 * touched. Same single-parser, byte-precise reconstruction as the claim:
 * exactly the id line changes.
 *
 * Fails closed in both directions: an UNCLAIMED note comes back unchanged
 * (reassigning must never turn into claiming, because copying an ordinary note
 * must not mutate it), and a newer handwriting-version is not written to.
 */
export function reassignMarkdown(content: string, newId: string): ClaimResult {
	const parsed = parseMarkdownPage(content);
	if (!parsed.pageId || parsed.pageId === newId) {
		return { content, pageId: parsed.pageId ?? newId, changed: false };
	}
	if (parsed.version !== undefined && parsed.version > MD_VERSION) {
		return { content, pageId: parsed.pageId, changed: false, futureVersion: parsed.version };
	}
	const fm = updateFrontmatter(parsed.frontmatter, newId, { version: false });
	const body = parsed.rawBody;
	const eol = parsed.eol;
	const next = `---${eol}${fm.join(eol)}${eol}---${eol}${body.startsWith(eol) ? "" : eol}${body}`;
	return { content: next, pageId: newId, changed: true };
}

export function claimMarkdown(content: string, pageId: string): ClaimResult {
	const parsed = parseMarkdownPage(content);
	if (parsed.pageId) {
		// Someone already claimed it. Adopt their id, touch nothing.
		return { content, pageId: parsed.pageId, changed: false };
	}
	if (parsed.version !== undefined && parsed.version > MD_VERSION) {
		return { content, pageId, changed: false, futureVersion: parsed.version };
	}
	// `handwriting-version` describes block markers, which the inline model never
	// writes, so the claim is the id line and nothing else.
	const fm = updateFrontmatter(parsed.frontmatter, pageId, { version: false });
	const body = parsed.rawBody;
	// Reassemble with the note's OWN line ending (parsed.eol), not a
	// hardcoded "\n" - a CRLF note used to come back with every line ending
	// rewritten to LF for the sake of one added frontmatter line
	// (audit-fixes-design.md 5i I5).
	const eol = parsed.eol;
	const next = `---${eol}${fm.join(eol)}${eol}---${eol}${body.startsWith(eol) ? "" : eol}${body}`;
	return { content: next, pageId, changed: true };
}
