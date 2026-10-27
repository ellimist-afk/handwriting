/**
 * Slide sections and note matching for the slides ink surface: how a note's
 * Markdown splits into the presenter's slides, how a slide is named and hashed,
 * whether a note is the deck on the screen, and where stored ink belongs after
 * the deck was edited. Pure functions and constants, no DOM and no state.
 *
 * SlidesInkSurface.ts re-exports every name here, so each importer keeps its
 * import line.
 */
import type { InkStroke } from "../ink/Stroke";
import { parseMarkdownPage } from "../model/MarkdownPage";

// ---- slide identity (A5) --------------------------------------------------

/**
 * The sidecar id for a note's slides ink.
 *
 * A SEPARATE id, not the note's, and that is the whole of design §3.1: an
 * older plugin reads `handwriting-page-id` from frontmatter and loads the bare
 * id, so it can never ask for this one. `isSafePageId` accepts it (dots are
 * legal inside an id), so `PageStore.path` will build a path for it.
 */
export const SLIDES_SIDECAR_SUFFIX = ".slides";

export function slidesSidecarId(pageId: string): string {
	return `${pageId}${SLIDES_SIDECAR_SUFFIX}`;
}

/**
 * A stroke's `page` field is 1-BASED (PageData drops anything below 1, because
 * for the pdf surface it is a page number), and a slide index is 0-based.
 * The two conversions live here so the off-by-one is written once.
 */
export function pageOfSlide(index: number): number {
	return index + 1;
}

export function slideOfPage(page: number | undefined): number {
	return typeof page === "number" && Number.isInteger(page) && page >= 1 ? page - 1 : 0;
}

/**
 * A CommonMark thematic break: three or more `*`, `-` or `_`, all the same
 * character, spaces or tabs allowed between them, up to three leading spaces
 * and nothing else on the line.
 */
const THEMATIC_BREAK = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;

/**
 * A setext heading underline, as the presenter's OWN parser reads it.
 *
 * Obsidian's presenter splits with legacy remark-parse under
 * `{breaks: true, commonmark: true}`, whose setext tokenizer takes a line that
 * is ONLY `=` or `-` characters - no leading and no trailing whitespace. Only
 * `-` can reach here, because a line of `=` is never a thematic break. So
 * `- - -` under a paragraph is a break, and so is `--- ` with a trailing
 * space; bare `---` under a single line of text is that line's h2.
 */
const SETEXT_UNDERLINE = /^-+$/;

/** Opens or closes a fenced code block: three or more backticks or tildes. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** The close has to be bare - an info string only ever rides the opener. */
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * Lines that start a block a paragraph cannot continue into, so a `---` under
 * one of them is a break rather than that line's setext underline.
 */
const OPENS_OTHER_BLOCK = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|>|[-*+][ \t]|\d{1,9}[.)][ \t]|<)/;
const LIST_START = /^ {0,3}(?:[-*+][ \t]|\d{1,9}[.)][ \t])/;
const INLINE_HTML_LINE = /^ {0,3}<img\b/i;

/** Clean one inline block: %% closes on its line; HTML and code may span soft breaks. */
function stripInlineComments(line: string): string {
	let out = "";
	let i = 0;
	while (i < line.length) {
		if (line[i] === "\\") {
			out += line.slice(i, i + 2);
			i += 2;
			continue;
		}
		if (line[i] === "`") {
			const ticks = /^`+/.exec(line.slice(i))![0];
			let end = line.indexOf(ticks, i + ticks.length);
			while (end >= 0 && (line[end - 1] === "`" || line[end + ticks.length] === "`")) {
				end = line.indexOf(ticks, end + ticks.length);
			}
			if (end >= 0) {
				out += line.slice(i, end + ticks.length);
				i = end + ticks.length;
				continue;
			}
			out += ticks;
			i += ticks.length;
			continue;
		}
		const open = line.startsWith("%%", i) ? "%%" : line.startsWith("<!--", i) ? "<!--" : null;
		if (open) {
			const close = open === "%%" ? "%%" : "-->";
			const end = line.indexOf(close, i + open.length);
			const newline = line.indexOf("\n", i);
			if (end >= 0 && (open !== "%%" || newline < 0 || end < newline)) {
				out += line.slice(i, end + close.length).replace(/[^\n]/g, "");
				i = end + close.length;
				continue;
			}
		}
		out += line[i++]!;
	}
	return out;
}

/**
 * The note's slide sections, in deck order (§3.6).
 *
 * This has to agree with Obsidian's own presenter, because the slide INDEX it
 * produces is what a stroke's `page` is keyed off: the presenter parses the
 * note to mdast, splits the top-level children on `thematicBreak` nodes and
 * SKIPS EMPTY GROUPS. So a `---` here is a CommonMark thematic break, not any
 * line of three dashes: one inside a fence is code, one directly under a
 * SINGLE line of text is that line's setext underline (the presenter's own
 * tokenizer takes one content line, and setext never interrupts a paragraph
 * already under way). Only groups without mdast nodes are dropped; a comment
 * node can make a real slide whose rendered text is blank.
 *
 * The frontmatter is skipped through the one parser the rest of the plugin
 * uses (`parseMarkdownPage.rawBody`), so the malformed-fence corpus is handled
 * by construction rather than by a second, subtly different, `---` scanner.
 *
 * Comments (`%%...%%` and `<!-- ... -->`) are dropped here, ONCE, for the same
 * reason: the presenter does not render them, so a note whose first slide
 * opens `%%rel%%# Slide one` is on screen as "Slide one". This is the only
 * place they are stripped - the section texts every caller reads are already
 * comment-free, so nothing downstream pays for it per sample or per stroke.
 * Not inside a fence, where `%%` is code.
 */
export function splitSlideSections(source: string): string[] {
	const parsed = parseMarkdownPage(source);
	const lines = parsed.rawBody.split(/\r\n|\n|\r/);
	const groups: Array<{ lines: string[]; hasNode: boolean }> = [];
	let current: string[] = [];
	let inlineRun: string[] = [];
	const flushInline = (): void => {
		if (inlineRun.length === 0) return;
		current.push(...stripInlineComments(inlineRun.join("\n")).split("\n"));
		inlineRun = [];
	};
	let hasNode = false;
	let fence: { char: string; len: number } | null = null;
	let blockClose: "%%" | "-->" | null = null;
	// Structural decisions use the raw paragraph, before inline comments are
	// removed. `%%hidden%%\n---` is a setext heading, while `%%hidden%%---`
	// is ordinary text. Neither becomes a rule when its comment disappears.
	let paragraphRun = 0;
	let listContinuation = false;
	for (let index = 0; index < lines.length; index++) {
		let raw = lines[index]!;
		if (LIST_START.test(raw)) listContinuation = true;
		else if (raw.trim() === "" || !/^[ \t]/.test(raw)) listContinuation = false;
		if (fence) {
			current.push(raw);
			const close = FENCE_CLOSE.exec(raw)?.[1];
			if (close && close[0] === fence.char && close.length >= fence.len) fence = null;
			continue;
		}
		if (blockClose) {
			const end = raw.indexOf(blockClose);
			if (end < 0) {
				current.push("");
				continue;
			}
			raw = raw.slice(end + blockClose.length);
			blockClose = null;
		}
		// A top-level indented code line is literal, just like a fenced one.
		if (paragraphRun === 0 && /^(?: {4}|\t)/.test(raw)) {
			flushInline();
			hasNode = true;
			current.push(raw);
			continue;
		}
		// The installed presenter's %% block tokenizer accepts a line-start
		// opener only when no further percent occurs on that opening line.
		// The entire block is one mdast node, including any rules inside it.
		if (/^ {0,3}%%[^%]*$/.test(raw)) {
			flushInline();
			hasNode = true;
			blockClose = "%%";
			paragraphRun = 0;
			current.push("");
			continue;
		}
		// Legacy remark gives a one-line setext heading priority over an HTML
		// block. Preserve that measured exception (`<!--\n---`), too.
		const htmlSetext = paragraphRun === 0 && /^ {0,3}<!--/.test(raw) && SETEXT_UNDERLINE.test(lines[index + 1] ?? "");
		if (/^ {0,3}<!--/.test(raw) && !htmlSetext) {
			flushInline();
			hasNode = true;
			paragraphRun = 0;
			const end = raw.indexOf("-->", raw.indexOf("<!--") + 4);
			if (end < 0) {
				blockClose = "-->";
				current.push("");
				continue;
			}
			raw = raw.slice(end + 3);
		}
		const open = FENCE.exec(raw)?.[1];
		if (open) {
			flushInline();
			fence = { char: open[0]!, len: open.length };
			hasNode = true;
			paragraphRun = 0;
			current.push(raw);
			continue;
		}
		if (THEMATIC_BREAK.test(raw)) {
			flushInline();
			if (paragraphRun === 1 && SETEXT_UNDERLINE.test(raw)) {
				current.push(raw);
				paragraphRun = 0;
				continue;
			}
			groups.push({ lines: current, hasNode });
			current = [];
			hasNode = false;
			paragraphRun = 0;
			continue;
		}
		if (raw.trim() !== "") hasNode = true;
		paragraphRun = raw.trim() !== "" && !listContinuation &&
			(htmlSetext || INLINE_HTML_LINE.test(raw) || !OPENS_OTHER_BLOCK.test(raw)) ? paragraphRun + 1 : 0;
		if (paragraphRun > 0) inlineRun.push(raw);
		else {
			flushInline();
			current.push(stripInlineComments(raw));
		}
	}
	flushInline();
	groups.push({ lines: current, hasNode });
	// The presenter drops empty mdast groups, not groups whose rendered text
	// is empty. Comments and frontmatter both keep a real, possibly blank slide.
	const hasFrontmatter = parsed.frontmatter.length > 0;
	return groups.filter((group, i) => (hasFrontmatter && i === 0) || group.hasNode)
		.map((group) => group.lines.join("\n"));
}

/**
 * FNV-1a, 32-bit, lower-case hex (§3.6). Trimmed first, so re-indenting a
 * slide's last line does not detach its ink.
 *
 * Not cryptographic and does not need to be: the only cost of a collision is
 * that two identical slides cannot be told apart, and identical slides are
 * exactly the case `remapSlides` already refuses to guess about.
 */
export function sectionHash(text: string): string {
	let h = 0x811c9dc5;
	const s = text.trim();
	for (let i = 0; i < s.length; i++) {
		h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

export function sectionHashes(source: string): string[] {
	return splitSlideSections(source).map(sectionHash);
}

/**
 * How much of each section's opening is compared with its slide (see
 * NOTE_CHECK_NEEDLE_CHARS). Enough to be a fingerprint.
 */
export const NOTE_CHECK_CHARS = 240;

/**
 * Pass as the normaliser's limit to take the whole thing.
 *
 * The DECK side is never cut. One slide's rendered text is small, and a note
 * with a long frontmatter block would otherwise spend the whole window on
 * properties and push the slide's actual words out of the comparison.
 */
const UNCUT = Number.POSITIVE_INFINITY;

/**
 * The classes Obsidian puts on a rendered frontmatter block.
 *
 * The presenter parses the note to mdast and the frontmatter node lands in the
 * FIRST slide's group, rendered, so that section's `textContent` begins with
 * the note's own properties - `handwriting-page-id` above all, which is on
 * every note that has ever been inked. The note side starts at the body
 * (`parseMarkdownPage(...).rawBody`), so without this the two sides disagree
 * on every note this feature has ever touched.
 */
const FRONTMATTER_CLASSES = ["frontmatter", "metadata-container"];

/** The little of an element the deck-side gather reads. */
export interface DeckSectionEl {
	readonly textContent: string | null;
	readonly children: ArrayLike<DeckSectionEl>;
	readonly classList: { contains(token: string): boolean };
}

/** Every frontmatter block under `el`, in order, without descending into one. */
function frontmatterTexts(el: DeckSectionEl, out: string[]): string[] {
	const kids = el.children;
	for (let i = 0; i < kids.length; i++) {
		const child = kids[i];
		if (!child) continue;
		if (FRONTMATTER_CLASSES.some((c) => child.classList.contains(c))) {
			// The whole block goes, so there is nothing inside it to look at.
			out.push(child.textContent ?? "");
			continue;
		}
		frontmatterTexts(child, out);
	}
	return out;
}

/**
 * One slide section's text, with the rendered frontmatter left out (§3.5).
 *
 * Load-time only - this walks the section once per presentation, never per
 * sample and never per stroke. The DOM is not cloned: the frontmatter blocks'
 * `textContent` is subtracted from the section's, which is the same string a
 * clone would have produced and costs one walk.
 */
export function deckSectionText(section: DeckSectionEl): string {
	let text = section.textContent ?? "";
	for (const skip of frontmatterTexts(section, [])) {
		if (skip === "") continue;
		const at = text.indexOf(skip);
		if (at >= 0) text = text.slice(0, at) + text.slice(at + skip.length);
	}
	return text;
}

/**
 * The shortest run of a section's letters that counts as found on its slide.
 *
 * A window of this length is slid over the first NOTE_CHECK_CHARS of each
 * section, and every letter inside a window the slide shows counts as covered.
 * A section no longer than one window must turn up whole. Short enough that a
 * construct the reduction to rendered text does not know (inline math, say)
 * costs only its own letters and the few around it, rather than the whole
 * window it sits in.
 */
export const NOTE_CHECK_NEEDLE_CHARS = 20;

/**
 * How many of the counted letters must be covered, over every section, for the
 * note to be the deck's: 3 in 4.
 *
 * A single found run used to be enough, and two notes made from one template
 * share a heading and an agenda on purpose - a wrong note passed and its page
 * id was written into another file. A different note sharing a template's
 * opening covers about 60% of it; the note's own slides, with an unknown
 * construct or two, cover well over 75%.
 */
export const NOTE_CHECK_COVERAGE_NUMERATOR = 3;
export const NOTE_CHECK_COVERAGE_DENOMINATOR = 4;

/**
 * Markdown source and rendered text, reduced to the one thing they share.
 *
 * The two sides of `noteMatchesDeck` are NOT the same string and never can be:
 * one is the note's own `---`-split source, the other is what Reveal put on the
 * screen after Obsidian rendered it. `# Title` is `Title` by the time it is a
 * section's `textContent`. So everything that is syntax rather than content is
 * dropped - fences, link targets, and finally every character that is not a
 * letter or a digit - and what is left is the letters and digits, lower-cased.
 * That is a fingerprint, which is all this check needs: it is answering "is
 * this the same note at all", not "is this byte-identical".
 *
 * What is NOT dropped here is anything the presenter removes before it renders
 * at all: the note's comments (`%%...%%`, `<!-- ... -->`) are gone by the time
 * the text reaches this function, stripped once by `splitSlideSections`. A
 * reader adding to this list has to check there too - a comment left in the
 * note's first section put "rel" at the head of the needle, the deck's text
 * began "slide one", and the whole presentation's ink was parked in memory
 * (owner's console, 2026-09-06).
 *
 * Separators are dropped rather than collapsed to a space, because the two
 * sides do not agree on where a space belongs. The rendered side is a
 * `textContent`, and there is no whitespace BETWEEN block elements:
 * `<h1>Slide one</h1><p>Draw here` reads as "Slide oneDraw here", so a
 * space-collapsing fingerprint compared "slide one draw here" against
 * "slide onedraw here" and failed every real deck. With the separators gone
 * both sides fuse the same way.
 */
export function normaliseSectionText(text: string, limit: number = NOTE_CHECK_CHARS): string {
	return text
		.replace(/[^\p{L}\p{N}]+/gu, "")
		.toLowerCase()
		.slice(0, limit);
}

/**
 * The note's Markdown, reduced to the text the presenter shows for it, before
 * the fingerprint above is taken.
 *
 * The rendered side has no syntax at all, so anything the renderer drops or
 * rewrites has to be dropped or rewritten here the same way, or a note whose
 * first slide opens with it never matches its own deck: saved ink stayed
 * hidden and new ink was never saved. A code block shows its code, never its
 * fences or their language tag; inline code keeps its text (the backticks
 * go); a callout shows its title, never its `[!type]` marker; an image,
 * Markdown or embed, shows no text; a link shows its text, and an aliased
 * wikilink its alias; a task's checkbox shows no text; inline HTML shows its
 * text, never its tags (a tag opens with a letter or a slash, so a < or >
 * in a sentence stays text); math, a `$$` block or inline `$...$`, is
 * typeset and its source letters never reach the slide's text. Inline math follows
 * Obsidian's rule - no space just inside either `$` - so "$5 and $6" stays
 * text. An ordered list's numbers (`1.`, `2)`) and a block id (`^abc`) at the
 * end of a block are not text of the slide either.
 */
export function renderedNoteText(text: string): string {
	// Code shows its text literally, so it is set aside before the tag and math
	// strips can reach a `<span>` or a `$x$` inside it, and put back after.
	const code: string[] = [];
	const setAside = (kept: string): string => `\u0001${code.push(kept) - 1}\u0001`;
	return text
		.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^[ \t]*\1[ \t]*$/gm, (_m, _fence, body: string) => setAside(body))
		.replace(/`{1,3}([^`]*)`{1,3}/g, (_m, body: string) => setAside(body))
		.replace(/<\/?[A-Za-z][^<>]*>/g, " ")
		.replace(/\$\$[\s\S]*?\$\$/g, " ")
		.replace(/\$(?=\S)[^$\n]*?\S\$/g, " ")
		.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*$/gm, " ")
		.replace(/^([ \t]*>[ \t]*)\[![^\]]+\][+-]?/gm, "$1")
		.replace(/!\[\[[^\]]*\]\]/g, " ")
		.replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, "$1")
		.replace(/\[\[([^\]]*)\]\]/g, "$1")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/^(\s*(?:[-*+]|\d+[.)])\s+)\[[ xX]\]\s/gm, "$1")
		// An ordered list shows its items and never their numbers (the browser
		// draws those), also inside a callout or a quote; a block id at the end
		// of a block is not shown either. Both run after the task-box strip,
		// which needs the marker, and before the code put-back below.
		.replace(/^([ \t]*(?:>[ \t]*)*)\d{1,9}[.)][ \t]+/gm, "$1")
		.replace(/(?:^|[ \t])\^[A-Za-z0-9-]+[ \t\r]*$/gm, "")
		// eslint-disable-next-line no-control-regex -- U+0001 is the set-aside marker setAside writes above; note text never carries it.
		.replace(/\u0001(\d+)\u0001/g, (_m, i: string) => code[Number(i)] ?? "");
}

/**
 * Is the note we resolved actually the note on the screen? (§3.5)
 *
 * `activeFilePath()` is read at container time and is only ever a good guess:
 * Start presentation acts on the active file, but a second pane or a popout
 * window can make the workspace's active file something other than the deck the
 * reader is looking at. Without this the surface would stamp
 * `handwriting-page-id` into an innocent note and file the presentation's ink
 * under it - a Markdown write on the wrong file, which is the one thing this
 * feature must never do.
 *
 * Two cheap questions, both of which a wrong note fails: the deck has one
 * section per `---` in the source, so the COUNTS must agree; and, slide by
 * slide, most of each section's opening must turn up on its slide as
 * rendered: at least 3 in 4 of the counted letters, over every section,
 * covered by runs of NOTE_CHECK_NEEDLE_CHARS the slide shows. A note that
 * passes both is the note, near enough to write to. A note that fails either
 * takes the memory-only arm: ink still flows, nothing is stamped, nothing is
 * saved.
 *
 * An empty section on either side (a title slide that is only an image, say)
 * proves nothing either way and is not counted; when no section is counted,
 * the count alone decides rather than a blank string being read as a mismatch.
 *
 * What it cannot do: two notes whose rendered text agrees on more than 3 in 4
 * of every slide's opening letters cannot be told apart, and a title-only
 * slide no longer than one window that opens with a construct the reduction
 * does not know still refuses, as 1.4.21 did. The failure log line keeps both
 * heads, so either shows up in a report. Cost: once per presentation start,
 * at most NOTE_CHECK_CHARS - NOTE_CHECK_NEEDLE_CHARS + 1 `includes` per
 * section.
 */
export function noteMatchesDeck(
	sectionTexts: readonly string[],
	deckTexts: readonly string[]
): boolean {
	if (sectionTexts.length !== deckTexts.length) return false;
	let counted = 0;
	let covered = 0;
	for (let i = 0; i < sectionTexts.length; i++) {
		const note = normaliseSectionText(renderedNoteText(sectionTexts[i] ?? ""));
		const deck = normaliseSectionText(deckTexts[i] ?? "", UNCUT);
		// A note whose body opens with a bare `---` right under its
		// frontmatter gives `splitSlideSections` an empty string for section
		// 0 (kept on purpose, see above), and the deck's first section is
		// frontmatter-only, which the gather above strips to "" too. Neither
		// side says anything, so the section is not counted either way.
		if (note === "" || deck === "") continue;
		counted += note.length;
		covered += coveredLetters(note, deck);
	}
	if (counted === 0) return true;
	return covered * NOTE_CHECK_COVERAGE_DENOMINATOR >= counted * NOTE_CHECK_COVERAGE_NUMERATOR;
}

/**
 * How many of `note`'s letters lie inside a NOTE_CHECK_NEEDLE_CHARS run that
 * `deck` contains.
 *
 * CONTAINS, not a prefix: the rendered side legitimately carries text the
 * source does not begin with. The frontmatter is the case that cost this
 * feature every save it ever tried to make - Obsidian renders the note's
 * properties into the FIRST slide, so the deck's text began with
 * `handwriting-page-id...` while the note's began with the body, and a prefix
 * relation failed on every note that had ever been inked. The gather above
 * drops that block by class; this is the belt to its braces, and it holds for
 * anything else Obsidian decides to render around a slide.
 */
function coveredLetters(note: string, deck: string): number {
	const width = NOTE_CHECK_NEEDLE_CHARS;
	if (note.length <= width) return deck.includes(note) ? note.length : 0;
	let covered = 0;
	// Letters before `end` are already counted; windows come in order, so a
	// found window adds only the part of it past the last one.
	let end = 0;
	for (let at = 0; at + width <= note.length; at++) {
		if (!deck.includes(note.slice(at, at + width))) continue;
		covered += at + width - Math.max(at, end);
		end = at + width;
	}
	return covered;
}

export interface StoredSlide {
	index: number;
	hash: string;
}

/**
 * Where each stored slide's ink belongs in the deck as it is NOW (§3.6).
 *
 * Returns old index -> new index for every entry that moved; an entry that did
 * not move is absent. The rules, in order:
 *
 *  - the hash still matches the section at that index: nothing moved.
 *  - exactly one section in the whole deck matches: the slide moved there.
 *    This is the case that matters - a `---` added above the first slide - and
 *    it is why an index alone was never enough.
 *  - no match, or several (a duplicated slide): KEEP THE INDEX. Ink is never
 *    deleted and never guessed onto a slide it might not belong to; a section
 *    that comes back finds its ink where it left it.
 */
export function remapSlides(
	stored: readonly StoredSlide[],
	current: readonly string[]
): Map<number, number> {
	const moved = new Map<number, number>();
	// Built once: a deck is small, but this is a load-time loop over both
	// lists and the nested scan was the shape that made it quadratic.
	const byHash = new Map<string, number[]>();
	for (let i = 0; i < current.length; i++) {
		const list = byHash.get(current[i]!);
		if (list) list.push(i);
		else byHash.set(current[i]!, [i]);
	}
	// A section that still holds its own stored slide is SPOKEN FOR, and a
	// duplicate elsewhere must not be moved on top of it.
	const settled = new Set<number>();
	for (const slide of stored) {
		if (current[slide.index] === slide.hash) settled.add(slide.index);
	}
	// Claimants per section. Two STORED slides that share a hash both used to
	// resolve to the one surviving section and their ink was merged there,
	// which is a silent loss of the distinction between them - and §3.6 never
	// merges. Only the nearest claimant moves; the rest keep their index and
	// are counted as kept, exactly like the ambiguous case below.
	const claims = new Map<number, number[]>();
	for (const slide of stored) {
		if (current[slide.index] === slide.hash) continue;
		const matches = byHash.get(slide.hash);
		if (!matches || matches.length !== 1) continue;
		const target = matches[0]!;
		if (target === slide.index || settled.has(target)) continue;
		const list = claims.get(target);
		if (list) list.push(slide.index);
		else claims.set(target, [slide.index]);
	}
	for (const [target, claimants] of claims) {
		// Nearest by index, ties to the lower index: an edit moves a slide a
		// short way far more often than a long way, and a tie has to break
		// somewhere it can be written down.
		let best = claimants[0]!;
		for (const c of claimants) {
			const d = Math.abs(c - target);
			const bd = Math.abs(best - target);
			if (d < bd || (d === bd && c < best)) best = c;
		}
		moved.set(best, target);
	}
	// An unmatched slide keeps its old index. A moved slide cannot claim that
	// slot, nor a slot newly kept because its own target was reserved.
	const reserved = new Set(stored.filter(slide => !moved.has(slide.index)).map(slide => slide.index));
	let blocked = true;
	while (blocked) {
		blocked = false;
		for (const [source, target] of moved) {
			if (!reserved.has(target)) continue;
			moved.delete(source);
			reserved.add(source);
			blocked = true;
		}
	}
	return moved;
}

/**
 * The stored slides `remapSlides` could NOT place, split by what the reader
 * will see. Both cases keep their index - §3.6 never deletes and never guesses
 * - but they are not the same experience and the log has to tell them apart:
 *
 *  - `kept` counts every unplaced slide (no matching section, or several).
 *  - `visible` counts the ones whose old index still names a real section, so
 *    that ink is now drawn on a DIFFERENT, currently-shown slide. The rest sit
 *    past the end of the deck and are simply invisible until it grows back.
 *
 * A slide whose hash still matches its own index is placed, not kept.
 */
export function keptSlides(
	stored: readonly StoredSlide[],
	current: readonly string[],
	moved: ReadonlyMap<number, number>
): { kept: number; visible: number } {
	let kept = 0;
	let visible = 0;
	for (const slide of stored) {
		if (current[slide.index] === slide.hash) continue;
		if (moved.has(slide.index)) continue;
		kept++;
		if (slide.index < current.length) visible++;
	}
	return { kept, visible };
}

/** Apply a remap to the strokes' 1-based page numbers. Returns how many moved. */
export function remapStrokes(strokes: InkStroke[], moved: Map<number, number>): number {
	if (moved.size === 0) return 0;
	let n = 0;
	for (const s of strokes) {
		const from = slideOfPage(s.page);
		const to = moved.get(from);
		if (to === undefined) continue;
		s.page = pageOfSlide(to);
		n++;
	}
	return n;
}
