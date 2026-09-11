import { timerHost } from "../util/RuntimeScheduler";
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

import { CameraState } from "../camera/coordinates";
import { drawStroke } from "../ink/StrokeRenderer";
import { InkStroke } from "../ink/Stroke";
import { InkSvgRun, inkSvgLayers } from "../ink/SvgExport";
import { HIGHLIGHTER_ALPHA } from "../ink/PenStyle";

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
 */
const MAX_LAYER_PX = 4_000_000;
const MARKER_ATTR = "data-handwriting-embed-ink";
/**
 * Records the `min-height` value WE last wrote on an embed root, so it can be
 * told apart from one the theme or Obsidian set. Same discipline as the
 * `position: relative` revert below, just with a value instead of a fixed
 * sentinel: `position` only ever becomes "relative" under us, but the
 * min-height we set moves with the ink's own height, so remembering "relative"
 * would not be enough to recognise it later.
 */
const MIN_HEIGHT_ATTR = "data-handwriting-embed-min-height";
const SVG_NS = "http://www.w3.org/2000/svg";

/** Windows whose print swap is already wired; popouts each get their own. */
const printArmed = new WeakSet<Window>();
/**
 * Teardowns for the print listeners, because the WeakSet above cannot survive
 * a plugin reload. Disable and re-enable and the module is evaluated afresh:
 * the set is empty, the listeners are added again, and the previous pair is
 * still on the window calling into the old module. Printing then fires both.
 */
const printDisarms: Array<() => void> = [];
/**
 * How many times a print actually asked for the vector layer.
 *
 * `beforeprint` is not guaranteed: an export that renders through its own
 * pipeline rather than the browser's print flow may never fire it, and the
 * symptom of that is indistinguishable by eye from a swap that fired and
 * didn't help. A count settles it in one export instead of another round of
 * inference from how the ink looks.
 */
let printSwaps = 0;

export function embedInkPrintSwaps(): number {
	return printSwaps;
}

/**
 * What the print vector layer is landing on.
 *
 * This layer exists ONLY while a print or an export is happening, and what it
 * lands on then is paper or a PDF page rather than the reading view's theme -
 * a print stylesheet drops the page to white whatever the editor looked like.
 * That is why the ink is made readable against white here and NOT against the
 * body's background: the swap is the moment the destination stops being the
 * screen. Outside the swap this module paints canvases, which are on-screen
 * surfaces and are left alone.
 */
const PRINT_PAGE_WHITE = "#ffffff";

const CAM: CameraState = { x: 0, y: 0, zoom: 1 };

/** Live rendered roots, each mapped to the note path it shows. */
const layers = new Map<HTMLElement, string>();
/** Bumped per path on every persisted change; part of the marker. */
const revisions = new Map<string, number>();
let strokesFor: ((path: string) => readonly InkStroke[]) | null = null;
/**
 * Where the one diagnostic line goes, when the setting is on.
 *
 * The pieces, not the string: the caller owns the `devDiagnostics` check and
 * so the line is only ever FORMATTED when someone is going to read it, which
 * matters when a scrolling reading view resolves a root per section.
 */
let diagnose: ((via: EmbedInkVia, path: string, waitedMs: number) => void) | null = null;
/**
 * Cancellers for waits that have not resolved yet, and for the resize
 * observers watching a collapsed root.
 *
 * Both live in someone else's document and outlast the render child that
 * started them: a plugin reload replaces this module while a pending timer or
 * a live observer goes on calling into the old one. `teardownEmbedInk` empties
 * both, which is why unload is the single place either can be leaked from.
 */
const pendingWaits = new Set<() => void>();
/**
 * One route-3 MutationObserver per DOCUMENT, shared by every wait on it.
 *
 * That observer is `body` + `subtree`, so it fires for every mutation
 * Obsidian makes anywhere. One per unresolved section meant a reading-view
 * note with N embeds installed N of them, each running
 * `embedInkResolveRoot` (up to two `closest` walks) on every one of those
 * mutations for up to ten seconds. The waits share one observer instead,
 * armed with the first wait on a body and disconnected when its last wait
 * goes. Keyed by body, not module-wide: a popout is its own document and
 * watching it through the main window's observer would see nothing.
 */
const bodyWatches = new Map<HTMLElement, { observer: MutationObserver; probes: Set<() => void> }>();
const sizeWatches = new Map<HTMLElement, () => void>();
/** Reading-view roots whose layer offset has to keep up with the pane. */
const anchorWatches = new Map<HTMLElement, { stop(): void; sizer: HTMLElement | null }>();

export function embedInkAnchorWatchCount(): number {
	return anchorWatches.size;
}

/**
 * The rendered document's root for a section element, if recognizable.
 *
 * Order is a preference, not a distance: each `closest` walks the whole chain.
 *
 * The sizer used to be the reading view's root and cannot be one. The
 * virtualised renderer owns its direct children and removes an appended
 * canvas in the same millisecond (Obsidian 1.13.7); the marker attribute
 * survives, so the root looks painted while showing nothing, and nothing
 * repaints it in a session that only reads. Embeds were unaffected because
 * `.markdown-embed-content` is not reconciled.
 *
 * `.markdown-preview-view` one level up survives a re-render and is already
 * `position: relative`, so it holds the layer instead; `embedInkAnchor` undoes
 * the inset between the two. The sizer stays below it for a render context
 * with no view, and the last entry for one with no sizer either - an export
 * or a print renders into a container of its own.
 */
export function embedInkRoot(sectionEl: HTMLElement): HTMLElement | null {
	return (
		sectionEl.closest<HTMLElement>(".markdown-embed-content") ??
		sectionEl.closest<HTMLElement>(".markdown-preview-view") ??
		sectionEl.closest<HTMLElement>(".markdown-preview-sizer") ??
		sectionEl.closest<HTMLElement>(".markdown-rendered")
	);
}

/**
 * The root for a section, or for the renderer's container when the section
 * is not yet in a tree.
 *
 * The virtualised preview renderer loads a section's MarkdownRenderChild
 * before inserting the section element into the sizer, so `embedInkRoot` on
 * the section alone often has nothing to climb from. The one thing the
 * renderer hands the post-processor for certain, attached or not, is its OWN
 * container - the sizer in the new renderer, the `.markdown-preview-view`
 * div in the old one - so that becomes the fallback anchor. Climbing from it
 * lands on the same root this returned before the renderer changed:
 * `embedInkRoot` on an embed's sizer still reaches `.markdown-embed-content`
 * (`closest()` includes the element itself, and the sizer sits inside it),
 * and on a plain reading view it returns the sizer, exactly what an already
 * -attached section would have resolved to.
 *
 * `containerEl` is not declared on MarkdownPostProcessorContext - read off
 * the shipped bundle, not the public API - so the caller passes it in only
 * after its own duck check that it is actually an element, and this stays a
 * pure fallback rather than assuming anything about its shape.
 */
export function embedInkRootFor(
	sectionEl: HTMLElement,
	containerEl: HTMLElement | null | undefined
): HTMLElement | null {
	return embedInkResolveRoot(sectionEl, containerEl).root;
}

/**
 * Which of the routes to a root actually worked.
 *
 * `section` and `container` are the two synchronous ones above. `observer`
 * and `timer` are the deferred route - no root at post-processing time, so
 * the wait below watched for the section to land and one of its two triggers
 * got there first. `none` means the wait ran out its budget and this section
 * never gained ink; it is the line worth having from a user we cannot see.
 */
export type EmbedInkVia = "section" | "container" | "observer" | "timer" | "none";

/**
 * The root AND the route that found it.
 *
 * Same order as `embedInkRoot`'s selectors and for the same reason - the
 * section pins the coordinate origin best - but it reports which route won,
 * because on a machine we cannot see that is the difference between "the
 * renderer handed us a container" and "we waited for the DOM". `embedInkRootFor`
 * is this with the route dropped, so every existing caller is unchanged.
 */
export function embedInkResolveRoot(
	sectionEl: HTMLElement,
	containerEl: HTMLElement | null | undefined
): { root: HTMLElement | null; via: "section" | "container" | "none" } {
	const fromSection = embedInkRoot(sectionEl);
	if (fromSection) return { root: fromSection, via: "section" };
	const fromContainer = containerEl ? embedInkRoot(containerEl) : null;
	if (fromContainer) return { root: fromContainer, via: "container" };
	return { root: null, via: "none" };
}

/**
 * How long the deferred route may wait for a section to land in the tree.
 *
 * This replaced a 30-FRAME budget, which is the wrong unit for the thing it
 * was bounding. Frames are not time: a background window throttles them to
 * nothing, a busy renderer stretches them, and a device slow enough to be the
 * reason the section is late is exactly the device whose 30 frames are worth
 * far less than half a second. Ten seconds of wall clock is the same promise
 * on every machine - and it is a ceiling, not a cost, because the observer
 * below almost always gets there first.
 */
export const EMBED_INK_WAIT_MS = 10_000;

/** Pure: is the wait still inside its budget? Time, never frames. */
export function embedInkKeepWaiting(elapsedMs: number): boolean {
	return elapsedMs < EMBED_INK_WAIT_MS;
}

/**
 * Pure: how long to sleep before the next check.
 *
 * Tight at first, because the ordinary case is a section that lands on the
 * very next tick and an export that is about to serialize the page; loose
 * later, because a section still missing after a second is waiting on
 * something slower than polling can help with, and the MutationObserver is
 * the one that will actually catch it. Bounded above so the whole schedule
 * costs about fifty wake-ups across ten seconds rather than six hundred.
 */
export function embedInkRetryDelay(elapsedMs: number): number {
	if (elapsedMs < 250) return 16;
	if (elapsedMs < 1_000) return 50;
	return 250;
}

/**
 * Pure: the one diagnostic line, behind the developer diagnostics setting.
 *
 * One line per section that resolved (or failed to resolve) a root, naming
 * the route. It exists for a machine we cannot get at: it is the difference
 * between "your renderer hands us no container and the section never
 * connected" and "we attached fine, the ink is elsewhere", which is otherwise
 * an afternoon of guessing per report.
 */
export function embedInkDiagLine(via: EmbedInkVia, path: string, waitedMs: number): string {
	return `[handwriting] embed ink root via ${via} after ${waitedMs}ms: ${path}`;
}

/**
 * Pure: has a painted root been given no size on screen?
 *
 * A root can be found, marked and painted while its box measures 0x0 - a
 * `.markdown-embed-content` inside a collapsed callout, a pane whose theme
 * lays it out a tick later, an embed rendered inside something still
 * `display: none`. The canvas is sized from the INK's extent, so it is not
 * itself zero, but nothing of it is on screen and painting once and never
 * looking again leaves it that way until the section happens to re-render.
 */
export function embedInkIsCollapsed(rect: { width: number; height: number } | null): boolean {
	if (!rect) return false;
	return rect.width <= 0 || rect.height <= 0;
}

/**
 * Pure: is this rendered root an embed's content box?
 *
 * Only `.markdown-embed-content` gets grown to fit its ink (see `paint`) - a
 * plain reading view's `.markdown-preview-sizer` is a scroller whose sizing
 * the virtualised renderer already owns, and forcing a min-height onto it
 * would fight that renderer rather than fix a clip.
 */
export function embedInkRootIsEmbed(root: { classList: { contains(cls: string): boolean } }): boolean {
	return root.classList.contains("markdown-embed-content");
}

/**
 * The offset a reading view's layer needs, or null to leave it where the
 * stylesheet puts it.
 *
 * Ink is anchored to the sizer's top-left. The root is now the view outside
 * it, so the inset between them has to be added back, and it is not a
 * constant: the sizer is centred, so it moves with the pane's width.
 *
 * Null for every other root, whose `0, 0` is already right, and for a sizer
 * with no offset parent - that is a `display: none` subtree, where every
 * offset reads 0, which is a real coordinate rather than a missing one.
 */
export function embedInkAnchor(root: HTMLElement): { left: number; top: number } | null {
	const sizer = anchorSizer(root);
	if (!sizer || sizer.offsetParent !== root) return null;
	return { left: sizer.offsetLeft, top: sizer.offsetTop };
}

/** The sizer a reading view's layer is anchored to, if this root is one. */
function anchorSizer(root: HTMLElement): HTMLElement | null {
	if (!root.classList?.contains("markdown-preview-view")) return null;
	return root.querySelector<HTMLElement>(":scope > .markdown-preview-sizer");
}

function anchorLayer(root: HTMLElement, el: { style: CSSStyleDeclaration }): void {
	const at = embedInkAnchor(root);
	if (!at) return;
	// Through `style`, not `setCssStyles`: the print swap anchors an <svg>,
	// and Obsidian's helper is an augmentation of HTMLElement.
	el.style.left = `${at.left}px`;
	el.style.top = `${at.top}px`;
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
 */
export function embedInkScale(w: number, h: number, dpr: number): number {
	if (w <= 0 || h <= 0) return 1;
	const want = Math.max(1, dpr);
	const area = w * h * want * want;
	if (area <= MAX_LAYER_PX) return want;
	return Math.max(0.25, Math.sqrt(MAX_LAYER_PX / (w * h)));
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

/**
 * Where the diagnostic line goes. Wired once at plugin load; null silences it.
 */
export function initEmbedInkDiagnostics(
	sink: ((via: EmbedInkVia, path: string, waitedMs: number) => void) | null
): void {
	diagnose = sink;
}

/** Diagnostics: waits still pending, and roots still watched for a size. */
export function embedInkPendingWaitCount(): number {
	return pendingWaits.size;
}

export function embedInkSizeWatchCount(): number {
	return sizeWatches.size;
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
		paint(root, path, strokesFor ? strokesFor(path) : []);
	}
}

/**
 * Drop roots the DOM let go of. Runs on every attach AND every change
 * notification, so growth is bounded by render activity as well as save
 * activity - a session that only READS (hover previews register roots and
 * never draws) must not accumulate detached trees and their canvases.
 */
function sweepDisconnected(): void {
	for (const root of [...layers.keys()]) {
		if (!root.isConnected) layers.delete(root);
	}
	sweepSizeWatches();
}

/**
 * Drop the size watches whose root the DOM let go of: a root that left the
 * tree will never gain a size, so its watch is a live ResizeObserver holding
 * a detached tree alive by a strong Map key for nothing.
 *
 * Split out of `sweepDisconnected` because `paint` runs THIS half on its own
 * and the layers half above is the expensive one: `embedInkChanged` paints
 * every root showing the note, so a full sweep per paint would cost
 * O(roots) per root - quadratic in the embeds on screen, on the path every
 * save takes. This half is bounded by the number of COLLAPSED roots, which
 * is zero in the ordinary case and does not grow with the embeds that did
 * lay out; the size test keeps even the array copy off that path.
 */
function sweepSizeWatches(): void {
	if (anchorWatches.size > 0) {
		for (const root of [...anchorWatches.keys()]) if (!root.isConnected) stopAnchorWatch(root);
	}
	if (sizeWatches.size === 0) return;
	for (const root of [...sizeWatches.keys()]) {
		if (!root.isConnected) stopSizeWatch(root);
	}
}

/**
 * Attach (or refresh) the ink layer on a rendered document root and put it
 * in the registry. Idempotent per (root, path, revision): a second section
 * with the same path finds the marker and leaves the existing layer alone.
 * Registered even with zero strokes, so an embed rendered before its note
 * was ever drawn on still gains ink at the first gesture.
 */
export function attachEmbedInk(
	root: HTMLElement,
	path: string,
	strokes: readonly InkStroke[]
): void {
	sweepDisconnected();
	layers.set(root, path);
	armPrintSwap(root.ownerDocument.defaultView ?? window);
	paint(root, path, strokes);
}

/**
 * Attach ink to a rendered section as soon as a root for it can be found,
 * however this build of Obsidian gets round to producing one.
 *
 * There are three routes and the code has to hold all three at once, because
 * which one applies is a property of the reader's app, not of ours:
 *
 * 1. The section is already in the tree, so `closest` walks straight up to the
 *    root. Every renderer before 1.12, and reading view once it has settled.
 * 2. The section is NOT in the tree yet - the virtualised preview renderer
 *    loads a section's render child before inserting the element - but the
 *    post-processor context carries the renderer's own `containerEl`, which
 *    is, and climbing from that lands on the same root.
 * 3. Neither: a build that hands us no container and a section that has not
 *    landed. Older desktop builds, and mobile is assumed to be here until
 *    somebody measures it. This is the route we cannot test on this machine
 *    and the one a report of "no ink in embeds" most likely lands on, so it
 *    gets belt AND braces: a MutationObserver on the document body (ONE
 *    per document, shared with every other wait on it - see `bodyWatches`),
 *    which fires the moment the renderer inserts the section whether or not
 *    frames are running, and a time-bounded poll behind it, in case a renderer
 *    reparents into a subtree the observer was not given or the section is
 *    moved by something that does not mutate `body` (an iframe-hosted
 *    document, a shadow root). Ten seconds of WALL CLOCK, not thirty frames:
 *    a backgrounded window can run no frames at all and a slow device's
 *    thirty are worth less than half a second.
 *
 * Route 1 stays SYNCHRONOUS and that is not an optimisation. An export
 * renders the note and serializes it immediately; a picture taken before a
 * promise resolves has already lost its ink.
 *
 * Returns a canceller for `child.onunload`, and registers the same canceller
 * for `teardownEmbedInk` - a render child's unload is not the plugin's, and a
 * pending wait that survives a reload is a timer calling into a dead module.
 */
export function attachEmbedInkOnceReady(
	el: HTMLElement,
	container: HTMLElement | null,
	path: string,
	strokes: () => readonly InkStroke[]
): () => void {
	const immediate = embedInkResolveRoot(el, container);
	if (immediate.root) {
		attachEmbedInk(immediate.root, path, strokes());
		diagnose?.(immediate.via, path, 0);
		return () => {};
	}
	const view = el.ownerDocument?.defaultView ?? null;
	const started = Date.now();
	let timer: number | null = null;
	let unwatchBody: (() => void) | null = null;
	let done = false;

	const cancel = (): void => {
		if (done) return;
		done = true;
		if (timer !== null) {
			clearTimer(view, timer);
			timer = null;
		}
		unwatchBody?.();
		unwatchBody = null;
		pendingWaits.delete(cancel);
	};

	/** One attempt. True once a root was found and the wait is over. */
	const settle = (via: "observer" | "timer"): boolean => {
		if (done) return false;
		const late = embedInkResolveRoot(el, container);
		if (!late.root) return false;
		const waited = Date.now() - started;
		cancel();
		attachEmbedInk(late.root, path, strokes());
		diagnose?.(via, path, waited);
		return true;
	};

	const tick = (): void => {
		timer = null;
		if (done) return;
		if (settle("timer")) return;
		const elapsed = Date.now() - started;
		if (!embedInkKeepWaiting(elapsed)) {
			// Out of budget. The line naming `none` is the whole point of the
			// diagnostic: it says the section never connected, which is a
			// different bug from one that attached and drew nothing.
			cancel();
			diagnose?.("none", path, elapsed);
			return;
		}
		timer = setTimer(view, tick, embedInkRetryDelay(elapsed));
	};

	// Registered before either trigger is armed, so there is no window in
	// which something is running that teardown cannot reach.
	pendingWaits.add(cancel);
	// The observer first, so a section inserted between here and the first
	// poll is caught by the cheaper of the two. Watching `body` with a
	// subtree is broad, but it lives only until the section lands or the
	// budget runs out, and only on the route where nothing else worked.
	const body = el.ownerDocument?.body ?? el.ownerDocument?.documentElement ?? null;
	unwatchBody = watchBodyForSections(view, body, () => void settle("observer"));
	if (!done) timer = setTimer(view, tick, embedInkRetryDelay(0));
	return cancel;
}

/**
 * Subscribe a probe to this document's shared route-3 observer, arming it if
 * this is the first wait on that body. Returns the unsubscriber (null when
 * there is no observer to be had - a host without `MutationObserver`, or a
 * detached document with no body - which is exactly the case the poll behind
 * it exists for), and disconnects the observer as the last probe leaves.
 */
function watchBodyForSections(
	view: Document["defaultView"],
	body: HTMLElement | null,
	probe: () => void
): (() => void) | null {
	const MO = view?.MutationObserver ?? null;
	if (!MO || !body) return null;
	let entry = bodyWatches.get(body);
	if (!entry) {
		const probes = new Set<() => void>();
		// Over a COPY: a probe that resolves cancels its own wait, which
		// unsubscribes it from this very set mid-iteration.
		const observer = new MO(() => {
			for (const p of [...probes]) p();
		});
		observer.observe(body, { childList: true, subtree: true });
		entry = { observer, probes };
		bodyWatches.set(body, entry);
	}
	entry.probes.add(probe);
	return () => {
		const live = bodyWatches.get(body);
		if (!live) return;
		live.probes.delete(probe);
		if (live.probes.size > 0) return;
		live.observer.disconnect();
		bodyWatches.delete(body);
	};
}

/**
 * Timers scheduled on the section's OWN window where there is one.
 *
 * A popout has its own window object, and a timer scheduled on the main one
 * for an element in a popout goes on firing after that popout has closed.
 * Falling back to the globals keeps this working under a fake view in tests
 * and anywhere `defaultView` is null (a detached document).
 */
function setTimer(view: Window | null, fn: () => void, ms: number): number {
	if (view && typeof view.setTimeout === "function") return view.setTimeout(fn, ms);
	return timerHost().setTimeout(fn, ms);
}

function clearTimer(view: Window | null, handle: number): void {
	if (view && typeof view.clearTimeout === "function") {
		view.clearTimeout(handle);
		return;
	}
	timerHost().clearTimeout(handle);
}

/** Cancel every pending wait. Called by teardown; safe to call twice. */
function cancelPendingWaits(): void {
	for (const cancel of [...pendingWaits]) cancel();
	pendingWaits.clear();
	// Cancelling every wait empties the shared observers by itself; this is
	// the belt on that, so unload stays the single place either collection
	// can be leaked from even if a canceller was lost.
	for (const { observer } of bodyWatches.values()) observer.disconnect();
	bodyWatches.clear();
}

/** Stop watching a root's size, if we were. */
function stopSizeWatch(root: HTMLElement): void {
	const stop = sizeWatches.get(root);
	if (!stop) return;
	stop();
	sizeWatches.delete(root);
}

/** Stop every size watch. Called by teardown. */
function stopAllSizeWatches(): void {
	for (const stop of [...sizeWatches.values()]) stop();
	sizeWatches.clear();
}

function stopAnchorWatch(root: HTMLElement): void {
	const watch = anchorWatches.get(root);
	if (!watch) return;
	watch.stop();
	anchorWatches.delete(root);
}

/** Stop every anchor watch. Called by teardown. */
function stopAllAnchorWatches(): void {
	for (const watch of [...anchorWatches.values()]) watch.stop();
	anchorWatches.clear();
}

/**
 * Re-anchor a reading view's layer as the pane changes width.
 *
 * Only `paint` writes the offset and a resize does not repaint, so without
 * this the ink stays where the text used to be until the next gesture.
 *
 * Both boxes are observed: toggling "readable line length" resizes the sizer
 * inside a view whose own box never changes, so watching the view alone sees
 * nothing while the ink drifts by the whole centring margin.
 */
function watchAnchor(root: HTMLElement): void {
	if (!root.classList?.contains("markdown-preview-view") || anchorWatches.has(root)) return;
	const RO = root.ownerDocument?.defaultView?.ResizeObserver ?? null;
	if (!RO) return;
	const sync = (): void => {
		if (anchorWatches.get(root) !== watch) return;
		if (!root.isConnected) {
			stopAnchorWatch(root);
			return;
		}
		const sizer = anchorSizer(root);
		if (watch.sizer !== sizer) {
			if (watch.sizer) ro.unobserve(watch.sizer);
			watch.sizer = sizer;
			if (sizer) ro.observe(sizer);
		}
		const canvas = root.querySelector<HTMLCanvasElement>(":scope > canvas.handwriting-embed-ink");
		if (canvas) anchorLayer(root, canvas);
		const svg = root.querySelector<SVGSVGElement>(":scope > svg.handwriting-embed-ink");
		if (svg) anchorLayer(root, svg);
	};
	const ro = new RO(sync);
	// A replacement need not repaint or resize the view. Observe only the
	// surviving root's direct children, then move the resize watch to its
	// current sizer; edits inside rendered sections need no observer work.
	const MO = root.ownerDocument?.defaultView?.MutationObserver ?? null;
	const mo = MO ? new MO(sync) : null;
	const watch = { sizer: null as HTMLElement | null, stop: () => { ro.disconnect(); mo?.disconnect(); } };
	anchorWatches.set(root, watch);
	ro.observe(root);
	mo?.observe(root, { childList: true });
	sync();
}

/**
 * A painted root with no size on screen gets watched until it has one.
 *
 * The 1.4.11 §6 clip - an embed's content box sized to its TEXT, 24px against
 * 368px of ink - is fixed by growing `min-height`, but that fix assumes the
 * box is being LAID OUT when we paint. Under a theme that renders the embed
 * collapsed, or inside a folded callout, or on a pane the renderer has not
 * given a size to yet, the box measures 0x0 and the min-height lands on
 * something with no layout to apply it to. Drawing once and walking away
 * leaves the ink invisible until that section next re-renders, which for an
 * embed can be never.
 *
 * So the box is re-measured on the observer's tick instead: as soon as the
 * layout gives it a size, the marker is dropped and it is painted again
 * against the box it actually has. The watch stops on the first non-zero
 * measurement, on teardown, and when the root leaves the DOM.
 */
function watchIfCollapsed(root: HTMLElement, path: string): void {
	if (typeof root.getBoundingClientRect !== "function") return;
	// A root the DOM has let go of measures 0x0, which `embedInkIsCollapsed`
	// cannot tell from a collapsed root still on screen - and it will never
	// gain a size, so arming a watch here would be a ResizeObserver on a
	// detached tree with nothing left to fire it.
	if (root.isConnected === false) {
		stopSizeWatch(root);
		return;
	}
	const view = root.ownerDocument?.defaultView ?? null;
	const RO = view?.ResizeObserver ?? null;
	if (!RO) return;
	if (!embedInkIsCollapsed(root.getBoundingClientRect())) {
		stopSizeWatch(root);
		return;
	}
	if (sizeWatches.has(root)) return;
	const ro = new RO(() => {
		if (!sizeWatches.has(root)) return;
		if (embedInkIsCollapsed(root.getBoundingClientRect())) return;
		stopSizeWatch(root);
		// Re-measure: the marker is what makes `paint` stand down, so drop it
		// and paint again now the box has a size.
		root.removeAttribute(MARKER_ATTR);
		paint(root, path, strokesFor ? strokesFor(path) : []);
	});
	ro.observe(root);
	sizeWatches.set(root, () => ro.disconnect());
}

/**
 * Canvas on screen, vector on paper.
 *
 * The two representations are good at opposite things and the choice is not a
 * compromise, it is a switch. A canvas costs what the PAGE costs - ten strokes
 * and ten thousand render identically - so no amount of drawing can slow a
 * note down, which is the only acceptable behaviour for a surface people are
 * meant to draw freely on. But a canvas is a fixed grid of pixels, and a
 * printer wants a resolution nobody knew at render time, so ink came out of a
 * PDF visibly soft beside the text.
 *
 * Vector has exactly the inverse profile: nothing to choose a resolution for,
 * and a cost that grows with how much was drawn. So it exists only while a
 * print is actually happening - built on `beforeprint`, dropped on
 * `afterprint`, never present during ordinary use.
 *
 * If a print path never fires these events, nothing swaps and the canvas is
 * printed, which is exactly the behaviour before any of this. The failure mode
 * is the old output, not a broken one.
 */
function armPrintSwap(win: Window): void {
	if (printArmed.has(win)) return;
	printArmed.add(win);
	const on = () => usePrintVector(true);
	const off = () => usePrintVector(false);
	win.addEventListener("beforeprint", on);
	win.addEventListener("afterprint", off);
	printDisarms.push(() => {
		win.removeEventListener("beforeprint", on);
		win.removeEventListener("afterprint", off);
	});
	// Second trigger, because the first is unreliable. A print stylesheet
	// becoming active is a media-query change, and some print paths flip that
	// without ever dispatching beforeprint. Both are idempotent: whichever
	// arrives first builds the layer and the other finds it already there.
	const mq = win.matchMedia?.("print");
	const onMq = (e: MediaQueryListEvent) => usePrintVector(e.matches);
	mq?.addEventListener?.("change", onMq);
	if (mq) printDisarms.push(() => mq.removeEventListener?.("change", onMq));
}

/** Drop the print listeners at unload, so a reload cannot leave a pair behind. */
export function disarmPrintSwaps(): void {
	for (const d of printDisarms.splice(0)) d();
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
		root.querySelector(":scope > canvas.handwriting-embed-ink")?.remove();
		root.querySelector(":scope > svg.handwriting-embed-ink")?.remove();
		root.removeAttribute(MARKER_ATTR);
		if (root.style.position === "relative") root.style.removeProperty("position");
		clearEmbedMinHeight(root);
	}
	layers.clear();
	revisions.clear();
	strokesFor = null;
	diagnose = null;
}

function usePrintVector(on: boolean): void {
	if (on) printSwaps++;
	sweepDisconnected();
	for (const [root, path] of layers) {
		const canvas = root.querySelector<HTMLCanvasElement>(
			":scope > canvas.handwriting-embed-ink"
		);
		const existing = root.querySelector<SVGSVGElement>(
			":scope > svg.handwriting-embed-ink"
		);
		if (!on) {
			existing?.remove();
			canvas?.style.removeProperty("display");
			continue;
		}
		const strokes = strokesFor ? strokesFor(path) : [];
		const { w, h } = embedInkExtent(strokes);
		if (strokes.length === 0 || w <= 0 || h <= 0) continue;
		// createElementNS, not createEl: an <svg> built as an HTML element is
		// an unknown tag that renders nothing.
		const svg = existing ?? root.ownerDocument.createElementNS(SVG_NS, "svg");
		svg.setAttribute("class", "handwriting-embed-ink");
		svg.setAttribute("aria-hidden", "true");
		svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
		svg.setAttribute("width", `${w}`);
		svg.setAttribute("height", `${h}`);
		// Built as elements rather than markup. The content is safe either
		// way - colours pass through normalizeInkColor and the rest is
		// formatted numbers - but assigning markup is flagged on sight by
		// the community review, and building nodes costs nothing here.
		while (svg.firstChild) svg.removeChild(svg.firstChild);
		const layers = inkSvgLayers(strokes, PRINT_PAGE_WHITE);
		if (layers.highlighter.length > 0) {
			const g = root.ownerDocument.createElementNS(SVG_NS, "g");
			g.setAttribute("opacity", String(HIGHLIGHTER_ALPHA));
			for (const run of layers.highlighter) g.appendChild(inkPathEl(root, run));
			svg.appendChild(g);
		}
		for (const run of layers.pen) svg.appendChild(inkPathEl(root, run));
		if (!existing) root.appendChild(svg);
		anchorLayer(root, svg);
		canvas?.setCssStyles({ display: "none" });
	}
}

/** One merged run as an SVG <path>, in the root's own document. */
function inkPathEl(root: HTMLElement, run: InkSvgRun): SVGPathElement {
	const el = root.ownerDocument.createElementNS(SVG_NS, "path");
	el.setAttribute("fill", run.color);
	el.setAttribute("fill-rule", "nonzero");
	el.setAttribute("d", run.d);
	return el;
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

function paint(root: HTMLElement, path: string, strokes: readonly InkStroke[]): void {
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
	if (!embedInkNeedsPaint(root.getAttribute(MARKER_ATTR), marker, canvas !== null)) {
		// A detached view may return with its unchanged bitmap. Its old
		// observers were stopped, so restore layout tracking without repainting.
		if (canvas) anchorLayer(root, canvas);
		watchAnchor(root);
		return;
	}
	root.setAttribute(MARKER_ATTR, marker);
	const view = root.ownerDocument.defaultView ?? window;
	const { w, h } = embedInkExtent(strokes);
	if (strokes.length === 0 || w <= 0 || h <= 0) {
		// The last stroke was erased: the picture goes too, and so does any
		// room we grew the embed by to hold it.
		canvas?.remove();
		if (embedInkRootIsEmbed(root)) clearEmbedMinHeight(root);
		// Nothing left to become visible, so nothing left to watch for.
		stopSizeWatch(root);
		stopAnchorWatch(root);
		return;
	}
	if (view.getComputedStyle(root).position === "static") {
		root.setCssStyles({ position: "relative" });
	}
	if (embedInkRootIsEmbed(root)) {
		// An embed's content box sizes itself to its TEXT and clips the ink
		// hanging below it (measured: 24px box, 368px of ink). Growing the box
		// to the ink's own height fixes that. Reading view's sizer is left
		// alone on purpose - it is a scroller whose scroll range the
		// absolutely positioned canvas already extends, and it is resized by
		// the virtualised renderer itself; forcing a min-height onto it would
		// fight that renderer rather than fix a clip.
		const minHeight = `${h}px`;
		root.setCssStyles({ minHeight });
		root.setAttribute(MIN_HEIGHT_ATTR, minHeight);
	}
	if (!canvas) {
		canvas = root.createEl("canvas", { cls: "handwriting-embed-ink" });
	}
	// Every paint, not only the ones that resize the backing store: a repaint
	// can follow a resize that moved the sizer without changing the ink.
	anchorLayer(root, canvas);
	watchAnchor(root);
	// The canvas is sized in DEVICE pixels and laid out in css pixels, so the
	// strokes below can go on drawing in note units and come out sharp.
	const scale = embedInkScale(w, h, view.devicePixelRatio || 1);
	const backingW = Math.max(1, Math.round(w * scale));
	const backingH = Math.max(1, Math.round(h * scale));
	if (canvas.width !== backingW || canvas.height !== backingH) {
		canvas.width = backingW;
		canvas.height = backingH;
		canvas.setCssStyles({ width: `${w}px`, height: `${h}px` });
	}
	const ctx = canvas.getContext("2d");
	if (!ctx) return;
	ctx.setTransform(scale, 0, 0, scale, 0, 0);
	ctx.clearRect(0, 0, w, h);
	// Highlighter first and translucent as a layer would be; then pen.
	ctx.globalAlpha = 0.35;
	for (const s of strokes) if (s.tool === "highlighter") drawStroke(ctx, CAM, s, undefined, true);
	ctx.globalAlpha = 1;
	for (const s of strokes) if (s.tool !== "highlighter") drawStroke(ctx, CAM, s, undefined, true);
	// Drawn - but drawn into a box that may have no size on screen yet. If it
	// has none, re-measure when the layout gives it one instead of leaving a
	// correct canvas inside a collapsed root.
	watchIfCollapsed(root, path);
}
