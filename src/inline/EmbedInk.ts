/**
 * Ink in rendered markdown (roadmap: ink showing in embeds).
 *
 * The overlay only ever painted the live editor. Everywhere else a note's
 * markdown is RENDERED - an ![[embed]] of it, or its own reading view - the
 * page showed text and no ink. This paints the committed strokes there,
 * read-only, using the committed renderer.
 *
 * Anchoring is the fixed-grid doctrine applied honestly: strokes live at
 * note-space coordinates, so they draw at those coordinates from the
 * rendered content's top-left. A rendered page wraps its text differently
 * than the editor did (narrower embed, different padding), and the ink does
 * not chase the text - it never does.
 *
 * One display correction is made on top: a stroke that carries a line anchor
 * is drawn at its page position plus how far its line sits lower here than it
 * did in the editor, read from the rendered blocks and their source lines
 * (EmbedInkLines.ts, `placeStrokes`). Nothing stored moves; this view draws
 * the same ink on the same words the editor does.
 *
 * An `![[embed]]`'s content box sizes itself to its TEXT, not to the ink
 * drawn on top of it, and clips whatever falls outside with `overflow: auto`
 * - measured at 24px tall against 368px of ink, and total for a note holding
 * only ink. So `.markdown-embed-content` roots get their `min-height` grown
 * to the ink's own extent; reading view is deliberately left alone (see
 * `teardownEmbedInk`).
 *
 * Mechanics: markdown post-processors run once per SECTION, and each section
 * registers a MarkdownRenderChild to defer past processing. On load it walks
 * up to the rendered document's root and attaches ONE ink layer there, keyed
 * by a data attribute so the other sections' children see it and stand down.
 *
 * That walk used to assume onload runs after the section is attached to the
 * document, because that used to be when Obsidian called ctx.addChild. The
 * virtualised preview renderer changed it: it calls addChild on a component
 * that is ALREADY loaded, so onload now fires synchronously during
 * post-processing, before the section is inserted into the sizer. Climbing
 * from a detached section finds nothing. The post-processor context also
 * carries a containerEl - undocumented, but present in both the old and new
 * renderers - naming the renderer's own element (the sizer, or the
 * `.markdown-preview-view` div) whether or not the section has landed yet,
 * so the walk tries the section first and falls back to that container.
 *
 * A build that hands us NEITHER - no container and a section that has not
 * landed - is the third route, and it is the one we cannot reproduce on this
 * machine: an eight-case matrix against Obsidian 1.13.7 desktop passes on
 * routes one and two without ever reaching it. It is also where a report of
 * "I embed a note and see no ink" most plausibly lands, so
 * `attachEmbedInkOnceReady` covers it twice over - a MutationObserver on the
 * document body, and a poll bounded by ten seconds of WALL CLOCK rather than
 * by frames, since a backgrounded or slow renderer is exactly the case where
 * a frame count buys almost no time at all. Both are cancelled by the render
 * child's unload AND by `teardownEmbedInk`.
 *
 * A found root is not yet a visible one: a box measuring 0x0 when we paint
 * (a collapsed embed, a folded callout, a pane the theme lays out a tick
 * later) holds a perfectly correct canvas that nobody can see. Such a root is
 * watched with a ResizeObserver and repainted the moment it has a size - see
 * `watchIfCollapsed`.
 *
 * Staleness (1.0.5): ink saves touch the sidecar and never the .md, so a
 * rendered embed used to keep its picture until Obsidian happened to
 * re-render it. Now every attached root sits in a registry, and one
 * ink-changed notification per persisted gesture repaints the roots showing
 * that path. The marker attribute carries a per-path revision, so attach
 * stays idempotent when nothing changed and repaints when the revision
 * moved. Disconnected roots are swept on every notification; the registry
 * holds at most a screenful of embeds between gestures.
 */

import { Platform } from "obsidian";
import { CameraState } from "../camera/coordinates";
import { drawStroke } from "../ink/StrokeRenderer";
import { InkStroke, settleLineAnchors } from "../ink/Stroke";
import { fontZoomFactor } from "./ZoomScale";
import { surfaceExtents } from "./SurfaceExtent";
import { shownStrokes } from "./EmbedInkLines";
import type { LineSignature } from "./LineAnchor";
import { growPrintContainer, isPrintContainer, printing, printSpans, printVectorFor, releasePrintStrips } from "./EmbedInkPrint";
import { embedInkAnchor, embedInkRootHidden, embedInkRootIsEmbed, type EmbedInkVia } from "./EmbedInkRoot";
import { type HeldTops, lineMemos, lineSources, measureSpans } from "./EmbedInkMeasure";
import { embedInkTile, embedInkTileHolds, embedInkUsesTile, type InkRect, type InkTile, TILE_PX, TILE_PX_MOBILE } from "./EmbedInkTile";
import { cancelPendingWaits, pendingWaitPaths, stopAllAnchorWatches, stopAllSizeWatches, stopAnchorWatch, stopSizeWatch, sweepSizeWatches, watchAnchor, watchIfCollapsed } from "./EmbedInkWatch";

export {
	disarmPrintSwaps,
	embedInkPrintSwaps,
	printColumnWidth,
} from "./EmbedInkPrint";
export {
	EMBED_INK_WAIT_MS,
	embedInkAnchor,
	embedInkDiagLine,
	embedInkInPopover,
	embedInkIsCollapsed,
	embedInkIsLiveEditorBlock,
	embedInkIsSectionEmbed,
	embedInkKeepWaiting,
	embedInkResolveRoot,
	embedInkRetryDelay,
	embedInkRoot,
	embedInkRootFor,
	embedInkRootIsEmbed,
} from "./EmbedInkRoot";
export type {
	EmbedInkVia,
} from "./EmbedInkRoot";
export type {
	EmbedInkLineSource,
	HeldTops,
} from "./EmbedInkMeasure";
export {
	attachEmbedInk,
	attachEmbedInkOnceReady,
	embedInkAnchorWatchCount,
	embedInkPendingWaitCount,
	embedInkSizeWatchCount,
} from "./EmbedInkWatch";

/**
 * Total device pixels one rendered layer may hold.
 *
 * This replaced a 2048px cap on each SIDE, which was the wrong shape for the
 * thing it was protecting against. A per-side cap does not bound cost - two
 * capped sides still buy 4.2M pixels - and it CLIPS: a note with ink below
 * 2048px lost it, in reading view and in anything printed from it. Ink
 * silently missing from a page is a worse failure than a heavy canvas.
 *
 * An area budget bounds the real cost (this is 16MB of RGBA) while letting a
 * tall narrow page be tall. When ink genuinely exceeds it, the layer degrades
 * in RESOLUTION rather than dropping strokes - every stroke still renders,
 * slightly softer. Hover previews and multi-embed notes each pay for their
 * own canvas, so this is a battery bound as much as a memory one.
 *
 * The area budget alone is not enough: a tall enough page (about 10,000
 * lines, audit 189) can stay under it while ONE side still exceeds the
 * browser's own per-side canvas limit (Chromium/Firefox: 65,535 px), because
 * the other side is narrow. That side gets no buffer, so the canvas silently
 * fails to size and the layer's ink vanishes - reading view, embeds and
 * hover previews only; Live Preview and print use a different path. A side
 * cap on top of the area one keeps every layer legal regardless of shape.
 */
const MAX_LAYER_PX = 4_000_000;
/** Chromium refuses a canvas side of 65,536 and accepts 65,535 (measured on
 *  Chromium 151). WebKit 26.5 held 65,536 in the same probe, so this margin
 *  under the Chromium limit serves the iPad as well. */
const MAX_LAYER_SIDE_PX = 65_000;
export const MARKER_ATTR = "data-handwriting-embed-ink";
/**
 * Records the `min-height` value WE last wrote on an embed root, so it can be
 * told apart from one the theme or Obsidian set. Same discipline as the
 * `position: relative` revert below, just with a value instead of a fixed
 * sentinel: `position` only ever becomes "relative" under us, but the
 * min-height we set moves with the ink's own height, so remembering "relative"
 * would not be enough to recognise it later.
 */
export const MIN_HEIGHT_ATTR = "data-handwriting-embed-min-height";
/**
 * Marks a root whose `position: relative` WE wrote. An inline `relative` alone
 * cannot say whose it is: a host that positions its own box inline looks the
 * same, and teardown removing that moved somebody else's layout.
 */
const POSITION_ATTR = "data-handwriting-embed-position";
/**
 * The room held left of a root's content for ink drawn left of its origin:
 * the property, the inline value it had before, the value written and the px
 * of room it buys, so it is given back only while it is still ours. On a
 * reading view's sizer it is the margin, on every other root the padding.
 */
const RESERVE_ATTR = "data-handwriting-embed-left-reserve";
/**
 * A reading view's scroll room left of its column, px: the sizer is shifted
 * right by it with `translate`, which moves no layout, and the view is
 * scrolled right by the same amount, so the column stays where it was on
 * screen and the room is reached by scrolling left.
 */
const SCROLL_RESERVE_ATTR = "data-handwriting-embed-scroll-reserve";
/** The spacer that gives a reading view the scroll range its reserve needs. */
const SCROLL_RESERVE_CLS = "handwriting-embed-scroll-reserve";
/**
 * The spacer that gives a canvas note's Reading view the editor's scroll range: one hidden 1 px box at the extent the
 * editor granted the note (`readingExtent`).
 */
const READING_EXTENT_CLS = "handwriting-reading-extent";
/** Lets a reading view scroll sideways while it holds a reserve. */
const SCROLL_AXIS_CLS = "handwriting-embed-hscroll";
export const SVG_NS = "http://www.w3.org/2000/svg";


const CAM: CameraState = { x: 0, y: 0, zoom: 1 };

/** Live rendered roots, each mapped to the note path it shows. */
export const layers = new Map<HTMLElement, string>();
/** Bumped per path on every persisted change; part of the marker. */
const revisions = new Map<string, number>();
export let strokesFor: ((path: string) => readonly InkStroke[]) | null = null;
/** The note surface's text column width for a path, px; null when no editor shows it (see `fitPrintColumn`). */
export let columnWidthFor: ((path: string) => number | null) | null = null;
/** Whether a note is an Infinite Canvas note, as the editor resolves it (per-note choice, else the setting); null when unwired. */
let canvasNoteOf: ((path: string) => boolean) | null = null;
/** The editor font size a note's ink was drawn against, px (its reference); null when none is known. */
let fontRefFor: ((path: string) => number | null) | null = null;
/** The signature of an editor open on a path, which its anchors are honoured under (`shownStrokes`); null when none is. */
let lineSignatureFor: ((path: string) => LineSignature | null) | null = null;
/** The zoom each root's canvas was last painted at: its text size over the note's reference font (`inkZoomOf`). */
const paintedZooms = new WeakMap<HTMLElement, number>();
/**
 * Where the one diagnostic line goes, when the setting is on.
 *
 * The pieces, not the string: the caller owns the `devDiagnostics` check and
 * so the line is only ever FORMATTED when someone is going to read it, which
 * matters when a scrolling reading view resolves a root per section.
 */
export let diagnose: ((via: EmbedInkVia, path: string, waitedMs: number) => void) | null = null;
/**
 * Where each painted root's layer starts, note px: negative where ink reaches
 * left of or above the origin. Read back when a resize re-anchors the layer.
 */
export const layerOrigins = new WeakMap<HTMLElement, { x: number; y: number }>();


/** Children measured per call, at most; one more rect read for the base. */
const COLUMN_SAMPLE = 8;

/** Children that are never the text column: the header, the pusher, the footer, our own layers. */
const NOT_COLUMN = [
	"mod-header",
	"markdown-preview-pusher",
	"mod-footer",
	"handwriting-embed-ink",
	SCROLL_RESERVE_CLS,
];

export function isNotColumn(child: Element): boolean {
	for (const cls of NOT_COLUMN) if (child.classList.contains(cls)) return true;
	return false;
}

/** The column inset last measured on each root (see `columnInset`). */
const lastColumnInset = new WeakMap<HTMLElement, number>();

/**
 * How far the text column's left edge sits inside `base`, px, or null when it
 * has never been measured on this root.
 *
 * A theme can centre the blocks inside a full-width sizer (Minimal with
 * readable line length on: 38.6 px), and an embed's text sits
 * inside its content box (24 px in every theme), so the box's own left is not
 * the column's. The column is the LARGEST left among the first
 * `COLUMN_SAMPLE` blocks of `scope`: a table or an image the theme widens
 * past the text sits further left and is passed over. Both rects are border
 * boxes on screen, so the scroll reserve's translate, which moves the sizer
 * and its blocks together, cancels out, and the stock shape (the sizer is the
 * column) reads 0, not the sizer's offset twice.
 *
 * Cost: measured on the first call for a root and on every
 * anchor-watch tick (`remeasure`), at most `COLUMN_SAMPLE + 1` rect reads;
 * every other paint takes the memory and reads nothing. A re-rendered embed
 * is a new root and measures once. Nothing measurable keeps the memory.
 */
export function columnInset(root: HTMLElement, scope: HTMLElement | null, base: HTMLElement, remeasure: boolean): number | null {
	const held = lastColumnInset.get(root);
	if (held !== undefined && !remeasure) return held;
	// A null scope is an embed's: its blocks sit in the first sizer under it,
	// or are its own children. That lookup walks the embed, so it is made
	// here, after the memory, and a paint with a memory makes none.
	const box = scope ?? root.querySelector<HTMLElement>(".markdown-preview-sizer") ?? root;
	const children = box.children as ArrayLike<Element> | undefined;
	if (!children || typeof base.getBoundingClientRect !== "function") return held ?? null;
	let best = -Infinity;
	let taken = 0;
	for (let i = 0; i < children.length && taken < COLUMN_SAMPLE; i++) {
		const child = children[i];
		if (!child || typeof child.getBoundingClientRect !== "function") continue;
		if (isNotColumn(child)) continue;
		taken++;
		const rect = child.getBoundingClientRect();
		if (rect.width <= 0) continue;
		if (rect.left > best) best = rect.left;
	}
	if (best === -Infinity) return held ?? null;
	const baseRect = base.getBoundingClientRect();
	const baseLeft = baseRect.left + (base === root ? root.clientLeft || 0 : 0);
	// Both rects are in viewport px. A base under a CSS zoom (a print container shrunk to the paper) reads them shrunk by it,
	// and the layer's `left` is set in the base's own px, so the inset is divided by the zoom the base's rect shows.
	const zoom = base.offsetWidth > 0 && baseRect.width > 0 ? baseRect.width / base.offsetWidth : 1;
	const inset = (best - baseLeft) / zoom;
	lastColumnInset.set(root, inset);
	return inset;
}

/**
 * Print / PDF export (audit 18, print half). Obsidian's print container is a
 * `.markdown-preview-view` with NO sizer: the file-name `h1` first when the
 * export includes it, then each of the note's top-level blocks in a div of its
 * own, straight in the container. Editor x 0 is the text column's left and
 * y 0 the first text line's top, so the layer is anchored on the first
 * content block, not on the container's padding edge: its top is that
 * block's `offsetTop` (the container's padding, the title and the block's own
 * top margin all included) and its left is the column's (`columnInset`, which
 * also takes in a theme that centres the blocks; the block's own
 * `offsetLeft`, or the title's with no block, when no column can be read). At Obsidian's default margins the padding edge
 * put the ink 32 px left of its words, and 48 px above them with no title.
 *
 * With no content block the title's bottom is the top. Null for every root
 * that is not such a container (an embed, a view with a sizer), for one with
 * neither a block nor a title, and for one that is not laid out (no offset
 * parent: a `display: none` subtree, where every offset reads 0).
 */
export function printAnchor(root: HTMLElement, remeasure: boolean): { left: number; top: number } | null {
	if (!root.classList?.contains("markdown-preview-view")) return null;
	const title = root.querySelector<HTMLElement>(":scope > h1");
	const first = printFirstBlock(root, title);
	const at = first ?? title;
	if (!at || !at.offsetParent) return null;
	const top = first ? first.offsetTop : at.offsetTop + at.offsetHeight;
	const left = columnInset(root, root, root, remeasure) ?? at.offsetLeft;
	return { left, top };
}

/**
 * The print container's first block of the note itself: the first child that
 * is not the file-name title, not one of our layers or spacers, and laid out.
 */
function printFirstBlock(root: HTMLElement, title: HTMLElement | null): HTMLElement | null {
	const children = root.children as ArrayLike<Element> | undefined;
	if (!children) return null;
	for (let i = 0; i < children.length; i++) {
		const child = children[i] as HTMLElement | undefined;
		if (!child || child === title || isNotColumn(child)) continue;
		if (!child.offsetParent) continue;
		return child;
	}
	return null;
}

/** The sizer a reading view's layer is anchored to, if this root is one. */
export function anchorSizer(root: HTMLElement): HTMLElement | null {
	if (!root.classList?.contains("markdown-preview-view")) return null;
	return root.querySelector<HTMLElement>(":scope > .markdown-preview-sizer");
}

/**
 * The sizer's own `.mod-header` height (inline title + Properties), or 0
 * when it has none - a note with the inline title off and Properties hidden
 * or absent. `offsetHeight` is self-contained: it does not depend on which
 * element is the header's own offset parent, unlike `offsetTop`.
 */
export function sizerHeaderHeight(sizer: HTMLElement): number {
	const header = sizer.querySelector<HTMLElement>(":scope > .mod-header");
	if (header) {
		const h = header.offsetHeight;
		lastHeaderHeight.set(sizer, h);
		return h;
	}
	// The renderer DETACHES the header section once the reader scrolls past
	// its render window and gives the pusher a margin of the same height, so
	// the text does not move. The anchor must not move either: use the last
	// height measured while the header was attached.
	return lastHeaderHeight.get(sizer) ?? 0;
}

/** The header height last measured on each sizer (see `sizerHeaderHeight`). */
const lastHeaderHeight = new WeakMap<HTMLElement, number>();

export function anchorLayer(root: HTMLElement, el: { style: CSSStyleDeclaration }, remeasure = false): void {
	const origin = layerOrigins.get(root) ?? { x: 0, y: 0 };
	const sizer = embedInkAnchor(root, remeasure);
	// `offsetLeft` does not include the sizer's `translate`, so the scroll reserve is added back here.
	const at = sizer
		? anchorSizer(root)
			? { left: sizer.left + scrollReserveHeld(root), top: sizer.top }
			: { left: sizer.left + reserveHeld(root), top: sizer.top } // an embed's column; print: the first block's column and top
		: { left: reserveHeld(root), top: 0 };
	// A Reading view tile sits at its own place inside the ink box; the box's place and the view's size are kept for
	// the scroll listener, which reads no layout of its own.
	const watch = tiles.get(root);
	const tiled = watch && watch.canvas === el ? watch : null;
	if (tiled) {
		tiled.at = { left: at.left + origin.x, top: at.top + origin.y };
		tiled.client = { w: root.clientWidth, h: root.clientHeight };
	}
	if (anchorSizer(root) && !isPrintContainer(root)) readingExtent(root, at);
	// Through `style`: the offsets are computed on every anchor, not fixed values.
	el.style.left = `${at.left + origin.x + (tiled?.tile?.x ?? 0)}px`;
	el.style.top = `${at.top + origin.y + (tiled?.tile?.y ?? 0)}px`;
	// A resize can leave part of the view off the tile.
	if (tiled) askTile(root, tiled);
}

/**
 * A canvas note's Reading view scrolls as far as its editor does. The editor's range is the extent it granted the note
 * (SurfaceExtent.ts `surfaceExtents`: the ink, room to write below the text, and the room scrolling out on the canvas
 * grew), and Reading view's was the ink's own box: scrolled far right and down, the editor reached further, and on the
 * switch the far ink sat lower on screen. Here the view holds one hidden 1 px spacer at the note's world origin (`at`)
 * plus that extent at the view's ink zoom, so the range ends where the editor's does. Room below and right only: the
 * extent is never negative, and the scroll floors stay 0. The extent is only read here, never grown or shrunk: only
 * the editor knows what it shows. No grant (no editor has laid the note out this session), a note that is not a
 * canvas note, or an unwired flag: no spacer, the range is the ink's as before.
 */
function readingExtent(root: HTMLElement, at: { left: number; top: number }): void {
	const path = layers.get(root);
	const spacer = root.querySelector<HTMLElement>(`:scope > .${READING_EXTENT_CLS}`);
	const extent = path !== undefined && canvasNoteOf?.(path) === true ? surfaceExtents.get(path) : null;
	if (!extent || (extent.x <= 0 && extent.y <= 0)) {
		spacer?.remove();
		return;
	}
	const zoom = paintedZooms.get(root) ?? inkZoomOf(root, path!);
	const el = spacer ?? root.createDiv({ cls: READING_EXTENT_CLS });
	el.setAttribute("aria-hidden", "true");
	el.setCssStyles({
		position: "absolute",
		width: "1px",
		height: "1px",
		visibility: "hidden",
		pointerEvents: "none",
		left: `${Math.round(at.left + Math.max(0, extent.x) * zoom)}px`,
		top: `${Math.round(at.top + Math.max(0, extent.y) * zoom)}px`,
	});
}

/** A Reading view root drawing a tile (EmbedInkTile.ts): what it draws, where its box is, and its scroll listener. */
interface TileWatch {
	canvas: HTMLCanvasElement;
	drawn: readonly InkStroke[];
	zoom: number;
	/** The ink box, note px, as `embedInkBounds` gives it. */
	box: { x: number; y: number; w: number; h: number };
	dpr: number;
	tile: InkTile | null;
	/** The box's top-left in the view's scrolled content, css px, and the view's client size: from the last anchor. */
	at: { left: number; top: number };
	client: { w: number; h: number };
	frame: number;
	/** Set while a paint measures the box: an anchor then asks for no frame. */
	quiet: boolean;
	onScroll: () => void;
}
const tiles = new WeakMap<HTMLElement, TileWatch>();
/** What a tile writes on the canvas beyond the whole box's width and height; taken off when the root draws whole again. */
const TILE_PROPS = ["box-sizing", "border-style", "border-color", "border-width"];

/** The view's rect in the ink box's css px. */
function tileView(root: HTMLElement, w: TileWatch): InkRect {
	return { x: root.scrollLeft - w.at.left, y: root.scrollTop - w.at.top, w: w.client.w, h: w.client.h };
}

/** Repaint the tile in the next frame when the view has left it; one frame however many scrolls ask. */
function askTile(root: HTMLElement, w: TileWatch): void {
	if (w.quiet || w.frame !== 0 || embedInkTileHolds(w.tile, { w: w.box.w, h: w.box.h }, tileView(root, w))) return;
	const win = root.ownerDocument.defaultView ?? window;
	w.frame = win.requestAnimationFrame(() => {
		w.frame = 0;
		if (tiles.get(root) !== w || !root.isConnected || !w.canvas.isConnected) return;
		drawTile(root, w);
	});
}

/** Stop drawing a tile on `root`: the listener and any frame go, and the canvas loses the tile's own styles. */
function untile(root: HTMLElement): void {
	const w = tiles.get(root);
	if (!w) return;
	tiles.delete(root);
	root.removeEventListener("scroll", w.onScroll);
	if (w.frame !== 0) (root.ownerDocument.defaultView ?? window).cancelAnimationFrame(w.frame);
	for (const prop of TILE_PROPS) w.canvas.style.removeProperty(prop);
}

/**
 * Draw the part of the ink box the view shows, plus a quarter view each side, at the display's ratio. The canvas's
 * content box is the tile; transparent borders to the right and below carry its border box to the ink box's far
 * edges, so the view's scroll range stays what the whole box gave it. The old tile stays on screen until this one is
 * drawn, in the same task.
 */
function drawTile(root: HTMLElement, w: TileWatch): void {
	const { canvas, box, zoom, dpr } = w;
	const budget = Platform.isMobile ? TILE_PX_MOBILE : TILE_PX;
	const tile = embedInkTile({ w: box.w, h: box.h }, tileView(root, w), (tw, th) => embedInkScale(tw, th, dpr, budget));
	w.tile = tile;
	const bw = tile?.bw ?? 1, bh = tile?.bh ?? 1;
	if (canvas.width !== bw || canvas.height !== bh) {
		canvas.width = bw;
		canvas.height = bh;
	}
	const tw = tile?.w ?? 0, th = tile?.h ?? 0;
	const right = Math.max(0, box.w - (tile?.x ?? 0) - tw), bottom = Math.max(0, box.h - (tile?.y ?? 0) - th);
	canvas.setCssStyles({ boxSizing: "content-box", borderStyle: "solid", borderColor: "transparent" });
	canvas.style.setProperty("border-width", `0px ${right}px ${bottom}px 0px`);
	canvas.setCssStyles({ width: `${tw}px`, height: `${th}px` });
	anchorLayer(root, canvas);
	const ctx = canvas.getContext("2d");
	if (!ctx) return;
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.clearRect(0, 0, bw, bh);
	if (!tile) return;
	const s = tile.scale;
	// The whole box's transform, moved by the tile's whole device px: a stroke lands on the same device px in any tile.
	ctx.setTransform(s, 0, 0, s, -box.x * s - tile.bx, -box.y * s - tile.by);
	// The tile in note px, and only the strokes that meet it. A stroke's box is padded by whoever built it, so the test
	// allows its full width and a px of antialiasing past the box: a stroke just off the tile still paints its edge.
	const x0 = box.x + tile.x, y0 = box.y + tile.y, x1 = x0 + tile.w, y1 = y0 + tile.h;
	const meets = (st: InkStroke): boolean => {
		const b = st.bbox, m = st.width * zoom + 1;
		return b.x * zoom - m <= x1 && b.y * zoom - m <= y1 && (b.x + b.width) * zoom + m >= x0 && (b.y + b.height) * zoom + m >= y0;
	};
	const cam = zoom === 1 ? CAM : { x: 0, y: 0, zoom };
	ctx.globalAlpha = 0.35;
	for (const st of w.drawn) if (st.tool === "highlighter" && meets(st)) drawStroke(ctx, cam, st, undefined, true);
	ctx.globalAlpha = 1;
	for (const st of w.drawn) if (st.tool !== "highlighter" && meets(st)) drawStroke(ctx, cam, st, undefined, true);
}

/** The tile a Reading view root holds, or null when it draws its whole box. */
export function embedInkTileOf(root: HTMLElement): InkTile | null {
	return tiles.get(root)?.tile ?? null;
}

interface HeldReserve { prop: string; was: string; priority: string; ours: string; reserve: number }

function readReserve(el: HTMLElement): HeldReserve | null {
	const held = el.getAttribute(RESERVE_ATTR);
	if (held === null) return null;
	try {
		return JSON.parse(held) as HeldReserve;
	} catch {
		return null;
	}
}

/** The px of room a root's own padding reserve buys; 0 when it holds none. */
function reserveHeld(root: HTMLElement): number {
	const r = readReserve(root)?.reserve;
	return typeof r === "number" && Number.isFinite(r) ? r : 0;
}

/** Give a held reserve back, unless something else has since written that property. */
function releaseReserve(el: HTMLElement): void {
	if (el.getAttribute(RESERVE_ATTR) === null) return;
	const h = readReserve(el);
	el.removeAttribute(RESERVE_ATTR);
	if (!h || el.style.getPropertyValue(h.prop) !== h.ours) return;
	if (h.was) el.style.setProperty(h.prop, h.was, h.priority);
	else el.style.removeProperty(h.prop);
}

/** The scroll reserve a reading view holds, px; 0 when it holds none. */
function scrollReserveHeld(root: HTMLElement): number {
	const r = Number.parseFloat(root.getAttribute(SCROLL_RESERVE_ATTR) ?? "");
	return Number.isFinite(r) && r > 0 ? r : 0;
}

/**
 * Set a reading view's scroll reserve to `reserve` px, or take it off at 0.
 * The sizer's `translate` and the view's `scrollLeft` move by the same
 * amount in the same pass, so nothing on screen moves; the spacer keeps the
 * scroll range wide enough for that scrollLeft to hold.
 */
function setScrollReserve(root: HTMLElement, sizer: HTMLElement | null, reserve: number): void {
	const held = scrollReserveHeld(root);
	const spacer = root.querySelector<HTMLElement>(`:scope > .${SCROLL_RESERVE_CLS}`);
	if (reserve <= 0) {
		if (held <= 0 && !spacer) return;
		root.removeAttribute(SCROLL_RESERVE_ATTR);
		if (sizer && sizer.style.getPropertyValue("translate") === `${held}px`) sizer.style.removeProperty("translate");
		spacer?.remove();
		root.classList.remove(SCROLL_AXIS_CLS);
		if (held > 0) root.scrollLeft = Math.max(0, root.scrollLeft - held);
		return;
	}
	if (!sizer) return;
	const view = root.ownerDocument?.defaultView;
	root.setAttribute(SCROLL_RESERVE_ATTR, `${reserve}`);
	sizer.style.setProperty("translate", `${reserve}px`);
	const el = spacer ?? (root.ownerDocument.win as Window & { createDiv(): HTMLDivElement }).createDiv();
	if (!spacer) {
		el.className = SCROLL_RESERVE_CLS;
		el.setAttribute("aria-hidden", "true");
		root.appendChild(el);
	}
	// The range must reach a full view past the reserve, whatever the sizer's own right edge gives.
	el.style.left = `${Math.ceil(root.clientWidth + reserve) - 1}px`;
	if (view && typeof view.getComputedStyle === "function" && !/^(auto|scroll|overlay)$/.test(view.getComputedStyle(root).overflowX)) {
		root.classList.add(SCROLL_AXIS_CLS);
	}
	if (reserve !== held) root.scrollLeft = Math.max(0, root.scrollLeft + reserve - held);
}

/**
 * Ink left of a root's origin holds no room: the page is bounded by its left
 * edge on screen and on paper, so the ink is drawn where it lies (its layer box
 * starts at the ink's own left) and the text, the scroll range and the printed
 * margin stay where they are without it. This only gives back what an earlier
 * pass held: the padding or margin, and a reading view's scroll room.
 */
export function reserveLeft(root: HTMLElement): void {
	const sizer = anchorSizer(root);
	releaseReserve(sizer ?? root);
	setScrollReserve(root, sizer, 0);
}

/**
 * Pure: the css box that covers every stroke, note px from the origin.
 *
 * It starts at the origin unless ink reaches left of it or above it, and then
 * at that ink: a stroke wholly left of the origin still gets a layer, and a
 * straddling one keeps its left part. Stored coordinates are untouched; only
 * the layer moves.
 */
export function embedInkBounds(strokes: readonly InkStroke[], zoom = 1): { x: number; y: number; w: number; h: number } {
	// `zoom`: px per world unit, for a layer that draws the ink at its text size (`inkZoomOf`).
	let minX = 0, minY = 0, maxX = 0, maxY = 0;
	for (const s of strokes) {
		minX = Math.min(minX, s.bbox.x * zoom);
		minY = Math.min(minY, s.bbox.y * zoom);
		maxX = Math.max(maxX, (s.bbox.x + s.bbox.width) * zoom);
		maxY = Math.max(maxY, (s.bbox.y + s.bbox.height) * zoom);
	}
	const x = Math.floor(minX), y = Math.floor(minY);
	return { x, y, w: Math.ceil(maxX) - x, h: Math.ceil(maxY) - y };
}

/** Pure: the css extent that covers every stroke. Never clipped. */
export function embedInkExtent(strokes: readonly InkStroke[]): { w: number; h: number } {
	let maxX = 0;
	let maxY = 0;
	for (const s of strokes) {
		maxX = Math.max(maxX, s.bbox.x + s.bbox.width);
		maxY = Math.max(maxY, s.bbox.y + s.bbox.height);
	}
	return { w: Math.ceil(maxX), h: Math.ceil(maxY) };
}

/**
 * Pure: device pixels per css pixel for a layer of this size.
 *
 * The display's own ratio, unless that would exceed the budget, in which case
 * as much resolution as the budget affords. Rendered ink used to be drawn at
 * exactly 1x - one device pixel per css pixel - which is soft on every modern
 * screen and softer still in an exported PDF, where it sits beside text that
 * was rasterized at the printer's resolution.
 *
 * Capped again after that so NEITHER backing side can exceed the browser's
 * canvas limit (audit 189): below the 0.25 area floor when the page is tall
 * enough, because a canvas that silently fails to size loses every stroke,
 * and a softer picture that actually exists is always the better failure.
 * `budget`: the device px the layer may hold; a Reading view tile passes its own (EmbedInkTile.ts).
 */
export function embedInkScale(w: number, h: number, dpr: number, budget = MAX_LAYER_PX): number {
	if (w <= 0 || h <= 0) return 1;
	const want = Math.max(1, dpr);
	const area = w * h * want * want;
	const areaScale = area <= budget ? want : Math.max(0.25, Math.sqrt(budget / (w * h)));
	const sideScale = Math.min(MAX_LAYER_SIDE_PX / w, MAX_LAYER_SIDE_PX / h);
	return Math.min(areaScale, sideScale);
}

/** Pure: what the marker attribute holds for a (path, revision) pair. */
export function embedInkMarker(path: string, rev: number): string {
	return `${path}@${rev}`;
}

/**
 * Pure: does this root need painting?
 *
 * The marker alone is not proof the picture is still there. Reading view
 * re-renders its sections as you scroll while KEEPING the sizer element, so
 * Obsidian can drop our canvas and leave the attribute behind - and a
 * marker-only check then decides everything is up to date and paints nothing.
 * That is why a note's own reading view came up blank while an embed of the
 * same note was fine: an embed is rebuilt whole, marker and all (reported
 * twice, iPad and Onyx Boox, 2026-08-27).
 */
export function embedInkNeedsPaint(
	currentMarker: string | null,
	wantedMarker: string,
	hasCanvas: boolean
): boolean {
	return currentMarker !== wantedMarker || !hasCanvas;
}

/** Diagnostics: how many rendered roots the registry currently holds. */
export function embedInkLayerCount(): number {
	return layers.size;
}

/** Where repaints read fresh strokes from. Wired once at plugin load. */
export function initEmbedInkRefresh(provider: (path: string) => readonly InkStroke[]): void {
	strokesFor = provider;
}

/** Where a render reads a note's reference font from (the store's `fontRefPx`). Wired once at plugin load. */
export function initEmbedInkFontRef(provider: ((path: string) => number | null) | null): void {
	fontRefFor = provider;
}

/**
 * The px per world unit `root` draws `path`'s ink at: its text size over the note's reference font, as the editor
 * draws it (fontZoomFactor). Stored coordinates are px at the reference, so ink drawn at 1 beside text of another size
 * came out that much too large or small, and too far from its line. 1 with no reference, or no text size to read.
 * The print layer reads it too, so paper shows the ink at the size the screen does.
 */
export function inkZoomOf(root: HTMLElement, path: string): number {
	const ref = fontRefFor ? fontRefFor(path) : null;
	if (ref === null) return 1;
	// The text's own size: a view's or an embed's sizer, else the root (a print container holds its blocks itself).
	const text = root.querySelector<HTMLElement>(".markdown-preview-sizer") ?? root;
	const font = Number.parseFloat(root.ownerDocument.defaultView?.getComputedStyle(text).fontSize ?? "");
	return fontZoomFactor(font, ref);
}

/**
 * Where a Reading view reads whether a note is an Infinite Canvas note, as the editor resolves it (`readingExtent`).
 * Wired by the note surface beside the strokes provider.
 */
export function initEmbedInkCanvasNote(provider: ((path: string) => boolean) | null): void {
	canvasNoteOf = provider;
}

/**
 * Where a print reads the note's screen column width from: the text column of the editor showing the path, px, or
 * null when none does. Wired by the note surface beside the strokes provider.
 */
export function initEmbedInkColumnWidth(provider: (path: string) => number | null): void {
	columnWidthFor = provider;
}

/**
 * Where a read-only view reads the signature of an editor open on a note (LineAnchor.ts), which anchors are honoured
 * under: null when none is open. Wired by the note surface beside the strokes provider.
 */
export function initEmbedInkLineSignature(provider: ((path: string) => LineSignature | null) | null): void {
	lineSignatureFor = provider;
}

/**
 * Where the diagnostic line goes. Wired once at plugin load; null silences it.
 */
export function initEmbedInkDiagnostics(
	sink: ((via: EmbedInkVia, path: string, waitedMs: number) => void) | null
): void {
	diagnose = sink;
}


/**
 * A note's ink was persisted: bump its revision and repaint every connected
 * root showing it. Every notification also sweeps roots the DOM dropped.
 */
export function embedInkChanged(path: string): void {
	revisions.set(path, (revisions.get(path) ?? 0) + 1);
	sweepDisconnected();
	for (const [root, p] of layers) {
		if (p !== path) continue;
		// A hidden root (the reading view of a tab now in Live Preview) keeps
		// its old marker and is left to the size watch, which repaints it the
		// moment it has a box again. Painting it here redrew the whole note
		// into a canvas nobody could see on every pen-up (audit #23).
		if (embedInkRootHidden(root)) {
			watchIfCollapsed(root, path);
			continue;
		}
		paint(root, path, strokesFor ? strokesFor(path) : []);
		// A print is running on this root (its vector layer is the picture and
		// the canvas is hidden): the vector layer follows the ink too. Asked of
		// the window, not the layer: the layer goes when the last stroke goes,
		// and ink that comes back while the print runs needs one built again.
		const win = root.ownerDocument.defaultView;
		if (root.querySelector(":scope > svg.handwriting-embed-ink") || (win !== null && printing.has(win))) {
			printVectorFor(root, path, true);
		}
	}
}

/**
 * Repaint every connected root from the current settings (audit 25). Pressure
 * sensitivity, Ink smoothing and Boox mode change how saved ink is SHAPED, not
 * what is saved, so no persisted-change notification fires and a layer whose
 * path@revision is unchanged would keep its old bitmap. Bumping each shown
 * note's revision makes every layer draw again.
 */
export function embedInkRepaintAll(): void {
	for (const path of new Set(layers.values())) embedInkChanged(path);
}

/**
 * A note was renamed: its layers and revision follow it (audit 118). Both are
 * keyed by path, so without this a rendered root keeps asking for the old
 * path's ink and stops updating. Call after the ink store has moved its own
 * record, so the repaint reads the strokes under the new path.
 */
export function embedInkRenamed(oldPath: string, newPath: string): void {
	if (oldPath === newPath) return;
	let moved = false;
	for (const [root, p] of layers) {
		if (p !== oldPath) continue;
		layers.set(root, newPath);
		moved = true;
	}
	for (const wait of pendingWaitPaths.values()) if (wait.path === oldPath) wait.path = newPath;
	const rev = revisions.get(oldPath);
	if (rev !== undefined) {
		revisions.set(newPath, Math.max(rev, revisions.get(newPath) ?? 0));
		revisions.delete(oldPath);
	}
	if (moved) embedInkChanged(newPath);
}

/**
 * A tab opened a different note (audit 119). A reading view's layer is
 * re-registered only by the post-processor, which a note with no content never
 * runs, so the tab kept the previous note's ink. Every reading-view root inside
 * `viewEl` is re-keyed to `path` and repainted from that note's own ink, which
 * for an empty note clears the layer. Embed roots inside the view are left
 * alone: they belong to the notes they embed.
 */
export function embedInkFileOpened(viewEl: { contains(node: Node): boolean } | null, path: string): void {
	if (!viewEl) return;
	const stale: HTMLElement[] = [];
	for (const [root, p] of layers) {
		if (p === path || !root.classList.contains("markdown-preview-view")) continue;
		if (viewEl.contains(root)) stale.push(root);
	}
	if (stale.length === 0) return;
	for (const root of stale) layers.set(root, path);
	embedInkChanged(path);
}

/**
 * Drop roots the DOM let go of. Runs on every attach AND every change
 * notification, so growth is bounded by render activity as well as save
 * activity - a session that only READS (hover previews register roots and
 * never draws) must not accumulate detached trees and their canvases.
 */
export function sweepDisconnected(): void {
	for (const root of [...layers.keys()]) {
		if (!root.isConnected) layers.delete(root);
	}
	sweepSizeWatches();
}


/**
 * Take the ink layers back out of the rendered DOM.
 *
 * Everything this module adds lives in someone else's tree - reading views,
 * hover previews, exported panes - and none of it is Obsidian's to clean up.
 * Disabling the plugin therefore left canvases, the marker attribute and the
 * `position: relative` patch behind on every rendered embed, showing ink from
 * a plugin that is no longer running, until each of those sections happened
 * to re-render.
 *
 * The position patch is only reverted where WE set it: a root that was
 * already positioned keeps whatever it had, because that was the theme's or
 * Obsidian's and removing it would move somebody else's layout.
 */
export function teardownEmbedInk(): void {
	// Before the roots themselves: a wait or a resize observer that survives
	// this goes on calling into a module the reload has already replaced,
	// which is a repaint from a plugin that is no longer running at best and
	// a throw inside someone else's observer callback at worst.
	cancelPendingWaits();
	stopAllSizeWatches();
	stopAllAnchorWatches();
	for (const root of [...layers.keys()]) {
		if (!root.isConnected) continue;
		untile(root);
		root.querySelector(":scope > canvas.handwriting-embed-ink")?.remove();
		releasePrintStrips(root);
		printSpans.delete(root);
		root.querySelector(":scope > svg.handwriting-embed-ink")?.remove();
		root.querySelector(`:scope > .${READING_EXTENT_CLS}`)?.remove();
		root.removeAttribute(MARKER_ATTR);
		if (root.getAttribute(POSITION_ATTR) !== null && root.style.position === "relative") root.style.removeProperty("position");
		root.removeAttribute(POSITION_ATTR);
		clearEmbedMinHeight(root);
		const sizer = anchorSizer(root);
		releaseReserve(sizer ?? root);
		setScrollReserve(root, sizer, 0);
		lineSources.delete(root);
		lineMemos.delete(root);
		placements.delete(root);
		paintedZooms.delete(root);
	}
	replaceQueue.clear();
	layers.clear();
	revisions.clear();
	strokesFor = null;
	canvasNoteOf = null;
	columnWidthFor = null;
	fontRefFor = null;
	diagnose = null;
}


/**
 * Remove a min-height we set, if it is still there and still ours.
 *
 * "Still ours" means the inline value matches what we recorded in
 * `MIN_HEIGHT_ATTR` the last time we wrote one. If it does not match, someone
 * else (the theme, a snippet, the user) has since taken over that property,
 * and clearing it would be clobbering layout that is no longer ours to touch
 * - the same rule `teardownEmbedInk` already applies to `position`, just
 * carrying a remembered value instead of a fixed sentinel.
 */
function clearEmbedMinHeight(root: HTMLElement): void {
	const ours = root.getAttribute(MIN_HEIGHT_ATTR);
	if (ours !== null && root.style.minHeight === ours) {
		root.style.removeProperty("min-height");
	}
	root.removeAttribute(MIN_HEIGHT_ATTR);
}

/** The placement each root was last painted with (`placeStrokes`): "" when no stroke is shown moved. */
const placements = new WeakMap<HTMLElement, string>();
/** Roots whose placement is read again once the current task's renders are done (`queueReplace`). */
const replaceQueue = new Set<HTMLElement>();


/**
 * The strokes as `root` shows them, and a key naming that placement: the list itself and "" when no stroke carries an
 * anchor or none is shown moved. `held` is a print's block tops from before it paged the layout. `zoom` is the px per
 * world unit the layer draws at (`inkZoomOf`); the key names it when it is not 1, so a new text size is a new placement.
 * `path` names the note, so an editor open on it lends its signature; without it the newest anchored stroke's is used.
 */
export function placeStrokes(
	root: HTMLElement,
	strokes: readonly InkStroke[],
	held?: HeldTops,
	zoom = 1,
	path?: string
): { strokes: readonly InkStroke[]; key: string } {
	const at = zoom === 1 ? "" : `@${zoom};`;
	if (!strokes.some((s) => s.lineAnchor)) return { strokes, key: at };
	// The editor brings its anchors up to date with typing when they are read or written. Reading them here is such a
	// read: a reading view beside an editor of the same note folds the editor's anchors at each of its renders.
	settleLineAnchors();
	const live = path !== undefined && lineSignatureFor ? lineSignatureFor(path) : null;
	const shown = shownStrokes(strokes, measureSpans(root, held), zoom, live);
	if (shown === strokes) return { strokes, key: at };
	let key = at;
	for (let k = 0; k < strokes.length; k++) {
		const a = strokes[k]!, b = shown[k]!;
		if (a !== b) key += `${k}:${(b.bbox.y - a.bbox.y).toFixed(2)};`;
	}
	return { strokes: shown, key };
}

/**
 * Read `root`'s placement again once the current task is done. A render post-processes its sections in one pass, each
 * section's attach asking for the same root; they come to one read, and to one repaint only when a stroke is shown
 * somewhere else than it was painted.
 */
export function queueReplace(root: HTMLElement): void {
	if (replaceQueue.has(root)) return;
	replaceQueue.add(root);
	queueMicrotask(() => {
		if (!replaceQueue.delete(root)) return;
		replace(root);
	});
}

function replace(root: HTMLElement): void {
	const path = layers.get(root);
	if (path === undefined || !root.isConnected || embedInkRootHidden(root)) return;
	if (!root.querySelector(":scope > canvas.handwriting-embed-ink")) return;
	const strokes = strokesFor ? strokesFor(path) : [];
	const placed = placeStrokes(root, strokes, undefined, inkZoomOf(root, path), path);
	if (placed.key === (placements.get(root) ?? "")) return;
	paint(root, path, strokes, placed);
	const win = root.ownerDocument.defaultView;
	if (root.querySelector(":scope > svg.handwriting-embed-ink") || (win !== null && printing.has(win))) {
		printVectorFor(root, path, true);
	}
}

export function paint(root: HTMLElement, path: string, strokes: readonly InkStroke[], placed: { strokes: readonly InkStroke[]; key: string } | null = null): void {
	// Until now the size watches were swept only from `attachEmbedInk` and
	// `embedInkChanged`, so a collapsed root that left the DOM kept its
	// ResizeObserver until the next embed render or the next persisted
	// gesture ANYWHERE - which in a session that only reads is never. Paint
	// is the cheapest boundary that a watch cannot outlive: see the
	// function's own comment for why this is the size half only.
	sweepSizeWatches();
	const marker = embedInkMarker(path, revisions.get(path) ?? 0);
	let canvas = root.querySelector<HTMLCanvasElement>(
		":scope > canvas.handwriting-embed-ink"
	);
	// The ink at its text's size: read every paint, since text that changes size keeps the marker.
	const zoom = inkZoomOf(root, path);
	if (
		!embedInkNeedsPaint(root.getAttribute(MARKER_ATTR), marker, canvas !== null) &&
		(placed === null || placed.key === (placements.get(root) ?? "")) &&
		zoom === (paintedZooms.get(root) ?? 1)
	) {
		// A detached view may return with its unchanged bitmap. Its old
		// observers were stopped, so restore layout tracking without repainting.
		if (canvas) anchorLayer(root, canvas);
		watchAnchor(root);
		// A section rendered since the last paint can put an anchored stroke
		// somewhere else: its placement is read once this render is done.
		if (placed === null && strokes.some((s) => s.lineAnchor)) queueReplace(root);
		return;
	}
	root.setAttribute(MARKER_ATTR, marker);
	const view = root.ownerDocument.defaultView ?? window;
	const stored = embedInkBounds(strokes);
	if (strokes.length === 0 || stored.w <= 0 || stored.h <= 0) {
		// The last stroke was erased: the picture goes too, and so does any
		// room we grew the embed by to hold it.
		untile(root);
		canvas?.remove();
		if (embedInkRootIsEmbed(root) || isPrintContainer(root)) clearEmbedMinHeight(root);
		layerOrigins.delete(root);
		placements.delete(root);
		paintedZooms.delete(root);
		releaseReserve(anchorSizer(root) ?? root);
		setScrollReserve(root, anchorSizer(root), 0);
		root.querySelector(`:scope > .${READING_EXTENT_CLS}`)?.remove();
		// Nothing left to become visible, so nothing left to watch for.
		stopSizeWatch(root);
		stopAnchorWatch(root);
		return;
	}
	if (view.getComputedStyle(root).position === "static") {
		root.setCssStyles({ position: "relative" });
		root.setAttribute(POSITION_ATTR, "");
	}
	// Placed once the root is positioned (its blocks' tops are read in its
	// frame) and before anything below writes to the layout.
	const shown = placed ?? placeStrokes(root, strokes, undefined, zoom, path);
	placements.set(root, shown.key);
	paintedZooms.set(root, zoom);
	const drawn = shown.strokes;
	// The layer's box in px: the ink's world box at the zoom it is drawn at.
	const { x, y, w, h } = embedInkBounds(drawn, zoom);
	if (embedInkRootIsEmbed(root)) {
		// An embed's content box sizes itself to its TEXT and clips the ink
		// hanging below it (measured: 24px box, 368px of ink). Growing the box
		// to the ink's own height fixes that. Reading view's sizer is left
		// alone on purpose - it is a scroller whose scroll range the
		// absolutely positioned canvas already extends, and it is resized by
		// the virtualised renderer itself; forcing a min-height onto it would
		// fight that renderer rather than fix a clip.
		// Below the origin only: the box starts at it.
		const minHeight = `${h + y}px`;
		root.setCssStyles({ minHeight });
		root.setAttribute(MIN_HEIGHT_ATTR, minHeight);
	}
	if (!canvas) {
		canvas = root.createEl("canvas", { cls: "handwriting-embed-ink" });
	}
	// The canvas is sized in DEVICE pixels and laid out in css pixels, so the
	// strokes below can go on drawing in note units and come out sharp.
	const dpr = view.devicePixelRatio || 1;
	const scale = embedInkScale(w, h, dpr);
	// A note's own Reading view (a view with its sizer: not an export's, not an embed's) whose box would be drawn
	// under the display's ratio draws only what is on screen.
	const tiled = embedInkUsesTile(anchorSizer(root) !== null, scale, dpr);
	const held = tiles.get(root);
	if (!tiled || (held && held.canvas !== canvas)) untile(root);
	// Every paint, not only the ones that resize the backing store: a repaint
	// can follow a resize that moved the sizer without changing the ink.
	layerOrigins.set(root, { x, y });
	reserveLeft(root);
	if (tiled) {
		let watch = tiles.get(root);
		if (!watch) {
			const made: TileWatch = { canvas, drawn, zoom, box: { x, y, w, h }, dpr, tile: null, at: { left: 0, top: 0 },
				client: { w: 0, h: 0 }, frame: 0, quiet: false, onScroll: () => askTile(root, made) };
			watch = made;
			tiles.set(root, made);
			root.addEventListener("scroll", made.onScroll, { passive: true });
		}
		Object.assign(watch, { drawn, zoom, box: { x, y, w, h }, dpr, tile: null });
		// The box's place and the view's size, read once per paint; a scroll moves neither.
		watch.quiet = true;
		anchorLayer(root, canvas);
		watch.quiet = false;
		growPrintContainer(root, canvas, h);
		watchAnchor(root);
		drawTile(root, watch);
		watchIfCollapsed(root, path);
		return;
	}
	anchorLayer(root, canvas);
	growPrintContainer(root, canvas, h);
	watchAnchor(root);
	const backingW = Math.max(1, Math.round(w * scale));
	const backingH = Math.max(1, Math.round(h * scale));
	if (canvas.width !== backingW || canvas.height !== backingH) {
		canvas.width = backingW;
		canvas.height = backingH;
	}
	// Every paint, not only the ones that resize the backing store: over the pixel budget the backing store is
	// scaled to the budget, so ink that grows by the same ratio both ways rounds to the same backing size while
	// its css box must still follow it.
	canvas.setCssStyles({ width: `${w}px`, height: `${h}px` });
	const ctx = canvas.getContext("2d");
	if (!ctx) return;
	// Note px, drawn from the layer's own origin: the ink's leftmost and topmost
	// point where that is past the note's.
	ctx.setTransform(scale, 0, 0, scale, -x * scale, -y * scale);
	ctx.clearRect(x, y, w, h);
	// World units at the text's size, through the camera as the editor draws them: the stroke's shape follows.
	const cam = zoom === 1 ? CAM : { x: 0, y: 0, zoom };
	// Highlighter first and translucent as a layer would be; then pen.
	ctx.globalAlpha = 0.35;
	for (const s of drawn) if (s.tool === "highlighter") drawStroke(ctx, cam, s, undefined, true);
	ctx.globalAlpha = 1;
	for (const s of drawn) if (s.tool !== "highlighter") drawStroke(ctx, cam, s, undefined, true);
	// Drawn - but drawn into a box that may have no size on screen yet. If it
	// has none, re-measure when the layout gives it one instead of leaving a
	// correct canvas inside a collapsed root.
	watchIfCollapsed(root, path);
}
