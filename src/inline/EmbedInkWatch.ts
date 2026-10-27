/**
 * Attaching embed ink to a rendered root and keeping it there: the attach, the wait for a root that is not ready yet,
 * the shared body observer, the size and anchor watches and their timers. EmbedInk.ts re-exports the names it exported
 * before.
 */
import { timerHost } from "../util/RuntimeScheduler";
import { runDetached } from "../util/Detached";
import { InkStroke } from "../ink/Stroke";
import { armPrintSwap, printing, printVectorFor } from "./EmbedInkPrint";
import { embedInkInPopover, embedInkIsCollapsed, embedInkIsLiveEditorBlock, embedInkIsSectionEmbed, embedInkKeepWaiting, embedInkResolveRoot, embedInkRetryDelay } from "./EmbedInkRoot";
import { type EmbedInkLineSource, lineSources, recordLines } from "./EmbedInkMeasure";
import { anchorLayer, anchorSizer, diagnose, layers, MARKER_ATTR, paint, queueReplace, reserveLeft, strokesFor, sweepDisconnected } from "./EmbedInk";

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
/** The note each pending wait will attach for; a rename while it waits moves it. */
export const pendingWaitPaths = new Map<() => void, { path: string }>();
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

/** Diagnostics: waits still pending, and roots still watched for a size. */
export function embedInkPendingWaitCount(): number {
	return pendingWaits.size;
}

export function embedInkSizeWatchCount(): number {
	return sizeWatches.size;
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
export function sweepSizeWatches(): void {
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
	const win = root.ownerDocument.defaultView ?? window;
	armPrintSwap(win);
	paint(root, path, strokes);
	// Attached while this window is printing: part of the print, like the rest.
	if (printing.has(win)) printVectorFor(root, path, true);
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
	strokes: () => readonly InkStroke[],
	/**
	 * For a hover popover: resolves true only when the popover rendered the
	 * whole note. Without it, or when it says no, a popover gets no ink -
	 * wrong ink over a section is worse than none.
	 */
	wholeNote?: () => Promise<boolean>,
	popoverProven = false,
	/** Where the section's source lines come from, so anchored ink is drawn on its words (`placeStrokes`). */
	lines?: EmbedInkLineSource
): () => void {
	if (embedInkIsLiveEditorBlock(el, container) || embedInkIsSectionEmbed(el, container)) return () => {};
	if (!popoverProven && embedInkInPopover(el, container)) {
		if (!wholeNote) return () => {};
		let cancelled = false;
		let inner: (() => void) | null = null;
		runDetached(
			wholeNote().then((whole) => {
				if (whole && !cancelled) inner = attachEmbedInkOnceReady(el, container, path, strokes, undefined, true, lines);
			}),
			"check whether a hover preview rendered the whole note"
		);
		return () => {
			cancelled = true;
			inner?.();
		};
	}
	const immediate = embedInkResolveRoot(el, container);
	if (immediate.root) {
		if (lines) recordLines(immediate.root, el, lines);
		attachEmbedInk(immediate.root, path, strokes());
		diagnose?.(immediate.via, path, 0);
		return () => {};
	}
	const view = el.ownerDocument?.defaultView ?? null;
	const started = Date.now();
	let timer: number | null = null;
	let unwatchBody: (() => void) | null = null;
	let done = false;
	const wait = { path };

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
		pendingWaitPaths.delete(cancel);
	};

	/** One attempt. True once a root was found and the wait is over. */
	const settle = (via: "observer" | "timer"): boolean => {
		if (done) return false;
		if (
			embedInkIsLiveEditorBlock(el, container) ||
			embedInkIsSectionEmbed(el, container) ||
			(!popoverProven && embedInkInPopover(el, container))
		) {
			cancel();
			return true;
		}
		const late = embedInkResolveRoot(el, container);
		if (!late.root) return false;
		const waited = Date.now() - started;
		// The note this wait is for NOW: the vault may have renamed it while the
		// section was late, and the caller's own strokes() still answers for the
		// old path.
		const shown = wait.path;
		cancel();
		if (lines) recordLines(late.root, el, lines);
		attachEmbedInk(late.root, shown, shown === path ? strokes() : strokesFor ? strokesFor(shown) : []);
		diagnose?.(via, shown, waited);
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
	pendingWaitPaths.set(cancel, wait);
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
export function cancelPendingWaits(): void {
	for (const cancel of [...pendingWaits]) cancel();
	pendingWaits.clear();
	pendingWaitPaths.clear();
	// Cancelling every wait empties the shared observers by itself; this is
	// the belt on that, so unload stays the single place either collection
	// can be leaked from even if a canceller was lost.
	for (const { observer } of bodyWatches.values()) observer.disconnect();
	bodyWatches.clear();
}

/** Stop watching a root's size, if we were. */
export function stopSizeWatch(root: HTMLElement): void {
	const stop = sizeWatches.get(root);
	if (!stop) return;
	stop();
	sizeWatches.delete(root);
}

/** Stop every size watch. Called by teardown. */
export function stopAllSizeWatches(): void {
	for (const stop of [...sizeWatches.values()]) stop();
	sizeWatches.clear();
}

export function stopAnchorWatch(root: HTMLElement): void {
	const watch = anchorWatches.get(root);
	if (!watch) return;
	watch.stop();
	anchorWatches.delete(root);
}

/** Stop every anchor watch. Called by teardown. */
export function stopAllAnchorWatches(): void {
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
export function watchAnchor(root: HTMLElement): void {
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
			sections?.disconnect();
			if (sizer) sections?.observe(sizer, { childList: true });
		}
		const canvas = root.querySelector<HTMLCanvasElement>(":scope > canvas.handwriting-embed-ink");
		// The room the centring leaves moves with the pane, and the reserve with it.
		if (canvas) reserveLeft(root);
		// The watch tick is where the column is measured again: a
		// resize or the readable line length toggle moves it, a paint does not.
		if (canvas) anchorLayer(root, canvas, true);
		const svg = root.querySelector<SVGSVGElement>(":scope > svg.handwriting-embed-ink");
		if (svg) anchorLayer(root, svg, !canvas);
		// A resize re-wraps the text and moves the blocks: anchored strokes
		// are placed again, and repainted only when one is shown elsewhere.
		if (canvas && lineSources.has(root)) queueReplace(root);
	};
	const ro = new RO(sync);
	// A replacement need not repaint or resize the view. Observe only the
	// surviving root's direct children, then move the resize watch to its
	// current sizer; edits inside rendered sections need no observer work.
	const MO = root.ownerDocument?.defaultView?.MutationObserver ?? null;
	const mo = MO ? new MO(sync) : null;
	// The sections the renderer attaches and detaches in the sizer as the
	// view scrolls move neither the sizer nor the column, so nothing here is
	// measured: a stroke on a section that comes back is placed again, once
	// the task's renders are done, and only a root with line sources asks.
	const sections = MO
		? new MO(() => {
			if (anchorWatches.get(root) === watch && lineSources.has(root)) queueReplace(root);
		})
		: null;
	const watch = { sizer: null as HTMLElement | null, stop: () => { ro.disconnect(); mo?.disconnect(); sections?.disconnect(); } };
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
export function watchIfCollapsed(root: HTMLElement, path: string): void {
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
		// The note the root shows NOW: a file-open or a rename moved it while
		// the watch waited, and the path this watch started with is stale.
		const shown = layers.get(root) ?? path;
		paint(root, shown, strokesFor ? strokesFor(shown) : []);
	});
	ro.observe(root);
	sizeWatches.set(root, () => ro.disconnect());
}
