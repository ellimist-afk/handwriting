/**
 * Measuring a rendered root's lines: the line sources each section registers, the text rows and character tops read
 * from the DOM, the top-level blocks, and the spans the ink is placed against.
 */
import { type BlockBox, type BlockLines, type BlockRows, type BlockTable, type CachedSection, frontmatterOf, type LineSpans, spansFromCache, splitLines } from "./EmbedInkLines";
import { embedInkAnchor } from "./EmbedInkRoot";
import { isNotColumn, queueReplace } from "./EmbedInk";
import { isHeldLine } from "./EmbedInkMobileExport";

/**
 * Where a rendered section's source lines come from, handed in by the post-processor and read at paint, never at
 * post-processing: the renderer keeps a section's element when text above it changes, so lines read then go stale.
 */
export interface EmbedInkLineSource {
	/** The renderer's own answer for this element (getSectionInfo), or null when the render gives none. */
	section(): { text: string; lineStart: number; lineEnd: number } | null;
	/**
	 * For a render that gives no section info (an embed, an export): the note's cached sections and its text, or null
	 * while the text is still being read; `wake` is called once it has been.
	 */
	cached(wake: () => void): { sections: readonly CachedSection[]; text: string } | null;
}

/** Each root's rendered sections and their line sources (`recordLines`). */
export const lineSources = new WeakMap<HTMLElement, Map<HTMLElement, EmbedInkLineSource>>();
/** Per root: the renderer's text last read, as lines, and each section's lines under that text. */
export const lineMemos = new WeakMap<HTMLElement, { text: string; lines: string[]; of: WeakMap<HTMLElement, { lineStart: number; lineEnd: number }> }>();
/**
 * Each section's top and height in its root, px, as last measured: a section the virtualised renderer has detached
 * keeps the place it was laid out at (the renderer holds the text still with a margin of the same height).
 */
const lastBlockBoxes = new WeakMap<HTMLElement, BlockBox>();
/** Each section's line height as last measured while it was attached: a detached section has no computed style. */
const lastLineHeights = new WeakMap<HTMLElement, number>();

/** Remember a rendered section of `root` and where its lines come from. */
export function recordLines(root: HTMLElement, el: HTMLElement, source: EmbedInkLineSource): void {
	let held = lineSources.get(root);
	if (!held) lineSources.set(root, (held = new Map<HTMLElement, EmbedInkLineSource>()));
	held.set(el, source);
}

/** An element's top in `root`, px, from the root's padding edge (where the layer's own top is measured from); null when it is not laid out there. */
function topInRoot(root: HTMLElement, el: HTMLElement): number | null {
	let top = 0;
	for (let node: HTMLElement = el; node !== root; ) {
		const parent = node.offsetParent as HTMLElement | null;
		if (!parent) return null;
		top += node.offsetTop;
		if (parent === root) return top;
		// The chain passed the root by (the root is not positioned): no top in its frame.
		if (parent.contains(root)) return null;
		top += parent.clientTop || 0;
		node = parent;
	}
	return 0;
}

/** `target`'s computed line height, px; 0 when it has no computed style (it is detached). */
function computedLineHeight(target: HTMLElement): number {
	const style = target.ownerDocument?.defaultView?.getComputedStyle?.(target);
	const lh = parseFloat(style?.lineHeight ?? "");
	if (Number.isFinite(lh) && lh > 0) return lh;
	const font = parseFloat(style?.fontSize ?? "");
	return Number.isFinite(font) && font > 0 ? font * 1.2 : 0;
}

/**
 * One rendered line's height in a block, px: its first child's computed line height (the paragraph, not its wrapper).
 * A block the renderer has detached has none, so it keeps the height it last had attached, else the root's.
 */
function lineHeightOf(root: HTMLElement, el: HTMLElement): number {
	const own = computedLineHeight((el.firstElementChild as HTMLElement | null) ?? el);
	if (own > 0) {
		lastLineHeights.set(el, own);
		return own;
	}
	return lastLineHeights.get(el) ?? computedLineHeight(root);
}

/** The elements whose rows can pair with source lines (`rowsOf`). */
const ROW_HOST = /^(UL|OL|PRE|P)$/;

/**
 * Whether `el` can host rows: a list, a code block, a paragraph, or a paragraph a phone or tablet export holds as a div
 * (`isHeldLine`, by identity), whose rows are the paragraph's.
 */
function isRowHost(el: Element | null): el is HTMLElement {
	return !!el && (ROW_HOST.test(el.tagName) || isHeldLine(el));
}

/**
 * The rows `el` shows, by its kind (EmbedInkLines.ts, `BlockRows`), read from the block itself or, where a wrapper holds
 * it (a reading view's section, a print's block), from its first element child: a list's items, a code block's rows of
 * code, a paragraph's lines as its hard breaks and the line feeds in its text start them (`lineStarts`). A paragraph a
 * phone or tablet export wrote as a div (`holdHostLines`) is read as that paragraph, so a build after the hold reads the
 * same rows as the build before it. Offsets are
 * client rects from `el`'s own, brought to layout px by `el`'s layout height over its rect height, so a zoom or
 * transform on the way to the screen cancels out. A row
 * of text is found by its first character: characters of one font sit one distance under their line's top, so two
 * such characters' tops differ by what their lines' tops do. A line that holds an embed or a picture and no text has
 * no first character: its row is the least top of its embeds' and pictures' boxes, or its own row of text where they
 * are shorter than the line. Where the first line is such a line, a later line of text only takes its first
 * character's top less the leading above it. Nothing is read until a stroke asks for a row.
 */
function rowsOf(el: HTMLElement): BlockRows | null {
	const first = el.firstElementChild as HTMLElement | null;
	const host = isRowHost(el) ? el : isRowHost(first) ? first : null;
	if (!host) return null;
	const frame = el.getBoundingClientRect();
	if (!(frame.height > 0) || !(el.offsetHeight > 0)) return null;
	// The layout height is whole px: within a px of the rect, the rect is in layout px already.
	const scale = Math.abs(el.offsetHeight - frame.height) <= 1 ? 1 : el.offsetHeight / frame.height;
	const below = (clientTop: number) => (clientTop - frame.top) * scale;
	if (host.tagName === "UL" || host.tagName === "OL") {
		const items: Element[] = [];
		for (let c = host.firstElementChild; c; c = c.nextElementSibling) if (c.tagName === "LI") items.push(c);
		return {
			kind: "list",
			count: items.length,
			top: (k) => {
				const item = items[k];
				return item ? below(item.getBoundingClientRect().top) : null;
			},
		};
	}
	// A row of text starts at its first line's top: the host's content top for the first row.
	const style = el.ownerDocument.defaultView?.getComputedStyle(host);
	const contentTop = below(host.getBoundingClientRect().top) + host.clientTop + (parseFloat(style?.paddingTop ?? "") || 0);
	const fromFirst = (top: number | null, firstTop: number | null) =>
		top === null || firstTop === null ? null : contentTop + (top - firstTop) * scale;
	if (host.tagName === "PRE") {
		const code = host.querySelector<HTMLElement>(":scope > code");
		if (!code) return null;
		// Each row's first character, a line feed for an empty row; a line feed ending the text starts no row.
		const starts: Array<[Text, number]> = [];
		let open = true;
		for (const node of textNodes(code)) {
			for (let i = 0; i < node.data.length; i++) {
				if (open) starts.push([node, i]);
				open = node.data.charCodeAt(i) === 10;
			}
		}
		return {
			kind: "code",
			count: starts.length,
			top: (k) => {
				const at = starts[k], at0 = starts[0];
				return at && at0 ? fromFirst(charTop(at[0], at[1]), charTop(at0[0], at0[1])) : null;
			},
		};
	}
	const held: LineHeld[] = [];
	const starts = lineStarts(host, held);
	// A row's top from a box of the paragraph's own text on it (a character, a hard break, an inline embed's span): the
	// box less the leading the layout puts above it, half the line height's spare, floored to a whole px as Chromium
	// splits it.
	const textRowTop = (box: DOMRect) => below(box.top) - Math.floor((computedLineHeight(host) - box.height * scale) / 2);
	// A line that holds an embed or a picture and no text: the least top of its boxes (a block's own, an inline
	// picture's), and the row of its text boxes where the boxes are shorter than the line (the hard break ending it, an
	// inline span).
	const boxRowTop = (k: number): number | null => {
		let least = Infinity, inline = true, strut: DOMRect | null = null;
		for (const box of held[k]!.boxes) {
			for (const part of [box, ...Array.from(box.children)]) {
				const r = part.getBoundingClientRect();
				if (r.width > 0 || r.height > 0) least = Math.min(least, r.top);
			}
			const display = el.ownerDocument.defaultView?.getComputedStyle(box).display ?? "";
			if (!display.startsWith("inline")) inline = false;
			else if (!strut && box.tagName !== "IMG") strut = box.getBoundingClientRect();
		}
		if (!Number.isFinite(least)) return null;
		const close = held[k + 1]?.br?.getBoundingClientRect();
		if (close && close.height > 0) strut = close;
		let own = inline && strut && strut.height > 0 ? textRowTop(strut) : Infinity;
		// The paragraph's last line, its boxes all pictures: no hard break closes it and no box of text is on it. Its
		// line ends at the content's bottom, so a picture shorter than the line still takes the line's own top.
		if (inline && own === Infinity && k === held.length - 1) {
			const bottom = below(host.getBoundingClientRect().bottom) - (parseFloat(style?.borderBottomWidth ?? "") || 0)
				- (parseFloat(style?.paddingBottom ?? "") || 0);
			own = bottom - computedLineHeight(host);
		}
		return Math.min(below(least), own);
	};
	return {
		kind: "breaks",
		count: starts.length,
		top: (k) => {
			if (k === 0) return contentTop;
			const at = starts[k], at0 = starts[0];
			if (at && at0) return fromFirst(charTop(at[0], at[1]), charTop(at0[0], at0[1]));
			const line = held[k];
			if (!line) return null;
			if (!at) return line.boxes.length ? boxRowTop(k) : null;
			// The first line holds an embed or a picture and no text, so no row counts from it: a line of text only takes
			// its own.
			if (!held[0]!.boxes.length || line.boxes.length || line.other) return null;
			const box = charBox(at[0], at[1]);
			return box ? textRowTop(box) : null;
		},
	};
}

/** Inline elements whose text is the renderer's, not the source's: math, svg, an embed. */
const NOT_LINES = "svg, math, mjx-container, .math, .internal-embed, .markdown-embed";
/** Of those, an embed: its own top is its line's when the line holds no text. */
const EMBED_BOX = ".internal-embed, .markdown-embed";
/**
 * Elements the walk enters that are not the paragraph's text and not a picture: a line holding one is not a line of
 * text only.
 */
const NOT_TEXT = "iframe, video, audio, canvas, object, embed, input";

/** What a paragraph's source line holds beside its start (`lineStarts`). */
interface LineHeld {
	/**
	 * The embeds and the pictures on the line, in document order. A picture is an img the walk meets: outside an embed
	 * (whose subtree it skips), a linked picture's too.
	 */
	boxes: Element[];
	/** Whether the line holds anything else that is not its text: math, an svg, a frame. */
	other: boolean;
	/** The hard break that started the line, which ends the line before it; null for a line a line feed started. */
	br: Element | null;
}

/**
 * A paragraph's source lines as it shows them, in document order: each line's first character that is not white space,
 * null for a line with none. A line starts after each hard break and after each line feed in its text (strict line
 * breaks on: the renderer keeps the source's line feeds and the layout flows the lines together); the line feed the
 * renderer writes after a hard break starts no second line, and a line feed ending the text starts none. Text the
 * renderer draws in place of the source (math, an svg, an embed) holds none of the paragraph's lines: it is skipped,
 * and `held`, when given, gets what each line holds beside its start, one entry per line.
 */
function lineStarts(host: HTMLElement, held?: LineHeld[]): Array<[Text, number] | null> {
	const starts: Array<[Text, number] | null> = [null];
	const lines: LineHeld[] = held ?? [];
	lines.push({ boxes: [], other: false, br: null });
	let afterBreak = false, endsInFeed = false;
	const walker = host.ownerDocument.createTreeWalker(host, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
		acceptNode: (n) => {
			if (n.nodeType === Node.TEXT_NODE || !(n as Element).matches(NOT_LINES)) return NodeFilter.FILTER_ACCEPT;
			const line = lines[lines.length - 1]!;
			if ((n as Element).matches(EMBED_BOX)) line.boxes.push(n as Element);
			else line.other = true;
			return NodeFilter.FILTER_REJECT;
		},
	});
	for (let n = walker.nextNode(); n; n = walker.nextNode()) {
		if (n.nodeType !== Node.TEXT_NODE) {
			if ((n as Element).tagName === "BR") {
				starts.push(null);
				lines.push({ boxes: [], other: false, br: n as Element });
				afterBreak = true;
				endsInFeed = false;
			} else if ((n as Element).tagName === "IMG") lines[lines.length - 1]!.boxes.push(n as Element);
			else if ((n as Element).matches(NOT_TEXT)) lines[lines.length - 1]!.other = true;
			continue;
		}
		const data = (n as Text).data;
		for (let i = 0; i < data.length; i++) {
			if (data.charCodeAt(i) === 10) {
				if (afterBreak) afterBreak = false;
				else {
					starts.push(null);
					lines.push({ boxes: [], other: false, br: null });
					endsInFeed = true;
				}
				continue;
			}
			if (/\s/.test(data[i]!)) continue;
			afterBreak = endsInFeed = false;
			if (starts[starts.length - 1] === null) starts[starts.length - 1] = [n as Text, i];
		}
	}
	if (endsInFeed) {
		starts.pop();
		lines.pop();
	}
	return starts;
}

function textNodes(root: HTMLElement): Text[] {
	const out: Text[] = [];
	const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
	return out;
}

/** The client top of one character, or null when it is not laid out. */
function charTop(node: Text, at: number): number | null {
	const range = node.ownerDocument.createRange();
	range.setStart(node, at);
	range.setEnd(node, at + 1);
	const rect = range.getClientRects().item(0);
	return rect && (rect.height > 0 || rect.width > 0) ? rect.top : null;
}

/** The client box of one character, or null when it is not laid out. */
function charBox(node: Text, at: number): DOMRect | null {
	const range = node.ownerDocument.createRange();
	range.setStart(node, at);
	range.setEnd(node, at + 1);
	const rect = range.getClientRects().item(0);
	return rect && (rect.height > 0 || rect.width > 0) ? rect : null;
}

/** Top-level elements of a render that are not one of the note's sections. */
const NOT_SECTION = ["inline-title", "metadata-container", "mod-header", "mod-footer", "frontmatter", "mod-frontmatter", "embed-title", "markdown-embed-title", "footnotes"];

function notSection(el: Element | null): boolean {
	if (!el) return false;
	for (const cls of NOT_SECTION) if (el.classList?.contains(cls)) return true;
	return false;
}

/**
 * A render's laid-out top-level blocks, for a render that gives no section info: `el`'s element children, less the
 * file name a print adds, our own layers and the elements that are not sections (the inline title, Properties,
 * frontmatter, the footnotes list).
 */
function topBlocks(root: HTMLElement, el: HTMLElement): HTMLElement[] {
	const title = el === root ? root.querySelector<HTMLElement>(":scope > h1") : null;
	const out: HTMLElement[] = [];
	const children = el.children as ArrayLike<Element> | undefined;
	if (!children) return out;
	for (let i = 0; i < children.length; i++) {
		const child = children[i] as HTMLElement | undefined;
		if (!child || child === title || isNotColumn(child) || !child.offsetParent) continue;
		if (notSection(child) || notSection(child.firstElementChild)) continue;
		out.push(child);
	}
	return out;
}

/** Block tops a print held before it paged the layout: the blocks and their tops in the layer's frame, px. */
export interface HeldTops {
	blocks: readonly HTMLElement[];
	tops: readonly number[];
}

/** The text nodes under `el` in order, none under an element its own style hides (display none). */
function shownTexts(el: Node, out: Text[] = []): Text[] {
	for (let c = el.firstChild; c; c = c.nextSibling) {
		if (c.nodeType === Node.TEXT_NODE) out.push(c as Text);
		else if (c.nodeType === Node.ELEMENT_NODE && (c as HTMLElement).style?.display !== "none") shownTexts(c, out);
	}
	return out;
}

/**
 * Elements whose tables are not drawn from the block's own source lines: an embed's (another note's text), a quote's and
 * a callout's (the source reads no table in quoted lines).
 */
const NOT_OWN_TABLE = ".internal-embed, .markdown-embed, blockquote, .callout";

/** One table a block draws from its own source lines, and its own rows (none of a table inside it). */
interface OwnTable {
	table: Element;
	rows: Element[];
}

/**
 * The tables block `el` draws from its own source lines, in document order: each table under it less those inside an
 * element of NOT_OWN_TABLE that is itself inside `el` (the block may sit in an embed or a callout). One walk.
 */
function ownTables(el: HTMLElement): OwnTable[] {
	const out: OwnTable[] = [], rowsOf = new Map<Element, Element[]>();
	for (const n of Array.from(el.querySelectorAll("table, tr"))) {
		if (n.tagName !== "TABLE") {
			const t = n.closest("table");
			if (t) rowsOf.get(t)?.push(n);
			continue;
		}
		let theirs = false;
		for (let p = n.parentElement; p && p !== el && !theirs; p = p.parentElement) theirs = p.matches(NOT_OWN_TABLE);
		if (theirs) continue;
		const rows: Element[] = [];
		rowsOf.set(n, rows);
		out.push({ table: n, rows });
	}
	return out;
}

/**
 * The table `own` of block `el`, read for a link inside one of its cells: each cell's text as it is asked for. Null
 * unless the table shows `rows` rows of `ncol` cells (th or td), as the source reads. A character's place is its client
 * rect brought to layout px by the block's layout height over its rect height (as `rowsOf`): its top from the block's top
 * (`top()`, the held top in a print), its left from the root's padding edge less the layer's (`left()`).
 */
function tableOf(root: HTMLElement, el: HTMLElement, table: OwnTable | undefined, rows: number, ncol: number, top: () => number | null, left: () => number): BlockTable | null {
	const own = table?.rows ?? [];
	if (!table || own.length !== rows) return null;
	const cells = own.map((tr) => Array.from(tr.children).filter((c) => c.tagName === "TD" || c.tagName === "TH"));
	if (cells.some((r) => r.length !== ncol)) return null;
	const texts = new Map<number, { text: string; nodes: { node: Text; start: number }[] } | null>();
	const read = (row: number, col: number) => {
		const key = row * ncol + col;
		if (texts.has(key)) return texts.get(key)!;
		const td = cells[row]?.[col] as HTMLElement | undefined;
		let out: { text: string; nodes: { node: Text; start: number }[] } | null = null;
		if (td && td.style?.display !== "none") {
			const nodes: { node: Text; start: number }[] = [];
			let at = 0;
			for (const node of shownTexts(td)) {
				nodes.push({ node, start: at });
				at += node.data.length;
			}
			out = { text: nodes.map((n) => n.node.data).join(""), nodes };
		}
		texts.set(key, out);
		return out;
	};
	return {
		text: (row, col) => read(row, col)?.text ?? null,
		charAt: (row, col, k) => {
			const c = read(row, col);
			let n = c?.nodes[0];
			for (const x of c?.nodes ?? []) if (x.start <= k) n = x;
			if (!n || k < n.start || k - n.start >= n.node.data.length) return null;
			const range = n.node.ownerDocument.createRange();
			range.setStart(n.node, k - n.start);
			range.setEnd(n.node, k - n.start + 1);
			const rect = range.getClientRects().item(0);
			const blockTop = top();
			if (!rect || blockTop === null) return null;
			const frame = el.getBoundingClientRect(), edge = root.getBoundingClientRect();
			if (!(frame.height > 0) || !(el.offsetHeight > 0)) return null;
			const scale = Math.abs(el.offsetHeight - frame.height) <= 1 ? 1 : el.offsetHeight / frame.height;
			return {
				left: (rect.left - edge.left - (root.clientLeft || 0)) * scale + (root.scrollLeft || 0) - left(),
				top: blockTop + (rect.top - frame.top) * scale,
			};
		},
	};
}

/**
 * What `root` knows of the note's lines, measured now: from the renderer's section info where it gives any, else from
 * the cached sections laid onto the render's blocks. Null when neither answers (no source recorded, the text not yet
 * read, a render the cached sections do not match). Each block is measured only when a stroke asks for its box, and
 * its table read only when a link inside one of its cells asks. `left` gives the ink layer's left in the root, px (layerAt), read only then.
 */
export function measureSpans(root: HTMLElement, held?: HeldTops, left: () => number = () => 0): LineSpans | null {
	const sources = lineSources.get(root);
	if (!sources || sources.size === 0) return null;
	const anchorTop = embedInkAnchor(root)?.top ?? 0;
	const block = (el: HTMLElement, lineStart: number, lineEnd: number): BlockLines => {
		let box: BlockBox | null | undefined;
		let rows: BlockRows | null | undefined;
		let tables: OwnTable[] | undefined;
		const reads = new Map<string, BlockTable | null>();
		const boxOf = (): BlockBox | null => {
			if (box !== undefined) return box;
			const k = held ? held.blocks.indexOf(el) : -1;
			if (held && k >= 0 && held.tops[k] !== undefined) return (box = { top: held.tops[k], height: el.offsetHeight });
			const top = topInRoot(root, el);
			if (top === null) {
				const last = lastBlockBoxes.get(el);
				return (box = last ? { top: last.top - anchorTop, height: last.height } : null);
			}
			const at = { top, height: el.offsetHeight };
			lastBlockBoxes.set(el, at);
			return (box = { top: top - anchorTop, height: at.height });
		};
		return {
			lineStart,
			lineEnd,
			box: boxOf,
			table: (index, count, n, ncol) => {
				// Each read is kept by the table's index as well as its shape: two tables of one shape in the block are two reads.
				const key = `${index}/${count}:${n}x${ncol}`;
				let read = reads.get(key);
				if (read !== undefined) return read;
				tables ??= ownTables(el);
				read = tables.length === count ? tableOf(root, el, tables[index], n, ncol, () => boxOf()?.top ?? null, left) : null;
				reads.set(key, read);
				return read;
			},
			lineHeight: () => lineHeightOf(root, el),
			rows: () => (rows !== undefined ? rows : (rows = rowsOf(el))),
		};
	};
	// The renderer's own answers. The first section asked carries the text; while it stays the same string, a section
	// already read keeps its lines, so a paint costs one walk of the renderer's sections rather than one per section.
	let memo = lineMemos.get(root);
	let asked = false;
	const found: Array<{ el: HTMLElement; lineStart: number; lineEnd: number }> = [];
	for (const [el, source] of [...sources]) {
		let lines = memo?.of.get(el);
		if (!lines || !asked || !el.isConnected) {
			const info = source.section();
			if (!info) {
				// Not the renderer's any more (a section rendered again is a new element): forget it.
				if (!el.isConnected || asked) sources.delete(el);
				continue;
			}
			if (!memo || memo.text !== info.text) {
				memo = { text: info.text, lines: splitLines(info.text), of: new WeakMap() };
				lineMemos.set(root, memo);
			}
			lines = { lineStart: info.lineStart, lineEnd: info.lineEnd };
			memo.of.set(el, lines);
			asked = true;
		}
		found.push({ el, ...lines });
	}
	if (memo && found.length > 0) {
		const skip = frontmatterOf(memo.lines);
		found.sort((a, b) => a.lineStart - b.lineStart || Number(b.el.isConnected) - Number(a.el.isConnected));
		const blocks: BlockLines[] = [];
		let end = -1;
		for (const f of found) {
			// The frontmatter's own section is no block, and of two elements on the same lines the connected one stands.
			if (skip && f.lineStart <= skip.to) continue;
			if (f.lineStart <= end || f.lineEnd < f.lineStart) continue;
			blocks.push(block(f.el, f.lineStart, f.lineEnd));
			end = f.lineEnd;
		}
		return { lines: memo.lines, blocks, skip: skip ? [skip] : [] };
	}
	// No section info: the cached sections, laid onto the render's blocks in order. The first source that has its text
	// answers; one still reading it asks for this root to be placed again once it has.
	for (const [el, source] of sources) {
		const cache = source.cached(() => queueReplace(root));
		if (!cache) continue;
		return spansFromCache(cache, topBlocks(root, el), (b) => [b.tagName, b.firstElementChild?.tagName ?? null] as const, block);
	}
	return null;
}
