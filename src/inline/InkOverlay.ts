import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import { editorInfoField } from "obsidian";
import { Camera } from "../camera/Camera";
import { computeCanvasSize, countPaintedPixels } from "../diag/Raster";
import { diagnosticsEnabled } from "../diag/DiagSwitch";
import { strokesHitByCircle } from "../ink/Eraser";
import { DEFAULT_PEN, HIGHLIGHTER_ALPHA, HIGHLIGHTER_PEN, PenStyle } from "../ink/PenStyle";
import { clampInkSize } from "../ink/InkSize";
import { getInkColorHex } from "../ink/InkColor";
import { Point2 } from "../ink/Smoothing";
import { BBox, InkStroke, InkTool } from "../ink/Stroke";
import { StrokeBuilder } from "../ink/StrokeBuilder";
import { StrokeMetrics } from "../ink/StrokeMetrics";
import { drawCommitted, drawStroke } from "../ink/StrokeRenderer";
import { TailRenderer } from "../ink/TailRenderer";
import { WetInkRenderer } from "../ink/WetInkRenderer";
import { PenSample } from "../input/PointerRouter";
import { pointInBBox } from "../objects/Selection";
import { SelectionModel } from "../objects/SelectionModel";
import { runDetached } from "../util/Detached";
import { InkOp, inkApplied, inkEffect, inkHistorySupport } from "./InkHistory";
import {
	InlineSelectionDeleteKeys,
	removeSelectedInlineStrokes,
} from "./InlineSelectionDelete";
import { StrokeFrame } from "./StrokeFrame";
import { FollowLayer } from "./FollowLayer";
import { clearMetadataVisibility, updateMetadataVisibility } from "./MetadataVisibility";
import { handoffFinishedStroke } from "./StrokeHandoff";
import { InlineInkStore } from "./InlineInkStore";
import { focusClaimedPenEditor } from "./InlineFocus";
import { PEN_HOVER_CLASS, penCursorLayout } from "./PenCursor";
import { normalizeInlinePenPressure } from "./PenPressure";
import { backingScale, effectiveScale, fontZoomFactor, noteToVisual, visualToNote } from "./ZoomScale";
import {
	isPenProbeEnabled,
	markMappedTip,
	noteProbeStroke,
	recordProbe,
	setProbeGeometry,
} from "./PenProbe";
import { InlinePenRouter } from "./InlinePenRouter";
import { describeEl, setHitProbeContext } from "./PenHitProbe";
import {
	Extent,
	ScrollAxisGuard,
	inkFrontier,
	isScrollableOverflow,
	spacerPosition,
	surfaceExtents,
	surfaceOriginInScroller,
	ZERO_EXTENT,
} from "./SurfaceExtent";
import { ProbeBox, capturePresented, parseHexColor, regionCensus } from "./PresentProbe";
import {
	bboxVisibleInViewport,
	scrollProbeCommit,
	scrollProbeExtent,
	scrollProbePenDown,
	scrollProbeRepaint,
	scrollProbeSchedule,
	scrollProbeScroll,
	scrollProbeWheel,
} from "./ScrollProbe";

/**
 * Ink on the ordinary Obsidian editor.
 *
 * A CM6 ViewPlugin mounts three viewport-sized canvases over the editor
 * (committed / wet / live-head tail, the same layering the approved canvas
 * pipeline uses) and claims only pen input, in capture phase, on the editor's
 * scroller. The editor underneath is untouched: typing, selection, links,
 * touch scrolling and caret placement remain native CodeMirror/Obsidian.
 *
 * Coordinates are NOTE-SURFACE coordinates (the settled OneNote model):
 * origin at the top-left of the Markdown content column, y absolute down the
 * document, zoom 1. Markdown flows however Obsidian wants; ink stays where
 * the pen physically put it; editing Markdown never moves ink. The existing
 * Camera does the mapping with its state pinned to
 *   (overlayLeft − contentLeft, overlayTop − documentTop, zoom 1),
 * so every reused renderer works unmodified.
 *
 * The pen hot path is the frozen pipeline verbatim: synchronous draw inside
 * `pointerrawupdate`, coalesced samples, live raw head + smoothed tail. The
 * only editor-derived values it touches are two numbers cached at pen-down.
 * Scroll/reflow repaints of committed ink are rAF-throttled and never run
 * during a stroke's wet path.
 *
 * Ink is keyed by file path in the session and persisted by InlineInkStore
 * under the note's page id; the eraser, lasso and history live on this
 * surface too. An untouched note stays untouched by construction: nothing is
 * written until the first stroke commits. Ink renders above the text; nothing
 * here bakes that in (a z-order field per stroke group can arrive later
 * without moving a single coordinate).
 */

/** Eraser radius in screen pixels (same feel as the canvas view). */
const ERASER_SCREEN_R = 12;
const SELECTION_COLOR = "#7f9cf5";
/** How far outside the selection box still counts as grabbing it, in px. */
const SELECTION_GRAB_PAD = 8;
/** Minimum spacing between lasso vertices, in screen px. */
const LASSO_MIN_STEP_PX = 2;

type PenMode = "ink" | "erase" | "lasso";

let enabled = true;
/**
 * What the pen TIP draws: pen or highlighter. This is a property of the nib
 * (like its color), not an interaction mode. The eraser end and the barrel
 * keep their hardware meanings regardless. Session-scoped; switched by command.
 */
let inlineTool: InkTool = "pen";
/**
 * Low-latency canvas request for the wet layers. Chosen by the v0.1.x A/B
 * re-run on the test Surface for the inline overlay: `true` noticeably improves pen
 * feel. Fixed at getContext() time; the diagnostic toggle that re-ran the
 * A/B was retired in the v0.13.0 cleanup.
 */
const INLINE_DESYNCHRONIZED = true;


// ---- ink size (v0.13.6) -----------------------------------------------------
//
// Size state lives here (session), pure step/clamp logic in ink/InkSize.ts,
// persistence in the plugin. Applied when a stroke BINDS its style at
// pen-down, so a size change takes effect on the next stroke with zero
// hot-path cost. Existing ink is never rewritten.

const inkSizeMult: Record<InkTool, number> = { pen: 1, highlighter: 1 };

export function getInkSizeMult(tool: InkTool): number {
	return inkSizeMult[tool];
}

export function setInkSizeMult(tool: InkTool, mult: number): void {
	inkSizeMult[tool] = clampInkSize(mult);
}

export function getInlineTool(): InkTool {
	return inlineTool;
}

export function setInlineTool(tool: InkTool): void {
	inlineTool = tool;
}

export const inlineInk = new InlineInkStore();
const instances = new Set<InkOverlayPlugin>();
/** Shared across editors so an A/B session accumulates one summary list. */
const metrics = new StrokeMetrics();

export function isInlineInkEnabled(): boolean {
	return enabled;
}

export function setInlineInkEnabled(on: boolean): void {
	enabled = on;
	for (const p of instances) (on ? p.mount() : p.unmount());
}

/** Repaint every open editor's committed ink (the shaping toggle uses this). */
export function repaintAllInkOverlays(): void {
	for (const p of instances) p.scheduleRepaint("shaping-toggle");
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
	const lines = [
		`Handwriting ink metrics: ${metrics.summaries.length} stroke(s)`,
		`down/up/backstop/silent: ${downs}/${ups}/${backstops}/${silentLifts}  palms blocked: ${palms}`,
		"",
		...metrics.summaries.map((s) => StrokeMetrics.summaryText(s)),
	];
	return lines.join("\n");
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
 * at `path` in whichever live editor shows it, as ONE editor-history entry,
 * so a single Ctrl+Z restores all of them with z-order intact, exactly like
 * undoing one big erase. Returns the stroke count removed, 0 when the note
 * had none, or null when no mounted editor is showing that note (the wipe
 * needs an editor's history to be undoable, so there is no store-only path).
 */
export function deleteAllInkOn(path: string): number | null {
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

class InkOverlayPlugin {
	private view: EditorView;
	private container: HTMLElement | null = null;
	private committedCanvas!: HTMLCanvasElement;
	private wetCanvas!: HTMLCanvasElement;
	private tailCanvas!: HTMLCanvasElement;
	private highlightCanvas!: HTMLCanvasElement;
	private highlightWetCanvas!: HTMLCanvasElement;
	private committedCtx!: CanvasRenderingContext2D;
	private highlightCtx!: CanvasRenderingContext2D;
	private wet!: WetInkRenderer;
	private highlightWet!: WetInkRenderer;
	private tail!: TailRenderer;
	private router: InlinePenRouter | null = null;
	private camera = new Camera();
	private penStyle: PenStyle = { ...DEFAULT_PEN };
	private highlighterStyle: PenStyle = { ...HIGHLIGHTER_PEN };
	/** Bound once at pen-down so the raw ink loop stays branch-free. */
	private activeWet!: WetInkRenderer;
	private activeStyle: PenStyle = this.penStyle;
	private builder: StrokeBuilder | null = null;

	// gesture state (one pen contact at a time; mode decided at pen-down)
	private mode: PenMode = "ink";
	private erased: Array<{ stroke: InkStroke; index: number }> = [];
	private selection = new SelectionModel();
	private readonly selectionDeleteKeys = new InlineSelectionDeleteKeys(
		() => !this.selection.isEmpty,
		() => this.deleteSelectedInk()
	);
	private lassoPts: Point2[] = [];
	private lassoActive = false;
	private dragFrom: { x: number; y: number } | null = null;
	private dragTotal: { dx: number; dy: number } | null = null;
	private penCursorEl: HTMLElement | null = null;
	private eraserEl: HTMLElement | null = null;

	private cssWidth = 0;
	private cssHeight = 0;
	private dpr = 1;
	private resizeObserver: ResizeObserver | null = null;
	private repaintQueued = false;
	private presentProbePending = false;
	private scrollFn: (() => void) | null = null;
	private wheelFn: ((e: WheelEvent) => void) | null = null;
	private hostPositionPatched = false;

	// ---- surface extent (reconstructed from the 2026-08-20 hardware build) --
	/** 1×1 invisible child of the scroller that extends its scroll range. */
	private spacer: HTMLElement | null = null;
	private spacerLeft = Number.NaN;
	private spacerTop = Number.NaN;
	private axisGuard = new ScrollAxisGuard();
	/** The `.markdown-source-view` ancestor carrying the `handwriting-page` class. */
	private pageClassHost: HTMLElement | null = null;
	/** Keeps the page-id-only Properties block class in step with Obsidian's DOM. */
	private metadataObserver: MutationObserver | null = null;
	/** Inner canvas layer the scroll-follow translate is applied to. */
	private layerEl: HTMLElement | null = null;
	/**
	 * Scroll-follow state: the baseline the current translate is measured
	 * from, and whether one is applied. Lives in its own object so the whole
	 * cycle (scroll, scroll, repaint, scroll) is unit-testable; this file
	 * cannot be instantiated without a live CodeMirror view.
	 */
	private follow = new FollowLayer();
	// Font-zoom tracking (quick font size / touchpad pinch; see ZoomScale).
	/** Live computed style of the content element; .fontSize is a cheap read. */
	private contentStyle: CSSStyleDeclaration | null = null;
	/** Editor font size at overlay mount, the fontZoom reference. */
	private refFontPx = 0;
	private lastFontStr = "";
	/** CSS-transform scale alone (visual px per layout px), fontZoom excluded. */
	private cssScale = 1;
	private fontZoom = 1;
	/** overflow-x re-checked once per resize/mount, not per repaint. */
	private axisChecked = false;
	private scrollPositionPatched = false;
	private lastReach: {
		required: number;
		scrollWidth: number;
		clientWidth: number;
		overflowX: string;
		patched: boolean;
	} | null = null;

	// Geometry stash: what syncCamera actually read this frame, kept for the
	// scroll probe so instrumentation never adds layout reads of its own.
	private lastSyncRectLeft = 0;
	private lastSyncRectTop = 0;
	private lastSyncContentLeft = 0;
	private lastSyncDocumentTop = 0;
	/** Scroll events observed while the current stroke was active. */
	private scrollsDuringStroke = 0;

	/**
	 * Presentation-probe target: the last committed stroke, anchored in NOTE
	 * space (never screen space: scrolling moves the ink's canvas position,
	 * so a screen-space target goes stale the moment anything repaints).
	 * Probes recompute the canvas/client box under the CURRENT camera and
	 * hard-gate on the committed backing actually containing pixels there.
	 */
	private lastCommitNote: { x: number; y: number; w: number; h: number } | null = null;
	private lastCommitPath: string | null = null;
	private lastCommitId = "";
	private lastCommitColor = "";
	lastCommitAt = Number.NEGATIVE_INFINITY;

	// LIVEPAINT sampler state (right-edge dead-zone diagnosis): during an
	// active ink stroke, every ~30 ms a small box around the newest SETTLED
	// wet segment is read back from the wet canvas. Zero paint while the
	// user is drawing = the rasterization never reached the backing store;
	// paint present while the glass is blank = presentation/compositor.
	/** The file this editor was last showing. Ink isolation depends on it. */
	private lastPath: string | null = null;
	/**
	 * Visual px per layout px for this editor (1 unless something applies a
	 * CSS zoom/transform). Every conversion between screen geometry and note
	 * space goes through it; see ZoomScale.ts.
	 */
	private scale = 1;
	private mediaQuery: MediaQueryList | null = null;
	private mediaFn: (() => void) | null = null;
	/**
	 * True from pen-down to pen-up. While set, syncCamera() is a no-op so the
	 * stroke's coordinate frame cannot move underneath it.
	 *
	 * Without this, any repaint that lands mid-stroke (a ResizeObserver tick,
	 * a CodeMirror geometry update, the resolution watcher) re-reads
	 * documentTop/contentLeft and rewrites the camera. Ink already drawn used
	 * the old origin and everything after it uses the new one, so the live
	 * stroke kinks by exactly the origin delta, a spatial discontinuity in
	 * the middle of a handwritten line.
	 */
	private readonly frame = new StrokeFrame();

	constructor(view: EditorView) {
		this.view = view;
		instances.add(this);
		if (enabled) this.mount();
	}

	// ---- lifecycle ----------------------------------------------------------

	/** The file behind this editor, resolved live, because Obsidian reuses editors. */
	private filePath(): string | null {
		const info = this.view.state.field(editorInfoField, false);
		return info?.file?.path ?? null;
	}

	mount(): void {
		if (this.container || !enabled) return;
		// Not a file-backed markdown editor (e.g. a bare CM instance): stay inert.
		if (this.view.state.field(editorInfoField, false) === undefined) return;

		const host = this.view.dom;
		if (getComputedStyle(host).position === "static") {
			host.setCssStyles({ position: "relative" });
			this.hostPositionPatched = true;
		}
		// The lost 2026-08-20 build carried this class (reconstruction gap,
		// found via the census counter reading 0). No stylesheet references
		// it. Restoring it is render-inert and gives diagnostics a selector.
		const container = host.createDiv({ cls: "handwriting-ink-overlay" });
		this.container = container;
		container.setCssStyles({
			position: "absolute",
			inset: "0",
			overflow: "hidden",
			pointerEvents: "none",
		});

		// Transform-follow layer (v0.13.5): the canvases sit in an inner layer
		// that scroll events TRANSLATE by the delta since the last real
		// repaint (a compositor-cheap style write), so ink stays glued to
		// the text through fast flings instead of floating at main-thread
		// repaint rate and snapping at rest. Every real repaint redraws at
		// the current camera and zeroes the translate in the same frame.
		// Camera and pointer mapping keep reading the OUTER container, which
		// never moves.
		const layer = container.createDiv({ cls: "handwriting-ink-layer" });
		this.layerEl = layer;
		layer.setCssStyles({
			position: "absolute",
			inset: "0",
			pointerEvents: "none",
			willChange: "transform",
		});

		const canvas = (): HTMLCanvasElement => {
			const c = layer.createEl("canvas");
			c.setCssStyles({
				position: "absolute",
				inset: "0",
				pointerEvents: "none",
			});
			return c;
		};
		// Highlighter layers first: on the inline surface all ink paints above
		// the Markdown (the editor owns the DOM under it), so the stacking that
		// matters is highlight-under-PEN: a highlight never dims ink lines.
		// The v0.6.0 rule is unchanged where it counts: strokes are painted
		// OPAQUE and the whole layer carries one alpha, so a highlight crossing
		// itself stays a single flat wash instead of double-blending into seams.
		this.highlightCanvas = canvas();
		this.highlightWetCanvas = canvas();
		this.highlightCanvas.setCssStyles({ opacity: String(HIGHLIGHTER_ALPHA) });
		this.highlightWetCanvas.setCssStyles({ opacity: String(HIGHLIGHTER_ALPHA) });
		this.committedCanvas = canvas();
		this.wetCanvas = canvas();
		this.tailCanvas = canvas();

		const ctx = this.committedCanvas.getContext("2d");
		const hctx = this.highlightCanvas.getContext("2d");
		if (!ctx || !hctx) {
			this.unmount();
			return;
		}
		this.committedCtx = ctx;
		this.highlightCtx = hctx;
		// Frozen pipeline: plain canvas (desynchronized: false), smoothed tail.
		this.wet = new WetInkRenderer(this.wetCanvas, INLINE_DESYNCHRONIZED);
		this.wet.smooth = true;
		this.wet.shape = true; // pen ink takes the shaped width law (InkShape)
		this.highlightWet = new WetInkRenderer(this.highlightWetCanvas, INLINE_DESYNCHRONIZED);
		this.highlightWet.smooth = true;
		this.activeWet = this.wet;
		this.tail = new TailRenderer(this.tailCanvas);

		this.penCursorEl = container.createDiv({ cls: "handwriting-pen-cursor" });
		this.penCursorEl.setAttribute("aria-hidden", "true");
		this.eraserEl = container.createDiv({ cls: "handwriting-eraser-cursor" });
		this.eraserEl.setAttribute("aria-hidden", "true");

		this.router = new InlinePenRouter(
			this.view.scrollDOM,
			container,
			{
				onPenDown: (s, ev) => this.penDown(s, ev),
				onPenHover: (s) => this.showPenCursor(s),
				onPenLeave: () => this.hidePenCursor(),
				onPenRaw: (samples, ev) => this.penRaw(samples, ev),
				onPenMove: (_ev, count) => metrics.recordEvent("move", count, 0, false),
				onPenUp: () => this.penUp(),
			},
			() => this.cssScale
		);

		this.resizeObserver = new ResizeObserver(() => this.handleResize());
		this.resizeObserver.observe(host);
		this.handleResize();

		// Hit-probe context: what note-space point and granted extent this
		// overlay would assign to a client coordinate right now.
		setHitProbeContext((clientX, clientY) => {
			if (!this.container) return null;
			const rect = this.container.getBoundingClientRect();
			const w = this.camera.screenToWorld(
				visualToNote(clientX - rect.left, this.cssScale),
				visualToNote(clientY - rect.top, this.cssScale)
			);
			const path = this.filePath();
			const granted = path ? surfaceExtents.get(path) : ZERO_EXTENT;
			return {
				noteX: w.x,
				noteY: w.y,
				scrollLeft: this.view.scrollDOM.scrollLeft,
				scrollTop: this.view.scrollDOM.scrollTop,
				grantedX: granted.x,
				grantedY: granted.y,
				scale: this.scale,
			};
		});

		this.scrollFn = () => {
			const during = this.router?.isStroking ?? false;
			if (during) this.scrollsDuringStroke++;
			// Scroll-follow: move the ink layer with the text NOW, by a
			// compositor transform, instead of leaving the canvases at their
			// old screen position until the next main-thread repaint. That
			// gap is the visible snap. The delta is layout px straight from
			// the scroller and is deliberately unscaled; see FollowLayer.
			//
			// One read of each offset, used by both the translate and the
			// probe. RC4 kept these reads behind the diagnostics switch
			// because the probe discarded them; they are load-bearing now,
			// so the switch only gates the probe call itself.
			const scroller = this.view.scrollDOM;
			const scrollLeft = scroller.scrollLeft;
			const scrollTop = scroller.scrollTop;
			this.follow.follow(this.layerEl, scrollLeft, scrollTop, this.frame.locked);
			if (diagnosticsEnabled()) {
				scrollProbeScroll(scrollLeft, scrollTop, during);
			}
			this.scheduleRepaint("scroll");
		};
		this.view.scrollDOM.addEventListener("scroll", this.scrollFn, { passive: true });
		// Log-only wheel tap on the ACTUAL trigger path of the touchpad dead
		// zone: two-finger precision-touchpad scrolling arrives here, not as
		// touch pointers. Passive + capture: sees everything, changes nothing.
		// Wholly diagnostic, so the whole body is behind the switch (RC4).
		this.wheelFn = (e: WheelEvent) => {
			if (!diagnosticsEnabled()) return;
			scrollProbeWheel(
				e,
				this.view.scrollDOM.scrollLeft,
				this.view.scrollDOM.scrollTop,
				this.router?.isStroking ?? false
			);
		};
		this.view.scrollDOM.addEventListener("wheel", this.wheelFn, {
			capture: true,
			passive: true,
		});
		this.watchResolution();
		this.lastPath = this.filePath();
		this.updateHandwritingPageClass();
		this.loadInk(this.lastPath);
	}

	/**
	 * Obsidian's Ctrl+/Ctrl- is Electron page zoom, which changes
	 * devicePixelRatio without necessarily changing anything's CSS-px size,
	 * so neither the ResizeObserver nor a CodeMirror geometry update is
	 * guaranteed to fire. This listener is: a resolution media query flips
	 * exactly when the zoom factor does. Re-arms itself for the new dpr.
	 */
	private watchResolution(): void {
		this.unwatchResolution();
		const dpr = window.devicePixelRatio || 1;
		const mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
		const fn = () => {
			this.handleResize();
			this.watchResolution();
		};
		this.mediaQuery = mq;
		this.mediaFn = fn;
		mq.addEventListener("change", fn);
	}

	private unwatchResolution(): void {
		if (this.mediaQuery && this.mediaFn) {
			this.mediaQuery.removeEventListener("change", this.mediaFn);
		}
		this.mediaQuery = null;
		this.mediaFn = null;
	}

	/** Persisted ink arrives lazily; an untouched note costs one cache lookup. */
	private loadInk(path: string | null): void {
		if (!path) return;
		runDetached(
			inlineInk.ensureLoaded(path).then((changed) => {
				if (this.filePath() === path) {
					this.updateHandwritingPageClass();
					if (changed) this.scheduleRepaint();
				}
			}),
			`load inline ink for ${path}`
		);
	}

	/**
	 * Presentation only: mark the editor chrome of a note that IS a Handwriting
	 * page (`handwriting-page` on the markdown view, for scoped CSS hooks like the
	 * backlinks divider), and mark the scroller once Handwriting has actually made
	 * it horizontally scrollable (`handwriting-hscroll`, for the visible horizontal
	 * scrollbar). Reads session state and cheap metadata; never mutates the
	 * note.
	 */
	private updateHandwritingPageClass(): void {
		if (!this.pageClassHost) {
			this.pageClassHost =
				this.view.dom.closest(".markdown-source-view") ?? this.view.dom;
			if (typeof MutationObserver !== "undefined") {
				this.metadataObserver = new MutationObserver(() => {
					if (this.pageClassHost) updateMetadataVisibility(this.pageClassHost);
				});
				this.metadataObserver.observe(this.pageClassHost, {
					childList: true,
					subtree: true,
					attributes: true,
					attributeFilter: ["data-property-key"],
				});
			}
		}
		const path = this.filePath();
		this.pageClassHost.classList.toggle(
			"handwriting-page",
			!!path && inlineInk.isHandwritingPage(path)
		);
		updateMetadataVisibility(this.pageClassHost);
	}

	unmount(): void {
		this.router?.dispose();
		this.router = null;
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		if (this.scrollFn) {
			this.view.scrollDOM.removeEventListener("scroll", this.scrollFn);
			this.scrollFn = null;
		}
		if (this.wheelFn) {
			this.view.scrollDOM.removeEventListener("wheel", this.wheelFn, { capture: true });
			this.wheelFn = null;
		}
		this.unwatchResolution();
		setHitProbeContext(null);
		this.spacer?.remove();
		this.spacer = null;
		this.spacerLeft = Number.NaN;
		this.spacerTop = Number.NaN;
		this.view.scrollDOM.classList.remove("handwriting-hscroll");
		this.metadataObserver?.disconnect();
		this.metadataObserver = null;
		if (this.pageClassHost) clearMetadataVisibility(this.pageClassHost);
		this.pageClassHost?.classList.remove("handwriting-page");
		this.pageClassHost = null;
		this.restoreScrollableAxis();
		this.axisChecked = false;
		this.lastReach = null;
		if (this.scrollPositionPatched) {
			this.view.scrollDOM.setCssStyles({ position: "" });
			this.scrollPositionPatched = false;
		}
		this.container?.remove();
		this.container = null;
		this.layerEl = null;
		this.follow.forget();
		this.builder = null;
		this.penCursorEl = null;
		this.eraserEl = null;
		this.resetGestureState();
		if (this.hostPositionPatched) {
			this.view.dom.setCssStyles({ position: "" });
			this.hostPositionPatched = false;
		}
	}

	update(u: ViewUpdate): void {
		if (!this.container) {
			if (enabled) this.mount();
			return;
		}
		// Obsidian reuses the same editor across file switches. When a
		// different note takes over, NOTHING of the previous note's ink may
		// survive on screen: drop any in-flight stroke, wipe the transient
		// layers, and repaint committed ink from the new file's store entry
		// (which clears the canvas even when that entry is empty). Without
		// this the old bitmap sat there until the next repaint trigger: the
		// v0.9.1 cross-file ink leak.
		// Ink history ops re-dispatched by the editor's undo/redo. Original
		// gestures carry the inkApplied annotation (the store already reflects
		// them); anything else is history's work and gets applied here. The op
		// carries its own path, so undo after a file switch still acts on the
		// note where the ink lives.
		for (const tr of u.transactions) {
			if (tr.annotation(inkApplied)) continue;
			for (const effect of tr.effects) {
				if (effect.is(inkEffect)) this.applyInkOp(effect.value);
			}
		}

		const path = this.filePath();
		if (path !== this.lastPath) {
			this.lastPath = path;
			this.updateHandwritingPageClass();
			this.builder = null;
			this.resetGestureState();
			this.wet.clear(this.cssWidth, this.cssHeight);
			this.highlightWet.clear(this.cssWidth, this.cssHeight);
			this.tail.clearAll(this.cssWidth, this.cssHeight);
			this.scheduleRepaint();
			this.loadInk(path);
			return;
		}
		// Reflow, resize, edits, viewport moves: committed ink repaints from
		// note-surface coordinates. Note what is NOT here: nothing repositions
		// strokes. Text edits are invisible to ink by construction.
		if (u.geometryChanged || u.viewportChanged || u.docChanged) {
			// Font-zoom edge: the quick-font-size reflow arrives here as a
			// geometry update. One string compare against a LIVE computed
			// style. No per-frame polling, no new style objects.
			if (
				u.geometryChanged &&
				this.contentStyle &&
				this.contentStyle.fontSize !== this.lastFontStr
			) {
				this.handleResize();
			}
			this.scheduleRepaint();
		}
	}

	destroy(): void {
		this.unmount();
		instances.delete(this);
	}

	handleKeyDown(event: KeyboardEvent): boolean {
		return this.selectionDeleteKeys.keydown(event);
	}

	handleKeyUp(event: KeyboardEvent): boolean {
		return this.selectionDeleteKeys.keyup(event);
	}

	/** Everything needed to identify the zoom mechanism from hardware. */
	zoomReport(): string {
		const rect = this.container?.getBoundingClientRect();
		const content = this.view.contentDOM.getBoundingClientRect();
		const cs = getComputedStyle(this.view.contentDOM);
		return [
			`file: ${this.filePath() ?? "(none)"}`,
			`devicePixelRatio: ${window.devicePixelRatio}`,
			`measured scale: ${this.scale}  (cssScale ${this.cssScale} × fontZoom ${this.fontZoom}; CM scaleX ${this.view.scaleX}, scaleY ${this.view.scaleY})`,
			`font: current ${this.lastFontStr || "(unread)"} reference ${this.refFontPx}px  camera zoom ${this.camera.zoom}`,
			`overlay rect: ${rect?.width.toFixed(2)} x ${rect?.height.toFixed(2)} (visual px)`,
			`overlay offset: ${this.container?.offsetWidth} x ${this.container?.offsetHeight} (layout px)`,
			`content rect left/width: ${content.left.toFixed(2)} / ${content.width.toFixed(2)}`,
			`content offsetWidth: ${this.view.contentDOM.offsetWidth}`,
			`content font-size / line-height: ${cs.fontSize} / ${cs.lineHeight}`,
			`documentTop: ${this.view.documentTop.toFixed(2)}  contentHeight: ${this.view.contentHeight.toFixed(2)}`,
			`canvas backing: ${this.committedCanvas?.width} x ${this.committedCanvas?.height}` +
				`  css: ${this.cssWidth.toFixed(2)} x ${this.cssHeight.toFixed(2)}`,
			`camera origin (note space): ${this.camera.x.toFixed(2)}, ${this.camera.y.toFixed(2)}`,
			`strokes on this note: ${this.filePath() ? inlineInk.strokes(this.filePath()!).length : 0}`,
		].join("\n");
	}

	/** The live overlay container, for the census's ghost detection. */
	containerEl(): Element | null {
		return this.container;
	}

	routerCounters(): {
		downs: number;
		ups: number;
		backstops: number;
		silentLifts: number;
		palms: number;
	} {
		return {
			downs: this.router?.penDowns ?? 0,
			ups: this.router?.penUps ?? 0,
			backstops: this.router?.fallbackEnds ?? 0,
			silentLifts: this.router?.silentLiftEnds ?? 0,
			palms: this.router?.palmsBlocked ?? 0,
		};
	}

	// ---- geometry -----------------------------------------------------------

	private handleResize(): void {
		if (!this.container) return;
		const rect = this.container.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) return;
		this.dpr = window.devicePixelRatio || 1;
		// The canvases live INSIDE whatever is scaled, so their coordinate
		// space is layout px, the same unit ink is stored in. Size them from
		// the untransformed box and give the backing store the extra device
		// pixels the scale demands, so ink stays crisp instead of being
		// upscaled by the compositor.
		this.cssScale = effectiveScale({
			visualWidth: rect.width,
			layoutWidth: this.container.offsetWidth,
			cmScaleX: this.view.scaleX,
		});
		// Quick-font-size zoom (Ctrl+scroll / touchpad pinch) is a reflow:
		// dpr and the transform scale both stay put while the text grows.
		// The current/mount-time font ratio is the missing zoom factor.
		this.contentStyle ??= getComputedStyle(this.view.contentDOM);
		this.lastFontStr = this.contentStyle.fontSize;
		const fontPx = Number.parseFloat(this.lastFontStr);
		if (this.refFontPx <= 0 && Number.isFinite(fontPx) && fontPx > 0) {
			this.refFontPx = fontPx;
		}
		this.fontZoom = fontZoomFactor(fontPx, this.refFontPx);
		this.scale = this.cssScale * this.fontZoom;
		const layoutW = this.container.offsetWidth || rect.width;
		const layoutH = this.container.offsetHeight || rect.height;
		// Backing resolution: device px per SCREEN css px. The font zoom is
		// GEOMETRY (applied by the camera before rasterization), not
		// resolution. Folding it in here was the part-2 bug's sibling.
		const backing = backingScale(this.dpr, this.cssScale);
		const size = computeCanvasSize(layoutW, layoutH, backing);
		this.cssWidth = size.cssW;
		this.cssHeight = size.cssH;
		for (const c of [
			this.committedCanvas,
			this.wetCanvas,
			this.tailCanvas,
			this.highlightCanvas,
			this.highlightWetCanvas,
		]) {
			c.width = size.backingW;
			c.height = size.backingH;
			c.setCssStyles({ width: `${size.cssW}px`, height: `${size.cssH}px` });
		}
		this.committedCtx.setTransform(backing, 0, 0, backing, 0, 0);
		this.highlightCtx.setTransform(backing, 0, 0, backing, 0, 0);
		this.wet.applyDpr(backing);
		this.highlightWet.applyDpr(backing);
		this.tail.applyDpr(backing);
		this.router?.refreshRect();
		this.syncFollowLayer();
		this.axisChecked = false;
		this.scheduleRepaint("resize");
	}

	/**
	 * Pin the camera so world == note surface: the camera holds the surface
	 * point currently at the overlay's top-left. `documentTop` is CM's public
	 * "top of the document in screen coordinates", so this is two subtractions.
	 * No scrollTop bookkeeping; padding is handled by CM.
	 */
	private syncCamera(): void {
		if (!this.container) return;
		// A stroke in flight owns its coordinate frame until it ends.
		if (this.frame.locked) return;
		const overlay = this.container.getBoundingClientRect();
		const contentLeft = this.view.contentDOM.getBoundingClientRect().left;
		const documentTop = this.view.documentTop;
		// Stashed for the scroll probe: read once, here, never re-read there.
		this.lastSyncRectLeft = overlay.left;
		this.lastSyncRectTop = overlay.top;
		this.lastSyncContentLeft = contentLeft;
		this.lastSyncDocumentTop = documentTop;
		// Both reads are visual px; the difference becomes note space by
		// dividing out the scale. At scale 1 this is arithmetically identical
		// to what shipped, so persisted coordinates keep their meaning.
		// Both reads are visual px. The camera origin is the overlay's WORLD
		// coordinate, so the division is by the TOTAL factor (cssScale × font
		// zoom). The font zoom itself rides on the camera as a real zoom:
		// worldToScreen multiplies by it, screenToWorld divides by it, so the
		// forward and inverse transforms are inverses by construction.
		this.camera.setState(
			visualToNote(overlay.left - contentLeft, this.scale),
			visualToNote(overlay.top - documentTop, this.scale),
			this.fontZoom
		);
	}

	// ---- pen path (frozen pipeline) ----------------------------------------

	private penDown(sample: PenSample, ev: PointerEvent): void {
		// The router cancels pointerdown so the pen cannot move CodeMirror's
		// caret. That also cancels native focus. Give keyboard ownership back to
		// this editor before freezing geometry, or Delete and undo go wherever
		// focus happened to be before the pen landed.
		focusClaimedPenEditor(this.view);
		this.hidePenCursor();
		// The only layout reads on the whole stroke happen here, once. From
		// here the frame is frozen until pen-up.
		this.frame.end();
		this.syncCamera();
		// Before anything freezes: if a scroll translate is still applied,
		// settle it against the camera we just synced.
		this.reconcileFollowLayer();
		this.router?.refreshRect();
		this.frame.begin();
		if (isPenProbeEnabled()) this.captureProbeGeometry();
		this.recordPenDownState(sample);

		// The pen decides what it is at contact (§52/§53, mode-free):
		// eraser end erases, barrel held lassos/moves, tip inks.
		const eraser = (ev.buttons & 32) !== 0 || ev.button === 5;
		const barrel = !eraser && (ev.buttons & 2) !== 0;
		if (barrel) {
			this.mode = "lasso";
			this.lassoDown(sample);
			return;
		}
		// Tip and eraser return the pen to normal behavior: selection dissolves.
		if (this.selection.clear()) this.redrawSelectionUI();
		if (eraser) {
			this.mode = "erase";
			this.erased = [];
			metrics.begin("erase", performance.now());
			this.showEraserCursor(sample);
			this.eraseAt(sample);
			return;
		}
		this.mode = "ink";
		metrics.begin("ink", performance.now());
		// Bind the nib once: the raw loop never asks which tool is active.
		const tool = inlineTool;
		this.activeStyle = tool === "highlighter" ? this.highlighterStyle : this.penStyle;
		// Nib size and color: bound per stroke from the current selection.
		// The stroke stores both, so later selection changes never touch it.
		this.activeStyle.baseWidth =
			(tool === "highlighter" ? HIGHLIGHTER_PEN.baseWidth : DEFAULT_PEN.baseWidth) *
			getInkSizeMult(tool);
		this.activeStyle.color = getInkColorHex(tool);
		this.activeWet = tool === "highlighter" ? this.highlightWet : this.wet;
		this.builder = new StrokeBuilder(tool, this.activeStyle.color, this.activeStyle.baseWidth);
		this.builder.start(sample.timestamp);
		const w = this.camera.screenToWorld(sample.x, sample.y);
		const point = this.builder.add(
			w.x,
			w.y,
			normalizeInlinePenPressure(sample.pressure),
			sample.timestamp,
			sample.tiltX,
			sample.tiltY
		);
		if (point) {
			this.activeWet.beginStroke(point, this.activeStyle);
			// A tap that never moves produces no rawupdate, so without this the
			// dot only appears at pen-up. Draw the contact point immediately.
			this.tail.clear();
			this.tail.drawHead(
				this.camera.snapshot,
				this.activeStyle,
				{ x: point.x, y: point.y },
				{ x: point.x, y: point.y },
				point.pressure
			);
			this.probeSample(sample, ev, point, 1, true, "down");
		}
		noteProbeStroke();
	}

	private penRaw(samples: PenSample[], ev: PointerEvent): void {
		if (this.mode === "lasso") {
			this.lassoMove(samples);
			return;
		}
		if (this.mode === "erase") {
			for (const s of samples) this.eraseAt(s);
			const last = samples[samples.length - 1];
			if (last) this.showEraserCursor(last);
			return;
		}
		if (!this.builder || samples.length === 0) return;
		const t0 = performance.now();
		metrics.recordEvent("raw", samples.length, t0 - ev.timeStamp, true);
		const cam = this.camera.snapshot;
		const drawStart = performance.now();
		let accepted = 0;
		let lastAccepted: { x: number; y: number } | undefined;
		for (const s of samples) {
			const w = this.camera.screenToWorld(s.x, s.y);
			const point = this.builder.add(
				w.x,
				w.y,
				normalizeInlinePenPressure(s.pressure),
				s.timestamp,
				s.tiltX,
				s.tiltY
			);
			if (point) {
				this.activeWet.appendPoint(cam, this.activeStyle, point);
				lastAccepted = point;
				accepted++;
			}
		}
		const drawEnd = performance.now();
		const newestTs = samples[samples.length - 1]!.timestamp;
		metrics.recordAccepted(accepted);
		metrics.recordDraw(drawEnd - drawStart, drawEnd - newestTs);

		// Live raw head, exactly as the approved pipeline draws it.
		this.tail.clear();
		const head = this.activeWet.head();
		if (head) this.tail.drawHead(cam, this.activeStyle, head.from, head.to, head.pressure);
		// Probe AFTER the head is drawn: `head()` is then exactly the geometry
		// on screen, so the recorded endpoint is the rendered endpoint.
		if (isPenProbeEnabled()) {
			const newest = samples[samples.length - 1]!;
			this.probeSample(
				newest,
				ev,
				lastAccepted,
				samples.length,
				lastAccepted !== undefined,
				samples.length > 1 ? "coalesced" : "rawupdate"
			);
		}
		this.schedulePresentProbe(newestTs);
	}

	private schedulePresentProbe(newestTs: number): void {
		if (this.presentProbePending) return;
		this.presentProbePending = true;
		window.requestAnimationFrame(() => {
			this.presentProbePending = false;
			metrics.recordPresent(performance.now() - newestTs);
		});
	}

	/**
	 * What syncCamera WOULD produce right now, without touching the camera.
	 * Read-only diagnostic twin of syncCamera: while frameLocked freezes the
	 * stroke's frame, the difference between this and the live camera is the
	 * exact on-screen displacement of the ink layer relative to the document.
	 */
	private freshFrame(): { x: number; y: number } | null {
		if (!this.container) return null;
		const overlay = this.container.getBoundingClientRect();
		const contentLeft = this.view.contentDOM.getBoundingClientRect().left;
		return {
			x: visualToNote(overlay.left - contentLeft, this.scale),
			y: visualToNote(overlay.top - this.view.documentTop, this.scale),
		};
	}

	/** One scroll-probe row per acquisition: everything the mapping read. */
	private recordPenDownState(sample: PenSample): void {
		this.scrollsDuringStroke = 0;
		if (!diagnosticsEnabled()) return;
		const scroller = this.view.scrollDOM;
		const w = this.camera.screenToWorld(sample.x, sample.y);
		scrollProbePenDown({
			clientX: this.lastSyncRectLeft + noteToVisual(sample.x, this.cssScale),
			clientY: this.lastSyncRectTop + noteToVisual(sample.y, this.cssScale),
			noteX: w.x,
			noteY: w.y,
			scrollLeft: scroller.scrollLeft,
			scrollTop: scroller.scrollTop,
			rectLeft: this.lastSyncRectLeft,
			rectTop: this.lastSyncRectTop,
			cssW: this.cssWidth,
			cssH: this.cssHeight,
			camX: this.camera.x,
			camY: this.camera.y,
			scale: this.scale,
			spacerLeft: this.spacerLeft,
			spacerTop: this.spacerTop,
			axisPatched: this.axisGuard.patched,
			scrollWidth: scroller.scrollWidth,
			scrollHeight: scroller.scrollHeight,
			clientWidth: scroller.clientWidth,
			clientHeight: scroller.clientHeight,
		});
	}

	private penUp(): void {
		// Whatever the gesture was, it is over: the frame is live again and
		// re-reads the editor's current origin.
		this.frame.end();
		if (this.mode === "lasso") {
			this.mode = "ink";
			this.lassoUp();
			this.updateExtent();
			return;
		}
		if (this.mode === "erase") {
			this.mode = "ink";
			metrics.end(performance.now());
			this.hideEraserCursor();
			const erased = this.erased;
			this.erased = [];
			const path = this.filePath();
			if (erased.length === 0 || !path) return;
			// One persist per gesture, at pen-up. Never on the erase hot path.
			inlineInk.save(path);
			this.dispatchInk({
				type: "remove",
				path,
				strokes: erased.map((e) => e.stroke),
				indices: erased.map((e) => e.index),
			});
			this.repaintPath(path);
			return;
		}
		metrics.end(performance.now());
		const builder = this.builder;
		this.builder = null;
		// Finish before clearing the wet layer. Release filtering may produce
		// several stored strokes from one contact, but every committed segment
		// is drawn underneath the still-visible wet pixels before they clear.
		const strokes = builder?.finishReleaseFiltered() ?? [];
		const stroke = strokes.at(-1);
		const path = stroke ? this.filePath() : null;
		// Paint ground truth, part 1: was the WET ink actually in the backing
		// store? Sampled over the stroke's screen bbox (clamped to canvas).
		let wetPx = -1;
		let sample = { x: 0, y: 0, w: 0, h: 0, clippedPct: 0 };
		if (diagnosticsEnabled() && stroke && path) {
			sample = this.strokeScreenSample(stroke);
			wetPx = this.activeWet.countPainted(
				sample.x,
				sample.y,
				sample.w,
				sample.h,
				backingScale(this.dpr, this.cssScale)
			);
		}
		if (!stroke || !path) {
			this.activeWet.clear(this.cssWidth, this.cssHeight);
			this.tail.clearAll(this.cssWidth, this.cssHeight);
			return;
		}
		handoffFinishedStroke({
			store: () => {
				inlineInk.commitGesture(path, strokes);
				this.updateHandwritingPageClass();
			},
			// Paint underneath the still-visible wet layer. Long strokes can take
			// long enough to flatten that clearing the desynchronized wet canvas
			// first produces a visible blank frame, especially over Moonlight.
			drawCommitted: () => {
				for (const finished of strokes) {
					drawStroke(
						this.committedCtxFor(finished.tool),
						this.camera.snapshot,
						finished,
						undefined,
						true
					);
				}
			},
			clearTransient: () => {
				this.activeWet.clear(this.cssWidth, this.cssHeight);
				this.tail.clearAll(this.cssWidth, this.cssHeight);
			},
			publishHistory: () => this.dispatchInk({ type: "add", path, strokes }),
		});
		// Diagnostics (explicitly enabled only): paint ground truth part 2
		// (did the commit draw reach the committed backing store?), plus the
		// frame-desync measure and the COMMIT trace row. Ordinary writing
		// skips every readback and layout read in this block.
		if (diagnosticsEnabled()) this.recordCommitDiagnostics(stroke, path, wetPx, sample);
		this.scrollsDuringStroke = 0;
		// Presentation-probe target: NOTE-space bbox (pen-width padded) plus
		// identity, so later probes can re-locate the ink under whatever
		// camera is current and verify the backing before judging anything.
		const pad = 4;
		this.lastCommitNote = {
			x: stroke.bbox.x - pad,
			y: stroke.bbox.y - pad,
			w: stroke.bbox.width + pad * 2,
			h: stroke.bbox.height + pad * 2,
		};
		this.lastCommitPath = path;
		this.lastCommitId = stroke.id;
		this.lastCommitColor = stroke.color;
		this.lastCommitAt = performance.now();
		// A second pane on the same note shows the new ink too.
		this.repaintPath(path);
		this.updateExtent();
	}

	/**
	 * The last committed stroke's box under the CURRENT camera, clamped to
	 * the canvas. Null when there is no target or it left the viewport.
	 */
	private currentTargetBox(): { canvas: ProbeBox; client: ProbeBox } | null {
		if (!this.lastCommitNote || !this.container) return null;
		const n = this.lastCommitNote;
		const z = this.camera.zoom;
		const sx = (n.x - this.camera.x) * z;
		const sy = (n.y - this.camera.y) * z;
		const x = Math.max(0, sx);
		const y = Math.max(0, sy);
		const w = Math.min(this.cssWidth, sx + n.w * z) - x;
		const h = Math.min(this.cssHeight, sy + n.h * z) - y;
		if (w <= 0 || h <= 0) return null;
		return {
			canvas: { x, y, w, h },
			client: {
				x: this.lastSyncRectLeft + noteToVisual(x, this.cssScale),
				y: this.lastSyncRectTop + noteToVisual(y, this.cssScale),
				w: noteToVisual(w, this.cssScale),
				h: noteToVisual(h, this.cssScale),
			},
		};
	}

	/** Region census at the last commit's current screen box. */
	censusReport(liveContainers: Element[]): string | null {
		const t = this.currentTargetBox();
		if (!t || !this.container) return null;
		const b = t.client;
		// Pad a little so near-miss overlays are listed too.
		return regionCensus(
			{ x: b.x - 8, y: b.y - 8, w: b.w + 16, h: b.h + 16 },
			this.container,
			liveContainers
		);
	}

	/**
	 * Composited frame vs committed backing, note-anchored. HARD VALIDITY
	 * GATE: no verdict unless the committed backing contains pixels at the
	 * target at the moment of capture.
	 */
	async presentationReport(): Promise<string | null> {
		if (!this.lastCommitNote) return null;
		const header = `Handwriting presentation capture: stroke ${this.lastCommitId.slice(0, 8)}, committed ${((performance.now() - this.lastCommitAt) / 1000).toFixed(1)}s ago, note box (${this.lastCommitNote.x.toFixed(0)},${this.lastCommitNote.y.toFixed(0)} ${this.lastCommitNote.w.toFixed(0)}x${this.lastCommitNote.h.toFixed(0)})`;
		if (this.filePath() !== this.lastCommitPath) {
			return `${header}\nINVALID: this pane no longer shows ${this.lastCommitPath ?? "(unknown)"}; no verdict.`;
		}
		const t = this.currentTargetBox();
		if (!t) {
			return `${header}\nINVALID: target is outside the viewport under the current camera (scroll it into view and rerun); no verdict.`;
		}
		const backingNow = countPaintedPixels(
			this.committedCtx,
			t.canvas.x,
			t.canvas.y,
			t.canvas.w,
			t.canvas.h,
			backingScale(this.dpr, this.cssScale)
		);
		if (backingNow <= 0) {
			return `${header}\nINVALID: committed backing has ${backingNow === 0 ? "no pixels" : "unreadable pixels"} at the recomputed target (canvas box ${t.canvas.x.toFixed(0)},${t.canvas.y.toFixed(0)} ${t.canvas.w.toFixed(0)}x${t.canvas.h.toFixed(0)}); no verdict. A repaint may not have run since a camera move. Nudge scroll by one notch and rerun.`;
		}
		const inkRGB = parseHexColor(this.lastCommitColor);
		const cap = await capturePresented(t.client, inkRGB);
		const inkPresent = inkRGB ? cap.inkMatchedPx > 0 : cap.presentedPx > 0;
		const verdict = !cap.ok
			? "NO VERDICT: capture unavailable; census + eyes remain the instruments"
			: !inkPresent
				? "*** VERDICT: BACKING HAS INK, COMPOSITED FRAME DOES NOT. The compositor dropped the layer content (or an exact-background occluder; cross-check census). ***"
				: "*** VERDICT: COMPOSITED FRAME CONTAINS THE INK. If the glass still shows nothing, the loss is BELOW the compositor (DComp/DWM presentation). ***";
		return [
			header,
			`target (current camera)   : canvas (${t.canvas.x.toFixed(0)},${t.canvas.y.toFixed(0)} ${t.canvas.w.toFixed(0)}x${t.canvas.h.toFixed(0)})  client (${t.client.x.toFixed(0)},${t.client.y.toFixed(0)} ${t.client.w.toFixed(0)}x${t.client.h.toFixed(0)})`,
			`committed backing (now)   : ${backingNow} painted px  (VALID target)`,
			`composited frame (capture): ${cap.presentedPx} / ${cap.sampledPx} non-background px, ${cap.inkMatchedPx} matching the stroke's own color ${this.lastCommitColor || "(unknown)"}`,
			`capture detail            : ${cap.detail}`,
			verdict,
		].join("\n");
	}

	/**
	 * The stroke's screen-space bbox (camera frame, CSS px), padded by the
	 * pen width and clamped to the canvas. `clippedPct` is how much of the
	 * padded bbox fell OUTSIDE the canvas, a direct measure of edge
	 * clipping at the viewport boundary.
	 */
	/** Diagnostics-only (explicitly enabled): commit readback + COMMIT row. */
	private recordCommitDiagnostics(
		stroke: InkStroke,
		path: string,
		wetPx: number,
		sample: { x: number; y: number; w: number; h: number; clippedPct: number }
	): void {
		// Paint ground truth, part 2: did the commit draw reach the committed
		// backing store?
		const committedPx = countPaintedPixels(
			this.committedCtxFor(stroke.tool),
			sample.x,
			sample.y,
			sample.w,
			sample.h,
			backingScale(this.dpr, this.cssScale)
		);
		// Frame-desync measure: the stroke was committed with the PEN-DOWN
		// camera; if the scroller moved during the stroke, a fresh frame
		// differs by exactly the visible snap-back distance.
		const fresh = this.freshFrame();
		scrollProbeCommit({
			strokeId: stroke.id,
			points: stroke.points.length,
			bboxX: stroke.bbox.x,
			bboxY: stroke.bbox.y,
			bboxW: stroke.bbox.width,
			bboxH: stroke.bbox.height,
			visible: bboxVisibleInViewport(
				stroke.bbox,
				this.camera.snapshot,
				this.cssWidth / this.camera.zoom,
				this.cssHeight / this.camera.zoom
			),
			storeCount: inlineInk.strokes(path).length,
			camX: this.camera.x,
			camY: this.camera.y,
			scrollLeft: this.view.scrollDOM.scrollLeft,
			scrollTop: this.view.scrollDOM.scrollTop,
			driftX: fresh ? fresh.x - this.camera.x : 0,
			driftY: fresh ? fresh.y - this.camera.y : 0,
			scrollsDuring: this.scrollsDuringStroke,
			wetPx,
			committedPx,
			sampleW: sample.w,
			sampleH: sample.h,
			clippedPct: sample.clippedPct,
			topEl: this.topElementAtStroke(sample),
		});
	}

	private strokeScreenSample(stroke: InkStroke): {
		x: number;
		y: number;
		w: number;
		h: number;
		clippedPct: number;
	} {
		const pad = 4;
		const z = this.camera.zoom;
		const sx = (stroke.bbox.x - this.camera.x) * z - pad;
		const sy = (stroke.bbox.y - this.camera.y) * z - pad;
		const sw = stroke.bbox.width * z + pad * 2;
		const sh = stroke.bbox.height * z + pad * 2;
		const x = Math.max(0, sx);
		const y = Math.max(0, sy);
		const w = Math.min(this.cssWidth, sx + sw) - x;
		const h = Math.min(this.cssHeight, sy + sh) - y;
		const fullArea = sw * sh;
		const clampedArea = Math.max(0, w) * Math.max(0, h);
		return {
			x,
			y,
			w: Math.max(0, w),
			h: Math.max(0, h),
			clippedPct: fullArea > 0 ? 1 - clampedArea / fullArea : 0,
		};
	}

	/** Top hit-testable element at the stroke sample's center, at commit. */
	private topElementAtStroke(sample: { x: number; y: number; w: number; h: number }): string {
		const cx = this.lastSyncRectLeft + noteToVisual(sample.x + sample.w / 2, this.cssScale);
		const cy = this.lastSyncRectTop + noteToVisual(sample.y + sample.h / 2, this.cssScale);
		try {
			return describeEl(document.elementFromPoint(cx, cy));
		} catch {
			return "(err)";
		}
	}

	// ---- pen probe (spatial/latency diagnosis) --------------------------------

	private captureProbeGeometry(): void {
		const rect = this.container?.getBoundingClientRect();
		setProbeGeometry({
			rectLeft: rect?.left ?? 0,
			rectTop: rect?.top ?? 0,
			scale: this.cssScale,
			dpr: this.dpr,
			backing: backingScale(this.dpr, this.cssScale),
			canvasCssW: this.cssWidth,
			canvasCssH: this.cssHeight,
			canvasBackingW: this.committedCanvas?.width ?? 0,
			canvasBackingH: this.committedCanvas?.height ?? 0,
			camX: this.camera.x,
			camY: this.camera.y,
			camZoom: this.camera.zoom,
			contentLeft: this.view.contentDOM.getBoundingClientRect().left,
			documentTop: this.view.documentTop,
			desynchronizedRequested: this.wet?.requested ?? false,
			desynchronizedActual: String(this.wet?.actualDesynchronized),
		});
	}

	/**
	 * Record the newest sample's full chain, and map the DRAWN endpoint back
	 * out to client space so the round-trip error is measured against the real
	 * transforms rather than asserted.
	 */
	private probeSample(
		sample: PenSample,
		ev: PointerEvent,
		point: { x: number; y: number } | undefined,
		coalesced: number,
		accepted: boolean,
		source: "down" | "rawupdate" | "coalesced"
	): void {
		if (!isPenProbeEnabled()) return;
		const rect = this.container?.getBoundingClientRect();
		if (!rect) return;
		const head = this.activeWet?.head();
		// The endpoint actually submitted for drawing. Falls back to the
		// accepted point when the head has not formed yet (first sample).
		const headX = head?.to.x ?? point?.x ?? 0;
		const headY = head?.to.y ?? point?.y ?? 0;
		// …mapped back out through the production camera + scale.
		const screen = this.camera.worldToScreen(headX, headY);
		const backX = rect.left + noteToVisual(screen.x, this.cssScale);
		const backY = rect.top + noteToVisual(screen.y, this.cssScale);
		const noteWorld = this.camera.screenToWorld(sample.x, sample.y);
		// Where the raw pointer itself maps to, for the tip-gap measure.
		const rawScreen = this.camera.worldToScreen(noteWorld.x, noteWorld.y);
		const rawBackX = rect.left + noteToVisual(rawScreen.x, this.cssScale);
		const rawBackY = rect.top + noteToVisual(rawScreen.y, this.cssScale);
		recordProbe({
			at: performance.now(),
			source,
			clientX: ev.clientX,
			clientY: ev.clientY,
			eventTs: ev.timeStamp,
			deliveryAgeMs: performance.now() - ev.timeStamp,
			coalesced,
			accepted,
			noteX: noteWorld.x,
			noteY: noteWorld.y,
			headX,
			headY,
			backX,
			backY,
			// Round-trip fidelity of the raw pointer through every transform.
			errPx: Math.hypot(rawBackX - ev.clientX, rawBackY - ev.clientY),
			// How far the drawn tip sits behind the raw pointer.
			tipGapPx: Math.hypot(backX - ev.clientX, backY - ev.clientY),
		});
		markMappedTip(backX, backY);
	}

	// ---- eraser (canvas semantics: whole-stroke, hit-circle, live) -----------

	private showPenCursor(sample: PenSample): void {
		if (!this.penCursorEl) return;
		this.view.scrollDOM.classList.add(PEN_HOVER_CLASS);
		const tool = inlineTool;
		const strokeWidth =
			(tool === "highlighter" ? HIGHLIGHTER_PEN.baseWidth : DEFAULT_PEN.baseWidth) *
			getInkSizeMult(tool);
		const cursor = penCursorLayout({
			x: sample.x,
			y: sample.y,
			strokeWidth,
			cameraZoom: this.camera.zoom,
			cssScale: this.cssScale,
		});
		this.penCursorEl.setCssStyles({
			display: "",
			width: `${cursor.diameter}px`,
			height: `${cursor.diameter}px`,
			transform: `translate(${cursor.x}px, ${cursor.y}px)`,
			backgroundColor: getInkColorHex(tool),
			opacity: tool === "highlighter" ? String(HIGHLIGHTER_ALPHA) : "0.9",
		});
	}

	private hidePenCursor(): void {
		this.view.scrollDOM.classList.remove(PEN_HOVER_CLASS);
		if (this.penCursorEl) this.penCursorEl.setCssStyles({ display: "none" });
	}

	private eraseAt(sample: PenSample): void {
		const path = this.filePath();
		if (!path) return;
		const w = this.camera.screenToWorld(sample.x, sample.y);
		const hits = strokesHitByCircle(
			inlineInk.strokes(path),
			w.x,
			w.y,
			visualToNote(ERASER_SCREEN_R, this.scale)
		);
		if (hits.length === 0) return;
		this.erased.push(...inlineInk.takeLive(path, hits));
		// Batched to the next frame, exactly like the canvas eraser.
		this.scheduleRepaint();
		this.repaintPath(path);
	}

	private showEraserCursor(sample: PenSample): void {
		if (!this.eraserEl) return;
		// Screen-space element: convert the visual constant with cssScale
		// only (samples are screen css px).
		const r = visualToNote(ERASER_SCREEN_R, this.cssScale);
		this.eraserEl.setCssStyles({
			display: "",
			width: `${r * 2}px`,
			height: `${r * 2}px`,
			transform: `translate(${sample.x - r}px, ${sample.y - r}px)`,
		});
	}

	private hideEraserCursor(): void {
		if (this.eraserEl) this.eraserEl.setCssStyles({ display: "none" });
	}

	// ---- lasso / move (barrel held; §52/§53, ink-only on the inline surface) --

	private strokesHere(): readonly InkStroke[] {
		const path = this.filePath();
		return path ? inlineInk.strokes(path) : [];
	}

	private selectionBounds(): BBox | null {
		return this.selection.bounds(this.strokesHere(), () => null, () => null);
	}

	private lassoDown(sample: PenSample): void {
		const w = this.camera.screenToWorld(sample.x, sample.y);
		const bounds = this.selectionBounds();
		// Landing inside an existing selection moves it; anywhere else lassos.
		if (
			bounds &&
			pointInBBox(w.x, w.y, padBBox(bounds, visualToNote(SELECTION_GRAB_PAD, this.scale)))
		) {
			this.dragFrom = { x: w.x, y: w.y };
			this.dragTotal = { dx: 0, dy: 0 };
			return;
		}
		this.selection.clear();
		this.lassoActive = true;
		this.lassoPts = [w];
		this.redrawSelectionUI();
	}

	private lassoMove(samples: PenSample[]): void {
		const last = samples[samples.length - 1];
		if (!last) return;

		if (this.dragFrom && this.dragTotal) {
			const path = this.filePath();
			if (!path) return;
			const w = this.camera.screenToWorld(last.x, last.y);
			const dx = w.x - this.dragFrom.x;
			const dy = w.y - this.dragFrom.y;
			// Live drag only translates coordinates in the store; the history
			// op is pushed once at release, with the id list frozen there.
			inlineInk.moveStrokes(path, this.selection.strokeIds, dx, dy);
			this.dragTotal.dx += dx;
			this.dragTotal.dy += dy;
			this.dragFrom = w;
			this.scheduleRepaint();
			this.repaintPath(path);
			this.redrawSelectionUI();
			return;
		}

		if (!this.lassoActive) return;
		const minStep = visualToNote(LASSO_MIN_STEP_PX, this.scale);
		for (const sample of samples) {
			const p = this.camera.screenToWorld(sample.x, sample.y);
			const prev = this.lassoPts[this.lassoPts.length - 1];
			if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) >= minStep) {
				this.lassoPts.push(p);
			}
		}
		this.redrawSelectionUI();
	}

	private lassoUp(): void {
		if (this.dragTotal) {
			const { dx, dy } = this.dragTotal;
			this.dragFrom = null;
			this.dragTotal = null;
			const path = this.filePath();
			if (path && (dx !== 0 || dy !== 0)) {
				// The op freezes WHICH strokes moved. An old move must never
				// later act on whatever happens to be selected.
				const strokeIds = [...this.selection.strokeIds];
				inlineInk.save(path);
				this.dispatchInk({ type: "move", path, strokeIds, dx, dy });
			}
			this.redrawSelectionUI();
			return;
		}
		this.lassoActive = false;
		this.selection.selectByLasso(this.lassoPts, this.strokesHere(), [], () => null);
		this.lassoPts = [];
		this.redrawSelectionUI();
	}

	private redrawSelectionUI(): void {
		if (!this.tail) return;
		this.tail.clearAll(this.cssWidth, this.cssHeight);
		const cam = this.camera.snapshot;
		if (this.lassoActive && this.lassoPts.length > 1) {
			this.tail.drawLasso(cam, this.lassoPts, SELECTION_COLOR);
		}
		const bounds = this.selectionBounds();
		if (bounds) this.tail.drawSelectionBox(cam, bounds, SELECTION_COLOR);
	}

	private resetGestureState(): void {
		// Lifecycle rule (v0.13.6 fix): every gesture-state reset releases the
		// stroke frame lock. File switch and unmount reach here mid-stroke;
		// leaving the lock held froze the NEXT note's camera and repaints
		// until its first pen-down. A cancelled frame never leaks forward.
		this.frame.cancel();
		this.builder = null;
		this.mode = "ink";
		this.erased = [];
		this.selection.clear();
		this.lassoPts = [];
		this.lassoActive = false;
		this.dragFrom = null;
		this.dragTotal = null;
		this.selectionDeleteKeys.reset();
		this.hidePenCursor();
		this.hideEraserCursor();
	}

	// ---- history --------------------------------------------------------------

	/**
	 * Wipe every committed stroke on this editor's note as ONE undoable
	 * history op (the delete-all command). Same machinery as an erase: the
	 * store change is applied directly, the op captures the full strokes and
	 * indices, and undo restores everything in original z-order. The caller
	 * (main.ts) has already made the .handwriting/trash/ safety copy.
	 */
	clearAllInk(path: string): number | null {
		if (this.filePath() !== path) return null;
		const strokes = [...inlineInk.strokes(path)];
		if (strokes.length === 0) return 0;
		const indices = strokes.map((_, i) => i);
		inlineInk.applyRemove(
			path,
			strokes.map((s) => s.id)
		);
		this.dispatchInk({ type: "remove", path, strokes, indices });
		this.selection.clear();
		this.scheduleRepaint();
		this.repaintPath(path);
		return strokes.length;
	}

	/** Delete the current lasso selection as one normal editor-history step. */
	private deleteSelectedInk(): void {
		const path = this.filePath();
		if (!path) return;
		const op = removeSelectedInlineStrokes(inlineInk, path, this.selection.strokeIds);
		this.selection.clear();
		this.redrawSelectionUI();
		if (!op) return;
		this.dispatchInk(op);
		this.scheduleRepaint();
		this.repaintPath(path);
	}

	/**
	 * Record a finished gesture in the EDITOR's history, so plain Ctrl+Z /
	 * Redo covers ink in chronological order with text edits. The store
	 * already reflects the gesture (inkApplied), and isolateHistory keeps
	 * each gesture its own undo step; strokes never merge into one entry.
	 */
	private dispatchInk(op: InkOp): void {
		try {
			this.view.dispatch({
				effects: inkEffect.of(op),
				annotations: [inkApplied.of(true), isolateHistory.of("full")],
			});
		} catch (err) {
			console.error("[handwriting] ink history dispatch failed", err);
		}
	}

	/** Undo/redo handed us an op: apply it to the store and persist. */
	private applyInkOp(op: InkOp): void {
		switch (op.type) {
			case "add":
				inlineInk.applyAdd(op.path, op.strokes, op.indices);
				break;
			case "remove":
				inlineInk.applyRemove(op.path, op.strokes.map((s) => s.id));
				break;
			case "move":
				inlineInk.moveStrokes(op.path, op.strokeIds, op.dx, op.dy);
				inlineInk.save(op.path);
				break;
		}
		const current = this.filePath();
		if (current === op.path) {
			this.selection.prune(
				new Set(inlineInk.strokes(current).map((s) => s.id)),
				new Set(),
				new Set()
			);
		}
		this.scheduleRepaint();
		this.repaintPath(op.path);
	}

	/** Repaint every OTHER pane showing this note (ink belongs to the note). */
	private repaintPath(path: string): void {
		for (const p of instances) {
			if (p !== this && p.filePath() === path) p.scheduleRepaint();
		}
	}

	// ---- committed repaint --------------------------------------------------

	scheduleRepaint(via = "other"): void {
		if (this.repaintQueued || !this.container) return;
		this.repaintQueued = true;
		scrollProbeSchedule(via);
		window.requestAnimationFrame(() => {
			this.repaintQueued = false;
			this.repaint();
		});
	}

	/** The committed layer a finished stroke belongs to. */
	private committedCtxFor(tool: InkTool): CanvasRenderingContext2D {
		return tool === "highlighter" ? this.highlightCtx : this.committedCtx;
	}

	private repaint(): void {
		if (!this.container) return;
		if ((window.devicePixelRatio || 1) !== this.dpr) {
			this.handleResize();
			return;
		}
		this.syncCamera();
		const path = this.filePath();
		const strokes = path ? inlineInk.strokes(path) : [];
		drawCommitted(
			this.highlightCtx,
			this.camera.snapshot,
			strokes,
			this.cssWidth,
			this.cssHeight,
			true,
			"highlighter"
		);
		drawCommitted(
			this.committedCtx,
			this.camera.snapshot,
			strokes,
			this.cssWidth,
			this.cssHeight,
			true,
			"pen"
		);
		// Selection chrome lives in world coordinates: scrolling and reflow
		// repaint it at the strokes' current position.
		if (!this.selection.isEmpty || this.lassoActive) this.redrawSelectionUI();
		// While a stroke is active this repaint ran with the LOCKED pen-down
		// camera (syncCamera above was a no-op); measure how far that frame
		// has diverged from a fresh read: the ink layer's on-screen error.
		if (diagnosticsEnabled()) {
			let driftX = 0;
			let driftY = 0;
			if (this.frame.locked) {
				const fresh = this.freshFrame();
				if (fresh) {
					driftX = fresh.x - this.camera.x;
					driftY = fresh.y - this.camera.y;
				}
			}
			scrollProbeRepaint({
				camX: this.camera.x,
				camY: this.camera.y,
				documentTop: this.lastSyncDocumentTop,
				contentLeft: this.lastSyncContentLeft,
				rectLeft: this.lastSyncRectLeft,
				rectTop: this.lastSyncRectTop,
				scale: this.scale,
				scrollLeft: this.view.scrollDOM.scrollLeft,
				scrollTop: this.view.scrollDOM.scrollTop,
				strokesDrawn: strokes.length,
				locked: this.frame.locked,
				driftX,
				driftY,
			});
		}
		this.syncFollowLayer();
		this.updateExtent();
	}

	/**
	 * Repaint just redrew committed ink at the CURRENT camera: make that the
	 * follow baseline and zero any scroll-follow translate in the same frame,
	 * so the style reset and the redrawn pixels land together. Skipped while
	 * a stroke owns the frame (its camera is frozen; scrollFn does not
	 * translate then either).
	 */
	private syncFollowLayer(): void {
		const scroller = this.view.scrollDOM;
		this.follow.rebase(this.layerEl, scroller.scrollLeft, scroller.scrollTop, this.frame.locked);
	}

	/**
	 * Pen-down inside a follow interval: the layer is still carrying a
	 * scroll translate, and syncCamera has just moved the camera to the live
	 * geometry. Drawing the new stroke now would put fresh ink at the NEW
	 * camera inside a layer still shifted by the OLD delta, which is the
	 * same forward/inverse mismatch the snap comes from, wearing a different
	 * hat. So redraw the committed layers at the current camera and zero the
	 * translate, synchronously, before the frame freezes.
	 *
	 * Only reachable on pen-down after a shifted scroll frame. The repaint
	 * that scroll already queued still runs and is harmless: it repaints at
	 * the same camera against a zeroed transform. No polling, no extra
	 * layout reads on any other path.
	 */
	private reconcileFollowLayer(): void {
		if (!this.follow.shifted || !this.container) return;
		const path = this.filePath();
		const strokes = path ? inlineInk.strokes(path) : [];
		drawCommitted(
			this.highlightCtx,
			this.camera.snapshot,
			strokes,
			this.cssWidth,
			this.cssHeight,
			true,
			"highlighter"
		);
		drawCommitted(
			this.committedCtx,
			this.camera.snapshot,
			strokes,
			this.cssWidth,
			this.cssHeight,
			true,
			"pen"
		);
		this.syncFollowLayer();
	}

	// ---- surface extent -----------------------------------------------------
	//
	// Reconstructed from the 2026-08-20 deployed hardware build (its source
	// was lost with the session container). The note surface must be
	// SCROLLABLE wherever ink lives, including below the last line and right
	// of the content column: an invisible 1×1 spacer inside the scroller,
	// positioned at (note origin + granted extent) in scroller-content
	// coordinates, extends scrollWidth/scrollHeight so native scrolling
	// (finger, touchpad, scrollbar) reaches all of it. Obsidian ships the
	// scroller with `overflow-x: hidden`, so the axis guard flips exactly
	// that property to `auto` while ink needs it.
	//
	// This is the one piece of Handwriting that changes what SCROLLING itself can
	// do, and wheel input (the touchpad pipeline) can pan a scrollable x-axis
	// that an axis-locked touch drag never touches. That made it the first
	// suspect in the 2026-08 touchpad dead-zone investigation, which is why
	// every mutation here is traced.

	private updateExtent(): void {
		if (!this.container || this.frame.locked) return;
		const path = this.filePath();
		if (!path) return;
		const granted = surfaceExtents.grow(path, inkFrontier(inlineInk.strokes(path)));
		if (!this.spacer && granted.x === 0 && granted.y === 0) return;
		const scroller = this.view.scrollDOM;
		if (!this.spacer) {
			if (getComputedStyle(scroller).position === "static") {
				scroller.setCssStyles({ position: "relative" });
				this.scrollPositionPatched = true;
			}
			this.spacer = scroller.createDiv({ cls: "handwriting-surface-extent" });
			this.spacer.setCssStyles({
				position: "absolute",
				width: "1px",
				height: "1px",
				visibility: "hidden",
				pointerEvents: "none",
			});
			scrollProbeExtent("spacer created");
		}
		this.ensureScrollableAxis(scroller);
		const scrollRect = scroller.getBoundingClientRect();
		const pos = spacerPosition(
			surfaceOriginInScroller({
				contentLeftVisual: this.view.contentDOM.getBoundingClientRect().left,
				documentTopVisual: this.view.documentTop,
				scrollRectLeft: scrollRect.left,
				scrollRectTop: scrollRect.top,
				scrollLeft: scroller.scrollLeft,
				scrollTop: scroller.scrollTop,
				// Scroller-content coordinates are LAYOUT px: convert the
				// visual rect offsets with the transform scale alone…
				scale: this.cssScale,
			}),
			// …and the granted extent (note px) with the font zoom, so the
			// scroll range tracks the ink's rendered size.
			{ x: granted.x * this.fontZoom, y: granted.y * this.fontZoom }
		);
		let moved = false;
		if (pos.left !== this.spacerLeft) {
			this.spacerLeft = pos.left;
			this.spacer.setCssStyles({ left: `${pos.left}px` });
			moved = true;
		}
		if (pos.top !== this.spacerTop) {
			this.spacerTop = pos.top;
			this.spacer.setCssStyles({ top: `${pos.top}px` });
			moved = true;
		}
		if (moved) scrollProbeExtent(`spacer -> (${pos.left},${pos.top})`);
		scroller.classList.toggle("handwriting-hscroll", granted.x > 0);
		if (moved || !this.lastReach) this.measureReach(scroller, pos.left + 1);
	}

	private ensureScrollableAxis(scroller: HTMLElement): void {
		if (this.axisChecked || this.axisGuard.patched) return;
		this.axisChecked = true;
		const overflowX = getComputedStyle(scroller).overflowX;
		this.axisGuard.assert(scroller, overflowX);
		if (this.axisGuard.patched) {
			scrollProbeExtent(`axis guard: overflow-x "${overflowX}" -> auto`);
		}
	}

	private restoreScrollableAxis(): void {
		this.axisGuard.restore(this.view.scrollDOM);
	}

	private measureReach(scroller: HTMLElement, required: number): void {
		this.lastReach = {
			required,
			scrollWidth: scroller.scrollWidth,
			clientWidth: scroller.clientWidth,
			overflowX: getComputedStyle(scroller).overflowX,
			patched: this.axisGuard.patched,
		};
	}

	surfaceReport(): string {
		const path = this.filePath();
		const scroller = this.view.scrollDOM;
		const granted: Extent = path ? surfaceExtents.get(path) : ZERO_EXTENT;
		const frontier = path ? inkFrontier(inlineInk.strokes(path)) : ZERO_EXTENT;
		const reach = this.lastReach;
		return [
			`file: ${path ?? "(none)"}`,
			`ink frontier (note units): ${frontier.x.toFixed(1)}, ${frontier.y.toFixed(1)}`,
			`granted extent: ${granted.x}, ${granted.y}`,
			`spacer: ${this.spacer ? `present at ${this.spacerLeft}, ${this.spacerTop}` : "none"}  parent: ${this.spacer?.parentElement?.className ?? "-"}`,
			`scroller: client ${scroller.clientWidth} x ${scroller.clientHeight}  scroll ${scroller.scrollWidth} x ${scroller.scrollHeight}  at ${scroller.scrollLeft}, ${scroller.scrollTop}`,
			`computed overflow-x: ${getComputedStyle(scroller).overflowX}  overflow-y: ${getComputedStyle(scroller).overflowY}  position: ${getComputedStyle(scroller).position}`,
			`axis asserted by Handwriting: ${this.axisGuard.patched}`,
			reach
				? `last reconcile: required ${reach.required}, scrollWidth ${reach.scrollWidth}, client ${reach.clientWidth}: ` +
					(reach.scrollWidth >= reach.required
						? isScrollableOverflow(reach.overflowX)
							? "REACHABLE"
							: `EXTENT PRESENT BUT NOT USER-SCROLLABLE (overflow-x: ${reach.overflowX})`
						: "EXTENT MISSING: scrollWidth did not grow")
				: "last reconcile: (none yet)",
		].join("\n");
	}
}

function padBBox(b: BBox, pad: number): BBox {
	return { x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 };
}

const inkOverlayPlugin = ViewPlugin.fromClass(InkOverlayPlugin);

// Obsidian's ordinary editor keymap also handles Delete and Backspace. Put
// the selected-ink handler first, but claim those keys only while ink is
// selected. Every other key still falls through untouched.
const inlineSelectionKeyHandlers = Prec.highest(
	EditorView.domEventHandlers({
		keydown(event, view) {
			return view.plugin(inkOverlayPlugin)?.handleKeyDown(event) ?? false;
		},
		keyup(event, view) {
			return view.plugin(inkOverlayPlugin)?.handleKeyUp(event) ?? false;
		},
	})
);

export function inkOverlayExtension(): Extension {
	return [
		inlineSelectionKeyHandlers,
		inkOverlayPlugin,
		inkHistorySupport(),
	];
}
