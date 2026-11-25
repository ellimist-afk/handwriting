/**
 * A read-only view of a note for the attach rigs: Reading view, an embed of the note, or the print container of Export to
 * PDF, as the plugin's view code reads it (EmbedInkMeasure.ts measureSpans, through EmbedInk.ts placeStrokes).
 *
 * The root holds one block element per section of the note, in order, each laid out in the root (offsetParent the root,
 * offsetTop its top in the root's frame, offsetHeight its height), its first element child the section's own element
 * (a paragraph's p, a table's table). How each view tells the code the block's source lines:
 *  - Reading view: each block's line source answers section() (the renderer's getSectionInfo).
 *  - An embed and a print: section() answers none; cached() answers the note's cached sections and its text, which the
 *    code lays onto the root's blocks in order.
 *  - A print also hands the tops it held before it paged the layout (HeldTops); the blocks' own offsetTop then are the
 *    paged ones, `pagedBy` px lower from the paged block on.
 *
 * What lies inside a block is the caller's: the elements and their client rects (screen px, the root's top-left at 0, 0).
 * The root's classes are chosen so no sizer or print anchor is read (the layer's top is the root's), and every geometry is
 * the caller's (AttachTable.test.ts lays the table block from the Rogue record). Recorded here: a print's blocks are
 * classless divs, Reading view's and an embed's are el-* divs.
 *
 * Reads through the view's own document are counted (`FDoc.reads`): a tree walk (createTreeWalker, querySelectorAll)
 * as a walk, a rect as a rect.
 */
import { vi } from "vitest";
import { FDoc, FEl, FNode, FText, SEPARATOR_ROW, type Box } from "./tableWidgetDom.testutil";
import { recordLines, type HeldTops } from "./EmbedInkMeasure";
import type { CachedSection } from "./EmbedInkLines";

export type ViewKind = "reading" | "embed" | "print";
export const VIEWS: readonly ViewKind[] = ["reading", "embed", "print"];

/** One section as the view lays it out: its source lines (0-based, inclusive), its type, its element, its box in the root. */
export interface ViewSection {
	lineStart: number;
	lineEnd: number;
	type: string;
	/** The section's own element (a p, a table), its rects already set. */
	el: FEl;
	top: number;
	height: number;
}

const ELEMENT = 1, TEXT = 3;

/** Node and NodeFilter as the DOM gives them, for code that reads them as globals; set once, only when absent. */
function domGlobals(): void {
	if (typeof Node === "undefined") vi.stubGlobal("Node", { ELEMENT_NODE: ELEMENT, TEXT_NODE: TEXT });
	if (typeof NodeFilter === "undefined") vi.stubGlobal("NodeFilter", { SHOW_ELEMENT: 1, SHOW_TEXT: 4, SHOW_ALL: 0xffffffff, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 });
}

/** A tree walker over the fake DOM, in document order: whatToShow and a filter's accept, reject (the subtree) or skip. */
function treeWalker(doc: FDoc, root: FNode, what: number, filter?: { acceptNode(n: FNode): number } | ((n: FNode) => number) | null) {
	doc.counted("walk");
	const order: FNode[] = [];
	const shows = (n: FNode) => (n.nodeType === ELEMENT ? (what & 1) !== 0 : n.nodeType === TEXT ? (what & 4) !== 0 : false);
	const verdict = (n: FNode) => (!filter ? 1 : typeof filter === "function" ? filter(n) : filter.acceptNode(n));
	const walk = (n: FNode) => {
		for (const c of n.childNodes) {
			if (!shows(c)) { walk(c); continue; }
			const v = verdict(c);
			if (v === 2) continue;
			if (v === 1) order.push(c);
			walk(c);
		}
	};
	walk(root);
	let at = -1;
	return {
		root,
		get currentNode() { return order[at] ?? root; },
		nextNode: () => order[++at] ?? null,
	};
}

/** Every rect and character box under `n`, `dy` px lower. */
function shiftTree(n: FNode, dy: number): void {
	const s = (b: Box): Box => ({ ...b, top: b.top + dy, bottom: b.bottom + dy, y: b.y + dy });
	if (n instanceof FEl) n.rect = s(n.rect);
	if (n instanceof FText) n.chars = n.chars.map(s);
	n.childNodes.forEach((c) => shiftTree(c, dy));
}

/** `el` laid out in `root`: offsetParent, offsetTop and offsetHeight, and the element-child links the view code reads. */
function laidOut(el: FEl, root: FEl, top: number, height: number): void {
	Object.defineProperties(el, {
		offsetParent: { value: root, configurable: true },
		offsetTop: { value: top, configurable: true, writable: true },
		offsetLeft: { value: 0, configurable: true },
		offsetHeight: { value: height, configurable: true },
		clientTop: { value: 0, configurable: true },
	});
}

/** Element-child links on every element under `n` (firstElementChild, nextElementSibling), as the DOM gives them. */
function elementLinks(n: FNode): void {
	if (n instanceof FEl && !Object.getOwnPropertyDescriptor(n, "firstElementChild")) {
		Object.defineProperties(n, {
			firstElementChild: { get: () => n.children[0] ?? null, configurable: true },
			nextElementSibling: {
				get: () => {
					const s = n.parentNode?.children ?? [];
					return s[s.indexOf(n) + 1] ?? null;
				},
				configurable: true,
			},
		});
	}
	n.childNodes.forEach(elementLinks);
}

/**
 * The view `kind` of a note whose text is `lines`, drawing `sections` in order. `pagedBy`: a print's paging, the px each
 * block from `pagedFrom` (a section index) on is laid lower than the top held for it before paging.
 */
export function readOnlyView(
	doc: FDoc,
	kind: ViewKind,
	lines: readonly string[],
	sections: readonly ViewSection[],
	opts: { pagedBy?: number; pagedFrom?: number } = {}
): { root: HTMLElement; held: HeldTops | undefined; blocks: FEl[]; doc: FDoc } {
	domGlobals();
	if (!(doc as unknown as { createTreeWalker?: unknown }).createTreeWalker) {
		Object.assign(doc, { createTreeWalker: (r: FNode, what: number, filter?: never) => treeWalker(doc, r, what, filter) });
	}
	const root = new FEl("div", `rig-read-only rig-${kind}`, doc);
	const width = 1400, height = sections.reduce((h, s) => Math.max(h, s.top + s.height), 0);
	root.rect = { left: 0, top: 0, right: width, bottom: height, width, height, x: 0, y: 0 };
	Object.defineProperties(root, { offsetParent: { value: null }, offsetHeight: { value: height }, clientTop: { value: 0 } });
	const text = lines.join("\n");
	const pagedBy = kind === "print" ? opts.pagedBy ?? 0 : 0, pagedFrom = opts.pagedFrom ?? 0;
	const blocks: FEl[] = [];
	sections.forEach((s, k) => {
		// The print wraps each top-level element in a classless div (as recorded: the PDF table's block is its parent, class "");
		// Reading view and an embed draw an el-* block.
		const block = new FEl("div", kind === "print" ? "" : s.type === "table" ? "el-table" : s.type === "heading" ? "el-h1" : "el-p", doc);
		block.append(s.el);
		// A paged block's every rect is laid lower with it.
		if (k >= pagedFrom && pagedBy !== 0) shiftTree(s.el, pagedBy);
		const top = s.top + (k >= pagedFrom ? pagedBy : 0);
		block.rect = { left: 0, top, right: width, bottom: top + s.height, width, height: s.height, x: 0, y: top };
		laidOut(block, root, top, s.height);
		root.append(block);
		blocks.push(block);
	});
	elementLinks(root);
	const cachedSections: CachedSection[] = sections.map((s) => ({ type: s.type, lineStart: s.lineStart, lineEnd: s.lineEnd }));
	if (kind === "reading") {
		sections.forEach((s, k) => recordLines(root as unknown as HTMLElement, blocks[k] as unknown as HTMLElement, {
			section: () => ({ text, lineStart: s.lineStart, lineEnd: s.lineEnd }),
			cached: () => null,
		}));
	} else {
		recordLines(root as unknown as HTMLElement, root as unknown as HTMLElement, {
			section: () => null,
			cached: () => ({ sections: cachedSections, text }),
		});
	}
	const held: HeldTops | undefined = kind === "print"
		? { blocks: blocks as unknown as HTMLElement[], tops: sections.map((s) => s.top) }
		: undefined;
	return { root: root as unknown as HTMLElement, held, blocks, doc };
}

/**
 * The note's sections from its text, as the metadata cache gives them for these rigs: runs of lines; a run of quoted
 * lines (">") a callout; a run holding a "|" a table when its second line is the separator row, else a paragraph (a pipe
 * run with no separator is drawn as text).
 */
export function sectionsOf(lines: readonly string[]): { lineStart: number; lineEnd: number; type: string }[] {
	const out: { lineStart: number; lineEnd: number; type: string }[] = [];
	const quoted = (l: string) => /^\s*>/.test(l);
	for (let i = 0; i < lines.length; i++) {
		if (lines[i]!.trim() === "") continue;
		let j = i;
		if (quoted(lines[i]!)) {
			while (j + 1 < lines.length && quoted(lines[j + 1]!)) j++;
			out.push({ lineStart: i, lineEnd: j, type: "callout" });
			i = j;
			continue;
		}
		const pipes = lines[i]!.includes("|");
		while (j + 1 < lines.length && lines[j + 1]!.trim() !== "" && !quoted(lines[j + 1]!) && lines[j + 1]!.includes("|") === pipes) j++;
		out.push({ lineStart: i, lineEnd: j, type: pipes && j > i && SEPARATOR_ROW.test(lines[i + 1]!) ? "table" : "paragraph" });
		i = j;
	}
	return out;
}

/** A paragraph's p holding one line of text, each character `cw` px wide and `fh` high, its box at (x0, top). */
export function paragraphEl(doc: FDoc, text: string, x0: number, top: number, lh: number, cw: number, fh: number): FEl {
	const p = new FEl("p", "", doc), t = new FText(text, doc), ty = top + (lh - fh) / 2;
	p.rect = { left: x0, top, right: x0 + text.length * cw, bottom: top + lh, width: text.length * cw, height: lh, x: x0, y: top };
	t.chars = [...text].map((_, i) => ({ left: x0 + i * cw, right: x0 + (i + 1) * cw, top: ty, bottom: ty + fh, width: cw, height: fh, x: x0 + i * cw, y: ty }));
	return p.append(t);
}
