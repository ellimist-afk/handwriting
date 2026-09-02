/**
 * The textual half of a Handwriting page (handoff §17, §18).
 *
 * The `.md` file stays real Obsidian data: wiki links, tags, headings and
 * embeds inside text containers are indexed normally. Containers are delimited
 * by HTML comments, which render as nothing, survive round-tripping through
 * other editors, and give each container a stable anchor id that the sidecar
 * refers to.
 *
 *     ---
 *     handwriting: page
 *     handwriting-version: 1
 *     handwriting-page-id: 9201c8...
 *     ---
 *
 *     <!-- handwriting:textbox id=tb-001 -->
 *     ## Meeting
 *     Talked about [[LanMouse]].
 *     <!-- /handwriting:textbox -->
 *
 * Design rule: anything in the file we did not write is preserved verbatim. If
 * the plugin is uninstalled the note is still readable Markdown, and if a user
 * edits the file by hand we must not silently eat their text.
 */

export const FM_MARKER = "handwriting";
export const FM_MARKER_VALUE = "page";
export const FM_VERSION = "handwriting-version";
export const FM_PAGE_ID = "handwriting-page-id";
export const MD_VERSION = 1;

const OPEN_RE = /^<!--\s*handwriting:textbox\s+id=([A-Za-z0-9_-]+)\s*-->$/;
const CLOSE_RE = /^<!--\s*\/handwriting:textbox\s*-->$/;
const IMG_OPEN_RE = /^<!--\s*handwriting:image\s+id=([A-Za-z0-9_-]+)\s*-->$/;
const IMG_CLOSE_RE = /^<!--\s*\/handwriting:image\s*-->$/;
/** The embed inside an image block: ![[path]] or ![alt](path). */
const EMBED_RE = /!\[\[([^\]]+)\]\]|!\[[^\]]*\]\(([^)]+)\)/;

export interface MarkdownBlock {
	id: string;
	text: string;
}

/**
 * An image placed on the page. The `target` is the vault path Obsidian
 * resolves. It lives in the Markdown as a real embed so the attachment is
 * linked, counted as used, and follows renames on its own.
 */
export interface MarkdownImage {
	id: string;
	target: string;
}

export interface ParsedMarkdownPage {
	/** Frontmatter lines between the --- fences, verbatim (no fences). */
	frontmatter: string[];
	pageId: string | undefined;
	/** Declared `handwriting-version`, when present. Used to refuse writing a newer format. */
	version: number | undefined;
	isHandwritingPage: boolean;
	blocks: MarkdownBlock[];
	images: MarkdownImage[];
	/** Body content outside any handwriting block, preserved verbatim. */
	extra: string;
	/**
	 * Everything after the frontmatter, verbatim past line-ending normalization
	 * (rejoined with `eol`, not necessarily the file's original `\n`). This is
	 * the ONLY answer to "where does the body begin". A second implementation of
	 * that question corrupted notes with malformed fences the moment the page
	 * id was first written, because the two parsers disagreed about which lines
	 * were frontmatter (audit v0.8.0 #3).
	 */
	rawBody: string;
	/**
	 * The file's own line ending, detected once from the raw text and reused
	 * everywhere this parse gets reassembled. Before this, `rawBody` and
	 * `composeMarkdownPage` always rejoined with `\n`, so a Windows-authored
	 * (CRLF) note that gained a page id came back with every line ending
	 * rewritten - a whole-file diff in git and a whole-file change to sync,
	 * for a one-line frontmatter insert (audit-fixes-design.md 5i I5).
	 *
	 * Detection is file-wide, not per-line: a single `\r\n` anywhere in the
	 * text is enough to call the whole file CRLF. A genuinely mixed file
	 * (both conventions present) is therefore normalized to CRLF on
	 * reassembly rather than preserved line-for-line - `splitLines` already
	 * collapses every `\r\n` to `\n` before anything is split, so the exact
	 * position of each original line ending is not something a later rejoin
	 * could recover anyway. CRLF is the one that wins a mixed file because it
	 * is the less common case in this codebase's actual notes: guessing LF
	 * for a file that has deliberately-added CRLF lines would be the more
	 * surprising rewrite of the two.
	 */
	eol: "\r\n" | "\n";
}

function splitLines(text: string): string[] {
	return text.replace(/\r\n/g, "\n").split("\n");
}

/** Flat `key: value` lookup. Enough for our own keys, and it never rewrites the user's. */
function frontmatterValue(lines: string[], key: string): string | undefined {
	const prefix = `${key}:`;
	for (const line of lines) {
		if (line.startsWith(prefix)) return line.slice(prefix.length).trim();
	}
	return undefined;
}

/**
 * Block ids must be unique across the whole document. The sidecar keys
 * geometry by id, and it does not care whether that id came from a container
 * or an image.
 *
 * A duplicate is not hypothetical: copying a block by hand, or a sync merge
 * duplicating a section, produces one. Before this, the later block's content
 * won and was then written back into BOTH blocks, so the earlier one's words,
 * or its `![[embed]]` pointing at a completely different attachment, were
 * destroyed in the user's own file on the next save.
 *
 * Renaming the duplicate keeps both. The new id is written back on the next
 * save, so it settles immediately, and copying a block becomes a legitimate way
 * to place a second copy of something rather than a way to lose one.
 */
function makeIdUniquifier(): (id: string) => string {
	const seen = new Set<string>();
	return (id: string): string => {
		if (!seen.has(id)) {
			seen.add(id);
			return id;
		}
		let n = 2;
		while (seen.has(`${id}-${n}`)) n++;
		const fresh = `${id}-${n}`;
		seen.add(fresh);
		return fresh;
	};
}

export function parseMarkdownPage(md: string): ParsedMarkdownPage {
	// First occurrence wins: scanned once, before splitLines throws the
	// distinction away. See the `eol` doc comment on ParsedMarkdownPage for
	// the mixed-file rule this implies.
	const eol: "\r\n" | "\n" = md.includes("\r\n") ? "\r\n" : "\n";
	const lines = splitLines(md);
	let i = 0;
	const frontmatter: string[] = [];
	const uniqueId = makeIdUniquifier();

	if (lines[0]?.trim() === "---") {
		let close = -1;
		for (let j = 1; j < lines.length; j++) {
			if (lines[j]!.trim() === "---") {
				close = j;
				break;
			}
		}
		// An unterminated fence is NOT frontmatter. Obsidian treats a lone
		// leading `---` as body (a horizontal rule), and so do we. Swallowing
		// the rest of the file as "frontmatter" here used to fabricate YAML
		// out of the user's prose the first time the page id was written.
		if (close > 0) {
			for (let j = 1; j < close; j++) frontmatter.push(lines[j]!);
			i = close + 1;
		}
	}
	const rawBody = lines.slice(i).join(eol);

	const blocks: MarkdownBlock[] = [];
	const images: MarkdownImage[] = [];
	const extraLines: string[] = [];
	while (i < lines.length) {
		const line = lines[i]!;
		const imgOpen = IMG_OPEN_RE.exec(line.trim());
		if (imgOpen) {
			const id = imgOpen[1]!;
			const body: string[] = [];
			i++;
			while (i < lines.length && !IMG_CLOSE_RE.test(lines[i]!.trim())) {
				body.push(lines[i]!);
				i++;
			}
			i++;
			const embed = EMBED_RE.exec(body.join("\n"));
			const target = embed?.[1] ?? embed?.[2];
			// A block whose embed we cannot read is not silently dropped: it
			// falls through to `extra` and stays in the file verbatim.
			if (target) images.push({ id: uniqueId(id), target: target.trim() });
			else extraLines.push(...body);
			continue;
		}
		const open = OPEN_RE.exec(line.trim());
		if (open) {
			const id = open[1]!;
			const body: string[] = [];
			i++;
			while (i < lines.length && !CLOSE_RE.test(lines[i]!.trim())) {
				body.push(lines[i]!);
				i++;
			}
			i++; // closing marker (or EOF; an unterminated block still yields its text)
			blocks.push({ id: uniqueId(id), text: trimBlank(body).join("\n") });
			continue;
		}
		extraLines.push(line);
		i++;
	}

	const marker = frontmatterValue(frontmatter, FM_MARKER);
	const rawVersion = frontmatterValue(frontmatter, FM_VERSION);
	const version = rawVersion === undefined ? undefined : Number.parseInt(rawVersion, 10);
	return {
		frontmatter,
		pageId: frontmatterValue(frontmatter, FM_PAGE_ID),
		version: version !== undefined && Number.isFinite(version) ? version : undefined,
		isHandwritingPage: marker === FM_MARKER_VALUE || marker === "true",
		blocks,
		images,
		extra: trimBlank(extraLines).join("\n"),
		rawBody,
		eol,
	};
}

function trimBlank(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && lines[start]!.trim() === "") start++;
	while (end > start && lines[end - 1]!.trim() === "") end--;
	return lines.slice(start, end);
}

/**
 * Replace our keys in existing frontmatter, keeping every other key untouched.
 *
 * We never *add* the `handwriting:` marker. There is no such thing as a Handwriting file:
 * any note can be opened on the canvas, and the marker only ever means "this
 * note prefers to open in the canvas view", a preference the user (or `New
 * canvas page`) sets, not something Handwriting stamps on a note it was merely shown.
 * An existing marker is preserved verbatim, so notes that already have one keep
 * working exactly as before.
 *
 * `handwriting-version` describes the block-marker format, so it is written only when
 * the file actually carries markers.
 */
export function updateFrontmatter(
	existing: string[],
	pageId: string,
	opts: { version?: boolean } = {}
): string[] {
	const ours = new Map<string, string>();
	if (opts.version !== false) ours.set(FM_VERSION, String(MD_VERSION));
	ours.set(FM_PAGE_ID, pageId);
	const out: string[] = [];
	const seen = new Set<string>();
	for (const line of existing) {
		const key = line.slice(0, line.indexOf(":"));
		if (ours.has(key)) {
			if (seen.has(key)) continue; // drop duplicates of our own keys
			out.push(`${key}: ${ours.get(key)!}`);
			seen.add(key);
		} else {
			out.push(line);
		}
	}
	for (const [key, value] of ours) {
		if (!seen.has(key)) out.push(`${key}: ${value}`);
	}
	return out;
}

export interface ComposeInput {
	pageId: string;
	frontmatter?: string[];
	blocks: MarkdownBlock[];
	images?: MarkdownImage[];
	extra?: string;
	/**
	 * The line ending to rejoin with - a parse's own `eol`, when this compose
	 * is reassembling a file that already existed. Defaults to `\n`: a brand
	 * new page (`newPageMarkdown`) has no original EOL to honour, and every
	 * other existing caller composed with `\n` before this field existed, so
	 * the default keeps their output unchanged (5i I5).
	 */
	eol?: "\r\n" | "\n";
}

export function composeMarkdownPage(input: ComposeInput): string {
	const eol = input.eol ?? "\n";
	const fm = updateFrontmatter(input.frontmatter ?? [], input.pageId);
	const parts: string[] = ["---", ...fm, "---", ""];
	for (const block of input.blocks) {
		parts.push(`<!-- handwriting:textbox id=${block.id} -->`);
		if (block.text.length > 0) parts.push(block.text);
		parts.push("<!-- /handwriting:textbox -->", "");
	}
	for (const image of input.images ?? []) {
		parts.push(
			`<!-- handwriting:image id=${image.id} -->`,
			`![[${image.target}]]`,
			"<!-- /handwriting:image -->",
			""
		);
	}
	const extra = (input.extra ?? "").trim();
	if (extra.length > 0) parts.push(extra, "");
	return parts.join(eol);
}

/**
 * The body a brand-new page starts with.
 *
 * This is the one place the `handwriting:` marker is written, because here the user
 * explicitly asked for a canvas. The marker records that preference so the
 * note opens on the canvas next time. It does not make the file a different
 * kind of document: delete the line and it is still an ordinary note, and every
 * ordinary note without the line is still fully drawable.
 */
export function newPageMarkdown(pageId: string): string {
	return composeMarkdownPage({
		pageId,
		frontmatter: [`${FM_MARKER}: ${FM_MARKER_VALUE}`],
		blocks: [],
	});
}
