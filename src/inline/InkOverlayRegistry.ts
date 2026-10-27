/**
 * The overlay's module-level registry, split out of InkOverlay.ts: the shared ink store, the set of mounted overlays,
 * the on/off switches, the sweeps and reports that walk every overlay, the copy and cut notices, and the committed-layer floor.
 *
 * InkOverlay.ts re-exports every exported name here, so each importer keeps its import line. This file reads InkOverlayPlugin
 * as a type only, so it adds no load-time cycle.
 */
import type { Editor, TFile } from "obsidian";
import { contentOrigin } from "./ContentOrigin";
import { markPenSeen, releaseMouseInkQuietly } from "./PenToolsMode";
import { StrokeMetrics } from "../ink/StrokeMetrics";
import { ribbonCacheStats } from "../ink/StrokeRenderer";
import { InlineInkStore } from "./InlineInkStore";
import { embedInkLayerCount, embedInkPrintSwaps, initEmbedInkCanvasNote, initEmbedInkColumnWidth, initEmbedInkLineSignature, printColumnWidth } from "./EmbedInk";
import { initEmbedInkPrintCanvas } from "./EmbedInkPrint";
import { canvasForNote } from "./CanvasNoteOverride";
import { setNoteChoiceSource } from "./NoteChoiceHint";
import { armMouseInkQuietly, mouseInkEnabled, toolPickedHere } from "./MouseInk";
import { surfaceExtents } from "./SurfaceExtent";
import { tipModeHeld, releaseTipModes, repaintSurfaces, hideCursorSurfaces, endStrokeSurfaces, refreshStripSurfaces } from "./InkOverlayToolState";
import type { InkOverlayPlugin } from "./InkOverlay";

const sessionStartMs = Date.now();
export let enabled = true;

export const inlineInk = new InlineInkStore();
setNoteChoiceSource(inlineInk);
export const instances = new Set<InkOverlayPlugin>();

export let scrollExpansionEnabled = false;
export function setScrollExpansionEnabled(on: boolean): void {
	if (on === scrollExpansionEnabled) return;
	scrollExpansionEnabled = on;
	// Off: the room scrolling demanded is no longer asked for, so every note's
	// sideways grant comes back down to what its ink needs (shrinkSideways).
	if (!on) surfaceExtents.oweShrinkXEverywhere();
	// The mode IS the gate for the ctrl+wheel zoom, so turning it off
	// mid-run leaves a preview up with nothing left to end it. End it here, on
	// its own anchor, before the mode changes anything else.
	if (!on) for (const overlay of instances) overlay.endWheelZoomRun();
	// The global is only the DEFAULT now; each note answers for itself (a frontmatter
	// override, src/inline/CanvasNoteOverride.ts). Every mounted note re-reads its own answer and
	// applies it: momentum, the wheel zoom, and a zoomed note landing back at 100 percent when its
	// canvas goes off.
	for (const overlay of instances) {
		overlay.applyCanvasMode();
		overlay.scheduleRepaint("scroll-expansion-setting");
	}
}

export function prepareFingerInkEverywhere(): void {
	for (const p of instances) p.prepareFingerInk();
}
/** Shared across editors so an A/B session accumulates one summary list. */
export const metrics = new StrokeMetrics();

export function isInlineInkEnabled(): boolean {
	return enabled;
}

export function setInlineInkEnabled(on: boolean): void {
	enabled = on;
	for (const p of instances) (on ? p.mount() : p.unmount());
}

/**
 * How the line-number gutters follow a pan written on `.cm-sizer`.
 *
 * RIDE: the gutters are not inside the sizer (stock CodeMirror), so they take the sizer's translate themselves.
 * COUNTER: they are inside it but absolutely positioned against the scroller (Obsidian nests them in
 * `.cm-contentContainer`; Minimal makes them `position: absolute !important`). A transformed sizer becomes their
 * containing block, which moves them by the sizer's offset inside the scroller on the first panned frame (48 px with
 * Minimal's line-number padding); the counter translate takes that offset back off. Layout px, like the offsets.
 * NONE: inside it and in flow or sticky, so the sizer's translate already carries them.
 */
export type GutterPanMode = { kind: "ride" } | { kind: "counter"; translate: string } | { kind: "none" };

/**
 * Read once per pan, and again after a column margin write moves the sizer. Safe with a live sizer transform: the
 * precondition below never reads `offsetParent` (which switches to a transformed sizer), and `offsetLeft`/`offsetTop`
 * ignore transforms.
 */
export function gutterPanMode(sizer: HTMLElement | null, gutters: HTMLElement, scroller: HTMLElement | undefined): GutterPanMode {
	if (!sizer || typeof sizer.contains !== "function" || !sizer.contains(gutters)) return { kind: "ride" };
	const win = gutters.ownerDocument?.defaultView;
	const cs = win?.getComputedStyle?.(gutters);
	// The anchored test needs COMPUTED values: getComputedStyle resolves a positioned element's `top: auto` to its used
	// offset ("32px"), while the Typed OM keeps the keyword. No Typed OM (the unit fixtures) means NONE.
	if (!cs || !win || typeof gutters.computedStyleMap !== "function") return { kind: "none" };
	if (cs.position !== "absolute" && cs.position !== "fixed") return { kind: "none" };
	// Absolutely positioned against the scroller only while nothing between them is positioned or transformed, the
	// sizer's own transform aside (it is ours).
	let el = gutters.parentElement;
	for (; el && el !== scroller; el = el.parentElement) {
		const s = win.getComputedStyle(el);
		if (s.position !== "static" || (el !== sizer && s.transform !== "none")) return { kind: "none" };
	}
	if (!el) return { kind: "none" };
	const map = gutters.computedStyleMap();
	const dx = String(map.get("left")) !== "auto" ? sizer.offsetLeft + sizer.clientLeft : 0;
	const dy = String(map.get("top")) !== "auto" ? sizer.offsetTop + sizer.clientTop : 0;
	return { kind: "counter", translate: dx === 0 && dy === 0 ? "" : `translate(${-dx}px,${-dy}px)` };
}

/** The mounted overlay showing `path`, if any editor has it open. */
export function overlayForPath(path: string): InkOverlayPlugin | null {
	for (const p of instances) {
		if (p.showsPath(path)) return p;
	}
	return null;
}

// A native export prints the note at the width its text column has here, shrunk to the paper (see EmbedInk.ts).
initEmbedInkColumnWidth((path) => { const p = overlayForPath(path); const line = p ? contentOrigin(p.view.contentDOM).line : null; return printColumnWidth(p?.viewportLayout?.columnBox, line instanceof HTMLElement ? line.offsetWidth : null); });
// Reading view honours a note's anchors as its editor does, under the editor's signature (see EmbedInkLines.ts). An editor hidden
// by Reading view keeps its last measured one: a measure of width 0 is never taken (InkOverlayLineAnchors lineSignatureMeasured).
initEmbedInkLineSignature((path) => overlayForPath(path)?.lineAnchorState?.sig ?? null);
// A native export of an Infinite Canvas note prints the text and the ink on it only (see EmbedInkPrint.ts); the overlay answers whether the note shows the canvas.
initEmbedInkPrintCanvas((path) => canvasForNote(path, scrollExpansionEnabled));
// A canvas note's Reading view scrolls as far as the editor granted the note (see EmbedInk.ts readingExtent); the same answer.
initEmbedInkCanvasNote((path) => canvasForNote(path, scrollExpansionEnabled));

/**
 * The mounted overlay that IS the editor the user is working in.
 *
 * `overlayForPath` answers the FIRST overlay showing a path. That is the right
 * answer for a background repaint, where every pane on the path shows the same
 * ink, and the wrong one for a command: two panes on one note share a path, so
 * the palette and the hotkeys reached whichever pane mounted first - deleting
 * ink the user could see was not selected, and leaving the undo step in a pane
 * they were not looking at.
 *
 * IDENTITY, NEVER A PATH, on both halves. Two `TFile` objects can name one
 * path, and Obsidian reuses editors, so an `Editor` can still be paired with
 * the file it used to show. Either comparison alone can be satisfied by the
 * wrong pane.
 *
 * NULL RATHER THAN A GUESS. No fallback to the path, and never to another
 * pane's selection: a command that refuses is recoverable, and ink deleted in
 * a pane the user is not looking at is not. `overlayForPath` itself keeps its
 * policy unchanged for every caller that wants the old, broader question.
 */
export function overlayForActiveEditor(editor: Editor, file: TFile): InkOverlayPlugin | null {
	for (const p of instances) {
		if (p.ownsActiveEditor(editor, file)) return p;
	}
	return null;
}

/** Re-evaluate the pen-tools strip on every open editor (mode command). */
export function refreshPenToolsAll(): void {
	for (const p of instances) p.ensurePenTools();
}

/**
 * The pen just went off (or on): end any live stroke on every open surface.
 *
 * The state can be flipped with the nib on the glass - a hotkey, the palette,
 * or the other hand on the strip - and the router's gate deliberately refuses
 * only NEW claims (see `InlinePenCallbacks.penOff`). Without this, a stroke
 * claimed a moment earlier would keep `activePenId` set with the window-
 * capture click suppressor armed behind it, which is the note-switch failure
 * `abandonActiveStroke` was written for, reached a different way.
 *
 * COMMITS, it does not drop. `finishActiveStroke()` ends the stroke exactly
 * as a lift does - the surface's own `penUp` commits the ink and stands the
 * strip chrome down - which is the ruling already settled for the other
 * teardown a writer hits mid-stroke (alan, 2026-09-04, on a window blur:
 * "alt tab mid stroke - sure make it consistent"). Turning the pen off is not
 * a request to throw away the word being written, and a toggle that ate it
 * would be a worse bug than the one this feature fixes.
 *
 * Nothing live means nothing done: `finishActiveStroke()` returns false and
 * changes no state at all. Deliberately NOT `abandonActiveStroke()`, whose
 * teardown also runs `restoreGuardStyle()` whenever an ownership tail is
 * still open - that would strip the standing touch-action guard off the
 * scroller on every toggle made just after a stroke, which is the lit-nib
 * regression its own header spells out.
 * `preserveMouse` is the Keyboard-OFF exception: an owned mouse stays live
 * until its own up/cancel; blur and teardown use the default false.
 *
 * EVERY SURFACE, like the state itself. This walked `instances` alone while
 * the pen-off state was note-only; the owner's reversal ("why would you take
 * keyboard mode away from pdf") gave the pdf a gate of its own, and with it a
 * live stroke that has to end the same way. `instances` is the editor overlays
 * and nothing else, so the pdf half comes through `addStripSurface`'s
 * `onEndLiveStroke` - the same registry the reticle and strip fan-outs use,
 * and for the reason `stripSurfaces` states: this module is imported BY the
 * pdf surface, so importing back would close the loop.
 */
export function endLiveStrokesEverywhere(preserveMouse = false): void {
	for (const p of instances) p.endLiveStroke(preserveMouse);
	for (const end of endStrokeSurfaces) end(preserveMouse);
}

/**
 * Refresh every open editor's strip. The recording dot lives on the strip
 * and recording toggles from the PALETTE, with no pen anywhere near - the
 * pen-driven refreshes fire far too late for it (the dot appeared only
 * after the first stroke and outlived the recording it announced).
 */
export function refreshAllStrips(): void {
	for (const p of instances) p.refreshStrip();
	refreshStripSurfaces();
}

/**
 * Put a mouse-claimed tool down QUIETLY, and repaint every open strip's
 * light - not just the one that was clicked.
 *
 * `releaseMouseInkQuietly` (PenToolsMode.ts) clears the mode and the pen
 * light's `penHardware` flag but does not `announce()` - it changes no
 * surface's existence, only how a strip draws, so it leaves the repaint to
 * its callers. Before this wrapper, both hosts' `disarmMouseInkQuietly`
 * called it directly and then relied on `MobileTools`'s own post-click
 * `this.refresh()`, which repaints only the ONE strip the pointer is on. A
 * second open pane - another note, or the PDF - kept showing whatever light
 * it had before the put-down until something unrelated repainted it
 * (hardware finding, 2026-09-03, the same class of bug as the mouse-ink-off
 * command carried).
 *
 * Defined once, here, rather than duplicated in both hosts' object literals:
 * PenToolsMode.ts's own comment on `releaseMouseInkQuietly` names that kind
 * of duplication as this project's most expensive recurring defect, and
 * `MobileTools.ts` cannot reach `refreshAllStrips` itself (it is imported BY
 * this file, so importing back would close a cycle) - this module is the one
 * place that can pair the two calls once for every surface.
 */
/**
 * Mouse ink just went OFF: put the reticle away on every open surface.
 *
 * The reticle is taken down by two things and neither of them fires here. A
 * pen's is taken down by the 1000ms hover watchdog (`armHoverWatchdog`); an
 * armed mouse's is taken down by `pointerleave`, and it is EXEMPT from the
 * watchdog on both surfaces, on the correct grounds that a mouse is either
 * over the pane or has sent that event. Turning mouse ink off is the third
 * way, and it is neither: the pointer has not moved and never will - the
 * hotkey, the command palette and the strip's own put-down all reach this
 * edge with the mouse sitting still over the pane. The ring stayed lit and
 * `PEN_HOVER_CLASS`'s `cursor: none` stayed on the scroller, so the surface
 * had no pointer at all until something unrelated happened to hide it
 * (adversarial review, 2026-09-04, of the exemption this branch added).
 *
 * Fanned out the way the nib light already is on this same edge, and for the
 * same reason: a second open pane is not repainted by whatever the pointer is
 * over. Both halves are here rather than at the two call sites for the reason
 * `applyMouseInkUiFanout` (main.ts) gives - the loud toggle command and the
 * quiet put-down are one rule with two writers.
 *
 * A PEN hovering when this fires loses its ring for one sample and gets it
 * straight back: hover samples stream continuously from a hand-held pen, and
 * `showPenCursor` rebuilds the ring from the next one. That is the same trade
 * `hidePenCursor` already makes everywhere else it is called.
 *
 * Costs nothing when nothing toggles: no caller but the OFF edge.
 */
export function hidePenCursorsEverywhere(): void {
	for (const p of instances) p.hidePenCursor();
	for (const hide of hideCursorSurfaces) hide();
}

export function releaseMouseInkQuietlyEverywhere(): void {
	releaseMouseInkQuietly();
	refreshAllStrips();
	// The mode is off as of the line above, so the reticle it was holding up
	// is now a ring with nothing behind it; see hidePenCursorsEverywhere.
	hidePenCursorsEverywhere();
}

/** Peel one tool layer without disabling real pen contact or changing the chosen nib. */
export function peelInkEscapeFloor(event: KeyboardEvent): boolean {
	if (event.key !== "Escape" || event.defaultPrevented) return false;
	if (tipModeHeld()) {
		releaseTipModes();
		hidePenCursorsEverywhere();
		refreshAllStrips();
	} else if (mouseInkEnabled() || toolPickedHere()) {
		releaseMouseInkQuietlyEverywhere();
	} else return false;
	event.preventDefault();
	return true;
}

/** A selection still gets its own press when focus has left the editor. */
export function peelInlineEscapeSelection(doc: Document, event: KeyboardEvent): boolean {
	if (event.key !== "Escape" || event.defaultPrevented) return false;
	for (const overlay of instances) {
		if (overlay.ownerDocument === doc && overlay.hasSelection) return overlay.handleKeyDown(event);
	}
	return false;
}

/** The host may close a window before CodeMirror destroys its views. */
export function closeInlineInkDocument(doc: Document): void {
	for (const overlay of [...instances]) {
		if (overlay.ownerDocument === doc) overlay.destroy();
	}
}

/** Bubble on the window so host dialogs and every pane get Escape first. */
export function bindInkEscapeWindow(win: Window, peelSelection: (event: KeyboardEvent) => boolean): () => void {
	const doc = win.document;
	const onKey = (event: KeyboardEvent): void => {
		if (event.key !== "Escape" || event.defaultPrevented) return;
		const hostLayers = doc.querySelectorAll(".modal-container, .menu, .suggestion-container");
		if ([...hostLayers].some(layer => layer.getClientRects().length > 0 && win.getComputedStyle(layer).visibility !== "hidden")) return;
		if (!peelSelection(event)) peelInkEscapeFloor(event);
	};
	win.addEventListener("keydown", onKey);
	return () => win.removeEventListener("keydown", onKey);
}

/**
 * Arm mouse ink QUIETLY, and repaint what the ON edge has always repainted.
 *
 * The mirror of the wrapper above, and it exists for the same reason: the
 * bare `armMouseInkQuietly` (MouseInk.ts) flips a module flag and nothing
 * else, so a second open pane keeps its stale dark nib - the strip's own
 * post-click `this.refresh()` repaints only the strip the pointer is on.
 *
 * The three calls are exactly `applyMouseInkUiFanout(true)`'s (main.ts),
 * because this is the SAME edge reached quietly. Until now the strip's
 * active-nib mouse click reached it through the loud toggle command, which
 * did that fan-out on the way past; routing that click to the quiet arm - so
 * it stops writing data.json - would otherwise have dropped the fan-out
 * along with the write, which is a different bug rather than a fix.
 * `markPenSeen` because arming mouse ink IS declaring yourself a pen person,
 * the toggle command's own words: the toolbar must not go on waiting for
 * hardware that is never coming.
 *
 * Defined here rather than in `MouseInk.ts` for the reason its neighbour
 * gives: `refreshAllStrips` lives in this module, which `MouseInk` cannot
 * import back without closing a real cycle.
 */
export function armMouseInkQuietlyEverywhere(): void {
	armMouseInkQuietly();
	markPenSeen();
	refreshPenToolsAll();
	refreshAllStrips();
}

/**
 * Repaint every surface's committed ink: the shaping, smoothing and pressure
 * toggles all change render-time geometry and none of them touches a stroke,
 * so nothing else would. A held shape snap stays: a theme change or a synced
 * setting arriving mid-hold changes nothing it would commit, and its own check
 * (tool, colour, size) drops it when something does.
 */
export function repaintAllInkOverlays(): void {
	for (const p of instances) p.scheduleRepaint("shaping-toggle");
	for (const repaint of repaintSurfaces) repaint();
}

/** Everything the A/B comparison against the canvas view needs, as text. */
export function copyInlineInkMetrics(): string {
	let downs = 0;
	let ups = 0;
	let backstops = 0;
	let silentLifts = 0;
	let palms = 0;
	for (const p of instances) {
		downs += p.routerCounters().downs;
		ups += p.routerCounters().ups;
		backstops += p.routerCounters().backstops;
		silentLifts += p.routerCounters().silentLifts;
		palms += p.routerCounters().palms;
	}
	// Session health: the accumulation suspects for slow-after-hours
	// reports. If draw times in the summaries below stay flat but strokes
	// FEEL late, the lag is upstream of the canvas (input or compositor).
	const cache = inlineInk.cacheStats();
	const lines = [
		`Handwriting ink metrics: ${metrics.summaries.length} stroke(s)`,
		`down/up/backstop/silent: ${downs}/${ups}/${backstops}/${silentLifts}  palms blocked: ${palms}`,
		`session: up ${((Date.now() - sessionStartMs) / 60000).toFixed(0)} min  overlays ${instances.size}  embed layers ${embedInkLayerCount()}  print swaps ${embedInkPrintSwaps()}`,
		`ink cache: ${cache.notes} note(s), ${cache.strokes} strokes, ${cache.points} points`,
		`ribbon cache: ${ribbonCacheStats().hits} hit / ${ribbonCacheStats().misses} miss`,
		// `desynchronized` is a hint, not a contract - a browser may refuse it
		// without saying so. Report what was GRANTED, so "the tip is on the
		// low-latency path" is something this panel can settle rather than
		// something the code merely asked for.
		[...instances][0]?.latencyReport() ?? "canvas latency: (no overlay mounted)",
		"",
		...metrics.summaries.map((s) => StrokeMetrics.summaryText(s)),
	];
	return lines.join("\n");
}


/**
 * A note's ink was replaced by an external reload: the overlays showing it
 * drop any lasso selection (its stroke ids may no longer exist) and repaint.
 * Path-scoped on purpose - other notes' overlays have nothing to redraw.
 */
export function inkExternallyReloaded(path: string): void {
	for (const p of instances) p.noteExternallyReloaded(path);
}

export interface InlineReloadBinding {
	pane: object;
	attachment: object;
	epoch: number;
	file: object;
	editor: object | undefined;
	path: string;
	quiet: boolean;
}

/** Census includes busy bindings; a quiet sibling cannot hide one. */
export function inlineReloadBindings(): InlineReloadBinding[] {
	const bindings: InlineReloadBinding[] = [];
	for (const pane of instances) {
		const binding = pane.reloadBinding();
		if (binding) bindings.push(binding);
	}
	return bindings;
}

/** A note is eligible only when every attached pane on it is quiet. */
export function inlineReloadCandidates(): string[] {
	const quietByPath = new Map<string, boolean>();
	for (const binding of inlineReloadBindings()) {
		quietByPath.set(binding.path, (quietByPath.get(binding.path) ?? true) && binding.quiet);
	}
	return [...quietByPath].filter(([, quiet]) => quiet).map(([path]) => path);
}

/** The same cohort must remain attached, bound to this document, and quiet. */
export function captureInlineReloadAdmission(path: string): (() => boolean) | null {
	const bindings = () => inlineReloadBindings().filter(binding => binding.path === path);
	const expected = bindings();
	if (!expected.length || expected.some(binding => !binding.quiet)) return null;
	return () => {
		const current = bindings();
		return current.length === expected.length && expected.every((before, index) => {
			const now = current[index];
			return !!now && now.quiet && now.pane === before.pane && now.attachment === before.attachment &&
				now.epoch === before.epoch && now.file === before.file && now.editor === before.editor;
		});
	};
}

/** Zoom diagnostics for every live editor. Run at 100% and at zoom, then diff. */
export function copyInlineZoomReport(): string {
	if (instances.size === 0) return "Handwriting zoom report: no editors mounted";
	const parts = [`Handwriting zoom report: ${instances.size} editor(s)`];
	let n = 0;
	for (const p of instances) parts.push(`\n--- editor ${++n} ---`, p.zoomReport());
	return parts.join("\n");
}

/** The pane with the MOST RECENT commit, never an older pane's stale box. */
function newestCommitInstance(): InkOverlayPlugin | null {
	let best: InkOverlayPlugin | null = null;
	for (const p of instances) {
		if (p.lastCommitAt > (best?.lastCommitAt ?? Number.NEGATIVE_INFINITY)) best = p;
	}
	return best && best.lastCommitAt > Number.NEGATIVE_INFINITY ? best : null;
}

/** Region census at the last committed stroke's screen box (occluder hunt). */
export function copyRegionCensus(): string {
	const p = newestCommitInstance();
	const live = [...instances].map((i) => i.containerEl()).filter((c): c is Element => !!c);
	const r = p?.censusReport(live);
	return r ?? "Handwriting region census: no committed stroke this session. Draw one first.";
}

/** Composited-frame capture vs committed backing at the last stroke's box. */
export async function copyPresentationReport(): Promise<string> {
	const p = newestCommitInstance();
	const r = await p?.presentationReport();
	return r ?? "Handwriting presentation capture: no committed stroke this session. Draw one first.";
}

/**
 * "Delete all ink" (command entry): remove every committed stroke on the note
 * at `path` as ONE editor-history entry. A command may supply the pane it
 * started in; a missing or unmounted preferred pane refuses, never falls back
 * to the first pane showing the same note. Legacy path-only callers retain
 * their first-mounted lookup. A single Ctrl+Z restores all strokes with
 * z-order intact, exactly like undoing one big erase.
 * Returns the stroke count removed, 0 when the note
 * had none, or null when no mounted editor is showing that note (the wipe
 * needs an editor's history to be undoable, so there is no store-only path).
 */
export function deleteAllInkOn(path: string, preferred?: InkOverlayPlugin | null): number | null {
	if (preferred !== undefined) {
		return preferred && instances.has(preferred) && preferred.showsPath(path)
			? preferred.clearAllInk(path)
			: null;
	}
	for (const p of instances) {
		const n = p.clearAllInk(path);
		if (n !== null) return n;
	}
	return null;
}

/** Surface-extent diagnostics: spacer, granted extent, scroll reach. */
export function copyInlineSurfaceReport(): string {
	if (instances.size === 0) return "Handwriting surface report: no editors mounted";
	const parts = [`Handwriting surface report: ${instances.size} editor(s)`];
	let n = 0;
	for (const p of instances) parts.push(`\n--- editor ${++n} ---`, p.surfaceReport());
	return parts.join("\n");
}

/**
 * What a lasso cut actually did, `DeleteSelectionOutcome`'s
 * (InlineSelectionDelete.ts) own shape for `cutSelectedInk`, and for the
 * same reason: a bare count answered 0 both when nothing was selected and
 * when the copy worked but the delete matched nothing in the store, and
 * every caller that reached 0 said "lasso some ink first" over ink that had,
 * in fact, just been copied and left on the page.
 *
 * Defined here rather than in `InlineSelectionDelete.ts`: that module owns
 * the delete outcome and nothing about cutting, and a cut is copy-then-
 * delete, a fact only this file knows.
 */
export type CutSelectionOutcome =
	/** Copied and removed. `count` is how many strokes. */
	| { kind: "cut"; count: number }
	/** Nothing was selected, or there is no path to cut from. */
	| { kind: "empty" }
	/** Copied, but the delete matched nothing in the store - the ink and the
	 *  lasso both stayed on the page. */
	| { kind: "unmatched"; count: number };

/**
 * The notice a lasso copy owes the user.
 *
 * Same shape and same reason as `cutSelectionNotice` below: ONE owner for
 * the sentence, so the strip button and the registered command cannot drift
 * into two wordings for one outcome. Both strings are exactly the ones the
 * command site's ternary produced before this function existed - moved, not
 * rewritten - and the empty-selection one stays byte-identical, as it has
 * through every box that has touched this row.
 */
export function copySelectionNotice(copied: number): string {
	if (copied > 0) return `Handwriting: copied ${copied} stroke(s)`;
	return "Handwriting: lasso some ink first";
}

/**
 * Which arm of `copySelectionNotice` a call is going to take, so a caller can
 * hide the routine one behind the developer switch without hiding the other.
 *
 * BRANCH-AWARE ON PURPOSE (root, 2026-09-09). The count is a routine success
 * and goes quiet; "lasso some ink first" is no-op guidance and must keep
 * showing. Gating the CALL would have taken both. This sits beside the string
 * helper rather than inside it so the helper's API and its exact sentences are
 * untouched, and so the wording still has one owner.
 */
export function copySelectionNoticeIsRoutine(copied: number): boolean {
	return copied > 0;
}

/**
 * The notice a lasso cut owes the user, `lassoDeleteNotice`'s
 * (InlineSelectionDelete.ts) own shape and reason: pinned by execution
 * rather than by reading a caller as text, and the empty-selection string
 * must stay byte-identical, since it was always true.
 */
export function cutSelectionNotice(outcome: CutSelectionOutcome): string {
	if (outcome.kind === "cut") return `Handwriting: cut ${outcome.count} stroke(s)`;
	if (outcome.kind === "empty") return "Handwriting: lasso some ink first";
	return `Handwriting: copied ${outcome.count} stroke(s) but could not remove them - the lasso has been kept`;
}

/**
 * `copySelectionNoticeIsRoutine`'s counterpart, and the reason this one is
 * worth stating separately: `cutSelectionNotice` has THREE arms, and only the
 * first is routine. "empty" is no-op guidance and the third is a partial
 * FAILURE - ink was copied but could not be removed - which is the last
 * sentence that should ever be hidden behind a developer switch.
 */
export function cutSelectionNoticeIsRoutine(outcome: CutSelectionOutcome): boolean {
	return outcome.kind === "cut";
}

/**
 * The width floor a committed paint uses, or undefined when there is no
 * committed backing to floor against.
 *
 * A FREE FUNCTION, not a method, and that is load-bearing: `repaint` is invoked
 * in the render harness on partial objects that carry the overlay's data fields
 * without its prototype. `this.committedBacking` resolves there; a
 * `committedFloorFor(this.committedBacking, this.dpr)` does not - it fails with "is not a function" inside
 * the page, past the type checker, and only two render tests catch it. Taking
 * the values as arguments keeps ONE definition for both paint sites without
 * depending on what `this` is.
 *
 * `backing` is the exact multiplier the committed context was set with, never
 * re-derived - see WidthFloor.ts.
 */
export function committedFloorFor(backing: number | null, dpr: number): { backing: number; dpr: number } | undefined {
	return backing === null ? undefined : { backing, dpr };
}

/**
 * `raw` moved toward `bounded` by the largest whole number of device px not above the exact clamp move, so
 * the page keeps the grid its ink is rastered on and never moves further than the bound asked. It can rest
 * under one device px past the bound, which is not a visible overscroll. `bounded` itself when the bound did
 * not move the page.
 */
export function onDeviceGrid(raw: number, bounded: number, dpr: number): number {
	const k = dpr > 0 && Number.isFinite(dpr) ? dpr : 1;
	const d = (raw - bounded) * k;
	// Float noise is not a correction: the bound's own value stands.
	if (!Number.isFinite(d) || Math.abs(d) < 1e-6) return bounded;
	return raw - (d > 0 ? Math.floor(d + 1e-6) : Math.ceil(d - 1e-6)) / k;
}
