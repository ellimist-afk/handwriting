/**
 * Where an embed's ink goes: the rendered root a section belongs to, whether that root is a live editor block, a
 * section embed, a popover or collapsed, how long to wait for one, and the layer's anchor inside it. EmbedInk.ts
 * re-exports the names it exported before.
 */
import { printNote } from "./EmbedInkPrint";
import { anchorSizer, columnInset, printAnchor, sizerHeaderHeight } from "./EmbedInk";

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
 * A Live Preview widget is rendered Markdown inside the note's own editor.
 * Its postprocessor receives the note path, but its table/callout is not a
 * second view of that note. Walk inward-out: an explicit embed content box
 * before the editor is a real rendered note, even when nested in Live Preview.
 */
export function embedInkIsLiveEditorBlock(
	sectionEl: HTMLElement,
	containerEl: HTMLElement | null | undefined
): boolean {
	const start = sectionEl.isConnected ? sectionEl : (containerEl ?? sectionEl);
	for (let node: HTMLElement | null = start; node; node = node.parentElement) {
		if (node.classList?.contains("markdown-embed-content")) return false;
		// cm-embed-block: a callout's widget is post-processed before CodeMirror
		// inserts it, so the detached block is the only editor mark it carries.
		if (
			node.classList?.contains("cm-editor") ||
			node.classList?.contains("markdown-source-view") ||
			node.classList?.contains("cm-embed-block")
		) return true;
	}
	return false;
}

/**
 * A heading or block embed (`![[Note#Heading]]`, `![[Note#^id]]`) renders one
 * section but is post-processed with the whole note's path, and the note's ink
 * has no section coordinates to cut it by. Drawing it would lay every other
 * section's ink over the excerpt and stretch the box to the whole note's ink
 * (audit #30), so such an embed gets no ink. The nearest embed decides: a
 * whole-note embed nested inside a section embed still draws its own note.
 */
export function embedInkIsSectionEmbed(
	sectionEl: HTMLElement,
	containerEl: HTMLElement | null | undefined
): boolean {
	const start = sectionEl.isConnected ? sectionEl : (containerEl ?? sectionEl);
	for (let node: HTMLElement | null = start; node; node = node.parentElement) {
		if (!node.classList?.contains("markdown-embed") && !node.classList?.contains("internal-embed")) continue;
		const src = node.getAttribute?.("src");
		if (src !== null && src !== undefined) return src.includes("#");
	}
	return false;
}

/**
 * A hover preview can render a [[Note#Heading]] section with no `src` to say
 * so, post-processed under the whole note's path. Nothing in the element tells
 * it from a whole-note preview, so a popover draws ink only when the caller
 * can prove the render was the whole note (see `attachEmbedInkOnceReady`).
 */
export function embedInkInPopover(
	sectionEl: HTMLElement,
	containerEl: HTMLElement | null | undefined
): boolean {
	const start = sectionEl.isConnected ? sectionEl : (containerEl ?? sectionEl);
	return start.closest?.(".hover-popover") != null;
}

/**
 * True when the root sits under an element the host hid with an inline
 * `display: none` - Obsidian's `hide()`, which is how a tab keeps its reading
 * view connected while Live Preview is showing. Inline styles only: no layout
 * read on the save path.
 */
export function embedInkRootHidden(root: HTMLElement): boolean {
	for (let node: HTMLElement | null = root; node; node = node.parentElement) {
		if (node.style?.display === "none") return true;
	}
	return false;
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
export type EmbedInkVia = "section" | "container" | "observer" | "timer" | "none" | "print";

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
 *
 * `print` is the export's own line: what the fit measured and built at the screen call and at the print-media call
 * (see `noteExport`). Its text is the one the print code left in `printNote` just before calling the sink, so a sink
 * that only forwards the three pieces still prints it.
 */
export function embedInkDiagLine(via: EmbedInkVia, path: string, waitedMs: number): string {
	if (via === "print") return `[handwriting] export fit ${printNote}: ${path}`;
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
 * Ink is anchored to the sizer's top-left, PLUS the height of the sizer's own
 * `.mod-header` (the inline title and Properties block), when the sizer has
 * one. Editor y=0 is `.cm-content`'s top, which sits below that same header -
 * it is never part of `.cm-content`. Without this, ink drawn under the text
 * in the editor landed under the header instead, in reading view and in
 * print (audit 18 / GitHub #19). An embed's top is NOT covered: its root has
 * no sizer, and whether its Properties header takes height is unmeasured.
 *
 * The root is now the view outside the sizer, so the inset between them has
 * to be added back, and it is not a constant: the sizer is centred, so it
 * moves with the pane's width. Left is the text column's edge, not the
 * sizer's (`columnInset`), for a reading view and for an embed alike: one x
 * law.
 *
 * Null for every other root, whose `0, 0` is already right, for an embed
 * with no column ever measured, and for a sizer
 * with no offset parent - that is a `display: none` subtree, where every
 * offset reads 0, which is a real coordinate rather than a missing one.
 */
export function embedInkAnchor(root: HTMLElement, remeasure = false): { left: number; top: number } | null {
	const sizer = anchorSizer(root);
	if (!sizer) {
		if (embedInkRootIsEmbed(root)) {
			const inset = columnInset(root, null, root, remeasure);
			if (inset !== null) return { left: inset, top: 0 };
		}
		return printAnchor(root, remeasure);
	}
	if (sizer.offsetParent !== root) return null;
	return {
		left: sizer.offsetLeft + (columnInset(root, sizer, sizer, remeasure) ?? 0),
		top: sizer.offsetTop + sizerHeaderHeight(sizer),
	};
}
