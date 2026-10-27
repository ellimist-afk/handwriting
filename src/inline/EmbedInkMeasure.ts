/**
 * Measuring a rendered root's lines: the line sources each section registers, the text rows and character tops read
 * from the DOM, the top-level blocks, and the spans the ink is placed against.
 */
import { type BlockBox, type BlockLines, type BlockRows, type CachedSection, frontmatterOf, type LineSpans, spansFromCache, splitLines } from "./EmbedInkLines";
import { embedInkAnchor } from "./EmbedInkRoot";
import { isNotColumn, queueReplace } from "./EmbedInk";

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
 * The rows `el` shows, by its kind (EmbedInkLines.ts, `BlockRows`), read from the block itself or, where a wrapper holds
 * it (a reading view's section, a print's block), from its first element child: a list's items, a code block's rows of
 * code, a paragraph's lines as its hard breaks start them. Offsets are client rects from `el`'s own, brought to layout
 * px by `el`'s layout height over its rect height, so a zoom or transform on the way to the screen cancels out. A row
 * of text is found by its first character: characters of one font sit one distance under their line's top, so two
 * such characters' tops differ by what their lines' tops do. Nothing is read until a stroke asks for a row.
 */
function rowsOf(el: HTMLElement): BlockRows | null {
	const first = el.firstElementChild as HTMLElement | null;
	const host = ROW_HOST.test(el.tagName) ? el : first && ROW_HOST.test(first.tagName) ? first : null;
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
	const breaks = Array.from(host.getElementsByTagName("br"));
	return {
		kind: "breaks",
		count: breaks.length + 1,
		top: (k) => {
			if (k === 0) return contentTop;
			const after = breaks[k - 1];
			if (!after) return null;
			return fromFirst(firstCharTop(host, after, breaks[k] ?? null), firstCharTop(host, null, breaks[0] ?? null));
		},
	};
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

/** The client top of the first character that is not white space after `after` (or from the start) and before `before`. */
function firstCharTop(host: HTMLElement, after: Node | null, before: Node | null): number | null {
	for (const node of textNodes(host)) {
		if (after && !(after.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
		if (before && before.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) return null;
		const at = node.data.search(/\S/);
		if (at >= 0) return charTop(node, at);
	}
	return null;
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

/**
 * What `root` knows of the note's lines, measured now: from the renderer's section info where it gives any, else from
 * the cached sections laid onto the render's blocks. Null when neither answers (no source recorded, the text not yet
 * read, a render the cached sections do not match). Each block is measured only when a stroke asks for its box.
 */
export function measureSpans(root: HTMLElement, held?: HeldTops): LineSpans | null {
	const sources = lineSources.get(root);
	if (!sources || sources.size === 0) return null;
	const anchorTop = embedInkAnchor(root)?.top ?? 0;
	const block = (el: HTMLElement, lineStart: number, lineEnd: number): BlockLines => {
		let box: BlockBox | null | undefined;
		let rows: BlockRows | null | undefined;
		return {
			lineStart,
			lineEnd,
			box: () => {
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
