/**
 * The slides ink controller: the on and off switch, the document observers, the live deck, the teardown drains
 * and the small log and clock helpers. SlidesInkSurface.ts re-exports every name.
 */
import { type SlidesActions } from "./SlidesActions";
import { timerHost } from "../util/RuntimeScheduler";
import { diagnosticsEnabled } from "../diag/DiagSwitch";
import { SlidesDeck, type SlidesInkHost } from "./SlidesInkSurface";

// ---- module-level controller ----------------------------------------------

let enabled = false;
const observers = new Map<Document, MutationObserver>();
let stopDocumentChanges: (() => void) | null = null;
let deck: SlidesDeck | null = null;
let host: SlidesInkHost | null = null;
/**
 * Teardown drains of decks that are already gone.
 *
 * Module-level because `deck` is nulled the moment the container is detached,
 * and the write we are still waiting on belongs to that dead deck: a shutdown
 * that only asked the LIVE deck would report settled while the last stroke of
 * the presentation the reader just closed was still unwritten.
 */
export const drains = new Set<Promise<void>>();

export function log(message: string): void {
	console.debug(`[slides] ${message}`);
}

/**
 * Monotonic clock on the same base as `event.timeStamp`, so the hold
 * arithmetic in the reducer compares like with like.
 */
export function now(): number {
	return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function describe(el: Element): string {
	const cls =
		typeof el.className === "string" && el.className
			? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".")
			: "";
	return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${cls}`;
}

/**
 * True for anything that would eat a keystroke Reveal expects for itself:
 * `document.activeElement.isContentEditable`, or the input-family elements a
 * browser also excludes from ordinary keydown handling the same way.
 */
export function isTextEntryElement(el: Element): el is HTMLElement {
	if ((el as HTMLElement).isContentEditable) return true;
	const tag = el.tagName;
	return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** The document the presentation would be built in (popout-aware, S1). */
function presentationDoc(): Document {
	const active = typeof activeDocument === "undefined" ? undefined : activeDocument;
	return active ?? document;
}

/**
 * Find a live presentation, or null.
 *
 * Selector list rather than one string: this is someone else's markup, and the
 * only thing that makes a future rename a one-line change is knowing which
 * candidate matched.
 */
function findDeck(
	doc: Document
): { container: HTMLElement; reveal: HTMLElement; slides: HTMLElement } | null {
	const container = doc.body?.querySelector<HTMLElement>(":scope > .slides-container");
	if (!container) return null;
	const reveal = container.querySelector<HTMLElement>(".reveal");
	if (!reveal) return null;
	const slides = reveal.querySelector<HTMLElement>(".slides");
	if (!slides) return null;
	return { container, reveal, slides };
}

/**
 * Re-check the document for a presentation.
 *
 * Idempotent and cheap, so the workspace events in main.ts can call it freely.
 * It is NOT the mount signal - see S1 - the observer is.
 *
 * A live deck is disposed only when ITS OWN container is gone, never because
 * a scan of some other document did not turn it up. Presenting on one screen
 * with notes in a pop-out on the other focuses that pop-out constantly, and
 * every focus change that fires the body observer used to scan the pop-out's
 * (empty) document, find nothing there, and tear down the still-live deck on
 * the presentation screen - ink kept flushing, but the canvases were gone and
 * drawing stayed dead until the presenter exited and re-presented.
 */
export function scanForSlides(): void {
	if (!enabled || !host) return;
	if (deck) {
		if (deck.container.isConnected && observers.has(deck.ownerDocument)) return;
		deck.dispose();
		deck = null;
	}
	// No live deck: search every watched window, with the active one first.
	const active = presentationDoc();
	const ordered = [active, ...observers.keys()].filter((doc, i, docs) =>
		observers.has(doc) && docs.indexOf(doc) === i);
	const found = ordered.map(findDeck).find(Boolean) ?? null;
	if (found) {
		deck = new SlidesDeck(found.container, found.reveal, found.slides, host);
	}
}

function syncSlidesDocuments(): void {
	if (!enabled || !host) return;
	const wanted = new Set(host.documents?.() ?? [presentationDoc()]);
	for (const [doc, observer] of observers) {
		if (wanted.has(doc)) continue;
		observer.disconnect();
		observers.delete(doc);
	}
	for (const doc of wanted) {
		if (observers.has(doc) || !doc.body) continue;
		const observer = new MutationObserver(() => scanForSlides());
		observer.observe(doc.body, { childList: true });
		observers.set(doc, observer);
	}
	scanForSlides();
}

/**
 * main.ts's `css-change` handler (GAP 16): a theme switch or a snippet
 * toggle mid-presentation moves `.reveal`'s paint without remounting the
 * deck, and nothing else re-arms `measureDeckTheme` for a live deck. A
 * no-op with no deck live, so registering this beside the note-surface
 * fan-out costs nothing on every OTHER `css-change` this workspace fires.
 */
export function onSlidesCssChange(): void {
	deck?.onCssChange();
}

/** Whether slides ink is currently watching. */
export function slidesInkEnabled(): boolean {
	return enabled;
}

/**
 * The sidecar the live deck would let the live-reload poll re-read, or null.
 *
 * The poll in main.ts owns the timer for every surface; a deck presenting while
 * Syncthing writes its `.slides` sidecar rides that one tick rather than
 * keeping time of its own.
 */
export function slidesReloadCandidate(): string | null {
	return deck?.reloadCandidateSidecarId() ?? null;
}

/** Adopt an external `.slides` sidecar edit. True when the deck actually changed. */
export async function reloadSlidesExternal(sidecarId: string): Promise<boolean> {
	const live = deck;
	if (!live) return false;
	return live.reloadExternal(sidecarId);
}

/**
 * Wait for the live deck's parked claims, loads and teardown drains.
 *
 * `InlineInkStore.settle`'s shape and its reasons: bounded so a hung vault
 * write cannot wedge shutdown, several passes because a load can end by
 * starting a claim, and TRUE only when everything actually drained. A deck
 * disposed a moment ago is still in `drains` - its drain outlives the `deck`
 * binding, which `scanForSlides` nulls the instant the container goes.
 */
export async function settleSlidesInk(maxWaitMs = 2000): Promise<boolean> {
	let expire: (v: boolean) => void = () => {};
	const deadline = new Promise<boolean>((r) => {
		expire = r;
	});
	const scheduler = timerHost();
    const timer = scheduler.setTimeout(() => expire(true), maxWaitMs);
	try {
		for (let pass = 0; pass < 4; pass++) {
			const inFlight: Promise<unknown>[] = [...drains, ...(deck?.inFlightWork() ?? [])];
			if (inFlight.length === 0) return true;
			const timedOut = await Promise.race([
				Promise.all(inFlight).then(() => false),
				deadline,
			]);
			if (timedOut) return false;
		}
		return false;
	} finally {
		scheduler.clearTimeout(timer);
	}
}

/**
 * Turn slides ink on or off.
 *
 * Off is genuinely off: the observer is disconnected, the deck disposed (which
 * flushes its save), the canvases removed. With the setting off the observer is
 * never installed, so the whole cost of the feature to a reader who does not
 * present is its bundle size.
 */
export function setSlidesInk(on: boolean, next?: SlidesInkHost): void {
	if (next) host = next;
	if (on === enabled) return;
	enabled = on;
	if (!on) {
		stopDocumentChanges?.();
		stopDocumentChanges = null;
		for (const observer of observers.values()) observer.disconnect();
		observers.clear();
		deck?.dispose();
		deck = null;
		if (diagnosticsEnabled()) log("slides ink off");
		return;
	}
	if (!host) {
		// Nothing to draw with and nowhere to save: refuse rather than
		// installing an observer that would build a deck with no host.
		enabled = false;
		log("slides ink asked to start with no host; ignored");
		return;
	}
	// Each body owns its direct-child mount signal. Watching no subtree keeps
	// Reveal transitions from waking a full deck scan.
	stopDocumentChanges = host.onDocumentChange?.(syncSlidesDocuments) ?? null;
	syncSlidesDocuments();
	if (diagnosticsEnabled()) log(`slides ink on; watching ${observers.size} body(s), build ${host.buildId}`);
}

/** No underlying note fallback: commands resolve only a live deck in their document. */
export function activeSlidesActions(doc: Document): SlidesActions | null {
	return deck?.ownerDocument === doc && deck.status().live ? deck : null;
}
